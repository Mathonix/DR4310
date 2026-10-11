import { afterEach, describe, expect, it, vi } from "vitest";
import { SerialLink } from "../src/serial";
import { PcanUsbDevice } from "../src/pcan";
import { loadHost } from "../src/dashboard";
import { readObject } from "../src/storage";
import { createUartCfg } from "../src/uartcfg";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("serial lifecycle and stop barrier", () => {
  it("drops queued motion before STOP, keeps the current write serialized", async () => {
    const first = deferred(), sent: string[] = [];
    const port = { open: async () => {}, close: async () => {}, readable: new ReadableStream(), writable: new WritableStream<Uint8Array>({
      async write(b) { const line = new TextDecoder().decode(b); sent.push(line); if (line === "RUN\n") await first.promise; },
    }) } as unknown as SerialPort;
    const link = new SerialLink();
    await link.openPort(port, 115200);
    const run = link.writeText("RUN\n");
    await Promise.resolve(); await Promise.resolve();
    const motion = link.writeText("IQ 1\n").catch((e) => e.message);
    link.cancelPending();
    const stop = link.writeText("STOP\n");
    first.resolve();
    await run; expect(await motion).toBe("发送已取消"); await stop;
    expect(sent).toEqual(["RUN\n", "STOP\n"]);
    await link.close(); expect(port.readable?.locked).toBe(false);
  });
  it("notifies EOF once and releases the reader", async () => {
    const closed = vi.fn();
    const port = { open: async () => {}, close: async () => {}, readable: new ReadableStream({ start(c) { c.close(); } }) } as unknown as SerialPort;
    const link = new SerialLink(); link.onClose = closed;
    await link.openPort(port, 115200); await Promise.resolve();
    expect(link.connected).toBe(false); expect(closed).toHaveBeenCalledOnce();
    expect(port.readable?.locked).toBe(false); await link.close();
  });
});

describe("CAN cancellation preserves packet encoding", () => {
  it("never sends stale queued or invalid session frames", async () => {
    const first = deferred(), sent: Uint8Array[] = [];
    const dev = { productId: 0xc, vendorId: 0xc72, opened: true,
      async transferOut(_ep: number, bytes: Uint8Array) { sent.push(bytes.slice()); if (sent.length === 1) await first.promise; return { status: "ok" }; },
    } as unknown as USBDevice;
    const pcan = new PcanUsbDevice(dev);
    // Isolate transport queue behavior without opening a physical USB device.
    Object.assign(pcan, { running: true });
    const run = pcan.sendFrame({ id: 0x101, data: [1, 0, 0, 0, 0, 0, 0, 0] });
    await Promise.resolve();
    const stale = pcan.sendFrame({ id: 0x501, data: new Uint8Array(8) }).catch((e) => e.message);
    pcan.cancelPending();
    const stop = pcan.sendFrame({ id: 0x101, data: new Uint8Array(8) });
    const invalid = pcan.sendFrame({ id: 0x401 }, () => false).catch((e) => e.message);
    first.resolve(); await run; await stop;
    expect(await stale).toBe("发送已取消"); expect(await invalid).toBe("发送已取消");
    expect(sent).toHaveLength(2);
    expect(Array.from(sent[1]!.slice(2, 13))).toEqual([8, 0x20, 0x20, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("optional host storage", () => {
  it("rejects corrupt and out-of-range settings", () => {
    vi.stubGlobal("localStorage", { getItem: () => '{"gear":0,"kt":-1,"link":"bad","ramp":{"spd":-1,"mit":70000},"output":"yes"}' });
    const hs = loadHost();
    expect(hs).toMatchObject({ kt: 0, link: "auto", ramp: { spd: 300, mit: 500 } });
    expect(hs).not.toHaveProperty("gear"); expect(hs).not.toHaveProperty("output"); // direct drive: legacy keys dropped
    vi.stubGlobal("localStorage", { getItem: () => "null" });
    expect(readObject("params")).toEqual({}); expect(loadHost().kt).toBe(0);
    vi.stubGlobal("localStorage", { getItem() { throw new Error("blocked"); } });
    expect(loadHost().ramp.pos).toBe(500);
  });
});

describe("UART request lifecycle", () => {
  function fixture() {
    const writes: string[] = [], pending: ReturnType<typeof deferred>[] = [];
    const serial = { connected: true, writeText(line: string) { writes.push(line); const d = deferred(); pending.push(d); return d.promise; } } as unknown as SerialLink;
    const elements = new Map<string, { innerHTML: string; classList: { toggle(): void } }>();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("document", { getElementById(id: string) { if (!elements.has(id)) elements.set(id, { innerHTML: "", classList: { toggle() {} } }); return elements.get(id); } });
    const cfg = createUartCfg({ serial, toast() {}, log() {}, rec() {}, confirmOn: () => false, onFrame() {}, onChannels() {}, onFault() {}, onParams() {}, hostSettings: () => ({}), applyHostSettings() {} });
    const line = (s: string) => cfg.onData(new TextEncoder().encode(s + "\n"));
    return { cfg, writes, pending, line };
  }
  it("does not arm a timeout after a fast reply has already completed a job", async () => {
    vi.useFakeTimers(); const { cfg, pending, line } = fixture();
    const result = cfg.request("PING\n"); line("@PONG up=1");
    expect((await result).ok).toBe(true);
    pending[0]!.resolve(); await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0); expect(cfg.queueLen).toBe(0);
  });
  it("cancels queued motion and ignores a late write completion", async () => {
    vi.useFakeTimers(); const { cfg, writes, pending } = fixture();
    const first = cfg.request("SPD 100\n"), next = cfg.request("POS 3\n");
    cfg.cancelPending("急停");
    expect((await first).ok).toBe(false); expect((await next).ok).toBe(false);
    pending[0]!.resolve(); await Promise.resolve();
    expect(writes).toEqual(["SPD 100\n"]); expect(vi.getTimerCount()).toBe(0);
  });
});
