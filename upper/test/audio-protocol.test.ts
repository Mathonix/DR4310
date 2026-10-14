import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {audioCrc16,decodeAudioFrame,encodeAudioFrame} from '../../protocol/audio_uart_v1';
const fixtures=JSON.parse(readFileSync(new URL('../../protocol/protocol_vectors.json',import.meta.url),'utf8'));
const bytes=(h:string)=>new Uint8Array(Buffer.from(h,'hex'));
it('matches the common CCITT check value',()=>expect(audioCrc16(bytes(fixtures.crc_check.hex))).toBe(fixtures.crc_check.crc16));
for(const v of fixtures.vectors)it(v.name,()=>{
  const b=bytes(v.frame_hex);
  if(!v.valid){expect(()=>decodeAudioFrame(b)).toThrow();return;}
  const f=decodeAudioFrame(b);expect(f.sid).toBe(v.sid);expect(f.seq).toBe(v.seq);expect(f.type).toBe(v.type);expect(f.payload).toEqual(bytes(v.payload_hex));
  expect(encodeAudioFrame({type:v.type,sid:v.sid,seq:v.seq,payload:bytes(v.payload_hex)})).toEqual(b);
});
