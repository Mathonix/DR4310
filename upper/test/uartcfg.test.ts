import { describe, expect, it } from "vitest";
import {
  PARAM_GROUPS, PARAM_META, UartStreamParser, checkOverlimitIq, checkParam, formatOverlimit, metaFor, cmd, cmdGet, cmdSet,
  encodeJustFloat, errText, fnum, overlimitAvailable, overlimitFieldsEnabled, paramWriteOrder, parseInfo, parseOverlimit, parseReply, replyKeyFor,
} from "../src/uartcfg-protocol";
import { POSITION_RANGES, SPEED_RANGES, decodeFaults } from "../src/protocol";

const enc = new TextEncoder();
const frame = (base: number) => encodeJustFloat(Array.from({ length: 16 }, (_, k) => base + k));
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

describe("command builders", () => {
  it("formats numbers compactly", () => {
    expect(fnum(0.1)).toBe("0.1");
    expect(fnum(-0)).toBe("0");
    expect(fnum(1 / 3)).toBe("0.3333333");
    expect(() => fnum(NaN)).toThrow();
  });
  it("builds lines and clamps", () => {
    expect(cmd("ping")).toBe("PING\n");
    expect(cmdSet("can_id", 3)).toBe("SET CAN_ID 3\n");
    expect(cmdGet()).toBe("GET\n");
    expect(cmdGet("cur_kp")).toBe("GET CUR_KP\n");
  });
  it("rejects over-long lines", () => {
    expect(() => cmd("X".repeat(100))).toThrow();
  });
  it("maps reply keys incl. aliases", () => {
    expect(replyKeyFor("PING\n")).toBe("PONG");
    expect(replyKeyFor("idle")).toBe("STOP");
    expect(replyKeyFor("CURRENT")).toBe("RUN");
    expect(replyKeyFor("set cur_kp=1")).toBe("SET");
    expect(replyKeyFor("CALIBRATE")).toBe("CALIB");
  });
});

describe("param metadata / validation", () => {
  it("covers the 21 v2 firmware keys plus flagged v3 keys (CAN 1..7)", () => {
    const v2 = ["CAN_ID", "BOOT_MODE", "BOOT_TARGET", "BOOT_AE", "TELEM", "TIMEOUT_MS", "CUR_KP", "CUR_KI", "CUR_VLIM", "IQ_LIM", "SPD_KP", "SPD_KI", "SPD_KD",
      "ACCEL", "POS_KP", "POS_KI", "POS_KD", "POS_ISEP", "POS_VLIM", "MIT_KP", "MIT_KD"];
    expect(PARAM_META.filter((p) => !p.v3).map((p) => p.key).sort()).toEqual([...v2].sort());
    expect(PARAM_META.filter((p) => p.v3).map((p) => p.key).sort()).toEqual(["CAN_BAUD", "COG_EN", "COG_GAIN", "COG_LIM", "CUR_RAMP_MS", "ENC_DIR", "GEAR_RATIO", "KT", "LS", "OL_EN", "OL_IQ", "OL_TIME_S", "POLE_PAIRS", "POS_RAMP_MS", "POS_VFF", "RS", "SPD_RAMP_MS", "VBUS_MAX", "VBUS_MIN", "ZERO_OFFSET"]);
    expect(new Set(PARAM_META.map((p) => p.key)).size).toBe(PARAM_META.length);
    expect(metaFor("CAN_ID").page).toBe("comm");
    expect(metaFor("KT").page).toBe("motor");
    expect(metaFor("SPD_RAMP_MS").group).toBe("ramp");
    expect(metaFor("NEW_THING", 0, 5, true)).toMatchObject({ page: "other", group: "other", min: 0, max: 5, reboot: true, name: "NEW_THING" });
    expect(checkParam("CAN_ID", 0)).toMatch(/范围/);
    expect(checkParam("CAN_ID", 8)).toMatch(/范围/);
    expect(checkParam("CAN_ID", 2.5)).toMatch(/整数/);
    expect(checkParam("CAN_ID", 7)).toBeNull();
    expect(checkParam("IQ_LIM", 3)).toMatch(/范围/);
    expect(metaFor("IQ_LIM")).toMatchObject({ name: "最大电流", group: "ilim", hidden: true, min: 0, max: 2.5 });
    expect(PARAM_GROUPS.ilim).toBe("电流限制");
    expect(PARAM_META.filter((p) => p.group === "ilim").map((p) => p.key)).toEqual(["IQ_LIM", "OL_EN", "OL_IQ", "OL_TIME_S"]);
    expect(checkParam("SPD_KP", 0.3)).toBeNull();
    // firmware-reported range wins
    expect(checkParam("SPD_KP", 0.3, 0, 0.2)).toMatch(/范围/);
  });
  it("position velocity feedforward accepts zero and fractional gains in the position group", () => {
    expect(metaFor("POS_VFF")).toMatchObject({ page: "drive", group: "pos", min: 0, max: 1, v3: true });
    for (const value of [0, 0.25, 0.5, 1]) {
      expect(checkParam("POS_VFF", value)).toBeNull();
      expect(cmdSet("POS_VFF", value)).toBe(`SET POS_VFF ${value}\n`);
    }
    for (const value of [-0.01, 1.01, NaN, Infinity]) expect(checkParam("POS_VFF", value)).not.toBeNull();
  });
  it("speed/position gain ranges equal the CAN 0x400/0x500 uint16 maps (shared variables)", () => {
    const r = (k: string) => { const m = PARAM_META.find((p) => p.key === k)!; return [m.min, m.max]; };
    expect(r("SPD_KP")).toEqual([SPEED_RANGES.kp[0], SPEED_RANGES.kp[1]]);
    expect(r("SPD_KI")).toEqual([SPEED_RANGES.ki[0], SPEED_RANGES.ki[1]]);
    expect(r("SPD_KD")).toEqual([SPEED_RANGES.kd[0], SPEED_RANGES.kd[1]]);
    expect(r("POS_KP")).toEqual([POSITION_RANGES.kp[0], POSITION_RANGES.kp[1]]);
    expect(r("POS_KI")).toEqual([POSITION_RANGES.ki[0], POSITION_RANGES.ki[1]]);
    expect(r("POS_KD")).toEqual([POSITION_RANGES.kd[0], POSITION_RANGES.kd[1]]);
    expect([r("SPD_KI")[1], r("POS_KP")[1], r("POS_KI")[1], r("POS_KD")[1]]).toEqual([5, 200, 100, 100]);
  });
});

describe("电流限制 / 超限模式", () => {
  const v2keys = () => PARAM_META.filter((p) => !p.v3).map((p) => p.key);
  it("hides overlimit controls on a 2.0.0 parameter set", () => {
    expect(overlimitAvailable(v2keys())).toBe(false);
    expect(overlimitAvailable(["OL_EN", "OL_IQ"])).toBe(false);
    expect(overlimitAvailable([...v2keys(), "OL_EN", "OL_IQ", "OL_TIME_S"])).toBe(true);
    expect(overlimitFieldsEnabled(false, true)).toBe(false);
    expect(overlimitFieldsEnabled(true, false)).toBe(false);
    expect(overlimitFieldsEnabled(true, true)).toBe(true);
  });
  it("sends IQ_LIM before OL_IQ and keeps TELEM last, independent of list order", () => {
    expect(paramWriteOrder(["OL_IQ", "SPD_KP", "IQ_LIM", "TELEM", "OL_EN"])).toEqual(["SPD_KP", "IQ_LIM", "OL_EN", "OL_IQ", "TELEM"]);
    expect(paramWriteOrder(["TELEM", "OL_IQ", "BOOT_AE", "IQ_LIM"])).toEqual(["BOOT_AE", "IQ_LIM", "OL_IQ", "TELEM"]);
    expect(paramWriteOrder(["BOOT_AE", "SPD_KP"])).toEqual(["BOOT_AE", "SPD_KP"]);
    expect(paramWriteOrder(["IQ_LIM"])).toEqual(["IQ_LIM"]);
  });
  it("requires OL_IQ >= IQ_LIM and inside the firmware range", () => {
    expect(checkOverlimitIq(2.5, 2.5)).toBeNull();
    expect(checkOverlimitIq(2.8, 2.5)).toBeNull();
    expect(checkOverlimitIq(2.4, 2.5)).toMatch(/须 ≥ 最大电流 2\.5/);
    expect(checkOverlimitIq(2.9, 2.5)).toMatch(/范围/);
    expect(checkOverlimitIq(2.7, 2, 0, 2.6)).toMatch(/0\.\.2\.6/);
    expect(checkOverlimitIq(2.6, 2, 0, 2.6)).toBeNull();
    expect(checkOverlimitIq(NaN, 2.5)).toMatch(/无效/);
  });
  it("parses INFO ol / budget, including aliases and missing fields", () => {
    const kv = (s: string) => { const r = parseReply(s.startsWith("@") ? s : "@INFO " + s); return r.type === "INFO" ? r.kv : {}; };
    expect(parseOverlimit(kv("@INFO fw=DR4310 ver=3.1.0 ol=off"))).toEqual({ state: "off", budget: null });
    expect(formatOverlimit(parseOverlimit(kv("ol=off")))).toBe("超限：关闭");
    expect(parseOverlimit(kv("ol=ready budget=2"))).toEqual({ state: "ready", budget: 2 });
    expect(formatOverlimit(parseOverlimit(kv("ol=ready budget=2")))).toBe("超限：就绪 2.0 s");
    expect(parseOverlimit(kv("ol=active budget=0.85"))).toEqual({ state: "active", budget: 0.85 });
    expect(formatOverlimit(parseOverlimit(kv("ol=active budget=0.85")))).toBe("超限：超限中 0.85 s");
    expect(parseOverlimit(kv("ol=recover budget=0.4"))).toMatchObject({ state: "recover", budget: 0.4 });
    expect(formatOverlimit(parseOverlimit(kv("ol=recover budget=0.40")))).toBe("超限：恢复中 0.4 s");
    expect(parseOverlimit(kv("ol=ready budget=2 olb=0.1 ol_budget=9"))!.budget).toBe(2);
    expect(parseOverlimit(kv("ol=ready olb=1.25"))!.budget).toBe(1.25);
    expect(parseOverlimit(kv("OL=RECOVER ol_budget=0.5"))).toEqual({ state: "recover", budget: 0.5 });
    expect(parseOverlimit(kv("ol=ready budget="))).toEqual({ state: "ready", budget: null });
    expect(formatOverlimit(parseOverlimit(kv("ol=ready")))).toBe("超限：就绪");
    expect(parseOverlimit(kv("fw=DR4310 ver=2.0.0"))).toBeNull();
    expect(parseOverlimit(kv("ol=nope budget=1"))).toBeNull();
    expect(formatOverlimit(null)).toBe("");
    const info = parseInfo(kv("@INFO fw=DR4310 ver=3.1.0 ol=active budget=0.85"));
    expect(info.ol).toEqual({ state: "active", budget: 0.85 });
    expect(parseInfo(kv("@INFO fw=DR4310 ver=2.0.0")).ol).toBeNull();
  });
});

describe("reply parsing", () => {
  it("parses OK/ERR", () => {
    const ok = parseReply("@OK SAVE seq=12");
    expect(ok).toMatchObject({ type: "OK", cmd: "SAVE", text: "seq=12" });
    if (ok.type === "OK") expect(ok.kv.seq).toBe("12");
    const err = parseReply("@ERR SET range CAN_ID 1..7\r\n");
    expect(err).toMatchObject({ type: "ERR", cmd: "SET", text: "range CAN_ID 1..7" });
    if (err.type === "ERR") expect(errText(err.text)).toBe("超出范围：CAN_ID 1..7");
    expect(errText("not_idle")).toMatch(/空闲/);
    expect(parseReply("@OK STOP")).toMatchObject({ type: "OK", cmd: "STOP", text: "" });
  });
  it("parses @P lines", () => {
    expect(parseReply("@P CAN_ID=2 min=1 max=7 reboot=1")).toMatchObject({ type: "P", key: "CAN_ID", value: 2, min: 1, max: 7, reboot: true });
    expect(parseReply("@P SPD_KP=0.25 min=0 max=10")).toMatchObject({ type: "P", key: "SPD_KP", value: 0.25, reboot: false });
  });
  it("parses INFO", () => {
    const r = parseReply("@INFO fw=DR4310 ver=2.0.0 id=2 cfg_id=3 mode=0 run=IDLE drv=0 ae=0 telem=1 fault=0x0000 latched=0x0042 vbus=12.1 calib=1 zero=0.12578 dir=1 cfg=flash seq=12 timeout=0 trips=0 drops=5 up=12345");
    expect(r.type).toBe("INFO");
    if (r.type !== "INFO") return;
    const i = parseInfo(r.kv);
    expect(i).toMatchObject({ fw: "DR4310", ver: "2.0.0", id: 2, cfgId: 3, run: "IDLE", latched: 0x42, vbus: 12.1, cfg: "flash", seq: 12 });
    expect(decodeFaults(i.latched)).toEqual(["过流", "母线欠压"]);
  });
  it("parses EVT/PONG and junk", () => {
    expect(parseReply("@EVT TIMEOUT disabled ms=500")).toMatchObject({ type: "EVT", cmd: "TIMEOUT" });
    expect(parseReply("@PONG up=5")).toMatchObject({ type: "PONG" });
    expect(parseReply("hello").type).toBe("UNKNOWN");
    expect(parseReply("@FAULT code=0x0040 latched=0x0042 vbus=9.8")).toMatchObject({ type: "TAG", cmd: "FAULT", kv: { code: "0x0040", latched: "0x0042", vbus: "9.8" } });
    expect(parseReply("@TL 3 IQ A")).toMatchObject({ type: "TAG", cmd: "TL", text: "3 IQ A" });
  });
});

describe("UartStreamParser (JustFloat + @lines)", () => {
  it("splits interleaved frames and lines", () => {
    const p = new UartStreamParser();
    const data = cat(frame(0), enc.encode("@OK STOP\n"), frame(100), enc.encode("@P CAN_ID=2 min=1 max=7 reboot=1\n"), frame(200));
    const r = p.push(data);
    expect(r.frames.length).toBe(3);
    expect(r.frames[1]![0]).toBe(100);
    expect(r.frames[2]![15]).toBe(215);
    expect(r.lines).toEqual(["@OK STOP", "@P CAN_ID=2 min=1 max=7 reboot=1"]);
    expect(p.dropped).toBe(0);
  });
  it("handles byte-by-byte delivery", () => {
    const p = new UartStreamParser();
    const data = cat(frame(1), enc.encode("@PONG up=1\r\n"), frame(2));
    let frames = 0; const lines: string[] = [];
    for (const b of data) { const r = p.push(Uint8Array.of(b)); frames += r.frames.length; lines.push(...r.lines); }
    expect(frames).toBe(2);
    expect(lines).toEqual(["@PONG up=1"]);
  });
  it("resyncs after connecting mid-frame and mid-line", () => {
    const p = new UartStreamParser();
    const f = frame(5);
    const r = p.push(cat(f.subarray(30), enc.encode("@OK X\n"), frame(7), enc.encode("@OK Y\n")));
    expect(r.frames.length).toBe(1);
    expect(r.frames[0]![0]).toBe(7);
    expect(r.lines).toContain("@OK Y");
    expect(p.dropped).toBeGreaterThan(0);
  });
  it("works with telemetry off (lines only), incl. a junk fragment", () => {
    const p = new UartStreamParser();
    const r = p.push(enc.encode("K STOP\n@PONG up=9\n@OK TELEM telem=0\n"));
    expect(r.lines).toEqual(["@PONG up=9", "@OK TELEM telem=0"]);
    expect(r.frames.length).toBe(0);
  });
  it("does not mistake a frame starting with '@' (0x40) for a line", () => {
    const p = new UartStreamParser();
    const f = encodeJustFloat([3.0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // 3.0 = 00 00 40 40
    const g = encodeJustFloat([2.0000002, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(g[0]).toBeDefined();
    const r = p.push(cat(f, g, enc.encode("@OK A\n")));
    expect(r.frames.length).toBe(2);
    expect(r.lines).toEqual(["@OK A"]);
  });
  it("waits for incomplete lines", () => {
    const p = new UartStreamParser();
    expect(p.push(enc.encode("@OK SA")).lines).toEqual([]);
    expect(p.push(enc.encode("VE seq=3\n")).lines).toEqual(["@OK SAVE seq=3"]);
  });
  it("fuzz: random chunking of interleaved frames/lines loses nothing", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const p = new UartStreamParser();
    const L = ["@PONG up=123\n", "@P SPD_KP=0.25 min=0 max=10\n", "@OK STOP\n", "@EVT TIMEOUT disabled ms=500\n"];
    let sf = 0, sl = 0, gf = 0, gl = 0;
    for (let it = 0; it < 5000; it++) {
      const parts: Uint8Array[] = [];
      if (rnd() < 0.5) { parts.push(enc.encode(L[it % 4]!)); sl++; }
      parts.splice(Math.floor(rnd() * (parts.length + 1)), 0, encodeJustFloat(Array.from({ length: 16 }, (_, k) => Math.sin(it / 50 + k) * (k + 1)))); sf++;
      const all = cat(...parts);
      for (let i = 0; i < all.length;) { const n = 1 + Math.floor(rnd() * 40); const r = p.push(all.slice(i, i + n)); gf += r.frames.length; gl += r.lines.length; i += n; }
    }
    expect(gf).toBe(sf);
    expect(gl).toBe(sl);
    expect(p.dropped).toBe(0);
  });
});

describe("UartStreamParser variable width (v3 TCH)", () => {
  const fN = (n: number, base: number) => encodeJustFloat(Array.from({ length: n }, (_, k) => base + k));
  it("parses an explicit channel count", () => {
    const p = new UartStreamParser();
    p.setChannels(4);
    const r = p.push(cat(fN(4, 1), enc.encode("@OK TCH n=4 ch=IQ,ID,VBUS,RPM\n"), fN(4, 10)));
    expect(r.frames.map((f) => Array.from(f))).toEqual([[1, 2, 3, 4], [10, 11, 12, 13]]);
    expect(r.lines).toEqual(["@OK TCH n=4 ch=IQ,ID,VBUS,RPM"]);
    expect(p.dropped).toBe(0);
  });
  it("auto-detects a width change from 16 to 6 channels", () => {
    const p = new UartStreamParser();
    let seen = 0;
    p.onChannels = (n) => { seen = n; };
    const parts: Uint8Array[] = [fN(16, 0), fN(16, 0)];
    for (let i = 0; i < 6; i++) parts.push(fN(6, i * 10));
    const r = p.push(cat(...parts));
    expect(seen).toBe(6);
    expect(p.channels).toBe(6);
    const six = r.frames.filter((f) => f.length === 6);
    expect(six.length).toBeGreaterThanOrEqual(3);
    expect(Array.from(six[six.length - 1]!)).toEqual([50, 51, 52, 53, 54, 55]);
  });
  it("still splits lines at width 3 when split into tiny chunks", () => {
    const p = new UartStreamParser();
    p.setChannels(3);
    const data = cat(fN(3, 7), enc.encode("@FAULT code=0x0000 latched=0x0000\n"), fN(3, 8));
    const frames: Float32Array[] = [], lines: string[] = [];
    for (let i = 0; i < data.length; i += 5) { const r = p.push(data.subarray(i, i + 5)); frames.push(...r.frames); lines.push(...r.lines); }
    expect(frames.length).toBe(2);
    expect(lines).toEqual(["@FAULT code=0x0000 latched=0x0000"]);
  });
});
