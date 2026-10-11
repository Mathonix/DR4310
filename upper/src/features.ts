/**
 * Firmware feature detection + v3 (Grok Build, planned 3.0.0) reply parsing, telemetry channel
 * roles, unit conversion, host ramps, waveform generator and parameter profiles. Pure / testable.
 *
 * Expected v3 reply formats (host is tolerant; see README "v3 firmware contract"):
 *   HELP     → @OK HELP STOP RUN ... SETZERO TLIST TCH TRATE FAULT
 *   TLIST    → @TL <idx> <NAME> [unit]   (one line per channel) … @OK TLIST <count>
 *   TCH      → @OK TCH n=<k> ch=<NAME>,<NAME>,…        (query)
 *   TCH i,j  → @OK TCH n=<k> ch=<NAME>,<NAME>,…        (set; indices from TLIST)
 *   TRATE    → @OK TRATE hz=<n>          TRATE <hz> → @OK TRATE hz=<n>
 *   FAULT    → @FAULT code=0x<hex> latched=0x<hex> [names=A,B] [k=v …]   (then optional @OK FAULT)
 *   SETZERO  → @OK SETZERO zero=<rad>    (or @ERR SETZERO not_idle)
 */
import type { Reply } from "./uartcfg-protocol";

// ---------------- feature detection ----------------
export type Features = {
  help: boolean; setzero: boolean; tlist: boolean; tch: boolean; trate: boolean; fault: boolean;
  keys: Set<string>; major: number;
};
export const NO_FEATURES = (): Features => ({ help: false, setzero: false, tlist: false, tch: false, trate: false, fault: false, keys: new Set(), major: 0 });

/** Commands listed by "@OK HELP ...". */
export function parseHelp(text: string): Set<string> {
  return new Set(text.split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter((t) => /^[A-Z][A-Z0-9_]*$/.test(t)));
}
export function versionMajor(ver: string | undefined): number {
  const m = /^(\d+)/.exec(ver ?? "");
  return m ? Number(m[1]) : 0;
}

// ---------------- telemetry channels ----------------
export type ChannelDef = { idx: number; name: string; unit: string };
export type Role = "idRef" | "id" | "iqRef" | "iq" | "vd" | "vq" | "vbus" | "omega" | "rpm" | "pos" | "power" | "temp" | "eangle";

/** Legacy firmware (v2 and older): fixed 16 channels (control_app.cpp frame_values[0..15]). */
export const LEGACY_CHANNELS: ChannelDef[] = [
  ["Id_ref", "A"], ["Id", "A"], ["Iq_ref", "A"], ["Iq", "A"], ["Vd_unsat", "V"], ["Vq_unsat", "V"], ["Vd_sat", "V"], ["Vq_sat", "V"],
  ["Vbus", "V"], ["Vsat", "0/1"], ["omega", "rad/s"], ["Duty_A", ""], ["Duty_B", ""], ["Duty_C", ""], ["Cur_Kp", ""], ["Cur_Ki", ""],
].map(([name, unit], idx) => ({ idx, name: name!, unit: unit! }));

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const ROLE_ALIASES: Record<Role, string[]> = {
  idRef: ["IDREF", "IDR", "IDTARGET"],
  id: ["ID", "IDA"],
  iqRef: ["IQREF", "IQR", "IQTARGET", "IQCMD"],
  iq: ["IQ", "IQA"],
  vd: ["VDSAT", "VD"],
  vq: ["VQSAT", "VQ"],
  vbus: ["VBUS", "VDC", "BUS", "BUSV"],
  omega: ["OMEGA", "W", "VEL", "VELOCITY", "SPEEDRADS", "SPDRADS", "WRADS"],
  rpm: ["RPM", "SPEED", "SPD", "SPEEDRPM", "SPDRPM"],
  pos: ["POS", "POSITION", "POSRAD", "ANGLE", "MECHANGLE", "THETA"],
  power: ["POWER", "PWR", "P", "PIN", "PELEC"],
  temp: ["TEMP", "TEMPERATURE", "T", "TMOTOR", "TBOARD"],
  eangle: ["EANGLE", "ELEANGLE", "EELANGLE", "ELECANGLE", "THETAE"],
};
/** Map roles → channel index (first match in alias order). Units disambiguate rpm vs rad/s. */
export function channelRoles(defs: ChannelDef[]): Partial<Record<Role, number>> {
  const out: Partial<Record<Role, number>> = {};
  const n = defs.map((d) => norm(d.name));
  for (const role of Object.keys(ROLE_ALIASES) as Role[]) {
    for (const a of ROLE_ALIASES[role]) {
      const k = n.indexOf(a);
      if (k >= 0 && out[role] === undefined) { out[role] = k; break; }
    }
  }
  // unit-driven fixes: a "SPEED" channel in rad/s is omega, an "OMEGA" in rpm is rpm
  if (out.rpm !== undefined && /rad/i.test(defs[out.rpm]!.unit) && out.omega === undefined) { out.omega = out.rpm; delete out.rpm; }
  if (out.omega !== undefined && /rpm/i.test(defs[out.omega]!.unit) && out.rpm === undefined) { out.rpm = out.omega; delete out.omega; }
  return out;
}

/**
 * Parse one TLIST channel line. Accepts "@TL 3 IQ A", "@TL 3=IQ:A", "@TL idx=3 name=IQ unit=A",
 * and the same with tags @T / @CH / @TCH. Returns null for anything else.
 */
export function parseChannelLine(line: string): ChannelDef | null {
  const m = /^@(TL|T|CH|TCH|TLIST)\s+(.+)$/i.exec(line.trim());
  if (!m) return null;
  return parseChannelToken(m[2]!.trim());
}
function parseChannelToken(s: string, fallbackIdx = -1): ChannelDef | null {
  const kv: Record<string, string> = {};
  for (const p of s.split(/\s+/)) { const i = p.indexOf("="); if (i > 0 && /^(idx|i|id|name|n|unit|u)$/i.test(p.slice(0, i))) kv[p.slice(0, i).toLowerCase()] = p.slice(i + 1); }
  if (kv.name ?? kv.n) {
    const idx = Number(kv.idx ?? kv.i ?? kv.id ?? fallbackIdx);
    return Number.isInteger(idx) && idx >= 0 ? { idx, name: (kv.name ?? kv.n)!, unit: unitOf(kv.unit ?? kv.u) } : null;
  }
  const parts = s.split(/\s+/);
  let a = parts[0] ?? "";
  // "3=IQ:A" / "3:IQ:A"
  const m = /^(\d+)[=:]([^:\s]+)(?::(\S*))?$/.exec(a);
  if (m) return { idx: Number(m[1]), name: m[2]!, unit: unitOf(m[3] ?? parts[1]) };
  if (/^\d+$/.test(a) && parts[1]) return { idx: Number(a), name: parts[1]!.replace(/:.*/, ""), unit: unitOf(parts[1]!.includes(":") ? parts[1]!.split(":")[1] : parts[2]) };
  if (fallbackIdx >= 0 && /^[A-Za-z_][\w.]*$/.test(a.replace(/:.*/, ""))) {
    const [nm, u] = a.split(":");
    return { idx: fallbackIdx, name: nm!, unit: unitOf(u ?? parts[1]) };
  }
  return null;
}
const unitOf = (u: string | undefined) => (!u || u === "-" || u === "_" ? "" : u);
/** Units for the DR4310 v3 firmware channel names (TLIST carries names only). */
const FW_UNITS: Record<string, string> = {
  IDREF: "A", ID: "A", IQREF: "A", IQ: "A", VDUNSAT: "V", VQUNSAT: "V", VDSAT: "V", VQSAT: "V", VBUS: "V", VSAT: "0/1",
  OMEGA: "rad/s", IA: "A", IB: "A", IC: "A", VD: "V", VQ: "V", RPM: "rpm", POSRAD: "rad", ELECANGLE: "rad", POWER: "W", IQLIMIT: "A",
};
export const fwUnit = (name: string) => FW_UNITS[norm(name)] ?? "";

/** Inline list in an @OK TLIST text ("0:IQ:A 1:ID:A …" or "IQ,ID,…"); [] when it only carries a count. */
export function parseChannelListText(text: string): ChannelDef[] {
  const body = text.replace(/\bn=\d+\b/i, "").replace(/^\s*\d+\s*$/, "").trim();
  if (!body) return [];
  const toks = body.replace(/^ch=/i, "").split(/[\s,;]+/).filter(Boolean);
  const out: ChannelDef[] = [];
  toks.forEach((t, k) => { const d = parseChannelToken(t, k); if (d) out.push(d); });
  for (const d of out) if (!d.unit) d.unit = fwUnit(d.name);
  return out;
}

/**
 * Active channel list from a TCH reply ("@OK TCH n=4 ch=IQ,IQ_REF,7,VBUS"); numeric entries are
 * resolved through the TLIST catalogue. Returns null if the reply carries no list.
 */
export function parseTch(r: Reply, catalogue: ChannelDef[]): ChannelDef[] | null {
  // v3 firmware answers a TCH query with one line "@TCH IdRef,Id,…" (always 16 names, no @OK)
  if (r.type !== "OK" && r.type !== "INFO" && !(r.type === "TAG" && /^TCH$/i.test(r.cmd))) return null;
  const kv = r.kv;
  let list = kv.ch ?? kv.chs ?? kv.channels ?? kv.list;
  if (list === undefined) {
    const rest = r.text.split(/\s+/).filter((t) => t && !t.includes("="));
    if (rest.length) list = rest.join(",");
  }
  if (list === undefined) return null;
  const items = list.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  const out = items.map((it, k) => {
    const [nameOrIdx, unit] = it.split(":");
    if (/^\d+$/.test(nameOrIdx!)) {
      const c = catalogue.find((d) => d.idx === Number(nameOrIdx));
      return { idx: k, name: c?.name ?? "CH" + nameOrIdx, unit: unitOf(unit) || c?.unit || "" };
    }
    const c = catalogue.find((d) => norm(d.name) === norm(nameOrIdx!));
    return { idx: k, name: nameOrIdx!, unit: unitOf(unit) || c?.unit || fwUnit(nameOrIdx!) };
  });
  const n = Number(kv.n);
  return Number.isInteger(n) && n > 0 && n !== out.length ? null : out;
}
/** TCH set command: comma-separated TLIST indices (short enough for the 95-char line limit). */
export function cmdTch(indices: number[]): string {
  const s = "TCH " + indices.map((i) => String(Math.round(i))).join(",");
  if (!indices.length || indices.length > 32 || s.length > 95) throw new Error("通道选择无效");
  return s + "\n";
}
/**
 * TCH set command for the v3 firmware: exactly `slots` channel NAMES (it rejects indices and other
 * counts). The selection comes first; the remaining slots are padded with unselected catalogue
 * channels in catalogue order, so the JustFloat frame width stays `slots`.
 */
export function cmdTchNames(selected: number[], catalogue: ChannelDef[], slots = 16): { line: string; names: string[] } {
  const byIdx = (i: number) => catalogue.find((c) => c.idx === i);
  const names = selected.map((i) => byIdx(i)?.name).filter((n): n is string => !!n);
  if (!names.length || names.length > slots || names.length !== selected.length) throw new Error("通道选择无效");
  for (const c of catalogue) { if (names.length >= slots) break; if (!names.includes(c.name)) names.push(c.name); }
  if (names.length !== slots) throw new Error(`需要 ${slots} 个通道`);
  const line = "TCH " + names.join(",");
  if (line.length > 191) throw new Error("通道命令过长");
  return { line: line + "\n", names };
}
export function parseTrate(r: Reply): number {
  if (r.type !== "OK") return NaN;
  const v = r.kv.hz ?? r.kv.rate ?? r.kv.trate ?? /(\d+(?:\.\d+)?)/.exec(r.text)?.[1];
  return v === undefined ? NaN : Number(v);
}

// ---------------- fault snapshot ----------------
export type FaultSnapshot = { code: number; latched: number; names: string[]; kv: Record<string, string>; t: number };
const hexOrNum = (s: string | undefined) => (s === undefined ? NaN : /^0x/i.test(s) ? parseInt(s, 16) : Number(s));
/** "@FAULT code=0x0008 latched=0x0008 names=BusUndervoltage vbus=5.1 …" (also accepts fault=/flags=). */
export function parseFault(r: { kv: Record<string, string> }, now = Date.now()): FaultSnapshot {
  const kv = r.kv;
  // v3 firmware: "@FAULT active=0x0000 latched=0x0008 snap=1 t=… fault=0x0008 pos= omega= iq= vbus= mode="
  // — active is the CURRENT fault word; fault= is the word captured in the snapshot (history).
  const code = hexOrNum(kv.active ?? kv.code ?? (kv.snap !== undefined ? undefined : kv.fault) ?? kv.flags ?? kv.now);
  const latched = hexOrNum(kv.latched ?? kv.latch ?? kv.code ?? kv.fault);
  const names = (kv.names ?? kv.name ?? "").split(/[,|]+/).filter(Boolean);
  return { code: Number.isFinite(code) ? code : 0, latched: Number.isFinite(latched) ? latched : 0, names, kv, t: now };
}
export function parseSetZero(r: Reply): number {
  if (r.type !== "OK") return NaN;
  const v = r.kv.zero ?? r.kv.ZERO_OFFSET ?? r.kv.offset ?? r.kv.zero_offset;
  return v === undefined ? NaN : Number(v);
}

// ---------------- units / display ----------------
/** Direct-drive motor (no reduction): speed/position are shown exactly as the firmware reports them. */
export type Display = { kt: number };
/** Iq (A) → N·m (Iq·Kt, no gear factor). NaN without Kt. */
export const torqueNm = (iq: number, d: Display) => (d.kt > 0 ? iq * d.kt : NaN);
/** Electrical input power from dq quantities (amplitude-invariant transform): P = 1.5·(Vd·Id + Vq·Iq). */
export const dqPower = (vd: number, id: number, vq: number, iq: number) => 1.5 * (vd * id + vq * iq);
/** Mechanical power from torque constant: P = Kt·Iq·ω (rotor). */
export const mechPower = (iq: number, kt: number, rpm: number) => iq * kt * rpm * (Math.PI / 30);

// ---------------- host ramp (指令时间 when firmware has no *_RAMP_MS) ----------------
export class Ramp {
  from = 0; to = 0; t0 = 0; dur = 0; active = false;
  start(from: number, to: number, durMs: number, now: number): void {
    this.from = from; this.to = to; this.t0 = now; this.dur = Math.max(0, durMs); this.active = this.dur > 0 && from !== to;
  }
  value(now: number): number {
    if (!this.active) return this.to;
    const u = (now - this.t0) / this.dur;
    if (u >= 1) { this.active = false; return this.to; }
    return this.from + (this.to - this.from) * Math.max(0, u);
  }
  stop(): void { this.active = false; }
}

// ---------------- waveform generator ----------------
export type Wave = "sine" | "square" | "triangle";
export function waveValue(kind: Wave, tSec: number, amp: number, offset: number, freqHz: number): number {
  const ph = ((tSec * freqHz) % 1 + 1) % 1;
  let u: number;
  if (kind === "sine") u = Math.sin(2 * Math.PI * ph);
  else if (kind === "square") u = ph < 0.5 ? 1 : -1;
  else u = ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;
  return offset + amp * u;
}
/** Safety caps: clamp |offset|+|amp| into ±limit and frequency into (0, fMax]. */
export function capWave(amp: number, offset: number, freq: number, limit: number, fMax: number): { amp: number; offset: number; freq: number; capped: boolean } {
  let a = Math.abs(Number.isFinite(amp) ? amp : 0), o = Number.isFinite(offset) ? offset : 0, f = Number.isFinite(freq) ? freq : 0;
  let capped = false;
  if (Math.abs(o) > limit) { o = Math.sign(o) * limit; capped = true; }
  if (Math.abs(o) + a > limit) { a = Math.max(0, limit - Math.abs(o)); capped = true; }
  if (f <= 0) { f = 0.1; capped = true; }
  if (f > fMax) { f = fMax; capped = true; }
  return { amp: a, offset: o, freq: f, capped };
}

// ---------------- parameter profiles ----------------
export type Profile = { type: "dr4310-profile"; version: 1; created: string; fw?: string; ver?: string; params: Record<string, number>; host?: Record<string, unknown> };
export function makeProfile(params: Record<string, number>, fw?: string, ver?: string, host?: Record<string, unknown>): Profile {
  return { type: "dr4310-profile", version: 1, created: new Date().toISOString(), fw, ver, params, host };
}
/** Validate an imported profile; returns the numeric params or throws with a readable message. */
export function readProfile(json: string): Profile {
  let o: unknown;
  try { o = JSON.parse(json); } catch { throw new Error("不是有效的 JSON 文件"); }
  const p = o as Partial<Profile>;
  if (!p || p.type !== "dr4310-profile" || typeof p.params !== "object" || !p.params) throw new Error("不是 DR4310 参数文件（缺少 type/params）");
  const params: Record<string, number> = {};
  for (const [k, v] of Object.entries(p.params)) {
    if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(k)) throw new Error("非法参数名：" + k);
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`参数 ${k} 不是数字`);
    params[k] = v;
  }
  return { type: "dr4310-profile", version: 1, created: String(p.created ?? ""), fw: p.fw, ver: p.ver, params, host: p.host };
}
