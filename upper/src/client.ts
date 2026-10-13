import { PcanUsbDevice, webUsbFilters, type CanFrame, type BusStats } from "./pcan";
import { SerialLink } from "./serial";
import { AudioSession } from "./audio-session";
import { initAudioUI } from "./audio-ui";
import type { AudioInput } from "./audio-file";
import { StripChart, PALETTE } from "./chart";
import { createUartCfg } from "./uartcfg";
import { createDashboard, type DMode, type Meas, type Route } from "./dashboard";
import { readObject, readStored, writeStored } from "./storage";
import { initTheme } from "./theme";
import { LEGACY_CHANNELS, channelRoles, type ChannelDef, type FaultSnapshot, type Role } from "./features";
import { aggregateMeasurement } from "./measurement";
import { createAeTracker, stopCanWithAe, stopSerialWithAe } from "./auto-enable";
import { saveLog, listLogs, getLog, deleteLog, clearLogs } from "./logstore";
import {
  FAULT_BITS, LIMITS, MIT_RANGE, MODE_NAMES, PARAMS, UART_LIMITS,
  asciiCommand, clamp, decodeGmFeedback, decodeStatus, encodeGmCurrent, gmAmpsToRaw, gmCommandId,
  gmFeedbackId, hex, hexId, mitPackConflict, nativeControlId, nativeCurrent,
  nativeEnterMit, nativeSetMode, nativeSetParam,
  encodeSpeedFrame, encodePositionFrame, quantizedSpeed, quantizedPosition, speedCmdId, positionCmdId,
  SPEED_FACTORY, POSITION_FACTORY, SPEED_RANGES, POSITION_RANGES, type GainFrame, type U16Ranges,
  nativeStatusId, packMit, primaryLabel, type GmFeedback, type NativeStatus, decodeFaults,
} from "./protocol";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (id: string) => Number(($(id) as HTMLInputElement).value);

// ---------------- state ----------------
let pcan: PcanUsbDevice | null = null;
let busOn = false;
const serial = new SerialLink();
let activeAudioSession: AudioSession | null = null;
let audioUi: ReturnType<typeof initAudioUI> | null = null;
const savedId = Number(readStored("dr4310.motorId") ?? 1);
let motorId = Number.isInteger(savedId) && savedId >= 1 && savedId <= 7 ? savedId : 1;
let controlEpoch = 0;
let stopTask: Promise<void> | null = null;
let emergencyTask: Promise<void> | null = null;
let switchingNode = false;
let canBusOff = false;
let canDriving = false, canDrivingT = 0;
let serialDriving = false, serialDrivingT = 0;
let gmBusy = false;

let lastStatus: NativeStatus | null = null;
let lastStatusT = 0;
let lastFb: GmFeedback | null = null;
let lastFbT = 0;
let lastUart: Float32Array | null = null;
let lastUartT = 0;
let uartDefs: ChannelDef[] = LEGACY_CHANNELS;
let uartRoles: Partial<Record<Role, number>> = channelRoles(LEGACY_CHANNELS);
let lastVbus = { v: NaN, t: -Infinity };
type NodeSeen = { st: number; fb: number; mode: number; faults: number };
const nodes = new Map<number, NodeSeen>();
const rate = { st: 0, fb: 0, rx: 0, tx: 0, uart: 0 };
const rateShown = { st: 0, fb: 0, rx: 0, tx: 0, uart: 0 };

let gmTimer = 0;
let gmArm = 0;
let gmSent = 0;
let mitTimer = 0;
let debugMitEpoch = -1;
let liveLast = 0;

// ---------------- toast ----------------
let toastTimer = 0;
function toast(text: string, kind: "" | "ok" | "err" = ""): void {
  const el = $("msg");
  el.textContent = text;
  el.className = "toast" + (kind ? " " + kind : "");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.textContent = ""; }, kind === "err" ? 7000 : 3500);
}
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------- CSV recorder ----------------
const rec = { on: false, rows: [] as string[], t0: 0 };
const REC_MAX = 2_000_000;
function recRow(src: string, id: string, vals: (number | string)[]): void {
  if (!rec.on) return;
  if (rec.rows.length >= REC_MAX) { stopRec(); toast("记录已达 200 万行上限，已自动停止", "err"); return; }
  const t = (performance.now() - rec.t0).toFixed(2);
  rec.rows.push(`${t},${src},${id},${vals.map((v) => (typeof v === "number" ? +v.toPrecision(7) : v)).join(",")}`);
}
function startRec(): void {
  rec.rows = []; rec.t0 = performance.now(); rec.on = true;
  $("recBtn").textContent = "停止记录"; $("recSave").toggleAttribute("disabled", true);
}
function stopRec(): void {
  const was = rec.on;
  rec.on = false;
  $("recBtn").textContent = "开始记录";
  $("recSave").toggleAttribute("disabled", rec.rows.length === 0);
  if (was && rec.rows.length && ($("logAuto") as HTMLInputElement).checked) {
    const srcs = [...new Set(rec.rows.slice(0, 5000).map((r) => r.split(",")[1]))].join("+");
    saveLog(recName(), recCsv(), rec.rows.length, srcs).then(() => { toast(`记录已存入日志库（${rec.rows.length} 行）`, "ok"); void renderLogs(); },
      (e) => toast("存入日志库失败：" + errMsg(e), "err"));
  }
}
function recName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `dr4310_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.csv`;
}
function recCsv(): string {
  const n = Math.max(16, uartDefs.length);
  const header = "t_ms,src,id," + Array.from({ length: n }, (_, i) => "v" + i).join(",") + "\n" +
    "# gm: v0=angle_deg v1=rpm v2=iq_A | status: v0=mode v1=faults v2=primary v3=rpm | uart: v0..v" + (uartDefs.length - 1) + "=" +
    uartDefs.map((c) => c.name).join(" ") + " | tx: v0=hex\n";
  return header + rec.rows.join("\n") + "\n";
}
function download(name: string, text: string, type = "text/csv"): void {
  const a = document.createElement("a");
  a.download = name;
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function saveRec(): void { download(recName(), recCsv()); }

// ---------------- log manager (IndexedDB) ----------------
async function renderLogs(): Promise<void> {
  let list;
  try { list = await listLogs(); } catch (e) { $("logList").innerHTML = `<tr><td colspan="6">${esc(errMsg(e))}</td></tr>`; return; }
  $("logStat").textContent = `${list.length} 条 · ${(list.reduce((n, l) => n + l.bytes, 0) / 1024).toFixed(1)} KB`;
  $("logList").innerHTML = list.length ? list.map((l) =>
    `<tr><td>${esc(l.name)}</td><td>${new Date(l.created).toLocaleString()}</td><td>${l.rows}</td><td>${(l.bytes / 1024).toFixed(1)} KB</td><td>${esc(l.source)}</td>` +
    `<td><button type="button" class="ghost" data-dl="${l.id}">下载</button> <button type="button" class="ghost danger" data-del="${l.id}">删除</button></td></tr>`).join("")
    : `<tr><td colspan="6" class="small">暂无记录。在右侧「数据记录」开始 / 停止记录后自动存入。</td></tr>`;
}

// ---------------- log ----------------
type LogRow = { t: number; dir: string; ch: string; id: string; data: string; note: string; kind: "fb" | "st" | "other" };
let logRows: LogRow[] = [];
let logDirty = false;
let logPaused = false;
const LOG_MAX = 3000;
function addLog(r: LogRow): void {
  if (logPaused) return;
  logRows.push(r);
  if (logRows.length > LOG_MAX * 1.2) logRows = logRows.slice(-LOG_MAX);
  logDirty = true;
}
function esc(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function tstr(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function renderLog(): void {
  if (!logDirty || !$("panel-log").classList.contains("active")) return;
  logDirty = false;
  const h1k = ($("logHide1k") as HTMLInputElement).checked;
  const hst = ($("logHideStatus") as HTMLInputElement).checked;
  const rows: LogRow[] = [];
  for (let i = logRows.length - 1; i >= 0 && rows.length < 400; i--) {
    const r = logRows[i]!;
    if (h1k && r.kind === "fb") continue;
    if (hst && r.kind === "st") continue;
    rows.push(r);
  }
  rows.reverse();
  $("logBody").innerHTML = rows.map((r) =>
    `<tr class="${r.dir === "TX" ? "tx-row" : "rx-row"}"><td>${tstr(r.t)}</td><td>${r.dir}</td><td>${r.ch}</td><td class="mono">${esc(r.id)}</td><td class="mono">${esc(r.data)}</td><td>${esc(r.note)}</td></tr>`).join("");
  const w = $("logWrap");
  w.scrollTop = w.scrollHeight;
}

// ---------------- charts ----------------
const charts: Record<string, StripChart> = {};
const S: Record<string, number> = {};
function mkChart(id: string, unit: string, legendId: string, series: [string, string, boolean][], cap = 40000): StripChart {
  const c = new StripChart($(id) as HTMLCanvasElement, unit, cap);
  const lg = $(legendId);
  series.forEach(([key, name, vis], k) => {
    const color = PALETTE[k % PALETTE.length]!;
    S[key] = c.addSeries(name, color, vis);
    const lab = document.createElement("label");
    lab.innerHTML = `<input type="checkbox" ${vis ? "checked" : ""}/><i style="background:${color}"></i>${esc(name)}`;
    lab.querySelector("input")!.addEventListener("change", (e) => {
      c.series[S[key]!]!.visible = (e.target as HTMLInputElement).checked; c.markDirty();
    });
    lg.appendChild(lab);
  });
  charts[id] = c;
  return c;
}
let chRpm: StripChart, chIq: StripChart, chAng: StripChart, chPrim: StripChart, chUA: StripChart, chUB: StripChart;

function initCharts(): void {
  chRpm = mkChart("chRpm", "rpm", "lgRpm", [["rpmFb", "GM 反馈 1 kHz", true], ["rpmSt", "状态帧 10 Hz", true], ["rpmCmd", "已发送目标", true]]);
  chIq = mkChart("chIq", "A", "lgIq", [["iqFb", "Iq 反馈 1 kHz", true], ["iqCmd", "已发送目标", true]]);
  chAng = mkChart("chAng", "°", "lgAng", [["ang", "机械角", true]]);
  chPrim = mkChart("chPrim", "", "lgPrim", [["prim", "主反馈", true]], 4000);
  buildUartCharts(LEGACY_CHANNELS);
  const loop = () => {
    const now = performance.now();
    for (const [id, c] of Object.entries(charts)) {
      const el = $(id);
      if (el.offsetParent !== null) c.draw(now);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
function buildUartCharts(defs: ChannelDef[]): void {
  chUA = new StripChart($("chUA") as HTMLCanvasElement, "", 20000);
  chUB = new StripChart($("chUB") as HTMLCanvasElement, "", 20000);
  const legacy = defs === LEGACY_CHANNELS;
  defs.forEach((c, k) => {
    const col = PALETTE[k % PALETTE.length]!;
    chUA.addSeries(c.name, col, legacy ? k <= 3 : k < 2);
    chUB.addSeries(c.name, col, legacy ? k === 6 || k === 7 : k >= 2 && k < 4);
  });
  const w = chRpm?.windowSec ?? 10;
  chUA.windowSec = w; chUB.windowSec = w;
  charts["chUA"] = chUA; charts["chUB"] = chUB;
}
function legendUart(): void {
  const mk = (lg: HTMLElement, c: StripChart) => {
    lg.innerHTML = c.series.filter((s) => s.visible).map((s) => `<label><i style="background:${s.color}"></i>${esc(s.name)}</label>`).join("");
  };
  mk($("lgUA"), chUA); mk($("lgUB"), chUB);
}

// ---------------- CAN I/O ----------------
function idsText(): string {
  return `原生 TX ${hexId(nativeControlId(motorId))} · 速度 ${hexId(speedCmdId(motorId))} · 位置 ${hexId(positionCmdId(motorId))} / 状态 RX ${hexId(nativeStatusId(motorId))} · GM TX ${hexId(gmCommandId(motorId))}[槽 ${motorId <= 4 ? motorId : motorId - 4}] / RX ${hexId(gmFeedbackId(motorId))}`;
}

async function sendCan(id: number, data: Uint8Array, note: string, safety = false, valid: () => boolean = () => true): Promise<boolean> {
  if (activeAudioSession && !safety) { toast("AUDIO 独占期间禁止 CAN 电机控制", "err"); return false; }
  const epoch = controlEpoch;
  const allowed = () => valid() && (safety || (epoch === controlEpoch && !stopTask && !emergencyTask && !switchingNode));
  if (!allowed()) return false;
  if (!pcan || !busOn) { toast("PCAN 未连接或总线未打开", "err"); return false; }
  try {
    await pcan.sendFrame({ id, ext: false, rtr: false, data }, allowed);
    if (!safety && epoch === controlEpoch && (id >= 0x400 && id <= 0x507 || id === nativeControlId(motorId) && (data[0] === 1 || data[0] === 6 || (data[0] === 7 || data[0] === 8) && data[1]! > 0))) {
      if (!canDriving) canDrivingT = performance.now();
      canDriving = true;
    }
    rate.tx++;
    addLog({ t: Date.now(), dir: "TX", ch: "CAN", id: hexId(id), data: hex(data), note, kind: "other" });
    recRow("tx", hexId(id), [hex(data).replace(/ /g, "")]);
    return true;
  } catch (e) {
    if (errMsg(e) === "发送已取消") return false;
    toast("CAN 发送失败：" + errMsg(e), "err");
    return false;
  }
}

async function sendNative(data: Uint8Array, note: string, opts: { keepGm?: boolean } = {}): Promise<boolean> {
  if (gmTimer && !opts.keepGm) { stopGmLoop(false); toast("原生命令会取消 GM 会话，已停止 GM 循环"); }
  const ok = await sendCan(nativeControlId(motorId), data, note);
  if (ok) $("lastCmd").textContent = `· 上次：${note}`;
  return ok;
}

function onCanFrame(f: CanFrame): void {
  if (f.dir === "tx") return; // logged by sendCan
  const now = performance.now();
  if (f.error) {
    addLog({ t: Date.now(), dir: "RX", ch: "CAN", id: "ERR", data: "", note: f.busState || "bus error", kind: "other" });
    return;
  }
  rate.rx++;
  if (f.ext || f.rtr) {
    addLog({ t: Date.now(), dir: "RX", ch: "CAN", id: (f.ext ? "x" : "") + f.id.toString(16), data: hex(f.data), note: "", kind: "other" });
    return;
  }
  if (f.id >= 0x181 && f.id <= 0x187) {
    const st = decodeStatus(f.data);
    const n = nodes.get(f.id - 0x180) ?? { st: 0, fb: 0, mode: 0, faults: 0 };
    n.st = now; if (st) { n.mode = st.mode; n.faults = st.faults; }
    nodes.set(f.id - 0x180, n);
  } else if (f.id >= 0x205 && f.id <= 0x20b) {
    const n = nodes.get(f.id - 0x204) ?? { st: 0, fb: 0, mode: -1, faults: 0 };
    n.fb = now; nodes.set(f.id - 0x204, n);
  }
  if (f.id === gmFeedbackId(motorId)) {
    const fb = decodeGmFeedback(f.data);
    if (!fb) return;
    rate.fb++;
    lastFb = fb; lastFbT = now;
    chRpm.push(S.rpmFb!, now, fb.rpm);
    chIq.push(S.iqFb!, now, fb.iq);
    chAng.push(S.ang!, now, fb.angleDeg);
    recRow("gm", hexId(f.id), [fb.angleDeg, fb.rpm, fb.iq]);
    addLog({ t: Date.now(), dir: "RX", ch: "CAN", id: hexId(f.id), data: hex(f.data), note: `${fb.angleDeg.toFixed(1)}° ${fb.rpm} rpm ${fb.iq.toFixed(3)} A`, kind: "fb" });
    return;
  }
  if (f.id === nativeStatusId(motorId)) {
    const st = decodeStatus(f.data);
    if (!st) return;
    rate.st++;
    lastStatus = st; lastStatusT = now;
    if (st.faults && (activeAudioSession || canDriving || aeActive() || dash.running || gmTimer || mitTimer || gainTimers.spd || gainTimers.pos)) void safeStop("CAN 故障");
    if (st.mode === 0) lastVbus = { v: st.primary, t: now };
    chRpm.push(S.rpmSt!, now, st.rpm);
    chPrim.push(S.prim!, now, st.primary);
    recRow("status", hexId(f.id), [st.mode, st.faults, st.primary, st.rpm]);
    const pl = primaryLabel(st.mode);
    addLog({ t: Date.now(), dir: "RX", ch: "CAN", id: hexId(f.id), data: hex(f.data), note: `${MODE_NAMES[st.mode] ?? st.mode} fault=0x${st.faults.toString(16)} ${pl.name}=${st.primary.toFixed(3)}${pl.unit} ${st.rpm.toFixed(1)} rpm`, kind: "st" });
    return;
  }
  addLog({ t: Date.now(), dir: "RX", ch: "CAN", id: hexId(f.id), data: hex(f.data), note: "", kind: "other" });
}

function onBusStatus(b: BusStats, text?: string): void {
  canBusOff = b.busOff;
  const parts = [b.busOff ? "Bus-Off" : b.busHeavy ? "Error Passive" : b.busLight ? "Error Warning" : "Active", `rxerr=${b.rxerr} txerr=${b.txerr}`];
  if (b.rxOverflow) parts.push("RX-OVR");
  $("stPcanBus").textContent = "1 Mbps · " + parts.join(" · ");
  $("dotPcan").className = "dot " + (b.busOff || b.busHeavy ? "warn" : "on");
  if (text && b.busOff) toast(text, "err");
  if ((b.busOff || text?.startsWith("读取中断")) && (activeAudioSession || canDriving || aeActive() || dash.running || gmTimer || mitTimer || gainTimers.spd || gainTimers.pos)) void safeStop("CAN 链路异常");
}

async function pcanConnect(): Promise<void> {
  if (!navigator.usb) { toast("当前浏览器不支持 WebUSB（需 Chrome/Edge + HTTPS）", "err"); return; }
  let dev: USBDevice;
  try { dev = await navigator.usb.requestDevice({ filters: webUsbFilters() }); }
  catch (e) { const m = errMsg(e); toast(/cancel|NotFound|No device selected/i.test(m) ? "已取消选择设备" : m, /cancel|NotFound|No device selected/i.test(m) ? "" : "err"); return; }
  await pcanOpen(dev);
}
async function pcanOpen(dev: USBDevice, auto = false): Promise<void> {
  if (pcan) return;
  try {
    pcan = new PcanUsbDevice(dev);
    await pcan.open();
    pcan.onFrame = onCanFrame;
    pcan.onStatus = onBusStatus;
    let sn = "—";
    try { sn = (await pcan.getSerial()).toString(16).toUpperCase().padStart(8, "0"); } catch { /* optional */ }
    $("stPcanDev").textContent = `${pcan.productName} · SN ${sn}`;
    await pcan.start(1_000_000, false);
    busOn = true;
    canBusOff = false;
    $("stPcanBus").textContent = "1 Mbps · Active";
    $("dotPcan").className = "dot on";
    $("pcanConnect").toggleAttribute("disabled", true);
    $("pcanDisconnect").toggleAttribute("disabled", false);
    toast(auto ? "PCAN 已自动连接，总线 1 Mbps（只监听，未发送命令）" : "PCAN 已连接，总线 1 Mbps 已打开", "ok");
  } catch (e) {
    toast((auto ? "PCAN 自动连接失败：" : "") + errMsg(e), "err");
    if (pcan) { try { await pcan.close(); } catch { /* ignore */ } }
    pcan = null; busOn = false;
  }
}

async function pcanDisconnect(sendStop = true): Promise<void> {
  if (sendStop && pcan && busOn) await safeStop("断开 PCAN 前失能");
  stopGmLoop(false); stopAllPeriodic();
  if (pcan) { try { await pcan.close(); } catch { /* ignore */ } }
  pcan = null; busOn = false;
  autoEnable.forget("can");
  lastStatus = null; lastFb = null; nodes.clear(); lastVbus = { v: NaN, t: -Infinity };
  $("stPcanDev").textContent = "—"; $("stPcanBus").textContent = "未连接"; $("dotPcan").className = "dot";
  $("pcanConnect").toggleAttribute("disabled", false);
  $("pcanDisconnect").toggleAttribute("disabled", true);
}

// ---------------- GM6020 loop ----------------
function gmTarget(): number { return clamp(num("gmA"), -LIMITS.currentA, LIMITS.currentA); }
function gmPreview(): void {
  const a = gmTarget();
  const f = encodeGmCurrent(motorId, a);
  $("gmRaw").textContent = `原始值 ${gmAmpsToRaw(a)}`;
  $("gmHex").textContent = `${hexId(f.id)}  ${hex(f.data)}`;
}
async function gmTick(): Promise<void> {
  if (gmBusy) return;
  if (!pcan || !busOn) { stopGmLoop(false); return; }
  const amps = gmArm > 0 ? 0 : gmTarget();
  if (gmArm > 0) gmArm--;
  const f = encodeGmCurrent(motorId, amps);
  gmBusy = true;
  try {
    const epoch = controlEpoch;
    await pcan.sendFrame({ id: f.id, ext: false, rtr: false, data: f.data }, () => epoch === controlEpoch && !!gmTimer);
    rate.tx++; gmSent++;
    if (gmArm === 0) chIq.push(S.iqCmd!, performance.now(), amps);
    recRow("tx", hexId(f.id), [hex(f.data).replace(/ /g, "")]);
    if (gmSent % 20 === 0) addLog({ t: Date.now(), dir: "TX", ch: "CAN", id: hexId(f.id), data: hex(f.data), note: `GM ${amps.toFixed(3)} A（每 20 帧记 1 条）`, kind: "other" });
  } catch (e) {
    stopGmLoop(false);
    if (errMsg(e) === "发送已取消") return;
    void safeStop("GM 发送失败");
    toast("GM 循环发送失败，已停止：" + errMsg(e), "err");
  } finally { gmBusy = false; }
}
function startGmLoop(): void {
  if (stopTask || emergencyTask || switchingNode) return;
  void dash.halt("", false);
  controlEpoch++; pcan?.cancelPending();
  if (!pcan || !busOn) { toast("PCAN 未连接", "err"); return; }
  if (gmTimer) return;
  stopAllPeriodic();
  gmArm = 3; gmSent = 0;
  gmTimer = window.setInterval(() => { void gmTick(); }, 10);
  $("gmStart").toggleAttribute("disabled", true);
  $("gmStop").toggleAttribute("disabled", false);
  $("dotGm").className = "dot on";
  $("gmState").textContent = "运行中：先发 3 帧零电流握手，然后 100 Hz 发送目标";
}
function stopGmLoop(sendZero = true): void {
  const wasOn = !!gmTimer;
  if (gmTimer) { clearInterval(gmTimer); gmTimer = 0; }
  $("gmStart").toggleAttribute("disabled", false);
  $("gmStop").toggleAttribute("disabled", true);
  $("dotGm").className = "dot";
  $("gmState").textContent = "未运行";
  if (wasOn && sendZero && pcan && busOn) {
    const f = encodeGmCurrent(motorId, 0);
    void sendCan(f.id, f.data, "GM 零帧（停机）");
    chIq.push(S.iqCmd!, performance.now(), 0);
  }
}

// ---------------- MIT ----------------
function mitCmd() { return { p: num("mP"), v: num("mV"), kp: num("mKp"), kd: num("mKd"), t: num("mT") }; }
function mitPreview(): Uint8Array {
  const d = packMit(mitCmd());
  $("mitHex").textContent = `${hexId(nativeControlId(motorId))}  ${hex(d)}`;
  const w = mitPackConflict(d);
  const c = mitCmd();
  const out: string[] = [];
  if (w) out.push(w);
  const chk = (v: number, r: readonly [number, number], n: string) => { if (v < r[0] || v > r[1]) out.push(`${n} 超出范围，将被钳位到 [${r[0]}, ${r[1]}]`); };
  chk(c.p, MIT_RANGE.p, "p_des"); chk(c.v, MIT_RANGE.v, "v_des"); chk(c.kp, MIT_RANGE.kp, "Kp"); chk(c.kd, MIT_RANGE.kd, "Kd"); chk(c.t, MIT_RANGE.t, "Iq_ff");
  $("mitWarn").textContent = out.join("；");
  return d;
}
async function mitSend(): Promise<boolean> {
  const epoch = controlEpoch;
  if (debugMitEpoch !== epoch) {
    if (!alignDebugPosition("mit")) return false;
    if (!(await sendNative(nativeEnterMit(), "进入 MIT")) || epoch !== controlEpoch) return false;
    debugMitEpoch = epoch;
  }
  const d = mitPreview();
  const w = mitPackConflict(d);
  if (w) { toast("已拒绝发送：" + w, "err"); stopMitPeriodic(); return false; }
  const ok = await sendNative(d, "MIT 帧");
  if (ok) chIq.push(S.iqCmd!, performance.now(), clamp(num("mT"), -2.5, 2.5));
  return ok;
}
function stopAllPeriodic(): void { stopMitPeriodic(); stopGainPeriodic(); }
function stopMitPeriodic(): void {
  if (mitTimer) { clearInterval(mitTimer); mitTimer = 0; }
  ($("mitPeriodic") as HTMLInputElement).checked = false;
}

// ---------------- Serial ----------------
function onUartFrame(fr: Float32Array, now: number): void {
  rate.uart++;
  lastUart = fr; lastUartT = now;
  const n = Math.min(fr.length, chUA.series.length);
  for (let k = 0; k < n; k++) { chUA.push(k, now, fr[k]!); chUB.push(k, now, fr[k]!); }
  recRow("uart", "", Array.from(fr));
}
function onUartChannels(defs: ChannelDef[]): void {
  if (defs.length === uartDefs.length && defs.every((d, i) => d.name === uartDefs[i]!.name && d.unit === uartDefs[i]!.unit)) return;
  uartDefs = defs;
  uartRoles = channelRoles(defs);
  lastUart = null;
  buildUartCharts(defs);
  buildUartVals();
}
function onFault(sn: FaultSnapshot): void {
  if (sn.code) {
    if (activeAudioSession || serialDriving || canDriving || aeActive() || dash.running || gmTimer || mitTimer || gainTimers.spd || gainTimers.pos) void safeStop("串口故障");
    toast(`故障 0x${sn.code.toString(16)} ${sn.names.join(",") || decodeFaults(sn.code).join("、")}`, "err");
  }
}
// Optional serial settings tab (merged UART-config firmware); also splits '@' reply lines out of the JustFloat stream.
const cfg = createUartCfg({
  serial,
  toast,
  log: (dir, text, note, poll) => addLog({ t: Date.now(), dir, ch: "UART", id: "", data: text, note, kind: poll ? "st" : "other" }),
  rec: (dir, text) => recRow(dir, "uart", [text]),
  confirmOn: () => ($("wdConfirm") as HTMLInputElement).checked,
  onFrame: onUartFrame,
  onChannels: onUartChannels,
  onFault,
  onParams: () => dash.renderHostSettings(),
  hostSettings: () => ({ ...dash.hostSettings(), gains: { spd: gainFrame("spd"), pos: gainFrame("pos") } }),
  applyHostSettings: (o) => {
    dash.applyHostSettings(o);
    const g = o.gains as Record<string, Partial<GainFrame>> | undefined;
    if (g && typeof g === "object") for (const k of ["spd", "pos"] as GainKind[]) {
      const x = g[k]; if (!x) continue;
      for (const n of ["kp", "ki", "kd"] as const) if (typeof x[n] === "number" && Number.isFinite(x[n])) ($(k + n) as HTMLInputElement).value = String(x[n]);
      saveGains(k); gainPreview(k);
    }
  },
});
async function serConnect(port?: SerialPort): Promise<void> {
  if (serial.connected) return;
  // Handlers first: the read loop starts inside open().
  cfg.prepare();
  serial.onData = (c) => { if (activeAudioSession) activeAudioSession.onData(c); else cfg.onData(c); };
  serial.onClose = (r) => { activeAudioSession?.disconnected(r); void safeStop("串口断开"); lastUart = null; serUi(false); cfg.onClosed(); autoEnable.forget("serial"); void serial.close(); toast("串口已断开：" + r, "err"); };
  try {
    const baud = Number($<HTMLSelectElement>("serBaud").value);
    if (port) await serial.openPort(port, baud); else await serial.open(baud);
  } catch (e) {
    const m = errMsg(e);
    toast(/No port selected|cancel/i.test(m) ? "已取消选择串口" : m, /No port selected|cancel/i.test(m) ? "" : "err");
    return;
  }
  serUi(true);
  toast("串口已连接，正在识别固件…", "ok");
  await cfg.onOpened();
  audioUi?.refresh();
}
function serUi(on: boolean): void {
  $("dotSer").className = "dot" + (on ? " on" : "");
  $("stSer").textContent = on ? `已连接 · ${serial.baudRate} 8N1` : "未连接";
  $("serConnect").toggleAttribute("disabled", on);
  $("serDisconnect").toggleAttribute("disabled", !on);
  audioUi?.refresh();
}
async function serDisconnect(sendStop = true): Promise<void> {
  if (sendStop && serial.connected) await safeStop("断开串口");
  await serial.close();
  serUi(false);
  cfg.onClosed();
  autoEnable.forget("serial");
  lastUart = null;
  audioUi?.refresh();
}
async function serSend(line: string, note = "", safety = false): Promise<boolean> {
  const epoch = controlEpoch;
  if (activeAudioSession) { if (!safety) toast("AUDIO 独占，其他串口命令已禁止", "err"); return false; }
  if (!safety && line.trim() !== "STOP" && (stopTask || emergencyTask || switchingNode)) return false;
  if (!serial.connected) { toast("串口未连接", "err"); return false; }
  try {
    await serial.writeText(line);
    if (epoch === controlEpoch && /^(RUN|CUR|SPD|POS|MIT|CALIB|MODE\s+[1-4])\b/i.test(line.trim())) { if (!serialDriving) serialDrivingT = performance.now(); serialDriving = true; }
    addLog({ t: Date.now(), dir: "TX", ch: "UART", id: "", data: line.trim(), note, kind: "other" });
    recRow("tx", "uart", [line.trim()]);
    return true;
  } catch (e) { toast("串口发送失败：" + errMsg(e), "err"); return false; }
}

// ---------------- AUDIO V1 ----------------
async function audioStart(file: AudioInput, axis: "Q" | "D", ampMa: number): Promise<void> {
  if (activeAudioSession) throw new Error("已有 AUDIO 会话");
  if (!serial.connected || serial.baudRate !== 230400)
    throw new Error("AUDIO V1 必须通过 230400 8N1 Web Serial 连接");
  if (cfg.fw !== "v2") throw new Error("固件未识别，不支持 AUDIO V1");
  if (!Number.isInteger(ampMa) || ampMa < 1 || ampMa > 200) throw new Error("峰值幅度必须是 1..200mA 的整数");
  // Do not interpret the legacy INFO baud=CAN_BAUD as USART speed.
  const response = await cfg.request("INFO\n", { note: "AUDIO 能力检测", timeout: 850 });
  const kv = response.reply?.type === "INFO" ? response.reply.kv : null;
  if (!response.ok || kv?.audio !== "1" || kv.uart_baud !== "230400")
    throw new Error("固件不支持 AUDIO V1（INFO 必须包含 audio=1 uart_baud=230400）");
  if (kv.fault && parseInt(kv.fault, 16)) throw new Error("固件存在故障锁存，拒绝开启音频");
  const previousTelem = kv.telem === "1" ? 1 : 0;
  if (!confirm("即将向电机注入音频电流。请确认电机已固定、空载，外部硬件急停可靠、无其他 CAN 主机控制，首次使用建议 20 mA 和 300 Hz 测试。\n\n启动 AUDIO？"))
    throw new Error("用户取消音频启动");
  await safeStop("AUDIO 启动前安全停机");
  if (!serial.connected || activeAudioSession) throw new Error("安全停机期间串口断开或 AUDIO 已启动");
  cancelControl("AUDIO 独占接管");
  cfg.setAudioExclusive(true);
  let session: AudioSession;
  session = new AudioSession(serial, file, previousTelem,
    (snapshot) => audioUi?.update(snapshot),
    (safe) => {
      if (activeAudioSession === session) activeAudioSession = null;
      if (safe) cfg.setAudioExclusive(false);
      else {
        toast("AUDIO 退出未经确认，停机状态未知；请使用硬件急停", "err");
        void serial.close();
      }
      audioUi?.released();
    });
  activeAudioSession = session;
  try { await session.start(axis, ampMa); }
  catch (e) {
    if (activeAudioSession === session) await session.stop("启动失败");
    throw e;
  }
}

// ---------------- Safety ----------------
function cancelControl(reason: string): boolean {
  controlEpoch++;
  autoEnable.resetOff(motorId);
  void dash.halt("", false);
  stopAllPeriodic();
  canDriving = false; serialDriving = false;
  $<HTMLInputElement>("liveSlider").checked = false;
  const gmWas = !!gmTimer;
  stopGmLoop(false);
  pcan?.cancelPending(); serial.cancelPending(); cfg.cancelPending(reason);
  return gmWas;
}
function safeStop(reason: string): Promise<void> {
  if (stopTask) return stopTask;
  if (emergencyTask) return emergencyTask;
  const gmWas = cancelControl(reason);
  const id = motorId;
  stopTask = (async () => {
    await Promise.all([
      (async () => {
        if (!pcan || !busOn) return;
        if (gmWas) { const f = encodeGmCurrent(id, 0); await sendCan(f.id, f.data, "GM 零帧 · " + reason, true); }
        const result = await stopCanWithAe(id, false, (cid, data) => sendCan(cid, data, (data[0] === 8 ? "关闭自动使能 · " : "Disable · ") + reason, true));
        autoEnable.stopped({ route: "can", id }, result.ae);
      })(),
      stopSerial(reason),
    ]);
  })().finally(() => { stopTask = null; });
  return stopTask;
}
async function stopSerial(reason: string): Promise<boolean> {
  if (activeAudioSession) return activeAudioSession.stop(reason);
  if (!serial.connected) return false;
  const result = await stopSerialWithAe(async (line) => {
    // AE 0 is written raw (serial writes stay ordered, so it still precedes STOP on the wire) and is not
    // awaited for a reply: a lost "@OK AE" must not delay STOP by the 700 ms request timeout.
    // (Firmware STOP also clears runtime AE.)
    if (cfg.fw !== "v2" || /^AE\b/.test(line)) return serSend(line, reason, true);
    const r = await cfg.request(line, { note: reason, timeout: 700 });
    if (!r.ok) toast(`${line.trim()} 未确认：${r.err ?? "无应答"}`, "err");
    return r.ok;
  });
  autoEnable.stopped({ route: "serial", id: motorId }, result.ae);
  return result.stop;
}

async function estop(): Promise<void> {
  if (emergencyTask) return emergencyTask;
  const gmWas = cancelControl("急停");
  emergencyTask = performEstop(gmWas).finally(() => { emergencyTask = null; });
  return emergencyTask;
}
async function performEstop(gmWas: boolean): Promise<void> {
  const done: string[] = [];
  await Promise.all([(async () => { if (pcan && busOn) {
    if (gmWas) { const f = encodeGmCurrent(motorId, 0); await sendCan(f.id, f.data, "急停 · GM 零帧", true); }
    const result = await stopCanWithAe(motorId, true, (id, data) => sendCan(id, data, data[0] === 8 ? "急停 · 关闭自动使能" : "急停 · E-stop 0x03", true));
    autoEnable.stopped({ route: "can", id: motorId }, result.ae);
    if (result.stop) done.push("CAN");
  } })(), (async () => { if (serial.connected && await stopSerial("急停")) done.push("串口"); })()]);
  toast(done.length ? `已发送急停 · ${done.join(" + ")}` : "急停未确认，请使用硬件急停", done.length ? "ok" : "err");
}

// ---------------- UI wiring ----------------
function bindPair(nId: string, rId: string, onChange?: () => void): void {
  const n = $(nId) as HTMLInputElement, r = $(rId) as HTMLInputElement;
  n.addEventListener("input", () => { r.value = n.value; onChange?.(); });
  r.addEventListener("input", () => { n.value = r.value; onChange?.(); });
}

function liveSend(kind: "iq" | "spd" | "pos"): void {
  if (!($("liveSlider") as HTMLInputElement).checked) return;
  const now = performance.now();
  if (now - liveLast < 50) return;
  liveLast = now;
  void sendTarget(kind);
}
async function sendTarget(kind: "iq" | "spd" | "pos"): Promise<void> {
  if (dash.running) { void dash.halt("", false); controlEpoch++; pcan?.cancelPending(); }
  stopAllPeriodic();
  if (kind === "pos" && !alignDebugPosition("pos")) return;
  if (kind === "iq") {
    const a = clamp(num("nIq"), -LIMITS.currentA, LIMITS.currentA);
    if (await sendNative(nativeCurrent(a), `电流 ${a} A`)) chIq.push(S.iqCmd!, performance.now(), a);
  } else {
    await sendGainFrame(kind);
  }
}

function alignDebugPosition(kind: "pos" | "mit"): boolean {
  const m = meas("can"), devMode = kind === "pos" ? 3 : 4;
  if (m.fresh && m.mode === devMode) return true;
  if (m.fresh && Number.isFinite(m.pos)) {
    const limit = kind === "pos" ? LIMITS.positionRad : MIT_RANGE.p[1];
    if (Math.abs(m.pos) > limit) { toast("当前位置超出模式量程", "err"); return false; }
    $<HTMLInputElement>(kind === "pos" ? "nPos" : "mP").value = String(m.pos);
    if (kind === "pos") { $<HTMLInputElement>("rPos").value = String(m.pos); gainPreview("pos"); } else mitPreview();
    return true;
  }
  return confirm("未知当前位置。启动可能转向输入目标，继续？");
}

// ---------------- speed / position frames (0x400+id / 0x500+id) ----------------
type GainKind = "spd" | "pos";
const GAIN_CFG: Record<GainKind, { factory: GainFrame; ranges: U16Ranges; unit: string; name: string; store: string }> = {
  spd: { factory: SPEED_FACTORY, ranges: SPEED_RANGES, unit: "rpm", name: "速度", store: "dr4310.gains.spd" },
  pos: { factory: POSITION_FACTORY, ranges: POSITION_RANGES, unit: "rad", name: "位置", store: "dr4310.gains.pos" },
};
const gainTimers: Record<GainKind, number> = { spd: 0, pos: 0 };
const cap = (k: GainKind) => (k === "spd" ? "Spd" : "Pos");
function gainFrame(k: GainKind): GainFrame {
  const r = GAIN_CFG[k].ranges;
  return {
    target: clamp(num("n" + cap(k)), r.target[0], r.target[1]),
    kp: clamp(num(k + "kp"), r.kp[0], r.kp[1]),
    ki: clamp(num(k + "ki"), r.ki[0], r.ki[1]),
    kd: clamp(num(k + "kd"), r.kd[0], r.kd[1]),
  };
}
function encodeGain(k: GainKind, f: GainFrame) {
  return k === "spd" ? encodeSpeedFrame(motorId, f) : encodePositionFrame(motorId, f);
}
function loadGains(k: GainKind): void {
  const g = readObject(GAIN_CFG[k].store);
  const fac = GAIN_CFG[k].factory;
  for (const n of ["kp", "ki", "kd"] as const) {
    const v = typeof g[n] === "number" && Number.isFinite(g[n]) ? g[n]! : fac[n];
    ($(k + n) as HTMLInputElement).value = String(v);
  }
}
function saveGains(k: GainKind): void {
  const f = gainFrame(k);
  writeStored(GAIN_CFG[k].store, JSON.stringify({ kp: f.kp, ki: f.ki, kd: f.kd }));
}
function gainPreview(k: GainKind): void {
  const f = gainFrame(k);
  const { id, data } = encodeGain(k, f);
  $(k + "Hex").textContent = `ID ${hexId(id)}  ${hex(data)}`;
  const q = k === "spd" ? quantizedSpeed(f) : quantizedPosition(f);
  const r = (x: number) => String(+x.toPrecision(6));
  $(k + "Q").textContent = `固件解码：目标 ${r(q.target)} ${GAIN_CFG[k].unit} · Kp ${r(q.kp)} · Ki ${r(q.ki)} · Kd ${r(q.kd)}`;
}
async function sendGainFrame(k: GainKind, note = ""): Promise<boolean> {
  const f = gainFrame(k);
  const { id, data } = encodeGain(k, f);
  if (gmTimer) { stopGmLoop(false); toast("速度/位置帧会取消 GM 会话，已停止 GM 循环"); }
  const ok = await sendCan(id, data, note || `${GAIN_CFG[k].name} ${f.target} ${GAIN_CFG[k].unit} Kp=${f.kp} Ki=${f.ki} Kd=${f.kd}`);
  if (ok) {
    $("lastCmd").textContent = `· 上次：${GAIN_CFG[k].name}帧 ${hexId(id)}`;
    if (k === "spd") chRpm.push(S.rpmCmd!, performance.now(), f.target);
  }
  return ok;
}
function stopGainPeriodic(k?: GainKind): void {
  for (const x of (k ? [k] : (["spd", "pos"] as GainKind[]))) {
    if (gainTimers[x]) { clearInterval(gainTimers[x]); gainTimers[x] = 0; }
    const cb = document.getElementById(x + "Periodic") as HTMLInputElement | null;
    if (cb) cb.checked = false;
  }
}
function initGainPanel(k: GainKind): void {
  loadGains(k);
  const upd = () => { saveGains(k); gainPreview(k); };
  ["kp", "ki", "kd"].forEach((n) => $(k + n).addEventListener("input", () => { upd(); liveSend(k); }));
  ["n" + cap(k), "r" + cap(k)].forEach((id) => $(id).addEventListener("input", () => gainPreview(k)));
  $(k + "Factory").addEventListener("click", () => {
    const fac = GAIN_CFG[k].factory;
    ($(k + "kp") as HTMLInputElement).value = String(fac.kp);
    ($(k + "ki") as HTMLInputElement).value = String(fac.ki);
    ($(k + "kd") as HTMLInputElement).value = String(fac.kd);
    upd();
    toast(`${GAIN_CFG[k].name}增益已恢复出厂（未发送）`, "ok");
  });
  $(k + "Periodic").addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    if (gainTimers[k]) { clearInterval(gainTimers[k]); gainTimers[k] = 0; }
    if (!on) return;
    if (!pcan || !busOn) { toast("PCAN 未连接", "err"); stopGainPeriodic(k); return; }
    if (k === "pos" && !alignDebugPosition("pos")) { stopGainPeriodic(k); return; }
    void dash.halt("", false); controlEpoch++; pcan.cancelPending();
    stopGainPeriodic(k === "spd" ? "pos" : "spd"); // the two would fight over the mode
    stopMitPeriodic();
    const period = Math.max(10, num(k + "Period") || 50);
    let busy = false;
    gainTimers[k] = window.setInterval(async () => {
      if (busy) return; busy = true;
      try { if (!(await sendGainFrame(k, `${GAIN_CFG[k].name} 周期`))) stopGainPeriodic(k); } finally { busy = false; }
    }, period);
  });
  gainPreview(k);
}

function buildParams(): void {
  const saved = readObject("dr4310.params");
  $("paramBody").innerHTML = PARAMS.map((p) =>
    `<tr><td class="mono">0x${p.id.toString(16).padStart(2, "0")}</td><td title="${esc(p.note ?? p.name)}">${esc(p.name)}</td>
     <td><input type="number" step="any" min="0" id="par_${p.key}" value="${typeof saved[p.key] === "number" && Number.isFinite(saved[p.key]) ? saved[p.key] : p.def}"/></td><td>${p.unit}</td>
     <td><button type="button" data-par="${p.key}">写入</button></td></tr>`).join("");
  $("paramBody").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button[data-par]") as HTMLButtonElement | null;
    if (b) void sendParam(b.dataset.par!);
  });
}
async function sendParam(key: string): Promise<boolean> {
  const p = PARAMS.find((x) => x.key === key)!;
  const v = num("par_" + key);
  if (!Number.isFinite(v)) { toast(`${p.name} 数值无效`, "err"); return false; }
  if (p.id === 0x03 && v <= 0) { toast("PI 输出电压限幅必须 > 0，固件忽略 ≤0", "err"); return false; }
  const saved = readObject("dr4310.params");
  saved[key] = v; writeStored("dr4310.params", JSON.stringify(saved));
  return sendNative(nativeSetParam(p.id, v), `参数 ${p.name}=${Math.max(0, v)}`);
}

let uValsBound = false;
function buildUartVals(): void {
  $("uValsH").textContent = `遥测通道 · ${uartDefs.length}`;
  $("uVals").innerHTML = uartDefs.map((c, k) =>
    `<div class="r"><span><i style="display:inline-block;width:.6rem;height:.6rem;border-radius:2px;background:${PALETTE[k % PALETTE.length]}"></i> CH${k} ${esc(c.name)} <span class="small">${esc(c.unit)}</span></span>
     <span class="v" id="uv${k}">—</span>
     <label class="small"><input type="checkbox" data-ua="${k}" ${chUA.series[k]!.visible ? "checked" : ""}/>A</label>
     <label class="small"><input type="checkbox" data-ub="${k}" ${chUB.series[k]!.visible ? "checked" : ""}/>B</label></div>`).join("");
  if (uValsBound) { legendUart(); return; }
  uValsBound = true;
  $("uVals").addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.ua) { chUA.series[Number(t.dataset.ua)]!.visible = t.checked; chUA.markDirty(); }
    if (t.dataset.ub) { chUB.series[Number(t.dataset.ub)]!.visible = t.checked; chUB.markDirty(); }
    legendUart();
  });
  legendUart();
}

function setMotorId(id: number): void {
  if (gmTimer) stopGmLoop(true); // zero frame to the old id first
  stopAllPeriodic();
  motorId = id;
  writeStored("dr4310.motorId", String(id));
  $("stIds").textContent = idsText();
  $("hdrIds").textContent = `NODE ${id} · ${hexId(0x100 + id)} / ${hexId(speedCmdId(id))} / ${hexId(positionCmdId(id))}`;
  $("gmIds").textContent = `TX ${hexId(gmCommandId(id))} 槽 ${((id - 1) % 4) + 1} · RX ${hexId(gmFeedbackId(id))}`;
  lastStatus = null; lastFb = null; lastVbus = { v: NaN, t: -Infinity };
  Object.values(charts).forEach((c) => c.clear());
  gmPreview(); mitPreview();
  $("spdId").textContent = `→ ${hexId(speedCmdId(id))}`;
  $("posId").textContent = `→ ${hexId(positionCmdId(id))}`;
  gainPreview("spd"); gainPreview("pos");
}
async function changeMotorId(id: number): Promise<void> {
  if (switchingNode || id === motorId || !Number.isInteger(id) || id < 1 || id > 7) { $<HTMLSelectElement>("motorId").value = String(motorId); return; }
  switchingNode = true;
  $<HTMLSelectElement>("motorId").disabled = true;
  try {
    if (canDriving || serialDriving || aeActive() || dash.running || gmTimer || mitTimer || gainTimers.spd || gainTimers.pos || (lastStatus && lastStatus.mode > 0)) await safeStop("切换电机");
    else { controlEpoch++; pcan?.cancelPending(); }
    setMotorId(id);
    $<HTMLSelectElement>("motorId").value = String(id);
  } finally { switchingNode = false; $<HTMLSelectElement>("motorId").disabled = false; }
}

function fmt(v: number, d = 2): string { return Number.isFinite(v) ? v.toFixed(d) : "—"; }

// ---------------- aggregated measurement (dashboard) ----------------
function meas(selected: Route = route("auto")): Meas {
  return aggregateMeasurement({
    route: selected, motorId, now: performance.now(), canEnabled: busOn, serialEnabled: serial.connected,
    status: { value: lastStatus, t: lastStatusT }, gm: { value: lastFb, t: lastFbT }, uart: { value: lastUart, t: lastUartT },
    info: cfg.fw === "v2" ? cfg.info : null, infoAge: cfg.infoAge, roles: uartRoles, cachedVbus: lastVbus,
    kt: cfg.param("KT") ?? dash.hostSettings().kt as number,
  });
}
function route(pref: "auto" | "can" | "serial") {
  if (activeAudioSession) return null;
  if (stopTask || emergencyTask || switchingNode) return null;
  const canOk = !!pcan && busOn && !canBusOff;
  const ser = serial.connected ? (cfg.fw === "v2" ? "serial" : cfg.fw === "legacy" ? "legacy" : null) : null;
  if (pref === "can") return canOk ? "can" : null;
  if (pref === "serial") return ser;
  return canOk ? "can" : ser;
}
const dash = createDashboard({
  route,
  async sendCanTarget(mode: DMode, v, mit, first, valid) {
    const epoch = controlEpoch;
    const current = () => epoch === controlEpoch && valid();
    const note = `仪表盘 ${mode}`;
    if (mode === "spd") { const g = gainFrame("spd"); const f = encodeSpeedFrame(motorId, { ...g, target: clamp(v, -LIMITS.speedRpm, LIMITS.speedRpm) }); const ok = await sendCan(f.id, f.data, `${note} ${v.toFixed(2)} rpm`); if (ok) chRpm.push(S.rpmCmd!, performance.now(), v); return ok; }
    if (mode === "pos") { const g = gainFrame("pos"); const f = encodePositionFrame(motorId, { ...g, target: clamp(v, -LIMITS.positionRad, LIMITS.positionRad) }); return sendCan(f.id, f.data, `${note} ${v.toFixed(3)} rad`); }
    if (mode === "cur") { const ok = await sendCan(nativeControlId(motorId), nativeCurrent(v), `${note} ${v.toFixed(3)} A`); if (ok) chIq.push(S.iqCmd!, performance.now(), v); return ok; }
    if (first && !(await sendCan(nativeControlId(motorId), nativeEnterMit(), "仪表盘 进入 MIT", false, current))) return false;
    if (!current()) return false;
    const d = packMit({ p: v, v: mit.v, kp: mit.kp, kd: mit.kd, t: mit.t });
    const w = mitPackConflict(d);
    if (w) { toast("已拒绝发送：" + w, "err"); return false; }
    return sendCan(nativeControlId(motorId), d, `${note} p=${v.toFixed(3)}`, false, current);
  },
  async serialLine(line, note) {
    const r = await cfg.request(line, { note, timeout: 700 });
    if (!r.ok) toast(`${line.trim()}：${r.err ?? "失败"}`, "err");
    return r.ok;
  },
  serialRaw: (line, note) => serSend(line, note),
  stopAll: (reason) => safeStop(reason),
  stopOthers: () => { controlEpoch++; pcan?.cancelPending(); serial.cancelPending(); cfg.cancelPending("切换控制"); if (gmTimer) stopGmLoop(false); stopAllPeriodic(); },
  meas,
  fwRamp: (m) => (cfg.fw === "v2" ? cfg.param(m === "spd" ? "SPD_RAMP_MS" : m === "cur" ? "CUR_RAMP_MS" : m === "pos" ? "POS_RAMP_MS" : "__none") : null),
  fwKt: () => (cfg.fw === "v2" ? cfg.param("KT") : null),
  vbusMax: () => (cfg.fw === "v2" ? cfg.param("VBUS_MAX") : null),
  canSetZero: () => serial.connected && cfg.fw === "v2" && cfg.features.setzero,
  setZero: async () => { await cfg.setZero(); },
  async preparePosition(valid) {
    if (!(await cfg.ensurePositionTelemetry(valid))) {
      if (valid()) toast("位置反馈准备失败，启动已取消", "err");
      return false;
    }
    // Fixed-channel older firmware cannot provide PosRad: keep its explicit confirmation path.
    if (!cfg.channels.some(c => c.name.toUpperCase() === "POSRAD")) return valid();
    const deadline = performance.now() + 1500;
    while (valid() && performance.now() < deadline) {
      const m = meas("serial");
      if (m.fresh && Number.isFinite(m.pos)) return true;
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
    if (valid()) toast("未收到有效位置反馈，启动已取消；检查编码器和遥测", "err");
    return false;
  },
  clearFaults: async () => { await clearFaults(); },
  toast,
  confirmOn: () => ($("wdConfirm") as HTMLInputElement).checked,
  registerChart: (id, c) => { charts[id] = c; },
});
// Runtime AE is never switched on by this page (persistent BOOT_AE lives in 参数配置 › 驱动参数 › 上电行为).
// The tracker only mirrors the firmware's INFO ae= so stops send AE off first and the indicator shows it.
const autoEnable = createAeTracker({
  target: () => {
    const rt = route($<HTMLSelectElement>("dLink").value as "auto" | "can" | "serial");
    return rt === "can" || rt === "serial" ? { route: rt, id: motorId } : null;
  },
  info: () => {
    const info = serial.connected && cfg.fw === "v2" ? cfg.info : null;
    return info ? { id: info.id, ae: info.ae, t: performance.now() - cfg.infoAge } : null;
  },
  now: () => performance.now(),
  changed: () => renderAutoEnable(),
});
function aeActive(): boolean {
  return autoEnable.view({ route: "can", id: motorId }).on || autoEnable.view({ route: "serial", id: motorId }).on;
}
/** Read-only indicator of the firmware-reported runtime AE (INFO ae=), e.g. after booting with BOOT_AE=1. */
function renderAutoEnable(): void {
  const info = serial.connected && cfg.fw === "v2" ? cfg.info : null;
  const el = $("dAe");
  // A stop sent after the last INFO wins (shows 关 immediately); the next INFO is authoritative again.
  const ae = info && (info.ae === 0 || info.ae === 1) ? (autoEnable.view({ route: "serial", id: motorId }).on ? 1 : 0) : null;
  el.classList.toggle("hidden", ae === null);
  el.classList.toggle("on", ae === 1);
  el.textContent = ae === 1 ? "自动使能：开" : "自动使能：关";
  el.dataset.ae = ae === null ? "" : String(ae);
}
async function clearFaults(): Promise<void> {
  if (!serial.connected) { toast("清除故障需要串口（原生 CAN 协议没有 CLEAR）", "err"); return; }
  await cfg.clearFaults();
}

// ---------------- fault panel ----------------
const fhex = (n: number, w = 4) => "0x" + (n >>> 0).toString(16).toUpperCase().padStart(w, "0");
/** v3 firmware "@FAULT … snap=1 fault=0x…": the fault word captured at the last new latch (history, not current). */
function snapWord(sn: FaultSnapshot): number | null {
  if (sn.kv.snap === undefined || sn.kv.fault === undefined) return null;
  const v = parseInt(sn.kv.fault, 16);
  return Number.isFinite(v) ? v : null;
}
function renderFaults(stFaults: number): void {
  const inf = cfg.fw === "v2" ? cfg.info : null;
  $("faultInfo").innerHTML = inf
    ? (inf.fault || inf.latched
      ? `<span class="chip">串口 INFO 当前 ${fhex(inf.fault)} · 锁存 ${fhex(inf.latched)}</span>` + FAULT_BITS.filter((f) => ((inf.fault | inf.latched) >>> f.bit) & 1).map((f) => `<span class="chip on" title="bit ${f.bit} ${f.name}">${f.cn}${(inf.fault >>> f.bit) & 1 ? "" : "（锁存）"}</span>`).join("")
      : `<span class="chip ok">串口 INFO：无故障</span>`)
    : "";
  const sn = cfg.fault;
  $("faultSnap").innerHTML = sn
    ? `<table class="fsnap"><tr><td>快照</td><td>${new Date(sn.t).toLocaleTimeString("zh-CN", { hour12: false })}</td></tr><tr><td>当前 / 锁存</td><td>${fhex(sn.code)} / ${fhex(sn.latched)}</td></tr>` +
      (snapWord(sn) !== null ? `<tr><td>快照故障</td><td>${sn.kv.snap === "0" ? "无快照" : fhex(snapWord(sn)!)}</td></tr>` : "") +
      `<tr><td>名称</td><td>${esc(sn.names.join(", ") || decodeFaults(sn.code | sn.latched | (snapWord(sn) ?? 0)).join("、") || "—")}</td></tr>` +
      Object.entries(sn.kv).filter(([k]) => !/^(code|active|latched|names?|fault|flags|snap)$/.test(k)).slice(0, 10).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("") + "</table>"
    : "";
  $("btnFaultRead").classList.toggle("hidden", !(cfg.fw === "v2" && cfg.features.fault));
  $("btnFaultClear").toggleAttribute("disabled", !serial.connected);
  void stFaults;
}

// ---------------- CAN discovery (passive) ----------------
function renderNodes(): void {
  const now = performance.now();
  const live = [...nodes.entries()].filter(([, n]) => now - Math.max(n.st, n.fb) < 3000).sort((a, b) => a[0] - b[0]);
  $("canNodes").innerHTML = live.length
    ? live.map(([id, n]) => `<button type="button" data-node="${id}" class="${id === motorId ? "cur" : ""}" title="状态 ${hexId(0x180 + id)}${n.fb && now - n.fb < 3000 ? " · GM 反馈 " + hexId(0x204 + id) : ""}">ID ${id} · ${now - n.st < 3000 ? String(MODE_NAMES[n.mode] ?? n.mode).split(" ")[0] : "GM"}${n.faults ? ` <span class="f">⚠${fhex(n.faults, 2)}</span>` : ""}</button>`).join("")
    : `<span class="small">${pcan && busOn ? "未发现（只监听，不发送）" : "连接 PCAN 后自动发现"}</span>`;
}

function refreshUi(): void {
  const now = performance.now();
  // Firmware may already have AE enabled (e.g. BOOT_AE); keep the feedback watchdog active.
  if (serial.connected && !serialDriving && autoEnable.view({ route: "serial", id: motorId }).on) {
    serialDriving = true; serialDrivingT = now;
  }
  const stFresh = lastStatus && now - lastStatusT < 500;
  const fbFresh = lastFb && now - lastFbT < 200;
  if (stFresh && lastStatus) {
    const pl = primaryLabel(lastStatus.mode);
    $("vMode").textContent = MODE_NAMES[lastStatus.mode] ?? String(lastStatus.mode);
    $("vPrim").textContent = fmt(lastStatus.primary, 3);
    $("vPrimL").textContent = `${pl.name} ${pl.unit}`;
    $("chPrimT").textContent = `状态主反馈 · ${pl.name} ${pl.unit}`;
    $("vFault").textContent = "0x" + lastStatus.faults.toString(16).toUpperCase().padStart(2, "0");
    $("vFault").style.color = lastStatus.faults ? "var(--danger)" : "var(--ok)";
    if (!fbFresh) $("vRpm").textContent = fmt(lastStatus.rpm, 1);
    document.querySelectorAll<HTMLButtonElement>("#modeBtns button").forEach((b) =>
      b.classList.toggle("cur", Number(b.dataset.mode) === lastStatus!.mode));
  } else {
    $("vMode").textContent = "—"; $("vPrim").textContent = "—"; $("vFault").textContent = "—"; $("vFault").style.color = "";
  }
  const faults = stFresh && lastStatus ? lastStatus.faults : -1;
  $("liveDot").className = "live" + (stFresh || fbFresh ? " on" : "");
  $("faultChips").innerHTML = faults < 0
    ? `<span class="chip">无状态帧（${hexId(nativeStatusId(motorId))}）</span>`
    : faults === 0
      ? `<span class="chip ok">无故障（低 8 位）</span>`
      : FAULT_BITS.filter((f) => f.bit < 8 && (faults >> f.bit) & 1).map((f) => `<span class="chip on" title="bit ${f.bit}">${f.cn}</span>`).join("");
  if (fbFresh && lastFb) {
    $("vRpm").textContent = String(lastFb.rpm);
    $("vAngle").textContent = fmt(lastFb.angleDeg, 1);
    $("vIq").textContent = fmt(lastFb.iq, 3);
  } else {
    if (!stFresh) $("vRpm").textContent = "—";
    $("vAngle").textContent = "—"; $("vIq").textContent = "—";
  }
  $("vRates").textContent = `状态帧 ${rateShown.st}/s · GM 反馈 ${rateShown.fb}/s · CAN RX ${rateShown.rx}/s · TX ${rateShown.tx}/s · 串口 JustFloat ${rateShown.uart}/s`;
  $("stSerFrames").textContent = serial.connected ? `${rateShown.uart} 帧/s · 累计 ${cfg.parser.frames}` : "—";
  if (lastUart) for (let k = 0; k < Math.min(lastUart.length, uartDefs.length); k++) { const el = document.getElementById("uv" + k); if (el) el.textContent = fmt(lastUart[k]!, 4); }
  renderFaults(faults);
  $("sumCan").textContent = pcan && busOn ? `CAN ${$("stPcanBus").textContent}` : "CAN 未连接";
  $("sumCanDot").className = $("dotPcan").className;
  $("sumSer").textContent = serial.connected ? `串口 ${$("stFw").textContent === "—" ? "已连接" : $("stFw").textContent}` : "串口未连接";
  $("sumSerDot").className = $("dotSer").className;
  if (gmTimer) $("gmState").textContent = `运行中 · 已发送 ${gmSent} 帧 · 目标 ${gmTarget().toFixed(3)} A${gmArm > 0 ? " · 握手中" : ""}`;
  $("recInfo").textContent = rec.on ? `记录中… ${rec.rows.length} 行` : rec.rows.length ? `已记录 ${rec.rows.length} 行，可下载` : "未记录";
  renderAutoEnable();
  const pref = $<HTMLSelectElement>("dLink").value;
  const connected = pref === "can" ? busOn : pref === "serial" ? serial.connected : busOn || serial.connected;
  const connectButton = $("dConnect");
  const connectLabel = connected ? "断开" : pref === "serial" ? "连接串口" : pref === "can" ? "连接 CAN" : "连接";
  connectButton.querySelector<HTMLElement>(".conn-label")!.textContent = connectLabel;
  connectButton.querySelector<HTMLElement>(".conn-dot")!.classList.toggle("on", connected);
  connectButton.dataset.shortLabel = connected ? "断开" : "连接";
  connectButton.setAttribute("aria-label", connectLabel);
  connectButton.title = `${connectLabel}（自动：优先 PCAN，否则串口）`;
  $("dConnect").classList.toggle("ghost", connected);
  $("dConnect").toggleAttribute("disabled", !!stopTask || !!emergencyTask || switchingNode);
  renderLog();
}

function init(): void {
  initCharts();
  buildParams();
  buildUartVals();
  $<HTMLSelectElement>("motorId").value = String(motorId);
  setMotorId(motorId);

  if (!navigator.usb) { $("pcanConnect").toggleAttribute("disabled", true); $("stPcanBus").textContent = "浏览器不支持 WebUSB"; }
  if (!("serial" in navigator)) { $("serConnect").toggleAttribute("disabled", true); $("stSer").textContent = "浏览器不支持 Web Serial"; }

  $("pcanConnect").addEventListener("click", () => void pcanConnect());
  $("pcanDisconnect").addEventListener("click", () => void pcanDisconnect(true));
  $("serConnect").addEventListener("click", () => void serConnect());
  $("serDisconnect").addEventListener("click", () => void serDisconnect(true));
  $("motorId").addEventListener("change", (e) => void changeMotorId(Number((e.target as HTMLSelectElement).value)));

  // views
  $("views").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button[data-view]") as HTMLButtonElement | null;
    if (!b) return;
    if (activeAudioSession) void safeStop("切换页面，停止 AUDIO");
    document.querySelectorAll("#views button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + b.dataset.view));
    b.scrollIntoView({ block: "nearest", inline: "nearest" });
    logDirty = true;
    Object.values(charts).forEach((c) => c.markDirty());
    if (b.dataset.view === "cfg") void renderLogs();
  });
  $("canNodes").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button[data-node]") as HTMLButtonElement | null;
    if (!b) return;
    e.preventDefault(); // inside <summary>: don't toggle the link panel
    const id = Number(b.dataset.node);
    void changeMotorId(id);
  });
  $("btnFaultClear").addEventListener("click", () => void clearFaults());
  $("btnFaultRead").addEventListener("click", () => void cfg.readFault());
  $("logRefresh").addEventListener("click", () => void renderLogs());
  $("logDelAll").addEventListener("click", async () => {
    if (!confirm("删除日志库中的全部记录？")) return;
    await clearLogs(); void renderLogs();
  });
  $("logList").addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const dl = t.closest("button[data-dl]") as HTMLButtonElement | null;
    const del = t.closest("button[data-del]") as HTMLButtonElement | null;
    if (dl) { const r = await getLog(Number(dl.dataset.dl)); if (r) download(r.name, r.csv); }
    if (del) { await deleteLog(Number(del.dataset.del)); void renderLogs(); }
  });
  const autoRe = $("autoRe") as HTMLInputElement;
  autoRe.checked = readStored("dr4310.autoReconnect") === "1";
  autoRe.addEventListener("change", () => writeStored("dr4310.autoReconnect", autoRe.checked ? "1" : "0"));
  if (autoRe.checked) void autoReconnect();

  document.querySelectorAll("details").forEach((el) => el.addEventListener("toggle", () => {
    Object.values(charts).forEach((c) => c.markDirty());
  }));

  // tabs
  $("tabs").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button[data-tab]") as HTMLButtonElement | null;
    if (!b) return;
    document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + b.dataset.tab));
    b.scrollIntoView({ block: "nearest", inline: "nearest" });
    logDirty = true;
    Object.values(charts).forEach((c) => c.markDirty());
  });

  // native
  $("modeBtns").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button[data-mode]") as HTMLButtonElement | null;
    if (!b) return;
    const m = Number(b.dataset.mode);
    if (m === 0) { void safeStop("调试停止"); return; }
    if (m === 3 && !alignDebugPosition("pos")) return;
    void dash.halt("", false); stopAllPeriodic(); controlEpoch++; pcan?.cancelPending();
    if (m === 3 || m === 4) void (async () => {
      const epoch = controlEpoch;
      const ok = m === 3 ? await sendGainFrame("pos") : await mitSend();
      if (ok && epoch === controlEpoch) await sendNative(nativeSetMode(m), `切换模式 ${MODE_NAMES[m]}`);
    })();
    else void sendNative(nativeSetMode(m), `切换模式 ${MODE_NAMES[m]}`);
  });
  bindPair("nIq", "rIq", () => liveSend("iq"));
  bindPair("nSpd", "rSpd", () => liveSend("spd"));
  bindPair("nPos", "rPos", () => liveSend("pos"));
  initGainPanel("spd");
  initGainPanel("pos");
  $("sendIq").addEventListener("click", () => void sendTarget("iq"));
  $("sendSpd").addEventListener("click", () => void sendTarget("spd"));
  $("sendPos").addEventListener("click", () => void sendTarget("pos"));
  $("paramAll").addEventListener("click", async () => {
    for (const p of PARAMS) { if (p.id === 0x03 && num("par_" + p.key) <= 0) continue; if (!(await sendParam(p.key))) break; }
  });
  $("paramReset").addEventListener("click", () => {
    PARAMS.forEach((p) => { ($("par_" + p.key) as HTMLInputElement).value = String(p.def); });
    writeStored("dr4310.params", null);
  });
  ["mP", "mV", "mKp", "mKd", "mT"].forEach((id) => $(id).addEventListener("input", mitPreview));
  $("mitEnter").addEventListener("click", () => { void dash.halt("", false); stopAllPeriodic(); controlEpoch++; pcan?.cancelPending(); void mitSend(); });
  $("mitSend").addEventListener("click", () => { void dash.halt("", false); stopAllPeriodic(); controlEpoch++; pcan?.cancelPending(); void mitSend(); });
  $("mitPeriodic").addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    if (mitTimer) { clearInterval(mitTimer); mitTimer = 0; }
    if (!on) return;
    if (!pcan || !busOn) { toast("PCAN 未连接", "err"); stopMitPeriodic(); return; }
    void dash.halt("", false); controlEpoch++; pcan.cancelPending();
    stopGainPeriodic();
    const period = Math.max(5, num("mitPeriod") || 10);
    let busy = false;
    mitTimer = window.setInterval(async () => {
      if (busy) return; busy = true;
      try { if (!(await mitSend())) stopMitPeriodic(); } finally { busy = false; }
    }, period);
  });
  $("dLink").addEventListener("change", () => { if (aeActive()) void safeStop("切换链路"); });
  $("dLink").addEventListener("change", () => refreshUi());
  $("dModes").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-dmode]");
    if (b && b.dataset.dmode !== dash.mode && aeActive()) void safeStop("切换模式");
  });
  $("dConnect").addEventListener("click", async () => {
    const pref = $<HTMLSelectElement>("dLink").value;
    const disconnect = pref === "can" ? busOn : pref === "serial" ? serial.connected : busOn || serial.connected;
    if (disconnect) {
      await safeStop("断开连接");
      if (pref !== "serial") await pcanDisconnect(false);
      if (pref !== "can") await serDisconnect(false);
    } else if (pref === "serial" || pref === "auto" && !navigator.usb) await serConnect();
    else await pcanConnect();
  });

  // GM
  bindPair("gmA", "gmR", gmPreview);
  $("gmStart").addEventListener("click", startGmLoop);
  $("gmStop").addEventListener("click", () => stopGmLoop(true));
  $("gmZero").addEventListener("click", () => { const f = encodeGmCurrent(motorId, 0); void sendCan(f.id, f.data, "GM 零帧"); });

  // AUDIO UI
  audioUi = initAudioUI({
    start: audioStart,
    pause: () => activeAudioSession?.pause() ?? Promise.resolve(),
    resume: () => activeAudioSession?.resume() ?? Promise.resolve(),
    stop: () => safeStop("电机音乐停止"),
    connected: () => serial.connected,
    firmware: () => cfg.fw === "v2" ? "固件已识别 · AUDIO V1 需 INFO 探测" : "旧固件 / 未识别",
  });

  // UART
  document.querySelectorAll<HTMLButtonElement>("button[data-u]").forEach((b) =>
    b.addEventListener("click", () => { if (b.dataset.u === "STOP") void safeStop("串口停止"); else void serSend(asciiCommand(b.dataset.u!)); }));
  $("uCalib").addEventListener("click", () => {
    if (($("wdConfirm") as HTMLInputElement).checked && !confirm(
      "电角度标定会施加开环 d 轴电压，转子定位并缓慢转动约 10 秒，完成后写入 Flash。\n\n" +
      "请确认：电机空载可自由转动、周围无人手/工具、CAN 上无其他主机发送非零命令。\n\n确定开始标定？")) return;
    void (async () => { const stopping = safeStop("标定前停机"), epoch = controlEpoch; await stopping; if (epoch === controlEpoch && !stopTask && !emergencyTask) await serSend("CALIB\n", "电角度标定"); })();
  });
  const sendU = (name: string, id: string, lo?: number, hi?: number) => {
    let v = num(id);
    if (!Number.isFinite(v)) { toast("数值无效", "err"); return; }
    if (lo !== undefined && hi !== undefined) v = clamp(v, lo, hi);
    void serSend(asciiCommand(name, v));
  };
  $("uIqSend").addEventListener("click", () => sendU("IQ", "uIq", -LIMITS.currentA, LIMITS.currentA));
  $("uKpSend").addEventListener("click", () => sendU("KP", "uKp", 0, UART_LIMITS.kpMax));
  $("uKiSend").addEventListener("click", () => sendU("KI", "uKi", 0, UART_LIMITS.kiMax));
  const custom = () => {
    const s = ($("uCustom") as HTMLInputElement).value.trim();
    if (!s) return;
    if (s.length > 47) { toast("命令过长（固件上限 47 字符）", "err"); return; }
    if (/^CALIB/i.test(s) && ($("wdConfirm") as HTMLInputElement).checked && !confirm("确定发送标定命令？")) return;
    void serSend(s + "\n");
  };
  $("uCustomSend").addEventListener("click", custom);
  $("uCustom").addEventListener("keydown", (e) => { if (e.key === "Enter") custom(); });

  // charts / record / log
  $("chWin").addEventListener("change", (e) => {
    const w = Number((e.target as HTMLSelectElement).value);
    Object.values(charts).forEach((c) => { c.windowSec = w; c.markDirty(); });
  });
  $("chPause").addEventListener("click", () => {
    const p = !chRpm.paused;
    Object.values(charts).forEach((c) => c.setPaused(p));
    $("chPause").textContent = p ? "继续" : "暂停";
  });
  $("chClear").addEventListener("click", () => Object.values(charts).forEach((c) => c.clear()));
  $("recBtn").addEventListener("click", () => (rec.on ? stopRec() : startRec()));
  $("recSave").addEventListener("click", saveRec);
  $("logPause").addEventListener("click", () => { logPaused = !logPaused; $("logPause").textContent = logPaused ? "继续" : "暂停"; });
  $("logClear").addEventListener("click", () => { logRows = []; logDirty = true; renderLog(); });
  $("logHide1k").addEventListener("change", () => { logDirty = true; });
  $("logHideStatus").addEventListener("change", () => { logDirty = true; });

  // E-stop
  $("estop").addEventListener("click", () => void estop());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") void estop(); });

  // watchdog
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    dash.stopWave();
    if (activeAudioSession || ($("wdHidden") as HTMLInputElement).checked) void safeStop("页面隐藏");
  });
  window.addEventListener("pagehide", () => {
    if (activeAudioSession || ($("wdHidden") as HTMLInputElement).checked) void safeStop("页面关闭");
  });
  navigator.usb?.addEventListener("connect", (ev: USBConnectionEvent) => {
    if (autoRe.checked && !pcan && ev.device.vendorId === 0x0c72) void pcanOpen(ev.device, true);
  });
  navigator.usb?.addEventListener("disconnect", (ev: USBConnectionEvent) => {
    if (pcan && ev.device === pcan.device) {
      void safeStop("PCAN 已拔出");
      stopGmLoop(false); stopAllPeriodic();
      pcan = null; busOn = false;
      void pcanDisconnect(false);
      toast("PCAN 已拔出！电机可能仍在运行（原生协议无超时）—— 请用硬件急停", "err");
    }
  });
  if ("serial" in navigator) {
    navigator.serial.addEventListener("disconnect", (ev: Event) => {
      if (serial.port && (ev.target === serial.port || (ev as Event & { port?: SerialPort }).port === serial.port)) { void safeStop("串口已拔出"); void serial.close(); lastUart = null; serUi(false); cfg.onClosed(); toast("串口设备已拔出", "err"); }
    });
  }

  setInterval(() => {
    Object.assign(rateShown, rate);
    rate.st = rate.fb = rate.rx = rate.tx = rate.uart = 0;
  }, 1000);
  setInterval(refreshUi, 100);
  setInterval(() => audioUi?.refresh(), 500);
  setInterval(renderNodes, 500);
  dash.init();
  setInterval(() => cfg.refreshUi(), 250);
  cfg.init((reason) => safeStop(reason));
  setInterval(() => {
    const now = performance.now();
    if (!activeAudioSession && (canDriving && now - canDrivingT > 1500 && !meas("can").fresh || serialDriving && now - serialDrivingT > 2500 && !meas("serial").fresh)) void safeStop("反馈中断");
  }, 100);
  cfg.refreshUi();
  initTheme(() => Object.values(charts).forEach((c) => c.markDirty()));
  refreshUi();
}

async function autoReconnect(): Promise<void> {
  try {
    if (navigator.usb && !pcan) {
      const devs = (await navigator.usb.getDevices()).filter((d) => d.vendorId === 0x0c72);
      if (devs[0]) await pcanOpen(devs[0], true);
    }
  } catch (e) { toast("PCAN 自动连接失败：" + errMsg(e), "err"); }
  try {
    if ("serial" in navigator && !serial.connected) {
      const ports = await navigator.serial.getPorts();
      if (ports[0]) await serConnect(ports[0]);
    }
  } catch (e) { toast("串口自动连接失败：" + errMsg(e), "err"); }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
