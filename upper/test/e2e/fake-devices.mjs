// Fake Web Serial firmware (legacy / v2 / v3) and fake PCAN-USB (WebUSB) for puppeteer e2e.
// Injected with page.evaluateOnNewDocument(installFakeSerial, mode) / (installFakePcan, opts).

export function installFakeSerial(mode) {
  window.__writes = [];
  const enc = new TextEncoder();
  const vff = mode === "v3-vff";
  const v3 = mode === "v3" || vff;
  const META = [["CAN_ID",1,7,1,1],["BOOT_MODE",0,3,1,1],["BOOT_TARGET",-500,500,0,1],["BOOT_AE",0,1,1,1],["TELEM",0,1,1,0],["TIMEOUT_MS",0,60000,1,0],
    ["CUR_KP",0,100,0,0],["CUR_KI",0,100000,0,0],["CUR_VLIM",0,30,0,0],["IQ_LIM",0,2.5,0,0],["SPD_KP",0,10,0,0],["SPD_KI",0,5,0,0],["SPD_KD",0,1,0,0],
    ["ACCEL",0,100000,0,0],["POS_KP",0,200,0,0],["POS_KI",0,100,0,0],["POS_KD",0,100,0,0],["POS_ISEP",0,100,0,0],["POS_VLIM",0,500,0,0],["MIT_KP",0,500,0,0],["MIT_KD",0,5,0,0]];
  const DEF = {CAN_ID:2,BOOT_MODE:0,BOOT_TARGET:0,BOOT_AE:0,TELEM:1,TIMEOUT_MS:0,CUR_KP:12,CUR_KI:1500,CUR_VLIM:0,IQ_LIM:2.5,SPD_KP:0.25,SPD_KI:0.02,SPD_KD:0,ACCEL:0,POS_KP:3.5,POS_KI:1.2,POS_KD:2.6,POS_ISEP:0.35,POS_VLIM:100,MIT_KP:10,MIT_KD:0.5};
  if (v3) {
    // Ranges / defaults exactly as Grok Build's v3.0.0 firmware (device_config.c); FOO_BAR is a deliberate
    // extra key to exercise the host's "unknown key → 其他" path.
    META.push(["POLE_PAIRS",1,40,1,1],["GEAR_RATIO",1,100,1,0],["KT",0,10,0,0],["RS",0,20,0,0],["LS",0,1,0,0],["ENC_DIR",0,1,1,1],
      ["VBUS_MIN",0,48,0,0],["VBUS_MAX",8,60,0,0],["ZERO_OFFSET",-100000,100000,0,0],["CAN_BAUD",125000,1000000,1,1,"125000|250000|500000|1000000"],
      ["SPD_RAMP_MS",0,60000,1,0],["POS_RAMP_MS",0,60000,1,0],["CUR_RAMP_MS",0,60000,1,0],["FOO_BAR",0,9,1,0]);
    Object.assign(DEF, {POLE_PAIRS:14,GEAR_RATIO:10,KT:0.06,RS:1.97,LS:0.005,ENC_DIR:1,ZERO_OFFSET:0,VBUS_MIN:9,VBUS_MAX:30,CAN_BAUD:1000000,SPD_RAMP_MS:250,POS_RAMP_MS:400,CUR_RAMP_MS:0,FOO_BAR:3});
  }
  if (vff) {
    META.push(["POS_VFF",0,1,0,0]);
    DEF.POS_VFF = 1;
  }
  // v3 firmware telemetry catalogue (TLIST): names only; slots 0..15 are the historical VOFA frame.
  const CAT = ["IdRef","Id","IqRef","Iq","VdUnsat","VqUnsat","VdSat","VqSat","Vbus","Vsat","Omega","DutyA","DutyB","DutyC","CurKp","CurKi",
    "Ia","Ib","Ic","Vd","Vq","Rpm","PosRad","ElecAngle","Power","IqLimit","Fault","Mode"].map((n, i) => ({ i, n }));
  const dev = { flash: null, ram: { ...DEF }, activeId: 2, mode: 0, ae: 0, seq: 0, up0: Date.now(), alive: true, latched: v3 ? 0x40 : 0, cfg: "default", rx: "",
    rpm: 0, tgt: 0, pos: 1.25, iq: 0, active: [...Array(16).keys()], hz: 100, snap: null };
  window.__dev = dev;
  const out = [];
  const send = (s) => { if (mode !== "legacy" && dev.alive) out.push(enc.encode(s)); };
  const fmt = (v) => String(Number(v.toPrecision(6)));
  const MODES = ["IDLE","CURRENT","SPEED","POSITION","MIT"];
  const HELP2 = "STOP RUN ZERO CLEAR CALIB IQ KP KI CUR SPD POS MIT MODE AE TELEM PING INFO GET SET SAVE DEFAULTS RELOAD REBOOT";
  const reply = (line) => {
    const t = line.trim().toUpperCase().split(/[\s=,]+/).filter(Boolean);
    if (!t.length) return;
    const c = t[0], a = t.slice(1);
    const idle = dev.mode === 0 && dev.ae === 0;
    const ok = (d) => send(`@OK ${c}${d ? " " + d : ""}\n`);
    const err = (d) => send(`@ERR ${c} ${d}\n`);
    const P = (k) => { const m = META.find((x) => x[0] === k); send(`@P ${k}=${fmt(dev.ram[k])} min=${m[1]} max=${m[2]}${m[4] ? " reboot=1" : ""}${m[5] ? " choices=" + m[5] : ""}\n`); };
    const chNames = () => dev.active.map((i) => CAT[i].n).join(",");
    switch (c) {
      case "PING": send(`@PONG up=${Date.now() - dev.up0}\n`); return;
      case "HELP": ok(HELP2 + (v3 ? " SETZERO TLIST TCH TRATE FAULT" : "")); return;
      case "INFO": send(`@INFO fw=DR4310 ver=${vff ? "3.2.0" : v3 ? "3.0.1" : "2.0.0"} id=${dev.activeId} cfg_id=${dev.ram.CAN_ID} mode=${dev.mode} run=${MODES[dev.mode]} drv=${dev.mode ? 1 : 0} ae=${dev.ae} telem=${dev.ram.TELEM} fault=0x0000 latched=0x${dev.latched.toString(16).padStart(4,"0")} vbus=12.1 calib=1 zero=0.12578 dir=1 cfg=${dev.cfg} seq=${dev.seq} timeout=${dev.ram.TIMEOUT_MS} trips=0 drops=0 up=${Date.now() - dev.up0}${v3 ? ` pp=${dev.ram.POLE_PAIRS} baud=${dev.ram.CAN_BAUD} zoff=${fmt(dev.ram.ZERO_OFFSET)} zset=${dev.ram.ZERO_OFFSET ? 1 : 0} zturn=1 can_fb=0` : ""}\n`); return;
      // real firmware: UART STOP is a real stop and also clears runtime AE (only CAN Disable/E-stop are ignored while AE=1)
      case "STOP": case "IDLE": case "ESTOP": dev.mode = 0; dev.ae = 0; dev.tgt = 0; send("@OK STOP\n"); return;
      case "MODE": dev.mode = Number(a[0]); ok(`mode=${MODES[dev.mode]}`); return;
      case "CUR": dev.mode = 1; dev.tgt = Math.max(-2.5, Math.min(2.5, Number(a[0]))); ok(`iq=${fmt(dev.tgt)}`); return;
      case "SPD": dev.mode = 2; dev.tgt = Number(a[0]); ok(`rpm=${fmt(dev.tgt)}`); return;
      case "POS": dev.mode = 3; dev.tgt = Number(a[0]); ok(`rad=${fmt(dev.tgt)}`); return;
      case "MIT": if (a.length !== 5) return err("usage MIT p v kp kd iq"); dev.mode = 4; dev.tgt = Number(a[0]); ok(); return;
      case "ZERO": ok(); return;
      case "CLEAR": dev.latched = 0; ok("latched=0x0000"); return;
      case "AE": dev.ae = Number(a[0]) ? 1 : 0; if (dev.ae && !dev.mode) dev.mode = 2; if (!dev.muteAe) ok(`ae=${dev.ae}`); return;
      case "TELEM": dev.ram.TELEM = Number(a[0]) ? 1 : 0; ok(`telem=${dev.ram.TELEM}`); return;
      case "GET": {
        if (!a.length) { META.forEach((m) => P(m[0])); ok(String(META.length)); return; }
        if (!META.find((m) => m[0] === a[0])) return err("unknown_key"); P(a[0]); ok("1"); return;
      }
      case "SET": {
        if (a.length !== 2) return err("usage SET KEY VALUE");
        const m = META.find((x) => x[0] === a[0]); if (!m) return err("unknown_key");
        const v = Number(a[1]); if (!Number.isFinite(v)) return err("bad_value");
        if (v < m[1] || v > m[2] || (m[3] && !Number.isInteger(v))) return err(`range ${m[0]} ${m[1]}..${m[2]}`);
        dev.ram[m[0]] = v; ok(`${m[0]}=${fmt(v)}${m[4] ? " reboot=1" : ""}`); return;
      }
      case "SAVE": if (!idle) return err("not_idle"); dev.flash = { ...dev.ram }; dev.seq++; dev.cfg = "flash"; ok(`seq=${dev.seq}`); return;
      case "DEFAULTS": if (v3 && !idle) return err("not_idle"); dev.ram = { ...DEF }; ok("ram_only"); return;
      case "RELOAD": if (v3 && !idle) return err("not_idle"); dev.ram = { ...(dev.flash ?? DEF) }; ok(`cfg=${dev.cfg}`); return;
      case "REBOOT": if (!idle) return err("not_idle"); ok(); setTimeout(() => { dev.alive = false; }, 5);
        setTimeout(() => { dev.ram = { ...(dev.flash ?? DEF) }; dev.activeId = dev.ram.CAN_ID; dev.mode = 0; dev.up0 = Date.now(); dev.alive = true; }, 400); return;
      case "CALIB": if (!idle) return err("not_idle"); ok("started"); setTimeout(() => send("@OK CALIB done saved\n"), 300); return;
    }
    if (v3) switch (c) {
      // Real v3.0.0 formats (control_app.cpp): TLIST / TCH query / FAULT answer ONE line and no @OK.
      case "TLIST": send(`@TLIST ${CAT.map((x) => x.n).join(",")}\n`); return;
      case "TCH": {
        if (!a.length) { send(`@TCH ${chNames()}\n`); return; }
        if (a.length !== 16) return err("usage TCH ch0,ch1,...,ch15");
        const idx = a.map((n) => CAT.findIndex((x) => x.n.toUpperCase() === n));
        if (idx.some((i) => i < 0)) return err("unknown_channel");
        dev.active = idx; ok(); return;
      }
      case "TRATE": {
        if (a.length) { const hz = Number(a[0]); if (!Number.isInteger(hz) || hz < 0) return err("bad_value"); if (hz > 142) return err("bandwidth max=135"); dev.hz = hz; }
        ok(`hz=${dev.hz} period_ms=${dev.hz ? Math.max(1, Math.floor(1000 / dev.hz)) : 0}`); return;
      }
      case "FAULT": {
        if (dev.latched && !dev.snap) dev.snap = { t: Date.now() - dev.up0, w: dev.latched, iq: dev.iq, mode: dev.mode };
        const sn = dev.snap ?? { t: 0, w: 0, iq: 0, mode: 0 };
        send(`@FAULT active=0x0000 latched=0x${dev.latched.toString(16).padStart(4, "0")} snap=${dev.snap ? 1 : 0} t=${sn.t} fault=0x${sn.w.toString(16).padStart(4, "0")} pos=1.25 omega=0 iq=${fmt(sn.iq)} vbus=8.7 mode=${sn.mode}\n`); return;
      }
      case "SETZERO": if (!idle) return err("not_idle"); dev.ram.ZERO_OFFSET = Number((((dev.pos % 6.283185307) + 6.283185307) % 6.283185307).toFixed(4)); dev.pos = 0; ok(`zero=${fmt(dev.ram.ZERO_OFFSET)} saved=0`); return;
    }
    err("unknown");
  };
  const port = {
    readable: new ReadableStream({ start(ctl) { let t = 0;
      const push = (c) => { try { ctl.enqueue(c); } catch { /* stream closed by host (disconnect) */ } };
      window.__injectSerial = (line) => push(enc.encode(line + "\n"));
      setInterval(() => {
        // simple plant
        if (dev.mode === 2) dev.rpm += (dev.tgt - dev.rpm) * 0.2; else dev.rpm *= 0.8;
        if (dev.mode === 3 || dev.mode === 4) dev.pos += (dev.tgt - dev.pos) * 0.1; else dev.pos += dev.rpm * Math.PI / 30 * 0.01;
        dev.iq = dev.mode === 1 ? dev.tgt : dev.mode ? 0.05 + (dev.tgt - dev.rpm) * 0.002 : 0;
        const parts = [...out.splice(0)];
        if (dev.alive && (mode === "legacy" || dev.ram.TELEM)) {
          let vals;
          if (v3) {
            const w = dev.rpm * Math.PI / 30, vq = 1.5 + dev.rpm * 0.01;
            const all = { IdRef: 0, Id: 0.01, IqRef: dev.iq, Iq: dev.iq, VdUnsat: -0.2, VqUnsat: vq, VdSat: -0.2, VqSat: vq, Vbus: 12.3, Vsat: 0, Omega: w,
              DutyA: 0.5, DutyB: 0.5, DutyC: 0.5, CurKp: 12, CurKi: 1500, Ia: dev.iq, Ib: -dev.iq / 2, Ic: -dev.iq / 2, Vd: -0.2, Vq: vq, Rpm: dev.rpm,
              PosRad: dev.pos, ElecAngle: (t % 628) / 100, Power: 1.5 * (-0.2 * 0.01 + vq * dev.iq), IqLimit: 2.5, Fault: dev.latched, Mode: dev.mode };
            vals = dev.active.map((i) => all[CAT[i].n]);
          } else {
            vals = Array.from({ length: 16 }, (_, k) => Math.sin(t / 50 + k) * 0.1);
            vals[3] = dev.iq; vals[1] = 0.01; vals[6] = -0.2; vals[7] = 1.5; vals[8] = 12.1; vals[10] = dev.rpm * Math.PI / 30;
          }
          t++;
          const f = new Uint8Array(vals.length * 4 + 4); const dv = new DataView(f.buffer); vals.forEach((v, k) => dv.setFloat32(k * 4, v, true)); f.set([0, 0, 0x80, 0x7f], vals.length * 4);
          parts.splice(Math.floor(Math.random() * (parts.length + 1)), 0, f);
        }
        if (!parts.length) return;
        const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of parts) { all.set(x, o); o += x.length; }
        let i = 0; while (i < all.length) { const n = 1 + Math.floor(Math.random() * 40); push(all.slice(i, i + n)); i += n; }
      }, 10); } }),
    writable: new WritableStream({ write(ch) {
      const s = new TextDecoder().decode(ch); window.__writes.push(s);
      dev.rx += s; let k; while ((k = dev.rx.indexOf("\n")) >= 0) { const line = dev.rx.slice(0, k); dev.rx = dev.rx.slice(k + 1); if (dev.alive) reply(line); }
    } }),
    open: async () => {}, close: async () => {},
  };
  const ser = new EventTarget(); ser.requestPort = async () => port; ser.getPorts = async () => (window.__grantedSerial ? [port] : []);
  Object.defineProperty(navigator, "serial", { value: ser });
  // capture downloads (anchor.click on blob URLs)
  window.__dl = [];
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && this.href.startsWith("blob:")) { const name = this.download; fetch(this.href).then((r) => r.text()).then((t) => window.__dl.push({ name, text: t })); return; }
    return origClick.call(this);
  };
}

export function installFakePcan(opts) {
  window.__tx = [];
  const nodes = opts?.nodes ?? [{ id: 1, mode: 1, faults: 0x42, primary: 0.123 }, { id: 3, mode: 0, faults: 0, primary: 12.4 }, { id: 5, mode: 2, faults: 0, primary: 88 }];
  window.__canNodes = nodes;
  let n = 0;
  const rec = (id, data, first) => { const r = [(first ? 0x80 : 0) | 8, ((id << 5) & 0xff), (id << 5) >> 8]; if (first) r.push(n & 0xff, (n >> 8) & 0xff); else r.push(n & 0xff); return r.concat(Array.from(data)); };
  const fb = () => { const d = new Uint8Array(8); const dv = new DataView(d.buffer); dv.setUint16(0, (n * 7) % 8192); dv.setInt16(2, Math.round(200 * Math.sin(n / 300))); dv.setInt16(4, Math.round(0.3 * Math.sin(n / 150) * 16384 / 3)); d[6] = 0xff; return d; };
  const st = (x) => { const d = new Uint8Array(8); const dv = new DataView(d.buffer); d[0] = x.mode; d[1] = x.faults; dv.setFloat32(2, x.primary, true); dv.setInt16(6, x.mode === 2 ? 883 : 0, true); return d; };
  const dev = {
    vendorId: 0x0c72, productId: 0x000c, opened: false, configuration: null, productName: "PCAN-USB (fake)",
    async open() { this.opened = true; }, async close() { this.opened = false; },
    async selectConfiguration() { this.configuration = { interfaces: [{ interfaceNumber: 0, alternates: [{ endpoints: [
      { endpointNumber: 1, direction: "out" }, { endpointNumber: 1, direction: "in" }, { endpointNumber: 2, direction: "out" }, { endpointNumber: 2, direction: "in" }] }] }] }; },
    async claimInterface() {}, async releaseInterface() {},
    async transferOut(ep, data) {
      const u = new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength);
      if (ep === 2) {
        if (window.__canDelay) await new Promise((r) => setTimeout(r, window.__canDelay));
        window.__tx.push(Array.from(u));
        if (opts?.respondToTx) {
          const id = (u[3] | u[4] << 8) >> 5, node = nodes.find((x) => x.id === (id & 0x7f));
          if (node) {
            if (id >= 0x400 && id < 0x600) { node.mode = id >= 0x500 ? 3 : 2; node.primary = id >= 0x500 ? -500 + (u[5] | u[6] << 8) / 65535 * 1000 : -1000 + (u[5] | u[6] << 8) / 65535 * 2000; }
            else if (id >= 0x100 && id < 0x180) {
              if (u[5] === 8) node.ae = u[6] ? 1 : 0;
              else if ((u[5] === 0 || u[5] === 3) && !node.ae) { node.mode = 0; node.primary = 12.4; }
              else if (u[5] === 1) { node.mode = 1; node.primary = new DataView(u.buffer, u.byteOffset).getFloat32(7, true); }
              else if (u[5] === 6) { node.mode = 4; node.primary = 1.25; }
            }
          }
        }
      }
      return { status: "ok", bytesWritten: u.length };
    },
    async transferIn(ep) {
      if (ep === 1 || ep === 0x81) { const r = new Uint8Array(16); r[2] = 0x78; r[3] = 0x56; r[4] = 0x34; r[5] = 0x12; return { status: "ok", data: new DataView(r.buffer) }; }
      await new Promise((r) => setTimeout(r, 4));
      if (window.__canReceive === false) return { status: "ok", data: new DataView(new ArrayBuffer(64)) };
      const recs = []; let cnt = 0;
      const add = (id, d) => { const r = rec(id, d, cnt === 0); if (recs.length + r.length > 62) return false; recs.push(...r); cnt++; return true; };
      window.__stPending = window.__stPending ?? [];
      for (let k = 0; k < 3; k++) {
        n++;
        if (n % 100 === 0) window.__stPending.push(...nodes);
        while (window.__stPending.length && add(0x180 + window.__stPending[0].id, st(window.__stPending[0]))) window.__stPending.shift();
        add(0x205, fb());
      }
      const buf = new Uint8Array(64); buf[0] = 0; buf[1] = cnt; buf.set(recs.slice(0, 62), 2);
      return { status: "ok", data: new DataView(buf.buffer) };
    },
  };
  const usb = new EventTarget(); usb.requestDevice = async () => dev; usb.getDevices = async () => [dev];
  Object.defineProperty(navigator, "usb", { value: usb });
}
