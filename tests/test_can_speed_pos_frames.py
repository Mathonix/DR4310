"""Decode the two documented CAN example frames through the *firmware's own* C code.

The decode functions (CAN_UintToFloat, CAN_UnpackU16, CAN_ApplySpeedFrame,
CAN_ApplyPositionFrame) and the CAN_* range macros are extracted verbatim from
Core/Src/main.c, compiled for the host with small stubs, and executed.

Run:  python -m pytest tests/test_can_speed_pos_frames.py   (or)   python tests/test_can_speed_pos_frames.py
Needs a host C compiler (cc/gcc/clang); the test is skipped if none is found.
"""
import os
import re
import shutil
import subprocess
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN_C = os.path.join(ROOT, "Core", "Src", "main.c")
FUNCS = ["CAN_UintToFloat", "CAN_UnpackU16", "CAN_ApplySpeedFrame", "CAN_ApplyPositionFrame"]

# Example frames from docs/CAN_USAGE.md (ID 1 on the bench board).
SPEED_EXAMPLE = bytes.fromhex("cc8c660606010000")    # 0x401: 100 rpm, Kp 0.25, Ki 0.02, Kd 0
POSITION_EXAMPLE = bytes.fromhex("66807B041203A806")  # 0x501: 1.57 rad, Kp 3.5, Ki 1.2, Kd 2.6


def _extract_function(src, name):
    m = re.search(r"^static\s+\w+\s+" + name + r"\s*\([^;{]*\)\s*\{", src, re.M)
    assert m, "function not found in main.c: " + name
    i, depth = m.end() - 1, 0
    while True:
        c = src[i]
        depth += c == "{"
        depth -= c == "}"
        i += 1
        if depth == 0:
            return src[m.start():i]


def _harness():
    src = open(MAIN_C, encoding="utf-8", errors="replace").read().replace("\r\n", "\n")
    defines = "\n".join(re.findall(r"^#define\s+(?:CAN_\w+|RPM_TO_RAD_S)\b.*$", src, re.M))
    protos = "\n".join(_extract_function(src, f).split("{", 1)[0].strip() + ";" for f in FUNCS)
    body = "\n\n".join(_extract_function(src, f) for f in FUNCS)
    return f"""
#include <stdint.h>
#include <stdio.h>
#include "control_app.h"
{defines}
volatile float control_speed_pi_kp, control_speed_pi_ki, control_speed_pi_kd;
volatile float control_position_kp, control_position_ki, control_position_kd;
volatile uint8_t can_control_mode, can_control_last_cmd; volatile uint32_t can_control_rx_count;
volatile float can_control_target;
static unsigned mode_set = 255; static float spd_ref = -1e9f, pos_ref = -1e9f;
static unsigned enc_ready = 1;
void ControlApp_SetMode(uint8_t m) {{ mode_set = m; }}
void ControlApp_SetSpeedRef(float v) {{ spd_ref = v; }}
void ControlApp_SetPositionRef(float p) {{ pos_ref = p; }}
uint8_t ControlApp_PositionEncoderReady(void) {{ return (uint8_t)enc_ready; }}
{protos}
{body}
int main(int argc, char **argv) {{
  static const uint8_t spd[8] = {{{", ".join("0x%02X" % b for b in SPEED_EXAMPLE)}}};
  static const uint8_t pos[8] = {{{", ".join("0x%02X" % b for b in POSITION_EXAMPLE)}}};
  (void)argc; (void)argv;
  CAN_ApplySpeedFrame(spd);
  printf("SPEED %u %.6f %.6f %.6f %.6f %.6f %u\\n", mode_set, (double)can_control_target, (double)(spd_ref / RPM_TO_RAD_S),
         (double)control_speed_pi_kp, (double)control_speed_pi_ki, (double)control_speed_pi_kd, (unsigned)can_control_mode);
  CAN_ApplyPositionFrame(pos);
  printf("POSITION %u %.6f %.6f %.6f %.6f %.6f %u\\n", mode_set, (double)can_control_target, (double)pos_ref,
         (double)control_position_kp, (double)control_position_ki, (double)control_position_kd, (unsigned)can_control_mode);
  /* Encoder not ready: SetMode is still called (firmware refuses the switch)
   * but the frame's gains, target, and CAN mode byte are left untouched. */
  enc_ready = 0;
  {{
    const unsigned mode_before = mode_set;
    const float tgt_before = can_control_target;
    const float ref_before = pos_ref;
    const float kp_before = control_position_kp;
    const float ki_before = control_position_ki;
    const float kd_before = control_position_kd;
    const unsigned cmode_before = can_control_mode;
    const unsigned rx_before = can_control_rx_count;
    mode_set = 255;
    CAN_ApplyPositionFrame(pos);
    printf("IGNORE %u %.6f %.6f %.6f %.6f %.6f %u %u %u %.6f\\n",
           mode_set, (double)can_control_target, (double)pos_ref,
           (double)control_position_kp, (double)control_position_ki, (double)control_position_kd,
           (unsigned)can_control_mode, rx_before == can_control_rx_count,
           mode_before, (double)(tgt_before + ref_before + kp_before + ki_before + kd_before + (float)cmode_before));
  }}
  return 0;
}}
"""


def _run():
    cc = shutil.which("cc") or shutil.which("gcc") or shutil.which("clang")
    if not cc:
        return None
    with tempfile.TemporaryDirectory() as d:
        c = os.path.join(d, "frames.c")
        exe = os.path.join(d, "frames.exe" if os.name == "nt" else "frames")
        open(c, "w").write(_harness())
        subprocess.run([cc, "-std=c11", "-Wall", "-Wextra", "-Werror", "-Wno-unused-function",
                        "-I", os.path.join(ROOT, "tests", "stubs"), "-I", os.path.join(ROOT, "Libraries", "App", "inc"),
                        c, "-o", exe, "-lm"], check=True)
        out = subprocess.run([exe], check=True, capture_output=True, text=True).stdout
    return {ln.split()[0]: [float(x) for x in ln.split()[1:]] for ln in out.strip().splitlines()}


def _close(a, b, tol):
    return abs(a - b) <= tol


def test_example_frames_decode_through_firmware_code():
    r = _run()
    if r is None:
        try:
            import pytest
            pytest.skip("no host C compiler")
        except ImportError:
            print("SKIP: no host C compiler")
            return
    lsb_spd, lsb_pos = 2000.0 / 65535, 1000.0 / 65535
    mode, tgt, ref, kp, ki, kd, cmode = r["SPEED"]
    assert mode == 2 and cmode == 2                     # CTRL_MODE_SPEED / CAN_MODE_SPEED
    assert _close(tgt, 100.0, lsb_spd) and _close(ref, 100.0, lsb_spd)
    assert _close(kp, 0.25, 10.0 / 65535) and _close(ki, 0.02, 5.0 / 65535) and kd == 0.0
    mode, tgt, ref, kp, ki, kd, cmode = r["POSITION"]
    assert mode == 3 and cmode == 3                     # CTRL_MODE_POSITION / CAN_MODE_POSITION
    assert _close(tgt, 1.57, lsb_pos / 2 + 1e-4) and _close(ref, tgt, 1e-6)
    assert _close(kp, 3.5, 200.0 / 65535) and _close(ki, 1.2, 100.0 / 65535) and _close(kd, 2.6, 100.0 / 65535)
    mode, tgt2, ref2, kp2, ki2, kd2, cmode, rx_same, _mode_before, _sum = r["IGNORE"]
    assert mode == 3                                  # SetMode(POSITION) asked; firmware no-ops
    assert rx_same == 1 and cmode == 3
    assert tgt2 == tgt and ref2 == ref and kp2 == kp and ki2 == ki and kd2 == kd
    return r


if __name__ == "__main__":
    print(test_example_frames_decode_through_firmware_code())
    print("test_can_speed_pos_frames: passed")
