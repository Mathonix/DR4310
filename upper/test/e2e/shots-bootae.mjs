// Screenshots: dashboard without a runtime AE switch (read-only INFO ae= indicator) + 参数配置 › 驱动参数 › 上电行为.
// Usage: node test/e2e/shots-bootae.mjs <url> <outDir>
import { launchBrowser } from "./browser.mjs";
import { installFakeSerial } from "./fake-devices.mjs";
const [url = "http://localhost:8799/", out = "screenshots"] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await launchBrowser();
const errs = [];
async function shot(name, { w = 1440, h = 1000, theme = "dark", full = false, settings = false }) {
  const p = await b.newPage();
  await p.setViewport({ width: w, height: h, deviceScaleFactor: w < 600 ? 2 : 1 });
  p.on("pageerror", (e) => errs.push(name + ": " + e.message));
  p.on("dialog", (d) => d.accept());
  await p.evaluateOnNewDocument(installFakeSerial, "v3");
  await p.evaluateOnNewDocument((t) => { if (!sessionStorage.getItem("x")) { localStorage.clear(); localStorage.setItem("dr4310-theme", t); sessionStorage.setItem("x", "1"); } }, theme);
  await p.goto(url, { waitUntil: "networkidle0" });
  await p.select('[data-testid="connection-route"]', "serial"); await p.click('[data-testid="connection-toggle"]');
  await p.waitForFunction(() => /v3/.test(document.getElementById("stFw")?.textContent ?? ""), { timeout: 8000 }).catch(() => {});
  // motor booted with BOOT_AE=1 (BOOT_MODE=2 speed, 60 rpm) → firmware reports ae=1
  await p.evaluate(() => { const d = window.__dev; d.ram.BOOT_MODE = 2; d.ram.BOOT_TARGET = 60; d.ram.BOOT_AE = 1; d.flash = { ...d.ram }; d.ae = 1; d.mode = 2; d.tgt = 60; });
  await p.waitForFunction(() => document.getElementById("dAe").dataset.ae === "1", { timeout: 4000 }).catch(() => {});
  if (settings) {
    await p.click('[data-testid="view-cfg"]'); await p.click("#btnGetAll"); await sleep(600);
    await p.$eval('#cfgPages button[data-page="drive"]', (e) => e.click()); await sleep(300);
  } else await sleep(1500);
  await p.evaluate(() => window.scrollTo(0, 0)); await sleep(300);
  await p.screenshot({ path: `${out}/bootae-${name}.png`, fullPage: full });
  await p.close();
  console.log("wrote", `${out}/bootae-${name}.png`);
}
await shot("desktop-dark", {});
await shot("desktop-light", { theme: "light" });
await shot("mobile", { w: 390, h: 844, full: true });
await shot("settings", { settings: true });
await shot("settings-mobile", { settings: true, w: 390, h: 844 });
await b.close();
if (errs.length) { console.log(errs.join("\n")); process.exit(1); }
