"""Generate shared AUDIO UART V1 fixtures from the frozen contract.

Uses Python's independent CCITT implementation; firmware and TS do not import
this encoder. Generated output is committed, so consumers test fixed bytes.
"""
from pathlib import Path
import binascii,json,struct
ROOT=Path(__file__).resolve().parents[1]
def frame(kind,sid,seq,payload=b'',version=1):
    core=struct.pack('<BBHIH',version,kind,sid,seq,len(payload))+payload
    return b'\xa5\x5a'+core+struct.pack('<H',binascii.crc_hqx(core,0xffff))
vectors=[]
def add(name,kind,sid,seq,payload=b''):
    vectors.append(dict(name=name,valid=True,type=kind,sid=sid,seq=seq,payload_hex=payload.hex(),frame_hex=frame(kind,sid,seq,payload).hex()))
pcm=[-32768,32767,0,0x5aa5,10,13,64,-1]*20
add('data_full_binary_delimiters',1,1,0,struct.pack('<160h',*pcm))
add('data_short_negative',1,0x1234,0x12345678,struct.pack('<3h',-32768,0,32767))
for kind,name in [(2,'end'),(3,'abort'),(4,'ping'),(5,'exit'),(6,'pause'),(7,'resume')]:add(name,kind,0xabcd,7 if kind==2 else 0)
for state in range(8):
    for reason in range(12):add(f'status_state_{state}_reason_{reason}',0x81,42,0,struct.pack('<IIIIHHBBH',0x01020304,0x01020310,0x12345678,3,800,0xabcd,state,reason,0))
for name,b in [
    ('bad_crc',frame(4,42,0)[:-1]+bytes([frame(4,42,0)[-1]^1])),
    ('bad_version',frame(4,42,0,version=2)),
    ('bad_type',frame(8,42,0)),('zero_sid',frame(4,0,0)),
    ('odd_pcm',frame(1,42,0,b'abc')),('empty_pcm',frame(1,42,0)),
    ('control_payload',frame(4,42,0,b'aa')),('control_seq',frame(4,42,1)),
    ('oversize_length',b'\xa5\x5a'+struct.pack('<BBHIH',1,1,42,0,321))]:
    vectors.append(dict(name=name,valid=False,frame_hex=b.hex()))
result={'protocol':'DR4310 AUDIO UART V1','source':'task/00_AUDIO_UART_PROTOCOL_V1_FROZEN (1).md',
        'crc_check':{'ascii':'123456789','hex':'313233343536373839','crc16':0x29b1},'vectors':vectors}
assert binascii.crc_hqx(b'123456789',0xffff)==0x29b1
dest=ROOT/'protocol/protocol_vectors.json';dest.parent.mkdir(exist_ok=True)
dest.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8');print(f'{len(vectors)} shared vectors: {dest}')
