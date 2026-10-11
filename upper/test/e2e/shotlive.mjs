import { launchBrowser } from "./browser.mjs";
const [url, out, w = "1440", h = "900", full = "0", theme = "dark"] = process.argv.slice(2);
const b = await launchBrowser();
const p = await b.newPage();
await p.setViewport({ width: +w, height: +h });
const errs = [];
p.on("pageerror", (e) => errs.push("pageerror: " + e.message));
p.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
await p.evaluateOnNewDocument(() => {
  window.__tx = [];
  let n = 0;
  const rec = (id, data, first) => { const r = [ (first ? 0x80 : 0) | 8, ((id << 5) & 0xff), (id << 5) >> 8 ]; if (first) r.push(n & 0xff, (n >> 8) & 0xff); else r.push(n & 0xff); return r.concat(Array.from(data)); };
  const fb = () => { const d = new Uint8Array(8); const dv = new DataView(d.buffer); dv.setUint16(0, (n * 7) % 8192); dv.setInt16(2, Math.round(200 * Math.sin(n / 300))); dv.setInt16(4, Math.round(0.3 * Math.sin(n / 150) * 16384 / 3)); d[6] = 0xff; return d; };
  const st = () => { const d = new Uint8Array(8); const dv = new DataView(d.buffer); d[0] = 1; d[1] = 0x42; dv.setFloat32(2, 0.123, true); dv.setInt16(6, -1234, true); return d; };
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
await p.goto(url, { waitUntil: "networkidle0" });
await p.evaluate((t) => { localStorage.clear(); localStorage.setItem("dr4310-theme", t); }, theme);
await p.reload({ waitUntil: "networkidle0" });
await p.select('[data-testid="connection-route"]', "can"); await p.click('[data-testid="connection-toggle"]');
await sleep(5000);
await p.evaluate(() => window.scrollTo(0, 0)); await sleep(300);
await p.screenshot({ path: out, fullPage: full === "1" });
if (errs.length) console.log(errs.join("\n"));
await b.close();
