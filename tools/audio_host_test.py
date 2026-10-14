"""Bounded 300 Hz / 1..20 mA AUDIO V1 live check. Requires manual --run.

The upper agent owns the music UI; this tool exercises the actual frozen
transport with cumulative ACK, credit and at most six frames in flight.
"""
import argparse,binascii,json,math,re,struct,time
from pathlib import Path
from cogging_calibrate import Uart,kv

def encode(kind,sid,seq,payload=b''):
    body=struct.pack('<BBHIH',1,kind,sid,seq,len(payload))+payload
    return b'\xa5\x5a'+body+struct.pack('<H',binascii.crc_hqx(body,0xffff))
class StatusParser:
    def __init__(self):self.buffer=bytearray();self.invalid_frames=[]
    def feed(self,data):
        self.buffer.extend(data);out=[]
        while len(self.buffer)>=2:
            if self.buffer[:2]!=b'\xa5\x5a':del self.buffer[0];continue
            if len(self.buffer)<12:break
            n=struct.unpack_from('<H',self.buffer,10)[0]
            if n>320:del self.buffer[0];continue
            if len(self.buffer)<14+n:break
            f=bytes(self.buffer[:14+n])
            if f[2]!=1 or f[3]!=0x81 or n!=24 or binascii.crc_hqx(f[2:-2],0xffff)!=struct.unpack_from('<H',f,len(f)-2)[0]:
                self.invalid_frames.append(f.hex());del self.buffer[0];continue
            del self.buffer[:14+n]
            sid=struct.unpack_from('<H',f,4)[0];fields=struct.unpack_from('<IIIIHHBBH',f,12)
            if not sid or fields[-1]!=0 or fields[6]>7 or fields[7]>11:
                self.invalid_frames.append(f.hex());continue
            out.append(dict(zip(('ack','grant','played','underruns','buffer','faults','state','reason','reserved'),fields))|{'sid':sid})
        return out

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',default='COM5');parser.add_argument('--axis',choices=['Q','D'],default='Q')
    parser.add_argument('--baud',type=int,choices=(200000,230400),default=200000)
    parser.add_argument('--seconds',type=float,default=1);parser.add_argument('--run',action='store_true')
    parser.add_argument('--amplitude-ma',type=int,default=5,help='Peak current cap, 1..20 mA; default 5')
    parser.add_argument('--out',default='logs/audio_uart_v1_20261014/hardware.json')
    args=parser.parse_args()
    if not args.run:parser.error('Manual hardware confirmation and --run are required')
    if not .1<=args.seconds<=120:parser.error('--seconds must be .1..120')
    if not 1<=args.amplitude_ma<=20:parser.error('--amplitude-ma must be 1..20')
    u=Uart(args.port,args.baud);sid=None;binary=False;original=None;telem=None;records=[];wire=bytearray();passed=False;received=StatusParser()
    try:
        u.stop();info=u.info()
        if info.get('audio')!='1' or info.get('uart_baud')!=str(args.baud) or info.get('calib')!='1':raise RuntimeError('Need calibrated AUDIO firmware at the selected baud')
        telem=int(info['telem']);u.set('TELEM',0);original=u.params();original['TELEM']=telem
        if original['IQ_LIM']<args.amplitude_ma/1000:raise RuntimeError('Existing continuous current cap is too low')
        u.set('OL_EN',0);u.set('IQ_LIM',min(.2,original['IQ_LIM']));u.set('TIMEOUT_MS',1000)
        u.command('RUN');u.command('IQ 0');time.sleep(.1)
        info=u.info()
        if info.get('run')!='CURRENT' or info.get('drv')!='1' or int(info['fault'],0) or int(info['latched'],0):raise RuntimeError('Current-zero safety gate is not ready')
        response=u.command(f'AUDIO OPEN {args.axis} {args.amplitude_ma}')[-1];sid=int(kv(response)['sid']);binary=True
        opened=kv(response);capacity=int(opened['cap']);window=int(opened['window'])
        if (capacity,window) not in ((2048,6),(4096,12)):raise RuntimeError('Unsupported audio capacity/window')
        retry_seconds=.25 if window==12 else .1;status_timeout=.5 if window==12 else .3
        u.parser.frames.clear();u.parser.lines.clear();u.parser.buffer.clear()
        samples=int(args.seconds*8000);pcm=[int(16000*math.sin(2*math.pi*300*i/8000)) for i in range(samples)]
        packets=[struct.pack('<'+'h'*len(pcm[i:i+160]),*pcm[i:i+160]) for i in range(0,samples,160)]
        ack=sent=grant=0;pending={};ended=False;retry=False;retry_ack=-1;last_retry=0;last_status=time.monotonic();last_progress=last_status;ping=0;deadline=last_status+args.seconds+5
        while time.monotonic()<deadline:
            now=time.monotonic()
            incoming=u.port.read(max(1,u.port.in_waiting));wire.extend(incoming)
            for s in received.feed(incoming):
                if s['sid']!=sid:raise RuntimeError('Session mismatch')
                records.append(s);last_status=now
                if s['faults'] or s['state'] in (5,6) or s['underruns']:raise RuntimeError('Device safety stop: '+str(s))
                if s['ack']>ack:ack=s['ack'];last_progress=now
                grant=max(grant,s['grant'])
                if s['reason'] in (1,2,3):retry=True
                for seq in list(pending):
                    if seq<ack:del pending[seq]
                if s['state']==4:
                    if s['played']!=samples or ack!=len(packets):raise RuntimeError('Incomplete playback')
                    passed=True;break
            if passed:break
            if now-last_status>status_timeout:raise RuntimeError('STATUS timeout')
            if pending and ((retry and retry_ack!=ack) or now-last_progress>retry_seconds):
                # One replay per cumulative ACK point. Old SEQ_GAP reports
                # must not create an unbounded duplicate-write queue.
                if now-last_retry>retry_seconds or retry_ack!=ack:
                    for seq in sorted(pending):
                        if seq<ack or seq>=ack+window or seq>=grant:continue
                        tries=pending[seq]+1
                        if tries>5:raise RuntimeError('Too many retries')
                        u.port.write(encode(1,sid,seq,packets[seq]));pending[seq]=tries
                    retry_ack=ack;last_retry=last_progress=now
                retry=False
            while sent<len(packets) and sent<grant and sent<ack+window:
                u.port.write(encode(1,sid,sent,packets[sent]));pending[sent]=0;sent+=1
            if ack==len(packets) and not ended:u.port.write(encode(2,sid,ack));ended=True
            if now>=ping:u.port.write(encode(4,sid,0));ping=now+.1
        if not passed:raise RuntimeError('Bounded test deadline')
    finally:
        try:
            if binary:
                u.port.write(encode(3,sid,0));u.port.write(encode(5,sid,0))
                exit_receiver=StatusParser();deadline=time.monotonic()+1;exited=False
                while time.monotonic()<deadline:
                    for s in exit_receiver.feed(u.port.read(max(1,u.port.in_waiting))):
                        if s['sid']==sid and s['state']==7:exited=True
                    if exited:break
                if not exited:
                    # No more binary heartbeats. The MCU watchdog closes the
                    # stage at 300 ms and resumes ASCII at 2 s; do not guess.
                    time.sleep(2.1)
                u.parser.buffer.clear();u.parser.lines.clear();u.parser.frames.clear()
            u.stop()
            if original:
                for key in ('IQ_LIM','OL_EN','TIMEOUT_MS'):u.set(key,original[key])
            if telem is not None:u.set('TELEM',telem)
            final=u.info()
        finally:
            u.close();out=Path(args.out);out.parent.mkdir(parents=True,exist_ok=True)
            out.with_suffix('.rx.bin').write_bytes(wire)
            final_info=locals().get('final');stopped=bool(final_info and final_info.get('run')=='IDLE' and final_info.get('drv')=='0' and final_info.get('ae')=='0')
            out.write_text(json.dumps({'passed':passed and stopped,'playback_passed':passed,'stopped':stopped,'axis':args.axis,'seconds':args.seconds,'amplitude_ma':args.amplitude_ma,'pcm_peak_fraction':16000/32768,'invalid_status_frames':received.invalid_frames,'status':records,'final':final_info},indent=2),encoding='utf-8')
    if not stopped:raise RuntimeError('Final IDLE/driver-off confirmation failed; inspect test report')
    print('AUDIO live test passed; stopped and temporary parameters restored')
if __name__=='__main__':main()
