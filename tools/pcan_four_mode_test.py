#!/usr/bin/env python3
"""Safe sequential PCAN four-mode smoke test for node_id=2."""

from __future__ import annotations

import struct
import sys
import time

import can

from tools.can_motor_control import (
    CMD_CURRENT,
    CMD_DISABLE,
    CMD_MIT,
    CMD_POSITION,
    CMD_SPEED,
    MODE_CURRENT,
    MODE_DISABLED,
    MODE_MIT,
    MODE_POSITION,
    MODE_SPEED,
    control_id,
    decode_status,
    make_bus,
    pack_mit,
    send_command,
    send_mit,
    status_id,
)

NODE_ID = 2
CHANNEL = "PCAN_USBBUS1"
BITRATE = 1_000_000


def collect_status(bus: can.BusABC, seconds: float) -> list[str]:
    lines: list[str] = []
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        msg = bus.recv(timeout=0.1)
        if msg is None:
            continue
        decoded = decode_status(msg, NODE_ID)
        if decoded is not None:
            lines.append(decoded)
    return lines


def wait_mode(bus: can.BusABC, expected_mode: int, timeout_s: float = 2.0) -> tuple[bool, str]:
    deadline = time.monotonic() + timeout_s
    last = "no status"
    while time.monotonic() < deadline:
        msg = bus.recv(timeout=0.1)
        if msg is None:
            continue
        if msg.arbitration_id != status_id(NODE_ID) or len(msg.data) < 8:
            continue
        mode = msg.data[0]
        fault = msg.data[1]
        feedback = struct.unpack("<f", bytes(msg.data[2:6]))[0]
        last = decode_status(msg, NODE_ID) or last
        if mode == expected_mode and fault == 0:
            return True, last
        if fault != 0:
            return False, last
    return False, last


def step(title: str) -> None:
    print(f"\n=== {title} ===")


def main() -> int:
    print("Opening PCAN...")
    bus = make_bus(CHANNEL, BITRATE)
    print(f"PCAN status: {bus.status_string()}")

    results: list[tuple[str, bool, str]] = []

    try:
        step("0) Baseline status (1.2s)")
        base = collect_status(bus, 1.2)
        if not base:
            print("FAIL: no status frames from node 2 (0x182). Check wiring/power/node id.")
            return 1
        print(f"  got {len(base)} frames")
        print(f"  last: {base[-1]}")
        results.append(("status RX", True, base[-1]))

        step("1) DISABLE / IDLE")
        send_command(bus, NODE_ID, CMD_DISABLE)
        ok, last = wait_mode(bus, MODE_DISABLED, 1.5)
        print(f"  {'OK' if ok else 'WARN'}: {last}")
        results.append(("disable", ok, last))

        step("2) CURRENT 0.15 A (hold 2.5s then 0)")
        send_command(bus, NODE_ID, CMD_CURRENT, 0.15)
        ok, last = wait_mode(bus, MODE_CURRENT, 2.0)
        print(f"  enter: {'OK' if ok else 'FAIL'} {last}")
        samples = collect_status(bus, 2.0)
        if samples:
            print(f"  mid:   {samples[-1]}")
        send_command(bus, NODE_ID, CMD_CURRENT, 0.0)
        time.sleep(0.4)
        send_command(bus, NODE_ID, CMD_DISABLE)
        ok2, last2 = wait_mode(bus, MODE_DISABLED, 1.5)
        print(f"  exit:  {'OK' if ok2 else 'WARN'} {last2}")
        results.append(("current 0.15A", ok, last))

        step("3) SPEED 40 rpm (hold 3s)")
        send_command(bus, NODE_ID, CMD_SPEED, 40.0)
        ok, last = wait_mode(bus, MODE_SPEED, 2.0)
        print(f"  enter: {'OK' if ok else 'FAIL'} {last}")
        samples = collect_status(bus, 3.0)
        if samples:
            print(f"  mid:   {samples[len(samples)//2]}")
            print(f"  last:  {samples[-1]}")
        send_command(bus, NODE_ID, CMD_DISABLE)
        ok2, last2 = wait_mode(bus, MODE_DISABLED, 1.5)
        print(f"  exit:  {'OK' if ok2 else 'WARN'} {last2}")
        results.append(("speed 40rpm", ok, last if not samples else samples[-1]))

        step("4) POSITION hold current + 0.5 rad")
        # Read current position from status while disabled (feedback is bus_v when disabled).
        # Enter position with a small absolute target near last known ~4.3 rad from J-Link.
        # First enter with current position estimate, then step +0.5.
        pos0 = 4.3
        send_command(bus, NODE_ID, CMD_POSITION, pos0)
        ok, last = wait_mode(bus, MODE_POSITION, 2.0)
        print(f"  enter@ {pos0}: {'OK' if ok else 'FAIL'} {last}")
        samples = collect_status(bus, 1.0)
        if samples:
            # parse feedback as position
            msg = None
            # use last status string only; also request a raw frame
            print(f"  hold:  {samples[-1]}")
            # Extract feedback float by re-reading one frame
        # grab one raw frame for position
        pos_fb = pos0
        deadline = time.monotonic() + 0.8
        while time.monotonic() < deadline:
            m = bus.recv(timeout=0.1)
            if m is None or m.arbitration_id != status_id(NODE_ID) or len(m.data) < 8:
                continue
            if m.data[0] == MODE_POSITION:
                pos_fb = struct.unpack("<f", bytes(m.data[2:6]))[0]
                break
        target = pos_fb + 0.5
        print(f"  step to {target:.4f} rad (from {pos_fb:.4f})")
        send_command(bus, NODE_ID, CMD_POSITION, target)
        samples = collect_status(bus, 3.0)
        if samples:
            print(f"  last:  {samples[-1]}")
        send_command(bus, NODE_ID, CMD_DISABLE)
        ok2, last2 = wait_mode(bus, MODE_DISABLED, 1.5)
        print(f"  exit:  {'OK' if ok2 else 'WARN'} {last2}")
        results.append(("position +0.5rad", ok, samples[-1] if samples else last))

        step("5) MIT soft hold (kp=8, kd=0.4)")
        send_command(bus, NODE_ID, CMD_MIT)
        time.sleep(0.05)
        # Use last position feedback if available
        mit_pos = pos_fb
        send_mit(bus, NODE_ID, mit_pos, 0.0, 8.0, 0.4, 0.0)
        ok, last = wait_mode(bus, MODE_MIT, 2.0)
        print(f"  enter: {'OK' if ok else 'FAIL'} {last}")
        # stream a few packs at same position
        for _ in range(10):
            send_mit(bus, NODE_ID, mit_pos, 0.0, 8.0, 0.4, 0.0)
            time.sleep(0.05)
        samples = collect_status(bus, 1.5)
        if samples:
            print(f"  last:  {samples[-1]}")
        # small step
        send_mit(bus, NODE_ID, mit_pos + 0.3, 0.0, 8.0, 0.4, 0.0)
        samples = collect_status(bus, 2.0)
        if samples:
            print(f"  step:  {samples[-1]}")
        # escape MIT with zeroed disable
        send_command(bus, NODE_ID, CMD_DISABLE)
        ok2, last2 = wait_mode(bus, MODE_DISABLED, 2.0)
        print(f"  exit:  {'OK' if ok2 else 'WARN'} {last2}")
        results.append(("MIT soft", ok, samples[-1] if samples else last))

        step("6) Final DISABLE")
        send_command(bus, NODE_ID, CMD_DISABLE)
        ok, last = wait_mode(bus, MODE_DISABLED, 1.5)
        print(f"  {'OK' if ok else 'WARN'}: {last}")
        results.append(("final disable", ok, last))

    except Exception as exc:
        print(f"ERROR: {exc}")
        try:
            send_command(bus, NODE_ID, CMD_DISABLE)
        except Exception:
            pass
        return 2
    finally:
        try:
            send_command(bus, NODE_ID, CMD_DISABLE)
        except Exception:
            pass
        bus.shutdown()

    step("SUMMARY")
    failed = 0
    for name, ok, detail in results:
        mark = "PASS" if ok else "FAIL"
        if not ok:
            failed += 1
        print(f"  [{mark}] {name}: {detail}")

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
