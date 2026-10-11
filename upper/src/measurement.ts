import { dqPower, mechPower, type Role } from "./features";
import type { Meas, Route } from "./dashboard";
import type { GmFeedback, NativeStatus } from "./protocol";
import type { DeviceInfo } from "./uartcfg-protocol";

type Timed<T> = { value: T | null; t: number };
export type Feedback = {
  route: Route; motorId: number; now: number; canEnabled: boolean; serialEnabled: boolean;
  status: Timed<NativeStatus>; gm: Timed<GmFeedback>; uart: Timed<Float32Array>;
  info: DeviceInfo | null; infoAge: number; roles: Partial<Record<Role, number>>;
  cachedVbus: { v: number; t: number }; kt: number;
};

/** Control feedback is scoped to the selected link. UART can supplement CAN only for the same confirmed node. */
export function aggregateMeasurement(f: Feedback): Meas {
  const can = f.route === "can";
  const info = f.serialEnabled && f.infoAge < 2500 ? f.info : null;
  const serialOk = f.route === "serial" || f.route === "legacy" || (can && info?.id === f.motorId);
  const st = can && f.canEnabled && f.now - f.status.t < 500 ? f.status.value : null;
  const fb = can && f.canEnabled && f.now - f.gm.t < 200 ? f.gm.value : null;
  const u = serialOk && f.serialEnabled && f.now - f.uart.t < 300 ? f.uart.value : null;
  const inf = serialOk ? info : null;
  const ur = (r: Role) => { const i = f.roles[r]; return u && i !== undefined && i < u.length ? u[i]! : NaN; };
  const pick = (...v: number[]) => v.find(Number.isFinite) ?? NaN;
  const mode = st?.mode ?? inf?.mode ?? null;
  const rpm = pick(fb?.rpm ?? NaN, ur("rpm"), ur("omega") * (30 / Math.PI), st?.rpm ?? NaN);
  const iq = pick(fb?.iq ?? NaN, st?.mode === 1 ? st.primary : NaN, ur("iq"));
  const pos = pick(st && (st.mode === 3 || st.mode === 4) ? st.primary : NaN, ur("pos"));
  const vbus = pick(st?.mode === 0 ? st.primary : NaN, ur("vbus"), inf?.vbus ?? NaN, can && f.now - f.cachedVbus.t < 30000 ? f.cachedVbus.v : NaN);
  let power = ur("power"), powerSrc = Number.isFinite(power) ? "固件" : "";
  if (!Number.isFinite(power)) {
    const vd = ur("vd"), id = ur("id"), vq = ur("vq"), iqU = ur("iq");
    if ([vd, id, vq, iqU].every(Number.isFinite)) { power = dqPower(vd, id, vq, iqU); powerSrc = "电 dq"; }
  }
  if (!Number.isFinite(power) && f.kt > 0 && Number.isFinite(iq) && Number.isFinite(rpm)) { power = mechPower(iq, f.kt, rpm); powerSrc = "机械"; }
  const src = [st && "CAN 状态", fb && "GM 1 kHz", u && "串口遥测", inf && "INFO"].filter(Boolean).join(" + ");
  return { fresh: can ? !!(st || fb) : !!(u || inf), mode, faults: (st?.faults ?? 0) | (inf?.fault ?? 0), rpm, pos, iq, vbus, power, powerSrc, src };
}
