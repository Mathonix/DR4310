#!/usr/bin/env python3
"""Position-loop debug: relative steps around current unwrap position."""

from __future__ import annotations

import struct
import sys
import time

from tools.can_motor_control import (
    CMD_DISABLE,
    CMD_POSITION,
    CMD_SET_MODE,
    MODE_POSITION,
    make_bus,
    send_command,
    status_id,
)

NODE_ID = 2


def wait_status(bus, timeout=12.0, need=4):
    t0 = time.time()
    n = 0
    last = None
    while time.time() - t0 < timeout:
        m = bus.recv(0.1)
        if m is None or m.arbitration_id != status_id(NODE_ID):
            continue
        n += 1
        fb = struct.unpack("<f", bytes(m.data[2:6]))[0]
        last = (m.data[0], m.data[1], fb)
        if n <= 2:
            print(f"  status#{n} mode={last[0]} fault={last[1]} fb={fb:.4f}", flush=True)
        if n >= need:
            return True, last
    return False, last


def collect(bus, seconds, want=None):
    rows = []
    t0 = time.time()
    while time.time() - t0 < seconds:
        m = bus.recv(0.1)
        if m is None or m.arbitration_id != status_id(NODE_ID):
            continue
        mode, fault = m.data[0], m.data[1]
        fb = struct.unpack("<f", bytes(m.data[2:6]))[0]
        if want is not None and mode != want:
            continue
        rows.append((time.time() - t0, mode, fault, fb))
    return rows


def summarize(rows, target):
    if not rows:
        return "no samples"
    vals = [r[3] for r in rows]
    start = vals[0]
    final = sum(vals[-8:]) / min(8, len(vals[-8:]))
    if target >= start:
        peak = max(vals)
        overshoot = max(0.0, peak - target)
    else:
        peak = min(vals)
        overshoot = max(0.0, target - peak)
    moved = final - start
    return (
        f"start={start:.4f} final={final:.4f} target={target:.4f} "
        f"moved={moved:+.4f} err={final-target:+.4f} overshoot={overshoot:.4f} n={len(rows)}"
    )


def soft_hold(bus):
    send_command(bus, NODE_ID, CMD_SET_MODE, 0.0, MODE_POSITION)
    # wait until mode appears, then hold sample
    t0 = time.time()
    while time.time() - t0 < 2.5:
        rows = collect(bus, 0.4, MODE_POSITION)
        if rows:
            # extra settle sample
            more = collect(bus, 0.8, MODE_POSITION)
            return (more[-1][3] if more else rows[-1][3])
    return None


def step_rel(bus, delta, hold_s=5.0):
    pos0 = soft_hold(bus)
    if pos0 is None:
        print("  FAIL soft-hold enter", flush=True)
        return False
    target = pos0 + delta
    print(f"  pos0={pos0:.4f} delta={delta:+.3f} target={target:.4f}", flush=True)
    send_command(bus, NODE_ID, CMD_POSITION, target)
    rows = collect(bus, hold_s, MODE_POSITION)
    print(" ", summarize(rows, target), flush=True)
    if rows:
        # progress samples
        for tmark in (0.5, 1.5, 3.0):
            v = next((r[3] for r in rows if r[0] >= tmark), None)
            if v is not None:
                print(f"   t={tmark:.1f}s pos={v:.4f}", flush=True)
        print(f"   last={rows[-1][3]:.4f}", flush=True)
    send_command(bus, NODE_ID, CMD_DISABLE)
    time.sleep(0.6)
    return True


def main() -> int:
    bus = make_bus("PCAN_USBBUS1", 1_000_000)
    print("PCAN", bus.status_string(), flush=True)
    print("waiting MCU status...", flush=True)
    ok, last = wait_status(bus)
    if not ok:
        print("NO STATUS", last, flush=True)
        bus.shutdown()
        return 2
    print("bus live", last, flush=True)
    send_command(bus, NODE_ID, CMD_DISABLE)
    time.sleep(0.3)

    print("\n=== +0.5 rad ===", flush=True)
    step_rel(bus, +0.5, 7.0)

    print("\n=== -0.5 rad ===", flush=True)
    step_rel(bus, -0.5, 7.0)

    print("\n=== +1.0 rad ===", flush=True)
    step_rel(bus, +1.0, 7.0)

    print("\n=== -1.0 rad ===", flush=True)
    step_rel(bus, -1.0, 7.0)

    send_command(bus, NODE_ID, CMD_DISABLE)
    print("\nDone.", flush=True)
    bus.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
