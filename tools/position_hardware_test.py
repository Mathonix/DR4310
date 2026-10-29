"""Bounded UART/SWD validation of position feedforward; always stop on exit."""
import argparse
import datetime
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import time

import pylink
import serial
from elftools.elf.elffile import ELFFile

ROOT = Path(__file__).resolve().parents[1]
DLL = r'C:\Program Files\SEGGER\JLink_V930a\JLink_x64.dll'


class Uart:
    def __init__(self, port='COM5', baud=200000):
        self.port = serial.Serial(port, baud, timeout=.03, write_timeout=1)
        self.events = []

    def command(self, text, timeout=2):
        self.port.reset_input_buffer()
        self.port.write((text+'\n').encode('ascii'))
        self.port.flush()
        self.events.append({'time': time.time(), 'command': text})
        key = text.split()[0]
        raw = bytearray()
        deadline = time.monotonic()+timeout
        while time.monotonic() < deadline:
            raw.extend(self.port.read(max(1, self.port.in_waiting)))
            lines = [m.decode('ascii') for m in re.findall(rb'@[A-Z][A-Za-z0-9_ =.,:/+|\-]*[\r\n]', raw)]
            lines = [line.strip() for line in lines]
            if any(line.startswith('@ERR '+key+' ') for line in lines):
                raise RuntimeError(text+': '+str(lines))
            if any(line.startswith('@OK '+key) for line in lines) or (
                key in ('INFO', 'TCH', 'TLIST', 'FAULT') and any(line.startswith('@'+key+' ') for line in lines)
            ) or (key == 'PING' and any(line.startswith('@PONG ') for line in lines)):
                return lines
        raise RuntimeError('UART timeout: '+text+' '+repr(bytes(raw)[-200:]))

    def params(self):
        lines = self.command('GET')
        return {m[1]:float(m[2]) for line in lines if (m := re.match(r'@P (\w+)=([\deE+.\-]+)', line))}

    def info(self):
        line = next(line for line in self.command('INFO') if line.startswith('@INFO '))
        return dict(re.findall(r'(\w+)=([^ ]+)', line))

    def set(self, key, value):
        return self.command(f'SET {key} {value:.7g}')

    def close(self):
        self.port.close()


def probe():
    j = pylink.JLink(lib=pylink.library.Library(dllpath=DLL))
    try:
        j.open(serial_no=29534567)
        j.set_tif(pylink.enums.JLinkInterfaces.SWD)
        j.connect('STM32G431KB', speed=1000)
    except BaseException:
        j.close()
        raise
    return j


def word_bytes(j, address, size):
    # Read each live float atomically; byte reads can tear across control ticks.
    words = j.memory_read32(address, (size + 3) // 4)
    return struct.pack('<' + 'I' * len(words), *words)[:size]


def telemetry_layout(elf):
    def resolve(d):
        while d.tag in ('DW_TAG_typedef', 'DW_TAG_const_type', 'DW_TAG_volatile_type'):
            d = d.get_DIE_from_attribute('DW_AT_type')
        return d
    for cu in elf.get_dwarf_info().iter_CUs():
        for d in cu.iter_DIEs():
            if (d.tag == 'DW_TAG_class_type' and d.attributes.get('DW_AT_name') and
                d.attributes['DW_AT_name'].value == b'ApplicationController' and 'DW_AT_byte_size' in d.attributes):
                app = d
                break
        else:
            continue
        break
    tele = next(c for c in app.iter_children() if c.tag == 'DW_TAG_member' and c.attributes['DW_AT_name'].value == b'telemetry_')
    t = resolve(tele.get_DIE_from_attribute('DW_AT_type'))
    layout = {}
    for member in t.iter_children():
        if member.tag != 'DW_TAG_member':
            continue
        base = resolve(member.get_DIE_from_attribute('DW_AT_type'))
        size = base.attributes['DW_AT_byte_size'].value
        encoding = base.attributes['DW_AT_encoding'].value
        fmt = 'f' if encoding == 4 and size == 4 else {1:'B', 2:'H', 4:'I'}[size]
        layout[member.attributes['DW_AT_name'].value.decode()] = (member.attributes['DW_AT_data_member_location'].value, fmt)
    symtab = elf.get_section_by_name('.symtab')
    symbols = {sym.name:sym['st_value'] for sym in symtab.iter_symbols()}
    address = symbols['_ZN3app13g_applicationE'] + tele.attributes['DW_AT_data_member_location'].value
    fields={c.attributes['DW_AT_name'].value.decode():c for c in app.iter_children() if c.tag=='DW_TAG_member'}
    symbols['active_velocity_ref']=symbols['_ZN3app13g_applicationE']+fields['active_velocity_ref_rad_s_'].attributes['DW_AT_data_member_location'].value
    position=fields['position_controller_']
    position_type=resolve(position.get_DIE_from_attribute('DW_AT_type'))
    integral=next(c for c in position_type.iter_children() if c.tag=='DW_TAG_member' and c.attributes['DW_AT_name'].value==b'integrator_')
    symbols['position_integral']=symbols['_ZN3app13g_applicationE']+position.attributes['DW_AT_data_member_location'].value+integral.attributes['DW_AT_data_member_location'].value
    return address, t.attributes['DW_AT_byte_size'].value, layout, symbols


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('action', choices=['backup', 'test'])
    ap.add_argument('--out', required=True)
    ap.add_argument('--port', default='COM5')
    ap.add_argument('--baud', type=int, choices=(200000, 230400), default=200000)
    ap.add_argument('--retry', action='store_true', help='Migration/persistence already checked; retry motion with restored original profile')
    ap.add_argument('--original-gains', action='store_true', help='Keep the saved PID gains; retain conservative motion/current limits')
    args = ap.parse_args()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    uart = None
    j = None
    result = {'action':args.action, 'samples':[], 'stages':[], 'stopped':False}
    original = None
    original_telem = None
    symbols = None
    try:
        uart = Uart(args.port, args.baud)
        uart.command('STOP')
        original_telem = int(uart.info()['telem'])
        if args.action=='backup' and (out/'backup-result.json').exists():
            previous = json.loads((out/'backup-result.json').read_text(encoding='utf-8'))
            # Recover the telemetry value from a preflight interrupted before
            # SWD was opened; its STOP succeeded but its restore was skipped.
            if previous.get('error')=='Saved auto-start configuration':
                original_telem = int(previous['initial_params']['TELEM'])
        uart.set('TELEM', 0)
        original = uart.params()
        original['TELEM'] = original_telem
        info = uart.info()
        result['initial_info'] = info
        result['initial_params'] = original
        assert info['mode']=='0' and info['drv']=='0' and info['ae']=='0'
        assert int(info['fault'],16)==0 and int(info['latched'],16)==0, 'Existing fault; abort without clearing'
        assert info['calib']=='1', 'No calibration'
        j = probe()
        assert not j.halted(), 'Target unexpectedly halted'
        assert not (j.memory_read32(0x48001414,1)[0]&1), 'Driver enabled'
        if args.action == 'backup':
            image = b''.join(bytes(j.memory_read8(0x08000000+off,4096)) for off in range(0,0x20000,4096))
            (out/'flash-before.bin').write_bytes(image)
            (out/'calibration-before.bin').write_bytes(image[0x1F000:])
            result['flash_sha256'] = hashlib.sha256(image).hexdigest()
            result['calibration_sha256'] = hashlib.sha256(image[0x1F000:]).hexdigest()
            result['channels'] = uart.command('TCH')
            result['rate'] = uart.command('TRATE')
            # Back up first, then make reboot safe without losing the user's
            # saved auto-enable setting from the original profile.
            if original['BOOT_AE'] and original['BOOT_MODE']:
                uart.set('BOOT_AE',0)
                uart.set('TELEM',original_telem)
                uart.command('SAVE')
                uart.set('TELEM',0)
            prepared = uart.params()
            prepared['TELEM']=original_telem
            result['prepared_params']=prepared
            (out/'calibration-prepared.bin').write_bytes(bytes(j.memory_read8(0x0801F000,4096)))
            (out/'before.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
            print('BACKUP', json.dumps({k:v for k,v in result.items() if k not in ['samples','stages','initial_params']}),flush=True)
            return

        assert info['ver']=='3.2.0', 'Wrong firmware version'
        if not args.retry:
            assert original['BOOT_AE']==0 or original['BOOT_MODE']==0, 'Unsafe auto-start configuration'
        assert 'POS_VFF' in original and original['POS_VFF']==1, 'Legacy migration must default to 1'
        before = json.loads((out/'before.json').read_text(encoding='utf-8'))
        assert before['initial_info']['zero']==info['zero'] and before['initial_info']['dir']==info['dir'], 'Calibration changed'
        calibration = bytes(j.memory_read8(0x0801F000,4096))
        if not args.retry:
            assert calibration == (out/'calibration-prepared.bin').read_bytes(), 'Flashing altered configuration pages'
        expected=before['initial_params'] if args.retry else before['prepared_params']
        for key, value in expected.items():
            assert math.isclose(original[key],value,rel_tol=2e-6,abs_tol=1e-6), 'Migrated parameter mismatch: '+key
        with (ROOT/'build/Release/4310_G431KBT6.elf').open('rb') as file:
            elf = ELFFile(file)
            for section in elf.iter_sections():
                if section.name == '.text':
                    assert bytes(j.memory_read8(section['sh_addr'],section['sh_size'])) == section.data(), 'ELF mismatch'
            address, size, layout, symbols = telemetry_layout(elf)
        start = time.monotonic()
        def sample(stage):
            raw = word_bytes(j,address,size)
            row = {key:struct.unpack_from('<'+fmt,raw,offset)[0] for key,(offset,fmt) in layout.items()}
            row.update(t=time.monotonic()-start,stage=stage)
            row['vff'] = struct.unpack('<f',word_bytes(j,symbols['control_position_velocity_ff_gain'],4))[0]
            row['velocity_ref_rad_s'] = struct.unpack('<f',word_bytes(j,symbols['active_velocity_ref'],4))[0]
            row['position_integral'] = struct.unpack('<f',word_bytes(j,symbols['position_integral'],4))[0]
            result['samples'].append(row)
            return row
        baseline = sample('baseline')
        assert baseline['arm_all_ok']==1 and baseline['encoder_valid']==1 and baseline['encoder_pll_locked']==1, 'Motor not ready'
        p0 = baseline['position_rad']
        print('READY',json.dumps({'position_rad':p0,'vbus':baseline['bus_v'],'zero':info['zero'],'preserved_params':len(before['initial_params'])}),flush=True)

        # First exercise persistence while all original control parameters
        # remain unchanged. Restore the original FF before motion testing.
        if not args.retry:
            uart.set('POS_VFF',0)
            uart.command('SAVE')
            uart.command('REBOOT')
            time.sleep(2)
            uart.set('TELEM',0)
            assert uart.info()['ver']=='3.2.0'
            assert uart.params()['POS_VFF']==0, 'Zero not persistent'
            uart.set('POS_VFF',original['POS_VFF'])
            uart.set('TELEM',original_telem)
            uart.command('SAVE')
            uart.set('TELEM',0)
        result['persistence_zero_verified'] = True
        baseline = sample('post_reboot')
        p0 = baseline['position_rad']

        # All changes below are RAM-only and restored on exit. 0.1 rad is
        # approximately 5.7 degrees; velocity stays below 0.4 rad/s.
        settings = {'IQ_LIM':min(original['IQ_LIM'],.15), 'OL_EN':0,
                    'POS_VLIM':.4, 'ACCEL':2, 'POS_RAMP_MS':0,
                    'POS_KP':2, 'POS_KI':0, 'POS_KD':.3,
                    'SPD_KP':.014, 'SPD_KI':.4, 'SPD_KD':0, 'TIMEOUT_MS':1000}
        if args.original_gains:
            for key in ['POS_KP','POS_KI','POS_KD','SPD_KP','SPD_KI','SPD_KD']:
                settings[key]=original[key]
        result['test_settings']=settings
        assert settings['IQ_LIM']>0, 'Current limit zero'
        for key,value in settings.items():
            uart.set(key,value)

        def capture(stage, target, seconds, expected_mode=3):
            rows = []
            deadline = time.monotonic()+seconds
            last_ping = 0
            next_report = 0
            while time.monotonic()<deadline:
                row = sample(stage)
                rows.append(row)
                assert all(math.isfinite(row[k]) for k in ['position_rad','velocity_rad_s','iq_a','iq_ref_a','bus_v'])
                assert row['fault_flags']==0 and row['latched_faults']==0, 'Firmware fault during '+stage
                assert abs(row['position_rad']-p0)<.35, 'Position travel guard during '+stage
                assert abs(row['velocity_rad_s'])<2, 'Speed guard during '+stage
                assert abs(row['iq_ref_a'])<=settings['IQ_LIM']+.001, 'Iq command guard during '+stage
                assert max(abs(row['ia_a']),abs(row['ib_a']),abs(-row['ia_a']-row['ib_a']))<.6, 'Phase current guard during '+stage
                assert row['control_mode']==expected_mode and row['power_stage_armed']==1, 'Unexpected disarm during '+stage
                if time.monotonic()-last_ping>.3:
                    uart.command('PING');last_ping=time.monotonic()
                if time.monotonic()>next_report:
                    print(stage,'pos',round(row['position_rad'],4),'target',round(target,4),'speed',round(row['velocity_rad_s'],4),'iq',round(row['iq_a'],4),flush=True)
                    next_report=time.monotonic()+2
                time.sleep(.01)
            tail=rows[-min(30,len(rows)):]
            summary={'stage':stage,'target':target,'final_position':rows[-1]['position_rad'],
                     'mean_abs_error':sum(abs(r['position_rad']-target) for r in tail)/len(tail),
                     'max_speed':max(abs(r['velocity_rad_s']) for r in rows),
                     'max_iq_ref':max(abs(r['iq_ref_a']) for r in rows)}
            result['stages'].append(summary)
            print('STAGE',json.dumps(summary),flush=True)
            return summary

        # Compare full, half and zero FF using identical low-energy settings.
        for gain in ([0, 1] if args.original_gains else [0, .5, 1]):
            uart.command('STOP');uart.set('POS_VFF',gain)
            uart.command(f'POS {p0+.1:.7g}')
            forward=capture(f'ff_{gain}_forward',p0+.1,10)
            assert forward['mean_abs_error']<.015, 'Forward tracking failure at FF '+str(gain)
            uart.command(f'POS {p0:.7g}')
            back=capture(f'ff_{gain}_return',p0,10)
            assert back['mean_abs_error']<.015, 'Return tracking failure at FF '+str(gain)
        # All zero PID and zero FF must produce zero position-speed reference.
        uart.command('STOP')
        for key in ['POS_KP','POS_KI','POS_KD','POS_VFF']:
            uart.set(key,0)
        uart.command(f'POS {p0+.05:.7g}')
        capture('all_zero',p0,1)
        zero_rows=[r for r in result['samples'] if r['stage']=='all_zero']
        assert max(abs(r['position_ref_rad']-p0) for r in zero_rows)>.03, 'Trajectory not running'
        assert max(abs(r['velocity_ref_rad_s']) for r in zero_rows)==0, 'Nonzero position speed reference'
        assert max(abs(r['position_integral']) for r in zero_rows)==0, 'Residual position integral after Ki disabled'
        result['all_zero_stationary'] = max(abs(r['position_rad']-p0) for r in zero_rows)<.015
        assert result['all_zero_stationary'], 'Unexpected movement with all-zero position path'
        result['passed']=True
    except BaseException as exc:
        result['error']=str(exc)
        print('TEST_ABORT',str(exc),flush=True)
        raise
    finally:
        try:
            if uart:
                uart.command('STOP')
                stopped_info=uart.info()
                result['stopped']=stopped_info['mode']=='0' and stopped_info['drv']=='0' and stopped_info['ae']=='0'
            if j and j.connected():
                # UART STOP is primary; SWD independently checks the physical pin.
                time.sleep(.2)
                pin=j.memory_read32(0x48001414,1)[0]&1
                if pin:
                    if symbols:
                        j.memory_write8(symbols['control_debug_cmd'],[2])
                        time.sleep(.2)
                        pin=j.memory_read32(0x48001414,1)[0]&1
                    if pin:
                        j.halt();j.memory_write32(0x48001418,[1<<16])
                result['stopped']=not (j.memory_read32(0x48001414,1)[0]&1)
            if original is not None and uart and result['stopped']:
                # Restore original parameters in RAM; no SAVE of temporary gains.
                changed=['POS_KP','POS_KI','POS_KD','POS_VFF','POS_VLIM','ACCEL','POS_RAMP_MS','SPD_KP','SPD_KI','SPD_KD','IQ_LIM','OL_EN','TIMEOUT_MS','BOOT_AE']
                if args.action=='test':
                    restored=dict(original)
                    restored.update(json.loads((out/'before.json').read_text(encoding='utf-8'))['initial_params'])
                    for key in changed:
                        uart.set(key,restored[key])
                uart.set('TELEM',original_telem)
                if args.action=='test':
                    uart.command('SAVE')
                result['final_info']=uart.info()
                result['restored_params']=uart.params()
                if args.action=='test':
                    result['params_restored']=result['restored_params']==restored
                else:
                    result['params_restored']=result['restored_params']==result.get('prepared_params',original)
                assert result['params_restored'], 'RAM parameter restoration failed'
        finally:
            if uart:
                result['events']=uart.events
                uart.close()
            if j:j.close()
            (out/(args.action+'-result.json')).write_text(json.dumps(result,indent=2),encoding='utf-8')
            print('FINAL_STOP',result['stopped'],'LOG',out/(args.action+'-result.json'),flush=True)


if __name__=='__main__':
    main()
