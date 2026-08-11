#!/usr/bin/env python3
"""Speed + position step response over PCAN (PCAN must be open first)."""

from __future__ import annotations

import struct
import sys
import time

from tools.can_motor_control import (
    CMD_DISABLE,
    CMD_POSITION,
    CMD_SET_MODE,
    CMD_SPEED,
    MODE_POSITION,
    MODE_SPEED,
    make_bus,
    send_command,
    status_id,
)

NODE_ID = 2


def wait_status(bus, timeout=12.0, need=5):
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
        if n <= 3:
            print(f"  status#{n} mode={last[0]} fault={last[1]} fb={fb:.3f}", flush=True)
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


def summarize_speed(rows, target):
    if not rows:
        return "no samples"
    vals = [r[3] for r in rows]
    peak = max(abs(v) for v in vals)
    late = [r[3] for r in rows if r[0] >= max(0.0, rows[-1][0] - 1.2)]
    settle = sum(late) / len(late)
    return f"n={len(rows)} settle={settle:.1f}rpm peak={peak:.1f}rpm err={settle-target:+.1f}"


def summarize_pos(rows, target):
    if not rows:
        return "no samples"
    vals = [r[3] for r in rows]
    start = vals[0]
    final = sum(vals[-8:]) / min(8, len(vals[-8:]))
    if target >= start:
        overshoot = max(0.0, max(vals) - target)
    else:
        overshoot = max(0.0, target - min(vals))
    return (
        f"n={len(rows)} start={start:.3f} final={final:.3f} target={target:.3f} "
        f"err={final-target:+.3f} overshoot={overshoot:.3f}"
    )


def main() -> int:
    bus = make_bus("PCAN_USBBUS1", 1_000_000)
    print("PCAN", bus.status_string(), flush=True)
    print("waiting MCU status (reset MCU if needed)...", flush=True)
    ok, last = wait_status(bus, 15.0, 5)
    if not ok:
        print("NO STATUS", last, flush=True)
        bus.shutdown()
        return 2
    print("bus live", last, flush=True)

    send_command(bus, NODE_ID, CMD_DISABLE)
    time.sleep(0.4)

    print("\n=== SPEED 40 rpm x 6s ===", flush=True)
    send_command(bus, NODE_ID, CMD_SPEED, 40.0)
    rows = collect(bus, 6.0, MODE_SPEED)
    print(" ", summarize_speed(rows, 40.0), flush=True)
    if rows:
        print(
            f"  t1={next((r[3] for r in rows if r[0] >= 1), None)} "
            f"t3={next((r[3] for r in rows if r[0] >= 3), None)} "
            f"last={rows[-1][3]:.2f}",
            flush=True,
        )
    send_command(bus, NODE_ID, CMD_DISABLE)
    time.sleep(1.0)

    print("\n=== SPEED 80 rpm x 6s ===", flush=True)
    send_command(bus, NODE_ID, CMD_SPEED, 80.0)
    rows = collect(bus, 6.0, MODE_SPEED)
    print(" ", summarize_speed(rows, 80.0), flush=True)
    if rows:
        print(f"  last={rows[-1][3]:.2f}", flush=True)
    send_command(bus, NODE_ID, CMD_DISABLE)
    time.sleep(1.0)

    print("\n=== POSITION soft-hold then +0.5 rad ===", flush=True)
    send_command(bus, NODE_ID, CMD_SET_MODE, 0.0, MODE_POSITION)
    hold = collect(bus, 1.5, MODE_POSITION)
    if not hold:
        print(" no enter", flush=True)
        send_command(bus, NODE_ID, CMD_DISABLE)
        bus.shutdown()
        return 1
    pos0 = hold[-1][3]
    target = pos0 + 0.5
    print(f"  pos0={pos0:.4f} -> {target:.4f}", flush=True)
    send_command(bus, NODE_ID, CMD_POSITION, target)
    rows = collect(bus, 5.0, MODE_POSITION)
    print(" ", summarize_pos(rows, target), flush=True)
    if rows:
        print(f"  last={rows[-1][3]:.4f}", flush=True)
    send_command(bus, NODE_ID, CMD_DISABLE)
    time.sleep(0.8)

    print("\n=== POSITION soft-hold then +1.0 rad ===", flush=True)
    send_command(bus, NODE_ID, CMD_SET_MODE, 0.0, MODE_POSITION)
    hold = collect(bus, 1.2, MODE_POSITION)
    if not hold:
        print(" no enter", flush=True)
        send_command(bus, NODE_ID, CMD_DISABLE)
        bus.shutdown()
        return 1
    pos1 = hold[-1][3]
    target2 = pos1 + 1.0
    print(f"  pos1={pos1:.4f} -> {target2:.4f}", flush=True)
    send_command(bus, NODE_ID, CMD_POSITION, target2)
    rows = collect(bus, 6.0, MODE_POSITION)
    print(" ", summarize_pos(rows, target2), flush=True)
    if rows:
        print(f"  last={rows[-1][3]:.4f}", flush=True)
    send_command(bus, NODE_ID, CMD_DISABLE)

    print("\nDone.", flush=True)
    bus.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
