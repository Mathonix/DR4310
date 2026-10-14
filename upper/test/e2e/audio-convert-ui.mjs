import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { launchBrowser } from "./browser.mjs";
import { installFakeAudio } from "./fake-audio.mjs";

const out = resolve("../logs/continue_task2_20261014");
mkdirSync(out, { recursive: true });
const downloads = mkdtempSync(join(out, "downloads-"));
// A real 44.1 kHz stereo WAV, including DC and a tone above the target Nyquist.
const rate = 44100, count = rate, wav = Buffer.alloc(44 + count * 4);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(count * 4, 40);
for (let i = 0; i < count; i++) {
  const low = Math.sin(2 * Math.PI * 500 * i / rate), high = Math.sin(2 * Math.PI * 6000 * i / rate);
  wav.writeInt16LE(Math.round(32767 * (.1 + .3 * low + .1 * high)), 44 + i * 4);
  wav.writeInt16LE(Math.round(32767 * (.1 + .2 * low + .1 * high)), 46 + i * 4);
}
const wavPath = join(out, "stereo.wav"); writeFileSync(wavPath, wav);
for (const ext of ["mp3", "flac"]) {
  const encoded = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", wavPath, join(out, `music-${ext}.${ext}`)], { encoding: "utf8", windowsHide: true });
  assert.equal(encoded.status, 0, encoded.stderr || "ffmpeg is required only to generate the browser test fixtures");
}
const server = createServer((req, res) => {
  res.setHeader("Content-Type", req.url === "/app.js" ? "application/javascript" : "text/html; charset=utf-8");
  res.end(readFileSync(req.url === "/app.js" ? "dist/pages/app.js" : "dist/pages/index.html"));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = process.argv.find(a => a.startsWith("http")) || `http://127.0.0.1:${server.address().port}/`;
const browser = await launchBrowser(), page = await browser.newPage(), errors = [], results = [];
page.on("pageerror", e => errors.push(e.message)); await page.setViewport({ width: 1440, height: 1000 });
await page.evaluateOnNewDocument(installFakeAudio, 200000, true);
const cdp = await page.createCDPSession(); await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
async function waitForFile(path) {
  const deadline = Date.now() + 10000;
  while (!existsSync(path)) { assert.ok(Date.now() < deadline, `download missing: ${path}`); await new Promise(r => setTimeout(r, 50)); }
  return readFileSync(path);
}
async function choose(path) {
  const input = await page.$("#audioFile"); await input.uploadFile(path);
  await page.waitForFunction(() => !document.getElementById("audioDownload").disabled, { timeout: 10000 });
}
try {
  await page.goto(url, { waitUntil: "networkidle0" }); await page.click('[data-view="audio"]');
  assert.equal(await page.$eval("#audioFileInputs", e => e.disabled), false);
  assert.equal(await page.$eval("#audioInputs", e => e.disabled), true);
  for (const [name, fileName] of [["stereo", "stereo.wav"], ["music-mp3", "music-mp3.mp3"], ["music-flac", "music-flac.flac"]]) {
    const path = join(out, fileName), download = join(downloads, `${name}.8k-mono.s16le.raw`);
    await choose(path);
    const info = await page.$eval("#audioFileInfo", e => e.textContent);
    assert.ok(info.includes(fileName) && info.includes("2 声道 → 单声道") && info.includes("8000 Hz / S16LE"), info);
    const samples = Number(/· (\d+) 样本/.exec(info)[1]); assert.ok(samples >= 8000 && samples < 8500);
    await page.click("#audioDownload");
    const raw = await waitForFile(download);
    assert.equal(raw.length, samples * 2);
    let sum = 0, peak = 0; for (let i = 0; i < samples; i++) { const value = raw.readInt16LE(i * 2); sum += value; peak = Math.max(peak, Math.abs(value)); }
    assert.ok(Math.abs(sum / samples) < 80, `DC was not removed: ${sum / samples}`);
    assert.ok(peak > 5000 && peak < 18000, `unexpected gain: ${peak}`);
    function amplitude(hz) {
      let sine = 0, cosine = 0;
      for (let i = 400; i < samples; i++) {
        const value = raw.readInt16LE(i * 2), phase = 2 * Math.PI * hz * i / 8000;
        sine += value * Math.sin(phase); cosine += value * Math.cos(phase);
      }
      return 2 * Math.hypot(sine, cosine) / (samples - 400);
    }
    const tone500Hz = amplitude(500), alias2000Hz = amplitude(2000);
    assert.ok(tone500Hz > 6000 && tone500Hz < 10000, `wanted tone changed: ${tone500Hz}`);
    assert.ok(alias2000Hz < 500, `6 kHz source aliased into output: ${alias2000Hz}`);
    results.push({ fileName, samples, bytes: raw.length, mean: sum / samples, peak, tone500Hz, alias2000Hz });
  }
  assert.equal(await page.evaluate(() => window.__audioDev.commands.length), 0, "offline conversion must not command the motor");
  await page.select("#dLink", "serial"); await page.click("#dConnect");
  await page.waitForFunction(() => !document.getElementById("audioInputs").disabled); await page.click("#audioReady");
  await page.$eval("#audioAmpRange", e => { e.value = "1750"; e.dispatchEvent(new Event("input", { bubbles: true })); });
  assert.equal(await page.$eval("#audioAmp", e => e.value), "1750");
  await page.select("#audioAxis", "D");
  assert.equal(await page.$eval("#audioAmp", e => e.value), "1500"); assert.equal(await page.$eval("#audioAmpRange", e => e.max), "1500");
  await page.$eval("#audioAmp", e => { e.value = "1501"; e.dispatchEvent(new Event("input", { bubbles: true })); });
  assert.equal(await page.$eval("#audioPlay", e => e.disabled), true);
  await page.$eval("#audioAmp", e => { e.value = "1"; e.dispatchEvent(new Event("input", { bubbles: true })); });
  assert.equal(await page.$eval("#audioAmpRange", e => e.value), "1");
  await page.click("#audioPlay"); await page.waitForFunction(() => document.getElementById("audioStatus").textContent.includes("播放完成"), { timeout: 10000 });
  assert.equal(await page.evaluate(() => window.__audioDev.played), results.at(-1).samples);
  assert.ok(await page.evaluate(() => window.__audioDev.commands.includes("AUDIO OPEN D 1")));
  assert.equal(await page.evaluate(() => window.__audioDev.mode), 0);
  assert.equal(await page.evaluate(() => window.__audioDev.illegalAscii), 0);
  // A bad encoded file clears the previous PCM rather than playing stale music.
  await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(["invalid"], "broken.mp3")); const input = document.getElementById("audioFile"); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForFunction(() => document.getElementById("audioFileInfo").textContent.includes("无法解码"));
  assert.equal(await page.$eval("#audioPlay", e => e.disabled), true); assert.equal(await page.$eval("#audioDownload", e => e.disabled), true);
  await choose(wavPath);
  await page.waitForFunction(() => !document.getElementById("msg").textContent, { timeout: 10000 });
  await page.screenshot({ path: join(out, "audio-desktop.png") });
  await page.setViewport({ width: 390, height: 844 }); await page.screenshot({ path: join(out, "audio-mobile.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.click("#themeToggle"); await page.screenshot({ path: join(out, "audio-mobile-light.png"), fullPage: true });
  assert.equal(errors.length, 0, errors.join("\n"));
  writeFileSync(join(out, `conversion-${url.startsWith("https:") ? "online" : "local"}.json`), JSON.stringify({ passed: true, url, results, errors, device: await page.evaluate(() => window.__audioDev) }, null, 2));
  console.log("WAV / MP3 / FLAC local conversion, S16LE download, D 1 mA simulated playback, current controls and mobile layout passed");
} catch (error) {
  writeFileSync(join(out, "conversion-failed.json"), JSON.stringify({ error: String(error), errors, body: await page.evaluate(() => document.body.innerText) }, null, 2)); throw error;
} finally { await browser.close(); server.close(); }
