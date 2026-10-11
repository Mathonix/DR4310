#!/usr/bin/env python3
"""PCAN control tool for the STM32 motor controller.

Protocol:
  RX control ID: 0x100 + node_id
  TX status  ID: 0x180 + node_id
  Discrete commands (data[0]):
    0x00 disable
    0x01 current loop, target is Iq_ref in ampere (float at [2:6])
    0x03 estop
    0x04 set PID: data[1]=param id, float value at [2:6]
    0x06 enter MIT mode (subsequent frames are Cheetah packs)
    0x07 set mode: data[1]=mode id
    0x08 automatic-enable: data[1]=1 on, 0 off
  Speed command ID:  0x400 + node_id
  Position command ID: 0x500 + node_id
    four little-endian uint16 linear maps: target, kp, ki, kd
  MIT streaming (while MIT active): pure 8-byte Cheetah pack
    p_des:16, v_des:12, kp:12, kd:12, iq_ff:12
"""

from __future__ import annotations

import argparse
import struct
import time

try:
    import can
except ImportError as exc:
    raise SystemExit("Install python-can first: python -m pip install python-can") from exc


CMD_DISABLE = 0x00
CMD_CURRENT = 0x01
CMD_SPEED = 0x02
CMD_ESTOP = 0x03
CMD_SET_PID = 0x04
CMD_POSITION = 0x05
CMD_MIT = 0x06
CMD_SET_MODE = 0x07
CMD_SET_AUTO_ENABLE = 0x08

MODE_DISABLED = 0x00
MODE_CURRENT = 0x01
MODE_SPEED = 0x02
MODE_POSITION = 0x03
MODE_MIT = 0x04

PID_CURRENT_KP = 0x01
PID_CURRENT_KI = 0x02
PID_CURRENT_LIMIT = 0x03
PID_POS_KP = 0x04
PID_POS_KD = 0x05
PID_MIT_KP = 0x06
PID_MIT_KD = 0x07
PID_POS_KI = 0x08
PID_POS_ISEP = 0x09

MIT_P_MIN, MIT_P_MAX = -50.0, 50.0
MIT_V_MIN, MIT_V_MAX = -50.0, 50.0
MIT_KP_MIN, MIT_KP_MAX = 0.0, 500.0
MIT_KD_MIN, MIT_KD_MAX = 0.0, 5.0
MIT_T_MIN, MIT_T_MAX = -2.5, 2.5

# Identifier is the command. Ranges match Core/Src/main.c.
SPEED_CMD_BASE = 0x400
POSITION_CMD_BASE = 0x500
SPEED_RPM_MIN, SPEED_RPM_MAX = -1000.0, 1000.0
SPEED_KP_MAX = 10.0
SPEED_KI_MAX = 5.0
SPEED_KD_MAX = 1.0
POSITION_RAD_MIN, POSITION_RAD_MAX = -500.0, 500.0
POSITION_KP_MAX = 200.0
POSITION_KI_MAX = 100.0
POSITION_KD_MAX = 100.0
DEFAULT_SPEED_KP = 0.25
DEFAULT_SPEED_KI = 0.02
DEFAULT_SPEED_KD = 0.0
DEFAULT_POSITION_KP = 3.5
DEFAULT_POSITION_KI = 1.2
DEFAULT_POSITION_KD = 2.6


def float_to_uint(x: float, x_min: float, x_max: float, bits: int) -> int:
    x = min(max(float(x), x_min), x_max)
    span = x_max - x_min
    if span <= 0.0:
        return 0
    max_int = (1 << bits) - 1
    return int(round(max_int * ((x - x_min) / span)))


def uint_to_float(x_int: int, x_min: float, x_max: float, bits: int) -> float:
    max_int = (1 << bits) - 1
    if max_int <= 0:
        return x_min
    return (float(x_int) * (x_max - x_min) / float(max_int)) + x_min


def pack_mit(pos: float, vel: float, kp: float, kd: float, iq_ff: float) -> bytearray:
    """Cheetah-style 8-byte MIT pack (big-endian bit packing)."""
    p = float_to_uint(pos, MIT_P_MIN, MIT_P_MAX, 16)
    v = float_to_uint(vel, MIT_V_MIN, MIT_V_MAX, 12)
    kp_i = float_to_uint(kp, MIT_KP_MIN, MIT_KP_MAX, 12)
    kd_i = float_to_uint(kd, MIT_KD_MIN, MIT_KD_MAX, 12)
    t = float_to_uint(iq_ff, MIT_T_MIN, MIT_T_MAX, 12)

    data = bytearray(8)
    data[0] = (p >> 8) & 0xFF
    data[1] = p & 0xFF
    data[2] = (v >> 4) & 0xFF
    data[3] = ((v & 0x0F) << 4) | ((kp_i >> 8) & 0x0F)
    data[4] = kp_i & 0xFF
    data[5] = (kd_i >> 4) & 0xFF
    data[6] = ((kd_i & 0x0F) << 4) | ((t >> 8) & 0x0F)
    data[7] = t & 0xFF
    return data


def unpack_mit(data: bytes | bytearray) -> tuple[float, float, float, float, float]:
    p = (data[0] << 8) | data[1]
    v = (data[2] << 4) | (data[3] >> 4)
    kp = ((data[3] & 0x0F) << 8) | data[4]
    kd = (data[5] << 4) | (data[6] >> 4)
    t = ((data[6] & 0x0F) << 8) | data[7]
    return (
        uint_to_float(p, MIT_P_MIN, MIT_P_MAX, 16),
        uint_to_float(v, MIT_V_MIN, MIT_V_MAX, 12),
        uint_to_float(kp, MIT_KP_MIN, MIT_KP_MAX, 12),
        uint_to_float(kd, MIT_KD_MIN, MIT_KD_MAX, 12),
        uint_to_float(t, MIT_T_MIN, MIT_T_MAX, 12),
    )


def make_bus(channel: str, bitrate: int) -> can.BusABC:
    return can.interface.Bus(interface="pcan", channel=channel, bitrate=bitrate)


def control_id(node_id: int) -> int:
    return 0x100 + (node_id & 0x7F)


def status_id(node_id: int) -> int:
    return 0x180 + (node_id & 0x7F)


def _pack_u16_maps(fields: list[tuple[float, float, float]]) -> bytearray:
    raw = [float_to_uint(value, low, high, 16) for value, low, high in fields]
    return bytearray(struct.pack("<HHHH", *raw))


def _unpack_u16_maps(data: bytes | bytearray, fields: list[tuple[float, float]]) -> tuple[float, ...]:
    raw = struct.unpack_from("<HHHH", bytes(data), 0)
    return tuple(uint_to_float(value, low, high, 16) for value, (low, high) in zip(raw, fields))


def pack_speed(rpm: float, kp: float, ki: float, kd: float) -> bytearray:
    return _pack_u16_maps([
        (rpm, SPEED_RPM_MIN, SPEED_RPM_MAX),
        (kp, 0.0, SPEED_KP_MAX),
        (ki, 0.0, SPEED_KI_MAX),
        (kd, 0.0, SPEED_KD_MAX),
    ])


def unpack_speed(data: bytes | bytearray) -> tuple[float, float, float, float]:
    return _unpack_u16_maps(data, [
        (SPEED_RPM_MIN, SPEED_RPM_MAX),
        (0.0, SPEED_KP_MAX),
        (0.0, SPEED_KI_MAX),
        (0.0, SPEED_KD_MAX),
    ])


def pack_position(radians: float, kp: float, ki: float, kd: float) -> bytearray:
    return _pack_u16_maps([
        (radians, POSITION_RAD_MIN, POSITION_RAD_MAX),
        (kp, 0.0, POSITION_KP_MAX),
        (ki, 0.0, POSITION_KI_MAX),
        (kd, 0.0, POSITION_KD_MAX),
    ])


def unpack_position(data: bytes | bytearray) -> tuple[float, float, float, float]:
    return _unpack_u16_maps(data, [
        (POSITION_RAD_MIN, POSITION_RAD_MAX),
        (0.0, POSITION_KP_MAX),
        (0.0, POSITION_KI_MAX),
        (0.0, POSITION_KD_MAX),
    ])


def speed_command_id(node_id: int) -> int:
    return SPEED_CMD_BASE + (node_id & 0x7F)


def position_command_id(node_id: int) -> int:
    return POSITION_CMD_BASE + (node_id & 0x7F)


def send_speed(bus: can.BusABC, node_id: int, rpm: float,
               kp: float = DEFAULT_SPEED_KP, ki: float = DEFAULT_SPEED_KI,
               kd: float = DEFAULT_SPEED_KD) -> None:
    bus.send(can.Message(
        arbitration_id=speed_command_id(node_id),
        is_extended_id=False,
        data=pack_speed(rpm, kp, ki, kd),
    ))


def send_position(bus: can.BusABC, node_id: int, radians: float,
                  kp: float = DEFAULT_POSITION_KP, ki: float = DEFAULT_POSITION_KI,
                  kd: float = DEFAULT_POSITION_KD) -> None:
    bus.send(can.Message(
        arbitration_id=position_command_id(node_id),
        is_extended_id=False,
        data=pack_position(radians, kp, ki, kd),
    ))


def send_command(bus: can.BusABC, node_id: int, command: int, target: float = 0.0, param: int = 0) -> None:
    data = bytearray(8)
    data[0] = command & 0xFF
    data[1] = param & 0xFF
    data[2:6] = struct.pack("<f", float(target))
    bus.send(can.Message(arbitration_id=control_id(node_id), is_extended_id=False, data=data))


def send_mit(bus: can.BusABC, node_id: int, pos: float, vel: float, kp: float, kd: float, iq_ff: float) -> None:
    """Enter MIT if needed is caller's job; this sends a pure Cheetah pack."""
    data = pack_mit(pos, vel, kp, kd, iq_ff)
    bus.send(can.Message(arbitration_id=control_id(node_id), is_extended_id=False, data=data))


def decode_status(message: can.Message, node_id: int) -> str | None:
    if message.arbitration_id != status_id(node_id) or len(message.data) < 8:
        return None

    mode = message.data[0]
    fault = message.data[1]
    feedback = struct.unpack("<f", bytes(message.data[2:6]))[0]
    reported_id = message.data[6]
    counter = message.data[7]
    mode_name = {
        MODE_DISABLED: "disabled",
        MODE_CURRENT: "current",
        MODE_SPEED: "speed",
        MODE_POSITION: "position",
        MODE_MIT: "mit",
    }.get(mode, f"unknown({mode})")
    unit = {
        MODE_CURRENT: "A",
        MODE_SPEED: "rpm",
        MODE_POSITION: "rad",
        MODE_MIT: "rad",
    }.get(mode, "V")
    return (
        f"mode={mode_name} fault=0x{fault:02X} feedback={feedback:.4f}{unit} "
        f"id={reported_id} count={counter}"
    )


def monitor(bus: can.BusABC, node_id: int, duration_s: float | None) -> None:
    deadline = None if duration_s is None else time.monotonic() + duration_s
    while deadline is None or time.monotonic() < deadline:
        message = bus.recv(timeout=0.5)
        if message is None:
            continue
        decoded = decode_status(message, node_id)
        if decoded is not None:
            print(decoded)


def main() -> None:
    parser = argparse.ArgumentParser(description="Control STM32 motor loops over PCAN.")
    parser.add_argument("--channel", default="PCAN_USBBUS1")
    parser.add_argument("--bitrate", type=int, default=1_000_000)
    parser.add_argument("--id", type=int, default=2, dest="node_id")

    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("disable")
    sub.add_parser("estop")

    current = sub.add_parser("current")
    current.add_argument("amps", type=float)

    speed = sub.add_parser("speed")
    speed.add_argument("rpm", type=float)
    speed.add_argument("kp", type=float, nargs="?", default=DEFAULT_SPEED_KP)
    speed.add_argument("ki", type=float, nargs="?", default=DEFAULT_SPEED_KI)
    speed.add_argument("kd", type=float, nargs="?", default=DEFAULT_SPEED_KD)

    position = sub.add_parser("position")
    position.add_argument("rad", type=float)
    position.add_argument("kp", type=float, nargs="?", default=DEFAULT_POSITION_KP)
    position.add_argument("ki", type=float, nargs="?", default=DEFAULT_POSITION_KI)
    position.add_argument("kd", type=float, nargs="?", default=DEFAULT_POSITION_KD)

    mit_enter = sub.add_parser("mit-enter", help="Enter MIT mode (then stream packs with mit)")
    mit = sub.add_parser("mit", help="Enter MIT and send one Cheetah pack")
    mit.add_argument("pos", type=float)
    mit.add_argument("vel", type=float)
    mit.add_argument("kp", type=float)
    mit.add_argument("kd", type=float)
    mit.add_argument("iq_ff", type=float)

    set_mode = sub.add_parser("set-mode")
    set_mode.add_argument("mode", choices=["idle", "current", "speed", "position", "mit"])

    auto_enable = sub.add_parser("auto-enable")
    auto_enable.add_argument("state", choices=["on", "off"])

    set_pid = sub.add_parser("set-pid")
    set_pid.add_argument(
        "param",
        choices=[
            "current-kp",
            "current-ki",
            "current-limit",
            "pos-kp",
            "pos-kd",
            "pos-ki",
            "pos-isep",
            "mit-kp",
            "mit-kd",
        ],
    )
    set_pid.add_argument("value", type=float)

    mon = sub.add_parser("monitor")
    mon.add_argument("--seconds", type=float, default=None)

    args = parser.parse_args()

    mode_map = {
        "idle": MODE_DISABLED,
        "current": MODE_CURRENT,
        "speed": MODE_SPEED,
        "position": MODE_POSITION,
        "mit": MODE_MIT,
    }
    pid_map = {
        "current-kp": PID_CURRENT_KP,
        "current-ki": PID_CURRENT_KI,
        "current-limit": PID_CURRENT_LIMIT,
        "pos-kp": PID_POS_KP,
        "pos-kd": PID_POS_KD,
        "pos-ki": PID_POS_KI,
        "pos-isep": PID_POS_ISEP,
        "mit-kp": PID_MIT_KP,
        "mit-kd": PID_MIT_KD,
    }

    with make_bus(args.channel, args.bitrate) as bus:
        if args.command == "disable":
            send_command(bus, args.node_id, CMD_DISABLE)
        elif args.command == "estop":
            send_command(bus, args.node_id, CMD_ESTOP)
        elif args.command == "current":
            send_command(bus, args.node_id, CMD_CURRENT, args.amps)
        elif args.command == "speed":
            send_speed(bus, args.node_id, args.rpm, args.kp, args.ki, args.kd)
        elif args.command == "position":
            send_position(bus, args.node_id, args.rad, args.kp, args.ki, args.kd)
        elif args.command == "mit-enter":
            send_command(bus, args.node_id, CMD_MIT)
        elif args.command == "mit":
            # Enter MIT, then stream one packed command.
            send_command(bus, args.node_id, CMD_MIT)
            time.sleep(0.02)
            send_mit(bus, args.node_id, args.pos, args.vel, args.kp, args.kd, args.iq_ff)
        elif args.command == "set-mode":
            send_command(bus, args.node_id, CMD_SET_MODE, 0.0, mode_map[args.mode])
        elif args.command == "auto-enable":
            send_command(bus, args.node_id, CMD_SET_AUTO_ENABLE, 0.0,
                         1 if args.state == "on" else 0)
        elif args.command == "set-pid":
            send_command(bus, args.node_id, CMD_SET_PID, args.value, pid_map[args.param])
        elif args.command == "monitor":
            monitor(bus, args.node_id, args.seconds)


if __name__ == "__main__":
    main()
