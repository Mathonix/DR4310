"""Read-only SWD capture. Never enables, stops, halts or changes the motor."""
import argparse
import datetime
import json
import math
from pathlib import Path
import struct
import time
from elftools.elf.elffile import ELFFile
from position_hardware_test import ROOT, probe, telemetry_layout

ap=argparse.ArgumentParser(description=__doc__)
ap.add_argument('--seconds',type=float,default=20)
args=ap.parse_args()
assert 0<args.seconds<=60

def resolve(d):
    while d.tag in ('DW_TAG_typedef','DW_TAG_const_type','DW_TAG_volatile_type'):
        d=d.get_DIE_from_attribute('DW_AT_type')
    return d

def fields(d):
    return {c.attributes['DW_AT_name'].value.decode():c for c in d.iter_children() if c.tag=='DW_TAG_member'}

with (ROOT/'build/Release/4310_G431KBT6.elf').open('rb') as f:
    elf=ELFFile(f)
    tele_addr,tele_size,tele_layout,symbols=telemetry_layout(elf)
    section=elf.get_section_by_name('.text')
    signature_addr=section['sh_addr'];signature=section.data()[:128]
    for cu in elf.get_dwarf_info().iter_CUs():
        for d in cu.iter_DIEs():
            if d.tag=='DW_TAG_class_type' and d.attributes.get('DW_AT_name') and d.attributes['DW_AT_name'].value==b'ApplicationController' and 'DW_AT_byte_size' in d.attributes:
                app=d;break
        else:continue
        break
    foc=fields(app)['foc_']
    state=fields(resolve(foc.get_DIE_from_attribute('DW_AT_type')))['state_']
    state_type=resolve(state.get_DIE_from_attribute('DW_AT_type'))
    foc_addr=symbols['_ZN3app13g_applicationE']+foc.attributes['DW_AT_data_member_location'].value+state.attributes['DW_AT_data_member_location'].value
    foc_size=state_type.attributes['DW_AT_byte_size'].value
    foc_layout={}
    for name,member in fields(state_type).items():
        base=resolve(member.get_DIE_from_attribute('DW_AT_type'))
        size=base.attributes['DW_AT_byte_size'].value
        encoding=base.attributes['DW_AT_encoding'].value
        fmt='f' if encoding==4 and size==4 else {1:'B',2:'H',4:'I'}[size]
        foc_layout[name]=(member.attributes['DW_AT_data_member_location'].value,fmt)

rows=[];j=None
out=ROOT/'logs'/('zero_current_observe_'+datetime.datetime.now().strftime('%Y%m%d_%H%M%S')+'.json')
try:
    j=probe()
    assert not j.halted(),'Target halted; not resuming it'
    assert bytes(j.memory_read8(signature_addr,128))==signature,'Firmware does not match ELF'
    def word_bytes(address,size):
        # FOC rewrites these float words every 50 us. Byte-wide reads can
        # combine bytes from different float values; 32-bit reads are atomic.
        words=j.memory_read32(address,(size+3)//4)
        return struct.pack('<'+'I'*len(words),*words)[:size]
    timer=j.memory_read32(symbols['htim1'],1)[0]
    start=time.monotonic();next_report=0
    while time.monotonic()-start<args.seconds:
        traw=word_bytes(tele_addr,tele_size)
        fraw=word_bytes(foc_addr,foc_size)
        tele={key:struct.unpack_from('<'+fmt,traw,offset)[0] for key,(offset,fmt) in tele_layout.items()}
        foc={key:struct.unpack_from('<'+fmt,fraw,offset)[0] for key,(offset,fmt) in foc_layout.items()}
        row={'t':time.monotonic()-start}
        row.update({key:tele[key] for key in ['control_mode','auto_enable','power_stage_armed','arm_all_ok','position_rad','velocity_rad_s','fault_flags','latched_faults']})
        row.update({'foc_'+key:foc[key] for key in ['enabled','id_ref_a','iq_ref_a','id_a','iq_a','vd_sat_v','vq_sat_v','duty_a','duty_b','duty_c','bus_v','invalid_sample_count','overcurrent_trip_count']})
        row['driver_enable_pin']=j.memory_read32(0x48001414,1)[0]&1
        row['current_target_a']=struct.unpack('<f',word_bytes(symbols['control_current_test_iq_ref_a'],4))[0]
        row['current_kp']=struct.unpack('<f',word_bytes(symbols['control_current_pi_kp'],4))[0]
        row['current_ki']=struct.unpack('<f',word_bytes(symbols['control_current_pi_ki'],4))[0]
        arr=j.memory_read32(timer+0x2c,1)[0]
        ccr=j.memory_read32(timer+0x34,3)
        row.update({'pwm_hw_'+channel:value/arr for channel,value in zip(['a','b','c'],ccr)})
        assert all(0<=row['foc_duty_'+channel]<=1 for channel in ['a','b','c']), 'Invalid duty snapshot'
        rows.append(row)
        if row['t']>=next_report:
            print('SAMPLE',json.dumps({key:round(value,5) if isinstance(value,float) else value for key,value in row.items() if key not in ['foc_invalid_sample_count','foc_overcurrent_trip_count','arm_all_ok']}),flush=True)
            next_report=row['t']+4
        time.sleep(.015)
finally:
    if j:j.close()
    summary={'read_only':True,'atomic_word_reads':True,'seconds':args.seconds,'samples':len(rows),'first':rows[0] if rows else None,'last':rows[-1] if rows else None,
             'ranges':{key:[min(row[key] for row in rows),max(row[key] for row in rows)] for key in rows[0]} if rows else {}}
    active=[row for row in rows if row['foc_enabled']==1 and row['driver_enable_pin']==1]
    summary['active_samples']=len(active)
    summary['active_ranges']={key:[min(row[key] for row in active),max(row[key] for row in active)] for key in rows[0]} if active else {}
    out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps({'summary':summary,'samples':rows},indent=2),encoding='utf-8')
    print('SUMMARY',json.dumps(summary),flush=True)
    print('LOG',out,flush=True)
