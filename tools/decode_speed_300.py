#!/usr/bin/env python3
"""Decode J-Link log from debug_speed_300.jlink using current map addresses."""

from __future__ import annotations

import re
import struct
import sys
from pathlib import Path

RPM_SCALE = 9.54929658551

# Addresses from build/Debug/4310_G431KBT6.map (2026-07-11 rebuild)
ADDR = {
    "mode_cmd": 0x20000400,
    "enable": 0x20000401,
    "open_loop_en": 0x20000402,
    "current_en": 0x20000403,
    "calibrate_en": 0x20000407,
    "vel_ref": 0x20000408,
    "e_zero": 0x2000041C,
    "enc_dir": 0x20000034,
    "telemetry": 0x2000043C,
    "foc": 0x20000524,
    "motion": 0x200005EC,
    "power_armed": 0x200004FE,
}

MODE = {
    0: "IDLE",
    1: "CURRENT",
    2: "SPEED",
    3: "POSITION",
    4: "MIT",
    10: "ALIGN",
    11: "OPEN_LOOP",
    12: "IDENT",
    13: "CALIBRATE",
}


def u2f(u: int) -> float:
    return struct.unpack("<f", struct.pack("<I", u & 0xFFFFFFFF))[0]


def parse_mem_blocks(text: str):
    """Return list of (base_addr, [words...]) in order of appearance."""
    blocks = []
    for m in re.finditer(
        r"(?m)^(20[0-9A-Fa-f]{6})\s*=\s*((?:[0-9A-Fa-f]{8}\s*)+)$",
        text,
    ):
        base = int(m.group(1), 16)
        words = [int(w, 16) for w in m.group(2).split()]
        blocks.append((base, words))
    # also mem8 single-byte dumps as 32-bit lines sometimes
    for m in re.finditer(r"(?m)^(20[0-9A-Fa-f]{6})\s*=\s*([0-9A-Fa-f]{2})\s*$", text):
        base = int(m.group(1), 16)
        blocks.append((base, [int(m.group(2), 16)]))
    return blocks


def decode_telemetry(words):
    # expect 24 words from mem32 telemetry,24
    def f(i):
        return u2f(words[i]) if i < len(words) else float("nan")

    def u(i):
        return words[i] if i < len(words) else 0

    mode = u(20) & 0xFF
    return {
        "angle_deg": f(0),
        "vel_rpm": f(1) * RPM_SCALE,
        "vel_rad_s": f(1),
        "ia": f(4),
        "ib": f(5),
        "iq_ref": f(6),
        "iq": f(7),
        "id": f(8),
        "vd": f(9),
        "vq": f(10),
        "bus": f(11),
        "pos": f(15),
        "loop": u(17),
        "isr": u(18),
        "fault": u(19),
        "mode": mode,
        "mode_name": MODE.get(mode, str(mode)),
        "ident": (u(20) >> 8) & 0xFF,
        "calib": (u(20) >> 16) & 0xFF,
        "enc_dir": (u(20) >> 24) & 0xFF,
        "e_zero": f(21) if len(words) > 21 else float("nan"),
    }


def decode_foc(words):
    def f(i):
        return u2f(words[i]) if i < len(words) else float("nan")

    flags = words[15] if len(words) > 15 else 0
    return {
        "id_ref": f(0),
        "iq_ref": f(1),
        "id": f(2),
        "iq": f(3),
        "vd": f(4),
        "vq": f(5),
        "duty_a": f(8),
        "duty_b": f(9),
        "duty_c": f(10),
        "bus": f(11),
        "e_ang": f(12),
        "omega_e": f(13),
        "enabled": flags & 0xFF,
        "ang_ov": (flags >> 16) & 0xFF,
        "ol_en": (flags >> 24) & 0xFF,
    }


def main():
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "debug_speed_300_log.txt")
    text = path.read_text(encoding="utf-8", errors="ignore")
    if "\x00" in text[:200]:
        text = path.read_text(encoding="utf-16", errors="ignore")

    blocks = parse_mem_blocks(text)
    snap_i = 0
    for base, words in blocks:
        if base == ADDR["telemetry"] and len(words) >= 20:
            t = decode_telemetry(words)
            snap_i += 1
            print(f"\n=== TELEMETRY SNAP #{snap_i} ===")
            print(
                f"mode={t['mode_name']}({t['mode']}) fault=0x{t['fault']:X} "
                f"bus={t['bus']:.2f}V calib={t['calib']} enc_dir={t['enc_dir']} e_zero={t['e_zero']:.4f}"
            )
            print(
                f"vel={t['vel_rpm']:+.1f} rpm ({t['vel_rad_s']:+.3f} rad/s) "
                f"iq_ref={t['iq_ref']:+.3f}A iq={t['iq']:+.3f}A id={t['id']:+.3f}A"
            )
            print(
                f"ia={t['ia']:+.3f}A ib={t['ib']:+.3f}A vd={t['vd']:+.2f} vq={t['vq']:+.2f} "
                f"isr={t['isr']} loop={t['loop']}"
            )
        elif base == ADDR["foc"] and len(words) >= 14:
            f = decode_foc(words)
            print(
                f"  FOC en={f['enabled']} e_ang={f['e_ang']:.3f} we={f['omega_e']:.1f} "
                f"iq_ref={f['iq_ref']:+.3f} iq={f['iq']:+.3f} vq={f['vq']:+.2f} "
                f"duty=[{f['duty_a']:.2f},{f['duty_b']:.2f},{f['duty_c']:.2f}]"
            )
        elif base == ADDR["e_zero"] and len(words) == 1:
            print(f"  e_zero_raw={u2f(words[0]):.6f} rad")
        elif base == ADDR["enc_dir"] and len(words) == 1:
            print(f"  enc_dir_raw={words[0] & 0xFF}")
        elif base == ADDR["mode_cmd"] and len(words) >= 1:
            # mem8 dump of 8 mode bytes may appear as multiple
            pass

    # quick health from last telemetry
    teles = [decode_telemetry(w) for b, w in blocks if b == ADDR["telemetry"] and len(w) >= 20]
    if teles:
        last = teles[-1]
        print("\n=== SUMMARY ===")
        print(f"snaps={len(teles)} last_mode={last['mode_name']} last_rpm={last['vel_rpm']:+.1f}")
        speed_snaps = [t for t in teles if t["mode"] == 2]
        if speed_snaps:
            rpms = [t["vel_rpm"] for t in speed_snaps]
            print(
                f"speed_mode snaps={len(speed_snaps)} rpm min/avg/max="
                f"{min(rpms):+.1f}/{sum(rpms)/len(rpms):+.1f}/{max(rpms):+.1f}"
            )
            good = [t for t in speed_snaps if abs(t["vel_rpm"] - 300) < 60 or abs(t["vel_rpm"] + 300) < 60]
            print(f"near_±300rpm snaps={len(good)}")
        if any(t["fault"] & 0x8 for t in teles):
            print("WARN: bus undervolt fault seen (need >=6V pack)")
        if any(t["fault"] & 0x1 for t in teles):
            print("WARN: encoder fault seen")
        if any(t["fault"] & 0x4 for t in teles):
            print("WARN: DRV nFAULT seen")


if __name__ == "__main__":
    main()
