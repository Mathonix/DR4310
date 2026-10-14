/** Shared pure codec for the upper agent; the frozen wire contract is V1. */
export const AudioType = {DATA:1,END:2,ABORT:3,PING:4,EXIT:5,PAUSE:6,RESUME:7,STATUS:0x81} as const;
export function audioCrc16(bytes:Uint8Array):number {
  let crc=0xffff;
  for(const byte of bytes){crc^=byte<<8;for(let i=0;i<8;i++)crc=((crc<<1)^((crc&0x8000)?0x1021:0))&0xffff;}
  return crc;
}
export type AudioFrame={type:number;sid:number;seq:number;payload:Uint8Array};
function validate(f:AudioFrame):void {
  if(!Object.values(AudioType).some(t=>t===f.type)||!Number.isInteger(f.sid)||f.sid<1||f.sid>65535||!Number.isInteger(f.seq)||f.seq<0||f.seq>0xffffffff||f.payload.length>320)throw new Error('Invalid V1 header');
  if(f.type===AudioType.DATA){if(!f.payload.length||f.payload.length%2)throw new Error('Invalid PCM length');}
  else if(f.type===AudioType.STATUS){if(f.seq||f.payload.length!==24)throw new Error('Invalid STATUS');const d=new DataView(f.payload.buffer,f.payload.byteOffset,24);if(d.getUint8(20)>7||d.getUint8(21)>11||d.getUint16(22,true))throw new Error('Invalid STATUS fields');}
  else if(f.payload.length||(f.type!==AudioType.END&&f.seq))throw new Error('Invalid control frame');
}
export function encodeAudioFrame(f:AudioFrame):Uint8Array {
  validate(f);const b=new Uint8Array(14+f.payload.length),d=new DataView(b.buffer);
  b.set([0xa5,0x5a,1,f.type]);d.setUint16(4,f.sid,true);d.setUint32(6,f.seq,true);d.setUint16(10,f.payload.length,true);b.set(f.payload,12);d.setUint16(b.length-2,audioCrc16(b.subarray(2,b.length-2)),true);return b;
}
export function decodeAudioFrame(b:Uint8Array):AudioFrame {
  if(b.length<14||b[0]!==0xa5||b[1]!==0x5a||b[2]!==1)throw new Error('Invalid V1 frame');
  const d=new DataView(b.buffer,b.byteOffset,b.byteLength),n=d.getUint16(10,true);
  if(n>320||b.length!==14+n||d.getUint16(12+n,true)!==audioCrc16(b.subarray(2,12+n)))throw new Error('Invalid length/CRC');
  const f={type:b[3]!,sid:d.getUint16(4,true),seq:d.getUint32(6,true),payload:b.slice(12,12+n)};validate(f);return f;
}
