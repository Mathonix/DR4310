/** Real IndexedDB + actual dedicated worker with a simulated serial device. No motor I/O. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { launchBrowser } from "./browser.mjs";
import { installFakeAudio } from "./fake-audio.mjs";
import { build } from "esbuild";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
const apiBundle = await build({entryPoints:["src/music-api.ts"],bundle:true,platform:"node",format:"esm",write:false});
const {musicApi} = await import("data:text/javascript;base64,"+Buffer.from(apiBundle.outputFiles[0].contents).toString("base64"));
const cloudEntries = new Map();
const env = {MUSIC_LIBRARY_KEY:"browser-test-key",MUSIC_KV:{
  list:async()=>({keys:[...cloudEntries].map(([name,e])=>({name,metadata:e.metadata})),list_complete:true}),
  getWithMetadata:async key=>{const e=cloudEntries.get(key);return{value:e?new ReadableStream({start(c){c.enqueue(new Uint8Array(e.bytes));c.close();}}):null,metadata:e?.metadata};},
  put:async(key,bytes,{metadata})=>cloudEntries.set(key,{bytes,metadata}),delete:async key=>cloudEntries.delete(key)
}};
const out = "../logs/music_library_20261014"; mkdirSync(out, { recursive: true });
const prefix = `(${installFakeAudio.toString()})(200000,true,true);`;
const auth = `localStorage.setItem('dr4310-music-access','browser-test-key');`;
function remoteFakeSerial() {
  let socket=null,controller=null;
  const port={readable:null,writable:null,getInfo:()=>({usbVendorId:0x1366}),open:async()=>{
    socket=new WebSocket(`ws://${location.host}/test-serial`);socket.binaryType='arraybuffer';
    port.readable=new ReadableStream({start:c=>controller=c,cancel:()=>controller=null});
    socket.onmessage=e=>{if(typeof e.data==='string')self.postMessage({event:'testDevice',state:JSON.parse(e.data)});else controller?.enqueue(new Uint8Array(e.data));};
    socket.onclose=()=>{controller?.close();controller=null;};
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    port.writable=new WritableStream({write:bytes=>socket.send(bytes)});
  },close:async()=>{controller=null;socket?.close();port.readable=port.writable=null;}};
  Object.defineProperty(navigator,'serial',{value:{getPorts:async()=>[port]},configurable:true});
}
const observe = `const NativeWorker=Worker;window.Worker=class extends NativeWorker{constructor(...a){super(...a);this.addEventListener('message',e=>{if(e.data.event==='testDevice')window.__workerDev=e.data.state;});}};`;
const server = createServer(async (req, res) => {
  const name = new URL(req.url, "http://local").pathname;
  if(name.startsWith('/api/music')) {
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const response=await musicApi(new Request('http://local'+req.url,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)}),env);
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
  }
  res.setHeader("Content-Type", name.endsWith(".js") ? "application/javascript" : "text/html; charset=utf-8");
  if (name === "/serial-worker.js") res.end(`(${remoteFakeSerial.toString()})();` + readFileSync("dist/pages/serial-worker.js", "utf8"));
  else if (name === "/app.js") res.end(readFileSync("dist/pages/app.js"));
  else res.end(readFileSync("dist/pages/index.html", "utf8").replace('<script src="./app.js" defer>', `<script>${auth}${prefix}${observe}</script><script src="./app.js" defer>`));
});
const websocket=new WebSocketServer({noServer:true});
server.on('upgrade',(request,socket,head)=>websocket.handleUpgrade(request,socket,head,ws=>websocket.emit('connection',ws)));
websocket.on('connection',async ws=>{
  const context={},nav={},timers=[];
  // The peripheral clock runs in Node, independently from page/worker timer
  // throttling; UART replies arrive as I/O events rather than browser timers.
  new Function('window','navigator','setInterval',`(${installFakeAudio.toString()})(200000,true,true);`)(context,nav,(fn,ms)=>{const timer=setInterval(fn,ms);timers.push(timer);return timer;});
  const port=await nav.serial.requestPort();await port.open({baudRate:200000});
  const reader=port.readable.getReader();
  void(async()=>{try{for(;;){const{value,done}=await reader.read();if(done)break;if(ws.readyState===1)ws.send(value);}}catch{}finally{reader.releaseLock();}})();
  const writer=port.writable.getWriter();
  ws.on('message',bytes=>{void writer.write(new Uint8Array(bytes)).catch(e=>{console.error(e.message);ws.close();});});
  const snapshot=setInterval(()=>{if(ws.readyState===1)ws.send(JSON.stringify(context.__audioDev));},50);
  ws.on('close',()=>{clearInterval(snapshot);for(const t of timers)clearInterval(t);void reader.cancel();writer.releaseLock();void port.close();});
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await launchBrowser(), page = await browser.newPage(), errors = [];
page.on("pageerror", e => errors.push(e.message)); page.on("dialog", d => d.accept());
const wait = ms => new Promise(r => setTimeout(r, ms));
async function ready(p) {
  await p.select("#dLink", "serial"); await p.click("#dConnect");
  await p.waitForFunction(() => !document.getElementById("audioInputs").disabled, { timeout: 10000 });
  await p.click('[data-view="audio"]'); await p.click("#audioReady");
}
async function running(p) { await p.waitForFunction(() => window.__workerDev?.state === 1); }
async function finished(p) {
  await p.waitForFunction(() => document.getElementById("audioStatus").textContent.includes("播放完成"), { timeout: 10000, polling: 100 });
  await p.waitForFunction(() => window.__workerDev.mode === 0, { polling: 100 });
}
async function seek(p, seconds) { await p.$eval("#audioSeek", (e, v) => { e.value = String(v); e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); }, seconds); }
try {
  await page.goto(url, { waitUntil: "networkidle0" }); await page.click('[data-view="audio"]');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    for (const [name, hz] of [["track-one.raw", 300], ["<img src=x onerror=alert(1)>.raw", 400]]) {
      const bytes = new Uint8Array(64000), d = new DataView(bytes.buffer);
      for (let i = 0; i < 32000; i++) d.setInt16(i * 2, Math.round(16000 * Math.sin(2 * Math.PI * hz * i / 8000)), true);
      dt.items.add(new File([bytes], name));
    }
    const input = document.getElementById("audioFile"); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll(".music-row").length === 2);
  assert.equal(cloudEntries.size,2);
  assert.equal(await page.$$("#audioLibrary img").then(a => a.length), 0);
  // Reimport identical music: content deduplication keeps two rows.
  await page.evaluate(() => { const input = document.getElementById("audioFile"); input.dispatchEvent(new Event("change", { bubbles: true })); });
  await wait(250); assert.equal(await page.$$(".music-row").then(a => a.length), 2);
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.querySelectorAll(".music-row").length === 2);
  const remoteContext=await browser.createBrowserContext(),remotePage=await remoteContext.newPage();
  await remotePage.goto(url,{waitUntil:'networkidle0'});await remotePage.click('[data-view="audio"]');
  await remotePage.waitForFunction(()=>document.querySelectorAll('.music-row').length===2);
  await remotePage.click('.music-row button[data-action="select"]');
  await remotePage.waitForFunction(()=>!document.getElementById('audioDownload').disabled);
  await remoteContext.close();
  await ready(page);
  await page.click('.music-row button[data-action="play"]'); await running(page);
  await seek(page, 3);
  await page.waitForFunction(() => window.__workerDev.commands.filter(c => c.startsWith("AUDIO OPEN")).length === 2);
  await finished(page);
  assert.equal(await page.evaluate(() => window.__workerDev.played), 8000);
  // Pause then seek: new session stays paused and no PCM is consumed.
  await page.click("#audioPlay"); await running(page); await page.click("#audioPause");
  await page.waitForFunction(() => window.__workerDev.state === 2);
  const opens = await page.evaluate(() => window.__workerDev.commands.filter(c => c.startsWith("AUDIO OPEN")).length);
  await seek(page, 2);
  await page.waitForFunction(n => window.__workerDev.commands.filter(c => c.startsWith("AUDIO OPEN")).length > n && window.__workerDev.state === 2, {}, opens);
  await wait(350); assert.equal(await page.evaluate(() => window.__workerDev.played), 0);
  await page.click("#audioPause"); await finished(page);
  assert.equal(await page.evaluate(() => window.__workerDev.played), 16000);
  // Main thread is blocked longer than the 300 ms firmware watchdog. Worker
  // still sends DATA/PING, including while the tab is hidden and view changes.
  await page.click("#audioPlay"); await running(page); await page.click('[data-view="dash"]');
  const other = await browser.newPage(); await other.goto("about:blank"); await other.bringToFront();
  await page.evaluate(() => { const end = performance.now() + 650; while (performance.now() < end) {} });
  await finished(page); assert.equal(await page.evaluate(() => window.__workerDev.played), 32000); await other.close();
  await page.bringToFront(); await page.click('[data-view="audio"]');
  // STOP wins over a queued seek restart.
  await page.click("#audioPlay"); await running(page);
  const beforeStop = await page.evaluate(() => window.__workerDev.commands.filter(c => c.startsWith("AUDIO OPEN")).length);
  await page.evaluate(() => { const e = document.getElementById("audioSeek"); e.value = "1"; e.dispatchEvent(new Event("change", { bubbles: true })); document.getElementById("audioStop").click(); });
  await page.waitForFunction(() => document.getElementById("audioStop").disabled); await wait(200);
  assert.equal(await page.evaluate(() => window.__workerDev.commands.filter(c => c.startsWith("AUDIO OPEN")).length), beforeStop);
  await page.setViewport({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: out + "/library-mobile.png", fullPage: true });
  // Opening the independent player carries the selected song, uses the same
  // IndexedDB, and playback continues after its opener is closed.
  const popupPromise = new Promise(resolve => page.once("popup", resolve)); await page.click("#audioDetach");
  const popup = await popupPromise; popup.on("pageerror", e => errors.push(e.message)); popup.on("dialog", d => d.accept());
  await popup.waitForFunction(() => document.querySelector(".music-row.active")); await ready(popup);
  await popup.click("#audioPlay"); await running(popup); await page.close();
  await finished(popup); assert.equal(await popup.evaluate(() => window.__workerDev.played), 32000);
  await popup.click('.music-row.active button[data-action="delete"]');
  await popup.waitForFunction(() => document.querySelectorAll(".music-row").length === 1);
  assert.equal(await popup.$eval("#audioDownload", e => e.disabled), true);
  assert.deepEqual(errors, []);
  assert.equal(cloudEntries.size,1);
  writeFileSync(out + "/report.json", JSON.stringify({ passed: true, checks: ["cloud cross-browser sync", "cloud PCM download", "multi-file import", "persistent IndexedDB", "dedup", "safe file names", "seek while playing", "seek while paused", "STOP beats seek", "650 ms main-thread block", "hidden tab", "view change", "independent window survives opener close", "delete", "mobile layout"], errors }, null, 2));
  console.log("Music library / seek / worker background / independent player PASSED");
} catch(e) {
  console.error("LIBRARY FAILED", e.message);
  console.error(await page.evaluate(() => ({status:document.getElementById('audioStatus')?.textContent, stats:document.getElementById('audioStats')?.textContent, device:window.__workerDev, errors:window.__errors})).catch(()=>({closed:true})));
  throw e;
} finally { await browser.close(); websocket.close(); server.close(); }
