// Redesign screenshots + smoke: three views, four modes, no console errors.
// Usage: CHROME_PATH=... node test/e2e/shots-redesign.mjs <url> <outDir>
import { launchBrowser } from "./browser.mjs";
import { installFakeSerial } from "./fake-devices.mjs";
const [url = "http://localhost:8799/", out = "screenshots"] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await launchBrowser();
const errs = [];
async function open(name, w, h, theme) {
  const p = await b.newPage();
  await p.setViewport({ width: w, height: h, deviceScaleFactor: w < 600 ? 2 : 1 });
  p.on("pageerror", (e) => errs.push(`${name} pageerror: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/favicon|404/.test(m.text())) errs.push(`${name} console: ${m.text()}`); });
  p.on("dialog", (d) => d.accept());
  await p.evaluateOnNewDocument(installFakeSerial, "v3");
  await p.evaluateOnNewDocument((t) => { if (!sessionStorage.getItem("x")) { localStorage.clear(); localStorage.setItem("dr4310-theme", t); sessionStorage.setItem("x", "1"); } }, theme);
  await p.goto(url, { waitUntil: "networkidle0" });
  await p.select('[data-testid="connection-route"]', "serial"); await p.click('[data-testid="connection-toggle"]');
  await p.waitForFunction(() => /v3/.test(document.getElementById("stFw")?.textContent ?? ""), { timeout: 8000 }).catch(() => errs.push(name + ": v3 not detected"));
  await sleep(800);
  return p;
}
async function view(p, v) { await p.click(`[data-testid="view-${v}"]`).catch(async () => p.$eval(`#views button[data-view="${v}"]`, (e) => e.click())); await sleep(400); }
async function shot(p, file, full = false) { await p.evaluate(() => window.scrollTo(0, 0)); await sleep(250); await p.screenshot({ path: `${out}/redesign-${file}.png`, fullPage: full }); console.log("wrote", `${out}/redesign-${file}.png`); }
const viewNames = async (p) => p.$$eval("#views button[data-view]", (bs) => bs.map((x) => x.dataset.view));

for (const [tag, w, h, theme] of [["desktop-dark", 1440, 900, "dark"], ["desktop-light", 1440, 900, "light"], ["mobile", 390, 844, "dark"]]) {
  const p = await open(tag, w, h, theme);
  const views = await viewNames(p);
  // four modes on dashboard
  for (const m of ["spd", "cur", "pos", "mit"]) {
    await p.$eval(`#dModes button[data-dmode="${m}"]`, (e) => e.click()); await sleep(250);
    const active = await p.$eval(`#dModes button[data-dmode="${m}"]`, (e) => e.classList.contains("active"));
    if (!active) errs.push(`${tag}: mode ${m} not active`);
  }
  await p.$eval(`#dModes button[data-dmode="spd"]`, (e) => e.click()); await sleep(300);
  await shot(p, `${tag}-dash`);
  if (tag === "mobile") {
    const order = await p.evaluate(() => { const y = (id) => document.getElementById(id)?.getBoundingClientRect().top ?? NaN; return { start: y("dStart"), gauge: y("dGauge") }; });
    console.log("mobile order", JSON.stringify(order));
    if (!(order.start < order.gauge)) errs.push("mobile: start not above gauge");
    const ovf = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (ovf > 1) errs.push("mobile: horizontal overflow " + ovf);
  }
  for (const v of views) {
    if (v === views[0]) continue;
    await view(p, v);
    const ok = await p.$eval(`#view-${v}`, (e) => e.classList.contains("active") && e.getBoundingClientRect().height > 0);
    if (!ok) errs.push(`${tag}: view ${v} not visible`);
    if (v === "cfg") { await p.click("#btnGetAll"); await sleep(700); }
    await shot(p, `${tag}-${v}`);
  }
  await view(p, views[0]);
  await p.close();
}
await b.close();
console.log(errs.length ? "ERRORS:\n" + errs.join("\n") : "NO ERRORS");
process.exit(errs.length ? 1 : 0);
