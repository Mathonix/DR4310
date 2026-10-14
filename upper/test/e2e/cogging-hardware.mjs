/** Explicit live test: drives the attached COM5 motor from the actual browser UI. */
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFileSync,mkdirSync,writeFileSync} from "node:fs";
import {launchBrowser} from "./browser.mjs";
import {spawn} from "node:child_process";
if(!process.argv.includes("--run")) throw new Error("Live motor test requires --run");
const option=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
const port=option("--port","COM5"),baud=Number(option("--baud","200000"));assert.ok([200000,230400].includes(baud));
const out="../logs/cogging_hw_20261013/browser";mkdirSync(out,{recursive:true});
const server=createServer((req,res)=> {res.setHeader("Content-Type",req.url==="/app.js"?"text/javascript":"text/html; charset=utf-8");res.end(readFileSync(req.url==="/app.js"?"dist/pages/app.js":"dist/pages/index.html"));});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const url=process.argv.find(a=>a.startsWith("http")) || `http://127.0.0.1:${server.address().port}/`;
const browser=await launchBrowser(),p=await browser.newPage(),errors=[];
p.on("pageerror",e=>errors.push(e.message));p.on("dialog",d=>d.accept());
await p.setViewport({width:1440,height:1100});
const bridge=spawn("../.venv/Scripts/python.exe",["../tools/browser_serial_bridge.py","--run","--port",port,"--baud",String(baud)],{stdio:["pipe","pipe","inherit"]});
let rx="",chunks=[],flushing=false;
async function flush() {
  if(flushing || !chunks.length) return;
  flushing=true;
  try { while(chunks.length) { const data=chunks;chunks=[];await p.evaluate(a=>window.__hwReceive?.(a),data); } }
  catch {} finally { flushing=false; }
}
bridge.stdout.on("data",bytes=> {
  rx+=bytes.toString();let end;
  while((end=rx.indexOf("\n"))>=0){const line=rx.slice(0,end);rx=rx.slice(end+1);if(line.trim())chunks.push(...Buffer.from(JSON.parse(line).data,"base64"));}
  setTimeout(()=>void flush(),8);
});
await p.exposeFunction("__hwWrite",async bytes=> {await new Promise((resolve,reject)=>bridge.stdin.write(JSON.stringify({data:Buffer.from(bytes).toString("base64")})+"\n",e=>e?reject(e):resolve()));});
await p.evaluateOnNewDocument(baud=> {
  let controller=null;
  const port={readable:null,writable:null,
    open:async options=> {
      if(options.baudRate!==baud)throw new Error(`Real UART bridge expects ${baud}`);window.__baud=options.baudRate;
      port.readable=new ReadableStream({start:c=>controller=c,cancel:()=>controller=null});
      port.writable=new WritableStream({write:data=>window.__hwWrite(Array.from(data))});
    },close:async()=>{controller=null;port.readable=null;port.writable=null;},getInfo:()=>({usbVendorId:0x1366})};
  window.__hwReceive=bytes=> {if(controller)controller.enqueue(new Uint8Array(bytes));};
  const serial=new EventTarget();serial.requestPort=async()=>port;serial.getPorts=async()=>[];
  Object.defineProperty(navigator,"serial",{value:serial,configurable:true});
},baud);
await p.evaluateOnNewDocument(()=> {
  localStorage.clear();window.__writes=[];window.__downloads=[];
  const write=WritableStreamDefaultWriter.prototype.write;
  WritableStreamDefaultWriter.prototype.write=function(data){if(data instanceof Uint8Array)window.__writes.push(new TextDecoder().decode(data).trim());return write.call(this,data);};
  const click=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){if(this.download&&this.href.startsWith("blob:")){const name=this.download;fetch(this.href).then(r=>r.text()).then(text=>window.__downloads.push({name,text}));return;}return click.call(this);};
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function status(){return p.$eval("#cogStatus",e=>e.textContent);}
async function idle(){await p.waitForFunction(()=>document.getElementById("cogStop").disabled,{timeout:12000});await p.waitForFunction(()=>document.getElementById("pd_IQ_LIM")?.textContent==="1.9",{timeout:12000});}
async function start(){console.log("START state",await p.evaluate(()=>({disabled:document.getElementById("cogStart").disabled,checked:document.getElementById("cogReady").checked,hint:document.getElementById("cogHint").textContent,modified:Array.from(document.querySelectorAll("tr.mod")).map(e=>e.id)})));await p.click("#cogStart");await sleep(100);console.log("START response",await p.$eval("#msg",e=>e.textContent));await p.waitForFunction(()=>document.getElementById("cogStatus").textContent.includes("正向扫描"),{timeout:12000});}
try {
  await p.goto(url,{waitUntil:"networkidle0"});
  await p.select("#serBaud",String(baud));
  await p.select('[data-testid="connection-route"]',"serial");await p.click("#dConnect");
  await p.waitForFunction(()=>document.getElementById("pd_COG_EN")?.textContent==="1",{timeout:15000});
  assert.equal(await p.evaluate(()=>window.__baud),baud);
  await p.click('#views button[data-view="cfg"]');await p.click("#cogReady");
  // Begin, try competing control, then stop via the dedicated button.
  await start();await sleep(3500);
  const writesBefore=await p.evaluate(()=>window.__writes.length);
  await p.evaluate(()=> {document.getElementById("uCustom").value="SPD 10";document.getElementById("uCustomSend").click();document.getElementById("dStart").click();});
  await sleep(250);
  assert.ok(!(await p.evaluate(n=>window.__writes.slice(n),writesBefore)).includes("SPD 10"));
  await p.click("#cogStop");await idle();console.log("STOP / competing controls:",await status());
  assert.match(await status(),/停止/);
  // Hidden page must stop even when the general hidden-page checkbox is off.
  await p.$eval("#wdHidden",e=>e.checked=false);await start();await sleep(700);
  await p.evaluate(()=> {Object.defineProperty(document,"visibilityState",{configurable:true,value:"hidden"});document.dispatchEvent(new Event("visibilitychange"));});
  await idle();assert.match(await status(),/隐藏/);console.log("Hidden-page cancellation passed");
  await p.evaluate(()=> {delete document.visibilityState;document.dispatchEvent(new Event("visibilitychange"));});
  await start();
  let prior="";
  for(let i=0;i<170;i++) {
    await sleep(1000);const s=await status();
    if(i%10===0||s.includes("反向")&&!prior.includes("反向"))console.log(s);
    prior=s;if(await p.$eval("#cogStop",e=>e.disabled))break;
  }
  await idle();assert.match(await status(),/补偿表已生成/);
  await p.click("#cogExport");await p.waitForFunction(()=>window.__downloads.length>0);
  const generated=await p.evaluate(()=>JSON.parse(window.__downloads[0].text));
  assert.equal(generated.current_ma.length,512);assert.ok(generated.quality.min_samples_per_bin>=4);
  writeFileSync(out+"/web-map.json",JSON.stringify(generated,null,2));
  console.log("WEB MAP",generated.crc32,generated.quality);
  await p.$eval("#cogPanel",e=>e.scrollIntoView());await p.screenshot({path:out+"/desktop.png"});
  await p.setViewport({width:390,height:844});await p.screenshot({path:out+"/mobile.png",fullPage:true});await p.setViewport({width:1440,height:1100});
  await p.click("#cogUpload");
  await p.waitForFunction(()=>document.getElementById("cogStatus").textContent.includes("已保存并校验"),{timeout:40000});await idle();
  assert.equal(await p.$eval("#pd_COG_EN",e=>e.textContent),"0");
  await p.click("#cogBackup");await p.waitForFunction(()=>window.__downloads.length===2);
  const backup=await p.evaluate(()=>JSON.parse(window.__downloads[1].text));assert.equal(backup.current_ma.length,512);assert.match(backup.crc32,/^[0-9a-f]{8}$/i);writeFileSync(out+"/original-map.json",JSON.stringify(backup,null,2));
  await p.click("#cogEnable");await p.waitForFunction(()=>document.getElementById("cogStatus").textContent.includes("已启用并保存"),{timeout:12000});await idle();
  assert.equal(await p.$eval("#pd_COG_EN",e=>e.textContent),"1");
  assert.deepEqual(errors,[]);
  const result=await p.evaluate(()=>({baud:window.__baud,writes:window.__writes,status:document.getElementById("cogStatus").textContent,result:document.getElementById("cogResult").textContent,run:document.getElementById("cfgRun").textContent}));
  writeFileSync(out+"/result.json",JSON.stringify({...result,port,transport:`test-only stdio adapter to real ${port} ${baud}`,errors,passed:true},null,2));console.log("BROWSER LIVE TEST PASSED",result.status,result.run);
} catch(e) {
  const state=await p.evaluate(()=>({writes:window.__writes,status:document.getElementById("cogStatus")?.textContent,msg:document.getElementById("msg")?.textContent,fw:document.getElementById("stFw")?.textContent,ser:document.getElementById("stSer")?.textContent,route:document.getElementById("dLink")?.value})).catch(()=>null);
  writeFileSync(out+"/failure.json",JSON.stringify({error:e.message,errors,state},null,2));throw e;
} finally {
  // Leave driver off before releasing the native serial port.
  await p.evaluate(()=>document.getElementById("estop")?.click()).catch(()=>{});await sleep(1200);
  await browser.close();server.close();bridge.stdin.end();
}
