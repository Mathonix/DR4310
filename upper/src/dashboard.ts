/**
 * 仪表盘 (home view), modelled on 电机精灵: mode tabs 速度 / 力矩(电流) / 位置 / MIT, a dial gauge
 * with target + measured needles (click / drag sets the target), adjacent 启动/停止, status icon,
 * key readings and folded charts, host ramps (指令时间) and a waveform generator.
 * Works over CAN (0x400 / 0x101 / 0x500 / MIT on 0x100+ID) or serial (SPD / CUR / POS / MIT lines).
 */
import { Gauge, fmtNum, type PickPhase } from "./gauge";
import { StripChart, PALETTE } from "./chart";
import { Ramp, capWave, torqueNm, waveValue, type Display, type Wave } from "./features";
import { LIMITS, MIT_RANGE, clamp } from "./protocol";
import { cmd as uartCmd } from "./uartcfg-protocol";
import { readObject } from "./storage";

export type DMode = "spd" | "cur" | "pos" | "mit";
export type Route = "can" | "serial" | "legacy" | null;
export type Meas = {
  fresh: boolean; mode: number | null; faults: number; rpm: number; pos: number; iq: number; vbus: number;
  power: number; powerSrc: string; src: string;
};
export type DashHost = {
  route(pref: "auto" | "can" | "serial"): Route;
  sendCanTarget(mode: DMode, v: number, mit: { v: number; kp: number; kd: number; t: number }, first: boolean, valid: () => boolean): Promise<boolean>;
  serialLine(line: string, note: string): Promise<boolean>;
  serialRaw(line: string, note: string): Promise<boolean>;
  stopAll(reason: string): Promise<void>;
  stopOthers(): void;
  meas(route?: Route): Meas;
  fwRamp(mode: DMode): number | null;
  fwKt(): number | null;
  vbusMax(): number | null;
  canSetZero(): boolean;
  setZero(): Promise<void>;
  preparePosition?(valid: () => boolean): Promise<boolean>;
  clearFaults(): Promise<void>;
  toast(text: string, kind?: "" | "ok" | "err"): void;
  confirmOn(): boolean;
  registerChart(id: string, c: StripChart): void;
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const MODES: Record<DMode, { name: string; dev: number; ranges: number[]; def: number; unit: string; dec: number }> = {
  spd: { name: "速度", dev: 2, ranges: [50, 100, 200, 300, 500, 1000], def: 200, unit: "rpm", dec: 1 },
  cur: { name: "力矩", dev: 1, ranges: [0.3, 0.5, 1, 2, 2.5], def: 0.5, unit: "A", dec: 3 },
  pos: { name: "位置", dev: 3, ranges: [Math.PI, 2 * Math.PI, 4 * Math.PI, 10 * Math.PI, 20 * Math.PI, 500], def: 2 * Math.PI, unit: "rad", dec: 3 },
  mit: { name: "MIT", dev: 4, ranges: [Math.PI, 2 * Math.PI, 4 * Math.PI, 12.5, 50], def: 2 * Math.PI, unit: "rad", dec: 3 },
};
const HARD: Record<DMode, number> = { spd: LIMITS.speedRpm, cur: LIMITS.currentA, pos: LIMITS.positionRad, mit: MIT_RANGE.p[1] };
const FMAX: Record<DMode, number> = { spd: 5, cur: 5, pos: 2, mit: 2 };
const STORE = "dr4310.host";

// Direct-drive motor: no gear ratio / output-shaft setting (old "gear"/"output" keys are dropped on next save).
export type HostSettings = { kt: number; ramp: Record<DMode, number>; link: "auto" | "can" | "serial" };
const DEF_HOST: HostSettings = { kt: 0, ramp: { spd: 300, cur: 200, pos: 500, mit: 500 }, link: "auto" };
export function loadHost(): HostSettings {
  const o = readObject(STORE);
  const n = (v: unknown, lo: number, hi: number, fallback: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
  const ramp = { ...DEF_HOST.ramp };
  if (o.ramp && typeof o.ramp === "object") for (const m of Object.keys(ramp) as DMode[]) ramp[m] = n((o.ramp as Record<string, unknown>)[m], 0, 60000, ramp[m]);
  return { kt: n(o.kt, 0, 10, DEF_HOST.kt),
    link: o.link === "can" || o.link === "serial" ? o.link : "auto", ramp };
}

export function createDashboard(h: DashHost) {
  const hs = loadHost();
  let mode: DMode = "spd";
  let running = false;
  let starting = false;
  let runRoute: Route = null;
  let startedAt = 0;
  let idleSince = 0;
  const range: Record<DMode, number> = { spd: MODES.spd.def, cur: MODES.cur.def, pos: MODES.pos.def, mit: MODES.mit.def };
  const target: Record<DMode, number> = { spd: 0, cur: 0, pos: 0, mit: 0 }; // command units (rotor side)
  const targetEdited: Record<DMode, boolean> = { spd: false, cur: false, pos: false, mit: false };
  const ramp = new Ramp();
  let lastSentV: number | null = null;
  let lastSendT = 0;
  let sending = false;
  let session = 0;
  let lastMit = "";
  let displayKey = "";
  let sentCount = 0;
  const wave = { on: false, kind: "sine" as Wave, amp: 0, off: 0, freq: 0, t0: 0 };
  let gauge!: Gauge;
  let chart!: StripChart, chart2!: StripChart;
  const SER = { tgt: 0, mes: 0, iq: 0, pw: 0, vb: 0 };

  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(hs)); } catch { /* ignore */ } };
  save(); // rewrite once so legacy gear/output keys are removed from storage
  const ktEff = () => { const v = h.fwKt(); return v !== null && v >= 0 && v <= 10 ? v : hs.kt; };
  const disp = (): Display => ({ kt: ktEff() });
  /** command units → display units for the given mode */
  function toDisp(m: DMode, v: number): number {
    const d = disp();
    return m === "cur" && d.kt > 0 ? torqueNm(v, d) : v;
  }
  function fromDisp(m: DMode, v: number): number {
    const d = disp();
    return m === "cur" && d.kt > 0 ? v / d.kt : v;
  }
  function unit(m: DMode): string {
    const d = disp();
    if (m === "cur") return d.kt > 0 ? "N·m" : "A";
    return MODES[m].unit;
  }
  const decs = (m: DMode) => (m === "cur" ? 3 : m === "spd" ? 1 : 3);

  function rampMs(m: DMode): number { return h.fwRamp(m) !== null ? 0 : Math.max(0, hs.ramp[m] || 0); }
  function setGaugeRange(): void {
    const r = range[mode];
    gauge.setRange(toDisp(mode, -r), toDisp(mode, r), unit(mode), decs(mode));
    if (toDisp(mode, -r) > toDisp(mode, r)) gauge.setRange(toDisp(mode, r), toDisp(mode, -r), unit(mode), decs(mode));
    gauge.setTarget(toDisp(mode, target[mode]));
    $("dRangeSel").innerHTML = MODES[mode].ranges.map((x) => `<option value="${x}"${x === r ? " selected" : ""}>±${fmtNum(Math.abs(toDisp(mode, x)), x < 10 ? 2 : 0)} ${unit(mode)}</option>`).join("");
    $("dTgtUnit").textContent = unit(mode);
    const t2 = $<HTMLInputElement>("dTarget");
    if (document.activeElement !== t2) t2.value = fmtNum(toDisp(mode, target[mode]), decs(mode));
    $("wUnit").textContent = unit(mode);
    chart.markDirty();
  }

  // ---------- target / ramp ----------
  function currentCmd(now: number): number {
    if (wave.on) return clamp(waveValue(wave.kind, (now - wave.t0) / 1000, wave.amp, wave.off, wave.freq), -Math.min(range[mode], HARD[mode]), Math.min(range[mode], HARD[mode]));
    return ramp.value(now);
  }
  function setTarget(v: number, why: "pick" | "input" | "start" = "input"): void {
    if (why === "pick") targetEdited[mode] = true;
    const r = range[mode];
    const tv = clamp(v, -Math.min(r, HARD[mode]), Math.min(r, HARD[mode]));
    target[mode] = tv;
    gauge.setTarget(toDisp(mode, tv));
    const inp = $<HTMLInputElement>("dTarget");
    if (document.activeElement !== inp || why !== "input") inp.value = fmtNum(toDisp(mode, tv), decs(mode));
    if (running && !wave.on) {
      const now = performance.now();
      ramp.start(lastSentV ?? currentCmd(now), tv, rampMs(mode), now);
    }
  }
  function onPick(dv: number, phase: PickPhase): void {
    if (wave.on) { if (phase === "start") h.toast("波形发生器运行中，先停止波形再拖动目标"); return; }
    setTarget(fromDisp(mode, dv), "pick");
  }

  // ---------- send ----------
  function mitParams() {
    return {
      v: clamp(Number($<HTMLInputElement>("dMitV").value) || 0, MIT_RANGE.v[0], MIT_RANGE.v[1]),
      kp: clamp(Number($<HTMLInputElement>("dMitKp").value) || 0, MIT_RANGE.kp[0], MIT_RANGE.kp[1]),
      kd: clamp(Number($<HTMLInputElement>("dMitKd").value) || 0, MIT_RANGE.kd[0], MIT_RANGE.kd[1]),
      t: clamp(Number($<HTMLInputElement>("dMitT").value) || 0, MIT_RANGE.t[0], MIT_RANGE.t[1]),
    };
  }
  async function sendValue(v: number, first = false, token = session): Promise<boolean> {
    const rt = runRoute;
    const valid = () => token === session && running;
    if (!valid()) return false;
    const note = `仪表盘 ${MODES[mode].name}`;
    let ok = false;
    const mp = mitParams();
    if (rt === "can") ok = await h.sendCanTarget(mode, v, mp, first, valid);
    else if (rt === "serial") {
      let line: string;
      if (mode === "spd") line = uartCmd("SPD", clamp(v, -LIMITS.speedRpm, LIMITS.speedRpm));
      else if (mode === "cur") line = uartCmd("CUR", clamp(v, -LIMITS.currentA, LIMITS.currentA));
      else if (mode === "pos") line = uartCmd("POS", clamp(v, -LIMITS.positionRad, LIMITS.positionRad));
      else { const m = mitParams(); line = uartCmd("MIT", clamp(v, MIT_RANGE.p[0], MIT_RANGE.p[1]), m.v, m.kp, m.kd, m.t); }
      ok = await h.serialLine(line, note);
    } else if (rt === "legacy") {
      if (first && (!(await h.serialRaw("RUN\n", "仪表盘 · 电流环")) || !valid())) return false;
      ok = await h.serialRaw(`IQ ${String(+clamp(v, -LIMITS.currentA, LIMITS.currentA).toPrecision(6))}\n`, note);
    }
    if (ok && valid()) { lastSentV = v; lastMit = JSON.stringify(mp); sentCount++; }
    if (!valid()) return false;
    return ok;
  }
  async function tick(): Promise<void> {
    if (!running) return;
    const now = performance.now();
    if (h.route(hs.link) !== runRoute) { await halt("链路已断开 / 切换", true); return; }
    const m = h.meas(runRoute);
    if (!m.fresh && now - startedAt > 1500) { await halt("反馈中断，已停止", true); return; }
    // device stopped by itself (timeout, fault, other host): stop driving it
    if (m.fresh && m.mode !== null && now - startedAt > 1200) {
      if (m.mode === 0) { if (!idleSince) idleSince = now; else if (now - idleSince > 800) { await halt("电机已回到空闲（超时 / 故障 / 其他主机）", false); return; } }
      else idleSince = 0;
    }
    if (m.fresh && m.faults) { await halt(`检测到故障 0x${m.faults.toString(16)}，已停止`, true); return; }
    if (sending) return;
    const period = runRoute === "can" ? 20 : 50;
    const v = currentCmd(now);
    const moving = wave.on || ramp.active;
    if (now - lastSendT < period) return;
    if (!moving && lastSentV !== null && v === lastSentV && (mode !== "mit" || JSON.stringify(mitParams()) === lastMit)) {
      // CAN position/speed frames are one-shot; keep serial TIMEOUT_MS fed by the heartbeat
      return;
    }
    sending = true; lastSendT = now;
    const token = session;
    try { if (!(await sendValue(v, false, token)) && token === session) await halt("发送失败，已停止", true); }
    catch { if (token === session) await halt("发送失败，已停止", true); }
    finally { if (token === session) sending = false; }
  }

  // ---------- start / stop ----------
  async function start(): Promise<void> {
    if (running || starting) return;
    if (!applyInput(false)) return;
    const rt = h.route(hs.link);
    if (!rt) { h.toast(hs.link === "can" ? "PCAN 未连接" : hs.link === "serial" ? "串口未连接或固件未识别" : "没有可用链路：请先连接 PCAN 或串口", "err"); return; }
    if (rt === "legacy" && mode !== "cur") { h.toast("旧固件串口只支持电流（力矩）模式", "err"); return; }
    const token = ++session;
    const startMode = mode;
    starting = true;
    renderControls();
    const valid = () => token === session && starting && mode === startMode && h.route(hs.link) === rt;
    try {
      if (rt === "serial" && (mode === "pos" || mode === "mit") && h.preparePosition) {
        if (!(await h.preparePosition(valid)) || !valid()) return;
      }
      if (!valid()) return;
      const m = h.meas(rt);
      if (m.fresh && m.faults) { h.toast(`电机有故障 0x${m.faults.toString(16)}，请先清除`, "err"); return; }
      if (mode === "cur" && h.confirmOn() && !confirm(`力矩（电流）模式不限转速，空载会持续加速。\n确认电机已固定，目标 ${fmtNum(target.cur, 3)} A，启动？`)) return;
      if (mode === "pos" || mode === "mit") {
        if (m.fresh && Number.isFinite(m.pos)) {
          // The initial hold position must fit the dial without changing the requested destination.
          if (Math.abs(m.pos) > HARD[mode]) { h.toast(`当前位置 ${fmtNum(m.pos, 2)} rad 超出${MODES[mode].name}模式范围 ±${HARD[mode]}`, "err"); return; }
          if (Math.abs(m.pos) > range[mode]) { range[mode] = MODES[mode].ranges.find(x => x >= Math.abs(m.pos)) ?? HARD[mode]; setGaugeRange(); }
          if (!targetEdited[mode]) setTarget(m.pos, "start");
        }
        else if (h.confirmOn() && !confirm(`未知电机当前位置（需处于位置/MIT 模式，或遥测含 PosRad 通道：参数配置 › 通信）。\n电机将转向目标 ${fmtNum(target[mode], 3)} rad（转子侧）。继续？`)) return;
      }
      h.stopOthers();
      runRoute = rt; running = true; starting = false; startedAt = performance.now(); idleSince = 0; lastSentV = null; sentCount = 0;
      lastMit = "";
      renderControls();
      const from = mode === "spd" || mode === "cur" ? 0 : m.fresh && Number.isFinite(m.pos) ? m.pos : target[mode];
      ramp.start(from, target[mode], rampMs(mode), performance.now());
      sending = true;
      try {
        if (!(await sendValue(ramp.value(performance.now()), true, token))) {
          if (token === session) await halt("启动失败，已停止", true);
          return;
        }
        if (token !== session) return;
        lastSendT = performance.now();
      } finally { if (token === session) sending = false; }
      h.toast(`已启动 · ${MODES[mode].name}模式 · ${rt === "can" ? "CAN" : "串口"}${rampMs(mode) ? ` · 指令时间 ${rampMs(mode)} ms` : h.fwRamp(mode) !== null ? " · 固件斜坡" : ""}`, "ok");
    } catch { if (token === session) await halt("启动失败，已停止", true); }
    finally { if (token === session) { starting = false; renderControls(); } }
  }
  /** Stop driving without commands (E-stop / watchdog already sent theirs). */
  function halt(reason: string, sendStop: boolean): Promise<void> {
    const was = running || starting || wave.on;
    session++; sending = false;
    running = false; starting = false; wave.on = false; ramp.stop(); runRoute = null;
    renderControls();
    if (was && reason) h.toast(reason, "err");
    return sendStop && was ? h.stopAll(reason) : Promise.resolve();
  }
  async function stop(): Promise<void> {
    session++; sending = false;
    running = false; starting = false; wave.on = false; ramp.stop(); runRoute = null;
    renderControls();
    await h.stopAll("仪表盘停止");
    h.toast("已发送停机", "ok");
  }

  // ---------- waveform ----------
  function startWave(): void {
    if (!running) { h.toast("请先点「启动」再开始波形", "err"); return; }
    const lim = Math.abs(toDisp(mode, Math.min(range[mode], HARD[mode])));
    const c = capWave(Number($<HTMLInputElement>("wAmp").value), Number($<HTMLInputElement>("wOff").value), Number($<HTMLInputElement>("wFreq").value), lim, FMAX[mode]);
    $<HTMLInputElement>("wAmp").value = String(+c.amp.toPrecision(4));
    $<HTMLInputElement>("wOff").value = String(+c.offset.toPrecision(4));
    $<HTMLInputElement>("wFreq").value = String(+c.freq.toPrecision(4));
    if (c.amp <= 0) { h.toast("幅值为 0，请减小偏置", "err"); return; }
    Object.assign(wave, { on: true, kind: $<HTMLSelectElement>("wKind").value as Wave, amp: Math.abs(fromDisp(mode, c.amp)), off: fromDisp(mode, c.offset), freq: c.freq, t0: performance.now() });
    ramp.stop();
    if (c.capped) h.toast(`参数已按安全上限修正（|偏置|+幅值 ≤ ${fmtNum(lim, 3)} ${unit(mode)}，频率 ≤ ${FMAX[mode]} Hz）`);
    renderControls();
  }
  function stopWave(): void {
    if (!wave.on) return;
    wave.on = false;
    const now = performance.now();
    if (running) ramp.start(lastSentV ?? target[mode], target[mode], rampMs(mode), now);
    renderControls();
  }

  // ---------- UI ----------
  function renderControls(): void {
    const btn = $("dStart");
    btn.textContent = running || starting ? "停止" : "启动";
    btn.classList.toggle("run", running || starting);
    btn.setAttribute("aria-pressed", String(running || starting));
    $("wStart").textContent = wave.on ? "停止波形" : "启动波形";
    $("wStart").classList.toggle("danger", wave.on);
    document.querySelectorAll<HTMLButtonElement>("#dModes button").forEach((b) => { b.classList.toggle("active", b.dataset.dmode === mode); b.setAttribute("aria-pressed", String(b.dataset.dmode === mode)); });
    $("dMitRow").classList.toggle("hidden", mode !== "mit");
    $("dGainNote").classList.toggle("hidden", !(mode === "spd" || mode === "pos"));
  }
  function setMode(m: DMode): void {
    if (m === mode) return;
    if (running || starting) void halt(`已停止：切换到${MODES[m].name}模式`, true);
    mode = m;
    chart.clear(); chart2.clear(); lastSentV = null;
    $("dGaugeMode").textContent = MODES[m].name;
    setGaugeRange();
    renderControls();
  }
  function refresh(): void {
    const now = performance.now();
    const rt = running ? runRoute : h.route(hs.link);
    const m = h.meas(rt);
    // status icon
    const st = !m.fresh ? "off" : m.faults ? "err" : (m.mode ?? 0) > 0 || running ? "run" : "idle";
    const stEl = $("dStatus");
    stEl.className = "dstatus " + st;
    stEl.title = "电机反馈状态；启动 / 停止按钮表示上位机控制会话，上电运行时可能尚未建立会话";
    $("dStatusT").textContent = { off: "无反馈", err: "电机故障", run: "电机运行", idle: "电机空闲" }[st];
    $("dFault").textContent = m.fresh && m.faults ? "故障 0x" + m.faults.toString(16).toUpperCase().padStart(4, "0") : "";
    $("dRoute").textContent = rt === "can" ? "CAN" : rt === "serial" ? "串口" : rt === "legacy" ? "旧固件" : "未连接";
    // measured value for the gauge
    let mv = NaN;
    if (m.fresh) {
      if (mode === "spd") mv = toDisp("spd", m.rpm);
      else if (mode === "cur") mv = toDisp("cur", m.iq);
      else mv = toDisp(mode, m.pos);
    }
    gauge.setMeasured(Number.isFinite(mv) ? mv : null);
    if (m.fresh && Number.isFinite(mv)) chart.push(SER.mes, now, mv);
    if (running && lastSentV !== null) chart.push(SER.tgt, now, toDisp(mode, lastSentV));
    if (m.fresh && Number.isFinite(m.iq)) chart2.push(SER.iq, now, m.iq);
    if (m.fresh && Number.isFinite(m.power)) chart2.push(SER.pw, now, m.power);
    if (m.fresh && Number.isFinite(m.vbus)) chart2.push(SER.vb, now, m.vbus);
    $("dCmdNow").textContent = running ? `${fmtNum(toDisp(mode, lastSentV ?? NaN), decs(mode))} ${unit(mode)}${ramp.active ? " · 斜坡" : ""}${wave.on ? " · 波形" : ""}` : "待机";
    $("dCmdNow").title = `已发送 ${sentCount} 帧`;
    // badges
    $("dPower").textContent = Number.isFinite(m.power) && m.fresh ? `${fmtNum(m.power, 2)} W` : "— W";
    $("dPowerSrc").textContent = "";
    $("dPower").title = m.powerSrc ? `功率来源：${m.powerSrc}` : "功率";
    $("dSrc").textContent = m.fresh ? "● 反馈在线" : "○ 无反馈";
    $("dSrc").title = m.src;
    // Key readings: current stays in A, regardless of the target's torque conversion.
    const setReading = (v: number, id: string, dec: number) => { $(id).textContent = m.fresh ? fmtNum(v, dec) : "—"; };
    setReading(m.rpm, "mSpdV", 1);
    setReading(m.iq, "mTrqV", 3);
    const pd = m.pos;
    $("mPosV").textContent = m.fresh ? fmtNum(pd, 3) : "—";
    setReading(m.vbus, "mVbusV", 2);
    $("mSpdU").textContent = "rpm";
    $("mTrqU").textContent = "A";
    $("mPosU").textContent = "rad";
    $("mVbusU").textContent = "V";
    const fr = h.fwRamp(mode);
    $("dRampChip").textContent = fr !== null ? `固件斜坡 ${fr} ms` : rampMs(mode) ? `上位机斜坡 ${rampMs(mode)} ms` : "无斜坡";
    $("dZero").classList.toggle("hidden", !h.canSetZero());
    $("dDisp").textContent = ktEff() > 0 ? `直驱 · Kt ${ktEff()}` : "直驱";
    $("dDisp").title = ktEff() > 0 ? `力矩 = Iq·Kt (${ktEff()} N·m/A)` : "未设置 Kt：电流以 A 显示";
    $("wInfo").textContent = wave.on ? `${wave.freq} Hz` : `≤ ${FMAX[mode]} Hz`;
    $("wInfo").title = "|偏置| + 幅值 ≤ 量程；急停、停止、切模式、掉线、隐藏页面自动停止";
  }

  function renderHostSettings(): void {
    const nextDisplay = JSON.stringify(disp());
    if (displayKey && displayKey !== nextDisplay) { stopWave(); chart.clear(); }
    displayKey = nextDisplay;
    const k = h.fwKt();
    $<HTMLInputElement>("hKt").value = String(k ?? (hs.kt || ""));
    $<HTMLInputElement>("hKt").disabled = k !== null;
    $("hFwNote").textContent = k !== null ? "来源：固件" : "来源：本机";
    $("hFwNote").title = k !== null ? "Kt 来自固件，只读" : "Kt 保存于当前浏览器，仅用于 Iq × Kt 力矩换算";
    (["spd", "cur", "pos", "mit"] as DMode[]).forEach((m) => {
      const el = $<HTMLInputElement>("hRamp_" + m);
      el.value = String(hs.ramp[m]);
      const fr = h.fwRamp(m);
      el.disabled = fr !== null;
      $("hRampFw_" + m).textContent = fr !== null ? `固件 ${fr} ms` : "";
    });
    $<HTMLSelectElement>("dLink").value = hs.link;
    setGaugeRange();
  }

  function init(): void {
    gauge = new Gauge($("dGauge"), { min: -200, max: 200, unit: "rpm", interactive: true, label: "目标设定刻度盘" });
    gauge.onPick = onPick;
    chart = new StripChart($("dChart") as HTMLCanvasElement, "", 20000);
    SER.tgt = chart.addSeries("目标", PALETTE[1]!, true);
    SER.mes = chart.addSeries("实测", "var(--measured)", true);
    chart2 = new StripChart($("dChart2") as HTMLCanvasElement, "", 20000);
    SER.iq = chart2.addSeries("Iq A", PALETTE[5]!, true);
    SER.pw = chart2.addSeries("功率 W", PALETTE[4]!, true);
    SER.vb = chart2.addSeries("母线 V", PALETTE[2]!, false);
    chart.windowSec = 10; chart2.windowSec = 10;
    h.registerChart("dChart", chart); h.registerChart("dChart2", chart2);
    const lg = (el: HTMLElement, c: StripChart) => {
      el.innerHTML = "";
      c.series.forEach((s) => {
        const lab = document.createElement("label");
        lab.innerHTML = `<input type="checkbox" ${s.visible ? "checked" : ""}/><i style="background:${s.color}"></i>${s.name}`;
        lab.querySelector("input")!.addEventListener("change", (e) => { s.visible = (e.target as HTMLInputElement).checked; c.markDirty(); });
        el.appendChild(lab);
      });
    };
    lg($("lgD1"), chart); lg($("lgD2"), chart2);

    $("dModes").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button[data-dmode]") as HTMLButtonElement | null;
      if (b) setMode(b.dataset.dmode as DMode);
    });
    $("dStart").addEventListener("click", () => void (running || starting ? stop() : start()));
    $("dRangeSel").addEventListener("change", (e) => {
      stopWave();
      range[mode] = Number((e.target as HTMLSelectElement).value);
      if (Math.abs(target[mode]) > range[mode]) setTarget(target[mode]);
      setGaugeRange();
    });
    $("dApply").addEventListener("click", () => applyInput());
    $("dTarget").addEventListener("input", () => { targetEdited[mode] = true; });
    $("dTarget").addEventListener("keydown", (e) => { if (e.key === "Enter") applyInput(); });
    $("dTgtZero").addEventListener("click", () => { if (!wave.on) setTarget(0, "pick"); });
    $("dTgtNeg").addEventListener("click", () => { if (!wave.on) setTarget(-target[mode], "pick"); });
    $("dZero").addEventListener("click", () => {
      if (running || starting) { h.toast("请先停止电机再设零", "err"); return; }
      void h.setZero();
    });
    $("dClear").addEventListener("click", () => void h.clearFaults());
    $("dLink").addEventListener("change", (e) => {
      hs.link = (e.target as HTMLSelectElement).value as HostSettings["link"]; save();
      if (running || starting) void halt("已停止：切换链路", true);
    });
    $("hKt").addEventListener("change", (e) => { const v = Number((e.target as HTMLInputElement).value || 0); if (v >= 0 && v <= 10) { hs.kt = v; save(); renderHostSettings(); } else h.toast("Kt 范围 0..10 N·m/A", "err"); });
    (["spd", "cur", "pos", "mit"] as DMode[]).forEach((m) => $("hRamp_" + m).addEventListener("change", (e) => {
      const v = Math.round(Number((e.target as HTMLInputElement).value));
      if (v >= 0 && v <= 60000) { hs.ramp[m] = v; save(); } else h.toast("指令时间范围 0..60000 ms", "err");
    }));
    $("wStart").addEventListener("click", () => (wave.on ? stopWave() : startWave()));
    $("wKind").addEventListener("change", () => { if (wave.on) wave.kind = $<HTMLSelectElement>("wKind").value as Wave; });
    renderHostSettings();
    setMode("spd");
    $("dGaugeMode").textContent = MODES.spd.name;
    setGaugeRange();
    renderControls();
    setInterval(() => void tick(), 10);
    setInterval(refresh, 100);
  }

  function applyInput(explicit = true): boolean {
    const text = $<HTMLInputElement>("dTarget").value;
    const v = Number(text);
    if (!text.trim() || !Number.isFinite(v)) { h.toast("请输入有效目标", "err"); return false; }
    if (wave.on) { h.toast("请先停止波形"); return false; }
    if (explicit || v !== Number(fmtNum(toDisp(mode, target[mode]), decs(mode)))) targetEdited[mode] = true;
    setTarget(fromDisp(mode, v), "input");
    $<HTMLInputElement>("dTarget").value = fmtNum(toDisp(mode, target[mode]), decs(mode));
    return true;
  }

  return {
    init, refresh, renderHostSettings, halt, stopWave,
    get running(): boolean { return running || starting; },
    get waveOn(): boolean { return wave.on; },
    get mode(): DMode { return mode; },
    hostSettings: (): Record<string, unknown> => ({ ...hs, ramp: { ...hs.ramp } }),
    applyHostSettings(o: Record<string, unknown>): void {
      const n = (x: unknown, lo: number, hi: number) => (typeof x === "number" && x >= lo && x <= hi ? x : undefined);
      hs.kt = n(o.kt, 0, 10) ?? hs.kt;
      const r = o.ramp as Record<string, unknown> | undefined;
      if (r && typeof r === "object") (["spd", "cur", "pos", "mit"] as DMode[]).forEach((m) => { hs.ramp[m] = n(r[m], 0, 60000) ?? hs.ramp[m]; });
      save(); renderHostSettings();
    },
  };
}
