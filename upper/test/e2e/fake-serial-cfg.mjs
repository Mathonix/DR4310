import { launchBrowser } from "./browser.mjs";
const url = process.argv[2] || "http://localhost:8799/";
const shotDir = process.argv[3] || "";
const b = await launchBrowser();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, extra = "") => { results.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); };

async function fakePage(mode) {
  const p = await b.newPage();
  await p.setViewport({ width: 1400, height: 1100 });
  const errs = [];
  p.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*404/.test(m.text())) errs.push("console: " + m.text()); });
  p.on("dialog", (d) => d.accept());
  await p.evaluateOnNewDocument((mode) => {
    window.__writes = [];
    const enc = new TextEncoder();
    const META = [["CAN_ID",1,7,1,1],["BOOT_MODE",0,3,1,1],["BOOT_TARGET",-500,500,0,1],["BOOT_AE",0,1,1,1],["TELEM",0,1,1,0],["TIMEOUT_MS",0,60000,1,0],
      ["CUR_KP",0,100,0,0],["CUR_KI",0,100000,0,0],["CUR_VLIM",0,30,0,0],["IQ_LIM",0,2.5,0,0],["SPD_KP",0,10,0,0],["SPD_KI",0,5,0,0],["SPD_KD",0,1,0,0],
      ["ACCEL",0,100000,0,0],["POS_KP",0,200,0,0],["POS_KI",0,100,0,0],["POS_KD",0,100,0,0],["POS_ISEP",0,100,0,0],["POS_VLIM",0,500,0,0],["MIT_KP",0,500,0,0],["MIT_KD",0,5,0,0]];
    const v31 = mode === "v31";
    // List OL_* before IQ_LIM so the host cannot rely on firmware GET order.
    if (v31) { const i = META.findIndex((m) => m[0] === "IQ_LIM"); META.splice(i, 0, ["OL_EN",0,1,1,0],["OL_IQ",0,2.8,0,0],["OL_TIME_S",0,10,0,0]); }
    const DEF = {CAN_ID:1,BOOT_MODE:0,BOOT_TARGET:0,BOOT_AE:0,TELEM:1,TIMEOUT_MS:0,CUR_KP:12,CUR_KI:1500,CUR_VLIM:0,IQ_LIM:2.5,SPD_KP:0.25,SPD_KI:0.02,SPD_KD:0,ACCEL:0,POS_KP:3.5,POS_KI:1.2,POS_KD:2.6,POS_ISEP:0.35,POS_VLIM:100,MIT_KP:10,MIT_KD:0.5};
    if (v31) Object.assign(DEF, {OL_EN:0, OL_IQ:2.5, OL_TIME_S:2});
    const dev = { flash: null, ram: { ...DEF }, activeId: 1, mode: 0, ae: 0, seq: 0, up0: Date.now(), alive: true, latched: 0, cfg: "default", rx: "" };
    window.__dev = dev;
    let ctl;
    const out = [];
    const send = (s) => { if (mode !== "legacy" && dev.alive) out.push(enc.encode(s)); };
    const fmt = (v) => String(Number(v.toPrecision(6)));
    const reply = (line) => {
      const t = line.trim().toUpperCase().split(/[\s=,]+/).filter(Boolean);
      if (!t.length) return;
      const c = t[0], a = t.slice(1);
      const idle = dev.mode === 0 && dev.ae === 0;
      const ok = (d) => send(`@OK ${c}${d ? " " + d : ""}\n`);
      const err = (d) => send(`@ERR ${c} ${d}\n`);
      const P = (k) => { const m = META.find((x) => x[0] === k); send(`@P ${k}=${fmt(dev.ram[k])} min=${m[1]} max=${m[2]}${m[4] ? " reboot=1" : ""}\n`); };
      switch (c) {
        case "PING": send(`@PONG up=${Date.now() - dev.up0}\n`); return;
        case "INFO": send(`@INFO fw=DR4310 ver=${v31 ? "3.1.0" : "2.0.0"} id=${dev.activeId} cfg_id=${dev.ram.CAN_ID} mode=${dev.mode} run=${["IDLE","CURRENT","SPEED","POSITION","MIT"][dev.mode]} drv=${dev.mode ? 1 : 0} ae=${dev.ae} telem=${dev.ram.TELEM} fault=0x0000 latched=0x${dev.latched.toString(16).padStart(4,"0")} vbus=12.1 calib=1 zero=0.12578 dir=1 cfg=${dev.cfg} seq=${dev.seq} timeout=${dev.ram.TIMEOUT_MS} trips=0 drops=0 up=${Date.now() - dev.up0}${v31 ? " ol=ready budget=2" : ""}\n`); return;
        case "STOP": case "IDLE": case "ESTOP": if (!dev.ae) dev.mode = 0; send("@OK STOP\n"); return;
        case "MODE": dev.mode = Number(a[0]); ok(`mode=${["IDLE","CURRENT","SPEED","POSITION","MIT"][dev.mode]}`); return;
        case "CUR": dev.mode = 1; ok(`iq=${fmt(Math.max(-2.5, Math.min(2.5, Number(a[0]))))}`); return;
        case "SPD": dev.mode = 2; ok(`rpm=${fmt(Number(a[0]))}`); return;
        case "POS": dev.mode = 3; ok(`rad=${fmt(Number(a[0]))}`); return;
        case "MIT": if (a.length !== 5) return err("usage MIT p v kp kd iq"); dev.mode = 4; ok(); return;
        case "ZERO": ok(); return;
        case "CLEAR": dev.latched = 0; ok("latched=0x0000"); return;
        case "AE": dev.ae = Number(a[0]) ? 1 : 0; ok(`ae=${dev.ae}`); return;
        case "TELEM": dev.ram.TELEM = Number(a[0]) ? 1 : 0; ok(`telem=${dev.ram.TELEM}`); return;
        case "GET": {
          if (!a.length) { META.forEach((m) => P(m[0])); ok(String(META.length)); return; }
          if (!(a[0] in dev.ram)) return err("unknown_key"); P(a[0]); ok("1"); return;
        }
        case "SET": {
          if (a.length !== 2) return err("usage SET KEY VALUE");
          const m = META.find((x) => x[0] === a[0]); if (!m) return err("unknown_key");
          const v = Number(a[1]); if (!Number.isFinite(v)) return err("bad_value");
          if (v < m[1] || v > m[2] || (m[3] && !Number.isInteger(v))) return err(`range ${m[0]} ${m[1]}..${m[2]}`);
          if (a[0] === "OL_IQ" && v + 1e-9 < dev.ram.IQ_LIM) return err(`range OL_IQ ${fmt(dev.ram.IQ_LIM)}..${m[2]}`);
          // Raising IQ_LIM above OL_IQ lifts OL_IQ to the new continuous limit.
          if (a[0] === "IQ_LIM" && Object.prototype.hasOwnProperty.call(dev.ram, "OL_IQ") && v > dev.ram.OL_IQ + 1e-9) {
            dev.ram.IQ_LIM = v; dev.ram.OL_IQ = v; ok(`IQ_LIM=${fmt(v)}`); return;
          }
          dev.ram[m[0]] = v; ok(`${m[0]}=${fmt(v)}${m[4] ? " reboot=1" : ""}`); return;
        }
        case "SAVE": if (!idle) return err("not_idle"); dev.flash = { ...dev.ram }; dev.seq++; dev.cfg = "flash"; dev.alive = false; setTimeout(() => { dev.alive = true; ok(`seq=${dev.seq}`); }, 40); return;
        case "DEFAULTS": dev.ram = { ...DEF }; ok("ram_only"); return;
        case "RELOAD": dev.ram = { ...(dev.flash ?? DEF) }; ok(`cfg=${dev.cfg}`); return;
        case "REBOOT": if (!idle) return err("not_idle"); ok(); setTimeout(() => { dev.alive = false; }, 5);
          setTimeout(() => { dev.ram = { ...(dev.flash ?? DEF) }; dev.activeId = dev.ram.CAN_ID; dev.mode = 0; dev.up0 = Date.now(); dev.alive = true; }, 400); return;
        case "CALIB": if (!idle) return err("not_idle"); ok("started"); setTimeout(() => send("@OK CALIB done saved\n"), 300); return;
        default: err("unknown");
      }
    };
    const port = {
      readable: new ReadableStream({ start(c) { ctl = c; let t = 0;
        setInterval(() => {
          // flush queued replies + one frame, split at random points (like USB-serial chunking)
          const parts = [...out.splice(0)];
          if (dev.alive && (mode === "legacy" || dev.ram.TELEM)) {
            const vals = Array.from({ length: 16 }, (_, k) => Math.sin(t / 50 + k) * (k + 1)); t++;
            vals[10] = dev.mode === 2 ? 6.283 : 0; vals[8] = 12.1;
            const f = new Uint8Array(68); const dv = new DataView(f.buffer); vals.forEach((v, k) => dv.setFloat32(k * 4, v, true)); f.set([0, 0, 0x80, 0x7f], 64);
            parts.splice(Math.floor(Math.random() * (parts.length + 1)), 0, f);
          }
          if (!parts.length) return;
          const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of parts) { all.set(x, o); o += x.length; }
          let i = 0; while (i < all.length) { const n = 1 + Math.floor(Math.random() * 40); c.enqueue(all.slice(i, i + n)); i += n; }
        }, 10); } }),
      writable: new WritableStream({ write(ch) {
        const s = new TextDecoder().decode(ch); window.__writes.push(s);
        dev.rx += s; let k; while ((k = dev.rx.indexOf("\n")) >= 0) { const line = dev.rx.slice(0, k); dev.rx = dev.rx.slice(k + 1); if (dev.alive) reply(line); }
      } }),
      open: async () => {}, close: async () => {},
    };
    const ser = new EventTarget(); ser.requestPort = async () => port;
    Object.defineProperty(navigator, "serial", { value: ser });
  }, mode);
  await p.goto(url, { waitUntil: "networkidle0" });
  return { p, errs };
}
const txt = (p, id) => p.$eval("#" + id, (e) => e.textContent);
const writes = (p) => p.evaluate(() => window.__writes.map((w) => w.trim()).filter((w) => w && w !== "PING" && w !== "INFO"));
async function waitFor(p, fn, ms = 5000, ...args) { try { await p.waitForFunction(fn, { timeout: ms, polling: 50 }, ...args); return true; } catch { return false; } }

// ---------- v2 (merged UART-config) firmware ----------
{
  const { p, errs } = await fakePage("v2");
  await p.select('[data-testid="connection-route"]', "serial"); await p.click('[data-testid="connection-toggle"]');
  check("v2 detected", await waitFor(p, () => /v2\.0\.0/.test(document.getElementById("stFw").textContent)), await txt(p, "stFw"));
  check("params read", await waitFor(p, () => document.getElementById("pd_CAN_ID").textContent === "1" && document.getElementById("pd_MIT_KD").textContent === "0.5"));
  check("firmware ranges shown (POS_KP 0..200, SPD_KI 0..5)", await waitFor(p, () => document.getElementById("pg_POS_KP").textContent === "[0, 200]" && document.getElementById("pg_SPD_KI").textContent === "[0, 5]"));
  await sleep(800);
  check("telemetry frames still parsed", Number((await txt(p, "stSerFrames")).match(/累计 (\d+)/)?.[1] ?? 0) > 50, await txt(p, "stSerFrames"));
  check("no bytes dropped on interleaved stream", /丢弃 0 B/.test(await txt(p, "stSerLines")), await txt(p, "stSerLines"));
  check("CAN UI untouched: motor ID 1, CAN tab default", (await p.$eval("#motorId", (e) => e.value)) === "1" && (await p.$eval("#panel-native", (e) => e.classList.contains("active"))));
  await p.click('#views button[data-view="cfg"]');
  check("v2: overlimit hidden on 2.0.0", await p.$eval("#olFields", (e) => e.classList.contains("hidden")));
  check("v2: overlimit needs 3.1.0", /需 3\.1\.0 固件/.test(await txt(p, "olNote")), await txt(p, "olNote"));
  check("v2: max current still editable", await waitFor(p, () => !document.getElementById("iqMax").disabled && document.getElementById("iqMax").value === "2.5"));
  check("v2: no ol status without the field", await p.$eval("#olStatus", (e) => e.classList.contains("hidden") || e.textContent === ""));
  await p.$eval("#pv_SPD_KP", (e) => { e.value = "0.3"; e.dispatchEvent(new Event("input")); });
  check("row marked modified", await p.$eval("#pr_SPD_KP", (e) => e.classList.contains("mod")));
  await p.click('button[data-set="SPD_KP"]');
  check("SET SPD_KP applied", await waitFor(p, () => window.__dev.ram.SPD_KP === 0.3 && document.getElementById("pd_SPD_KP").textContent === "0.3"));
  await p.$eval("#pv_POS_KP", (e) => { e.value = "250"; e.dispatchEvent(new Event("input")); });
  await p.click('button[data-set="POS_KP"]');
  await sleep(200);
  check("range check blocks POS_KP 250 (CAN map max 200)", !(await writes(p)).some((w) => w.startsWith("SET POS_KP")), await txt(p, "msg"));
  await p.$eval("#pv_POS_KP", (e) => { e.value = "3.5"; e.dispatchEvent(new Event("input")); });
  // firmware-side error surfaces (raw line via VOFA tab)
  await p.click('#views button[data-view="debug"]').then(() => p.click('button[data-tab="uart"]'));
  await p.type("#uCustom", "SET CAN_ID 9"); await p.click("#uCustomSend");
  await p.click('#views button[data-view="debug"]').then(() => p.click('button[data-tab="log"]'));
  check("firmware @ERR shown in log", await waitFor(p, () => /超出范围/.test(document.getElementById("logBody").textContent)));
  await p.click('#views button[data-view="cfg"]');
  await p.$eval("#pv_IQ_LIM", (e) => { e.value = "2"; e.dispatchEvent(new Event("input")); });
  await p.$eval("#pv_TIMEOUT_MS", (e) => { e.value = "1500"; e.dispatchEvent(new Event("input")); });
  await p.$eval(".more-actions", (d) => { d.open = true; }); await p.click("#btnWriteMod");
  check("write modified", await waitFor(p, () => window.__dev.ram.IQ_LIM === 2 && window.__dev.ram.TIMEOUT_MS === 1500));
  check("unsaved banner", /未保存/.test(await txt(p, "cfgBanner")));
  await p.click('#cfgPages button[data-page="store"]'); await p.click("#btnSave");
  check("SAVE ok", await waitFor(p, () => window.__dev.seq === 1 && !/未保存/.test(document.getElementById("cfgBanner").textContent)), await txt(p, "msg"));
  await p.click('#cfgPages button[data-page="comm"]'); await p.select("#newCanId", "3");
  check("ID hint lists 0x103/0x403/0x503/0x183", /0x103.*0x403.*0x503.*0x183/.test(await txt(p, "canIdHint")), await txt(p, "canIdHint"));
  await p.click('#cfgPages button[data-page="comm"]'); await p.click("#btnApplyId");
  check("CAN ID flow → active 3", await waitFor(p, () => document.getElementById("cfgActiveId").textContent === "3", 8000), await txt(p, "msg"));
  const w1 = await writes(p);
  const iSet = w1.indexOf("SET CAN_ID 3"), iSave = w1.lastIndexOf("SAVE"), iReb = w1.indexOf("REBOOT");
  check("sequence STOP→SET→SAVE→REBOOT", iSet > 0 && (w1[iSet - 1] === "STOP" || (w1[iSet - 1] === "SET TELEM 0" && w1[iSet - 2] === "STOP")) && iSave > iSet && iReb > iSave, JSON.stringify(w1.slice(iSet - 1, iReb + 1)));
  check("params persisted across reboot", await waitFor(p, () => document.getElementById("pd_SPD_KP").textContent === "0.3" && document.getElementById("pd_CAN_ID").textContent === "3"));
  await p.$eval(".more-actions", (d) => { d.open = true; }); await p.click("#btnDefaults");
  check("DEFAULTS → table refresh", await waitFor(p, () => document.getElementById("pd_SPD_KP").textContent === "0.25"));
  await p.click('#cfgPages button[data-page="store"]'); await p.click("#btnReload");
  check("RELOAD → flash values", await waitFor(p, () => document.getElementById("pd_SPD_KP").textContent === "0.3"));
  if (shotDir) { await sleep(300); await p.evaluate(() => window.scrollTo(0, 0)); await p.screenshot({ path: shotDir + "/after-dr4310-serial-settings.png", fullPage: true }); }
  const hb = await p.evaluate(() => window.__writes.filter((w) => w === "PING\n" || w === "INFO\n").length);
  check("heartbeat PING/INFO running", hb > 5, String(hb));
  await p.keyboard.press("Escape");
  check("Esc E-stop → serial STOP", await waitFor(p, () => window.__dev.mode === 0 && window.__writes.filter((w) => w === "STOP\n").length >= 2));
  await p.click('#views button[data-view="debug"]').then(() => p.click('button[data-tab="uart"]'));
  await p.click('button[data-u="RUN"]');
  await sleep(150);
  await p.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  check("hidden → STOP", await waitFor(p, () => window.__writes.slice(-3).includes("STOP\n")));
  await p.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); });
  check("no page errors", errs.length === 0, errs.join(" | "));
  await p.close();
}
// ---------- firmware 3.1.0: IQ_LIM + OL_EN / OL_IQ / OL_TIME_S ----------
{
  const { p, errs } = await fakePage("v31");
  await p.select('[data-testid="connection-route"]', "serial"); await p.click('[data-testid="connection-toggle"]');
  check("v31 detected", await waitFor(p, () => /v3\.1\.0/.test(document.getElementById("stFw").textContent)), await txt(p, "stFw"));
  await p.click('#views button[data-view="cfg"]');
  check("v31: overlimit visible", await waitFor(p, () => !document.getElementById("olFields").classList.contains("hidden") && document.getElementById("pd_OL_IQ").textContent === "2.5"));
  check("v31: status ready 2.0 s", await waitFor(p, () => document.getElementById("olStatus").textContent === "超限：就绪 2.0 s"), await txt(p, "olStatus"));
  check("v31: switch off disables inputs", (await p.$eval("#olCurrent", (e) => e.disabled)) && (await p.$eval("#olTime", (e) => e.disabled)) && !(await p.$eval("#olEnable", (e) => e.checked)));
  await p.click('[data-testid="ol-enable"]');
  check("v31: switch on enables inputs", await waitFor(p, () => !document.getElementById("olCurrent").disabled && !document.getElementById("olTime").disabled));
  await p.click('[data-testid="ol-enable"]');
  check("v31: switch off disables again", await waitFor(p, () => document.getElementById("olCurrent").disabled && document.getElementById("olTime").disabled));
  await p.click('[data-testid="ol-enable"]');
  await waitFor(p, () => !document.getElementById("olCurrent").disabled);
  const n0 = (await writes(p)).length;
  await p.$eval('[data-testid="ol-current"]', (e) => { e.value = "2"; e.dispatchEvent(new Event("input", { bubbles: true })); });
  check("v31: inline hint when OL_IQ < IQ_LIM", await waitFor(p, () => /最大电流/.test(document.getElementById("olHint").textContent)), await txt(p, "olHint"));
  await p.click("#btnSync");
  await sleep(600);
  const wBad = (await writes(p)).slice(n0);
  check("v31: illegal OL_IQ not sent", !wBad.some((w) => w.startsWith("SET OL_IQ")) && (await p.evaluate(() => window.__dev.ram.OL_IQ)) === 2.5, wBad.join(","));
  await p.$eval('[data-testid="ol-current"]', (e) => { e.value = "2.6"; e.dispatchEvent(new Event("input", { bubbles: true })); });
  check("v31: hint clears for a legal value", await waitFor(p, () => document.getElementById("olHint").textContent === ""));
  await p.click("#btnSync");
  check("v31: legal OL_IQ written to ram", await waitFor(p, () => window.__dev.ram.OL_IQ === 2.6 && window.__dev.ram.OL_EN === 1, 4000));
  await p.click('#views button[data-view="debug"]').then(() => p.click('button[data-tab="uart"]'));
  await p.$eval("#uCustom", (e) => { e.value = "SET OL_IQ 1"; });
  await p.click("#uCustomSend");
  await p.click('button[data-tab="log"]');
  check("v31: firmware rejects OL_IQ below IQ_LIM", await waitFor(p, () => /超出范围/.test(document.getElementById("logBody").textContent)));
  check("v31: direct SET did not lower ram", (await p.evaluate(() => window.__dev.ram.OL_IQ)) === 2.6);
  const nOrd = await p.evaluate(() => window.__writes.length);
  await p.click('#views button[data-view="cfg"]');
  await p.$eval('[data-testid="iq-max"]', (e) => { e.value = "1.2"; e.dispatchEvent(new Event("input", { bubbles: true })); });
  await p.$eval('[data-testid="ol-current"]', (e) => { e.value = "1.8"; e.dispatchEvent(new Event("input", { bubbles: true })); });
  await p.click("#btnSync");
  check("v31: IQ_LIM written before OL_IQ", await waitFor(p, (n) => {
    const w = window.__writes.slice(n).map((x) => x.trim());
    const iq = w.indexOf("SET IQ_LIM 1.2"), ol = w.indexOf("SET OL_IQ 1.8");
    return iq >= 0 && ol > iq && window.__dev.ram.IQ_LIM === 1.2 && window.__dev.ram.OL_IQ === 1.8;
  }, 4000, nOrd));
  await p.$eval('[data-testid="iq-max"]', (e) => { e.value = "2"; e.dispatchEvent(new Event("input", { bubbles: true })); });
  await p.click("#btnSync");
  check("v31: raising IQ_LIM re-reads the lifted OL_IQ", await waitFor(p, () => window.__dev.ram.OL_IQ === 2 && document.getElementById("olCurrent").value === "2" && window.__writes.some((w) => w.trim() === "GET OL_IQ"), 4000));
  check("v31: no page errors", errs.length === 0, errs.join(" | "));
  await p.close();
}
// ---------- older firmware (the one on the board now: JustFloat only, never replies) ----------
{
  const { p, errs } = await fakePage("legacy");
  await p.select('[data-testid="connection-route"]', "serial"); await p.click('[data-testid="connection-toggle"]');
  check("legacy detected", await waitFor(p, () => /旧固件/.test(document.getElementById("stFw").textContent), 6000), await txt(p, "stFw"));
  await p.click('#views button[data-view="cfg"]');
  check("settings disabled + warn banner", (await p.$eval("#btnSave", (e) => e.disabled)) && (await p.$eval("#btnApplyId", (e) => e.disabled)) && /无参数设置/.test(await txt(p, "cfgBanner")), await txt(p, "cfgBanner"));
  check("legacy: overlimit hidden", (await p.$eval("#olFields", (e) => e.classList.contains("hidden"))) && /需 3\.1\.0/.test(await txt(p, "olNote")), await txt(p, "olNote"));
  check("legacy JustFloat still charted", Number((await txt(p, "stSerFrames")).match(/累计 (\d+)/)?.[1] ?? 0) > 20, await txt(p, "stSerFrames"));
  if (shotDir) await p.screenshot({ path: shotDir + "/after-dr4310-serial-legacy.png", fullPage: false });
  const before = (await writes(p)).length;
  await p.click('#views button[data-view="debug"]').then(() => p.click('button[data-tab="uart"]'));
  await p.click('button[data-u="RUN"]');
  check("legacy VOFA command still sent", await waitFor(p, (n) => window.__writes.map((w) => w.trim()).filter((w) => w && w !== "PING" && w !== "INFO").length > n, 2000, before));
  const polls = await p.evaluate(() => window.__writes.filter((w) => w === "PING\n").length);
  check("no heartbeat spam to old firmware (only the connect handshake PING)", polls <= 1, String(polls));
  await p.click("#estop");
  check("legacy estop → STOP", await waitFor(p, () => window.__writes.includes("STOP\n")));
  check("legacy no page errors", errs.length === 0, errs.join(" | "));
  await p.close();
}
console.log(results.join("\n"));
console.log(results.filter((r) => r.startsWith("FAIL")).length ? "SOME FAILED" : "ALL PASSED");
await b.close();
