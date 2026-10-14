/**
 * Optional UART settings protocol (merged firmware "4310_G431KBT6_CurrentAccelLoop_uartcfg", v2.0.0+).
 * USART1 230400 8N1. Downlink: ASCII lines ending in '\n'. Uplink: VOFA JustFloat frames
 * (16 x f32 LE + 00 00 80 7F) interleaved with whole '@' reply lines ("@OK CMD ...", "@P KEY=v ...").
 * Older firmware sends JustFloat only and never replies -> detected as "legacy".
 * See firmware docs/UART_PROTOCOL.md.
 */
import { clamp } from "./protocol";
export { clamp };
export const LINE_MAX = 95;

// ---------------- parameters (labels; ranges come from the firmware's @P lines) ----------------
/** Settings pages (电机精灵 layout). Unknown keys from a newer firmware land in "other". */
export type ParamPage = "motor" | "drive" | "comm" | "other";
export type ParamGroup = "motor" | "zero" | "vbus" | "can" | "boot" | "link" | "ilim" | "cur" | "spd" | "pos" | "mit" | "cog" | "ramp" | "other";
export type ParamMeta = { key: string; name: string; unit: string; page: ParamPage; group: ParamGroup; int?: boolean; min: number; max: number; reboot?: boolean; note?: string; v3?: boolean; hidden?: boolean };
export const PARAM_META: ParamMeta[] = [
  // 电机参数 (v3 keys; hidden when the firmware does not list them in GET)
  { key: "POLE_PAIRS", name: "极对数", unit: "", page: "motor", group: "motor", int: true, min: 1, max: 64, v3: true },
  // GEAR_RATIO: DR4310 here is a direct-drive gimbal motor (no reduction) — the key is kept only so a firmware
  // that still lists it is recognised; its row is hidden and the host never uses it (motor = output).
  { key: "GEAR_RATIO", name: "减速比", unit: ":1", page: "motor", group: "motor", min: 1, max: 1000, v3: true, hidden: true, note: "直驱电机，不使用" },
  { key: "KT", name: "转矩常数 Kt", unit: "N·m/A", page: "motor", group: "motor", min: 0, max: 10, v3: true, note: "直驱：力矩 = Iq·Kt" },
  { key: "RS", name: "相电阻", unit: "Ω", page: "motor", group: "motor", min: 0, max: 100, v3: true },
  { key: "LS", name: "相电感", unit: "H", page: "motor", group: "motor", min: 0, max: 1, v3: true },
  { key: "ENC_DIR", name: "编码器方向", unit: "", page: "motor", group: "motor", int: true, min: -1, max: 1, v3: true, note: "通常由校准自动得到" },
  { key: "ZERO_OFFSET", name: "零点偏移", unit: "rad", page: "motor", group: "zero", min: -1000, max: 1000, v3: true, note: "「设零」按钮写入当前位置" },
  { key: "VBUS_MIN", name: "欠压阈值", unit: "V", page: "motor", group: "vbus", min: 0, max: 60, v3: true },
  { key: "VBUS_MAX", name: "过压阈值", unit: "V", page: "motor", group: "vbus", min: 0, max: 60, v3: true },
  // 驱动参数
  { key: "CUR_KP", name: "电流环 Kp", unit: "", page: "drive", group: "cur", min: 0, max: 100 },
  { key: "CUR_KI", name: "电流环 Ki", unit: "", page: "drive", group: "cur", min: 0, max: 100000 },
  { key: "CUR_VLIM", name: "电流环输出限幅", unit: "V", page: "drive", group: "cur", min: 0, max: 30, note: "0=跟随母线" },
  // 电流限制（3.1.0 起有 OL_*；2.0.0 / 3.0.1 只有 IQ_LIM）。行隐藏，由「电流限制」小节代理编辑。
  { key: "IQ_LIM", name: "最大电流", unit: "A", page: "drive", group: "ilim", min: 0, max: 2.5, hidden: true, note: "持续电流上限" },
  { key: "OL_EN", name: "超限模式", unit: "0/1", page: "drive", group: "ilim", int: true, min: 0, max: 1, v3: true, hidden: true, note: "开启后允许短时超过最大电流" },
  { key: "OL_IQ", name: "超限电流", unit: "A", page: "drive", group: "ilim", min: 0, max: 2.8, v3: true, hidden: true, note: "须 ≥ 最大电流，固件上限 2.8 A" },
  { key: "OL_TIME_S", name: "超限时间", unit: "s", page: "drive", group: "ilim", min: 0, max: 10, v3: true, hidden: true, note: "超限预算（秒）；0 等同关闭" },
  { key: "SPD_KP", name: "速度环 Kp", unit: "A/(rad/s)", page: "drive", group: "spd", min: 0, max: 10, note: "与 0x400+ID 帧共用；下一帧会覆盖" },
  { key: "SPD_KI", name: "速度环 Ki", unit: "", page: "drive", group: "spd", min: 0, max: 5 },
  { key: "SPD_KD", name: "速度环 Kd", unit: "", page: "drive", group: "spd", min: 0, max: 1 },
  { key: "ACCEL", name: "加速度限制", unit: "rad/s²", page: "drive", group: "spd", min: 0, max: 100000, note: "≤0.1 用内置 1000" },
  { key: "POS_KP", name: "位置环 Kp", unit: "", page: "drive", group: "pos", min: 0, max: 200, note: "与 0x500+ID 帧共用；下一帧会覆盖" },
  { key: "POS_KI", name: "位置环 Ki", unit: "", page: "drive", group: "pos", min: 0, max: 100 },
  { key: "POS_KD", name: "位置环 Kd", unit: "", page: "drive", group: "pos", min: 0, max: 100 },
  { key: "POS_ISEP", name: "积分分离阈值", unit: "rad", page: "drive", group: "pos", min: 0, max: 100 },
  { key: "POS_VLIM", name: "位置环速度限幅", unit: "rad/s", page: "drive", group: "pos", min: 0, max: 500 },
  { key: "POS_VFF", name: "轨迹速度前馈系数", unit: "", page: "drive", group: "pos", min: 0, max: 1, v3: true, note: "0=关闭，1=全量；写入立即生效，同步后断电保留（固件 3.2.0+）" },
  { key: "COG_EN", name: "齿槽转矩补偿", unit: "0/1", page: "drive", group: "cog", int: true, min: 0, max: 1, v3: true, note: "先完成双向低速标定并上传补偿表；只作用于速度、位置和 MIT 模式" },
  { key: "COG_GAIN", name: "补偿系数", unit: "", page: "drive", group: "cog", min: 0, max: 1, v3: true, note: "0 关闭 · 1 全量；初次验证从小系数开始" },
  { key: "COG_LIM", name: "补偿电流限幅", unit: "A", page: "drive", group: "cog", min: 0, max: 1, v3: true, note: "与总电流限幅同时生效，默认 0.2 A" },
  { key: "MIT_KP", name: "MIT 默认 Kp", unit: "", page: "drive", group: "mit", min: 0, max: 500 },
  { key: "MIT_KD", name: "MIT 默认 Kd", unit: "", page: "drive", group: "mit", min: 0, max: 5 },
  { key: "SPD_RAMP_MS", name: "速度指令时间", unit: "ms", page: "drive", group: "ramp", int: true, min: 0, max: 60000, v3: true, note: "固件斜坡；存在时上位机不再做斜坡" },
  { key: "POS_RAMP_MS", name: "位置指令时间", unit: "ms", page: "drive", group: "ramp", int: true, min: 0, max: 60000, v3: true },
  { key: "CUR_RAMP_MS", name: "力矩指令时间", unit: "ms", page: "drive", group: "ramp", int: true, min: 0, max: 60000, v3: true },
  // 通信参数
  { key: "CAN_ID", name: "CAN ID", unit: "", page: "comm", group: "can", int: true, min: 1, max: 7, reboot: true, note: "控制 0x100+ID · 速度 0x400+ID · 位置 0x500+ID · 状态 0x180+ID · GM6020 槽位" },
  { key: "CAN_BAUD", name: "CAN 波特率", unit: "kbps", page: "comm", group: "can", int: true, min: 10, max: 1000, reboot: true, v3: true, note: "改后 PCAN 需用同一波特率（本页 PCAN 固定 1 Mbps）" },
  { key: "TELEM", name: "JustFloat 遥测", unit: "0/1", page: "comm", group: "link", int: true, min: 0, max: 1 },
  { key: "TIMEOUT_MS", name: "命令超时", unit: "ms", page: "comm", group: "link", int: true, min: 0, max: 60000, note: "0=关闭；>0 时主机停发命令即停机" },
  { key: "BOOT_MODE", name: "上电模式", unit: "", page: "drive", group: "boot", int: true, min: 0, max: 3, reboot: true, note: "0 空闲 1 电流 2 速度 3 位置", hidden: true },
  { key: "BOOT_TARGET", name: "上电目标", unit: "A/rpm/rad", page: "drive", group: "boot", min: -1000, max: 1000, reboot: true, hidden: true },
  { key: "BOOT_AE", name: "上电自动使能", unit: "0/1", page: "drive", group: "boot", int: true, min: 0, max: 1, reboot: true, note: "=1 时上电即转！", hidden: true },
];
export const PARAM_GROUPS: Record<ParamGroup, string> = {
  motor: "电机本体", zero: "零点", vbus: "电压范围", can: "CAN", boot: "上电行为", link: "串口与安全",
  ilim: "电流限制", cur: "电流环", spd: "速度环", pos: "位置环", mit: "MIT", cog: "齿槽转矩补偿", ramp: "指令时间（固件斜坡）", other: "其他（新固件参数）",
};
export const PARAM_PAGES: Record<ParamPage, string> = { motor: "电机参数", drive: "驱动参数", comm: "通信参数", other: "其他" };
export function paramMeta(key: string): ParamMeta | undefined {
  return PARAM_META.find((p) => p.key === key);
}
/** Meta for any key, including unknown keys from a newer firmware (→ page "other"). */
export function metaFor(key: string, min = NaN, max = NaN, reboot = false): ParamMeta {
  return paramMeta(key) ?? { key, name: key, unit: "", page: "other", group: "other", min, max, reboot };
}

/** Validate a value for a parameter; returns an error string or null. */
export function checkParam(key: string, v: number, min?: number, max?: number): string | null {
  const m = paramMeta(key);
  if (!Number.isFinite(v)) return "数值无效";
  const lo = min ?? m?.min ?? -Infinity, hi = max ?? m?.max ?? Infinity;
  if (v < lo || v > hi) return `超出范围 ${lo}..${hi}`;
  if (m?.int && !Number.isInteger(v)) return "必须为整数";
  return null;
}

// ---------------- command builders ----------------
/** Format a number compactly for the firmware's strtof parser. */
export function fnum(v: number): string {
  if (!Number.isFinite(v)) throw new Error("数值无效");
  const s = String(Number(v.toPrecision(7)));
  return s === "-0" ? "0" : s;
}
/** Build a '\n'-terminated command line; throws if too long. */
export function cmd(name: string, ...args: number[]): string {
  const s = [name.trim().toUpperCase(), ...args.map(fnum)].join(" ");
  if (s.length > LINE_MAX) throw new Error("命令过长");
  return s + "\n";
}
export const cmdSet = (key: string, v: number) => {
  const s = `SET ${key.toUpperCase()} ${fnum(v)}`;
  if (s.length > LINE_MAX) throw new Error("命令过长");
  return s + "\n";
};
export const cmdGet = (key?: string) => (key ? `GET ${key.toUpperCase()}\n` : "GET\n");
/**
 * 一次同步里的 SET 顺序。相对顺序保持不变，只做两处调整：
 * - IQ_LIM 先于 OL_IQ。固件会拒绝「OL_IQ < 当前 IQ_LIM」；把 IQ_LIM 提高到超过 OL_IQ 时，固件会把 OL_IQ 抬到 IQ_LIM。
 * - TELEM 放最后，新打开的遥测在其余参数写完之后再恢复。
 */
export function paramWriteOrder(keys: readonly string[]): string[] {
  const rank = (k: string) => (k === "TELEM" ? 2 : k === "OL_IQ" ? 1 : 0);
  return keys.map((k, i) => ({ k, i })).sort((a, b) => rank(a.k) - rank(b.k) || a.i - b.i).map((x) => x.k);
}

const OL_STATES = ["off", "ready", "active", "recover"] as const;
export type OlState = (typeof OL_STATES)[number];
/** INFO 超限状态。budget 为秒；字段缺失时为 null（界面不显示预算）。 */
export type OverlimitStatus = { state: OlState; budget: number | null };
const OL_STATE_LABEL: Record<OlState, string> = { off: "关闭", ready: "就绪", active: "超限中", recover: "恢复中" };

function kvPick(kv: Record<string, string>, name: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(kv, name)) return kv[name];
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(kv)) if (k.toLowerCase() === want) return v;
  return undefined;
}
/**
 * INFO 里的超限状态。认得 ol=off|ready|active|recover（大小写不敏感）。
 * 预算优先 budget=，否则 olb= / ol_budget=。ol 缺失或不是这四种值时返回 null。
 */
export function parseOverlimit(kv: Record<string, string>): OverlimitStatus | null {
  const raw = (kvPick(kv, "ol") ?? "").trim().toLowerCase();
  if (!(OL_STATES as readonly string[]).includes(raw)) return null;
  const braw = kvPick(kv, "budget") ?? kvPick(kv, "olb") ?? kvPick(kv, "ol_budget");
  if (braw === undefined || braw.trim() === "") return { state: raw as OlState, budget: null };
  const n = Number(braw);
  return { state: raw as OlState, budget: Number.isFinite(n) ? n : null };
}
/** 预算显示：2 → "2.0"，0.4 → "0.4"，0.85 → "0.85"。 */
export function formatBudgetSeconds(v: number): string {
  if (!Number.isFinite(v)) return "";
  const n = Number(v.toPrecision(6));
  const r2 = Math.round(n * 100) / 100;
  const tenth = Math.round(r2 * 10) / 10;
  return Math.abs(r2 - tenth) < 1e-9 ? tenth.toFixed(1) : r2.toFixed(2);
}
/** 空串表示没有可显示的状态。off 不带预算。 */
export function formatOverlimit(st: OverlimitStatus | null): string {
  if (!st) return "";
  const name = OL_STATE_LABEL[st.state];
  if (st.state === "off" || st.budget === null) return `超限：${name}`;
  return `超限：${name} ${formatBudgetSeconds(st.budget)} s`;
}
/** 固件参数集里三个 OL_* 都在，才显示超限控件。2.0.0 / 3.0.1 为 false。 */
export function overlimitAvailable(keys: Iterable<string>): boolean {
  const s = new Set(keys);
  return s.has("OL_EN") && s.has("OL_IQ") && s.has("OL_TIME_S");
}
/** 超限电流 / 超限时间：固件支持且超限模式打开时才可编辑。 */
export function overlimitFieldsEnabled(available: boolean, enabled: boolean): boolean {
  return available && enabled;
}
function finiteBound(n: number | undefined): number | undefined {
  return n !== undefined && Number.isFinite(n) ? n : undefined;
}
/**
 * OL_IQ 须落在 [min, max]（缺省用 PARAM_META，调用方应传入固件报告的范围）且 ≥ IQ_LIM。
 * 返回错误文案或 null。文案以「须」开头表示低于最大电流。
 */
export function checkOverlimitIq(olIq: number, iqLim: number, min?: number, max?: number): string | null {
  const range = checkParam("OL_IQ", olIq, finiteBound(min), finiteBound(max));
  if (range) return range;
  if (!Number.isFinite(iqLim)) return "最大电流无效";
  if (olIq + 1e-6 < iqLim) return `须 ≥ 最大电流 ${fnum(iqLim)}`;
  return null;
}
/** The reply "cmd" token the firmware uses for a given request line. */
const REPLY_ALIASES: Record<string, string> = {
  IDLE: "STOP", ESTOP: "STOP", CURRENT: "RUN", IQ0: "ZERO", CLR: "CLEAR", CALIBRATE: "CALIB",
};
export function replyKeyFor(line: string): string {
  const t = line.trim().toUpperCase().split(/[\s=,]+/)[0] ?? "";
  if (t === "PING") return "PONG";
  return REPLY_ALIASES[t] ?? t;
}

// ---------------- reply parsing ----------------
export type Reply =
  | { type: "OK" | "ERR"; cmd: string; text: string; kv: Record<string, string> }
  | { type: "P"; key: string; value: number; min: number; max: number; reboot: boolean; kv: Record<string, string> }
  | { type: "INFO" | "PONG" | "EVT"; cmd: string; text: string; kv: Record<string, string> }
  /** Any other @TAG line (v3: @FAULT, @TL …). */
  | { type: "TAG"; cmd: string; text: string; kv: Record<string, string> }
  | { type: "UNKNOWN"; text: string };

export function parseKv(s: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const part of s.trim().split(/\s+/)) {
    const i = part.indexOf("=");
    if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1);
  }
  return kv;
}

export function parseReply(line: string): Reply {
  const s = line.replace(/[\r\n]+$/, "");
  const m = /^@(\w+)(?:\s+(.*))?$/.exec(s);
  if (!m) return { type: "UNKNOWN", text: s };
  const tag = m[1]!.toUpperCase();
  const rest = (m[2] ?? "").trim();
  if (tag === "OK" || tag === "ERR") {
    const sp = rest.indexOf(" ");
    const c = sp < 0 ? rest : rest.slice(0, sp);
    const text = sp < 0 ? "" : rest.slice(sp + 1);
    return { type: tag, cmd: c.toUpperCase(), text, kv: parseKv(text) };
  }
  if (tag === "P") {
    const kv = parseKv(rest);
    const first = rest.split(/\s+/)[0] ?? "";
    const i = first.indexOf("=");
    if (i <= 0) return { type: "UNKNOWN", text: s };
    const key = first.slice(0, i).toUpperCase();
    return {
      type: "P", key, value: Number(first.slice(i + 1)),
      min: kv.min !== undefined ? Number(kv.min) : NaN, max: kv.max !== undefined ? Number(kv.max) : NaN,
      reboot: kv.reboot === "1", kv,
    };
  }
  if (tag === "INFO" || tag === "PONG") return { type: tag, cmd: tag, text: rest, kv: parseKv(rest) };
  if (tag === "EVT") {
    const sp = rest.indexOf(" ");
    return { type: "EVT", cmd: (sp < 0 ? rest : rest.slice(0, sp)).toUpperCase(), text: sp < 0 ? "" : rest.slice(sp + 1), kv: parseKv(rest) };
  }
  return { type: "TAG", cmd: tag, text: rest, kv: parseKv(rest) };
}

export type DeviceInfo = {
  audio?: number; uartBaud?: number; audioQMaxMa?: number; audioDMaxMa?: number;
  fw: string; ver: string; id: number; cfgId: number; mode: number; run: string; drv: number; ae: number; telem: number;
  fault: number; latched: number; vbus: number; calib: number; zero: number; dir: number; cfg: string; seq: number;
  timeout: number; trips: number; drops: number; up: number;
  /** 3.1.0 INFO 的 ol= / budget=。旧固件为 null。 */
  ol: OverlimitStatus | null;
};
export function parseInfo(kv: Record<string, string>): DeviceInfo {
  const n = (k: string) => (kv[k] !== undefined ? Number(kv[k]) : NaN);
  return {
    audio: n("audio"), uartBaud: n("uart_baud"),
    audioQMaxMa: n("audio_qmax_ma"), audioDMaxMa: n("audio_dmax_ma"),
    fw: kv.fw ?? "?", ver: kv.ver ?? "?", id: n("id"), cfgId: n("cfg_id"), mode: n("mode"), run: kv.run ?? "?",
    drv: n("drv"), ae: n("ae"), telem: n("telem"), fault: parseInt(kv.fault ?? "", 16), latched: parseInt(kv.latched ?? "", 16),
    vbus: n("vbus"), calib: n("calib"), zero: n("zero"), dir: n("dir"), cfg: kv.cfg ?? "?", seq: n("seq"),
    timeout: n("timeout"), trips: n("trips"), drops: n("drops"), up: n("up"),
    ol: parseOverlimit(kv),
  };
}
export const CFG_SOURCE_NAMES: Record<string, string> = {
  default: "无 Flash 记录（编译默认值）", "flash-v1": "旧版记录（仅校准，参数为默认值）", flash: "Flash 已保存", invalid: "Flash 参数越界（已用默认值）",
};
export const ERR_NAMES: Record<string, string> = {
  unknown: "固件不支持该命令", bad_value: "数值格式错误", missing_value: "缺少数值", too_many_args: "参数过多",
  not_idle: "电机未处于空闲（先 STOP）", unknown_key: "未知参数", flash: "Flash 写入失败", too_long: "命令过长",
  failed: "标定失败", internal: "内部错误",
  // v3.0.1
  enc_not_ready: "编码器未就绪，不能进入位置/MIT", no_encoder: "编码器无效",
};
export function errText(reason: string): string {
  const w = reason.split(/\s+/)[0] ?? "";
  if (w === "range") return "超出范围：" + reason.slice(6);
  if (w === "usage") return "用法：" + reason.slice(6);
  return ERR_NAMES[w] ?? reason;
}

// ---------------- uplink stream: JustFloat frames + '@' lines ----------------
export const JF_TAIL = [0x00, 0x00, 0x80, 0x7f] as const;
export const JF_CHANNELS = 16;
export const JF_FRAME_BYTES = JF_CHANNELS * 4 + 4;
// INFO may use the firmware's 640-byte buffer as capabilities/diagnostics grow.
const LINE_SCAN_MAX = 768;

function isTail(b: Uint8Array, i: number): boolean {
  return b[i] === 0x00 && b[i + 1] === 0x00 && b[i + 2] === 0x80 && b[i + 3] === 0x7f;
}

/** '@' + 1..8 upper-case letters + (space | end), e.g. "@OK ", "@P ", "@PONG". */
function looksLikeReply(b: Uint8Array, i: number, end: number): boolean {
  let k = i + 1;
  while (k < end && b[k]! >= 0x41 && b[k]! <= 0x5a) k++;
  const n = k - i - 1;
  return n >= 1 && n <= 8 && (k === end || b[k] === 0x20 || b[k] === 0x0d);
}

/**
 * Splits the USART1 uplink into JustFloat frames and '@' reply lines.
 * Firmware enqueues frames and lines atomically, so after sync every item starts at a boundary.
 * The channel count is variable (v3 firmware: TCH selects 1..32 channels). It is set from the TCH
 * reply, and also auto-detected: three consecutive well-formed frames of another width switch it.
 */
export const JF_MAX_CHANNELS = 32;
export class UartStreamParser {
  private buf = new Uint8Array(0);
  frames = 0;
  lines = 0;
  dropped = 0; // bytes discarded while resyncing
  text = ""; // non-'@' printable text seen while unsynced (old firmware banners etc.)
  channels = JF_CHANNELS;
  autoDetect = true;
  /** Called when auto-detection switches the channel count. */
  onChannels: ((n: number) => void) | null = null;
  private cand = 0;
  private candHits = 0;

  setChannels(n: number): void {
    const k = Math.round(n);
    if (!(k >= 1 && k <= JF_MAX_CHANNELS)) return;
    this.channels = k;
    this.cand = 0; this.candHits = 0;
  }

  /** Width k (≠ 0) if a frame of k channels starts at i and is followed by another frame or an '@' line. */
  private detectAt(b: Uint8Array, i: number): number {
    for (let k = 1; k <= JF_MAX_CHANNELS; k++) {
      const t = i + 4 * k;
      if (t + 4 > b.length) break;
      if (!isTail(b, t)) continue;
      // a frame never contains a tail pattern: reject if one appears inside [i, t)
      for (let q = i; q < t - 3; q++) if (isTail(b, q)) return 0;
      const nx = t + 4;
      if (nx + 4 * k + 4 <= b.length && isTail(b, nx + 4 * k)) return k;
      if (nx < b.length && b[nx] === 0x40) return k;
    }
    return 0;
  }

  push(chunk: Uint8Array): { frames: Float32Array[]; lines: string[] } {
    const b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf, 0);
    b.set(chunk, this.buf.length);
    const frames: Float32Array[] = [];
    const lines: string[] = [];
    let i = 0;
    for (;;) {
      const ch = this.channels;
      const fb = ch * 4 + 4;
      const n = b.length - i;
      if (n <= 0) break;
      // 1) aligned frame?
      if (n >= fb && isTail(b, i + fb - 4)) {
        const dv = new DataView(b.buffer, b.byteOffset + i, fb - 4);
        const fs = new Float32Array(ch);
        for (let c = 0; c < ch; c++) fs[c] = dv.getFloat32(c * 4, true);
        frames.push(fs);
        this.frames++;
        this.candHits = 0;
        i += fb;
        continue;
      }
      // 2) '@' reply line (printable ASCII up to '\n')
      if (b[i] === 0x40) {
        let j = i + 1;
        let ok = true;
        while (j < b.length && j - i < LINE_SCAN_MAX) {
          const c = b[j]!;
          if (c === 0x0a) break;
          if (c !== 0x0d && (c < 0x20 || c > 0x7e)) { ok = false; break; }
          j++;
        }
        if (ok && j < b.length && b[j] === 0x0a && looksLikeReply(b, i, j)) {
          let s = "";
          for (let k = i; k < j; k++) if (b[k] !== 0x0d) s += String.fromCharCode(b[k]!);
          lines.push(s);
          this.lines++;
          i = j + 1;
          continue;
        }
        if (ok && j === b.length && j - i < LINE_SCAN_MAX) break; // incomplete line: wait
        if (n < fb) break; // might still be a frame starting with 0x40
      } else if (n < fb) {
        // Not enough for a frame. A printable text fragment ending in '\n' (e.g. the tail of a
        // reply line we connected in the middle of) is skipped; otherwise wait for more bytes.
        let j = i;
        while (j < b.length) {
          const c = b[j]!;
          if (c === 0x0a || (c !== 0x0d && (c < 0x20 || c > 0x7e))) break;
          j++;
        }
        // Only when a reply line follows: a partial binary frame can also contain printable bytes + 0x0A.
        if (j < b.length - 2 && b[j] === 0x0a && b[j + 1] === 0x40 && b[j + 2]! >= 0x41 && b[j + 2]! <= 0x5a) {
          for (let k = i; k < j; k++) if (b[k] !== 0x0d) this.text += String.fromCharCode(b[k]!);
          this.text = this.text.slice(-200);
          this.dropped += j + 1 - i;
          i = j + 1;
          continue;
        }
        // A narrower frame may already be complete here (channel count changed).
        if (!this.autoDetect || !this.detectAt(b, i)) break;
      }
      // 3) channel count changed? (TCH on v3 firmware, or a different VOFA tool config)
      if (this.autoDetect) {
        const k = this.detectAt(b, i);
        if (k && k !== ch) {
          if (k === this.cand) this.candHits++; else { this.cand = k; this.candHits = 1; }
          if (this.candHits >= 3) { this.setChannels(k); this.onChannels?.(k); continue; }
          this.dropped += k * 4 + 4;
          i += k * 4 + 4;
          continue;
        }
      }
      // 4) resync: skip one byte
      i++;
      this.dropped++;
    }
    let rest = b.subarray(i);
    const fb = this.channels * 4 + 4;
    if (rest.length > 8192) { this.dropped += rest.length - fb; rest = rest.subarray(rest.length - fb); }
    this.buf = rest.slice();
    return { frames, lines };
  }

  reset(): void { this.buf = new Uint8Array(0); this.cand = 0; this.candHits = 0; }
}

export function encodeJustFloat(values: number[]): Uint8Array {
  const d = new Uint8Array(values.length * 4 + 4);
  const dv = new DataView(d.buffer);
  values.forEach((v, k) => dv.setFloat32(k * 4, v, true));
  d.set(JF_TAIL, values.length * 4);
  return d;
}
