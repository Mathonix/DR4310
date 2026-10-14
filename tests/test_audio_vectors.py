from pathlib import Path
import json,subprocess,sys,tempfile,unittest
ROOT=Path(__file__).resolve().parents[1]

class CommonVectors(unittest.TestCase):
    def test_live_status_parser_recovers_after_corrupted_or_truncated_frames(self):
        sys.path.insert(0,str(ROOT/'tools'))
        from audio_host_test import StatusParser
        fixture=json.loads((ROOT/'protocol/protocol_vectors.json').read_text())
        statuses=[bytes.fromhex(v['frame_hex']) for v in fixture['vectors'] if v['valid'] and v['type']==0x81]
        for frame in statuses:
            parser=StatusParser();out=[]
            for b in frame:out+=parser.feed(bytes([b]))
            self.assertEqual(len(out),1);self.assertEqual(parser.invalid_frames,[])
        good=statuses[0]
        corrupt=bytearray(good);corrupt[20]^=1
        # A missing tail must not consume the next packet's A5 byte. A bad
        # sync byte is ignored; a bad CRC is never accepted as an ACK.
        sync_corrupt=bytearray(good);sync_corrupt[1]^=1
        wire=bytes(sync_corrupt)+bytes(corrupt)+good[:28]+good
        parser=StatusParser();out=[]
        for i in range(0,len(wire),7):out+=parser.feed(wire[i:i+7])
        self.assertEqual(len(out),1);self.assertEqual(out[0]['sid'],int.from_bytes(good[4:6],'little'))
        self.assertEqual(len(parser.invalid_frames),2)
    def test_cpp_encode_decode_fixed_shared_bytes(self):
        fixture=json.loads((ROOT/'protocol/protocol_vectors.json').read_text())
        cases=[]
        for v in fixture['vectors']:
            wire=','.join(str(b) for b in bytes.fromhex(v['frame_hex']))
            if v['valid']:
                payload=','.join(str(b) for b in bytes.fromhex(v['payload_hex'])) or '0'
                cases.append(f'''{{const uint8_t frame[]={{{wire}}},payload[]={{{payload}}};
                  audio::FrameView f;assert(audio::DecodeFrame(frame,sizeof(frame),f));
                  assert(f.sid=={v['sid']} && f.seq=={v['seq']}U && int(f.type)=={v['type']});
                  assert(f.length=={len(bytes.fromhex(v['payload_hex']))});
                  assert(!std::memcmp(f.payload,payload,f.length));uint8_t encoded[334];
                  auto n=audio::EncodeFrame(encoded,audio::Type({v['type']}),{v['sid']},{v['seq']}U,payload,f.length);
                  assert(n==sizeof(frame)&&!std::memcmp(encoded,frame,n));}}''')
            else:
                cases.append(f'{{const uint8_t frame[]={{{wire}}};audio::FrameView f;assert(!audio::DecodeFrame(frame,sizeof(frame),f));}}')
        code='#include "motor_audio.h"\n#include <cassert>\n#include <cstring>\nint main(){\n'+ '\n'.join(cases)+'\n}\n'
        with tempfile.TemporaryDirectory() as d:
            cpp=Path(d)/'vectors.cpp';exe=Path(d)/'vectors.exe';cpp.write_text(code,encoding='utf-8')
            subprocess.run(['g++','-std=c++17','-O2','-ILibraries/App/inc','-ILibraries/Control/inc',str(cpp),'Libraries/App/src/motor_audio.cpp','Libraries/Control/src/audio_current.cpp','-o',str(exe)],cwd=ROOT,check=True)
            subprocess.run([str(exe)],check=True)
        print(f'C++ encode/decode matched all {len(fixture["vectors"])} shared vectors')
if __name__=='__main__':unittest.main()
