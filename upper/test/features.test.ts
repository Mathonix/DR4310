import { describe, expect, it } from "vitest";
import {
  LEGACY_CHANNELS, Ramp, capWave, channelRoles, cmdTch, dqPower, makeProfile, mechPower, parseChannelLine, parseChannelListText,
  parseFault, parseHelp, parseSetZero, parseTch, parseTrate, readProfile, torqueNm, versionMajor, waveValue,
} from "../src/features";
import { parseReply } from "../src/uartcfg-protocol";

describe("feature detection", () => {
  it("parses the v2 HELP list (no v3 commands)", () => {
    const r = parseReply("@OK HELP STOP RUN ZERO CLEAR CALIB IQ KP KI CUR SPD POS MIT MODE AE TELEM PING INFO GET SET SAVE DEFAULTS RELOAD REBOOT");
    const c = parseHelp(r.type === "OK" ? r.text : "");
    expect(c.has("SPD")).toBe(true);
    expect(c.has("TLIST") || c.has("FAULT") || c.has("SETZERO")).toBe(false);
  });
  it("parses a v3 HELP list", () => {
    const c = parseHelp("STOP CLEAR SETZERO TLIST TCH TRATE FAULT GET SET");
    expect(["SETZERO", "TLIST", "TCH", "TRATE", "FAULT"].every((k) => c.has(k))).toBe(true);
  });
  it("versionMajor", () => { expect(versionMajor("3.0.0")).toBe(3); expect(versionMajor("2.0.0")).toBe(2); expect(versionMajor("?")).toBe(0); });
});

describe("telemetry channels", () => {
  it("parses TLIST channel lines in several tolerated forms", () => {
    expect(parseChannelLine("@TL 3 IQ A")).toEqual({ idx: 3, name: "IQ", unit: "A" });
    expect(parseChannelLine("@TL 0 VBUS")).toEqual({ idx: 0, name: "VBUS", unit: "" });
    expect(parseChannelLine("@TL 5=SPEED:rpm")).toEqual({ idx: 5, name: "SPEED", unit: "rpm" });
    expect(parseChannelLine("@CH idx=7 name=POS unit=rad")).toEqual({ idx: 7, name: "POS", unit: "rad" });
    expect(parseChannelLine("@T 2 ID:A")).toEqual({ idx: 2, name: "ID", unit: "A" });
    expect(parseChannelLine("@OK TLIST 20")).toBeNull();
  });
  it("parses an inline list in @OK TLIST", () => {
    expect(parseChannelListText("0:IQ:A 1:ID:A 2:VBUS:V")).toEqual([{ idx: 0, name: "IQ", unit: "A" }, { idx: 1, name: "ID", unit: "A" }, { idx: 2, name: "VBUS", unit: "V" }]);
    expect(parseChannelListText("20")).toEqual([]);
    expect(parseChannelListText("n=20")).toEqual([]);
    expect(parseChannelListText("IQ,OlBudget").map((c) => c.name)).toEqual(["IQ", "OlBudget"]);
  });
  it("parses TCH replies by name or index", () => {
    const cat = [{ idx: 0, name: "IQ", unit: "A" }, { idx: 4, name: "VBUS", unit: "V" }, { idx: 9, name: "RPM", unit: "rpm" }];
    expect(parseTch(parseReply("@OK TCH n=3 ch=IQ,VBUS,RPM"), cat)).toEqual([{ idx: 0, name: "IQ", unit: "A" }, { idx: 1, name: "VBUS", unit: "V" }, { idx: 2, name: "RPM", unit: "rpm" }]);
    expect(parseTch(parseReply("@OK TCH n=2 ch=9,0"), cat)!.map((d) => d.name)).toEqual(["RPM", "IQ"]);
    expect(parseTch(parseReply("@OK TCH n=3 ch=IQ,VBUS"), cat)).toBeNull(); // count mismatch
    expect(parseTch(parseReply("@ERR TCH unknown"), cat)).toBeNull();
  });
  it("builds TCH commands within the line limit", () => {
    expect(cmdTch([0, 3, 4])).toBe("TCH 0,3,4\n");
    expect(() => cmdTch([])).toThrow();
  });
  it("TRATE", () => {
    expect(parseTrate(parseReply("@OK TRATE hz=200"))).toBe(200);
    expect(parseTrate(parseReply("@OK TRATE 50"))).toBe(50);
    expect(parseTrate(parseReply("@ERR TRATE unknown"))).toBeNaN();
  });
  it("maps roles for legacy and v3 names", () => {
    const r = channelRoles(LEGACY_CHANNELS);
    expect(r).toMatchObject({ idRef: 0, id: 1, iqRef: 2, iq: 3, vd: 6, vq: 7, vbus: 8, omega: 10 });
    const v3 = channelRoles([{ idx: 0, name: "IQ", unit: "A" }, { idx: 1, name: "SPEED", unit: "rpm" }, { idx: 2, name: "POS", unit: "rad" }, { idx: 3, name: "VBUS", unit: "V" }, { idx: 4, name: "TEMP", unit: "C" }]);
    expect(v3).toMatchObject({ iq: 0, rpm: 1, pos: 2, vbus: 3, temp: 4 });
    expect(channelRoles([{ idx: 0, name: "SPEED", unit: "rad/s" }])).toMatchObject({ omega: 0 });
  });
});

describe("fault / zero", () => {
  it("parses @FAULT snapshots", () => {
    const f = parseFault(parseReply("@FAULT code=0x0040 latched=0x0042 names=BusUndervoltage t=1234 vbus=9.80 iq=0.01") as { kv: Record<string, string> }, 5);
    expect(f).toMatchObject({ code: 0x40, latched: 0x42, names: ["BusUndervoltage"], t: 5 });
    expect(f.kv.vbus).toBe("9.80");
    expect(parseFault({ kv: { fault: "3" } }).code).toBe(3);
  });
  it("parses SETZERO replies", () => {
    expect(parseSetZero(parseReply("@OK SETZERO zero=1.2345"))).toBeCloseTo(1.2345);
    expect(parseSetZero(parseReply("@OK SETZERO ZERO_OFFSET=-0.5"))).toBe(-0.5);
    expect(parseSetZero(parseReply("@ERR SETZERO not_idle"))).toBeNaN();
  });
});

describe("units, ramps, waves, profiles", () => {
  it("direct drive: torque = Iq·Kt, no gear factor", () => {
    const d = { kt: 0.05 };
    expect(torqueNm(2, d)).toBeCloseTo(0.1);
    expect(torqueNm(-1, d)).toBeCloseTo(-0.05);
    expect(torqueNm(2, { kt: 0 })).toBeNaN();
    expect(dqPower(1, 0.5, 2, 1)).toBeCloseTo(3.75);
    expect(mechPower(1, 0.05, 60 / (2 * Math.PI) * 10)).toBeCloseTo(0.5);
  });
  it("ramps linearly and finishes", () => {
    const r = new Ramp();
    r.start(0, 100, 200, 1000);
    expect(r.value(1000)).toBe(0);
    expect(r.value(1100)).toBeCloseTo(50);
    expect(r.value(1300)).toBe(100);
    expect(r.active).toBe(false);
    r.start(5, 7, 0, 0);
    expect(r.value(0)).toBe(7);
  });
  it("waveforms", () => {
    expect(waveValue("sine", 0.25, 2, 1, 1)).toBeCloseTo(3);
    expect(waveValue("square", 0.1, 2, 0, 1)).toBe(2);
    expect(waveValue("square", 0.6, 2, 0, 1)).toBe(-2);
    expect(waveValue("triangle", 0.25, 1, 0, 1)).toBeCloseTo(1);
    expect(waveValue("triangle", 0.75, 1, 0, 1)).toBeCloseTo(-1);
    expect(waveValue("triangle", 0.5, 1, 0, 1)).toBeCloseTo(0);
  });
  it("caps waveform parameters", () => {
    expect(capWave(80, 50, 10, 100, 5)).toEqual({ amp: 50, offset: 50, freq: 5, capped: true });
    expect(capWave(10, 0, 1, 100, 5)).toEqual({ amp: 10, offset: 0, freq: 1, capped: false });
    expect(capWave(10, 200, 1, 100, 5).offset).toBe(100);
    expect(capWave(NaN, 0, 0, 100, 5)).toMatchObject({ amp: 0, freq: 0.1 });
  });
  it("profiles round-trip and validate", () => {
    const p = makeProfile({ SPD_KP: 0.3, CAN_ID: 2 }, "DR4310", "3.0.0", { gear: 10 });
    const r = readProfile(JSON.stringify(p));
    expect(r.params).toEqual({ SPD_KP: 0.3, CAN_ID: 2 });
    expect(r.host).toEqual({ gear: 10 });
    expect(() => readProfile("nope")).toThrow(/JSON/);
    expect(() => readProfile(JSON.stringify({ type: "x", params: {} }))).toThrow(/DR4310/);
    expect(() => readProfile(JSON.stringify({ type: "dr4310-profile", params: { "bad key": 1 } }))).toThrow(/非法/);
    expect(() => readProfile(JSON.stringify({ type: "dr4310-profile", params: { A: "1" } }))).toThrow(/数字/);
    expect(readProfile(JSON.stringify({ type: "dr4310-profile", version: 1, params: { IQ_LIM: 1.5, OL_EN: 1, OL_IQ: 2.6, OL_TIME_S: 2 } })).params)
      .toEqual({ IQ_LIM: 1.5, OL_EN: 1, OL_IQ: 2.6, OL_TIME_S: 2 });
    expect(readProfile(JSON.stringify({ type: "dr4310-profile", version: 1, params: { SPD_KP: 0.2 } })).params.OL_IQ).toBeUndefined();
  });
});

// Exact reply lines of Grok Build's DR4310 v3.0.0 firmware (control_app.cpp)
import { cmdTchNames, fwUnit } from "../src/features";
import { parseReply as pr } from "../src/uartcfg-protocol";
describe("real v3.0.0 firmware formats", () => {
  const NAMES = "IdRef,Id,IqRef,Iq,VdUnsat,VqUnsat,VdSat,VqSat,Vbus,Vsat,Omega,DutyA,DutyB,DutyC,CurKp,CurKi,Ia,Ib,Ic,Vd,Vq,Rpm,PosRad,ElecAngle,Power,IqLimit,Fault,Mode";
  it("TLIST one line, names only → catalogue with units", () => {
    const r = pr("@TLIST " + NAMES);
    expect(r.type).toBe("TAG");
    const cat = parseChannelListText((r as { text: string }).text);
    expect(cat.length).toBe(28);
    expect(cat[3]).toEqual({ idx: 3, name: "Iq", unit: "A" });
    expect(cat[21]).toEqual({ idx: 21, name: "Rpm", unit: "rpm" });
    expect(cat[22]!.unit).toBe("rad");
    expect(fwUnit("Omega")).toBe("rad/s");
  });
  it("TCH query '@TCH a,b,…' (16 names) → defs + roles", () => {
    const cat = parseChannelListText(NAMES);
    const defs = parseTch(pr("@TCH " + NAMES.split(",").slice(0, 16).join(",")), cat)!;
    expect(defs.length).toBe(16);
    const roles = channelRoles(defs);
    expect(roles.iq).toBe(3); expect(roles.omega).toBe(10); expect(roles.vbus).toBe(8); expect(roles.vd).toBe(6);
    expect(parseTch(pr("@OK TCH"), cat)).toBeNull();
  });
  it("TCH set: exactly 16 names, selection first, padded", () => {
    const cat = parseChannelListText(NAMES);
    const { line, names } = cmdTchNames([3, 21, 22], cat);
    expect(names.length).toBe(16);
    expect(line.startsWith("TCH Iq,Rpm,PosRad,IdRef,Id,IqRef,VdUnsat,")).toBe(true);
    expect(new Set(names).size).toBe(16);
    expect(line.length).toBeLessThanOrEqual(192);
    expect(() => cmdTchNames([], cat)).toThrow();
  });
  it("TRATE / SETZERO / FAULT", () => {
    expect(parseTrate(pr("@OK TRATE hz=100 period_ms=10"))).toBe(100);
    expect(parseSetZero(pr("@OK SETZERO zero=0.842"))).toBeCloseTo(0.842);
    const f = pr("@FAULT active=0x0000 latched=0x0040 snap=1 t=1234 fault=0x0040 pos=1.2 omega=0 iq=0.1 vbus=5.1 mode=2");
    expect(f.type).toBe("TAG");
    const sn = parseFault(f as { kv: Record<string, string> });
    expect(sn.code).toBe(0); // the snapshot word is history, not a current fault
    expect(sn.latched).toBe(0x40);
    expect(parseFault(pr("@FAULT active=0x0080 latched=0x0080 snap=1 t=9 fault=0x0080 pos=0 omega=0 iq=0 vbus=41 mode=0") as { kv: Record<string, string> }).code).toBe(0x80);
  });
});
