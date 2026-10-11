import { afterEach, describe, expect, it, vi } from "vitest";
import { createUartCfg } from "../src/uartcfg";
import type { SerialLink } from "../src/serial";

class CfgElement extends EventTarget {
  innerHTML = ""; textContent = ""; value = ""; checked = false; disabled = false;
  classes = new Set<string>();
  classList = { toggle: (name: string, on: boolean) => { if (on) this.classes.add(name); else this.classes.delete(name); }, contains: (name: string) => this.classes.has(name) };
  toggleAttribute() {}
}
function firmware(kind: "v2" | "v3" | "legacy", bootAe = false, bootMode = 2, telemetry?: { value: number; info: boolean }, extras?: { iq?: boolean; ol?: boolean; olFirst?: boolean; iqLim?: number; olIq?: number }) {
  vi.useFakeTimers();
  const elements = new Map<string, CfgElement>();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.stubGlobal("document", { getElementById(id: string) {
    if (!elements.has(id)) elements.set(id, new CfgElement());
    return elements.get(id);
  }, querySelectorAll: () => [] });
  const writes: string[] = [];
  const ram = { IQ_LIM: extras?.iqLim ?? 2.5, OL_IQ: extras?.olIq ?? 2.5, OL_EN: 0, OL_TIME_S: 2 };
  const serial = { connected: true, writeText: vi.fn(async (line: string) => {
    const c = line.trim(); writes.push(c);
    if (kind === "legacy") return;
    const reply = (s: string) => cfg.onData(new TextEncoder().encode(s + "\n"));
    if (c === "PING") reply("@PONG up=1");
    if (c === "INFO") reply(`@INFO fw=DR4310 ver=${kind === "v3" ? "3.0.0" : "2.0.0"} id=2 cfg_id=2 mode=0 vbus=12.1 fault=0 latched=0${telemetry?.info ? ` telem=${telemetry.value}` : ""}${extras?.ol ? " ol=ready budget=2" : ""}`);
    if (c === "HELP") reply("@OK HELP STOP RUN SPD GET SET" + (kind === "v3" ? " SETZERO TLIST TCH TRATE FAULT" : ""));
    const replyOl = () => { reply(`@P OL_EN=${ram.OL_EN} min=0 max=1`); reply(`@P OL_IQ=${ram.OL_IQ} min=0 max=2.8`); reply(`@P OL_TIME_S=${ram.OL_TIME_S} min=0 max=10`); };
    if (c === "GET OL_IQ" && extras?.ol) { reply(`@P OL_IQ=${ram.OL_IQ} min=0 max=2.8`); reply("@OK GET 1"); }
    if (c === "GET") {
      if (telemetry) reply("@P TELEM=" + telemetry.value + " min=0 max=1");
      reply("@P SPD_KP=0.25 min=0 max=10");
      if (bootAe) { reply("@P BOOT_MODE=" + bootMode + " min=0 max=3 reboot=1"); reply("@P BOOT_TARGET=60 min=-500 max=500 reboot=1"); reply("@P BOOT_AE=0 min=0 max=1 reboot=1"); }
      if (extras?.ol && extras.olFirst) replyOl();
      if (extras?.iq || extras?.ol) reply(`@P IQ_LIM=${ram.IQ_LIM} min=0 max=2.5`);
      if (extras?.ol && !extras.olFirst) replyOl();
      reply("@OK GET " + (bootAe ? 4 : 1));
    }
    if (c.startsWith("SET TELEM") && telemetry) { telemetry.value = Number(c.split(" ")[2]); reply("@OK SET TELEM=" + telemetry.value); }
    if (c.startsWith("SET CAN_ID")) reply("@OK SET CAN_ID=" + c.split(" ")[2] + " reboot=1");
    if (c === "REBOOT") reply("@OK REBOOT");
    if (c.startsWith("SET SPD_KP")) reply("@OK SET SPD_KP=" + c.split(" ")[2]);
    if (c.startsWith("SET BOOT_AE")) reply("@OK SET BOOT_AE=" + c.split(" ")[2] + " reboot=1");
    if (extras?.ol && /^SET (?:OL_EN|OL_IQ|OL_TIME_S|IQ_LIM) /.test(c)) {
      const k = c.split(" ")[1] ?? "", vs = c.split(" ")[2] ?? "", v = Number(vs);
      if (k === "IQ_LIM") {
        if (!(v >= 0 && v <= 2.5)) reply("@ERR SET range IQ_LIM 0..2.5");
        else { ram.IQ_LIM = v; if (ram.OL_IQ < v) ram.OL_IQ = v; reply(`@OK SET IQ_LIM=${vs}`); }
      } else if (k === "OL_IQ") {
        if (!(v >= ram.IQ_LIM && v <= 2.8)) reply(`@ERR SET range OL_IQ ${ram.IQ_LIM}..2.8`);
        else { ram.OL_IQ = v; reply(`@OK SET OL_IQ=${vs}`); }
      } else if (k === "OL_EN") { ram.OL_EN = v ? 1 : 0; reply(`@OK SET OL_EN=${ram.OL_EN}`); }
      else reply(`@OK SET ${k}=${vs}`);
    }
    if (c === "SAVE") reply("@OK SAVE seq=1");
    if (c === "TLIST") { reply("@TL 0 IQ A"); reply("@TL 1 POS rad"); reply("@OK TLIST 2"); }
    if (c === "TCH") reply("@OK TCH n=2 ch=IQ,POS");
    if (c === "TRATE") reply("@OK TRATE hz=100");
    if (c === "FAULT") { reply("@FAULT code=0 latched=0"); reply("@OK FAULT"); }
  }) } as unknown as SerialLink;
  const cfg = createUartCfg({ serial, toast() {}, log() {}, rec() {}, confirmOn: () => false, onFrame() {}, onChannels: vi.fn(), onFault: vi.fn(), onParams() {}, hostSettings: () => ({}), applyHostSettings() {} });
  cfg.prepare();
  return { cfg, writes, serial, get: (id: string) => elements.get(id)! };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("firmware probing remains compatible", () => {
  it("v2 probes only PING, INFO, HELP, GET and uses fixed telemetry", async () => {
    const { cfg, writes } = firmware("v2"); const opened = cfg.onOpened(); await vi.advanceTimersByTimeAsync(160); await opened;
    expect(writes).toEqual(["PING", "INFO", "HELP", "GET"]); expect(cfg.fw).toBe("v2");
    expect(cfg.channels).toHaveLength(16); expect(cfg.features.tlist).toBe(false); expect(cfg.param("SPD_KP")).toBe(.25);
  });
  it("v3 detects extensions and variable JustFloat channels without motion", async () => {
    const { cfg, writes } = firmware("v3"); const opened = cfg.onOpened(); await vi.advanceTimersByTimeAsync(160); await opened;
    expect(writes).toEqual(["PING", "INFO", "HELP", "GET", "TLIST", "TCH", "TRATE", "FAULT"]);
    expect(cfg.features).toMatchObject({ major: 3, tlist: true, tch: true, fault: true, setzero: true });
    expect(cfg.parser.channels).toBe(2); expect(cfg.channels.map(c => c.name)).toEqual(["IQ", "POS"]);
  });
  it("legacy receives exactly three INFO probes and no extension commands", async () => {
    const { cfg, writes } = firmware("legacy"); const opened = cfg.onOpened(); await vi.advanceTimersByTimeAsync(2800); await opened;
    expect(cfg.fw).toBe("legacy"); expect(writes).toEqual(["PING", "INFO", "INFO", "INFO"]); expect(cfg.features.tch).toBe(false);
  });
  it("disconnect during probing cannot restore the old session", async () => {
    const { cfg, serial } = firmware("legacy"); const opened = cfg.onOpened(); await vi.advanceTimersByTimeAsync(180);
    Object.assign(serial, { connected: false }); cfg.onClosed(); await vi.advanceTimersByTimeAsync(3000); await opened;
    expect(cfg.fw).toBe("none"); expect(cfg.info).toBe(null); expect(cfg.queueLen).toBe(0);
  });
});

describe("上电行为 group (persistent BOOT_AE)", () => {
  it("toggle is disabled with a tooltip when GET lacks BOOT_AE", async () => {
    const f = firmware("v2"); f.cfg.init(async () => {});
    const opened = f.cfg.onOpened(); await vi.advanceTimersByTimeAsync(160); await opened; f.cfg.refreshUi();
    expect(f.get("bootAe").disabled).toBe(true); expect(f.get("bootMode").disabled).toBe(true);
    expect(f.get("bootSec").classList.contains("off")).toBe(true); expect(f.get("bootNote").textContent).toBe("固件不支持");
  });
  it("legacy / no serial: disabled", () => {
    const f = firmware("legacy", true); f.cfg.init(async () => {}); f.cfg.refreshUi();
    expect(f.get("bootAe").disabled).toBe(true); expect(f.get("bootNote").textContent).toMatch(/不支持/);
  });
  it("shows BOOT_MODE / BOOT_TARGET / BOOT_AE together; enabling confirms once (mode + target) and 同步 sends SET → SAVE, never runtime AE", async () => {
    const f = firmware("v2", true); f.cfg.init(async () => {});
    const opened = f.cfg.onOpened(); await vi.advanceTimersByTimeAsync(160); await opened; f.cfg.refreshUi();
    expect(f.get("bootAe").disabled).toBe(false); expect(f.get("bootMode").value).toBe("2"); expect(f.get("bootTarget").value).toBe("60");
    expect(f.get("bootNote").textContent).toBe("");
    const ask = vi.fn((_m?: string) => true); vi.stubGlobal("confirm", ask);
    f.get("bootAe").checked = true; f.get("bootAe").dispatchEvent(new Event("change"));
    expect(ask).toHaveBeenCalledOnce(); expect(String(ask.mock.calls[0]![0])).toMatch(/速度.*60 rpm/s);
    expect(f.get("pv_BOOT_AE").value).toBe("1"); expect(f.get("pr_BOOT_AE").classList.contains("mod")).toBe(true);
    expect(f.writes).not.toContain("SET BOOT_AE 1");
    f.get("btnSync").dispatchEvent(new Event("click")); await vi.advanceTimersByTimeAsync(1);
    expect(ask).toHaveBeenCalledOnce();
    const start = f.writes.indexOf("SET BOOT_AE 1"); expect(start).toBeGreaterThan(-1); expect(f.writes[start + 1]).toBe("SAVE");
    expect(f.writes.some(w => /^AE /.test(w))).toBe(false); expect(f.cfg.unsaved).toBe(false);
  });
  it("BOOT_MODE=0 (idle): the confirmation says it has no effect", async () => {
    const f = firmware("v2", true, 0); f.cfg.init(async () => {});
    const opened = f.cfg.onOpened(); await vi.advanceTimersByTimeAsync(160); await opened; f.cfg.refreshUi();
    const ask = vi.fn((_m?: string) => true); vi.stubGlobal("confirm", ask);
    f.get("bootAe").checked = true; f.get("bootAe").dispatchEvent(new Event("change"));
    expect(String(ask.mock.calls[0]![0])).toMatch(/空闲.*无效果/s);
    expect(f.get("bootNote").textContent).toMatch(/空闲.*无效果/);
  });
  it("cancelling the confirmation reverts the toggle and sends neither SET nor SAVE", async () => {
    const f = firmware("v2", true); f.cfg.init(async () => {});
    const opened = f.cfg.onOpened(); await vi.advanceTimersByTimeAsync(160); await opened;
    vi.stubGlobal("confirm", () => false);
    f.get("bootAe").checked = true; f.get("bootAe").dispatchEvent(new Event("change"));
    expect(f.get("bootAe").checked).toBe(false);
    f.get("btnSync").dispatchEvent(new Event("click")); await vi.advanceTimersByTimeAsync(1);
    expect(f.writes.some(w => /^(SET|SAVE|AE)/.test(w))).toBe(false);
  });
});


describe("电流限制", () => {
  it("hides overlimit controls on a 2.0.0 parameter set and keeps 最大电流", async () => {
    const f = firmware("v2", false, 2, undefined, { iq: true }); f.cfg.init(async () => {});
    const opened = f.cfg.onOpened(); await vi.advanceTimersByTimeAsync(160); await opened; f.cfg.refreshUi();
    expect(f.get("olFields").classList.contains("hidden")).toBe(true);
    expect(f.get("olNote").textContent).toBe("需 3.1.0 固件");
    expect(f.get("olStatus").classList.contains("hidden")).toBe(true);
    expect(f.get("iqMax").disabled).toBe(false);
    expect(f.get("iqMax").value).toBe("2.5");
  });
  it("disables OL inputs while the switch is off, blocks OL_IQ < IQ_LIM, then writes a legal value", async () => {
    const f = firmware("v2", false, 2, undefined, { ol: true }); f.cfg.init(async () => {});
    const opened = f.cfg.onOpened(); await vi.advanceTimersByTimeAsync(160); await opened; f.cfg.refreshUi();
    expect(f.cfg.info?.ol).toEqual({ state: "ready", budget: 2 });
    expect(f.get("olStatus").textContent).toBe("超限：就绪 2.0 s");
    expect(f.get("olFields").classList.contains("hidden")).toBe(false);
    expect(f.get("olCurrent").disabled).toBe(true);
    expect(f.get("olTime").disabled).toBe(true);
    f.get("olEnable").checked = true; f.get("olEnable").dispatchEvent(new Event("change"));
    expect(f.get("pv_OL_EN").value).toBe("1");
    expect(f.get("olCurrent").disabled).toBe(false);
    expect(f.get("olTime").disabled).toBe(false);
    f.get("olEnable").checked = false; f.get("olEnable").dispatchEvent(new Event("change"));
    expect(f.get("olCurrent").disabled).toBe(true);
    f.get("olEnable").checked = true; f.get("olEnable").dispatchEvent(new Event("change"));
    const before = f.writes.length;
    f.get("pv_OL_IQ").value = "1"; f.get("pv_OL_IQ").dispatchEvent(new Event("input")); f.cfg.refreshUi();
    expect(f.get("olHint").textContent).toMatch(/超限电流须 ≥ 最大电流/);
    f.get("btnSync").dispatchEvent(new Event("click")); await vi.advanceTimersByTimeAsync(1);
    expect(f.writes.slice(before)).toEqual(["SET OL_EN 1"]);
    f.get("pv_OL_IQ").value = "2.6"; f.get("pv_OL_IQ").dispatchEvent(new Event("input")); f.cfg.refreshUi();
    expect(f.get("olHint").textContent).toBe("");
    f.get("btnSync").dispatchEvent(new Event("click")); await vi.advanceTimersByTimeAsync(1);
    expect(f.writes.slice(before).filter((c) => c !== "INFO")).toEqual(["SET OL_EN 1", "SET OL_IQ 2.6", "SAVE"]);
  });
  it("writes IQ_LIM before OL_IQ when the firmware listed OL_IQ first", async () => {
    const f = firmware("v2", false, 2, undefined, { ol: true, olFirst: true }); f.cfg.init(async () => {});
    const opened = f.cfg.onOpened(); await vi.advanceTimersByTimeAsync(160); await opened; f.cfg.refreshUi();
    f.get("pv_IQ_LIM").value = "1.5"; f.get("pv_IQ_LIM").dispatchEvent(new Event("input"));
    f.get("pv_OL_IQ").value = "2"; f.get("pv_OL_IQ").dispatchEvent(new Event("input"));
    const before = f.writes.length;
    f.get("btnSync").dispatchEvent(new Event("click")); await vi.advanceTimersByTimeAsync(1);
    expect(f.writes.slice(before).filter((c) => c !== "INFO")).toEqual(["SET IQ_LIM 1.5", "SET OL_IQ 2", "SAVE"]);
  });
  it("re-reads OL_IQ after raising IQ_LIM so the firmware auto-raise is shown", async () => {
    const f = firmware("v2", false, 2, undefined, { ol: true, iqLim: 1, olIq: 1.2 }); f.cfg.init(async () => {});
    const opened = f.cfg.onOpened(); await vi.advanceTimersByTimeAsync(160); await opened; f.cfg.refreshUi();
    expect(f.get("olCurrent").value).toBe("1.2");
    f.get("pv_IQ_LIM").value = "2"; f.get("pv_IQ_LIM").dispatchEvent(new Event("input")); f.cfg.refreshUi();
    expect(f.get("olHint").textContent).toBe("");
    const before = f.writes.length;
    f.get("btnSync").dispatchEvent(new Event("click")); await vi.advanceTimersByTimeAsync(1);
    expect(f.writes.slice(before).filter((c) => c !== "INFO")).toEqual(["SET IQ_LIM 2", "GET OL_IQ", "SAVE"]);
    expect(f.cfg.param("OL_IQ")).toBe(2);
    expect(f.get("pv_OL_IQ").value).toBe("2");
    expect(f.get("olCurrent").value).toBe("2");
  });
});

describe("real UART parameter flows pause binary telemetry", () => {
  it("GET pauses on INFO telem=1 and renders the restored TELEM rather than the temporary zero", async () => {
    const telemetry = { value: 1, info: true };
    const f = firmware("v2", true, 2, telemetry); f.cfg.init(async () => {});
    const opened = f.cfg.onOpened(); await vi.advanceTimersByTimeAsync(160); await opened;
    expect(f.writes).toEqual(["PING", "INFO", "HELP", "SET TELEM 0", "GET", "SET TELEM 1"]);
    expect(telemetry.value).toBe(1); expect(f.cfg.param("TELEM")).toBe(1);
    expect(f.get("pv_TELEM").value).toBe("1"); expect(f.get("pd_TELEM").textContent).toBe("1");
  });
  it("sync nests BOOT_AE and gain writes under one pause and restores before SAVE", async () => {
    const telemetry = { value: 1, info: true };
    const f = firmware("v2", true, 2, telemetry); f.cfg.init(async () => {});
    const opened = f.cfg.onOpened(); await vi.advanceTimersByTimeAsync(160); await opened;
    vi.stubGlobal("confirm", () => true);
    f.get("bootAe").checked = true; f.get("bootAe").dispatchEvent(new Event("change"));
    f.get("pv_SPD_KP").value = "0.3"; f.get("pv_SPD_KP").dispatchEvent(new Event("input"));
    const before = f.writes.length;
    f.get("btnSync").dispatchEvent(new Event("click")); await vi.advanceTimersByTimeAsync(1);
    expect(f.writes.slice(before).filter(c => c !== "INFO")).toEqual(["SET TELEM 0", "SET SPD_KP 0.3", "SET BOOT_AE 1", "SET TELEM 1", "SAVE"]);
    expect(f.cfg.unsaved).toBe(false); expect(telemetry.value).toBe(1);
  });
  it("falls back to the parameter table when INFO does not report TELEM", async () => {
    const telemetry = { value: 1, info: false };
    const f = firmware("v2", false, 2, telemetry); f.cfg.init(async () => {});
    const opened = f.cfg.onOpened(); await vi.advanceTimersByTimeAsync(160); await opened;
    const before = f.writes.length;
    f.get("btnGetAll").dispatchEvent(new Event("click")); await vi.advanceTimersByTimeAsync(1);
    expect(f.writes.slice(before)).toEqual(["SET TELEM 0", "GET", "SET TELEM 1"]);
    expect(f.cfg.param("TELEM")).toBe(1); expect(telemetry.value).toBe(1);
  });
  it("RAM-only writes restore without SAVE; originally TELEM=0 does not toggle the stream", async () => {
    for (const value of [1, 0]) {
      const telemetry = { value, info: true };
      const f = firmware("v2", false, 2, telemetry); f.cfg.init(async () => {});
      const opened = f.cfg.onOpened(); await vi.advanceTimersByTimeAsync(160); await opened;
      f.get("pv_SPD_KP").value = "0.3"; f.get("pv_SPD_KP").dispatchEvent(new Event("input"));
      const before = f.writes.length;
      f.get("btnWriteMod").dispatchEvent(new Event("click")); await vi.advanceTimersByTimeAsync(1);
      expect(f.writes.slice(before)).toEqual(value ? ["SET TELEM 0", "SET SPD_KP 0.3", "SET TELEM 1"] : ["SET SPD_KP 0.3"]);
      expect(f.cfg.unsaved).toBe(true); expect(telemetry.value).toBe(value);
    }
  });
  it("CAN ID restores telemetry before flash SAVE and REBOOT", async () => {
    const telemetry = { value: 1, info: true };
    const f = firmware("v2", false, 2, telemetry); f.cfg.init(async () => {});
    const opened = f.cfg.onOpened(); await vi.advanceTimersByTimeAsync(160); await opened;
    f.get("newCanId").value = "3";
    const before = f.writes.length;
    f.get("btnApplyId").dispatchEvent(new Event("click")); await vi.advanceTimersByTimeAsync(60);
    expect(f.writes.slice(before).filter(c => c !== "INFO")).toEqual(["SET TELEM 0", "SET CAN_ID 3", "SET TELEM 1", "SAVE", "REBOOT"]);
    expect(telemetry.value).toBe(1);
  });
  it("GET typed through run uses the same pause/restore guard", async () => {
    const telemetry = { value: 1, info: true };
    const f = firmware("v2", false, 2, telemetry);
    const opened = f.cfg.onOpened(); await vi.advanceTimersByTimeAsync(160); await opened;
    const before = f.writes.length;
    expect((await f.cfg.run("GET\n")).ok).toBe(true);
    expect(f.writes.slice(before)).toEqual(["SET TELEM 0", "GET", "SET TELEM 1"]);
  });

  it("manual SET and SAVE commands also guard telemetry", async () => {
    const telemetry = { value: 1, info: true };
    const f = firmware("v2", false, 2, telemetry);
    const opened = f.cfg.onOpened(); await vi.advanceTimersByTimeAsync(160); await opened;
    const before = f.writes.length;
    expect((await f.cfg.run("SET SPD_KP 0.3\n")).ok).toBe(true);
    expect((await f.cfg.run("SAVE\n")).ok).toBe(true);
    expect(f.writes.slice(before)).toEqual(["SET TELEM 0", "SET SPD_KP 0.3", "SET TELEM 1", "SET TELEM 0", "SET TELEM 1", "SAVE"]);
    expect(telemetry.value).toBe(1);
  });
  it("an intentional TELEM enable is written after the other modified parameters", async () => {
    const telemetry = { value: 0, info: true };
    const f = firmware("v2", false, 2, telemetry); f.cfg.init(async () => {});
    const opened = f.cfg.onOpened(); await vi.advanceTimersByTimeAsync(160); await opened;
    for (const [key, value] of [["TELEM", "1"], ["SPD_KP", "0.3"]]) {
      f.get("pv_" + key).value = value; f.get("pv_" + key).dispatchEvent(new Event("input"));
    }
    const before = f.writes.length;
    f.get("btnSync").dispatchEvent(new Event("click")); await vi.advanceTimersByTimeAsync(1);
    expect(f.writes.slice(before).filter(c => c !== "INFO")).toEqual(["SET SPD_KP 0.3", "SET TELEM 1", "SAVE"]);
    expect(telemetry.value).toBe(1); expect(f.cfg.param("TELEM")).toBe(1);
  });

});
