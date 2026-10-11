import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { launchBrowser } from "./browser.mjs";
import { installFakeSerial } from "./fake-devices.mjs";

const url = process.argv[2] || "http://localhost:8799/";
const stage = url.startsWith("https:") ? "online" : "local";
const out = ".wrangler/position-vff-20261011";
mkdirSync(out, { recursive: true });
const browser = await launchBrowser();
const results = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
async function page(mode) {
  const p = await browser.newPage();
  const errors = [];
  p.on("pageerror", e => errors.push(e.message));
  p.on("dialog", d => d.accept());
  await p.setViewport({ width: 1440, height: 1100 });
  await p.evaluateOnNewDocument(installFakeSerial, mode);
  await p.evaluateOnNewDocument(() => {
    localStorage.clear(); window.__dev.latched = 0;
    window.__dev.active[15] = 22;
  });
  await p.goto(url, { waitUntil: "networkidle0" });
  await p.select('[data-testid="connection-route"]', "serial");
  await p.click('[data-testid="connection-toggle"]');
  await p.waitForFunction(() => document.getElementById("pd_POS_KP")?.textContent === "3.5");
  await p.click('#views button[data-view="cfg"]');
  return { p, errors };
}
async function setValue(p, value) {
  await p.$eval("#pv_POS_VFF", (e, v) => {
    e.value = String(v); e.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}
async function write(p, value) {
  await setValue(p, value);
  await p.click('button[data-set="POS_VFF"]');
  await p.waitForFunction(v => window.__dev.ram.POS_VFF === v &&
    Number(document.getElementById("pd_POS_VFF").textContent) === v, {}, value);
  // SET/GET run inside a telemetry transaction; wait for it to finish.
  await p.waitForFunction(() => window.__dev.ram.TELEM === 1);
}
try {
  {
    const { p, errors } = await page("v3-vff");
    assert.equal(await p.$eval("#pd_POS_VFF", e => e.textContent), "1");
    assert.equal(await p.$eval("#pg_POS_VFF", e => e.textContent), "[0, 1]");
    assert.ok(await p.$eval("#cfgBody_drive", e => e.textContent.includes("0 关闭 · 1 全量")));
    for (const value of [0, 0.5, 1]) await write(p, value);
    const firstWrites = await p.evaluate(() => window.__writes.map(w => w.trim()));
    assert.deepEqual(firstWrites.filter(w => /^SET POS_VFF /.test(w)), ["SET POS_VFF 0", "SET POS_VFF 0.5", "SET POS_VFF 1"]);
    assert.ok(!firstWrites.includes("SAVE"));
    for (const bad of [-0.01, 1.01]) {
      const n = await p.evaluate(() => window.__writes.length);
      await setValue(p, bad); await p.click('button[data-set="POS_VFF"]'); await pause(200);
      assert.ok(!(await p.evaluate(n => window.__writes.slice(n), n)).some(w => /^SET POS_VFF /.test(w)));
      assert.equal(await p.evaluate(() => window.__dev.ram.POS_VFF), 1);
    }
    await setValue(p, 1);

    // Write while position mode is running: no stop, save, reboot or mode command.
    await p.click('#views button[data-view="dash"]');
    await p.click('#dModes button[data-dmode="pos"]');
    await p.$eval("#dTarget", e => { e.value = "3"; e.dispatchEvent(new Event("input", { bubbles: true })); });
    await p.click("#dStart");
    await p.waitForFunction(() => window.__dev.mode === 3);
    await p.click('#views button[data-view="cfg"]');
    const runningStart = await p.evaluate(() => window.__writes.length);
    await write(p, 0.5);
    assert.equal(await p.evaluate(() => window.__dev.mode), 3);
    const running = await p.evaluate(n => window.__writes.slice(n).map(w => w.trim()), runningStart);
    assert.ok(!running.some(w => /^(STOP|SAVE|REBOOT|MODE|AE)( |$)/.test(w)));
    await p.keyboard.press("Escape");
    await p.waitForFunction(() => window.__dev.mode === 0);

    // Sync persists zero. Unsaved writes can be discarded by RELOAD and REBOOT.
    await setValue(p, 0); await p.click("#btnSync");
    await p.waitForFunction(() => window.__dev.flash?.POS_VFF === 0 && !document.getElementById("cfgBanner").textContent.includes("未保存"));
    await write(p, 1);
    await p.click('#cfgPages button[data-page="store"]'); await p.click("#btnReload");
    await p.waitForFunction(() => document.getElementById("pd_POS_VFF").textContent === "0");
    await p.click('#cfgPages button[data-page="drive"]'); await write(p, 1);
    await p.click('#cfgPages button[data-page="store"]'); await p.click("#btnReboot");
    await p.waitForFunction(() => window.__dev.ram.POS_VFF === 0 && window.__dev.alive && document.getElementById("pd_POS_VFF").textContent === "0", { timeout: 8000 });
    await p.click('#cfgPages button[data-page="drive"]');
    const commands = await p.evaluate(() => window.__writes.map(w => w.trim()));
    assert.ok(!commands.includes("AE 1"));
    assert.equal(errors.length, 0);
    await p.screenshot({ path: `${out}/${stage}-vff.png`, fullPage: true });
    results.push({ mode: "3.2.0", value: 0, persisted: true, runtimeWrites: running, commands, errors });
    await p.close();
  }
  for (const mode of ["v2", "v3"]) {
    const { p, errors } = await page(mode);
    assert.equal(await p.$("#pv_POS_VFF"), null);
    assert.ok(!(await p.evaluate(() => window.__writes)).some(w => /POS_VFF/.test(w)));
    assert.equal(errors.length, 0);
    results.push({ mode, unsupportedFieldHidden: true, errors });
    await p.close();
  }
  writeFileSync(`${out}/${stage}-vff.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.map(({ commands, ...r }) => r), null, 2));
} finally { await browser.close(); }
