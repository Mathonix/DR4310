#!/usr/bin/env python3
"""J-Link RAM PID read/write + PCAN position hold helper."""

from __future__ import annotations

import argparse
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

JLINK = r"C:\Program Files\SEGGER\JLink_V930a\JLink.exe"

ADDR = {
    "pos_kp": 0x20000010,
    "pos_ki": 0x20000014,
    "pos_kd": 0x20000018,
    "pos_vlim": 0x2000001C,
    "pos_isep": 0x20000020,
    "pos_target": 0x20000414,
    "mode_cmd": 0x20000408,
    "pos": 0x200004E0,
    "pos_i": 0x200004EC,
    "speed_kp": 0x200005E0,
    "speed_ki": 0x200005E4,
    "speed_i": 0x200005E8,
    "tele_vel": 0x20000440,
    "tele_iq_ref": 0x20000454,
    "tele_iq": 0x20000458,
    "tele_pos": 0x2000047C,
    "tele_pos_ref": 0x20000480,
}


def f2u(x: float) -> int:
    return struct.unpack("<I", struct.pack("<f", float(x)))[0]


def u2f(u: int) -> float:
    return struct.unpack("<f", struct.pack("<I", u & 0xFFFFFFFF))[0]


def run_jlink(script_lines, timeout=15) -> str:
    content = "\n".join(script_lines) + "\n"
    with tempfile.NamedTemporaryFile("w", suffix=".jlink", delete=False, encoding="ascii") as f:
        f.write(content)
        path = f.name
    try:
        r = subprocess.run(
            [JLINK, "-CommanderScript", path],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return (r.stdout or "") + (r.stderr or "")
    finally:
        Path(path).unlink(missing_ok=True)


def parse_mem32(out: str):
    vals = {}
    for line in out.splitlines():
        line = line.strip()
        if "=" not in line:
            continue
        try:
            left, right = line.split("=", 1)
            base = int(left.strip(), 16)
            words = right.strip().split()
            for i, w in enumerate(words):
                vals[base + 4 * i] = int(w, 16)
        except Exception:
            continue
    return vals


def ram_read_floats(names):
    addrs = sorted({ADDR[n] for n in names})
    lo, hi = min(addrs), max(addrs)
    count = ((hi - lo) // 4) + 1
    out = run_jlink([
        "si SWD", "device STM32G431KB", "speed 4000", "connect",
        f"mem32 0x{lo:08X},{count}", "q",
    ])
    mem = parse_mem32(out)
    res = {}
    for n in names:
        a = ADDR[n]
        res[n] = u2f(mem[a]) if a in mem else float("nan")
    return res


def ram_write_floats(updates):
    lines = ["si SWD", "device STM32G431KB", "speed 4000", "connect"]
    for name, val in updates.items():
        a = ADDR[name]
        lines.append(f"w4 0x{a:08X}, 0x{f2u(val):08X}")
    if any(k in updates for k in ("speed_kp", "speed_ki", "pos_ki", "pos_kp", "pos_kd", "pos_isep")):
        lines.append(f"w4 0x{ADDR['speed_i']:08X}, 0x00000000")
        lines.append(f"w4 0x{ADDR['pos_i']:08X}, 0x00000000")
    lines.append("q")
    out = run_jlink(lines)
    if "Could not connect" in out:
        raise RuntimeError(out)


def ram_snapshot():
    names = [
        "pos_kp", "pos_ki", "pos_kd", "pos_vlim", "pos_isep",
        "pos_target", "pos", "pos_i", "speed_kp", "speed_ki",
        "tele_vel", "tele_iq_ref", "tele_iq", "tele_pos", "tele_pos_ref",
    ]
    return ram_read_floats(names)


def pcan_hold_position(seconds=8.0, node_id=2):
    from tools.can_motor_control import (
        CMD_POSITION, CMD_SET_MODE, MODE_POSITION, make_bus, send_command, status_id,
    )
    bus = make_bus("PCAN_USBBUS1", 1_000_000)
    print("PCAN", bus.status_string(), flush=True)
    t0 = time.time()
    while time.time() - t0 < 8:
        m = bus.recv(0.1)
        if m and m.arbitration_id == status_id(node_id):
            break
    else:
        print("NO STATUS", flush=True)
        bus.shutdown()
        return []

    send_command(bus, node_id, CMD_SET_MODE, 0.0, MODE_POSITION)
    pos0 = None
    t0 = time.time()
    while time.time() - t0 < 2.5:
        m = bus.recv(0.1)
        if m and m.arbitration_id == status_id(node_id) and m.data[0] == MODE_POSITION:
            pos0 = struct.unpack("<f", bytes(m.data[2:6]))[0]
            break
    if pos0 is None:
        print("no position feedback", flush=True)
        bus.shutdown()
        return []

    send_command(bus, node_id, CMD_POSITION, pos0)
    print(f"HOLD target={pos0:.4f} for {seconds:.1f}s - apply disturbances now", flush=True)
    rows = []
    t0 = time.time()
    while time.time() - t0 < seconds:
        m = bus.recv(0.05)
        if m is None or m.arbitration_id != status_id(node_id):
            continue
        mode, fault = m.data[0], m.data[1]
        fb = struct.unpack("<f", bytes(m.data[2:6]))[0]
        err = fb - pos0
        rows.append((time.time() - t0, mode, fault, fb, err))
        if len(rows) % 10 == 0:
            print(f"  t={rows[-1][0]:.2f}s pos={fb:.4f} err={err:+.4f} fault=0x{fault:02X}", flush=True)
    if rows:
        maxe = max(abs(r[4]) for r in rows)
        late = [r[4] for r in rows if r[0] >= max(0.0, rows[-1][0] - 1.0)]
        rms = (sum(e * e for e in late) / len(late)) ** 0.5 if late else float("nan")
        peak = max(rows, key=lambda r: abs(r[4]))
        print(
            f"n={len(rows)} max|err|={maxe:.4f} late_rms={rms:.4f} peak_err={peak[4]:+.4f}@{peak[0]:.2f}s",
            flush=True,
        )
    bus.shutdown()
    return rows


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("get")
    s = sub.add_parser("set")
    s.add_argument("--pos-kp", type=float)
    s.add_argument("--pos-ki", type=float)
    s.add_argument("--pos-kd", type=float)
    s.add_argument("--pos-vlim", type=float)
    s.add_argument("--pos-isep", type=float)
    s.add_argument("--speed-kp", type=float)
    s.add_argument("--speed-ki", type=float)
    m = sub.add_parser("hold")
    m.add_argument("--seconds", type=float, default=8.0)
    args = ap.parse_args()

    if args.cmd == "get":
        snap = ram_snapshot()
        for k, v in snap.items():
            print(f"{k:14s} = {v}")
        return 0
    if args.cmd == "set":
        mapping = {
            "pos_kp": args.pos_kp,
            "pos_ki": args.pos_ki,
            "pos_kd": args.pos_kd,
            "pos_vlim": args.pos_vlim,
            "pos_isep": args.pos_isep,
            "speed_kp": args.speed_kp,
            "speed_ki": args.speed_ki,
        }
        upd = {k: v for k, v in mapping.items() if v is not None}
        if not upd:
            print("no updates")
            return 1
        ram_write_floats(upd)
        snap = ram_snapshot()
        print("updated:")
        for k in upd:
            print(f"  {k} = {snap.get(k)}")
        return 0
    if args.cmd == "hold":
        pcan_hold_position(args.seconds)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
