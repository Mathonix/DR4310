import { launchBrowser } from "./browser.mjs";
import { mkdirSync } from "node:fs";
const url = process.argv[2] || "http://localhost:8799/";
const b = await launchBrowser();
const p = await b.newPage();
await p.setViewport({ width: 1400, height: 1000 });
const errs = [];
p.on("pageerror", (e) => errs.push("pageerror: " + e.message));
p.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
await p.evaluateOnNewDocument(() => {
  window.__tx = [];
  let n = 0;
  const rec = (id, data, first) => { const r = [ (first ? 0x80 : 0) | 8, ((id << 5) & 0xff), (id << 5) >> 8 ]; if (first) r.push(n & 0xff, (n >> 8) & 0xff); else r.push(n & 0xff); return r.concat(Array.from(data)); };
  const fb = () => { const d = new Uint8Array(8); const dv = new DataView(d.buffer); dv.setUint16(0, (n * 7) % 8192); dv.setInt16(2, Math.round(200 * Math.sin(n / 300))); dv.setInt16(4, Math.round(0.3 * Math.sin(n / 150) * 16384 / 3)); d[6] = 0xff; return d; };
  const st = () => { const d = new Uint8Array(8); const dv = new DataView(d.buffer); d[0] = 1; d[1] = 0; dv.setFloat32(2, 0.123, true); dv.setInt16(6, -1234, true); return d; };
  const dev = {
    vendorId: 0x0c72, productId: 0x000c, opened: false, configuration: null,
    async open() { this.opened = true; }, async close() { this.opened = false; },
    async selectConfiguration() { this.configuration = { interfaces: [{ interfaceNumber: 0, alternates: [{ endpoints: [
      { endpointNumber: 1, direction: "out" }, { endpointNumber: 1, direction: "in" }, { endpointNumber: 2, direction: "out" }, { endpointNumber: 2, direction: "in" } ] }] }] }; },
    async claimInterface() {}, async releaseInterface() {},
    async transferOut(ep, data) { const u = new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength); if (ep === 2) { window.__tx.push(Array.from(u)); (window.__all = window.__all || []).push(Array.from(u)); } return { status: "ok", bytesWritten: u.length }; },
    async transferIn(ep, len) {
      if (ep === 1 || ep === 0x81) { const r = new Uint8Array(16); r[2] = 0x78; r[3] = 0x56; r[4] = 0x34; r[5] = 0x12; return { status: "ok", data: new DataView(r.buffer) }; }
      await new Promise(r => setTimeout(r, 4));
      const recs = []; let cnt = 0;
      for (let k = 0; k < 3; k++) { n++; recs.push(...rec(0x205, fb(), cnt === 0)); cnt++; if (n % 100 === 0) { recs.push(...rec(0x181, st(), false)); cnt++; } }
      const buf = new Uint8Array(64); buf[0] = 0; buf[1] = cnt; buf.set(recs.slice(0, 62), 2);
      return { status: "ok", data: new DataView(buf.buffer) };
    },
  };
  const usb = new EventTarget(); usb.requestDevice = async () => dev; usb.getDevices = async () => [dev];
  Object.defineProperty(navigator, "usb", { value: usb });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, extra = "") => results.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
p.on("dialog", (d) => d.accept());
await p.goto(url, { waitUntil: "networkidle0" });
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: "networkidle0" }); await p.click('#views button[data-view="debug"]');
const txs = () => p.evaluate(() => window.__tx.map((u) => { const id = (u[3] | (u[4] << 8)) >> 5; const dlc = u[2] & 15; return id.toString(16) + ":" + u.slice(5, 5 + dlc).map((x) => x.toString(16).padStart(2, "0")).join(""); }));
const connectCan = async () => { await p.click('[data-testid="view-dash"]'); await p.select('[data-testid="connection-route"]', "can"); await p.click('[data-testid="connection-toggle"]'); await p.click('[data-testid="view-debug"]'); };
const setVal = (sel, v) => p.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); }, String(v));
check("default motor ID 1", (await p.$eval("#motorId", (e) => e.value)) === "1");
await connectCan();
await sleep(2000);
check("bus on", /1 Mbps/.test(await p.$eval("#stPcanBus", (e) => e.textContent)));
check("factory speed gains prefilled", (await p.$eval("#spdkp", (e) => e.value)) === "0.25" && (await p.$eval("#spdki", (e) => e.value)) === "0.02" && (await p.$eval("#spdkd", (e) => e.value)) === "0");
check("factory position gains prefilled", (await p.$eval("#poskp", (e) => e.value)) === "3.5" && (await p.$eval("#poski", (e) => e.value)) === "1.2" && (await p.$eval("#poskd", (e) => e.value)) === "2.6");
await setVal("#nSpd", 100);
check("speed hex preview", (await p.$eval("#spdHex", (e) => e.textContent)) === "ID 0x401  CC 8C 66 06 06 01 00 00", await p.$eval("#spdHex", (e) => e.textContent));
await p.click("#sendSpd"); await sleep(150);
await setVal("#nPos", 1.57);
check("position hex preview", (await p.$eval("#posHex", (e) => e.textContent)) === "ID 0x501  66 80 7B 04 12 03 A8 06", await p.$eval("#posHex", (e) => e.textContent));
await p.click("#sendPos"); await sleep(150);
let t = await txs();
check("EXACT speed example frame sent", t.includes("401:9999660606010000"), t.filter((x) => x.startsWith("401")).join(","));
check("EXACT position example frame sent", t.includes("501:66807b041203a806"), t.filter((x) => x.startsWith("501")).join(","));
// other native commands still on 0x101
await p.click("#sendIq"); await sleep(40); await p.click('button[data-mode="2"]'); await sleep(40); await p.click('button[data-mode="0"]'); await sleep(100);
await p.click('[data-testid="view-dash"]');
check("no runtime auto-enable switch", !(await p.$('[data-testid="auto-enable"]')));
await p.click('[data-testid="view-debug"]'); await p.click("#paramAll"); await sleep(400);
await p.click("#mitEnter"); await p.click("#mitSend"); await sleep(200);
await p.click('button[data-mode="0"]'); await sleep(200);
t = await txs();
check("current 0x01 on 0x101", t.some((x) => x.startsWith("101:01")));
check("mode-only 0x07 02", t.includes("101:0702000000000000"));
check("never sends auto-enable ON (08 01)", !t.some((x) => /^1[0-9a-f]{2}:0801/.test(x)));
check("set-param 0x04 ids 1..9 (0x03 skipped if ≤0)", [1, 2, 4, 5, 6, 7, 8, 9].every((i) => t.some((x) => x.startsWith("101:04" + i.toString(16).padStart(2, "0")))));
check("MIT enter + pack", t.includes("101:0600000000000000") && t.filter((x) => x.startsWith("101:")).length > 10);
// gains persisted + factory reset
await setVal("#spdkp", 0.5); await setVal("#poskd", 3);
await p.reload({ waitUntil: "networkidle0" }); await p.click('#views button[data-view="debug"]');
check("gains persisted in localStorage", (await p.$eval("#spdkp", (e) => e.value)) === "0.5" && (await p.$eval("#poskd", (e) => e.value)) === "3");
await p.click("#spdFactory"); await p.click("#posFactory");
check("reset to factory", (await p.$eval("#spdkp", (e) => e.value)) === "0.25" && (await p.$eval("#poskd", (e) => e.value)) === "2.6");
await p.reload({ waitUntil: "networkidle0" }); await p.click('#views button[data-view="debug"]');
check("factory reset persisted", (await p.$eval("#spdkp", (e) => e.value)) === "0.25");
await connectCan(); await sleep(1500);
// periodic speed then E-stop
await p.evaluate(() => { window.__tx.length = 0; });
await setVal("#nSpd", 60);
await p.$eval("#spdPeriod", (e) => { e.value = "20"; });
await p.click("#spdPeriodic"); await sleep(500);
await p.click("#estop"); await sleep(150);
const n1 = (await txs()).filter((x) => x.startsWith("401:")).length;
await sleep(400);
t = await txs();
const n2 = t.filter((x) => x.startsWith("401:")).length;
check("periodic speed frames", n1 >= 10, String(n1));
check("E-stop stops periodic + sends 0x08 00 / 0x03", n1 === n2 && t.includes("101:0800000000000000") && t.includes("101:0300000000000000"), `${n1}->${n2}`);
// live slider for position
await p.click("#liveSlider");
await p.evaluate(() => { window.__tx.length = 0; });
await setVal("#rPos", 3.14); await sleep(200);
t = await txs();
check("live slider sends 0x501", t.some((x) => x.startsWith("501:")), t.join(","));
// hidden watchdog
await p.evaluate(() => { window.__tx.length = 0; Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
await sleep(300);
check("hidden → disable 0x00", (await txs()).includes("101:0000000000000000"));
await p.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); });
check("status decoded (0x181 → 电流环 in dock)", /电流环/.test(await p.$eval("#vMode", (e) => e.textContent)));
await p.evaluate(() => { window.__tx.length = 0; }); await p.keyboard.press("Escape"); await sleep(300);
{ const e = await txs(); check("Esc key → auto-enable off + E-stop", e.includes("101:0800000000000000") && e.some((x) => x.startsWith("101:03")), e.join(",")); }
{ const th0 = await p.evaluate(() => document.documentElement.dataset.theme); await p.click("#themeToggle"); await sleep(500);
  const th1 = await p.evaluate(() => document.documentElement.dataset.theme);
  check("theme toggle works with live data", th0 !== th1 && ["light", "dark"].includes(th1), th0 + "→" + th1); }
// motor id change
await p.click('[data-testid="view-dash"]'); await p.select('[data-testid="motor-id"]', "3"); await p.waitForFunction(() => !document.getElementById("motorId").disabled); await p.click('[data-testid="view-debug"]'); await setVal("#nSpd", 100); await p.click("#sendSpd"); await sleep(150);
check("ID 3 → 0x403", (await txs()).includes("403:9999660606010000"));
const all = await p.evaluate(() => window.__allTx || null);
t = await p.evaluate(() => window.__all.map((u) => { const id = (u[3] | (u[4] << 8)) >> 5; const dlc = u[2] & 15; return id.toString(16) + ":" + u.slice(5, 5 + dlc).map((x) => x.toString(16).padStart(2, "0")).join(""); }));
check("never sends 0x02/0x05 cmd on 0x10x", !t.some((x) => /^10[1-7]:0[25]/.test(x)));
check("no page errors", errs.length === 0, errs.join(" | "));
mkdirSync("screenshots", { recursive: true });
await p.screenshot({ path: "screenshots/review-can-debug.png", fullPage: true });
console.log(results.join("\n"));
console.log(results.some((r) => r.startsWith("FAIL")) ? "SOME FAILED" : "ALL PASSED");
await b.close();
