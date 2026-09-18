#!/usr/bin/env python3
"""Isolated-bench PCAN verification. --run explicitly permits short motor motion."""
import argparse
import datetime
import json
import struct
import time
from pathlib import Path
import can

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--motor-id', type=int, choices=range(1,8), required=True)
    p.add_argument('--channel', default='PCAN_USBBUS1')
    p.add_argument('--run', action='store_true')
    args=p.parse_args(); node=args.motor_id
    group=0x1FE if node<=4 else 0x2FE; feedback=0x204+node
    slot=(node-1)%4
    bus=can.interface.Bus(interface='pcan', channel=args.channel, bitrate=1_000_000)
    rows=[];results=[];start=time.perf_counter();final_stopped=False
    def send(identifier,data,extended=False,remote=False):
        bus.send(can.Message(arbitration_id=identifier,is_extended_id=extended,
                             is_remote_frame=remote,data=data),timeout=.1)
    def current(amps=0,which=None):
        data=bytearray(8);struct.pack_into('>h',data,2*(slot if which is None else which),round(amps*16384/3))
        return data
    def stop():send(0x100+node,bytes(8))
    def phase(name,duration,tx=None):
        end=time.perf_counter()+duration;next_tx=0;local=[]
        while time.perf_counter()<end:
            now=time.perf_counter()
            if tx and now>=next_tx:tx();next_tx=now+.01
            msg=bus.recv(timeout=.002)
            if msg is None:continue
            if msg.is_error_frame:raise RuntimeError('CAN error frame')
            if 0x205<=msg.arbitration_id<=0x20B and msg.arbitration_id!=feedback:
                raise RuntimeError('Other motor detected; test requires isolated bench')
            r={'t':time.perf_counter()-start,'bus_timestamp':msg.timestamp,'phase':name,
               'id':msg.arbitration_id,'data':msg.data.hex()}
            if msg.arbitration_id==feedback:
                assert len(msg.data)==8 and not msg.is_extended_id and not msg.is_fd
                angle,rpm,iq,temp,reserved=struct.unpack('>HhhBB',msg.data)
                assert angle<=8191 and temp==255 and reserved==0
                assert abs(rpm)<600 and abs(iq*3/16384)<1.5, 'Speed/current guard'
                r.update(angle=angle,rpm=rpm,iq_a=iq*3/16384)
            elif msg.arbitration_id==0x180+node:
                assert len(msg.data)==8
                r.update(mode=msg.data[0],fault=msg.data[1])
                assert r['fault']==0,'Firmware reported fault; do not auto clear'
            local.append(r);rows.append(r)
        fb=[r for r in local if r['id']==feedback]
        statuses=[r for r in local if 'mode' in r]
        assert fb and statuses,'Missing feedback/status'
        modes=sorted(set(r['mode'] for r in statuses))
        tail=statuses[-1]['mode']
        rate=(len(fb)-1)/(fb[-1]['bus_timestamp']-fb[0]['bus_timestamp']) if len(fb)>1 else 0
        result={'phase':name,'frames':len(fb),'feedback_hz':rate,'modes':modes,'last_mode':tail,
                'rpm_min':min(r['rpm'] for r in fb),'rpm_max':max(r['rpm'] for r in fb)}
        results.append(result);print(json.dumps(result),flush=True)
        return tail
    try:
        stop();phase('baseline',1.5)
        assert phase('zero_handshake',.3,lambda:send(group,current()))==0
        assert phase('wrong_slot',.3,lambda:send(group,current(.05,(slot+1)%4)))==0
        assert phase('voltage_ignored',.3,lambda:send(group+1,current(.05)))==0
        assert phase('wrong_group',.3,lambda:send(group^0x300,bytes(8)))==0
        assert phase('extended_ignored',.3,lambda:send(group,current(.05),True))==0
        assert phase('short_dlc_ignored',.3,lambda:send(group,b'\x02\x22'))==0
        assert phase('remote_ignored',.3,lambda:send(group,bytes(8),remote=True))==0
        if args.run:
            assert phase('current_0.05A',2,lambda:send(group,current(.05)))==1
            assert phase('command_timeout',.4)==0
            assert phase('nonzero_cannot_restart',.3,lambda:send(group,current(.05)))==0
            assert phase('rearm_zero',.2,lambda:send(group,current()))==0
            assert phase('current_0.10A_pulse',.15,lambda:send(group,current(.10)))==1
            assert phase('zero_stops',.4,lambda:send(group,current()))==0
            assert phase('restart_after_zero',.4,lambda:send(group,current(.05)))==1
            stop()
            assert phase('legacy_stop_locks_out_stream',.4,lambda:send(group,current(.05)))==0
        stop();assert phase('final_idle',1)==0
        if args.run:
            assert any(abs(r.get('rpm',0)) > 10 for r in rows), 'No measured rotation'
        assert all(900 < r['feedback_hz'] < 1100 for r in results), 'Feedback rate outside tolerance'
        final_stopped=True
    finally:
        try:
            stop()
        finally:
            bus.shutdown()
            root=Path(__file__).resolve().parents[1]/'logs';root.mkdir(exist_ok=True)
            out=root/('pcan_gm6020_id%d_'%node+datetime.datetime.now().strftime('%Y%m%d_%H%M%S')+'.json')
            out.write_text(json.dumps({'motor_id':node,'run':args.run,'final_stopped':final_stopped,
                                      'results':results,'frames':rows},indent=2),encoding='utf-8')
            print('LOG',out,flush=True)
    print('PCAN checks passed; motor disabled.',flush=True)

if __name__=='__main__':main()
