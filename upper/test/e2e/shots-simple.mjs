// Screenshots of the simplified UI (auto-enable switch) with fake devices (v3 serial firmware formats + PCAN discovery).
// Usage: node test/e2e/shots-codex.mjs <url> <outDir>
import { launchBrowser } from "./browser.mjs";
import { installFakeSerial, installFakePcan } from "./fake-devices.mjs";
const [url = "http://localhost:8799/", out = "screenshots"] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await launchBrowser();
const errs = [];
async function shot(name, { w = 1440, h = 1000, theme = "dark", full = false, run = true, view = "dash", cfgPage = null, pcan = true }) {
  const p = await b.newPage();
  await p.setViewport({ width: w, height: h, deviceScaleFactor: w < 600 ? 2 : 1 });
  p.on("pageerror", (e) => errs.push(name + ": " + e.message));
  p.on("dialog", (d) => d.accept());
  await p.evaluateOnNewDocument(installFakeSerial, "v3");
  if (pcan) await p.evaluateOnNewDocument(installFakePcan, { nodes: [{ id: 1, mode: 2, faults: 0, primary: 88 }, { id: 3, mode: 0, faults: 0, primary: 12.4 }] });
  await p.evaluateOnNewDocument((t) => { if (!sessionStorage.getItem("x")) { localStorage.clear(); localStorage.setItem("dr4310-theme", t); sessionStorage.setItem("x", "1"); } }, theme);
  await p.goto(url, { waitUntil: "networkidle0" });
  await p.select('[data-testid="connection-route"]', "serial"); await p.click('[data-testid="connection-toggle"]');
  await p.waitForFunction(() => /v3/.test(document.getElementById("stFw")?.textContent ?? ""), { timeout: 8000 }).catch(() => {});
  if (pcan) { await p.select('[data-testid="connection-route"]', "can"); await p.click('[data-testid="connection-toggle"]'); await sleep(800); }
  if (run) {
    await p.evaluate(() => { const t = document.getElementById("dTarget"); t.value = "120"; t.dispatchEvent(new Event("change", { bubbles: true })); });
    await p.click("#dStart").catch(() => {});
    await sleep(2500);
  }
  if (view !== "dash") { await p.click(`#views button[data-view="${view}"]`); await sleep(300); }
  if (cfgPage) { await p.$eval(`[data-page="${cfgPage}"]`, (e) => e.click()); await sleep(300); }
  await p.evaluate(() => window.scrollTo(0, 0)); await sleep(300);
  await p.screenshot({ path: `${out}/simple-${name}.png`, fullPage: full });
  if (run) await p.click("#dStart").catch(() => {});
  await p.close();
  console.log("wrote", `${out}/simple-${name}.png`);
}
await shot("desktop-dark", {});
await shot("desktop-light", { theme: "light" });
await shot("mobile", { w: 390, h: 844, full: true });
await b.close();
if (errs.length) { console.log(errs.join("\n")); process.exit(1); }
