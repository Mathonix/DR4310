import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboard, type DashHost, type Meas } from "../src/dashboard";
import type { StripChart } from "../src/chart";
import { page } from "../src/page";

/** Minimal event/attribute DOM for controller tests; no browser or device access. */
class El extends EventTarget {
  value = "0"; textContent = ""; innerHTML = ""; checked = false; disabled = false; title = "";
  style: Record<string, string> = {}; dataset: Record<string, string> = {};
  attrs = new Map<string, string>(); children: El[] = [];
  classes = new Set<string>();
  classList = { add: (...c: string[]) => c.forEach(x => this.classes.add(x)), contains: (c: string) => this.classes.has(c),
    toggle: (c: string, on?: boolean) => { const yes = on ?? !this.classes.has(c); if (yes) this.classes.add(c); else this.classes.delete(c); return yes; } };
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  appendChild(c: El) { this.children.push(c); return c; }
  prepend(c: El) { this.children.unshift(c); }
  querySelector(_s: string) { return new El(); }
  closest(_s: string) { return this; }
  click() { this.dispatchEvent(new Event("click")); }
  getContext() { return {}; }
}

function fixture() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
  const ids = new Map<string, El>();
  for (const m of page().matchAll(/id="([^"]+)"/g)) ids.set(m[1]!, new El());
  const get = (id: string) => { const el = ids.get(id); if (!el) throw new Error("Missing markup binding: " + id); return el; };
  const buttons = ["spd", "cur", "pos", "mit"].map(m => { const e = new El(); e.dataset.dmode = m; return e; });
  vi.stubGlobal("document", { getElementById: get, activeElement: null, createElement: () => new El(), createElementNS: () => new El(), querySelectorAll: () => buttons });
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
  vi.stubGlobal("confirm", () => true);
  get("dMitKp").value = "5"; get("dMitKd").value = "0.1"; get("wKind").value = "sine";
  const measured: Meas = { fresh: true, mode: 2, faults: 0, rpm: 0, pos: 1.25, iq: 0, vbus: 12, power: 0, powerSrc: "", src: "fake" };
  const charts: Record<string, StripChart> = {};
  const host: DashHost = { route: () => "can", sendCanTarget: vi.fn(async () => true), serialLine: vi.fn(async () => true), serialRaw: vi.fn(async () => true),
    stopAll: vi.fn(async () => {}), stopOthers: vi.fn(), meas: () => measured, fwRamp: () => 0, fwKt: () => null, vbusMax: () => null,
    canSetZero: () => false, setZero: async () => {}, clearFaults: async () => {}, toast: vi.fn(), confirmOn: () => true, registerChart: (id, chart) => { charts[id] = chart; } };
  const dash = createDashboard(host); dash.init();
  const mode = (m: string) => { const ev = new Event("click"); Object.defineProperty(ev, "target", { value: buttons.find(b => b.dataset.dmode === m) }); get("dModes").dispatchEvent(ev); };
  const change = (id: string, v: number) => { get(id).value = String(v); get(id).dispatchEvent(new Event("change")); };
  return { get, host, measured, charts, dash, mode, change };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("dashboard safety and interaction", () => {
  it("commits typed target at start and keeps the sent target in the response chart", async () => {
    const { get, host, charts } = fixture(); get("dTarget").value = "8"; get("dStart").click();
    await vi.advanceTimersByTimeAsync(11000);
    expect(host.sendCanTarget).toHaveBeenCalledWith("spd", 8, expect.any(Object), true, expect.any(Function));
    expect(get("dStart").textContent).toBe("停止");
    expect(charts.dChart!.series[0]!.count).toBeGreaterThan(100);
  });
  it("a stopped pending start cannot announce success or revive the session", async () => {
    const { get, host, dash } = fixture();
    let resolve!: (ok: boolean) => void;
    vi.mocked(host.sendCanTarget).mockReturnValueOnce(new Promise(r => { resolve = r; }));
    get("dStart").click(); expect(get("dStart").textContent).toBe("停止");
    const valid = vi.mocked(host.sendCanTarget).mock.calls[0]![4];
    await dash.halt("急停", false); resolve(true); await vi.advanceTimersByTimeAsync(100);
    expect(valid()).toBe(false); expect(dash.running).toBe(false); expect(get("dStart").textContent).toBe("启动");
    expect(vi.mocked(host.toast).mock.calls.some(([s]) => s.startsWith("已启动"))).toBe(false);
  });
  it("aligns position without clamping it to the previous dial range", async () => {
    const { host, measured, mode, get } = fixture(); measured.pos = 20; mode("pos"); get("dStart").click(); await vi.advanceTimersByTimeAsync(100);
    expect(host.sendCanTarget).toHaveBeenCalledWith("pos", 20, expect.any(Object), true, expect.any(Function));
    expect(Number(get("dTarget").value)).toBe(20); // direct drive: shown = motor position
  });
  it("preserves a position destination typed before start instead of replacing it with feedback", async () => {
    const { host, mode, get } = fixture(); mode("pos"); get("dTarget").value = "3";
    get("dStart").click(); await vi.advanceTimersByTimeAsync(100);
    expect(host.sendCanTarget).toHaveBeenCalledWith("pos", 3, expect.any(Object), true, expect.any(Function));
    expect(Number(get("dTarget").value)).toBe(3);
  });
  it("an explicitly entered zero position is a destination, not an untouched hold target", async () => {
    const { host, mode, get } = fixture(); mode("pos"); get("dTarget").value = "0";
    get("dTarget").dispatchEvent(new Event("input")); get("dStart").click(); await vi.advanceTimersByTimeAsync(100);
    expect(host.sendCanTarget).toHaveBeenCalledWith("pos", 0, expect.any(Object), true, expect.any(Function));
  });
  it("waits for serial position feedback before sending, and cancelling preparation prevents motion", async () => {
    const { host, mode, get, dash } = fixture(); host.route = () => "serial";
    let resolve!: (ok: boolean) => void;
    const prepare = vi.fn((_valid: () => boolean) => new Promise<boolean>(r => { resolve = r; }));
    host.preparePosition = prepare;
    mode("pos"); get("dStart").click();
    expect(host.serialLine).not.toHaveBeenCalled(); expect(dash.running).toBe(true);
    const valid = prepare.mock.calls[0]![0];
    get("dStart").click(); resolve(true); await vi.advanceTimersByTimeAsync(100);
    expect(valid()).toBe(false); expect(dash.running).toBe(false); expect(host.serialLine).not.toHaveBeenCalled();
  });
  it("failed serial position preparation leaves the dashboard stopped without a motion command", async () => {
    const { host, mode, get, dash } = fixture(); host.route = () => "serial";
    host.preparePosition = vi.fn(async () => false);
    mode("pos"); get("dStart").click(); await vi.advanceTimersByTimeAsync(100);
    expect(dash.running).toBe(false); expect(get("dStart").textContent).toBe("启动");
    expect(host.serialLine).not.toHaveBeenCalled();
  });
  it("refuses out-of-range MIT position and stops on missing feedback", async () => {
    const { host, measured, mode, get, dash } = fixture(); measured.pos = 60; mode("mit"); get("dStart").click();
    expect(host.sendCanTarget).not.toHaveBeenCalled(); expect(dash.running).toBe(false);
    mode("spd"); get("dStart").click(); await vi.advanceTimersByTimeAsync(50); measured.fresh = false;
    await vi.advanceTimersByTimeAsync(1600); expect(dash.running).toBe(false); expect(host.stopAll).toHaveBeenCalledWith("反馈中断，已停止");
  });
  it("sends MIT parameter changes even when target position is unchanged", async () => {
    const { host, mode, get, change, measured } = fixture(); measured.mode = 4; mode("mit"); get("dStart").click(); await vi.advanceTimersByTimeAsync(100);
    const n = vi.mocked(host.sendCanTarget).mock.calls.length; change("dMitKp", 6); await vi.advanceTimersByTimeAsync(100);
    expect(vi.mocked(host.sendCanTarget).mock.calls.length).toBeGreaterThan(n);
    expect(vi.mocked(host.sendCanTarget).mock.calls.at(-1)![2].kp).toBe(6);
  });
  it("caps waveform on every send and stops it when range or display changes", async () => {
    const { host, get, change, dash } = fixture(); get("dStart").click(); await vi.advanceTimersByTimeAsync(100);
    change("wAmp", 999); change("wOff", 0); change("wFreq", 99); get("wStart").click(); await vi.advanceTimersByTimeAsync(200);
    expect(Number(get("wAmp").value)).toBe(200); expect(Number(get("wFreq").value)).toBe(5);
    expect(vi.mocked(host.sendCanTarget).mock.calls.every(([,v]) => Math.abs(v) <= 200)).toBe(true);
    change("dRangeSel", 50); expect(dash.waveOn).toBe(false);
    change("wAmp", 2); get("wStart").click(); expect(dash.waveOn).toBe(true);
    get("hKt").value = "0.05"; get("hKt").dispatchEvent(new Event("change")); expect(dash.waveOn).toBe(false); // display (Kt) change
  });
  it("switching mode stops the previous run and clears mixed-unit chart history", async () => {
    const { host, get, charts, dash, mode } = fixture(); get("dStart").click(); await vi.advanceTimersByTimeAsync(150); expect(charts.dChart!.series[0]!.count).toBeGreaterThan(0);
    mode("cur"); expect(dash.running).toBe(false); expect(host.stopAll).toHaveBeenCalled(); expect(charts.dChart!.series[0]!.count).toBe(0);
  });
  it("shows key current in A even when the torque target uses Kt", () => {
    const { host, measured, dash, get, mode } = fixture(); host.fwKt = () => 0.06;
    measured.iq = 0.2; mode("cur"); dash.renderHostSettings(); dash.refresh();
    expect(get("dTgtUnit").textContent).toContain("N·m");
    expect(get("mTrqV").textContent).toBe("0.200"); expect(get("mTrqU").textContent).toBe("A");
  });
});
