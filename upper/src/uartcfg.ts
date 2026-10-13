/**
 * 参数配置 view over Web Serial (@-reply protocol, docs/UART_PROTOCOL.md):
 * auto-connect probe (PING → INFO → HELP → GET → TLIST/TCH/TRATE/FAULT when supported),
 * pages 电机参数 / 驱动参数 / 通信参数 / 数据存储 / 其他 rendered from the firmware's @P lines,
 * 同步 (SET changed + SAVE), 重置 (DEFAULTS), SETZERO, telemetry channel picker, fault snapshot,
 * parameter profile import/export. Older firmware (JustFloat only, no replies) is detected as legacy.
 */
import { createTelemetryTransactions, type TelemetryScope } from "./uartcfg-transaction";
import type { SerialLink } from "./serial";
import {
  CFG_SOURCE_NAMES, PARAM_GROUPS, PARAM_META, PARAM_PAGES, UartStreamParser, checkOverlimitIq, checkParam, cmdGet, cmdSet, errText,
  formatOverlimit, metaFor, overlimitAvailable, overlimitFieldsEnabled, paramWriteOrder, parseInfo, parseReply, replyKeyFor, type DeviceInfo, type ParamPage, type Reply,
} from "./uartcfg-protocol";
import {
  LEGACY_CHANNELS, NO_FEATURES, cmdTch, cmdTchNames, makeProfile, parseChannelLine, parseChannelListText, parseFault, parseHelp,
  parseSetZero, parseTch, parseTrate, readProfile, versionMajor, type ChannelDef, type FaultSnapshot, type Features,
} from "./features";
import { positionCmdId, speedCmdId } from "./protocol";

export type FwState = "none" | "probing" | "v2" | "legacy" | "rebooting";
export type UartCfgHost = {
  serial: SerialLink;
  toast(text: string, kind?: "" | "ok" | "err"): void;
  log(dir: "TX" | "RX", text: string, note: string, poll: boolean): void;
  rec(dir: "tx" | "rx", text: string): void;
  confirmOn(): boolean;
  onFrame(fr: Float32Array, now: number): void;
  onChannels(defs: ChannelDef[]): void;
  onFault(s: FaultSnapshot): void;
  onParams(): void;
  hostSettings(): Record<string, unknown>;
  applyHostSettings(o: Record<string, unknown>): void;
};

export type Result = { ok: boolean; reply?: Reply; err?: string; params: Reply[]; lines: Reply[]; timeout?: boolean; blind?: boolean };
type Job = { line: string; key: string; note: string; poll: boolean; timeout: number; resolve: (r: Result) => void; params: Reply[]; lines: Reply[]; timer: number; done: boolean };
export type DevParam = { value: number; min: number; max: number; reboot: boolean };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hex3 = (n: number) => "0x" + n.toString(16).toUpperCase();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const PAGES: ParamPage[] = ["motor", "drive", "comm", "other"];
const GROUP_ORDER = Object.keys(PARAM_GROUPS);
const EMPTY_HINT: Record<ParamPage, string> = {
  motor: "需 v3 固件",
  drive: "暂无参数。", comm: "暂无参数。", other: "",
};

export function createUartCfg(h: UartCfgHost) {
  const parser = new UartStreamParser();
  let fw: FwState = "none";
  let info: DeviceInfo | null = null;
  let infoT = 0;
  const getInfo = (): DeviceInfo | null => info;
  let missedPolls = 0;
  const devParams = new Map<string, DevParam>();
  let renderedSig = "";
  let rebootNeeded = false;
  let unsaved = false;
  let features: Features = NO_FEATURES();
  let catalogue: ChannelDef[] = [];
  /** v3 firmware: TCH takes exactly 16 channel names (TLIST answered with one @TLIST name list). */
  let tchByName = false;
  let canFbWarned = false;
  const TCH_SLOTS = 16;
  let channels: ChannelDef[] = LEGACY_CHANNELS;
  let trate = NaN;
  let lastFault: FaultSnapshot | null = null;
  let page: ParamPage | "store" = "drive";
  const rate = { lines: 0 }, rateShown = { lines: 0 };
  const queue: Job[] = [];
  let inflight: Job | null = null;
  let generation = 0;
  let audioExclusive = false;

  parser.onChannels = (n) => {
    if (channels.length === n) return;
    setChannels(n === 16 ? LEGACY_CHANNELS : Array.from({ length: n }, (_, i) => catalogue.length ? { ...(catalogue[i] ?? { name: "CH" + i, unit: "" }), idx: i } : { idx: i, name: "CH" + i, unit: "" }), false);
  };
  function setChannels(defs: ChannelDef[], setParser = true): void {
    channels = defs.map((d, i) => ({ ...d, idx: i }));
    if (setParser) parser.setChannels(channels.length);
    h.onChannels(channels);
  }

  // ---------- request / reply ----------
  function enqueueRequest(line: string, o: { note?: string; poll?: boolean; timeout?: number } = {}): Promise<Result> {
    return new Promise((resolve) => {
      if (audioExclusive) { resolve({ ok: false, err: "AUDIO 独占期间禁止配置/遥测命令", params: [], lines: [] }); return; }
      if (!h.serial.connected) { resolve({ ok: false, err: "串口未连接", params: [], lines: [] }); return; }
      queue.push({ line, key: replyKeyFor(line), note: o.note ?? "", poll: !!o.poll, timeout: o.timeout ?? 1000, resolve, params: [], lines: [], timer: 0, done: false });
      pump();
    });
  }
  function request(line: string, o: { note?: string; poll?: boolean; timeout?: number } = {}): Promise<Result> {
    // Includes GET typed in the serial command field, not just the parameter toolbar.
    if (/^GET(?:\s|$)/i.test(line.trim())) {
      return withTelemetryPaused(() => enqueueRequest(line, o), { ok: false, err: "参数读取失败", params: [], lines: [] } as Result);
    }
    return enqueueRequest(line, o);
  }
  function finish(job: Job, r: Omit<Result, "params" | "lines">): void {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    if (inflight === job) inflight = null;
    job.resolve({ ...r, params: job.params, lines: job.lines });
    pump();
  }
  function pump(): void {
    if (audioExclusive || inflight || !queue.length) return;
    const job = queue.shift()!;
    inflight = job;
    h.log("TX", job.line.trim(), job.note, job.poll);
    h.rec("tx", job.line.trim());
    h.serial.writeText(job.line).then(() => {
      if (job.done || inflight !== job) return;
      if (fw === "legacy") { finish(job, { ok: true, blind: true }); return; }
      job.timer = window.setTimeout(() => finish(job, { ok: false, timeout: true, err: "无应答" }), job.timeout);
    }, (e) => finish(job, { ok: false, err: "发送失败：" + errMsg(e) }));
  }
  function cancelQueued(reason: string): void {
    while (queue.length) { const job = queue.shift()!; job.done = true; job.resolve({ ok: false, err: reason, params: [], lines: [] }); }
  }
  function cancelPending(reason: string): void {
    cancelQueued(reason);
    if (inflight) finish(inflight, { ok: false, err: reason });
  }

  function onLine(line: string): void {
    rate.lines++;
    const r = parseReply(line);
    h.rec("rx", line);
    const job = inflight;
    const poll = !!job?.poll && (r.type === "PONG" || r.type === "INFO");
    h.log("RX", line, r.type === "ERR" ? errText(r.text) : "", poll);
    if (r.type === "UNKNOWN") return;
    if (fw === "probing" || fw === "legacy" || fw === "rebooting") {
      if (fw === "legacy") h.toast("检测到串口应答：固件支持串口设置", "ok");
      fw = "v2";
    }
    missedPolls = 0;
    if (r.type === "INFO") {
      info = parseInfo(r.kv); infoT = performance.now();
      if (r.kv.can_fb === "1" && !canFbWarned) { canFbWarned = true; h.toast(`CAN 波特率回退：固件保存 ${r.kv.baud ?? "?"} bps 初始化失败，当前 1 Mbps`, "err"); }
      if (info.fault) h.onFault({ code: info.fault, latched: info.latched, names: [], kv: r.kv, t: Date.now() });
    }
    if (r.type === "P") {
      devParams.set(r.key, { value: r.value, min: r.min, max: r.max, reboot: r.reboot });
      if (job && job.key === "GET") job.params.push(r); else updateParamRow(r.key);
      return;
    }
    if (r.type === "EVT") {
      if (r.cmd === "TIMEOUT") h.toast("固件命令超时，已自动停机（TIMEOUT_MS）", "err");
      // v3.0.1: "@EVT CAN_BAUD fallback live=1000000" — stored CAN baud failed to init, running at 1 Mbps
      if (r.cmd === "CAN_BAUD") h.toast(`CAN 波特率初始化失败，已回退 ${r.kv.live ?? "1000000"} bps（检查 CAN_BAUD 后同步 + 重启）`, "err");
      return;
    }
    if (r.type === "TAG") {
      if (r.cmd === "FAULT") {
        lastFault = parseFault(r);
        h.onFault(lastFault);
        if (job && job.key === "FAULT") finish(job, { ok: true, reply: r });
        return;
      }
      if (job) job.lines.push(r);
      // v3 firmware answers TLIST / TCH (query) with ONE "@TLIST a,b,…" / "@TCH a,b,…" line and no @OK
      if (job && job.key === r.cmd && (r.cmd === "TLIST" || r.cmd === "TCH") && r.text.includes(",")) finish(job, { ok: true, reply: r });
      return;
    }
    const key = r.type === "PONG" ? "PONG" : r.type === "INFO" ? "INFO" : r.cmd;
    if (job && job.key === key) { finish(job, { ok: r.type !== "ERR", reply: r, err: r.type === "ERR" ? errText(r.text) : undefined }); return; }
    if (r.type === "OK" && r.cmd === "CALIB" && /done/.test(r.text)) { h.toast("标定完成，已保存到 Flash", "ok"); void refreshInfo(); }
    if (r.type === "ERR" && r.cmd === "CALIB") h.toast("标定失败：" + errText(r.text), "err");
  }

  function onData(chunk: Uint8Array): void {
    if (audioExclusive) return;
    const { frames, lines } = parser.push(chunk);
    const now = performance.now();
    for (const fr of frames) h.onFrame(fr, now);
    for (const l of lines) onLine(l);
  }

  async function rawRun(line: string, note = "", o: { quiet?: boolean; timeout?: number } = {}): Promise<Result> {
    if (!h.serial.connected) { if (!o.quiet) h.toast("串口未连接", "err"); return { ok: false, err: "串口未连接", params: [], lines: [] }; }
    const r = await request(line, { note, timeout: o.timeout });
    $("cfgLast").textContent = `上次：${line.trim()} → ${r.blind ? "已发送（无应答）" : r.ok ? "OK" : r.err}`;
    if (!r.ok && !o.quiet) h.toast(`${line.trim()}：${r.err ?? "失败"}`, "err");
    return r;
  }

  async function run(line: string, note = "", o: { quiet?: boolean; timeout?: number } = {}): Promise<Result> {
    // Also protect parameter commands typed in the debug serial command field.
    if (/^(SET|SAVE)(?:\s|$)/i.test(line.trim())) {
      return withTelemetryPaused(async (transaction) => {
        if (/^SAVE(?:\s|$)/i.test(line.trim())) await transaction.restore();
        const r = await rawRun(line, note, o);
        const telem = /^SET\s+TELEM\s+(?:=\s*)?([01])\s*$/i.exec(line.trim());
        if (r.ok && telem) {
          const value = Number(telem[1]);
          transaction.setRestoreValue(value);
          if (info) info.telem = value;
          const d = devParams.get("TELEM");
          if (d) { d.value = value; updateParamRow("TELEM", false); }
        }
        return r;
      }, { ok: false, err: "参数操作失败", params: [], lines: [] } as Result);
    }
    return rawRun(line, note, o);
  }

  const telemetryTransaction = createTelemetryTransactions({
    captureSession: () => {
      const session = generation;
      return () => session === generation && h.serial.connected;
    },
    current: () => Number.isFinite(info?.telem) ? info!.telem : devParams.get("TELEM")?.value ?? null,
    run: (line) => rawRun(line, line.includes("TELEM 0") ? "暂停遥测" : "恢复遥测"),
    restored: (value) => {
      if (info) info.telem = value;
      const d = devParams.get("TELEM");
      if (d) { d.value = value; updateParamRow("TELEM", false); }
    },
  });
  async function withTelemetryPaused<T>(operation: (scope: TelemetryScope) => Promise<T>, fallback: T, scope?: TelemetryScope): Promise<T> {
    try { return await telemetryTransaction(operation, scope); }
    catch (e) { h.toast(errMsg(e), "err"); return fallback; }
  }

  // ---------- connect / probe (auto-connect flow) ----------
  /** Call before SerialLink.open(): the read loop starts inside open(). */
  function prepare(): void {
    audioExclusive = false;
    generation++; cancelPending("重新连接");
    parser.reset(); parser.setChannels(16); channels = LEGACY_CHANNELS; h.onChannels(channels);
    info = null; lastFault = null; devParams.clear(); features = NO_FEATURES(); catalogue = [];
    missedPolls = 0; unsaved = false; rebootNeeded = false;
  }
  async function onOpened(): Promise<void> { await probe(); }
  async function probe(): Promise<void> {
    const session = generation;
    const current = () => session === generation && h.serial.connected;
    fw = "probing";
    features = NO_FEATURES();
    devParams.clear(); renderParams();
    await sleep(150);
    if (!current()) return;
    await request("PING\n", { note: "连接握手", timeout: 500 });
    for (let i = 0; i < 3 && current(); i++) {
      const r = await request("INFO\n", { note: "识别固件", timeout: 700 });
      if (!current()) return;
      if (r.ok) {
        fw = "v2";
        features.major = versionMajor(info?.ver);
        const help = await request("HELP\n", { note: "读取命令表", timeout: 700 });
        if (!current()) return;
        if (help.ok && help.reply && help.reply.type === "OK") {
          const cmds = parseHelp(help.reply.text);
          features.help = true;
          features.tlist = cmds.has("TLIST"); features.tch = cmds.has("TCH"); features.trate = cmds.has("TRATE");
          features.fault = cmds.has("FAULT"); features.setzero = cmds.has("SETZERO");
        }
        await getAll(true);
        if (!current()) return;
        features.keys = new Set(devParams.keys());
        if (features.keys.has("ZERO_OFFSET")) features.setzero = true;
        if (features.tlist) await readTelemetryConfig();
        if (!current()) return;
        if (features.fault) await readFault(true);
        if (!current()) return;
        const extra = [features.tlist && "遥测通道", features.fault && "故障快照", features.setzero && "设零"].filter(Boolean).join(" / ");
        $("stFw").title = `CAN ID ${info?.id ?? "?"} · ${devParams.size} 个参数${extra ? " · " + extra : ""}`;
        h.toast("串口已连接", "ok");
        h.onParams();
        return;
      }
    }
    if (!current()) return;
    fw = "legacy";
    h.toast(parser.frames > 0 ? "串口：收到 JustFloat 但无应答 → 旧固件（参数配置不可用，仪表盘仅电流模式）" : "串口：没有收到任何数据，检查接线 / 波特率 / 电源", parser.frames > 0 ? "" : "err");
  }
  function onClosed(): void {
    audioExclusive = false;
    generation++;
    fw = "none"; info = null;
    cancelPending("串口已断开");
    devParams.clear(); features = NO_FEATURES(); lastFault = null; tchByName = false; canFbWarned = false;
    renderParams();
  }
  async function refreshInfo(): Promise<boolean> {
    if (fw !== "v2") return false;
    return (await request("INFO\n", { poll: true })).ok;
  }

  // ---------- telemetry channels (v3) ----------
  async function readTelemetryConfig(): Promise<void> {
    const tl = await request("TLIST\n", { note: "读取遥测通道表", timeout: 1500 });
    tchByName = tl.ok && tl.reply?.type === "TAG";
    if (tl.ok) {
      let cat = tl.lines.map((l) => (l.type === "TAG" ? parseChannelLine(`@${l.cmd} ${l.text}`) : null)).filter((d): d is ChannelDef => !!d);
      if (!cat.length && (tl.reply?.type === "OK" || tl.reply?.type === "TAG")) cat = parseChannelListText(tl.reply.text);
      catalogue = cat.sort((a, b) => a.idx - b.idx);
    } else features.tlist = false;
    if (features.tch) {
      const r = await request("TCH\n", { note: "读取当前遥测通道", timeout: 800 });
      const defs = r.ok && r.reply ? parseTch(r.reply, catalogue) : null;
      if (defs && defs.length) setChannels(defs);
      else if (!r.ok) features.tch = false;
    }
    if (features.trate) {
      const r = await request("TRATE\n", { note: "读取遥测频率", timeout: 800 });
      trate = r.ok && r.reply ? parseTrate(r.reply) : NaN;
      if (!r.ok) features.trate = false;
    }
    renderTelemetry();
  }
  function renderTelemetry(): void {
    const sec = $("telSec");
    const on = fw === "v2" && features.tlist && catalogue.length > 0;
    sec.classList.toggle("hidden", !on);
    $("telNone").classList.toggle("hidden", on);
    if (!on) return;
    const active = new Set(channels.map((c) => c.name.toUpperCase()));
    $("telList").innerHTML = catalogue.map((c) =>
      `<label class="telc"><input type="checkbox" value="${c.idx}" ${active.has(c.name.toUpperCase()) ? "checked" : ""}/><span class="mono">${c.idx}</span> ${esc(c.name)} <span class="small">${esc(c.unit)}</span></label>`).join("");
    $<HTMLInputElement>("telRate").value = Number.isFinite(trate) ? String(trate) : "";
    $("telRateRow").classList.toggle("hidden", !features.trate);
    $("telApply").toggleAttribute("disabled", !features.tch);
    $("telState").textContent = `当前 ${channels.length} 通道：${channels.map((c) => c.name).join(", ")}${Number.isFinite(trate) ? ` · ${trate} Hz` : ""}`;
  }
  async function applyTelemetry(): Promise<void> {
    if (!needV2()) return;
    const idx = Array.from(document.querySelectorAll<HTMLInputElement>("#telList input:checked")).map((e) => Number(e.value));
    if (!idx.length) { h.toast("至少选择 1 个通道", "err"); return; }
    if (idx.length > 16) { h.toast("最多 16 个通道", "err"); return; }
    let line: string, names: string[] | null = null;
    try {
      if (tchByName) ({ line, names } = cmdTchNames(idx, catalogue, TCH_SLOTS));
      else line = cmdTch(idx);
    } catch (e) { h.toast(errMsg(e), "err"); return; }
    const r = await run(line, "设置遥测通道");
    if (r.ok && r.reply) {
      // v3 firmware replies a bare "@OK TCH": read the active list back
      let defs = parseTch(r.reply, catalogue);
      if (!defs && names) {
        const q = await request("TCH\n", { note: "读取当前遥测通道", timeout: 800 });
        defs = q.ok && q.reply ? parseTch(q.reply, catalogue) : null;
      }
      setChannels(defs ?? (names ?? idx.map((i) => catalogue.find((c) => c.idx === i)?.name ?? "CH" + i)).map((n, k) => ({ idx: k, name: n, unit: catalogue.find((c) => c.name === n)?.unit ?? "" })));
    }
    const hz = Number($<HTMLInputElement>("telRate").value);
    if (features.trate && Number.isFinite(hz) && hz > 0 && hz !== trate) {
      const t = await run(`TRATE ${Math.round(hz)}\n`, "设置遥测频率");
      if (t.ok && t.reply) trate = parseTrate(t.reply);
    }
    renderTelemetry();
    if (r.ok) h.toast(`遥测通道已切换为 ${channels.length} 路${tchByName && idx.length < TCH_SLOTS ? `（固件固定 ${TCH_SLOTS} 路，其余自动补齐）` : ""}（RAM，同步后保存）`, "ok");
  }

  /** Position control needs a real feedback sample; default v3 telemetry omits PosRad. RAM only. */
  async function ensurePositionTelemetry(valid: () => boolean): Promise<boolean> {
    if (!valid()) return false;
    if (fw !== "v2" || !features.tch) return true; // fixed-channel firmware retains the unknown-position confirmation
    const position = catalogue.find(c => c.name.toUpperCase() === "POSRAD");
    if (!position) return true;
    const hasPosition = (defs: ChannelDef[]) => defs.some(c => c.name.toUpperCase() === "POSRAD");
    if (hasPosition(channels) && info?.telem === 1 && trate > 0) return true;
    const session = generation;
    const current = () => valid() && session === generation && h.serial.connected;
    return withTelemetryPaused(async transaction => {
      if (!current()) return false;
      const q = await request("TCH\n", { note: "确认位置反馈通道", timeout: 800 });
      if (!current()) return false;
      let defs = q.ok && q.reply ? parseTch(q.reply, catalogue) : null;
      if (!defs?.length) { h.toast("无法读取位置反馈通道，启动已取消", "err"); return false; }
      if (!hasPosition(defs)) {
        // Preserve the current slot order and electrical feedback. Replace a gain readout when available.
        const next = defs.map(c => catalogue.find(d => d.name.toUpperCase() === c.name.toUpperCase())?.idx);
        if (next.some(i => i === undefined)) return false;
        const gain = defs.findIndex(c => /^(CURKI|CURKP)$/i.test(c.name));
        next[gain >= 0 ? gain : next.length - 1] = position.idx;
        const indices = next as number[];
        const line = tchByName ? cmdTchNames(indices, catalogue, TCH_SLOTS).line : cmdTch(indices);
        const set = await request(line, { note: "加入 PosRad 位置反馈（RAM）", timeout: 800 });
        if (!current() || !set.ok) return false;
        const readback = await request("TCH\n", { note: "核对位置反馈通道", timeout: 800 });
        if (!current()) return false;
        defs = readback.ok && readback.reply ? parseTch(readback.reply, catalogue) : null;
        if (!defs?.length || !hasPosition(defs)) { h.toast("PosRad 通道核对失败，启动已取消", "err"); return false; }
      }
      setChannels(defs);
      if (trate === 0 && features.trate) {
        const rate = await request("TRATE 50\n", { note: "启用位置遥测（RAM）", timeout: 800 });
        if (!current() || !rate.ok || !rate.reply) return false;
        trate = parseTrate(rate.reply);
      }
      if (!current()) return false;
      transaction.setRestoreValue(1);
      await transaction.restore();
      if (!current()) return false;
      // A transaction that began with TELEM=0 has nothing to restore; explicitly enable feedback.
      if ((info?.telem ?? devParams.get("TELEM")?.value) !== 1) {
        const enabled = await request("SET TELEM 1\n", { note: "启用位置反馈（RAM）", timeout: 800 });
        if (!current() || !enabled.ok) return false;
        if (info) info.telem = 1;
        const param = devParams.get("TELEM");
        if (param) { param.value = 1; updateParamRow("TELEM", false); }
      }
      renderTelemetry();
      h.toast("已启用 PosRad 位置反馈（RAM）");
      return true;
    }, false);
  }

  // ---------- fault / zero ----------
  async function readFault(quiet = false): Promise<FaultSnapshot | null> {
    if (fw !== "v2" || !features.fault) return null;
    const r = quiet ? await request("FAULT\n", { note: "读取故障快照", timeout: 800 }) : await run("FAULT\n", "读取故障快照");
    return r.ok ? lastFault : null;
  }
  async function clearFaults(): Promise<boolean> {
    if (fw === "legacy") { await request("CLEAR\n", { note: "清除故障" }); return true; }
    if (!needV2()) return false;
    const r = await run("CLEAR\n", "清除故障");
    if (r.ok) { await refreshInfo(); if (features.fault) await readFault(true); h.toast("已清除锁存故障", "ok"); }
    return r.ok;
  }
  async function setZero(): Promise<boolean> {
    if (!needV2()) return false;
    if (!features.setzero) { h.toast("当前固件不支持 SETZERO", "err"); return false; }
    if (h.confirmOn() && !confirm("把电机当前位置设为零点（SETZERO）？\n位置模式 / MIT 的目标将以新零点为基准。需电机空闲。")) return false;
    const r = await run("SETZERO\n", "设零");
    if (!r.ok || !r.reply) return false;
    const z = parseSetZero(r.reply);
    if (devParams.has("ZERO_OFFSET")) await request(cmdGet("ZERO_OFFSET"), { note: "回读零点", timeout: 800 }).then(() => updateParamRow("ZERO_OFFSET"));
    unsaved = true;
    h.toast(`已设零${Number.isFinite(z) ? `（零点偏移 ${z} rad）` : ""}。需要断电保留请点“同步”保存`, "ok");
    return true;
  }

  // ---------- settings rendering ----------
  function fmtVal(key: string, v: number): string {
    if (!Number.isFinite(v)) return "—";
    return metaFor(key).int ? String(Math.round(v)) : String(Number(v.toPrecision(6)));
  }
  function rowHtml(key: string, d: DevParam): string {
    const p = metaFor(key, d.min, d.max, d.reboot);
    const reboot = d.reboot || p.reboot;
    const lo = Number.isFinite(d.min) ? d.min : p.min, hi = Number.isFinite(d.max) ? d.max : p.max;
    return `<tr class="prow${key === "BOOT_AE" || p.hidden ? " hidden" : ""}" id="pr_${key}"><td title="${esc(key + (p.note ? " · " + p.note : ""))}">${esc(p.name)} <span class="modified-label">已修改</span>${reboot ? ' <span class="badge" title="重启生效">重启生效</span>' : ""}</td>` +
      `<td class="mono small">${key}</td><td class="dev" data-label="当前值" id="pd_${key}">—</td>` +
      `<td data-label="新值"><input type="number" id="pv_${key}" aria-label="${esc(p.name)}" step="${p.int ? 1 : "any"}"${Number.isFinite(lo) ? ` min="${lo}"` : ""}${Number.isFinite(hi) ? ` max="${hi}"` : ""}/></td>` +
      `<td class="small" data-label="单位 / 范围">${esc(p.unit)} <span class="mono" id="pg_${key}">${Number.isFinite(lo) && Number.isFinite(hi) ? `[${lo}, ${hi}]` : ""}</span>${key === "POS_VFF" ? '<br><span>0 关闭 · 1 全量</span>' : ""}</td>` +
      `<td><button type="button" class="ghost" title="仅写入本项到 RAM，断电不保留" data-set="${key}">写入</button></td></tr>`;
  }
  /** Rebuild tables when the key set changes (GET order, grouped by page/group). */
  function renderParams(): void {
    const keys = [...devParams.keys()];
    const sig = keys.join(",");
    if (sig === renderedSig && keys.length) return;
    renderedSig = sig;
    const byPage: Record<ParamPage, string[]> = { motor: [], drive: [], comm: [], other: [] };
    for (const k of keys) byPage[metaFor(k).page].push(k);
    const metaIdx = (k: string) => { const i = PARAM_META.findIndex((p) => p.key === k); return i < 0 ? 1e6 + keys.indexOf(k) : i; };
    for (const pg of PAGES) {
      const list = byPage[pg].sort((a, b) => GROUP_ORDER.indexOf(metaFor(a).group) - GROUP_ORDER.indexOf(metaFor(b).group) || metaIdx(a) - metaIdx(b));
      let html = "", group = "";
      for (const k of list) {
        const g = metaFor(k).group;
        // Hidden rows (BOOT_*, GEAR_RATIO) keep their inputs for 同步 but get no group header of their own.
        if (g !== group && !metaFor(k).hidden) { group = g; html += `<tr class="gh"><td colspan="6">${esc(PARAM_GROUPS[g])}</td></tr>`; }
        html += rowHtml(k, devParams.get(k)!);
      }
      if (!list.some((k) => !metaFor(k).hidden)) html += `<tr><td colspan="6" class="small empty">${fw === "v2" ? EMPTY_HINT[pg] : "连接串口"}</td></tr>`;
      $("cfgBody_" + pg).innerHTML = html;
      for (const k of list) { $("pv_" + k).addEventListener("input", () => markRow(k)); updateParamRow(k); }
    }
    $("cfgTab_other").classList.toggle("hidden", byPage.other.length === 0);
    $("cfgPage_other").classList.toggle("hidden", byPage.other.length === 0);
    if (page === "other" && !byPage.other.length) showPage("drive");
  }
  function markRow(key: string): void {
    const d = devParams.get(key);
    const el = document.getElementById("pv_" + key) as HTMLInputElement | null;
    if (!el) return;
    $("pr_" + key).classList.toggle("mod", !!d && el.value !== "" && Number(el.value) !== Number(fmtVal(key, d.value)));
  }
  function updateParamRow(key: string, setInput = true): void {
    const d = devParams.get(key);
    if (!d) return;
    if (!document.getElementById("pd_" + key)) { renderParams(); if (!document.getElementById("pd_" + key)) return; }
    $("pd_" + key).textContent = fmtVal(key, d.value);
    if (Number.isFinite(d.min) && Number.isFinite(d.max)) $("pg_" + key).textContent = `[${d.min}, ${d.max}]`;
    if (setInput) $<HTMLInputElement>("pv_" + key).value = fmtVal(key, d.value);
    markRow(key);
  }
  const modifiedKeys = () => [...devParams.keys()].filter((k) => document.getElementById("pr_" + k)?.classList.contains("mod"));
  function needV2(): boolean {
    if (fw === "v2") return true;
    h.toast(fw === "legacy" ? "当前固件没有串口设置功能（旧固件）。请烧录合并版固件 4310_G431KBT6_CurrentAccelLoop_uartcfg" : "请先在「链路」里连接串口", "err");
    return false;
  }
  async function getAll(quiet = false): Promise<boolean> {
    if (!needV2()) return false;
    const r = await request(cmdGet(), { note: "读取全部参数", timeout: 2500 });
    if (!r.ok) { if (!quiet) h.toast("读取参数失败：" + (r.err ?? ""), "err"); return false; }
    renderedSig = ""; renderParams();
    for (const k of devParams.keys()) updateParamRow(k);
    $("cfgParamState").textContent = `已读取 ${r.params.length} 项`;
    $("cfgParamState").title = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    if (!quiet) h.toast(`已读取 ${r.params.length} 个参数`, "ok");
    h.onParams();
    return true;
  }
  async function writeParam(key: string, scope?: TelemetryScope): Promise<boolean> {
    if (!needV2()) return false;
    const v = Number($<HTMLInputElement>("pv_" + key).value);
    const d = devParams.get(key);
    const bad = checkParam(key, v, d?.min, d?.max);
    if (bad) { showIlimError(key, bad); h.toast(`${key}：${bad}`, "err"); return false; }
    const cross = crossLimitError(key, v);
    if (cross) { const text = showIlimError(key === "IQ_LIM" ? "OL_IQ" : key, cross); h.toast(text, "err"); return false; }
    if (key === "BOOT_AE" && v === 1 && !bootAeConfirmed && !confirm(bootAeWarning())) return false;
    return withTelemetryPaused(async (transaction) => {
      const r = await rawRun(cmdSet(key, v), `设置 ${key}`);
      if (!r.ok || !r.reply || r.reply.type !== "OK") return false;
      const got = Number(r.reply.kv[key]);
      const prev = devParams.get(key);
      devParams.set(key, { value: Number.isFinite(got) ? got : v, min: prev?.min ?? NaN, max: prev?.max ?? NaN, reboot: prev?.reboot || r.reply.kv.reboot === "1" });
      if (key === "TELEM") {
        const value = devParams.get(key)!.value;
        transaction.setRestoreValue(value);
        if (info) info.telem = value;
      }
      updateParamRow(key);
      if (key === "BOOT_AE") bootAeConfirmed = false;
      unsaved = true;
      if (r.reply.kv.reboot === "1") rebootNeeded = true;
      // SET IQ_LIM above OL_IQ makes the firmware raise OL_IQ. Re-read unless that key is still pending
      // (it will be SET next). enqueueRequest stays inside the current telemetry pause; request("GET …")
      // would open a second pause and wait for this one.
      if (key === "IQ_LIM" && devParams.has("OL_IQ") && !document.getElementById("pr_OL_IQ")?.classList.contains("mod")) {
        const back = await enqueueRequest(cmdGet("OL_IQ"), { note: "回读超限电流", timeout: 800 });
        if (back.ok) { updateParamRow("OL_IQ"); renderIlim(); }
      }
      h.onParams();
      return true;
    }, false, scope);
  }
  async function writeModified(quiet = false, scope?: TelemetryScope): Promise<{ n: number; total: number }> {
    // IQ_LIM before OL_IQ; TELEM last. Do not follow firmware GET / PARAM_META order.
    const keys = paramWriteOrder(modifiedKeys());
    if (!keys.length) { if (!quiet) h.toast("没有修改项"); return { n: 0, total: 0 }; }
    return withTelemetryPaused(async (transaction) => {
      let n = 0;
      for (const k of keys) { if (!(await writeParam(k, transaction))) break; n++; }
      if (!quiet) h.toast(`已写入 ${n}/${keys.length} 项（RAM）。需要断电保留请点“同步”或“保存配置”`, n === keys.length ? "ok" : "err");
      return { n, total: keys.length };
    }, { n: 0, total: keys.length }, scope);
  }
  /** 同步: write every modified key, then SAVE. */
  async function sync(): Promise<boolean> {
    if (!needV2()) return false;
    return withTelemetryPaused(async (transaction) => {
      const { n, total } = await writeModified(true, transaction);
      if (n < total) { h.toast(`同步中断：已写入 ${n}/${total} 项，未保存`, "err"); return false; }
      if (!total && !unsaved) { h.toast("没有需要同步的修改"); return true; }
      const ok = await save(true, transaction);
      if (ok) h.toast(`已同步：写入 ${total} 项并保存到 Flash${rebootNeeded ? "（部分参数需重启生效）" : ""}`, "ok");
      return ok;
    }, false);
  }
  async function save(quiet = false, scope?: TelemetryScope): Promise<boolean> {
    if (!needV2()) return false;
    return withTelemetryPaused(async (transaction) => {
      await transaction.restore();
      const r = await rawRun("SAVE\n", "保存到 Flash", { timeout: 2500 });
      if (r.ok) { unsaved = false; if (!quiet) h.toast(`已保存到 Flash（${r.reply?.type === "OK" ? r.reply.text : ""}）`, "ok"); void refreshInfo(); }
      return r.ok;
    }, false, scope);
  }
  async function resetDefaults(): Promise<boolean> {
    if (!needV2()) return false;
    if (h.confirmOn() && !confirm("重置：把全部参数恢复为固件默认值（DEFAULTS，仅 RAM；点“同步”后才写入 Flash）？\nCAN ID 也会恢复为默认值。")) return false;
    if (!(await run("DEFAULTS\n", "恢复默认值")).ok) return false;
    unsaved = true;
    await getAll(true);
    void refreshInfo();
    h.toast("已恢复默认值（未保存，点“同步”保存）", "ok");
    return true;
  }
  async function reboot(ask = true): Promise<boolean> {
    if (!needV2()) return false;
    const session = generation;
    const current = () => session === generation && h.serial.connected;
    if (ask && h.confirmOn() && !confirm("重启电机控制器？" + (unsaved ? "\n\n注意：还有未保存到 Flash 的修改，重启后会丢失！" : ""))) return false;
    const r = await run("REBOOT\n", "重启");
    if (!r.ok || !current()) return false;
    fw = "rebooting"; info = null;
    await sleep(800);
    if (!current()) return false;
    parser.reset();
    for (let i = 0; i < 8; i++) {
      await sleep(400);
      if (!current()) return false;
      const r = await request("INFO\n", { note: "重启后识别", timeout: 600 });
      if (!current()) return false;
      if (r.ok) {
        fw = "v2"; rebootNeeded = false; unsaved = false;
        h.toast(`电机已重启 · 生效 CAN ID ${getInfo()?.id ?? "?"}`, "ok");
        await getAll(true);
        if (features.tlist) await readTelemetryConfig();
        return true;
      }
    }
    h.toast("重启后未收到应答，请检查连接", "err");
    return false;
  }
  async function applyCanId(stopNow: (reason: string) => Promise<void>): Promise<void> {
    if (!needV2()) return;
    const session = generation;
    const id = Number($<HTMLSelectElement>("newCanId").value);
    if (checkParam("CAN_ID", id)) { h.toast("CAN ID 必须为 1..7", "err"); return; }
    if (h.confirmOn() && !confirm(`将 CAN ID 改为 ${id}？\n\n将依次执行：STOP → SET CAN_ID ${id} → SAVE（同时保存当前全部 RAM 参数）→ REBOOT。\n之后 CAN 主机需使用新 ID：控制 ${hex3(0x100 + id)} / 速度 ${hex3(speedCmdId(id))} / 位置 ${hex3(positionCmdId(id))} / 状态 ${hex3(0x180 + id)}。`)) return;
    await stopNow("修改 CAN ID");
    await sleep(50);
    if (session !== generation || !h.serial.connected) return;
    const saved = await withTelemetryPaused(async (transaction) => {
      if (!(await rawRun(cmdSet("CAN_ID", id), "设置 CAN ID")).ok) return false;
      return save(false, transaction);
    }, false);
    if (!saved) return;
    if (await reboot(false)) {
      const after = getInfo();
      if (after?.id === id) h.toast(`CAN ID 已改为 ${id} 并生效。上方「节点」里的电机 ID 也请改为 ${id}`, "ok");
      else h.toast(`重启后 CAN ID = ${after?.id ?? "?"}，与期望 ${id} 不一致`, "err");
    }
  }

  // ---------- profiles ----------
  function exportProfile(): void {
    const params: Record<string, number> = {};
    for (const [k, d] of devParams) params[k] = d.value;
    const prof = makeProfile(params, info?.fw, info?.ver, h.hostSettings());
    const blob = new Blob([JSON.stringify(prof, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    const d = new Date(), p2 = (n: number) => String(n).padStart(2, "0");
    a.download = `dr4310_profile_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}.json`;
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    h.toast(`已导出 ${Object.keys(params).length} 个电机参数${prof.host ? " + 上位机设置" : ""}`, "ok");
  }
  async function importProfile(file: File): Promise<void> {
    let prof;
    try { prof = readProfile(await file.text()); } catch (e) { h.toast("导入失败：" + errMsg(e), "err"); return; }
    if (prof.host) h.applyHostSettings(prof.host);
    let filled = 0;
    const skipped: string[] = [];
    for (const [k, v] of Object.entries(prof.params)) {
      const el = document.getElementById("pv_" + k) as HTMLInputElement | null;
      if (!el) { skipped.push(k); continue; }
      el.value = fmtVal(k, v);
      markRow(k);
      filled++;
    }
    const mod = modifiedKeys().length;
    h.toast(`已从 ${file.name} 填入 ${filled} 项（${mod} 项与电机不同，已标记）${skipped.length ? `；跳过 ${skipped.length} 项（电机无此参数${devParams.size ? "" : " / 未连接"}）` : ""}。点“同步”写入并保存。`, filled ? "ok" : "err");
  }

  // ---------- UI ----------
  function showPage(p: ParamPage | "store", scroll = false): void {
    page = p;
    document.querySelectorAll<HTMLButtonElement>("#cfgPages button").forEach((b) => b.classList.toggle("active", b.dataset.page === p));
    document.querySelectorAll<HTMLElement>(".cfgpage").forEach((el) => el.classList.toggle("active", el.id === "cfgPage_" + p));
    if (scroll) $("cfgPage_" + p).scrollIntoView({ behavior: "instant", block: "start" });
  }
  function refreshUi(): void {
    const now = performance.now();
    const inf = info && now - infoT < 4000 ? info : null;
    $("stFw").textContent = fw === "v2" && info ? `${info.fw} v${info.ver}` :
      fw === "legacy" ? "旧固件" : fw === "probing" ? "识别中…" : fw === "rebooting" ? "重启中…" : "—";
    $("cfgActiveId").textContent = inf ? String(inf.id) : "—";
    $("cfgCfgId").textContent = inf ? String(inf.cfgId) : "—";
    $("cfgSrc").textContent = inf ? CFG_SOURCE_NAMES[inf.cfg] ?? inf.cfg : "—";
    $("cfgSeq").textContent = inf && Number.isFinite(inf.seq) ? String(inf.seq) : "—";
    const calib = inf ? (inf.calib ? `已校准 · 零点 ${inf.zero.toFixed(4)} rad · 方向 ${inf.dir}` : "未校准（使用编译默认）") : "—";
    $("cfgCalib").textContent = calib;
    $("cfgCalib2").textContent = calib;
    $("cfgRun").textContent = inf ? `${inf.run}${inf.drv ? " · 驱动使能" : ""}${inf.ae ? " · 自动使能" : ""} · 母线电压 ${inf.vbus.toFixed(2)} V · 锁存 0x${(inf.latched || 0).toString(16).toUpperCase().padStart(4, "0")}` : "—";
    const id = Number($<HTMLSelectElement>("newCanId").value);
    $("canIdHint").textContent = `新 ID ${id}：控制 ${hex3(0x100 + id)} · 速度 ${hex3(speedCmdId(id))} · 位置 ${hex3(positionCmdId(id))} · 状态 ${hex3(0x180 + id)} · GM6020 ${id <= 4 ? "0x1FE" : "0x2FE"} 槽 ${((id - 1) % 4) + 1} · 反馈 ${hex3(0x204 + id)}`;
    const banner: string[] = [];
    if (fw === "none") banner.push("请连接串口");
    if (fw === "legacy") banner.push("旧固件 · 无参数设置");
    if (fw === "v2" && missedPolls >= 3) banner.push("电机连续无应答（可能断线 / 复位）。");
    if (inf && inf.cfgId !== inf.id) banner.push(`CAN ID 已设为 ${inf.cfgId}，重启后生效（当前 ${inf.id}）。`);
    if (unsaved) banner.push("未保存 · 点击同步");
    if (rebootNeeded) banner.push("需重启生效");
    $("cfgBanner").title = "速度/位置增益与 CAN 帧共用，下一帧会覆盖；同步写入修改并保存到 Flash";
    $("cfgBanner").textContent = banner.join(" ");
    $("cfgBanner").className = "banner " + (fw === "legacy" ? "warn" : "info");
    const dis = fw !== "v2";
    renderBoot();
    renderIlim();
    ["btnSave", "btnReload", "btnDefaults", "btnReboot", "btnGetAll", "btnWriteMod", "btnSync", "btnApplyId", "btnCfgInfo"].forEach((b) => $(b).toggleAttribute("disabled", dis));
    $("btnExport").toggleAttribute("disabled", devParams.size === 0);
    const sz = fw === "v2" && features.setzero;
    $("zeroSec").classList.toggle("hidden", !sz);
    $("btnSync").classList.toggle("pulse", unsaved || modifiedKeys().length > 0);
    $("stSerLines").textContent = h.serial.connected ? `应答 ${rateShown.lines} 行/s · 丢弃 ${parser.dropped} B` : "—";
    $("cfgFeat").textContent = fw === "v2"
      ? `固件 v${info?.ver ?? "?"} · 命令表 ${features.help ? "有" : "无"} · 遥测通道 ${features.tlist ? "可选" : "固定 16"} · 故障快照 ${features.fault ? "有" : "无"} · 设零 ${features.setzero ? "有" : "无"}`
      : "—";
  }

  let bootAeConfirmed = false;
  const bootVal = (key: string): number => {
    const el = document.getElementById("pv_" + key) as HTMLInputElement | null;
    return el && el.value !== "" ? Number(el.value) : devParams.get(key)?.value ?? NaN;
  };
  const BOOT_MODES = ["空闲", "电流", "速度", "位置"], BOOT_UNITS = ["", "A", "rpm", "rad"];
  function bootAeWarning(): string {
    const m = Math.round(bootVal("BOOT_MODE")), t = bootVal("BOOT_TARGET");
    if (!(m >= 1 && m <= 3)) return "开启上电自动使能？\n当前上电模式为空闲，开启后不会转动（无效果）。\n同步保存后重启生效。";
    return `开启上电自动使能？\n上电后电机将立即以「${BOOT_MODES[m]}」模式运行，目标 ${Number.isFinite(t) ? t : "?"} ${BOOT_UNITS[m]}。\n同步保存后重启生效。`;
  }
  function renderBoot(): void {
    const has = (k: string) => fw === "v2" && devParams.has(k);
    const any = has("BOOT_AE") || has("BOOT_MODE") || has("BOOT_TARGET");
    const tip = fw === "v2" ? "固件不支持" : "需串口参数固件（旧固件 / 仅 CAN 不支持）";
    $("bootSec").classList.toggle("off", !any);
    const m = Math.round(bootVal("BOOT_MODE"));
    const items: [string, string][] = [["bootMode", "BOOT_MODE"], ["bootTarget", "BOOT_TARGET"], ["bootAe", "BOOT_AE"]];
    for (const [id, key] of items) {
      const el = $<HTMLInputElement>(id), ok = has(key);
      el.disabled = !ok;
      el.title = ok ? key : tip;
      (el.closest?.("label") ?? el.parentElement)?.setAttribute("title", ok ? key : tip);
      if (document.activeElement === el) continue;
      const v = bootVal(key);
      if (id === "bootAe") el.checked = ok && v === 1;
      else el.value = ok && Number.isFinite(v) ? String(id === "bootMode" ? Math.round(v) : v) : "";
    }
    $("bootUnit").textContent = BOOT_UNITS[m] || "";
    $("bootNote").textContent = !any ? tip : bootVal("BOOT_AE") === 1 && !(m >= 1 && m <= 3) ? "上电模式为空闲：自动使能无效果 · 同步后重启生效" : "";
  }

  const fin = (n: number | undefined) => (n !== undefined && Number.isFinite(n) ? n : undefined);
  function fieldVal(key: string): number {
    const el = document.getElementById("pv_" + key) as HTMLInputElement | null;
    if (el && el.value !== "") return Number(el.value);
    return devParams.get(key)?.value ?? NaN;
  }
  /** 就地错误。OL_IQ 低于最大电流时文案以「须」开头，补上「超限电流」。 */
  function showIlimError(key: string, msg: string): string {
    const label = key === "IQ_LIM" ? "最大电流" : key === "OL_IQ" ? "超限电流" : key === "OL_TIME_S" ? "超限时间" : key === "OL_EN" ? "超限模式" : "";
    const text = label ? (key === "OL_IQ" && msg.startsWith("须") ? "超限电流" + msg : label + msg) : msg;
    if (label) $("olHint").textContent = text;
    return text;
  }
  /**
   * 即将写入的值是否非法。OL_IQ 必须 ≥ 将要生效的 IQ_LIM，且在范围内。
   * 只提高 IQ_LIM、不改 OL_IQ 时放行：固件会把 OL_IQ 抬到新的 IQ_LIM，写完再回读。
   * 用户同时把 OL_IQ 改到新 IQ_LIM 以下时，两项都不发送。
   */
  function crossLimitError(key: string, v: number): string | null {
    if ((key !== "OL_IQ" && key !== "IQ_LIM") || !devParams.has("OL_IQ") || !devParams.has("IQ_LIM")) return null;
    const iq = key === "IQ_LIM" ? v : fieldVal("IQ_LIM");
    const ol = key === "OL_IQ" ? v : fieldVal("OL_IQ");
    const d = devParams.get("OL_IQ")!;
    const msg = checkOverlimitIq(ol, iq, fin(d.min), fin(d.max));
    if (!msg) return null;
    if (!msg.startsWith("须")) return key === "OL_IQ" ? msg : null;
    if (key === "OL_IQ") return msg;
    return document.getElementById("pr_OL_IQ")?.classList.contains("mod") ? msg : null;
  }
  function applyRange(id: string, key: string): void {
    const el = $<HTMLInputElement>(id);
    const d = devParams.get(key), p = metaFor(key);
    const lo = d && Number.isFinite(d.min) ? d.min : p.min, hi = d && Number.isFinite(d.max) ? d.max : p.max;
    if (Number.isFinite(lo)) el.min = String(lo);
    if (Number.isFinite(hi)) el.max = String(hi);
  }
  function ilimLiveError(hasIq: boolean, hasOl: boolean): string {
    if (hasIq) {
      const d = devParams.get("IQ_LIM");
      const m = d && checkParam("IQ_LIM", fieldVal("IQ_LIM"), fin(d.min), fin(d.max));
      if (m) return showIlimError("IQ_LIM", m);
    }
    if (hasOl) {
      const d = devParams.get("OL_IQ")!;
      const m = checkOverlimitIq(fieldVal("OL_IQ"), fieldVal("IQ_LIM"), fin(d.min), fin(d.max));
      const olDirty = document.getElementById("pr_OL_IQ")?.classList.contains("mod") ?? false;
      // 未改 OL_IQ 时，IQ_LIM 高于当前超限电流是合法的（固件自动抬升），不就地报错。
      if (m && !(m.startsWith("须") && !olDirty)) return showIlimError("OL_IQ", m);
      const t = devParams.get("OL_TIME_S");
      const tm = t && checkParam("OL_TIME_S", fieldVal("OL_TIME_S"), fin(t.min), fin(t.max));
      if (tm) return showIlimError("OL_TIME_S", tm);
    }
    return "";
  }
  /** 电流限制小节：代理隐藏的 IQ_LIM / OL_* 行。旧固件没有 OL_* 时只留最大电流。 */
  function renderIlim(): void {
    const hasIq = fw === "v2" && devParams.has("IQ_LIM");
    const hasOl = fw === "v2" && overlimitAvailable(devParams.keys());
    $("olFields").classList.toggle("hidden", !hasOl);
    $("olNote").textContent = !hasOl && (fw === "legacy" || (fw === "v2" && devParams.size > 0)) ? "需 3.1.0 固件" : "";
    const iq = $<HTMLInputElement>("iqMax");
    iq.disabled = !hasIq;
    iq.title = hasIq ? "IQ_LIM · 持续电流上限" : fw === "v2" ? "固件不支持" : "需串口参数固件";
    applyRange("iqMax", "IQ_LIM");
    if (document.activeElement !== iq) {
      const v = hasIq ? fieldVal("IQ_LIM") : NaN;
      iq.value = Number.isFinite(v) ? fmtVal("IQ_LIM", v) : "";
    }
    const sw = $<HTMLInputElement>("olEnable");
    sw.disabled = !hasOl;
    sw.title = hasOl ? "OL_EN · 开启后允许短时超过最大电流" : "需 3.1.0 固件";
    if (document.activeElement !== sw) sw.checked = hasOl && fieldVal("OL_EN") === 1;
    for (const [id, key] of [["olCurrent", "OL_IQ"], ["olTime", "OL_TIME_S"]] as const) {
      applyRange(id, key);
      const el = $<HTMLInputElement>(id);
      if (document.activeElement !== el) {
        const v = hasOl ? fieldVal(key) : NaN;
        el.value = Number.isFinite(v) ? fmtVal(key, v) : "";
      }
    }
    const edit = overlimitFieldsEnabled(hasOl, sw.checked);
    $<HTMLInputElement>("olCurrent").disabled = !edit;
    $<HTMLInputElement>("olTime").disabled = !edit;
    $("olCurrentWrap").classList.toggle("is-off", hasOl && !edit);
    $("olTimeWrap").classList.toggle("is-off", hasOl && !edit);
    const fresh = info && performance.now() - infoT < 4000 ? info.ol : null;
    const label = formatOverlimit(fresh);
    $("olStatus").textContent = label;
    $("olStatus").classList.toggle("hidden", !label);
    $("olHint").textContent = ilimLiveError(hasIq, hasOl);
  }

  let hbTick = 0;
  async function heartbeat(): Promise<void> {
    if (audioExclusive || !h.serial.connected || fw !== "v2" || !$<HTMLInputElement>("cfgHb").checked || inflight || queue.length) return;
    hbTick++;
    const r = await request(hbTick % 2 ? "PING\n" : "INFO\n", { poll: true, timeout: 800 });
    if (!r.ok && r.timeout) missedPolls++;
  }

  function init(stopNow: (reason: string) => Promise<void>): void {
    renderParams();
    $("cfgPages").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button[data-page]") as HTMLButtonElement | null;
      if (b) showPage(b.dataset.page as ParamPage | "store", true);
    });
    showPage("drive");
    $("cfgView").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button[data-set]") as HTMLButtonElement | null;
      if (b) void writeParam(b.dataset.set!);
    });
    $("btnGetAll").addEventListener("click", () => void getAll());
    $("btnWriteMod").addEventListener("click", () => void writeModified());
    $("btnSync").addEventListener("click", () => void sync());
    $("btnRevertInputs").addEventListener("click", () => { for (const k of devParams.keys()) updateParamRow(k); });
    $("btnSave").addEventListener("click", () => void save());
    $("btnCfgInfo").addEventListener("click", () => { if (needV2()) void refreshInfo(); });
    $("btnReload").addEventListener("click", async () => {
      if (!needV2()) return;
      if ((await run("RELOAD\n", "重新加载 Flash 配置")).ok) { unsaved = false; await getAll(true); h.toast("已恢复为 Flash 中的配置", "ok"); }
    });
    $("btnDefaults").addEventListener("click", () => void resetDefaults());
    $("btnReboot").addEventListener("click", () => void reboot());
    $("btnApplyId").addEventListener("click", () => void applyCanId(stopNow));
    $("newCanId").addEventListener("change", refreshUi);
    // 上电行为: proxies for the hidden BOOT_* rows; written by 同步 (SET … then SAVE), effective after reboot.
    const bootProxy = (key: string, value: string) => {
      const input = document.getElementById("pv_" + key) as HTMLInputElement | null;
      if (!input || fw !== "v2") return;
      input.value = value; markRow(key); refreshUi();
    };
    $("bootMode").addEventListener("change", (e) => bootProxy("BOOT_MODE", (e.target as HTMLSelectElement).value));
    $("bootTarget").addEventListener("change", (e) => bootProxy("BOOT_TARGET", (e.target as HTMLInputElement).value));
    $("bootAe").addEventListener("change", (e) => {
      const box = e.target as HTMLInputElement;
      if (box.checked && !confirm(bootAeWarning())) { box.checked = false; return; }
      bootAeConfirmed = box.checked;
      bootProxy("BOOT_AE", box.checked ? "1" : "0");
    });
    // 电流限制: proxies for the hidden IQ_LIM / OL_* rows. 同步 writes them (SET … then SAVE).
    const ilimProxy = (key: string, value: string) => {
      const input = document.getElementById("pv_" + key) as HTMLInputElement | null;
      if (!input || !devParams.has(key)) return;
      input.value = value; markRow(key); renderIlim();
    };
    $("iqMax").addEventListener("input", () => ilimProxy("IQ_LIM", $<HTMLInputElement>("iqMax").value));
    $("olCurrent").addEventListener("input", () => ilimProxy("OL_IQ", $<HTMLInputElement>("olCurrent").value));
    $("olTime").addEventListener("input", () => ilimProxy("OL_TIME_S", $<HTMLInputElement>("olTime").value));
    $("olEnable").addEventListener("change", () => ilimProxy("OL_EN", $<HTMLInputElement>("olEnable").checked ? "1" : "0"));
    $("btnSetZero").addEventListener("click", () => void setZero());
    $("telApply").addEventListener("click", () => void applyTelemetry());
    $("telReload").addEventListener("click", () => { if (needV2()) void readTelemetryConfig(); });
    $("btnExport").addEventListener("click", exportProfile);
    $("btnImport").addEventListener("click", () => $<HTMLInputElement>("profFile").click());
    $("profFile").addEventListener("change", (e) => {
      const inp = e.target as HTMLInputElement;
      const f = inp.files?.[0];
      if (f) void importProfile(f);
      inp.value = "";
    });
    setInterval(() => { rateShown.lines = rate.lines; rate.lines = 0; }, 1000);
    setInterval(() => void heartbeat(), 500);
  }

  function setAudioExclusive(on: boolean): void {
    if (on === audioExclusive) return;
    audioExclusive = on;
    if (on) cancelPending("AUDIO 独占接管 UART");
    parser.reset(); // Keep the parser instance and its subscribers; clear only residual bytes.
  }

  return {
    setAudioExclusive, parser, prepare, onData, onOpened, onClosed, refreshUi, init, request, run, setZero, clearFaults, readFault, showPage, importProfile, ensurePositionTelemetry,
    get fw(): FwState { return fw; },
    get unsaved(): boolean { return unsaved; },
    get busy(): boolean { return !!inflight || queue.length > 0; },
    get queueLen(): number { return queue.length + (inflight ? 1 : 0); },
    get features(): Features { return features; },
    get channels(): ChannelDef[] { return channels; },
    get fault(): FaultSnapshot | null { return lastFault; },
    /** INFO if fresh (<4 s). */
    get info(): DeviceInfo | null { return info && performance.now() - infoT < 4000 ? info : null; },
    get infoAge(): number { return info ? performance.now() - infoT : Infinity; },
    param(key: string): number | null { const d = devParams.get(key); return d && Number.isFinite(d.value) ? d.value : null; },
    get paramPages(): Record<string, string> { return PARAM_PAGES; },
    cancelQueued, cancelPending,
  };
}
export type UartCfg = ReturnType<typeof createUartCfg>;
