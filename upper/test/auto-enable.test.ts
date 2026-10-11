import { describe, expect, it, vi } from "vitest";
import { createAeTracker, stopCanWithAe, stopSerialWithAe, type AeHost, type AeInfo, type AeTarget } from "../src/auto-enable";
import { PARAM_META } from "../src/uartcfg-protocol";

function fixture() {
  let target: AeTarget | null = { route: "can", id: 3 }, info: AeInfo | null = null, now = 100;
  const host: AeHost = { target: () => target, info: () => info, now: () => now, changed: vi.fn() };
  const ae = createAeTracker(host);
  return { ae, host, target: (v: AeTarget | null) => { target = v; }, info: (v: AeInfo | null) => { info = v; }, time: (v: number) => { now = v; } };
}

describe("runtime auto-enable is read-only (no UI path turns it on)", () => {
  it("the tracker has no way to send AE on", () => {
    const { ae } = fixture();
    expect(Object.keys(ae).sort()).toEqual(["forget", "resetOff", "stopped", "view"]);
  });
  it("no source file sends CAN 08 01 or serial AE 1", async () => {
    const fsMod = "node:fs";
    const urlMod = "node:url";
    const pathMod = "node:path";
    const fs = await import(/* @vite-ignore */ fsMod) as { readdirSync(p: string): string[]; readFileSync(p: string, e: string): string };
    const { fileURLToPath } = await import(/* @vite-ignore */ urlMod) as { fileURLToPath(u: URL): string };
    const { join } = await import(/* @vite-ignore */ pathMod) as { join(...p: string[]): string };
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    const files = fs.readdirSync(dir).filter((n: string) => n.endsWith(".ts") && n !== "client-bundle.ts");
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const src = fs.readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/nativeAutoEnable\(\s*(true|1|on)\b/);
      expect(src, f).not.toMatch(/cmd\(\s*"AE"\s*,\s*(1|on|true)\b/);
      expect(src, f).not.toMatch(/"AE 1/);
    }
  });
  it("mirrors INFO ae= (e.g. BOOT_AE) and never consumes another CAN node's state", () => {
    const f = fixture();
    expect(f.ae.view()).toMatchObject({ on: false, known: false, source: "unknown", available: true });
    f.info({ id: 2, ae: 1, t: 101 }); expect(f.ae.view().on).toBe(false);
    f.info({ id: 3, ae: 1, t: 101 }); expect(f.ae.view()).toMatchObject({ on: true, source: "reported" });
    f.target({ route: "serial", id: 1 });
    f.info({ id: 2, ae: 1, t: 102 }); expect(f.ae.view()).toMatchObject({ on: true, source: "reported" });
    f.info({ id: 2, ae: NaN, t: 103 }); expect(f.ae.view().known).toBe(false);
    f.target(null); expect(f.ae.view().available).toBe(false);
  });
  it("a stop overrides INFO captured before it; later INFO wins again", () => {
    const f = fixture(); f.info({ id: 3, ae: 1, t: 90 });
    expect(f.ae.view().on).toBe(true);
    f.ae.stopped({ route: "can", id: 3 }, true);
    expect(f.ae.view()).toMatchObject({ on: false, known: true, source: "stopped" });
    f.info({ id: 3, ae: 1, t: 101 }); expect(f.ae.view().on).toBe(true);
    f.time(200); f.ae.resetOff(3); expect(f.ae.view()).toMatchObject({ on: false, known: false });
    f.ae.forget("can"); f.info(null); expect(f.ae.view().known).toBe(false);
  });
});

describe("all stop paths use AE off before disabling", () => {
  it.each([false, true])("CAN emergency=%s preserves byte order and repeated E-stop", async emergency => {
    const frames: { id: number; bytes: number[] }[] = [];
    const result = await stopCanWithAe(7, emergency, async (id, data) => { frames.push({ id, bytes: [...data] }); return true; });
    const disable = [emergency ? 3 : 0, 0, 0, 0, 0, 0, 0, 0];
    expect(frames).toEqual([{ id: 0x107, bytes: [8, 0, 0, 0, 0, 0, 0, 0] }, { id: 0x107, bytes: disable }, ...(emergency ? [{ id: 0x107, bytes: disable }] : [])]);
    expect(result).toEqual({ ae: true, stop: true });
  });
  it("UART sends AE 0 before STOP", async () => {
    const writes: string[] = [];
    expect(await stopSerialWithAe(async line => { writes.push(line); return true; })).toEqual({ ae: true, stop: true });
    expect(writes).toEqual(["AE 0\n", "STOP\n"]);
  });
  it("attempts STOP / both E-stops even when AE off fails", async () => {
    const can = vi.fn(async (_id: number, data: Uint8Array) => { if (data[0] === 8) throw new Error("USB"); return true; });
    expect(await stopCanWithAe(1, true, can)).toEqual({ ae: false, stop: true });
    expect(can.mock.calls.map(([, data]) => data[0])).toEqual([8, 3, 3]);
    const serial = vi.fn(async (line: string) => line === "STOP\n");
    expect(await stopSerialWithAe(serial)).toEqual({ ae: false, stop: true });
    expect(serial.mock.calls.map(([line]) => line)).toEqual(["AE 0\n", "STOP\n"]);
  });
  it("a pending CAN write does not block the independent serial stop", async () => {
    let release!: () => void; const pending = new Promise<void>(r => { release = r; });
    const writes: string[] = [];
    const stopping = Promise.all([
      stopCanWithAe(1, true, async (_id, data) => { if (data[0] === 8) await pending; return true; }),
      stopSerialWithAe(async line => { writes.push(line); return true; }),
    ]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(writes).toEqual(["AE 0\n", "STOP\n"]); release(); await stopping;
  });
});

describe("上电行为 (BOOT_*) settings group", () => {
  it("BOOT_MODE / BOOT_TARGET / BOOT_AE live on the drive page as one hidden-row group (edited via the toggle group)", () => {
    const boot = PARAM_META.filter((p) => p.group === "boot");
    expect(boot.map((p) => p.key)).toEqual(["BOOT_MODE", "BOOT_TARGET", "BOOT_AE"]);
    expect(boot.every((p) => p.page === "drive" && p.hidden && p.reboot)).toBe(true);
  });
});
