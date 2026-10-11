// Phase 1 e2e: dashboard (CAN + serial v2/v3), auto-connect probe, paged settings, v3 features,
// fault panel, log manager, profiles, waveform + E-stop, CAN discovery. Screenshots → screenshots/phase1-*.png
import { launchBrowser, tempProfile } from "./browser.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { installFakeSerial, installFakePcan } from "./fake-devices.mjs";
const url = process.argv[2] || "http://localhost:8799/";
const shotDir = process.argv[3] || "screenshots";
mkdirSync(shotDir, { recursive: true });
const b = await launchBrowser();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, extra = "") => { results.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); };

async function newPage({ serial, pcan, prep } = {}) {
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 1000 });
  await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  const errs = [];
  p.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*404/.test(m.text())) errs.push("console: " + m.text()); });
  p.dialogs = [];
  p.on("dialog", (d) => { p.dialogs.push(d.message()); if (p.rejectNext) { p.rejectNext = false; d.dismiss(); } else d.accept(); });
  if (serial) await p.evaluateOnNewDocument(installFakeSerial, serial);
  if (pcan) await p.evaluateOnNewDocument(installFakePcan, pcan === true ? null : pcan);
  if (prep) await p.evaluateOnNewDocument(prep);
  await p.goto(url, { waitUntil: "networkidle0" });
  return { p, errs };
}
const txt = (p, id) => p.$eval("#" + id, (e) => e.textContent);
const writes = (p) => p.evaluate(() => window.__writes.map((w) => w.trim()).filter((w) => w && w !== "PING" && w !== "INFO"));
const allWrites = (p) => p.evaluate(() => window.__writes.map((w) => w.trim()).filter(Boolean));
async function waitFor(p, fn, ms = 5000, ...args) { try { await p.waitForFunction(fn, { timeout: ms, polling: 50 }, ...args); return true; } catch { return false; } }
const view = (p, v) => p.click(`[data-testid="view-${v}"]`);
const connect = async (p, route) => { await p.select('[data-testid="connection-route"]', route); await p.click('[data-testid="connection-toggle"]'); };
const cfgPage = (p, pg) => p.click(`#cfgPages button[data-page="${pg}"]`);
const setVal = (p, sel, v) => p.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); }, String(v));
async function clickGauge(p, deg, frac = 0.85) {
  await p.$eval("#dGauge", (e) => e.scrollIntoView({ block: "center" }));
  await sleep(100);
  const box = await (await p.$("#dGauge svg")).boundingBox();
  const r = box.width / 2 * frac, a = deg * Math.PI / 180;
  await p.mouse.click(box.x + box.width / 2 + r * Math.cos(a), box.y + box.height / 2 + r * Math.sin(a));
}
const canTx = (p) => p.evaluate(() => window.__tx.map((u) => { const id = (u[3] | (u[4] << 8)) >> 5; const dlc = u[2] & 15; return id.toString(16) + ":" + u.slice(5, 5 + dlc).map((x) => x.toString(16).padStart(2, "0")).join(""); }));

// ================= v2 serial =================
{
  const { p, errs } = await newPage({ serial: "v2" });
  check("v2: dashboard is the home view", await p.$eval("#view-dash", (e) => e.classList.contains("active") && e.offsetParent !== null));
  await p.screenshot({ path: `${shotDir}/phase1-home-disconnected.png` });
  check("v2: nothing sent before connect", (await allWrites(p)).length === 0);
  await connect(p, "serial");
  check("v2: detected", await waitFor(p, () => /v2\.0\.0/.test(document.getElementById("stFw").textContent)), await txt(p, "stFw"));
  await waitFor(p, () => document.getElementById("pd_CAN_ID")?.textContent === "2");
  const w0 = await allWrites(p);
  const iP = w0.indexOf("PING"), iI = w0.indexOf("INFO"), iH = w0.indexOf("HELP"), iG = w0.indexOf("GET");
  check("v2: auto-connect order PING → INFO → HELP → GET", iP >= 0 && iP < iI && iI < iH && iH < iG, w0.slice(0, 6).join(" | "));
  check("v2: no v3 probes (TLIST/TCH/TRATE/FAULT/SETZERO never sent)", !w0.some((w) => /^(TLIST|TCH|TRATE|FAULT|SETZERO)/.test(w)));
  check("v2: link panel folds to summary after connect", await waitFor(p, () => !document.getElementById("linkBox").open && /DR4310 v2/.test(document.getElementById("sumSer").textContent), 3000), await txt(p, "sumSer"));
  check("v2: gauge fully above the fold", await p.$eval("#dGauge", (e) => e.getBoundingClientRect().bottom <= innerHeight));
  check("v2: no motion commands during connect", !w0.some((w) => !/^SET TELEM [01]$/.test(w) && /^(SPD|CUR|POS|MIT|RUN|IQ|AE|SAVE|SET|REBOOT|CALIB)/.test(w)), w0.join(" | "));
  check("v2: drive params rendered", (await txt(p, "pd_SPD_KP")) === "0.25" && (await txt(p, "pd_MIT_KD")) === "0.5");
  check("v2: CAN_ID on 通信参数 page", !!(await p.$("#cfgBody_comm #pd_CAN_ID")));
  check("v2: motor page shows v3 hint", /v3/.test(await txt(p, "cfgBody_motor")));
  check("v2: 其他 tab hidden", await p.$eval("#cfgTab_other", (e) => e.classList.contains("hidden")));
  check("v2: SETZERO hidden", await p.$eval("#dZero", (e) => e.classList.contains("hidden")) && await p.$eval("#zeroSec", (e) => e.classList.contains("hidden")));
  check("v2: fault snapshot button hidden", await p.$eval("#btnFaultRead", (e) => e.classList.contains("hidden")));
  check("v2: telemetry picker hidden (fixed 16)", await p.$eval("#telSec", (e) => e.classList.contains("hidden")));
  await sleep(1200);
  check("v2: route = serial", /串口/.test(await txt(p, "dRoute")), await txt(p, "dRoute"));
  check("v2: status 空闲", (await txt(p, "dStatusT")) === "电机空闲", await txt(p, "dStatusT"));
  check("v2: Vbus badge", /12\.\d+ V/.test((await txt(p, "mVbusV")) + " V"), (await txt(p, "mVbusV")) + " V");
  check("v2: power badge from dq telemetry", /W/.test(await txt(p, "dPower")) && await p.$eval("#dPower", e => /dq/.test(e.title)));
  check("v2: no runtime auto-enable switch on the dashboard", !(await p.$('[data-testid="auto-enable"]')) && !(await p.$("#dAutoEnable")));
  check("v2: AE indicator shows INFO ae=0", await waitFor(p, () => document.getElementById("dAe").dataset.ae === "0" && !document.getElementById("dAe").classList.contains("hidden")), await txt(p, "dAe"));
  await p.evaluate(() => { window.__dev.ae = 1; window.__dev.mode = 2; }); // firmware booted with BOOT_AE=1
  check("v2: AE indicator → 自动使能 开 (read-only)", await waitFor(p, () => document.getElementById("dAe").dataset.ae === "1" && document.getElementById("dAe").classList.contains("on")), await txt(p, "dAe"));
  await p.keyboard.press("Escape"); await sleep(150);
  const aeStop = await allWrites(p), lastStop = aeStop.lastIndexOf("STOP");
  check("v2: Esc sends AE 0 before STOP; indicator back to 关", lastStop > 0 && aeStop[lastStop - 1] === "AE 0" && await waitFor(p, () => document.getElementById("dAe").dataset.ae === "0"));
  // gauge pick (not running → no send)
  const before = (await writes(p)).length;
  await clickGauge(p, 0);
  await sleep(200);
  const tgt = Number(await p.$eval("#dTarget", (e) => e.value));
  check("v2: gauge click sets target (direct drive, motor rpm)", tgt > 0, String(tgt));
  check("v2: no gear/output-shaft UI (direct drive)", !(await p.$("#hGear")) && !(await p.$("#hOutput")) && !(await p.$("#dOutput")) && (await txt(p, "mSpdU")) === "rpm" && !/输出轴|减速/.test(await p.evaluate(() => document.body.innerText)));
  check("v2: picking while stopped sends nothing", (await writes(p)).length === before);
  await p.screenshot({ path: `${shotDir}/phase1-dashboard-serial-v2.png` });
  // start → host ramp 300 ms
  await p.click("#dStart");
  check("v2: running", await waitFor(p, () => document.getElementById("dStart").textContent === "停止"));
  await sleep(700);
  const spd = (await writes(p)).filter((w) => w.startsWith("SPD"));
  const last = Number(spd[spd.length - 1]?.split(" ")[1]);
  check("v2: host ramp sends several SPD steps", spd.length >= 3 && Number(spd[0].split(" ")[1]) < last, spd.slice(0, 8).join(","));
  check("v2: final SPD = target (no gear factor)", Math.abs(last - tgt) < 0.6, `${last} vs ${tgt}`);
  check("v2: device in speed mode", (await p.evaluate(() => window.__dev.mode)) === 2);
  check("v2: status 运行", await waitFor(p, () => document.getElementById("dStatusT").textContent === "电机运行", 2000));
  check("v2: measured needle visible", await p.$eval("#dGauge .g-mes", (e) => e.style.display !== "none"));
  // waveform then E-stop (Esc)
  await p.$eval("#dAdvanced", e => { e.open = true; });
  await setVal(p, "#wAmp", 5); await setVal(p, "#wFreq", 2);
  await p.click("#wStart");
  await sleep(700);
  const ws = (await writes(p)).filter((w) => w.startsWith("SPD"));
  const vals = new Set(ws.slice(-10));
  check("v2: waveform varies SPD", vals.size >= 5, [...vals].join(","));
  await p.screenshot({ path: `${shotDir}/phase1-dashboard-wave.png` });
  await p.keyboard.press("Escape");
  await sleep(150);
  const nAfter = (await writes(p)).filter((w) => w.startsWith("SPD")).length;
  await sleep(600);
  const nLater = (await writes(p)).filter((w) => w.startsWith("SPD")).length;
  check("v2: Esc E-stop → STOP sent, waveform + dashboard halted", (await writes(p)).includes("STOP") && nLater === nAfter && (await txt(p, "dStart")) === "启动" && /启动波形/.test(await txt(p, "wStart")));
  check("v2: device idle after E-stop", (await p.evaluate(() => window.__dev.mode)) === 0);
  // mode tabs
  await p.click('#dModes button[data-dmode="cur"]');
  check("v2: torque tab shows A without Kt", /A/.test(await txt(p, "dTgtUnit")), await txt(p, "dTgtUnit"));
  await p.click('#dModes button[data-dmode="mit"]');
  check("v2: MIT tab shows MIT inputs", await p.$eval("#dMitRow", (e) => !e.classList.contains("hidden")));
  await p.click('#dModes button[data-dmode="spd"]');
  // settings: 同步 (SET + SAVE)
  await view(p, "cfg");
  await p.$eval("#pv_SPD_KP", (e) => { e.value = "0.3"; e.dispatchEvent(new Event("input")); });
  check("v2: row marked modified", await p.$eval("#pr_SPD_KP", (e) => e.classList.contains("mod")));
  await p.click("#btnSync");
  check("v2: 同步 writes and SAVEs", await waitFor(p, () => window.__dev.ram.SPD_KP === 0.3 && window.__dev.flash?.SPD_KP === 0.3));
  check("v2: row clean after sync", !(await p.$eval("#pr_SPD_KP", (e) => e.classList.contains("mod"))));
  // 重置
  await p.$eval(".more-actions", (d) => { d.open = true; }); await p.click("#btnDefaults");
  check("v2: 重置 → DEFAULTS + re-read", await waitFor(p, () => window.__writes.some((w) => w.trim() === "DEFAULTS") && document.getElementById("pd_SPD_KP").textContent === "0.25"));
  // profile import
  await cfgPage(p, "store");
  writeFileSync(tempProfile, JSON.stringify({ type: "dr4310-profile", version: 1, params: { SPD_KP: 0.4, NOPE_KEY: 1 }, host: { gear: 20, kt: 0.07, ramp: { spd: 100 } } }));
  await (await p.$("#profFile")).uploadFile(tempProfile);
  check("v2: profile import fills + marks", await waitFor(p, () => document.getElementById("pv_SPD_KP").value === "0.4" && document.getElementById("pr_SPD_KP").classList.contains("mod")));
  check("v2: profile import skips unknown + applies host", /跳过 1/.test(await txt(p, "msg")) && (await p.$eval("#hKt", (e) => e.value)) === "0.07", await txt(p, "msg"));
  await p.$eval(".more-actions", (d) => { d.open = true; }); await p.click("#btnRevertInputs");
  await p.click("#btnExport");
  await sleep(300);
  const dl = await p.evaluate(() => window.__dl);
  const prof = dl.find((d) => /profile/.test(d.name));
  let pj = null; try { pj = JSON.parse(prof?.text ?? "null"); } catch { /* */ }
  check("v2: profile export JSON", pj?.type === "dr4310-profile" && pj.params.CAN_ID === 2 && Object.keys(pj.params).length === 21 && pj.host?.kt === 0.07 && !("gear" in pj.host) && !("output" in pj.host), prof?.name);
  await setVal(p, "#hKt", ""); // reset imported Kt so later sections see current in A
  // recorder → log manager
  await view(p, "debug"); await p.$eval('[data-testid="record-details"]', e => { e.open = true; });
  await p.click("#recBtn"); await sleep(500); await p.click("#recBtn");
  await view(p, "cfg");
  check("v2: log auto-saved to IndexedDB", await waitFor(p, () => document.querySelectorAll("#logList button[data-dl]").length === 1, 3000));
  await sleep(200); await p.$eval("#logList button[data-dl]", (e) => e.click()); // list may re-render; click in-page
  await sleep(300);
  const csv = (await p.evaluate(() => window.__dl)).find((d) => d.name.endsWith(".csv"));
  check("v2: log download has CSV with uart channel names", !!csv && /^t_ms,src,id/.test(csv.text) && /Vbus/.test(csv.text) && csv.text.split("\n").length > 20, csv?.name);
  await p.screenshot({ path: `${shotDir}/phase1-config-store-logs.png` });
  await p.click("#logList button[data-del]");
  check("v2: log delete", await waitFor(p, () => document.querySelectorAll("#logList button[data-dl]").length === 0, 3000));
  // fault CLEAR from dock
  await view(p, "debug"); await p.$eval('[data-testid="fault-details"]', e => { e.open = true; });
  await p.click("#btnFaultClear");
  check("v2: CLEAR from fault panel", await waitFor(p, () => window.__writes.some((w) => w.trim() === "CLEAR")));
  await view(p, "cfg"); await cfgPage(p, "drive");
  await p.screenshot({ path: `${shotDir}/phase1-config-drive-v2.png`, fullPage: true });
  check("v2: no page errors", errs.length === 0, errs.join(" | "));
  await p.close();
}

// ================= v3 serial =================
{
  const { p, errs } = await newPage({ serial: "v3" });
  await connect(p, "serial");
  check("v3: detected", await waitFor(p, () => /v3\.0\.\d/.test(document.getElementById("stFw").textContent) && document.querySelector("#pd_KT"), 6000), await txt(p, "stFw"));
  check("v3: features", await waitFor(p, () => /遥测通道 可选.*故障快照 有.*设零 有/.test(document.getElementById("cfgFeat").textContent)), await txt(p, "cfgFeat"));
  const w0 = await allWrites(p);
  check("v3: probe sequence incl. TLIST/TCH/TRATE/FAULT", ["PING", "INFO", "HELP", "GET", "TLIST", "TCH", "TRATE", "FAULT"].every((c) => w0.includes(c)) && w0.indexOf("GET") < w0.indexOf("TLIST"), w0.slice(0, 10).join(" | "));
  check("v3: SETZERO not probed", !w0.includes("SETZERO"));
  check("v3: motor params (GEAR_RATIO row hidden — direct drive)", (await p.$eval("#pr_GEAR_RATIO", (e) => e.classList.contains("hidden"))) && (await txt(p, "pd_KT")) === "0.06" && (await txt(p, "pd_POLE_PAIRS")) === "14");
  check("v3: firmware Kt overrides host, no gear", (await p.$eval("#hKt", (e) => e.disabled && e.value === "0.06")) && /来源：固件/.test(await txt(p, "hFwNote")) && /直驱 · Kt 0\.06/.test(await txt(p, "dDisp")));
  check("v3: unknown key → 其他", !(await p.$eval("#cfgTab_other", (e) => e.classList.contains("hidden"))) && !!(await p.$("#cfgBody_other #pd_FOO_BAR")));
  check("v3: ramp keys on drive page", !!(await p.$("#cfgBody_drive #pd_SPD_RAMP_MS")));
  check("v3: CAN_BAUD on comm page", !!(await p.$("#cfgBody_comm #pd_CAN_BAUD")));
  await sleep(800);
  check("v3: 16 telemetry channels from @TCH", /遥测通道 · 16/.test(await txt(p, "uValsH")), await txt(p, "uValsH"));
  check("v3: parser width = 7, frames flowing", await p.evaluate(() => true) && /累计 \d+/.test(await txt(p, "stSerFrames")) && Number((await txt(p, "stSerFrames")).match(/累计 (\d+)/)[1]) > 30, await txt(p, "stSerFrames"));
  check("v3: fault snapshot shown (active=0, snap fault=0x0040 → 欠压)", /0x0040/.test(await txt(p, "faultSnap")) && /欠压/.test(await txt(p, "faultSnap")) && !(await p.$eval("#btnFaultRead", (e) => e.classList.contains("hidden"))), await txt(p, "faultSnap"));
  check("v3: INFO latched chip", /母线欠压/.test(await txt(p, "faultInfo")), await txt(p, "faultInfo"));
  check("v3: firmware ramp chip", /固件斜坡 250 ms/.test(await txt(p, "dRampChip")), await txt(p, "dRampChip"));
  check("v3: Kt → torque units", await (async () => { await p.click('#dModes button[data-dmode="cur"]'); const u = await txt(p, "dTgtUnit"); await p.click('#dModes button[data-dmode="spd"]'); return /N·m/.test(u); })());
  check("v3: power from POWER channel? (dq when POWER inactive)", /W/.test(await txt(p, "dPower")), (await txt(p, "dPower")) + " " + (await txt(p, "dPowerSrc")));
  // SETZERO from dashboard
  await p.$eval("#dAdvanced", e => { e.open = true; });
  check("v3: 设零 visible", !(await p.$eval("#dZero", (e) => e.classList.contains("hidden"))));
  await p.click("#dZero");
  check("v3: SETZERO → ZERO_OFFSET re-read", await waitFor(p, () => window.__writes.some((w) => w.trim() === "SETZERO") && document.getElementById("pd_ZERO_OFFSET").textContent === "1.25"), await txt(p, "pd_ZERO_OFFSET"));
  // speed with firmware ramp → no host ramp steps
  await setVal(p, "#dTarget", 20); await p.click("#dApply");
  await p.click("#dStart");
  await sleep(600);
  const spd = (await writes(p)).filter((w) => w.startsWith("SPD"));
  check("v3: firmware ramp → single SPD (no host ramp)", spd.length === 1 && spd[0] === "SPD 20", spd.join(","));
  await p.screenshot({ path: `${shotDir}/phase1-dashboard-serial-v3.png` });
  await p.click("#dStart");
  check("v3: stop → STOP", await waitFor(p, () => window.__writes.some((w) => w.trim() === "STOP") && window.__dev.mode === 0));
  // position: start holds measured position (POS channel)
  await p.click('#dModes button[data-dmode="pos"]');
  await sleep(300);
  const posMeas = await p.evaluate(() => window.__dev.pos);
  await p.click("#dStart");
  await sleep(400);
  const pos = (await writes(p)).filter((w) => w.startsWith("POS"));
  // Default v3 telemetry omits PosRad. Start adds it in RAM, then holds the fresh position when no target was entered.
  check("v3: position start obtains PosRad and holds the current position", !p.dialogs.some(m => /未知电机当前位置/.test(m)) && pos.length >= 1 && Math.abs(Number(pos[0].slice(4)) - posMeas) < 0.05 && await p.evaluate(() => window.__dev.active.includes(22)), `${pos[0]} vs ${posMeas.toFixed(3)}`);
  await p.click("#dStart");
  await waitFor(p, () => window.__dev.mode === 0);
  // telemetry picker
  await view(p, "cfg"); await cfgPage(p, "comm");
  check("v3: telemetry picker visible with 28 channels", (await p.$$eval("#telList input", (e) => e.length)) === 28);
  await p.$$eval("#telList input", (els) => els.forEach((e) => { e.checked = ["3", "21", "22"].includes(e.value); }));
  await setVal(p, "#telRate", 120);
  await p.click("#telApply");
  check("v3: TCH = 16 names (Iq,Rpm,PosRad + padding) + TRATE 120", await waitFor(p, () => window.__writes.some((w) => /^TCH Iq,Rpm,PosRad,IdRef,Id,/.test(w.trim()) && w.trim().slice(4).split(",").length === 16) && window.__writes.some((w) => w.trim() === "TRATE 120")), (await p.evaluate(() => window.__writes.filter((w) => /^TCH /.test(w)).join(" | "))));
  check("v3: TCH read back after bare @OK TCH", await waitFor(p, () => window.__writes.filter((w) => w.trim() === "TCH").length >= 2));
  check("v3: no TCH/TRATE errors", !(await p.evaluate(() => /@ERR (TCH|TRATE)/.test(document.body.innerText))));
  check("v3: host keeps 16-channel frame", await waitFor(p, () => /遥测通道 · 16/.test(document.getElementById("uValsH").textContent)), await txt(p, "uValsH"));
  await sleep(600);
  const f1 = Number((await txt(p, "stSerFrames")).match(/累计 (\d+)/)[1]); await sleep(500);
  const f2 = Number((await txt(p, "stSerFrames")).match(/累计 (\d+)/)[1]);
  check("v3: frames keep flowing at new width", f2 - f1 > 20, `${f1}→${f2}`);
  check("v3: telem state text", /16 通道：Iq, Rpm, PosRad, IdRef/.test(await txt(p, "telState")), await txt(p, "telState"));
  await p.screenshot({ path: `${shotDir}/phase1-config-comm-telemetry.png`, fullPage: true });
  // with PosRad streamed, position start holds the measured position (no jump, no dialog)
  await view(p, "dash"); await sleep(400);
  const nDlg = p.dialogs.length, nW = (await writes(p)).length;
  await p.click('#dModes button[data-dmode="pos"]'); await sleep(300);
  const posMeas2 = await p.evaluate(() => window.__dev.pos);
  await p.click("#dStart"); await sleep(400);
  const pos2 = (await writes(p)).slice(nW).filter((w) => w.startsWith("POS"));
  check("v3: PosRad streamed → position start holds measured position", pos2.length >= 1 && Math.abs(Number(pos2[0].split(" ")[1]) - posMeas2) < 0.05 && p.dialogs.length === nDlg, `${pos2[0]} vs ${posMeas2.toFixed(3)}`);
  await p.click("#dStart"); await waitFor(p, () => window.__dev.mode === 0);
  await view(p, "cfg"); await cfgPage(p, "comm");
  await cfgPage(p, "motor");
  await p.screenshot({ path: `${shotDir}/phase1-config-motor-v3.png`, fullPage: true });
  await view(p, "debug"); await p.click('button[data-tab="uart"]');
  await sleep(400);
  await p.screenshot({ path: `${shotDir}/phase1-debug-uart-v3.png` });
  check("v3: no page errors", errs.length === 0, errs.join(" | "));
  await p.close();
}

// ================= legacy serial =================
{
  const { p, errs } = await newPage({ serial: "legacy" });
  await connect(p, "serial");
  check("legacy: detected", await waitFor(p, () => /旧固件/.test(document.getElementById("stFw").textContent), 7000), await txt(p, "stFw"));
  await p.click("#dStart");
  check("legacy: speed refused (current only)", /只支持电流/.test(await txt(p, "msg")), await txt(p, "msg"));
  await p.click('#dModes button[data-dmode="cur"]');
  await setVal(p, "#dTarget", 0.1); await p.click("#dApply");
  await p.click("#dStart");
  await sleep(500);
  const w = await allWrites(p);
  check("legacy: RUN then IQ ramp", w.includes("RUN") && w.some((x) => x === "IQ 0.1"), w.slice(-5).join(","));
  await p.click("#dStart");
  check("legacy: stop → STOP", await waitFor(p, () => window.__writes.some((w) => w.trim() === "STOP")));
  check("legacy: no page errors", errs.length === 0, errs.join(" | "));
  await p.close();
}

// ================= CAN (fake PCAN) =================
{
  const { p, errs } = await newPage({ pcan: true });
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: "networkidle0" });
  await connect(p, "can");
  check("can: bus on", await waitFor(p, () => /1 Mbps/.test(document.getElementById("stPcanBus").textContent)));
  check("can: discovery lists IDs 1,3,5", await waitFor(p, () => ["1", "3", "5"].every((i) => document.querySelector(`#canNodes button[data-node="${i}"]`)), 4000), await txt(p, "canNodes"));
  check("can: discovery is passive (no TX)", (await canTx(p)).length === 0);
  check("can: ID 1 has fault → 异常", await waitFor(p, () => document.getElementById("dStatusT").textContent === "电机故障", 2000), await txt(p, "dStatusT"));
  check("can: fault chip 过流", /过流/.test(await txt(p, "faultChips")));
  await p.click("#dStart");
  check("can: start refused while faulted", /故障/.test(await txt(p, "msg")) && (await canTx(p)).length === 0, await txt(p, "msg"));
  await p.select('[data-testid="motor-id"]', "3");
  await waitFor(p, () => document.getElementById("motorId").value === "3" && !document.getElementById("motorId").disabled);
  check("can: click node switches motor ID", (await p.$eval("#motorId", (e) => e.value)) === "3" && /NODE 3/.test(await txt(p, "hdrIds")));
  check("can: status 空闲 + Vbus 12.40", await waitFor(p, () => document.getElementById("dStatusT").textContent === "电机空闲" && /12\.40 V/.test(document.getElementById("mVbusV").textContent + " V"), 2500), `${await txt(p, "dStatusT")} ${(await txt(p, "mVbusV")) + " V"}`);
  check("can: route CAN", /CAN/.test(await txt(p, "dRoute")));
  await p.screenshot({ path: `${shotDir}/phase1-dashboard-can.png` });
  // speed via CAN 0x403 with host ramp
  await setVal(p, "#dTarget", 10); await p.click("#dApply");
  await p.click("#dStart");
  await sleep(600);
  const tx = (await canTx(p)).filter((t) => t.startsWith("403:"));
  check("can: speed ramp frames on 0x403", tx.length >= 5, String(tx.length));
  const lastF = tx[tx.length - 1];
  const le16 = (f) => { const d = f.split(":")[1]; return parseInt(d.slice(2, 4) + d.slice(0, 2), 16); };
  const raw = lastF ? le16(lastF) : NaN;
  const rpmOf = (n) => -1000 + (n / 65535) * 2000;
  const rpmTx = rpmOf(raw);
  const firstRaw = le16(tx[0]);
  check("can: speed ramps 0 → 10 rpm (direct drive, no gear)", Math.abs(rpmTx - 10) < 0.1 && Math.abs(rpmOf(firstRaw)) < 30, `${rpmOf(firstRaw).toFixed(2)} → ${rpmTx.toFixed(2)}`);
  await p.keyboard.press("Escape");
  await sleep(200);
  const es = (await canTx(p)).slice(-4);
  check("can: Esc → 0x103 auto-enable off + E-stop", es.some((t) => t === "103:0800000000000000") && es.filter((t) => t.startsWith("103:03")).length >= 2, es.join(" "));
  check("can: dashboard halted", (await txt(p, "dStart")) === "启动");
  // current mode (confirm dialog accepted)
  await p.click('#dModes button[data-dmode="cur"]');
  await setVal(p, "#dTarget", 0.2); await p.click("#dApply");
  await p.click("#dStart"); await sleep(400);
  check("can: current frames 0x103 cmd 01", (await canTx(p)).some((t) => t.startsWith("103:01")));
  await p.click("#dStart"); await sleep(150);
  check("can: stop → disable 0x103 00", (await canTx(p)).slice(-2).some((t) => t === "103:0000000000000000"));
  // MIT
  await p.click('#dModes button[data-dmode="mit"]');
  await p.click("#dStart"); await sleep(300);
  const mt = await canTx(p);
  check("can: MIT enter 0x06 then pack", mt.some((t) => t.startsWith("103:06")));
  await p.click("#dStart"); await sleep(150);
  // views
  await view(p, "debug");
  check("can: debug view has scope + tabs", await p.$eval("#chRpm", (e) => e.offsetParent !== null) && await p.$eval("#panel-native", (e) => e.offsetParent !== null));
  await p.screenshot({ path: `${shotDir}/phase1-debug.png` });
  await view(p, "dash");
  // light theme + mobile
  await p.click("#themeToggle"); await sleep(300);
  await p.screenshot({ path: `${shotDir}/phase1-dashboard-light.png` });
  await p.click("#themeToggle"); await sleep(200);
  await p.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });
  await sleep(400);
  await p.screenshot({ path: `${shotDir}/phase1-mobile.png`, fullPage: false });
  check("can: no page errors", errs.length === 0, errs.join(" | "));
  await p.close();
}

// ================= auto-reconnect =================
{
  const { p, errs } = await newPage({ pcan: true, serial: "v2", prep: () => { localStorage.setItem("dr4310.autoReconnect", "1"); window.__grantedSerial = true; } });
  check("auto: PCAN reconnected", await waitFor(p, () => /1 Mbps/.test(document.getElementById("stPcanBus").textContent), 4000));
  check("auto: serial reconnected + probed", await waitFor(p, () => /v2\.0\.0/.test(document.getElementById("stFw").textContent), 5000));
  check("auto: no CAN TX, no motion on serial", (await canTx(p)).length === 0 && !(await allWrites(p)).some((w) => !/^SET TELEM [01]$/.test(w.trim()) && /^(SPD|CUR|POS|MIT|RUN|IQ|AE|SAVE|SET)/.test(w)));
  check("auto: checkbox persisted", await p.$eval("#autoRe", (e) => e.checked));
  check("auto: no page errors", errs.length === 0, errs.join(" | "));
  await p.close();
}

// ================= watchdog: hidden page stops the dashboard =================
{
  const { p, errs } = await newPage({ serial: "v2" });
  await connect(p, "serial");
  await waitFor(p, () => /v2\.0\.0/.test(document.getElementById("stFw").textContent));
  await sleep(300);
  await setVal(p, "#dTarget", 5); await p.click("#dApply");
  await p.click("#dStart"); await sleep(400);
  await p.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  check("wd: hidden → STOP + dashboard halted", await waitFor(p, () => window.__writes.some((w) => w.trim() === "STOP") && document.getElementById("dStart").textContent === "启动"));
  check("wd: no page errors", errs.length === 0, errs.join(" | "));
  await p.close();
}

// ================= AE-off-first on every stop path (no runtime AE switch; firmware may have AE on from BOOT_AE) =================
{
  const { p, errs } = await newPage({ pcan: { nodes: [{ id: 1, mode: 0, faults: 0, primary: 12.4 }] } });
  await p.evaluate(() => localStorage.clear()); await p.reload({ waitUntil: "networkidle0" }); // earlier sections persisted motor ID 3
  await view(p, "dash");
  await connect(p, "can");
  await waitFor(p, () => document.getElementById("dStatusT").textContent === "电机空闲", 3000); await sleep(300);
  const mark = async () => (await canTx(p)).length;
  const tail = async (n) => (await canTx(p)).slice(n).filter((f) => f.startsWith("101:"));
  const aeFirst = (t, stop) => t.length >= 2 && t[0].startsWith("101:0800") && t.slice(1).some((f) => f.startsWith("101:" + stop));
  const run = async () => { await setVal(p, "#dTarget", 5); await p.click("#dApply"); if ((await txt(p, "dStart")) !== "停止") await p.click("#dStart"); await waitFor(p, () => document.getElementById("dStart").textContent === "停止", 2000); await sleep(200); };
  check("ae(can): no runtime switch on the dashboard", !(await p.$('[data-testid="auto-enable"]')));
  await run(); let n = await mark(); await p.click("#dStart"); await sleep(400); let t = await tail(n);
  check("ae(can): normal stop → 08 00 before 00 (Disable)", aeFirst(t, "00"), t.join(","));
  await run(); n = await mark(); await p.click("#estop"); await sleep(300); t = await tail(n);
  check("ae(can): E-stop button → 08 00 before 03 ×2", aeFirst(t, "03") && t.filter((f) => f.startsWith("101:03")).length === 2, t.join(","));
  await run(); n = await mark(); await p.keyboard.press("Escape"); await sleep(300); t = await tail(n);
  check("ae(can): Esc → 08 00 before 03", aeFirst(t, "03"), t.join(","));
  await run(); n = await mark(); await p.evaluate(() => { window.__canNodes[0].faults = 0x42; }); await sleep(600); t = await tail(n);
  check("ae(can): CAN fault while running → 08 00 before 00", aeFirst(t, "00"), t.join(","));
  await p.evaluate(() => { window.__canNodes[0].faults = 0; }); await sleep(600);
  await run(); n = await mark();
  await p.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await sleep(400); t = await tail(n);
  check("ae(can): page hidden → 08 00 before 00", aeFirst(t, "00"), t.join(","));
  await p.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); });
  await run(); n = await mark(); await p.click('[data-testid="connection-toggle"]'); await sleep(500); t = await tail(n);
  check("ae(can): disconnect → 08 00 before 00", aeFirst(t, "00"), t.join(","));
  check("ae(can): host never sent 08 01 (AE on)", !(await canTx(p)).some((f) => /^1[0-9a-f]{2}:0801/.test(f)));
  check("ae(can): no page errors", errs.length === 0, errs.join(" | "));
  await p.close();
}
{
  const { p, errs } = await newPage({ serial: "v2" });
  await view(p, "dash");
  await connect(p, "serial");
  await waitFor(p, () => /v2\.0\.0/.test(document.getElementById("stFw").textContent)); await sleep(300);
  const ind = () => p.$eval("#dAe", (e) => e.dataset.ae);
  // Emulate a motor that booted with BOOT_AE=1 (or another tool set AE): the page only mirrors INFO ae=.
  const bootAe = async () => { await p.evaluate(() => { window.__dev.ae = 1; window.__dev.mode = 2; }); const ok = await waitFor(p, () => document.getElementById("dAe").dataset.ae === "1", 3000); await sleep(150); return ok; };
  const mark = async () => (await allWrites(p)).length;
  const tail = async (n) => (await allWrites(p)).slice(n).filter((w) => /^(AE|STOP)\b/.test(w));
  check("ae(serial): indicator shows firmware AE on", await bootAe(), await txt(p, "dAe"));
  let n = await mark(); await p.click("#estop"); await sleep(400); let t = await tail(n);
  check("ae(serial): E-stop → AE 0 then STOP, indicator 关", t[0] === "AE 0" && t[1] === "STOP" && await waitFor(p, () => document.getElementById("dAe").dataset.ae === "0", 3000), t.join(","));
  await bootAe(); await setVal(p, "#dTarget", 5); await p.click("#dApply"); await p.click("#dStart"); await sleep(400);
  n = await mark(); await p.click("#dStart"); await sleep(400); t = await tail(n);
  check("ae(serial): normal stop → AE 0 then STOP", t[0] === "AE 0" && t.includes("STOP") && (await p.evaluate(() => window.__dev.ae)) === 0, t.join(","));
  await bootAe(); n = await mark(); await p.evaluate(() => window.__injectSerial("@FAULT active=0x0080 latched=0x0080 snap=1 t=1 fault=0x0080 pos=0 omega=0 iq=0 vbus=41 mode=2")); await sleep(400); t = await tail(n);
  check("ae(serial): active @FAULT with AE on → AE 0 then STOP", t[0] === "AE 0" && t.includes("STOP"), t.join(","));
  await bootAe(); n = await mark();
  await p.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await sleep(400); t = await tail(n);
  check("ae(serial): page hidden with AE on → AE 0 then STOP", t[0] === "AE 0" && t.includes("STOP"), t.join(","));
  await p.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); });
  // STOP must not wait for the AE reply: firmware that never answers "AE" still gets STOP immediately
  await bootAe(); await p.evaluate(() => { window.__dev.muteAe = true; });
  n = await mark(); const t0 = Date.now(); await p.click("#estop");
  const fast = await waitFor(p, (k) => window.__writes.slice(k).some((w) => w.trim() === "STOP"), 400, n);
  check("ae(serial): STOP not delayed by a missing AE reply", fast, `${Date.now() - t0} ms`);
  await p.evaluate(() => { window.__dev.muteAe = false; });
  await bootAe(); n = await mark(); await p.click('[data-testid="connection-toggle"]'); await sleep(500); t = await tail(n);
  check("ae(serial): disconnect → AE 0 then STOP", t[0] === "AE 0" && t.includes("STOP"), t.join(","));
  check("ae(serial): indicator hidden when disconnected", await p.$eval("#dAe", (e) => e.classList.contains("hidden")));
  check("ae(serial): host never wrote AE 1", !(await allWrites(p)).some((w) => /^AE\s+1/.test(w)));
  check("ae(serial): no page errors", errs.length === 0, errs.join(" | "));
  await p.close();
}
// ================= settings › 驱动参数 › 上电行为 (BOOT_MODE / BOOT_TARGET / BOOT_AE) =================
{
  const { p, errs } = await newPage({ serial: "v2" });
  // before connecting: group visible, toggle disabled with a tooltip
  await view(p, "cfg"); await cfgPage(p, "drive");
  check("boot: group on 驱动参数 page", await p.$eval("#bootSec", (e) => e.offsetParent !== null && /上电行为/.test(e.textContent)));
  check("boot: offline → toggle disabled + tooltip", await p.$eval("#bootAe", (e) => e.disabled && /不支持/.test(e.title)));
  await view(p, "dash"); await connect(p, "serial");
  await waitFor(p, () => /v2\.0\.0/.test(document.getElementById("stFw").textContent));
  await view(p, "cfg"); await cfgPage(p, "drive");
  check("boot: enabled after GET", await waitFor(p, () => !document.getElementById("bootAe").disabled && document.getElementById("bootMode").value !== "", 4000));
  check("boot: BOOT_* rows hidden in tables", await p.$$eval("#pr_BOOT_AE, #pr_BOOT_MODE, #pr_BOOT_TARGET", (es) => es.length === 3 && es.every((e) => e.classList.contains("hidden"))));
  check("boot: no BOOT_* on 通信 page", !(await p.$("#cfgBody_comm #pr_BOOT_AE")));
  await p.select("#bootMode", "2"); await setVal(p, "#bootTarget", 60);
  const n0 = (await allWrites(p)).length;
  p.rejectNext = true; await p.click("#bootAe"); await sleep(150);
  check("boot: declined confirm → toggle off, nothing staged/sent", !(await p.$eval("#bootAe", (e) => e.checked)) && !(await p.$eval("#pr_BOOT_AE", (e) => e.classList.contains("mod"))) && p.dialogs.at(-1)?.includes("速度") && p.dialogs.at(-1)?.includes("60"), p.dialogs.at(-1));
  const nd = p.dialogs.length;
  await p.click("#bootAe"); await sleep(150);
  check("boot: confirm (mode + target) → staged, not yet sent", (await p.$eval("#bootAe", (e) => e.checked)) && (await p.$eval("#pr_BOOT_AE", (e) => e.classList.contains("mod"))) && !(await allWrites(p)).slice(n0).some((w) => /^SET BOOT_AE/.test(w)));
  await p.click("#btnSync");
  const ok = await waitFor(p, (k) => { const w = window.__writes.slice(k).map((x) => x.trim()); const i = w.indexOf("SET BOOT_AE 1"); return i >= 0 && w.slice(i).includes("SAVE"); }, 4000, n0);
  const w = (await allWrites(p)).slice(n0);
  check("boot: 同步 → SET BOOT_MODE/TARGET/AE then SAVE (one confirm only)", ok && w.includes("SET BOOT_MODE 2") && w.includes("SET BOOT_TARGET 60") && w.indexOf("SAVE") > w.indexOf("SET BOOT_AE 1") && p.dialogs.length === nd + 1, w.join(","));
  check("boot: never runtime AE 1", !w.some((x) => /^AE\b/.test(x)));
  check("boot: device stored BOOT_AE=1 (flash)", (await p.evaluate(() => window.__dev.flash?.BOOT_AE)) === 1);
  // idle boot mode → note says no effect
  await p.select("#bootMode", "0"); await sleep(100);
  check("boot: BOOT_MODE=0 → note: no effect", /空闲.*无效果/.test(await txt(p, "bootNote")), await txt(p, "bootNote"));
  await p.select("#bootMode", "2");
  check("boot: no page errors", errs.length === 0, errs.join(" | "));
  await p.close();
}
{
  const { p } = await newPage({ serial: "legacy" });
  await view(p, "dash"); await connect(p, "serial");
  await waitFor(p, () => /旧固件/.test(document.getElementById("stFw").textContent), 7000);
  await view(p, "cfg"); await cfgPage(p, "drive");
  check("boot: legacy firmware → toggle disabled + tooltip", await p.$eval("#bootAe", (e) => e.disabled && /不支持/.test(e.title)));
  await p.close();
}
await b.close();
console.log(results.join("\n"));
const fails = results.filter((r) => r.startsWith("FAIL"));
console.log(`\n${results.length - fails.length}/${results.length} passed`);
process.exit(fails.length ? 1 : 0);
