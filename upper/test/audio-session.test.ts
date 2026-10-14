import { describe, expect, it } from "vitest";
import fixtures from "../../protocol/protocol_vectors.json";
import { AudioSession, AudioStatusParser, audioTestTone, preparePcm, audioAmplitudeMax } from "../src/audio";
import { AudioType, decodeAudioFrame, encodeAudioFrame } from "../../protocol/audio_uart_v1";
import { UartStreamParser, parseReply, parseInfo } from "../src/uartcfg-protocol";

const frames = fixtures.vectors.filter(v => v.valid && v.type === 0x81).map(v => new Uint8Array(v.frame_hex.match(/../g)!.map(b => parseInt(b,16))));
describe("audio host", () => {
  it("requires advertised Q capability for the panel and preserves the D ceiling",()=>{
    expect(audioAmplitudeMax("Q")).toBe(200);expect(audioAmplitudeMax("Q",NaN)).toBe(200);
    expect(audioAmplitudeMax("Q",1000)).toBe(1000);expect(audioAmplitudeMax("D",1000)).toBe(200);
    expect(audioAmplitudeMax("D",200)).toBe(200);expect(audioAmplitudeMax("Q",1001)).toBe(200);
    const info=parseInfo({audio_qmax_ma:"1000",audio_dmax_ma:"200"});expect(info.audioQMaxMa).toBe(1000);expect(info.audioDMaxMa).toBe(200);
  });
  it("accepts INFO beyond 400 bytes with appended firmware diagnostics",()=>{
    const line="@INFO fw=DR4310 ver=3.4.1 id=2 "+"extra=0 ".repeat(65)+"audio=1 uart_baud=230400\n";
    const parser=new UartStreamParser();const lines:string[]=[];
    for(const byte of new TextEncoder().encode(line))lines.push(...parser.push(new Uint8Array([byte])).lines);
    expect(lines.length).toBe(1);const reply=parseReply(lines[0]!);expect(reply.type).toBe("INFO");
    if(reply.type==="INFO"){expect(parseInfo(reply.kv).audio).toBe(1);expect(parseInfo(reply.kv).uartBaud).toBe(230400);}
  });
  it("uses shared STATUS vectors and resyncs after CRC errors and missing tails", () => {
    const parser = new AudioStatusParser();
    for (const f of frames) { let parsed=0; for (const b of f) parsed+=parser.push(new Uint8Array([b])).length; expect(parsed).toBe(1); }
    const good=frames[0]!,bad=good.slice();bad[20]^=1;
    expect(parser.push(new Uint8Array([...bad,...good.slice(0,28),...good])).length).toBe(1);
    expect(parser.rejected).toBe(2);
  });
  it("removes DC without amplifying PCM and rejects WAV/odd/empty input", () => {
    const raw=new Uint8Array(6),d=new DataView(raw.buffer);[1000,2000,3000].forEach((v,i)=>d.setInt16(i*2,v,true));
    const p=preparePcm(raw);expect(p.removedDc).toBe(2000);expect(new DataView(p.bytes.buffer).getInt16(0,true)).toBe(-1000);
    expect(()=>preparePcm(new Uint8Array())).toThrow();expect(()=>preparePcm(new Uint8Array(1))).toThrow();
    expect(()=>preparePcm(new TextEncoder().encode("RIFFWAVE"))).toThrow();expect(audioTestTone().length).toBe(16000);
  });
  it("does not turn leading digital silence into 100 ms constant DC",()=>{
    const raw=new Uint8Array(16000),d=new DataView(raw.buffer);for(let i=4000;i<8000;i++)d.setInt16(i*2,1000,true);
    const p=preparePcm(raw),f=new DataView(p.bytes.buffer);let run=0,last=0,max=0;
    for(let i=0;i<8000;i++){const v=f.getInt16(i*2,true);run=v!==0&&v===last?run+1:v!==0?1:0;last=v;max=Math.max(max,run);}
    expect(max).toBeLessThan(800);expect(f.getInt16(3000*2,true)).toBe(0);
  });
  function fake(drop=false,lowTx=false,pauseMs=60,profile?:string) {
    let now=0,ack=0,played=0,used=0,state=0,ended=false,dropped=false,sid=42;
    const capacity=lowTx?4096:2048,window=lowTx?12:6;
    let lastStatusTx=-100,pendingReason=0,maxBuffer=0;
    const sent:number[]=[],seqs:number[]=[],texts:string[]=[],pauses:number[]=[];let pausedAt=-1;
    let engine:AudioSession;
    function status(reason=0,force=true) {
      pendingReason=reason;if(lowTx&&!force&&now-lastStatusTx<100)return;lastStatusTx=now;
      const p=new Uint8Array(24),d=new DataView(p.buffer);[ack,ack+Math.floor(Math.max(capacity-used-128,0)/160),played,0].forEach((n,i)=>d.setUint32(i*4,n,true));d.setUint16(16,used,true);p[20]=state;p[21]=reason;
      engine.receive(encodeAudioFrame({type:AudioType.STATUS,sid,seq:0,payload:p}));
    }
    engine=new AudioSession({connected:()=>true,cancel:()=>{},now:()=>now,changed:()=>{},sleep:async ms=>{
      now+=ms;
      if(state===1||state===3){const n=Math.min(used,ms*8);used-=n;played+=n;if(ended&&!used)state=4;}
      if(now>=40 && pausedAt===-1 && !drop){pausedAt=now;await engine.pause();pauses.push(played);}
      if(pausedAt>=0 && now>=pausedAt+pauseMs && state===2){pauses.push(played);await engine.resume();}
      status(pendingReason,!lowTx||state===4);
    },write:async bytes=>{
      if(bytes[0]!==0xa5){texts.push(new TextDecoder().decode(bytes));const ok=new TextEncoder().encode(`@OK AUDIO OPEN v=1 sid=${sid} rate=8000 bits=16 ${profile??`cap=${capacity} guard=128 prefill=800 window=${window}`}\n`);for(const b of ok)engine.receive(new Uint8Array([b]));status();return;}
      const f=decodeAudioFrame(bytes);sent.push(f.type);
      if(f.type===AudioType.DATA){seqs.push(f.seq);if(drop && f.seq===2 && !dropped){dropped=true;return;}if(f.seq>ack){status(2,!lowTx);return;}if(f.seq===ack){expect(used+f.payload.length/2).toBeLessThanOrEqual(capacity);used+=f.payload.length/2;maxBuffer=Math.max(maxBuffer,used);ack++;if(state===0&&used>=800)state=1;}status(0,!lowTx);return;}
      if(f.type===AudioType.END){expect(f.seq).toBe(ack);ended=true;if(state!==2)state=3;}
      if(f.type===AudioType.PAUSE)state=2;if(f.type===AudioType.RESUME)state=ended?3:1;
      if(f.type===AudioType.ABORT){state=5;used=0;}if(f.type===AudioType.EXIT)state=7;
      status();
    }});
    return {engine,sent,seqs,texts,pauses,status,get maxBuffer(){return maxBuffer;},injectOld:()=>{sid=7;status();sid=42;}};
  }
  it("streams by cumulative credit, pauses consumption, ends and exits without ASCII", async()=>{
    const f=fake();await f.engine.open("D",5);await f.engine.play(audioTestTone());
    expect(f.engine.status?.played).toBe(8000);expect(f.pauses[0]).toBe(f.pauses[1]);expect(f.engine.window).toBe(6);
    f.injectOld();expect(f.engine.status?.played).toBe(8000);
    expect(await f.engine.exit()).toBe(true);expect(f.sent.slice(-2)).toEqual([AudioType.ABORT,AudioType.EXIT]);expect(f.texts).toEqual(["AUDIO OPEN D 5\n"]);
  });
  it("recovers dropped DATA by retrying the ACK gap",async()=>{
    const f=fake(true);await f.engine.open("Q",5);await f.engine.play(audioTestTone());
    expect(f.engine.status?.played).toBe(8000);expect(f.engine.retries).toBeGreaterThan(0);expect(f.seqs.filter(n=>n===2).length).toBe(2);
    expect(await f.engine.exit()).toBe(true);
  });
  it("opens Q at 1000 mA and rejects Q above 1000 or D above 200 before writing",async()=>{
    const f=fake();await expect(f.engine.open("D",201)).rejects.toThrow();await expect(f.engine.open("Q",1001)).rejects.toThrow();
    expect(f.texts).toEqual([]);await f.engine.open("Q",1000);expect(f.texts).toEqual(["AUDIO OPEN Q 1000\n"]);await f.engine.exit();
  });
  it("negotiates low TX and fills the advertised 4096 ring with sparse STATUS",async()=>{
    const f=fake(false,true);await f.engine.open("D",5);expect(f.engine.lowTx).toBe(true);expect(f.engine.capacity).toBe(4096);expect(f.engine.window).toBe(12);
    await f.engine.play(audioTestTone());expect(f.engine.status?.played).toBe(8000);expect(f.maxBuffer).toBeGreaterThan(2048);expect(await f.engine.exit()).toBe(true);
  });
  it("retries a DATA gap under low TX without flooding healthy DATA with PING",async()=>{
    const f=fake(true,true);await f.engine.open("Q",5);await f.engine.play(audioTestTone());expect(f.engine.status?.played).toBe(8000);expect(f.engine.retries).toBeGreaterThan(0);expect(await f.engine.exit()).toBe(true);
  });
  it("keeps sending heartbeat while low TX playback is paused",async()=>{
    const f=fake(false,true,260);await f.engine.open("Q",5);await f.engine.play(audioTestTone());expect(f.sent.filter(t=>t===AudioType.PING).length).toBeGreaterThanOrEqual(2);expect(f.pauses[0]).toBe(f.pauses[1]);await f.engine.exit();
  });
  it("rejects an unsupported OPEN profile before sending PCM",async()=>{
    const f=fake(false,false,60,"cap=4096 guard=128 prefill=800 window=6");await expect(f.engine.open("Q",5)).rejects.toThrow("窗口不支持");expect(f.seqs).toEqual([]);
  });
});
