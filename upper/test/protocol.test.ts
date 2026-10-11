import { describe, expect, it } from "vitest";
import {
  JustFloatParser, asciiCommand, decodeFaults, decodeGmCommand, decodeGmFeedback, decodeStatus,
  encodeGmCurrent, encodeJustFloat, encodeNative, gmCommandId, gmFeedbackId, gmSlot, hex,
  mitPackConflict, nativeAutoEnable, nativeControlId, nativeCurrent, nativeDisable, nativeEstop,
  nativeSetMode, nativeSetParam, nativeStatusId, packMit, unpackMit,
  CMD, POSITION_FACTORY, SPEED_FACTORY, decodePositionFrame, decodeSpeedFrame, encodePositionFrame, encodeSpeedFrame,
  positionCmdId, quantizedSpeed, speedCmdId,
} from "../src/protocol";

describe("native command frames (match docs/CAN_USAGE.md §5.2)", () => {
  it("ids", () => {
    expect(nativeControlId(2)).toBe(0x102);
    expect(nativeStatusId(2)).toBe(0x182);
    expect(nativeControlId(1)).toBe(0x101);
  });
  it("documented examples", () => {
    expect(hex(nativeDisable())).toBe("00 00 00 00 00 00 00 00");
    expect(hex(nativeEstop())).toBe("03 00 00 00 00 00 00 00");
    expect(hex(nativeCurrent(0.1))).toBe("01 00 CD CC CC 3D 00 00");
    expect(hex(nativeSetParam(0x01, 0.5))).toBe("04 01 00 00 00 3F 00 00");
    expect(hex(nativeSetParam(0x02, 50))).toBe("04 02 00 00 48 42 00 00");
  });
  it("clamps like firmware", () => {
    const f = (d: Uint8Array) => new DataView(d.buffer).getFloat32(2, true);
    expect(f(nativeCurrent(9))).toBeCloseTo(2.5);
    expect(f(nativeCurrent(-9))).toBeCloseTo(-2.5);
    expect(f(nativeSetParam(4, -3))).toBe(0);
    expect(f(encodeNative(1, NaN))).toBe(0);
  });
  it("mode / auto-enable", () => {
    expect(hex(nativeSetMode(4))).toBe("07 04 00 00 00 00 00 00");
    expect(hex(nativeAutoEnable(true))).toBe("08 01 00 00 00 00 00 00");
    expect(hex(nativeAutoEnable(false))).toBe("08 00 00 00 00 00 00 00");
  });
});

describe("speed / position frames (0x400+id / 0x500+id, uint16 LE maps)", () => {
  it("100 rpm on the ±1000 rpm map, Kp 0.25 Ki 0.02 Kd 0 -> ID 0x401 CC 8C 66 06 06 01 00 00", () => {
    const f = encodeSpeedFrame(1, { target: 100, kp: 0.25, ki: 0.02, kd: 0 });
    expect(f.id).toBe(0x401);
    expect(hex(f.data)).toBe("CC 8C 66 06 06 01 00 00");
  });
  it("user example: 1.57 rad, Kp 3.5 Ki 1.2 Kd 2.6 -> ID 0x501 66 80 7B 04 12 03 A8 06", () => {
    const f = encodePositionFrame(1, { target: 1.57, kp: 3.5, ki: 1.2, kd: 2.6 });
    expect(f.id).toBe(0x501);
    expect(hex(f.data)).toBe("66 80 7B 04 12 03 A8 06");
  });
  it("doc examples for ID 2 use 0x402 / 0x502 with the same payload", () => {
    expect(speedCmdId(2)).toBe(0x402);
    expect(positionCmdId(2)).toBe(0x502);
    expect(hex(encodeSpeedFrame(2, { target: 100, ...{ kp: 0.25, ki: 0.02, kd: 0 } }).data)).toBe("CC 8C 66 06 06 01 00 00");
  });
  it("factory gains", () => {
    expect(SPEED_FACTORY).toMatchObject({ kp: 0.25, ki: 0.02, kd: 0 });
    expect(POSITION_FACTORY).toMatchObject({ kp: 3.5, ki: 1.2, kd: 2.6 });
  });
  it("decodes like firmware (raw/65535*(max-min)+min)", () => {
    const s = decodeSpeedFrame(Uint8Array.from([0xcc, 0x8c, 0x66, 0x06, 0x06, 0x01, 0, 0]));
    expect(Math.abs(s.target - 100)).toBeLessThan(2000 / 65535);
    expect(s.kp).toBeCloseTo(0.25, 3);
    expect(s.ki).toBeCloseTo(0.02, 3);
    expect(s.kd).toBe(0);
    const p = decodePositionFrame(Uint8Array.from([0x66, 0x80, 0x7b, 0x04, 0x12, 0x03, 0xa8, 0x06]));
    expect(Math.abs(p.target - 1.57)).toBeLessThan(1000 / 65535 / 2 + 1e-9); // resolution 0.01526 rad
    expect(p.kp).toBeCloseTo(3.5, 2);
    expect(p.ki).toBeCloseTo(1.2, 2);
    expect(p.kd).toBeCloseTo(2.6, 2);
    // quantisation: Kp 0.25 -> 0.249943 in firmware
    expect(quantizedSpeed({ target: 0, kp: 0.25, ki: 0.02, kd: 0 }).kp).toBeCloseTo(0.249943, 5);
  });
  it("clamps to the map ranges and endpoints", () => {
    expect(hex(encodeSpeedFrame(1, { target: 1e4, kp: 99, ki: -1, kd: 5 }).data)).toBe("FF FF FF FF 00 00 FF FF");
    expect(hex(encodePositionFrame(1, { target: -1e4, kp: 0, ki: 0, kd: 0 }).data)).toBe("00 00 00 00 00 00 00 00");
    expect(hex(encodeSpeedFrame(1, { target: NaN, kp: 0.25, ki: 0.02, kd: 0 }).data.subarray(0, 2))).toBe("00 80"); // NaN -> 0 -> mid-scale
  });
  it("legacy 0x02 / 0x05 command bytes are gone from the native command table", () => {
    const vals = Object.values(CMD) as number[];
    expect(vals).not.toContain(0x02);
    expect(vals).not.toContain(0x05);
  });
});

describe("MIT pack", () => {
  it("zero command mid-scale", () => {
    // p=0 → 32768 (round of 32767.5), v=0 → 2048, kp=0, kd=0, t=0 → 2048
    expect(hex(packMit({ p: 0, v: 0, kp: 0, kd: 0, t: 0 }))).toBe("80 00 80 00 00 00 08 00");
  });
  it("extremes", () => {
    expect(hex(packMit({ p: 50, v: 50, kp: 500, kd: 5, t: 2.5 }))).toBe("FF FF FF FF FF FF FF FF");
    expect(hex(packMit({ p: -99, v: -99, kp: -1, kd: -1, t: -9 }))).toBe("00 00 00 00 00 00 00 00");
  });
  it("round trip within quantization", () => {
    const c = { p: 1.234, v: -3.5, kp: 20, kd: 0.8, t: 0.3 };
    const u = unpackMit(packMit(c));
    expect(u.p).toBeCloseTo(c.p, 2);
    expect(Math.abs(u.v - c.v)).toBeLessThan(100 / 4095);
    expect(Math.abs(u.kp - c.kp)).toBeLessThan(500 / 4095);
    expect(Math.abs(u.kd - c.kd)).toBeLessThan(5 / 4095);
    expect(Math.abs(u.t - c.t)).toBeLessThan(5 / 4095);
  });
  it("matches python tools/can_motor_gui.py pack_mit (0,0,5,0.1,0)", () => {
    // python: p=32768 v=2048 kp=round(4095*5/500)=41 kd=round(4095*0.1/5)=82 t=2048
    expect(hex(packMit({ p: 0, v: 0, kp: 5, kd: 0.1, t: 0 }))).toBe("80 00 80 00 29 05 28 00");
  });
  it("detects escape conflicts", () => {
    expect(mitPackConflict(new Uint8Array([7, 1, 2, 3, 4, 5, 6, 7]))).toMatch(/0x07/);
    expect(mitPackConflict(new Uint8Array(8))).toMatch(/逃生/);
    expect(mitPackConflict(packMit({ p: 0, v: 0, kp: 5, kd: 0.1, t: 0 }))).toBeNull();
  });
});

describe("native status decode", () => {
  it("decodes float primary + int16 rpm*10 LE", () => {
    const d = new Uint8Array(8);
    const dv = new DataView(d.buffer);
    d[0] = 2;
    d[1] = 0x41;
    dv.setFloat32(2, 123.5, true);
    dv.setInt16(6, -1234, true);
    const s = decodeStatus(d)!;
    expect(s.mode).toBe(2);
    expect(s.faults).toBe(0x41);
    expect(s.primary).toBeCloseTo(123.5);
    expect(s.rpm).toBeCloseTo(-123.4);
  });
  it("handles limits and short frames", () => {
    const d = new Uint8Array([0, 0, 0, 0, 0, 0, 0xff, 0x7f]);
    expect(decodeStatus(d)!.rpm).toBeCloseTo(3276.7);
    expect(decodeStatus(new Uint8Array(4))).toBeNull();
  });
  it("fault bits", () => {
    expect(decodeFaults(0)).toEqual([]);
    expect(decodeFaults(0x42)).toEqual(["过流", "母线欠压"]);
    expect(decodeFaults(0x300)).toEqual(["FOC 中断超时", "外环超时"]);
  });
});

describe("GM6020 protocol", () => {
  it("ids and slots", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(gmCommandId)).toEqual([0x1fe, 0x1fe, 0x1fe, 0x1fe, 0x2fe, 0x2fe, 0x2fe]);
    expect([1, 2, 3, 4, 5, 6, 7].map(gmSlot)).toEqual([0, 2, 4, 6, 0, 2, 4]);
    expect(gmFeedbackId(2)).toBe(0x206);
    expect(gmFeedbackId(7)).toBe(0x20b);
  });
  it("documented example frames (ID=2)", () => {
    expect(hex(encodeGmCurrent(2, 0).data)).toBe("00 00 00 00 00 00 00 00");
    expect(hex(encodeGmCurrent(2, 0.1).data)).toBe("00 00 02 22 00 00 00 00");
    expect(hex(encodeGmCurrent(2, -0.1).data)).toBe("00 00 FD DE 00 00 00 00");
    expect(encodeGmCurrent(2, 0.1).id).toBe(0x1fe);
  });
  it("slot placement for ID 5/7 and clamp to 2.5 A", () => {
    const f5 = encodeGmCurrent(5, 0.1);
    expect(f5.id).toBe(0x2fe);
    expect(hex(f5.data)).toBe("02 22 00 00 00 00 00 00");
    const f7 = encodeGmCurrent(7, 10);
    expect(decodeGmCommand(7, f7.data)).toBeCloseTo(2.5, 3);
    expect(hex(f7.data)).toBe("00 00 00 00 35 55 00 00");
  });
  it("feedback decode", () => {
    const d = new Uint8Array([0x10, 0x00, 0xff, 0x38, 0x02, 0x22, 0xff, 0x00]);
    const fb = decodeGmFeedback(d)!;
    expect(fb.angleRaw).toBe(4096);
    expect(fb.angleDeg).toBe(180);
    expect(fb.rpm).toBe(-200);
    expect(fb.iq).toBeCloseTo(0.1, 3);
    expect(fb.temp).toBeNull();
  });
});

describe("JustFloat parser", () => {
  const vals = Array.from({ length: 16 }, (_, i) => i * 0.5 - 1);
  it("parses a whole frame", () => {
    const p = new JustFloatParser(16);
    const out = p.push(encodeJustFloat(vals));
    expect(out.length).toBe(1);
    expect(Array.from(out[0]!)).toEqual(vals);
  });
  it("handles split chunks and multiple frames", () => {
    const p = new JustFloatParser(16);
    const stream = new Uint8Array([...encodeJustFloat(vals), ...encodeJustFloat(vals.map((v) => -v))]);
    const got: Float32Array[] = [];
    for (let i = 0; i < stream.length; i += 7) got.push(...p.push(stream.subarray(i, i + 7)));
    expect(got.length).toBe(2);
    expect(got[1]![2]).toBe(-vals[2]!);
  });
  it("resyncs after leading garbage", () => {
    const p = new JustFloatParser(16);
    const out = p.push(new Uint8Array([1, 2, 3, ...encodeJustFloat(vals)]));
    expect(out.length).toBe(1);
    expect(out[0]![15]).toBe(vals[15]);
    expect(p.dropped).toBe(1);
  });
  it("drops truncated frames", () => {
    const p = new JustFloatParser(16);
    const out = p.push(new Uint8Array([...encodeJustFloat([1, 2, 3]), ...encodeJustFloat(vals)]));
    expect(out.length).toBe(1);
    expect(p.dropped).toBe(1);
  });
});

describe("ASCII commands", () => {
  it("formats", () => {
    expect(asciiCommand("stop")).toBe("STOP\n");
    expect(asciiCommand("IQ", 0.1)).toBe("IQ 0.1\n");
    expect(asciiCommand("kp", 12)).toBe("KP 12\n");
    expect(() => asciiCommand("IQ", NaN)).toThrow();
  });
});
