import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { launchBrowser } from "./browser.mjs";
import { installFakeSerial } from "./fake-devices.mjs";

const url = process.argv[2] || "http://localhost:8799/";
const baseline = process.argv.includes("--baseline");
const stage = baseline ? "baseline" : url.startsWith("https:") ? "online" : "local";
const out = ".wrangler/position-fix-20261011";
mkdirSync(out, { recursive: true });
const browser = await launchBrowser();
const results = [];
try {
  const cases = [{ existingPosition: true, telem: 1, hz: 100 }, { existingPosition: false, telem: 1, hz: 100 }];
  if (!baseline) cases.push({ existingPosition: false, telem: 0, hz: 100 }, { existingPosition: false, telem: 1, hz: 0 });
  for (const { existingPosition, telem, hz } of cases) {
    const p = await browser.newPage();
    const errors = [], dialogs = [];
    p.on("pageerror", e => errors.push(e.message));
    p.on("dialog", async d => { dialogs.push(d.message()); await d.accept(); });
    await p.evaluateOnNewDocument(installFakeSerial, "v3");
    await p.evaluateOnNewDocument(({ existingPosition, telem, hz }) => {
      window.__dev.latched = 0;
      window.__dev.ram.TELEM = telem; window.__dev.hz = hz;
      if (existingPosition) window.__dev.active[15] = 22;
    }, { existingPosition, telem, hz });
    await p.goto(url, { waitUntil: "networkidle0" });
    await p.select('[data-testid="connection-route"]', "serial");
    await p.click('[data-testid="connection-toggle"]');
    await p.waitForFunction(() => document.getElementById("telState").textContent.includes("16"));
    await p.click('#dModes button[data-dmode="pos"]');
    await p.$eval("#dTarget", e => { e.value = "3"; e.dispatchEvent(new Event("input", { bubbles: true })); });
    await p.click("#dStart");
    try { await p.waitForFunction(() => window.__writes.some(w => /^POS /.test(w)), { timeout: 6000 }); }
    catch (error) {
      const failure = await p.evaluate(() => ({ writes: window.__writes, status: document.getElementById("dStatusT").textContent, text: document.body.innerText }));
      writeFileSync(`${out}/failed-serial.json`, JSON.stringify({ existingPosition, telem, hz, failure, errors }, null, 2));
      throw error;
    }
    await new Promise(r => setTimeout(r, 750));
    const state = await p.evaluate(() => ({
      commands: window.__writes.map(w => w.trim()), target: window.__dev.tgt,
      actual: window.__dev.pos, reading: document.getElementById("mPosV").textContent,
      input: document.getElementById("dTarget").value, channels: window.__dev.active,
    }));
    results.push({ url, existingPosition, telem, hz, ...state, dialogs, errors });
    if (!baseline) {
      assert.equal(state.target, 3, "starting must preserve the requested position");
      assert.equal(Number(state.input), 3);
      assert.ok(Math.abs(state.actual - 3) < 0.03, "simulated motor must reach the requested position");
      assert.ok(Math.abs(Number(state.reading) - 3) < 0.03, "position feedback must be displayed");
      assert.ok(state.channels.includes(22), "PosRad must be in the telemetry mapping");
      assert.ok(!dialogs.some(d => d.includes("未知电机当前位置")));
      assert.ok(!state.commands.some(c => /^(SAVE|AE 1)$/.test(c)));
      assert.equal(errors.length, 0);
    }
    // Updating the target during a position session must also reach the device.
    await p.$eval("#dTarget", e => { e.value = "2"; e.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await p.waitForFunction(() => window.__writes.some(w => w.trim() === "POS 2"));
    await p.click("#dStart");
    await p.waitForFunction(() => window.__dev.mode === 0);
    const stopped = await p.evaluate(() => window.__writes.filter(w => /^POS /.test(w)).length);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(await p.evaluate(() => window.__writes.filter(w => /^POS /.test(w)).length), stopped);
    await p.screenshot({ path: `${out}/${baseline ? "before" : "after"}-${existingPosition ? "mapped" : "default"}-${telem}-${hz}.png`, fullPage: true });
    if (!baseline) {
      // An online serial port with no incoming position samples must never receive a new position command.
      await p.evaluate(() => { window.__dev.alive = false; });
      await new Promise(r => setTimeout(r, 350));
      await p.click("#dStart");
      await p.waitForFunction(() => document.getElementById("dStart").textContent === "启动", { timeout: 3000 });
      assert.equal(await p.evaluate(() => window.__writes.filter(w => /^POS /.test(w)).length), stopped);
      assert.equal(errors.length, 0);
    }
    await p.close();
  }
  writeFileSync(`${out}/${stage}-serial.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.map(r => ({ existingPosition: r.existingPosition, telem: r.telem, hz: r.hz, sent: r.commands.filter(c => /^POS /.test(c)), actual: r.actual, reading: r.reading, dialogs: r.dialogs.length, errors: r.errors })), null, 2));
} finally { await browser.close(); }
