import { nativeAutoEnable, nativeControlId, nativeDisable, nativeEstop } from "./protocol";
import { cmd } from "./uartcfg-protocol";

export type AeTarget = { route: "can" | "serial"; id: number };
export type AeInfo = { id: number; ae: number; t: number };
type Stop = { t: number; ok: boolean };
export type AeView = { on: boolean; known: boolean; source: "reported" | "stopped" | "unknown"; available: boolean };
export type AeHost = {
  target(): AeTarget | null;
  info(): AeInfo | null;
  now(): number;
  changed(): void;
};

/**
 * Read-only runtime auto-enable (AE) state. The host never turns AE on (only the firmware's persistent BOOT_AE,
 * set in 参数配置 › 驱动参数 › 上电行为, or another tool can). It tracks the firmware-reported INFO ae= so every stop
 * path can still send AE off first, and so a motor that booted with AE on keeps the feedback watchdog active.
 */
export function createAeTracker(h: AeHost) {
  const stops = new Map<string, Stop>();
  const key = (t: AeTarget) => t.route === "can" ? `can:${t.id}` : "serial";

  function view(target = h.target()): AeView {
    if (!target) return { on: false, known: false, source: "unknown", available: false };
    const last = stops.get(key(target)), info = h.info();
    // INFO from another CAN node, or captured before the last stop, cannot replace its state.
    if (info && (target.route === "serial" || info.id === target.id) && (info.ae === 0 || info.ae === 1) && (!last || info.t > last.t)) {
      return { on: info.ae === 1, known: true, source: "reported", available: true };
    }
    return { on: false, known: !!last?.ok, source: last?.ok ? "stopped" : "unknown", available: true };
  }
  function resetOff(id: number): void {
    const state = { t: h.now(), ok: false };
    stops.set(`can:${id}`, state); stops.set("serial", state);
    h.changed();
  }
  function stopped(target: AeTarget, ok: boolean): void {
    stops.set(key(target), { t: h.now(), ok }); h.changed();
  }
  function forget(route: "can" | "serial"): void {
    for (const k of stops.keys()) if (k.startsWith(route)) stops.delete(k);
    h.changed();
  }
  return { view, resetOff, stopped, forget };
}

/** Each stop attempts AE off first, even if that attempt fails. Emergency CAN sends twice. */
export async function stopCanWithAe(id: number, emergency: boolean, send: (id: number, data: Uint8Array) => Promise<boolean>) {
  const controlId = nativeControlId(id);
  const attempt = async (data: Uint8Array) => { try { return await send(controlId, data); } catch { return false; } };
  const ae = await attempt(nativeAutoEnable(false));
  const first = await attempt(emergency ? nativeEstop() : nativeDisable());
  const second = emergency ? await attempt(nativeEstop()) : false;
  return { ae, stop: first || second };
}

export async function stopSerialWithAe(send: (line: string) => Promise<boolean>) {
  const attempt = async (line: string) => { try { return await send(line); } catch { return false; } };
  const ae = await attempt(cmd("AE", 0));
  const stop = await attempt(cmd("STOP"));
  return { ae, stop };
}
