/** Actual production UI -> stdio adapter -> selected UART. Requires explicit --run. */
import assert from "node:assert/strict";
import {readFileSync,readdirSync,statSync,mkdirSync,writeFileSync} from "node:fs";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {launchBrowser} from "./browser.mjs";
if(!process.argv.includes("--run"))throw new Error("Actual motor playback requires manual authorization and --run");
const option=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
const port=option("--port","COM5");
const baud=Number(option("--baud","200000"));assert.ok([200000,230400].includes(baud));
let url=option("--url","https://dr4310.233688.xyz/");let server=null;
if(process.argv.includes("--local")){
  server=createServer((req,res)=>{res.setHeader("Content-Type",req.url==="/app.js"?"application/javascript":"text/html; charset=utf-8");res.end(readFileSync(req.url==="/app.js"?"dist/pages/app.js":"dist/pages/index.html"));});
  await new Promise(r=>server.listen(0,"127.0.0.1",r));url=`http://127.0.0.1:${server.address().port}/`;
}
const file=option("--file",readdirSync("E:/Desktop").filter(n=>n.toLowerCase().endsWith(".raw")).map(n=>"E:/Desktop/"+n).sort((a,b)=>statSync(a).size-statSync(b).size)[0]);
const amp=Number(option("--amplitude-ma","1")),axis=option("--axis","D");
assert.ok(Number.isInteger(amp)&&amp>=1&&amp<=5);assert.ok(["Q","D"].includes(axis));
const raw=readFileSync(file),samples=raw.length/2;assert.ok(samples>0&&Number.isInteger(samples)&&samples<=8000*300);
const out=option("--out","../logs/upper_audio_20261014/music-live");mkdirSync(out,{recursive:true});
const browser=await launchBrowser(),page=await browser.newPage(),errors=[],wire=[],statuses=[];
let bridge=null,bridgeError="",transportClosed=false,flushing=false,chunks=[],stdout="",rx=[];
let result={file,url,port,baud,axis,amplitude_ma:amp,samples,seconds:samples/8000,passed:false};
page.on("pageerror",e=>errors.push(e.message));page.on("dialog",d=>d.accept());await page.setViewport({width:1440,height:1000});
function crc(bytes){let c=65535;for(const b of bytes){c^=b<<8;for(let i=0;i<8;i++)c=((c<<1)^((c&32768)?0x1021:0))&65535;}return c;}
let badFrames=0;
function parse(bytes){for(const b of bytes){rx.push(b);while(rx.length>=2){if(rx[0]!==165||rx[1]!==90){rx.shift();continue;}if(rx.length<12)break;if(rx[2]!==1||rx[3]!==129||rx[10]!==24||rx[11]!==0){rx.shift();continue;}if(rx.length<38)break;
  const f=Buffer.from(rx.slice(0,38));if(crc(f.subarray(2,36))!==f.readUInt16LE(36)){badFrames++;rx.shift();continue;}rx.splice(0,38);
  statuses.push({sid:f.readUInt16LE(4),ack:f.readUInt32LE(12),grant:f.readUInt32LE(16),played:f.readUInt32LE(20),underruns:f.readUInt32LE(24),buffer:f.readUInt16LE(28),faults:f.readUInt16LE(30),state:f[32],reason:f[33],reserved:f.readUInt16LE(34)});
}}}
async function flush(){if(flushing||!chunks.length)return;flushing=true;try{while(chunks.length){const data=chunks;chunks=[];await page.evaluate(a=>window.__hwReceive?.(a),data);}}catch{}finally{flushing=false;}}
await page.exposeFunction("__hwWrite",async bytes=>{
  if(bridgeError)throw new Error(bridgeError);
  if(transportClosed||!bridge||bridge.stdin.destroyed||bridge.stdin.writableEnded)throw new Error("Test transport is closed");
  await new Promise((resolve,reject)=>bridge.stdin.write(JSON.stringify({data:Buffer.from(bytes).toString("base64")})+"\n",e=>e?reject(e):resolve()));
});
await page.evaluateOnNewDocument(baud=>{
  let controller=null;window.__nativeWrites=[];
  const port={readable:null,writable:null,open:async options=>{
    if(options.baudRate!==baud)throw new Error(`Hardware adapter requires ${baud}`);
    port.readable=new ReadableStream({start:c=>controller=c,cancel:()=>controller=null});
    port.writable=new WritableStream({write:data=>{
      if(data[0]===165){const d=new DataView(data.buffer,data.byteOffset,data.byteLength);window.__nativeWrites.push({type:data[3],sid:d.getUint16(4,true),seq:d.getUint32(6,true),length:d.getUint16(10,true)});}
      else window.__nativeWrites.push(new TextDecoder().decode(data).trim());
      return window.__hwWrite(Array.from(data));
    }});
  },close:async()=>{controller=null;port.readable=port.writable=null;},getInfo:()=>({usbVendorId:0x1366})};
  window.__hwReceive=bytes=>{if(controller)controller.enqueue(new Uint8Array(bytes));};
  const serial=new EventTarget();serial.requestPort=async()=>port;serial.getPorts=async()=>[];Object.defineProperty(navigator,"serial",{value:serial,configurable:true});
  window.__hwPort=port;
},baud);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function snapshot(){return page.evaluate(()=>({status:document.getElementById("audioStatus")?.textContent,stats:document.getElementById("audioStats")?.textContent,file:document.getElementById("audioFileInfo")?.textContent,stopDisabled:document.getElementById("audioStop")?.disabled,message:document.getElementById("msg")?.textContent}));}
try{
  await page.goto(url,{waitUntil:"networkidle0"});
  bridge=spawn("../.venv/Scripts/python.exe",["../tools/browser_serial_bridge.py","--run","--port",port,"--baud",String(baud)],{stdio:["pipe","pipe","pipe"]});
  bridge.stderr.on("data",b=>{bridgeError+=b.toString();});bridge.on("error",e=>{bridgeError=e.message;});
  bridge.stdin.on("error",e=>{if(!transportClosed)bridgeError=e.message;});
  bridge.stdout.on("data",bytes=>{stdout+=bytes.toString();let n;while((n=stdout.indexOf("\n"))>=0){const line=stdout.slice(0,n);stdout=stdout.slice(n+1);if(line.trim()){const data=Buffer.from(JSON.parse(line).data,"base64");wire.push(data);parse(data);chunks.push(...data);}}setTimeout(()=>void flush(),2);});
  await sleep(200);assert.equal(bridgeError,"");
  await page.select("#serBaud",String(baud));await page.select("#dLink","serial");await page.click("#dConnect");
  await page.waitForFunction(()=>!document.getElementById("audioInputs").disabled,{timeout:15000});
  await page.click('[data-view="audio"]');await page.select("#audioAxis",axis);await page.$eval("#audioAmp",(e,v)=>{e.value=String(v);},amp);await page.click("#audioReady");
  await (await page.$("#audioFile")).uploadFile(file);await page.waitForFunction(()=>!document.getElementById("audioPlay").disabled,{timeout:10000});
  console.log("START",JSON.stringify({file,axis,amplitude_ma:amp,samples,seconds:samples/8000}));
  await page.click("#audioPlay");await page.waitForFunction(()=>!document.getElementById("audioStop").disabled,{timeout:3000});
  const started=Date.now(),deadline=started+samples/8000*1000+20000;let reportAt=0;
  while(Date.now()<deadline){
    if(bridgeError)throw new Error(bridgeError);
    const state=await snapshot();
    if(Date.now()>=reportAt){console.log("PROGRESS",JSON.stringify(state));reportAt=Date.now()+10000;}
    if(state.stopDisabled){result.ui=state;break;}
    await sleep(100);
  }
  result.elapsed_seconds=(Date.now()-started)/1000;result.ui=await snapshot();
  assert.ok(result.ui.status?.includes("播放完成"),JSON.stringify(result.ui));
  const finish=statuses.findLast(s=>s.state===4);assert.ok(finish,"No independently validated FINISHED STATUS");
  assert.equal(finish.played,samples);assert.equal(finish.ack,Math.ceil(samples/160));assert.equal(finish.underruns,0);assert.equal(finish.faults,0);
  assert.ok(!statuses.some(s=>s.state===6||s.underruns||s.faults));assert.ok(statuses.some(s=>s.sid===finish.sid&&s.state===7));
  result.finished=finish;result.writes=await page.evaluate(()=>window.__nativeWrites);result.passed=true;
  await page.screenshot({path:out+"/finished.png"});console.log("MUSIC PLAYBACK PASSED",JSON.stringify(finish));
}catch(e){result.error=e.message;result.ui=await snapshot().catch(()=>null);console.error("MUSIC TEST FAILED",e.message);process.exitCode=1;}
finally{
  await page.evaluate(()=>document.getElementById("estop")?.click()).catch(()=>{});await sleep(1500);
  // Stop the page's ASCII polling before ending stdin; the page remains an
  // active writer after audio EXIT. Keep the bridge alive during page close.
  try {
    await page.evaluate(()=>{if(window.__hwPort?.readable)document.getElementById("serDisconnect")?.click();});
    await page.waitForFunction(()=>!window.__hwPort?.readable,{timeout:5000});
  }catch(e){result.error??=`Disconnect cleanup failed: ${e.message}`;result.passed=false;process.exitCode=1;}
  await browser.close();transportClosed=true;
  if(bridge){bridge.stdin.end();await Promise.race([new Promise(r=>bridge.once("exit",r)),sleep(2500)]);}
  result.errors=errors;result.bad_status_crc_frames=badFrames;result.statuses=statuses;result.transport=`Production browser UI and actual ${port}/${baud} via test-only stdio adapter`;
  writeFileSync(out+"/result.json",JSON.stringify(result,null,2));writeFileSync(out+"/uart.rx.bin",Buffer.concat(wire));
  server?.close();
}
