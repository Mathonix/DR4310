import { describe, expect, it } from "vitest";
import { aggregateMeasurement, type Feedback } from "../src/measurement";
import { parseInfo } from "../src/uartcfg-protocol";

const feedback = (): Feedback => ({ route: "can", motorId: 1, now: 1000, canEnabled: true, serialEnabled: true,
  status: { value: { mode: 0, faults: 0, primary: 12, rpm: 0 }, t: 950 }, gm: { value: null, t: 0 },
  uart: { value: new Float32Array([20, 100, .5, 24]), t: 950 }, roles: { pos: 0, rpm: 1, iq: 2, vbus: 3 },
  info: parseInfo({ id: "2", mode: "3", vbus: "24", fault: "0x40" }), infoAge: 50, cachedVbus: { v: NaN, t: 0 }, kt: .1 });

describe("feedback identity and freshness", () => {
  it("does not align CAN node 1 with serial node 2's position or faults", () => {
    const m = aggregateMeasurement(feedback()); expect(m.pos).toBeNaN(); expect(m.faults).toBe(0); expect(m.vbus).toBe(12); expect(m.rpm).toBe(0);
  });
  it("allows matched UART position to supplement CAN and combines current fault masks", () => {
    const f = feedback(); f.info!.id = 1; f.status.value!.faults = 2;
    const m = aggregateMeasurement(f); expect(m.pos).toBe(20); expect(m.faults).toBe(0x42); expect(m.src).toContain("串口遥测");
  });
  it("UART telemetry cannot conceal loss of the controlled CAN node", () => {
    const f = feedback(); f.info!.id = 1; f.status.t = 0;
    expect(aggregateMeasurement(f).fresh).toBe(false);
  });
  it("serial control ignores another CAN node's state and selects serial units", () => {
    const f = feedback(); f.route = "serial"; f.status.value!.mode = 4; f.status.value!.primary = -30;
    const m = aggregateMeasurement(f); expect(m.pos).toBe(20); expect(m.mode).toBe(3); expect(m.rpm).toBe(100); expect(m.vbus).toBe(24); expect(m.faults).toBe(0x40);
  });
  it("expired or disconnected streams never count as live feedback", () => {
    const f = feedback(); f.route = "serial"; f.uart.t = 0; f.infoAge = 3000;
    expect(aggregateMeasurement(f).fresh).toBe(false); f.uart.t = 1000; f.infoAge = 0; f.serialEnabled = false;
    expect(aggregateMeasurement(f).pos).toBeNaN(); expect(aggregateMeasurement(f).fresh).toBe(false);
  });
});
