// Header connect control + circular theme transition checks. Usage: CHROME_PATH=... node test/e2e/header-theme.mjs <url> <outDir>
import { launchBrowser } from "./browser.mjs";
import { installFakeSerial } from "./fake-devices.mjs";
const [url = "http://localhost:8799/", out = "screenshots"] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await launchBrowser(); const errs = []; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) errs.push(m); };
async function page(name, w, h, theme, { reduce = false } = {}) {
  const p = await b.newPage(); await p.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
  if (reduce) await p.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  p.on("pageerror", (e) => errs.push(`${name} pageerror ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) errs.push(`${name} console ${m.text()}`); });
  p.on("dialog", (d) => d.accept());
  await p.evaluateOnNewDocument(installFakeSerial, "v3");
  await p.evaluateOnNewDocument((t) => { localStorage.clear(); localStorage.setItem("dr4310-theme", t); }, theme);
  await p.goto(url, { waitUntil: "networkidle0" });
  return p;
}
const label = (p) => p.$eval("#dConnect", (e) => e.textContent.trim());
// desktop header, dark + light, before/after connect
for (const theme of ["dark", "light"]) {
  const p = await page("desk-" + theme, 1440, 900, theme);
  const order = await p.evaluate(() => { const x = (id) => document.getElementById(id).getBoundingClientRect(); const t = x("themeToggle"), l = x("dLink"), c = x("dConnect"); return { inHeader: !!document.querySelector("header #dConnect") && !!document.querySelector("header #dLink"), t: t.right, l: l.left, lr: l.right, c: c.left, top: Math.abs(t.top - c.top) }; });
  ok(order.inHeader && order.t <= order.l && order.lr <= order.c && order.top < 6, `${theme}: header order 主题 → 链路 → 连接 ${JSON.stringify(order)}`);
  await p.select("#dLink", "serial"); await sleep(100);
  ok((await label(p)) === "连接串口", `${theme}: label 连接串口 (${await label(p)})`);
  await p.screenshot({ path: `${out}/header-${theme}-disconnected.png`, clip: { x: 0, y: 0, width: 1440, height: 130 } });
  await p.click("#dConnect");
  await p.waitForFunction(() => /v3/.test(document.getElementById("stFw").textContent), { timeout: 8000 }).catch(() => {});
  await sleep(2500); // let toast fade
  ok((await label(p)) === "断开" && await p.$eval("#dConnect .conn-dot", (e) => e.classList.contains("on")), `${theme}: connected → 断开 + dot on`);
  await p.screenshot({ path: `${out}/header-${theme}-connected.png`, clip: { x: 0, y: 0, width: 1440, height: 130 } });
  if (theme === "dark") await p.screenshot({ path: `${out}/header-desktop-dark-full.png` });
  await p.close();
}
// mobile widths
for (const w of [320, 360, 390, 430]) {
  const p = await page("m" + w, w, 844, "dark");
  await p.select("#dLink", "serial"); await sleep(100);
  const r = await p.evaluate(() => { const hdr = document.querySelector("header"); const over = [...hdr.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5).map((e) => e.id || e.className); const t = document.getElementById("themeToggle").getBoundingClientRect(), c = document.getElementById("dConnect").getBoundingClientRect(); return { doc: document.documentElement.scrollWidth - innerWidth, over, sameRow: Math.abs(t.top - c.top) < 6, rightOf: c.left >= t.right }; });
  ok(r.doc <= 0 && r.over.length === 0 && r.sameRow && r.rightOf, `mobile ${w}: no overflow, connect right of theme ${JSON.stringify(r)}`);
  if (w === 320 || w === 390) await p.screenshot({ path: `${out}/header-mobile-${w}.png`, clip: { x: 0, y: 0, width: w, height: 260 } });
  await p.close();
}
// theme transition
{
  const p = await page("theme", 1440, 900, "dark");
  await p.select("#dLink", "serial"); await p.click("#dConnect");
  await p.waitForFunction(() => /v3/.test(document.getElementById("stFw").textContent), { timeout: 8000 }).catch(() => {});
  await sleep(500);
  const supported = await p.evaluate(() => typeof document.startViewTransition === "function");
  await p.click("#themeToggle"); await sleep(120);
  const mid = await p.evaluate(() => ({ cls: document.documentElement.classList.contains("theme-switching"), anims: document.documentElement.getAnimations({ subtree: true }).map((a) => `${a.effect?.pseudoElement}:${JSON.stringify(a.effect?.getKeyframes?.()[0]?.clipPath ?? "")}`) }));
  ok(supported && mid.cls && mid.anims.some((a) => /view-transition-new\(root\).*circle/.test(a)), `circular reveal running ${JSON.stringify(mid)}`);
  await p.screenshot({ path: `${out}/theme-transition-mid.png` });
  await sleep(800);
  ok(await p.evaluate(() => document.documentElement.dataset.theme === "light" && !document.documentElement.classList.contains("theme-switching") && localStorage.getItem("dr4310-theme") === "light"), "after 600ms → light, class cleared, persisted");
  // double click: second click during transition switches instantly back
  await p.click("#themeToggle"); await sleep(80); await p.click("#themeToggle"); await sleep(100);
  ok(await p.evaluate(() => document.documentElement.dataset.theme === "light" && !document.documentElement.classList.contains("theme-switching")), "rapid double toggle → instant, ends light");
  await sleep(700);
  // E-stop during transition: click must reach #estop and STOP must be sent
  await p.evaluate(() => { window.__w0 = window.__dev ? (window.__writes || []).length : 0; });
  await p.click("#themeToggle"); await sleep(100);
  const box = await p.$eval("#estop", (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const t0 = Date.now(); await p.mouse.click(box.x, box.y);
  const stopped = await p.waitForFunction(() => (window.__writes || []).slice(window.__w0).some((w) => /^STOP/.test(w.trim())), { timeout: 2000 }).then(() => true).catch(() => false);
  ok(stopped, `e-stop click during theme transition → STOP sent (${Date.now() - t0} ms)`);
  ok(await p.evaluate(() => !document.documentElement.classList.contains("theme-switching")), "e-stop pointerdown skipped transition");
  await p.close();
}
// reduced motion → instant
{
  const p = await page("reduce", 1440, 900, "dark", { reduce: true });
  await p.click("#themeToggle"); await sleep(30);
  ok(await p.evaluate(() => document.documentElement.dataset.theme === "light" && !document.documentElement.classList.contains("theme-switching") && document.getAnimations().length === 0), "prefers-reduced-motion → instant switch");
  await p.close();
}
await b.close();
console.log(errs.length ? "ERRORS:\n" + errs.join("\n") : "ALL PASSED");
process.exit(errs.length ? 1 : 0);
