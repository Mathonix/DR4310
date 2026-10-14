export function installFakeAudio(baud=230400,lowTx=false,workerMode=false) {
  let ctl=null,binary=false,sid=40,ack=0,played=0,used=0,state=0,ended=false,partial=false,lastInput=0;
  const capacity=lowTx?4096:2048,windowSize=lowTx?12:6;let lastStatusTx=0;
  const enc=new TextEncoder(), ram={TELEM:1,IQ_LIM:1.9,OL_EN:1,OL_IQ:2.2,OL_TIME_S:2,TIMEOUT_MS:0,BOOT_MODE:0,BOOT_AE:0};
  const dev=window.__audioDev={mode:0,ae:0,ram,frames:[],commands:[],illegalAscii:0,played:0,used:0,state:0,binary:false};
  function crc(bytes){let c=65535;for(const b of bytes){c^=b<<8;for(let i=0;i<8;i++)c=((c<<1)^((c&32768)?0x1021:0))&65535;}return c;}
  function push(bytes){if(ctl){for(let i=0;i<bytes.length;i+=7)ctl.enqueue(bytes.slice(i,i+7));}}
  function text(s){push(enc.encode(s+"\n"));}
  function status(reason=0){
    lastStatusTx=Date.now();
    const b=new Uint8Array(38),d=new DataView(b.buffer);b.set([165,90,1,129]);d.setUint16(4,sid,true);d.setUint16(10,24,true);
    [ack,ack+Math.floor(Math.max(capacity-used-128,0)/160),played,0].forEach((v,i)=>d.setUint32(12+i*4,v,true));d.setUint16(28,used,true);b[32]=state;b[33]=reason;d.setUint16(36,crc(b.subarray(2,36)),true);
    if(window.__badStatus && ack>=3){window.__badStatus=false;const bad=b.slice();bad[20]^=1;push(bad);}
    push(b);Object.assign(dev,{played,used,state,binary});
  }
  const names="IdRef,Id,IqRef,Iq,VdUnsat,VqUnsat,VdSat,VqSat,Vbus,Vsat,Omega,DutyA,DutyB,DutyC,CurKp,CurKi";
  function ascii(line){
    dev.commands.push(line);const t=line.trim().split(/\s+/),c=t[0];
    if(c==="AUDIO"){sid++;ack=played=used=0;state=0;ended=partial=false;binary=true;lastInput=Date.now();text(`@OK AUDIO OPEN v=1 sid=${sid} rate=8000 bits=16 cap=${capacity} guard=128 prefill=800 window=${windowSize}`);status();return;}
    if(c==="INFO"){text(`@INFO fw=DR4310 ver=3.4.5 id=2 cfg_id=2 mode=${dev.mode} run=${dev.mode?"CURRENT":"IDLE"} drv=${dev.mode?1:0} ae=${dev.ae} telem=${ram.TELEM} fault=0x0000 latched=0x0000 vbus=24 calib=1 zero=0.134657 dir=1 cfg=flash seq=18 timeout=0 trips=0 drops=0 up=1000 pp=14 baud=1000000 audio=1 uart_baud=${baud} audio_qmax_ma=2000 audio_dmax_ma=1500`);return;}
    if(c==="PING"){text("@PONG up=1000");return;}
    if(c==="HELP"){text("@OK HELP STOP RUN IQ AE TELEM INFO GET SET TLIST TCH TRATE FAULT AUDIO");return;}
    if(c==="GET"){for(const [k,v]of Object.entries(ram))text(`@P ${k}=${v} min=0 max=60000`);text("@OK GET 8");return;}
    if(c==="TLIST"){text("@TLIST "+names);return;}if(c==="TCH"){text("@TCH "+names);return;}if(c==="TRATE"){text("@OK TRATE hz=100 period_ms=10");return;}if(c==="FAULT"){text("@FAULT active=0x0000 latched=0x0000 snap=0");return;}
    if(c==="STOP"){dev.mode=0;dev.ae=0;}if(c==="RUN")dev.mode=1;if(c==="AE")dev.ae=Number(t[1]);if(c==="TELEM")ram.TELEM=Number(t[1]);if(c==="SET")ram[t[1]]=Number(t[2]);
    text("@OK "+c);
  }
  let rx="";
  const port={readable:null,writable:null,open:async options=>{
    if(options.baudRate!==baud)throw new Error("Selected baud does not match simulated firmware");
    port.readable=new ReadableStream({start:c=>ctl=c,cancel:()=>ctl=null});
    port.writable=new WritableStream({write:bytes=>{
      if(bytes[0]!==165){if(binary){dev.illegalAscii++;return;}rx+=new TextDecoder().decode(bytes);let n;while((n=rx.indexOf("\n"))>=0){const line=rx.slice(0,n);rx=rx.slice(n+1);if(line.trim())ascii(line.trim());}return;}
      const d=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),type=bytes[3],seq=d.getUint32(6,true),len=d.getUint16(10,true);
      if(crc(bytes.subarray(2,12+len))!==d.getUint16(12+len,true))throw new Error("Host CRC failed");
      dev.frames.push({type,seq,len});lastInput=Date.now();
      if(type===1){const before=state;if(seq>ack){if(!lowTx)status(2);return;}if(seq===ack){if(partial||used+len/2>capacity)throw new Error("Invalid host credit/partial");ack++;used+=len/2;partial=len<320;if(state===0&&used>=800)state=1;}if(lowTx&&state===before)return;}
      if(type===2){if(seq!==ack)throw new Error("Bad END seq");ended=true;if(state!==2)state=3;}
      if(type===6)state=2;if(type===7)state=ended?3:used>=800?1:0;
      if(type===3){state=5;used=0;dev.mode=0;dev.ae=0;}
      if(type===5){state=7;used=0;dev.mode=0;dev.ae=0;status();binary=false;return;}
      status();
    }});
  },close:async()=>{ctl=null;port.readable=port.writable=null;},getInfo:()=>({usbVendorId:0x1366})};
  setInterval(()=>{if(binary){const before=state;if(state===1||state===3){const count=Math.min(used,40);used-=count;played+=count;if(ended&&!used){state=4;dev.mode=0;}}if(Date.now()-lastInput>=300){state=5;dev.mode=0;}if(!lowTx||state!==before||Date.now()-lastStatusTx>=100)status();}},5);
  if(workerMode)Object.defineProperty(port,Symbol.toStringTag,{value:"SerialPort"});
  const serial=new EventTarget();serial.requestPort=async()=>port;serial.getPorts=async()=>workerMode?[port]:[];Object.defineProperty(navigator,"serial",{value:serial,configurable:true});
}
