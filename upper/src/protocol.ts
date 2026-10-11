/**
 * DR4310 (STM32G431 FOC) host protocol — pure encoders/decoders.
 * Source of truth: the user's current firmware (Core/Src/main.c with 0x400/0x500 speed/position
 * frames, speed full-scale ±1000 rpm), Libraries/App/src/gm6020_can.c, Libraries/App/src/control_app.cpp.
 */

// ---------------- Native CAN protocol ----------------
export const NATIVE_CONTROL_BASE = 0x100;
export const NATIVE_STATUS_BASE = 0x180;

export const CMD = {
  DISABLE: 0x00,
  CURRENT: 0x01,
  // 0x02 (speed) and 0x05 (position) were REMOVED from 0x100+id: use the 0x400/0x500 frames.
  ESTOP: 0x03,
  SET_PARAM: 0x04,
  MIT: 0x06,
  SET_MODE: 0x07,
  AUTO_ENABLE: 0x08,
} as const;

export const MODE = { DISABLED: 0, CURRENT: 1, SPEED: 2, POSITION: 3, MIT: 4 } as const;
export const MODE_NAMES: Record<number, string> = {
  0: "失能 / 空闲",
  1: "电流环",
  2: "速度环",
  3: "位置环",
  4: "MIT",
};

export type ParamDef = { id: number; key: string; name: string; unit: string; def: number; note?: string };
/** CAN cmd 0x04 parameter IDs (RAM only, negative → 0 in firmware). Defaults = firmware compile-time values. */
export const PARAMS: ParamDef[] = [
  { id: 0x01, key: "curKp", name: "电流环 Kp", unit: "", def: 6 },
  { id: 0x02, key: "curKi", name: "电流环 Ki", unit: "", def: 6816 },
  { id: 0x03, key: "curLim", name: "电流 PI 输出电压限幅", unit: "V", def: 0, note: "不是 Iq 上限；0 不会被固件接受（仅 >0 生效）" },
  { id: 0x04, key: "posKp", name: "位置环 Kp", unit: "", def: 3.5, note: "下一帧 0x500+ID 位置帧会覆盖" },
  { id: 0x05, key: "posKd", name: "位置环 Kd", unit: "", def: 2.6, note: "下一帧 0x500+ID 位置帧会覆盖" },
  { id: 0x06, key: "mitKp", name: "MIT 默认 Kp", unit: "", def: 10 },
  { id: 0x07, key: "mitKd", name: "MIT 默认 Kd", unit: "", def: 0.5 },
  { id: 0x08, key: "posKi", name: "位置环 Ki", unit: "", def: 1.2, note: "下一帧 0x500+ID 位置帧会覆盖" },
  { id: 0x09, key: "posIsep", name: "位置积分分离阈值", unit: "rad", def: 0.35 },
];

export const LIMITS = {
  currentA: 2.5,
  speedRpm: 1000,
  positionRad: 500,
} as const;

export function nativeControlId(motorId: number): number {
  return NATIVE_CONTROL_BASE + (motorId & 0x7f);
}
export function nativeStatusId(motorId: number): number {
  return NATIVE_STATUS_BASE + (motorId & 0x7f);
}

export function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < lo ? lo : x > hi ? hi : x;
}

/** Generic native frame: [cmd][param][f32 LE][0][0]. */
export function encodeNative(cmd: number, value = 0, param = 0): Uint8Array {
  const d = new Uint8Array(8);
  d[0] = cmd & 0xff;
  d[1] = param & 0xff;
  new DataView(d.buffer).setFloat32(2, Number.isFinite(value) ? value : 0, true);
  return d;
}

export const nativeDisable = () => encodeNative(CMD.DISABLE);
export const nativeEstop = () => encodeNative(CMD.ESTOP);
/** Host-side clamping mirrors firmware clamping so the UI shows what will really apply. */
export const nativeCurrent = (a: number) => encodeNative(CMD.CURRENT, clamp(a, -LIMITS.currentA, LIMITS.currentA));
export const nativeEnterMit = () => encodeNative(CMD.MIT);
export const nativeSetMode = (mode: number) => encodeNative(CMD.SET_MODE, 0, mode);
export const nativeSetParam = (paramId: number, value: number) =>
  encodeNative(CMD.SET_PARAM, Math.max(0, Number.isFinite(value) ? value : 0), paramId);
export const nativeAutoEnable = (on: boolean) => encodeNative(CMD.AUTO_ENABLE, 0, on ? 1 : 0);

// ---------------- Speed / position frames (0x400+id / 0x500+id) ----------------
/**
 * No command byte: the identifier is the command. Data = four little-endian uint16 linear maps
 * [0:2] target  [2:4] Kp  [4:6] Ki  [6:8] Kd;  raw = round((x-min)/(max-min)*65535).
 * Every frame writes all three gains, switches the firmware to speed/position mode and sets the target
 * (no separate enable needed; cancels a GM6020 session and leaves MIT).
 */
export const SPEED_CMD_BASE = 0x400;
export const POSITION_CMD_BASE = 0x500;
export type GainFrame = { target: number; kp: number; ki: number; kd: number };
export type U16Ranges = { target: readonly [number, number]; kp: readonly [number, number]; ki: readonly [number, number]; kd: readonly [number, number] };
export const SPEED_RANGES: U16Ranges = { target: [-1000, 1000], kp: [0, 10], ki: [0, 5], kd: [0, 1] };
export const POSITION_RANGES: U16Ranges = { target: [-500, 500], kp: [0, 200], ki: [0, 100], kd: [0, 100] };
export const SPEED_FACTORY: GainFrame = { target: 0, kp: 0.25, ki: 0.02, kd: 0 };
export const POSITION_FACTORY: GainFrame = { target: 0, kp: 3.5, ki: 1.2, kd: 2.6 };

export const speedCmdId = (motorId: number) => SPEED_CMD_BASE + (motorId & 0x7f);
export const positionCmdId = (motorId: number) => POSITION_CMD_BASE + (motorId & 0x7f);

function packU16(f: GainFrame, r: U16Ranges): Uint8Array {
  const d = new Uint8Array(8);
  const dv = new DataView(d.buffer);
  dv.setUint16(0, floatToUint(f.target, r.target[0], r.target[1], 16), true);
  dv.setUint16(2, floatToUint(f.kp, r.kp[0], r.kp[1], 16), true);
  dv.setUint16(4, floatToUint(f.ki, r.ki[0], r.ki[1], 16), true);
  dv.setUint16(6, floatToUint(f.kd, r.kd[0], r.kd[1], 16), true);
  return d;
}
function unpackU16(d: Uint8Array, r: U16Ranges): GainFrame {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    target: uintToFloat(dv.getUint16(0, true), r.target[0], r.target[1], 16),
    kp: uintToFloat(dv.getUint16(2, true), r.kp[0], r.kp[1], 16),
    ki: uintToFloat(dv.getUint16(4, true), r.ki[0], r.ki[1], 16),
    kd: uintToFloat(dv.getUint16(6, true), r.kd[0], r.kd[1], 16),
  };
}
export const encodeSpeedFrame = (motorId: number, f: GainFrame) => ({ id: speedCmdId(motorId), data: packU16(f, SPEED_RANGES) });
export const encodePositionFrame = (motorId: number, f: GainFrame) => ({ id: positionCmdId(motorId), data: packU16(f, POSITION_RANGES) });
export const decodeSpeedFrame = (d: Uint8Array) => unpackU16(d, SPEED_RANGES);
export const decodePositionFrame = (d: Uint8Array) => unpackU16(d, POSITION_RANGES);
/** Values the firmware will actually apply after 16-bit quantisation (e.g. Kp 0.25 → 0.249943). */
export const quantizedSpeed = (f: GainFrame) => decodeSpeedFrame(packU16(f, SPEED_RANGES));
export const quantizedPosition = (f: GainFrame) => decodePositionFrame(packU16(f, POSITION_RANGES));

// ---------------- MIT pack (Cheetah 8-byte) ----------------
export const MIT_RANGE = {
  p: [-50, 50],
  v: [-50, 50],
  kp: [0, 500],
  kd: [0, 5],
  t: [-2.5, 2.5],
} as const;

export function floatToUint(x: number, min: number, max: number, bits: number): number {
  const span = max - min;
  const maxInt = (1 << bits) - 1;
  if (span <= 0) return 0;
  const c = clamp(x, min, max);
  return Math.round(((c - min) * maxInt) / span);
}
export function uintToFloat(x: number, min: number, max: number, bits: number): number {
  const maxInt = (1 << bits) - 1;
  return (x * (max - min)) / maxInt + min;
}

export type MitCmd = { p: number; v: number; kp: number; kd: number; t: number };

export function packMit(c: MitCmd): Uint8Array {
  const p = floatToUint(c.p, MIT_RANGE.p[0], MIT_RANGE.p[1], 16);
  const v = floatToUint(c.v, MIT_RANGE.v[0], MIT_RANGE.v[1], 12);
  const kp = floatToUint(c.kp, MIT_RANGE.kp[0], MIT_RANGE.kp[1], 12);
  const kd = floatToUint(c.kd, MIT_RANGE.kd[0], MIT_RANGE.kd[1], 12);
  const t = floatToUint(c.t, MIT_RANGE.t[0], MIT_RANGE.t[1], 12);
  const d = new Uint8Array(8);
  d[0] = (p >> 8) & 0xff;
  d[1] = p & 0xff;
  d[2] = (v >> 4) & 0xff;
  d[3] = ((v & 0x0f) << 4) | ((kp >> 8) & 0x0f);
  d[4] = kp & 0xff;
  d[5] = (kd >> 4) & 0xff;
  d[6] = ((kd & 0x0f) << 4) | ((t >> 8) & 0x0f);
  d[7] = t & 0xff;
  return d;
}

export function unpackMit(d: Uint8Array): MitCmd {
  const p = (d[0]! << 8) | d[1]!;
  const v = (d[2]! << 4) | (d[3]! >> 4);
  const kp = ((d[3]! & 0x0f) << 8) | d[4]!;
  const kd = (d[5]! << 4) | (d[6]! >> 4);
  const t = ((d[6]! & 0x0f) << 8) | d[7]!;
  return {
    p: uintToFloat(p, MIT_RANGE.p[0], MIT_RANGE.p[1], 16),
    v: uintToFloat(v, MIT_RANGE.v[0], MIT_RANGE.v[1], 12),
    kp: uintToFloat(kp, MIT_RANGE.kp[0], MIT_RANGE.kp[1], 12),
    kd: uintToFloat(kd, MIT_RANGE.kd[0], MIT_RANGE.kd[1], 12),
    t: uintToFloat(t, MIT_RANGE.t[0], MIT_RANGE.t[1], 12),
  };
}

/**
 * While in MIT mode the firmware checks escape frames first:
 * byte0==0x07 → SET_MODE; byte0 in {0x00,0x03} with bytes1..7 all zero → disable.
 * Returns a warning string if this pack would be misinterpreted.
 */
export function mitPackConflict(d: Uint8Array): string | null {
  if (d[0] === CMD.SET_MODE) return "该 MIT 帧首字节为 0x07，固件会当作「切换模式」而非 MIT 指令（p≈-49.3 rad 附近）";
  const restZero = d.subarray(1).every((b) => b === 0);
  if ((d[0] === 0 || d[0] === 3) && restZero) return "该 MIT 帧被固件识别为失能/急停逃生帧";
  return null;
}

// ---------------- Native status (0x180+id, 10 Hz) ----------------
export type NativeStatus = {
  mode: number;
  faults: number; // low 8 bits only
  primary: number; // Iq(A) / rpm / rad / Vbus(V) depending on mode
  rpm: number; // always-on speed, int16 LE / 10
};

export function decodeStatus(d: Uint8Array): NativeStatus | null {
  if (d.length < 8) return null;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    mode: d[0]!,
    faults: d[1]!,
    primary: dv.getFloat32(2, true),
    rpm: dv.getInt16(6, true) / 10,
  };
}

export function primaryLabel(mode: number): { name: string; unit: string } {
  switch (mode) {
    case MODE.CURRENT:
      return { name: "实际 Iq", unit: "A" };
    case MODE.SPEED:
      return { name: "实际转速", unit: "rpm" };
    case MODE.POSITION:
    case MODE.MIT:
      return { name: "实际位置", unit: "rad" };
    default:
      return { name: "母线电压", unit: "V" };
  }
}

export const FAULT_BITS: { bit: number; name: string; cn: string }[] = [
  { bit: 0, name: "CurrentSense", cn: "电流采样" },
  { bit: 1, name: "OverCurrent", cn: "过流" },
  { bit: 2, name: "EncoderComm", cn: "编码器通信" },
  { bit: 3, name: "EncoderCrc", cn: "编码器 CRC" },
  { bit: 4, name: "EncoderMagnet", cn: "编码器磁场" },
  { bit: 5, name: "Driver", cn: "驱动器故障" },
  { bit: 6, name: "BusUndervoltage", cn: "母线欠压" },
  { bit: 7, name: "BusOvervoltage", cn: "母线过压" },
  { bit: 8, name: "FocIsrOverrun", cn: "FOC 中断超时" },
  { bit: 9, name: "OuterLoopDeadline", cn: "外环超时" },
];

export function decodeFaults(mask: number): string[] {
  return FAULT_BITS.filter((f) => (mask >>> f.bit) & 1).map((f) => f.cn);
}

// ---------------- GM6020-style current protocol ----------------
export const GM_SCALE = 16384 / 3; // raw per amp

export function gmCommandId(motorId: number): number {
  return motorId <= 4 ? 0x1fe : 0x2fe;
}
export function gmFeedbackId(motorId: number): number {
  return 0x204 + motorId;
}
export function gmSlot(motorId: number): number {
  return ((motorId - 1) % 4) * 2;
}
export function gmAmpsToRaw(a: number): number {
  const r = Math.round(clamp(a, -LIMITS.currentA, LIMITS.currentA) * GM_SCALE);
  return clamp(r, -16384, 16384);
}

/** Build a GM6020 group frame with only this motor's slot filled (others zero). */
export function encodeGmCurrent(motorId: number, amps: number): { id: number; data: Uint8Array } {
  const d = new Uint8Array(8);
  const raw = gmAmpsToRaw(amps) & 0xffff;
  const s = gmSlot(motorId);
  d[s] = (raw >> 8) & 0xff;
  d[s + 1] = raw & 0xff;
  return { id: gmCommandId(motorId), data: d };
}

export function decodeGmCommand(motorId: number, d: Uint8Array): number {
  const s = gmSlot(motorId);
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return dv.getInt16(s, false) / GM_SCALE;
}

export type GmFeedback = { angleRaw: number; angleDeg: number; rpm: number; iq: number; temp: number | null };

export function decodeGmFeedback(d: Uint8Array): GmFeedback | null {
  if (d.length < 8) return null;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const angleRaw = dv.getUint16(0, false);
  return {
    angleRaw,
    angleDeg: (angleRaw * 360) / 8192,
    rpm: dv.getInt16(2, false),
    iq: dv.getInt16(4, false) / GM_SCALE,
    temp: d[6] === 0xff ? null : d[6]!,
  };
}

// ---------------- UART: VOFA JustFloat + ASCII ----------------
export const JF_TAIL = [0x00, 0x00, 0x80, 0x7f] as const;
export const UART_CHANNELS: { name: string; unit: string }[] = [
  { name: "Id_ref", unit: "A" },
  { name: "Id", unit: "A" },
  { name: "Iq_ref", unit: "A" },
  { name: "Iq", unit: "A" },
  { name: "Vd_unsat", unit: "V" },
  { name: "Vq_unsat", unit: "V" },
  { name: "Vd_sat", unit: "V" },
  { name: "Vq_sat", unit: "V" },
  { name: "Vbus", unit: "V" },
  { name: "电压饱和", unit: "0/1" },
  { name: "ω", unit: "rad/s" },
  { name: "Duty A", unit: "" },
  { name: "Duty B", unit: "" },
  { name: "Duty C", unit: "" },
  { name: "电流 Kp", unit: "" },
  { name: "电流 Ki", unit: "" },
];

/** Streaming JustFloat parser: N little-endian float32 + tail 00 00 80 7F. Resyncs on garbage. */
export class JustFloatParser {
  private buf = new Uint8Array(0);
  frames = 0;
  dropped = 0;
  constructor(public readonly channels = 16, private readonly maxBuf = 4096) {}

  push(chunk: Uint8Array): Float32Array[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    const out: Float32Array[] = [];
    const need = this.channels * 4;
    let start = 0;
    let i = 0;
    while (i + 4 <= merged.length) {
      if (merged[i] === 0x00 && merged[i + 1] === 0x00 && merged[i + 2] === 0x80 && merged[i + 3] === 0x7f) {
        const len = i - start;
        if (len >= need) {
          const fs = new Float32Array(this.channels);
          const dv = new DataView(merged.buffer, merged.byteOffset + i - need, need);
          for (let c = 0; c < this.channels; c++) fs[c] = dv.getFloat32(c * 4, true);
          out.push(fs);
          this.frames++;
          if (len > need) this.dropped++;
        } else if (len > 0) {
          this.dropped++;
        }
        i += 4;
        start = i;
      } else {
        i++;
      }
    }
    let rest = merged.subarray(start);
    if (rest.length > this.maxBuf) {
      this.dropped++;
      rest = rest.subarray(rest.length - need);
    }
    this.buf = rest.slice();
    return out;
  }
}

export function encodeJustFloat(values: number[]): Uint8Array {
  const d = new Uint8Array(values.length * 4 + 4);
  const dv = new DataView(d.buffer);
  values.forEach((v, k) => dv.setFloat32(k * 4, v, true));
  d.set(JF_TAIL, values.length * 4);
  return d;
}

export const UART_LIMITS = { kpMax: 20, kiMax: 20000 } as const;

/** ASCII command line accepted by firmware ExecuteVofaCommand (≤47 chars, '\n' terminated). */
export function asciiCommand(name: string, value?: number): string {
  const n = name.trim().toUpperCase();
  if (value === undefined) return n + "\n";
  if (!Number.isFinite(value)) throw new Error("数值无效");
  const s = `${n} ${Number(value.toPrecision(7))}`;
  if (s.length > 47) throw new Error("命令过长");
  return s + "\n";
}

// ---------------- helpers ----------------
export function hex(d: Uint8Array): string {
  return Array.from(d, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}
export function hexId(id: number): string {
  return "0x" + id.toString(16).toUpperCase().padStart(3, "0");
}
