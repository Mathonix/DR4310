import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFileSync,mkdirSync,writeFileSync} from "node:fs";
import {launchBrowser} from "./browser.mjs";
import {installFakeAudio} from "./fake-audio.mjs";
const out="../logs/upper_audio_20261014";mkdirSync(out,{recursive:true});
const baudIndex=process.argv.indexOf("--baud"),baud=baudIndex<0?230400:Number(process.argv[baudIndex+1]);assert.ok([200000,230400].includes(baud));
const lowTx=process.argv.includes("--low-tx");
const server=createServer((req,res)=>{res.setHeader("Content-Type",req.url==="/app.js"?"application/javascript":"text/html; charset=utf-8");res.end(readFileSync(req.url==="/app.js"?"dist/pages/app.js":"dist/pages/index.html"));});
await new Promise(r=>server.listen(0,"127.0.0.1",r));const url=process.argv.find(a=>a.startsWith("http"))||`http://127.0.0.1:${server.address().port}/`;
const browser=await launchBrowser(),p=await browser.newPage(),errors=[];
p.on("pageerror",e=>errors.push(e.message));p.on("dialog",d=>d.accept());await p.setViewport({width:1440,height:1000});await p.evaluateOnNewDocument(installFakeAudio,baud,lowTx);
try{
  await p.goto(url,{waitUntil:"networkidle0"});await p.select("#serBaud",String(baud));await p.select("#dLink","serial");await p.click("#dConnect");
  await p.waitForFunction(()=>!document.getElementById("audioInputs").disabled,{timeout:10000});await p.click('[data-view="audio"]');await p.click("#audioReady");
  assert.equal(await p.$eval("#audioAmp",e=>e.max),"1000");await p.select("#audioAxis","D");assert.equal(await p.$eval("#audioAmp",e=>e.max),"200");await p.select("#audioAxis","Q");
  await p.evaluate(()=>window.__badStatus=true);await p.click("#audioTest");await p.waitForFunction(()=>window.__audioDev.state===1);
  if(lowTx)assert.ok(await p.$eval("#audioHint",e=>e.textContent.includes("短 TX 模式已生效")));
  await p.click("#audioPause");await p.waitForFunction(()=>window.__audioDev.state===2);const paused=await p.evaluate(()=>window.__audioDev.played);await new Promise(r=>setTimeout(r,100));assert.equal(await p.evaluate(()=>window.__audioDev.played),paused);
  await p.click("#audioPause");await p.waitForFunction(()=>document.getElementById("audioStatus").textContent.includes("播放完成"),{timeout:10000});
  let result=await p.evaluate(()=>window.__audioDev);assert.equal(result.played,8000);assert.equal(result.illegalAscii,0);assert.equal(result.ram.TELEM,1);assert.equal(result.mode,0);
  // Short final DATA and DC-filtered file, then a separate emergency stop.
  await p.evaluate(()=>{const bytes=new Uint8Array(8002),d=new DataView(bytes.buffer);for(let i=0;i<4001;i++)d.setInt16(i*2,1000+Math.round(5000*Math.sin(i*.2)),true);const dt=new DataTransfer();dt.items.add(new File([bytes],"music.raw"));const input=document.getElementById("audioFile");input.files=dt.files;input.dispatchEvent(new Event("change",{bubbles:true}));});
  await p.waitForFunction(()=>!document.getElementById("audioPlay").disabled);await p.select("#audioAxis","D");await p.click("#audioPlay");await p.waitForFunction(()=>document.getElementById("audioStatus").textContent.includes("播放完成"),{timeout:10000});assert.equal(await p.evaluate(()=>window.__audioDev.played),4001);
  await p.click("#audioTest");await p.waitForFunction(()=>window.__audioDev.state===1);await p.keyboard.press("Escape");await p.waitForFunction(()=>document.getElementById("audioStop").disabled,{timeout:10000});
  await p.select("#audioAxis","Q");await p.$eval("#audioAmp",e=>{e.value="1000";});await p.click("#audioPlay");await p.waitForFunction(()=>document.getElementById("audioStatus").textContent.includes("播放完成"),{timeout:10000});
  assert.ok(await p.evaluate(()=>window.__audioDev.commands.includes("AUDIO OPEN Q 1000")));
  result=await p.evaluate(()=>window.__audioDev);assert.equal(result.mode,0);assert.equal(result.illegalAscii,0);assert.equal(result.ram.TELEM,1);assert.equal(errors.length,0);
  await p.screenshot({path:`${out}/audio-desktop.png`});await p.setViewport({width:390,height:844});await p.screenshot({path:`${out}/audio-mobile.png`});
  const overflow=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);
  writeFileSync(`${out}/browser-${url.startsWith("https:")?"online":"local"}-${baud}-${lowTx?"low-tx":"standard"}.json`,JSON.stringify({passed:true,errors,result,url,baud,lowTx},null,2));console.log("AUDIO browser playback / credit / pause / corrupt STATUS / partial DATA / Esc / restore passed",baud,lowTx);
}catch(e){writeFileSync(`${out}/browser-failed.json`,JSON.stringify({error:String(e),errors,state:await p.evaluate(()=>({dev:window.__audioDev,text:document.body.innerText}))},null,2));throw e;}
finally{await browser.close();server.close();}
