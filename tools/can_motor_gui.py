#!/usr/bin/env python3
"""FOC Motor Host GUI — modern dark UI with always-on speed feedback.

Status frame (0x180+id):
  [0] mode
  [1] fault
  [2:6] float primary feedback (Iq / rpm / pos / Vbus)
  [6:8] int16 LE  speed_rpm * 10   (always present)
"""

from __future__ import annotations

import math
import queue
import struct
import threading
import time
import tkinter as tk
from collections import deque
from dataclasses import dataclass
from tkinter import messagebox, ttk

try:
    import can
except ImportError:  # pragma: no cover
    can = None

# ---- protocol ----
CMD_DISABLE = 0x00
CMD_CURRENT = 0x01
CMD_SPEED = 0x02
CMD_ESTOP = 0x03
CMD_SET_PID = 0x04
CMD_POSITION = 0x05
CMD_MIT = 0x06
CMD_SET_MODE = 0x07

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

DEFAULT_CHANNEL = "PCAN_USBBUS1"
DEFAULT_BITRATE = 1_000_000
DEFAULT_NODE_ID = 2

MODE_NAMES = {
    MODE_DISABLED: "IDLE",
    MODE_CURRENT: "CURRENT",
    MODE_SPEED: "SPEED",
    MODE_POSITION: "POSITION",
    MODE_MIT: "MIT",
}
MODE_UNITS = {
    MODE_DISABLED: "V",
    MODE_CURRENT: "A",
    MODE_SPEED: "rpm",
    MODE_POSITION: "rad",
    MODE_MIT: "rad",
}
MODE_COLORS = {
    MODE_DISABLED: "#64748b",
    MODE_CURRENT: "#38bdf8",
    MODE_SPEED: "#34d399",
    MODE_POSITION: "#a78bfa",
    MODE_MIT: "#fbbf24",
}

# Dark palette
BG = "#0b1220"
PANEL = "#111827"
CARD = "#1f2937"
CARD2 = "#162033"
TEXT = "#e5e7eb"
MUTED = "#94a3b8"
ACCENT = "#22d3ee"
GREEN = "#34d399"
RED = "#f87171"
ORANGE = "#fb923c"
LINE = "#334155"


@dataclass(frozen=True)
class StatusFrame:
    mode: int
    mode_name: str
    fault: int
    feedback: float
    unit: str
    speed_rpm: float
    timestamp: float


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


def build_command_frame(node_id: int, command: int, target: float = 0.0, param: int = 0) -> tuple[int, bytearray]:
    arbitration_id = 0x100 + (node_id & 0x7F)
    data = bytearray(8)
    data[0] = command & 0xFF
    data[1] = param & 0xFF
    data[2:6] = struct.pack("<f", float(target))
    return arbitration_id, data


def build_pid_command_frame(node_id: int, parameter: int, value: float) -> tuple[int, bytearray]:
    return build_command_frame(node_id, CMD_SET_PID, value, parameter)


def build_mit_frame(node_id: int, pos: float, vel: float, kp: float, kd: float, iq_ff: float) -> tuple[int, bytearray]:
    return 0x100 + (node_id & 0x7F), pack_mit(pos, vel, kp, kd, iq_ff)


def decode_status_frame(
    arbitration_id: int,
    data: bytes | bytearray,
    node_id: int,
    timestamp: float | None = None,
) -> StatusFrame | None:
    if arbitration_id != 0x180 + (node_id & 0x7F) or len(data) < 8:
        return None
    mode = data[0]
    fault = data[1]
    feedback = struct.unpack("<f", bytes(data[2:6]))[0]
    # New firmware: int16 LE rpm*10 in bytes 6-7.
    # Old firmware put node_id/counter there (tiny unsigned). Heuristic:
    speed_raw = struct.unpack("<h", bytes(data[6:8]))[0]
    if mode == MODE_SPEED:
        speed_rpm = feedback
    else:
        speed_rpm = speed_raw / 10.0
    return StatusFrame(
        mode=mode,
        mode_name=MODE_NAMES.get(mode, f"UNK({mode})"),
        fault=fault,
        feedback=feedback,
        unit=MODE_UNITS.get(mode, "?"),
        speed_rpm=speed_rpm,
        timestamp=time.time() if timestamp is None else timestamp,
    )


class PcanWorker:
    def __init__(self, event_queue: queue.Queue):
        self._queue = event_queue
        self._bus = None
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        self._mit_active = False

    @property
    def connected(self) -> bool:
        return self._bus is not None

    def start(self, channel: str, bitrate: int, node_id: int) -> None:
        if can is None:
            raise RuntimeError("python-can is not installed (pip install python-can)")
        if self._bus is not None:
            return
        self._stop_event.clear()
        self._bus = can.interface.Bus(interface="pcan", channel=channel, bitrate=bitrate)
        self._thread = threading.Thread(target=self._read_loop, args=(node_id,), daemon=True, name="pcan-rx")
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
            self._thread = None
        if self._bus is not None:
            with self._lock:
                self._bus.shutdown()
                self._bus = None
        self._mit_active = False

    def status_text(self) -> str:
        if self._bus is None:
            return "disconnected"
        try:
            return self._bus.status_string()
        except Exception as exc:
            return f"status error: {exc}"

    def send(self, node_id: int, command: int, target: float = 0.0, param: int = 0) -> None:
        if self._bus is None:
            raise RuntimeError("PCAN is not connected")
        arbitration_id, data = build_command_frame(node_id, command, target, param)
        msg = can.Message(arbitration_id=arbitration_id, is_extended_id=False, data=data)
        with self._lock:
            self._bus.send(msg, timeout=1.0)
        if command in (CMD_DISABLE, CMD_ESTOP):
            self._mit_active = False
        elif command == CMD_MIT:
            self._mit_active = True
        elif command == CMD_SET_MODE:
            self._mit_active = param == MODE_MIT
        elif command in (CMD_CURRENT, CMD_SPEED, CMD_POSITION):
            self._mit_active = False

    def send_pid(self, node_id: int, parameter: int, value: float) -> None:
        if self._bus is None:
            raise RuntimeError("PCAN is not connected")
        arbitration_id, data = build_pid_command_frame(node_id, parameter, value)
        msg = can.Message(arbitration_id=arbitration_id, is_extended_id=False, data=data)
        with self._lock:
            self._bus.send(msg, timeout=1.0)

    def send_mit(self, node_id: int, pos: float, vel: float, kp: float, kd: float, iq_ff: float) -> None:
        if self._bus is None:
            raise RuntimeError("PCAN is not connected")
        if not self._mit_active:
            self.send(node_id, CMD_MIT)
            time.sleep(0.02)
        arbitration_id, data = build_mit_frame(node_id, pos, vel, kp, kd, iq_ff)
        msg = can.Message(arbitration_id=arbitration_id, is_extended_id=False, data=data)
        with self._lock:
            self._bus.send(msg, timeout=1.0)
        self._mit_active = True

    def _read_loop(self, node_id: int) -> None:
        while not self._stop_event.is_set():
            try:
                message = self._bus.recv(timeout=0.1)
            except Exception as exc:
                self._queue.put(("error", str(exc)))
                time.sleep(0.2)
                continue
            if message is None:
                continue
            status = decode_status_frame(
                message.arbitration_id,
                message.data,
                node_id,
                getattr(message, "timestamp", None),
            )
            if status is not None:
                self._queue.put(("status", status))


class Sparkline(tk.Canvas):
    """Simple live sparkline for speed history."""

    def __init__(self, master, width=320, height=72, **kw):
        super().__init__(master, width=width, height=height, bg=CARD2, highlightthickness=0, **kw)
        # Do NOT name attrs _w/_h — Tk uses self._w as the widget path.
        self._plot_w = int(width)
        self._plot_h = int(height)
        self._data: deque[float] = deque(maxlen=120)
        self._draw_grid()

    def _draw_grid(self) -> None:
        self.delete("all")
        for i in range(1, 4):
            y = int(self._plot_h * i / 4)
            self.create_line(0, y, self._plot_w, y, fill=LINE, width=1)
        self.create_text(8, 10, text="rpm", fill=MUTED, anchor="w", font=("Segoe UI", 8))

    def push(self, value: float) -> None:
        self._data.append(float(value))
        self._redraw()

    def _redraw(self) -> None:
        self._draw_grid()
        if len(self._data) < 2:
            return
        vals = list(self._data)
        vmin = min(vals)
        vmax = max(vals)
        if abs(vmax - vmin) < 1e-3:
            vmax = vmin + 1.0
            vmin = vmin - 1.0
        pad = (vmax - vmin) * 0.1
        vmax += pad
        vmin -= pad
        n = len(vals)
        pts = []
        for i, v in enumerate(vals):
            x = i * (self._plot_w - 4) / max(1, n - 1) + 2
            y = self._plot_h - 4 - (v - vmin) * (self._plot_h - 10) / (vmax - vmin)
            pts.extend([x, y])
        self.create_line(*pts, fill=ACCENT, width=2, smooth=True)
        self.create_oval(pts[-2] - 3, pts[-1] - 3, pts[-2] + 3, pts[-1] + 3, fill=GREEN, outline="")


class MetricCard(tk.Frame):
    def __init__(self, master, title: str, unit: str = "", accent: str = ACCENT, **kw):
        super().__init__(master, bg=CARD, highlightbackground=LINE, highlightthickness=1, **kw)
        self._accent = accent
        tk.Label(self, text=title.upper(), bg=CARD, fg=MUTED, font=("Segoe UI", 9, "bold")).pack(
            anchor="w", padx=12, pady=(10, 0)
        )
        row = tk.Frame(self, bg=CARD)
        row.pack(fill=tk.X, padx=12, pady=(2, 10))
        self.value_lbl = tk.Label(row, text="—", bg=CARD, fg=TEXT, font=("Segoe UI Semibold", 28))
        self.value_lbl.pack(side=tk.LEFT)
        self.unit_lbl = tk.Label(row, text=unit, bg=CARD, fg=MUTED, font=("Segoe UI", 12))
        self.unit_lbl.pack(side=tk.LEFT, padx=(8, 0), pady=(10, 0))
        self.sub_lbl = tk.Label(self, text="", bg=CARD, fg=MUTED, font=("Segoe UI", 9))
        self.sub_lbl.pack(anchor="w", padx=12, pady=(0, 10))

    def set(self, value: str, sub: str = "", color: str | None = None) -> None:
        self.value_lbl.configure(text=value, fg=color or TEXT)
        self.sub_lbl.configure(text=sub)


class MotorControlApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("FOC Motor Host")
        self.geometry("1120x860")
        self.minsize(1000, 780)
        self.configure(bg=BG)

        self._events: queue.Queue = queue.Queue()
        self._worker = PcanWorker(self._events)
        self._last_status_time = 0.0
        self._active_mode = MODE_DISABLED
        self._mode_buttons: dict[int, tk.Button] = {}

        # vars
        self.channel_var = tk.StringVar(value=DEFAULT_CHANNEL)
        self.bitrate_var = tk.StringVar(value=str(DEFAULT_BITRATE))
        self.node_id_var = tk.StringVar(value=str(DEFAULT_NODE_ID))
        self.conn_var = tk.StringVar(value="DISCONNECTED")
        self.pcan_var = tk.StringVar(value="-")

        self.current_target_var = tk.StringVar(value="0.15")
        self.speed_target_var = tk.StringVar(value="40")
        self.position_target_var = tk.StringVar(value="0.0")
        self.mit_pos_var = tk.StringVar(value="0.0")
        self.mit_vel_var = tk.StringVar(value="0.0")
        self.mit_iq_var = tk.StringVar(value="0.0")

        self.i_kp_var = tk.StringVar(value="12.0")
        self.i_ki_var = tk.StringVar(value="1500.0")
        self.i_lim_var = tk.StringVar(value="0.0")
        self.pos_kp_var = tk.StringVar(value="3.5")
        self.pos_ki_var = tk.StringVar(value="1.2")
        self.pos_kd_var = tk.StringVar(value="2.6")
        self.pos_isep_var = tk.StringVar(value="0.35")
        self.mit_kp_var = tk.StringVar(value="10.0")
        self.mit_kd_var = tk.StringVar(value="0.5")

        self._setup_style()
        self._build_ui()
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.after(80, self._poll_events)
        self.after(350, self._auto_connect)

    def _setup_style(self) -> None:
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except Exception:
            pass
        style.configure(".", background=BG, foreground=TEXT, fieldbackground=CARD, bordercolor=LINE)
        style.configure("TFrame", background=BG)
        style.configure("TLabel", background=BG, foreground=TEXT, font=("Segoe UI", 10))
        style.configure("TLabelframe", background=PANEL, foreground=TEXT, bordercolor=LINE)
        style.configure("TLabelframe.Label", background=PANEL, foreground=MUTED, font=("Segoe UI", 9, "bold"))
        style.configure("TEntry", fieldbackground=CARD, foreground=TEXT, insertcolor=TEXT)
        style.configure("TNotebook", background=PANEL, borderwidth=0)
        style.configure("TNotebook.Tab", background=CARD, foreground=MUTED, padding=(12, 6))
        style.map("TNotebook.Tab", background=[("selected", CARD2)], foreground=[("selected", ACCENT)])
        style.configure("Accent.TButton", background=ACCENT, foreground="#041016", font=("Segoe UI", 10, "bold"))
        style.map("Accent.TButton", background=[("active", "#67e8f9")])
        style.configure("Ghost.TButton", background=CARD, foreground=TEXT)
        style.map("Ghost.TButton", background=[("active", CARD2)])
        style.configure("Danger.TButton", background="#7f1d1d", foreground=TEXT)
        style.map("Danger.TButton", background=[("active", "#991b1b")])

    def _card(self, parent, **kw) -> tk.Frame:
        f = tk.Frame(parent, bg=PANEL, highlightbackground=LINE, highlightthickness=1, **kw)
        return f

    def _build_ui(self) -> None:
        root = tk.Frame(self, bg=BG)
        root.pack(fill=tk.BOTH, expand=True, padx=14, pady=14)
        root.columnconfigure(0, weight=3)
        root.columnconfigure(1, weight=2)
        root.rowconfigure(2, weight=1)

        # Header
        header = self._card(root)
        header.grid(row=0, column=0, columnspan=2, sticky="ew", pady=(0, 12))
        header.columnconfigure(1, weight=1)
        tk.Label(header, text="FOC MOTOR HOST", bg=PANEL, fg=TEXT, font=("Segoe UI Semibold", 16)).grid(
            row=0, column=0, sticky="w", padx=14, pady=12
        )
        self.conn_dot = tk.Canvas(header, width=12, height=12, bg=PANEL, highlightthickness=0)
        self.conn_dot.grid(row=0, column=1, sticky="e", padx=(0, 6))
        self._set_dot(False)
        tk.Label(header, textvariable=self.conn_var, bg=PANEL, fg=MUTED, font=("Segoe UI", 10, "bold")).grid(
            row=0, column=2, sticky="e", padx=(0, 8)
        )
        tk.Label(header, textvariable=self.pcan_var, bg=PANEL, fg=MUTED, font=("Segoe UI", 9)).grid(
            row=0, column=3, sticky="e", padx=(0, 14)
        )

        # Connection strip
        conn = self._card(root)
        conn.grid(row=1, column=0, columnspan=2, sticky="ew", pady=(0, 12))
        for i, (lab, var, w) in enumerate((
            ("Channel", self.channel_var, 16),
            ("Bitrate", self.bitrate_var, 10),
            ("Node", self.node_id_var, 6),
        )):
            tk.Label(conn, text=lab, bg=PANEL, fg=MUTED, font=("Segoe UI", 9)).grid(row=0, column=i * 2, padx=(12, 4), pady=10, sticky="w")
            e = tk.Entry(conn, textvariable=var, width=w, bg=CARD, fg=TEXT, insertbackground=TEXT, relief="flat",
                         highlightthickness=1, highlightbackground=LINE, highlightcolor=ACCENT)
            e.grid(row=0, column=i * 2 + 1, padx=4, pady=10, sticky="w")
        ttk.Button(conn, text="Connect", style="Accent.TButton", command=self._connect).grid(row=0, column=6, padx=8)
        ttk.Button(conn, text="Disconnect", style="Ghost.TButton", command=self._disconnect).grid(row=0, column=7, padx=(0, 12))

        # Left: telemetry + sparkline
        left = tk.Frame(root, bg=BG)
        left.grid(row=2, column=0, sticky="nsew", padx=(0, 8))
        left.columnconfigure(0, weight=1)
        left.columnconfigure(1, weight=1)
        left.columnconfigure(2, weight=1)

        self.speed_card = MetricCard(left, "Speed", "rpm", accent=GREEN)
        self.speed_card.grid(row=0, column=0, sticky="ew", padx=(0, 6), pady=(0, 8))
        self.primary_card = MetricCard(left, "Primary", "", accent=ACCENT)
        self.primary_card.grid(row=0, column=1, sticky="ew", padx=3, pady=(0, 8))
        self.mode_card = MetricCard(left, "Mode", "", accent=ORANGE)
        self.mode_card.grid(row=0, column=2, sticky="ew", padx=(6, 0), pady=(0, 8))

        spark_panel = self._card(left)
        spark_panel.grid(row=1, column=0, columnspan=3, sticky="ew", pady=(0, 8))
        tk.Label(spark_panel, text="SPEED TREND", bg=PANEL, fg=MUTED, font=("Segoe UI", 9, "bold")).pack(
            anchor="w", padx=12, pady=(10, 4)
        )
        self.spark = Sparkline(spark_panel, width=620, height=90)
        self.spark.pack(fill=tk.X, padx=12, pady=(0, 12))

        # Mode buttons
        mode_panel = self._card(left)
        mode_panel.grid(row=2, column=0, columnspan=3, sticky="ew", pady=(0, 8))
        tk.Label(mode_panel, text="MODE", bg=PANEL, fg=MUTED, font=("Segoe UI", 9, "bold")).pack(
            anchor="w", padx=12, pady=(10, 6)
        )
        btn_row = tk.Frame(mode_panel, bg=PANEL)
        btn_row.pack(fill=tk.X, padx=10, pady=(0, 10))
        for mode, text in (
            (MODE_DISABLED, "IDLE"),
            (MODE_CURRENT, "CURRENT"),
            (MODE_SPEED, "SPEED"),
            (MODE_POSITION, "POSITION"),
            (MODE_MIT, "MIT"),
        ):
            b = tk.Button(
                btn_row,
                text=text,
                bg=CARD,
                fg=TEXT,
                activebackground=CARD2,
                activeforeground=TEXT,
                relief="flat",
                bd=0,
                padx=12,
                pady=8,
                font=("Segoe UI", 9, "bold"),
                command=(self._send_disable if mode == MODE_DISABLED else (lambda m=mode: self._set_mode(m))),
            )
            b.pack(side=tk.LEFT, expand=True, fill=tk.X, padx=3)
            self._mode_buttons[mode] = b
        estop = tk.Button(
            mode_panel,
            text="E-STOP",
            bg="#7f1d1d",
            fg=TEXT,
            activebackground="#991b1b",
            relief="flat",
            font=("Segoe UI", 10, "bold"),
            command=self._send_estop,
            pady=8,
        )
        estop.pack(fill=tk.X, padx=12, pady=(0, 12))

        # Fault / link
        meta = self._card(left)
        meta.grid(row=3, column=0, columnspan=3, sticky="ew")
        self.fault_lbl = tk.Label(meta, text="FAULT  0x00", bg=PANEL, fg=GREEN, font=("Segoe UI", 10, "bold"))
        self.fault_lbl.pack(side=tk.LEFT, padx=12, pady=10)
        self.rx_lbl = tk.Label(meta, text="RX —", bg=PANEL, fg=MUTED, font=("Segoe UI", 9))
        self.rx_lbl.pack(side=tk.RIGHT, padx=12)

        # Right: targets + PID
        right = tk.Frame(root, bg=BG)
        right.grid(row=2, column=1, sticky="nsew", padx=(8, 0))
        right.columnconfigure(0, weight=1)
        right.rowconfigure(2, weight=1)

        tgt = self._card(right)
        tgt.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        tk.Label(tgt, text="TARGETS", bg=PANEL, fg=MUTED, font=("Segoe UI", 9, "bold")).grid(
            row=0, column=0, columnspan=3, sticky="w", padx=12, pady=(10, 6)
        )
        self._entry_row(tgt, 1, "Iq (A)", self.current_target_var, "Send", self._send_current)
        self._entry_row(tgt, 2, "Speed (rpm)", self.speed_target_var, "Send", self._send_speed)
        self._entry_row(tgt, 3, "Pos (rad)", self.position_target_var, "Send", self._send_position)

        mit = self._card(right)
        mit.grid(row=1, column=0, sticky="ew", pady=(0, 8))
        tk.Label(mit, text="MIT PACK", bg=PANEL, fg=MUTED, font=("Segoe UI", 9, "bold")).grid(
            row=0, column=0, columnspan=6, sticky="w", padx=12, pady=(10, 6)
        )
        for col, (lab, var) in enumerate((
            ("pos", self.mit_pos_var),
            ("vel", self.mit_vel_var),
            ("iq_ff", self.mit_iq_var),
        )):
            tk.Label(mit, text=lab, bg=PANEL, fg=MUTED, font=("Segoe UI", 8)).grid(row=1, column=col * 2, padx=(12 if col == 0 else 4, 2), sticky="w")
            e = tk.Entry(mit, textvariable=var, width=8, bg=CARD, fg=TEXT, insertbackground=TEXT, relief="flat",
                         highlightthickness=1, highlightbackground=LINE, highlightcolor=ACCENT)
            e.grid(row=1, column=col * 2 + 1, padx=2, pady=4, sticky="ew")
        ttk.Button(mit, text="Send MIT", style="Accent.TButton", command=self._send_mit).grid(
            row=1, column=6, padx=12, pady=8
        )

        pid = self._card(right)
        pid.grid(row=2, column=0, sticky="nsew")
        tk.Label(pid, text="PID TUNING", bg=PANEL, fg=MUTED, font=("Segoe UI", 9, "bold")).pack(
            anchor="w", padx=12, pady=(10, 4)
        )
        nb_host = tk.Frame(pid, bg=PANEL)
        nb_host.pack(fill=tk.BOTH, expand=True, padx=8, pady=(0, 8))
        nb = ttk.Notebook(nb_host)
        nb.pack(fill=tk.BOTH, expand=True)

        tab_i = tk.Frame(nb, bg=PANEL)
        nb.add(tab_i, text="Current")
        self._pid_grid(tab_i, [
            ("Kp", self.i_kp_var),
            ("Ki", self.i_ki_var),
            ("Vlim", self.i_lim_var),
        ], self._apply_current_pi, "Apply Current PI")

        tab_p = tk.Frame(nb, bg=PANEL)
        nb.add(tab_p, text="Position")
        self._pid_grid(tab_p, [
            ("Kp", self.pos_kp_var),
            ("Ki", self.pos_ki_var),
            ("Kd", self.pos_kd_var),
            ("I-sep", self.pos_isep_var),
        ], self._apply_pos_pid, "Apply Position PID")

        tab_m = tk.Frame(nb, bg=PANEL)
        nb.add(tab_m, text="MIT")
        self._pid_grid(tab_m, [
            ("Kp", self.mit_kp_var),
            ("Kd", self.mit_kd_var),
        ], self._apply_mit_pd, "Apply MIT Kp/Kd")

        # Log
        log_panel = self._card(root)
        log_panel.grid(row=3, column=0, columnspan=2, sticky="nsew", pady=(12, 0))
        root.rowconfigure(3, weight=1)
        tk.Label(log_panel, text="LOG", bg=PANEL, fg=MUTED, font=("Segoe UI", 9, "bold")).pack(
            anchor="w", padx=12, pady=(8, 2)
        )
        self.log = tk.Text(
            log_panel,
            height=7,
            bg=CARD2,
            fg=TEXT,
            insertbackground=TEXT,
            relief="flat",
            font=("Consolas", 9),
            wrap="word",
        )
        self.log.pack(fill=tk.BOTH, expand=True, padx=10, pady=(0, 10))

    def _entry_row(self, parent, row, label, var, btn_text, cmd) -> None:
        tk.Label(parent, text=label, bg=PANEL, fg=MUTED, font=("Segoe UI", 9)).grid(
            row=row, column=0, sticky="w", padx=12, pady=4
        )
        e = tk.Entry(parent, textvariable=var, width=12, bg=CARD, fg=TEXT, insertbackground=TEXT, relief="flat",
                     highlightthickness=1, highlightbackground=LINE, highlightcolor=ACCENT)
        e.grid(row=row, column=1, sticky="ew", padx=4, pady=4)
        parent.columnconfigure(1, weight=1)
        ttk.Button(parent, text=btn_text, style="Ghost.TButton", command=cmd).grid(row=row, column=2, padx=12, pady=4)

    def _pid_grid(self, parent, fields, apply_cmd, apply_label) -> None:
        grid = tk.Frame(parent, bg=PANEL)
        grid.pack(fill=tk.X, padx=8, pady=8)
        for i, (lab, var) in enumerate(fields):
            tk.Label(grid, text=lab, bg=PANEL, fg=MUTED, font=("Segoe UI", 9)).grid(row=0, column=i * 2, padx=(0, 4), sticky="w")
            e = tk.Entry(grid, textvariable=var, width=8, bg=CARD, fg=TEXT, insertbackground=TEXT, relief="flat",
                         highlightthickness=1, highlightbackground=LINE, highlightcolor=ACCENT)
            e.grid(row=0, column=i * 2 + 1, padx=(0, 10), sticky="ew")
            grid.columnconfigure(i * 2 + 1, weight=1)
        ttk.Button(parent, text=apply_label, style="Accent.TButton", command=apply_cmd).pack(
            fill=tk.X, padx=8, pady=(0, 8)
        )

    def _set_dot(self, ok: bool) -> None:
        self.conn_dot.delete("all")
        color = GREEN if ok else RED
        self.conn_dot.create_oval(1, 1, 11, 11, fill=color, outline="")

    def _highlight_mode(self, mode: int) -> None:
        for m, btn in self._mode_buttons.items():
            if m == mode:
                btn.configure(bg=MODE_COLORS.get(m, ACCENT), fg="#041016")
            else:
                btn.configure(bg=CARD, fg=TEXT)

    # ---- connection ----
    def _auto_connect(self) -> None:
        self._connect()

    def _connect(self) -> None:
        try:
            node_id = self._node_id()
            bitrate = int(self.bitrate_var.get())
            self._worker.start(self.channel_var.get().strip(), bitrate, node_id)
        except Exception as exc:
            self.conn_var.set("DISCONNECTED")
            self._set_dot(False)
            self._append_log(f"Connect failed: {exc}")
            messagebox.showerror("PCAN connect failed", str(exc))
            return
        self.conn_var.set("CONNECTED")
        self._set_dot(True)
        self.pcan_var.set(self._worker.status_text())
        self._append_log("Connected")

    def _disconnect(self) -> None:
        self._worker.stop()
        self.conn_var.set("DISCONNECTED")
        self._set_dot(False)
        self.pcan_var.set("-")
        self._append_log("Disconnected")

    # ---- mode / targets ----
    def _set_mode(self, mode: int) -> None:
        name = MODE_NAMES.get(mode, str(mode))
        self._send(CMD_SET_MODE, 0.0, f"set-mode {name}", param=mode)

    def _send_disable(self) -> None:
        self._send(CMD_DISABLE, 0.0, "disable")

    def _send_estop(self) -> None:
        self._send(CMD_ESTOP, 0.0, "estop")

    def _send_current(self) -> None:
        self._send(CMD_CURRENT, self._float_from(self.current_target_var, "current"), "current")

    def _send_speed(self) -> None:
        self._send(CMD_SPEED, self._float_from(self.speed_target_var, "speed"), "speed")

    def _send_position(self) -> None:
        self._send(CMD_POSITION, self._float_from(self.position_target_var, "position"), "position")

    def _send_mit(self) -> None:
        try:
            pos = self._float_from(self.mit_pos_var, "mit pos")
            vel = self._float_from(self.mit_vel_var, "mit vel")
            kp = self._float_from(self.mit_kp_var, "mit kp")
            kd = self._float_from(self.mit_kd_var, "mit kd")
            iq = self._float_from(self.mit_iq_var, "mit iq_ff")
            self._worker.send_mit(self._node_id(), pos, vel, kp, kd, iq)
        except Exception as exc:
            self._append_log(f"Send MIT failed: {exc}")
            messagebox.showerror("Send MIT failed", str(exc))
            return
        self._append_log(f"Sent MIT pos={pos:g} vel={vel:g} kp={kp:g} kd={kd:g} iq_ff={iq:g}")

    def _apply_current_pi(self) -> None:
        try:
            kp = self._float_from(self.i_kp_var, "I Kp")
            ki = self._float_from(self.i_ki_var, "I Ki")
            lim = self._float_from(self.i_lim_var, "I Vlim")
            if min(kp, ki, lim) < 0:
                raise ValueError("Current gains must be >= 0")
            for pid, val in ((PID_CURRENT_KP, kp), (PID_CURRENT_KI, ki), (PID_CURRENT_LIMIT, lim)):
                self._worker.send_pid(self._node_id(), pid, val)
                time.sleep(0.01)
            self._append_log(f"Applied Current PI: Kp={kp:g} Ki={ki:g} Vlim={lim:g}")
        except Exception as exc:
            self._append_log(f"Apply Current PI failed: {exc}")
            messagebox.showerror("Apply Current PI", str(exc))

    def _apply_pos_pid(self) -> None:
        try:
            kp = self._float_from(self.pos_kp_var, "Pos Kp")
            ki = self._float_from(self.pos_ki_var, "Pos Ki")
            kd = self._float_from(self.pos_kd_var, "Pos Kd")
            isep = self._float_from(self.pos_isep_var, "Pos I-sep")
            if min(kp, ki, kd, isep) < 0:
                raise ValueError("Pos gains must be >= 0")
            for pid, val in (
                (PID_POS_KP, kp),
                (PID_POS_KI, ki),
                (PID_POS_KD, kd),
                (PID_POS_ISEP, isep),
            ):
                self._worker.send_pid(self._node_id(), pid, val)
                time.sleep(0.01)
            self._append_log(f"Applied Pos PID: Kp={kp:g} Ki={ki:g} Kd={kd:g} Isep={isep:g}")
        except Exception as exc:
            self._append_log(f"Apply Pos PID failed: {exc}")
            messagebox.showerror("Apply Pos PID", str(exc))

    def _apply_mit_pd(self) -> None:
        try:
            kp = self._float_from(self.mit_kp_var, "MIT Kp")
            kd = self._float_from(self.mit_kd_var, "MIT Kd")
            if kp < 0 or kd < 0:
                raise ValueError("MIT Kp/Kd must be >= 0")
            self._worker.send_pid(self._node_id(), PID_MIT_KP, kp)
            time.sleep(0.01)
            self._worker.send_pid(self._node_id(), PID_MIT_KD, kd)
            self._append_log(f"Applied MIT PD: Kp={kp:g} Kd={kd:g}")
        except Exception as exc:
            self._append_log(f"Apply MIT PD failed: {exc}")
            messagebox.showerror("Apply MIT PD", str(exc))

    def _send(self, command: int, target: float, name: str, param: int = 0) -> None:
        try:
            self._worker.send(self._node_id(), command, target, param)
        except Exception as exc:
            self._append_log(f"Send {name} failed: {exc}")
            messagebox.showerror("Send failed", str(exc))
            return
        self.pcan_var.set(self._worker.status_text())
        self._append_log(f"Sent {name}" + (f" target={target:g}" if command not in (CMD_DISABLE, CMD_ESTOP, CMD_SET_MODE) else ""))

    # ---- events ----
    def _poll_events(self) -> None:
        while True:
            try:
                kind, payload = self._events.get_nowait()
            except queue.Empty:
                break
            if kind == "status":
                self._apply_status(payload)
            elif kind == "error":
                self._append_log(f"RX error: {payload}")

        if self._worker.connected:
            age = time.time() - self._last_status_time if self._last_status_time else None
            if age is not None and age > 1.0:
                self.rx_lbl.configure(text=f"RX {age:.1f}s ago", fg=ORANGE)
            self.pcan_var.set(self._worker.status_text())
        self.after(80, self._poll_events)

    def _apply_status(self, status: StatusFrame) -> None:
        self._last_status_time = time.time()
        self._active_mode = status.mode
        self._highlight_mode(status.mode)

        # Always-on speed
        self.speed_card.set(f"{status.speed_rpm:.1f}", sub="live feedback", color=GREEN)
        self.spark.push(status.speed_rpm)

        # Primary depends on mode
        if status.mode == MODE_SPEED:
            primary = f"{status.feedback:.1f}"
            unit = "rpm"
            sub = "speed loop"
        elif status.mode == MODE_CURRENT:
            primary = f"{status.feedback:.3f}"
            unit = "A"
            sub = "iq feedback"
        elif status.mode in (MODE_POSITION, MODE_MIT):
            primary = f"{status.feedback:.3f}"
            unit = "rad"
            sub = "position"
        else:
            primary = f"{status.feedback:.2f}"
            unit = "V"
            sub = "bus voltage"
        self.primary_card.unit_lbl.configure(text=unit)
        self.primary_card.set(primary, sub=sub, color=ACCENT)

        self.mode_card.set(status.mode_name, sub=f"fault 0x{status.fault:02X}", color=MODE_COLORS.get(status.mode, TEXT))
        if status.fault:
            self.fault_lbl.configure(text=f"FAULT  0x{status.fault:02X}", fg=RED)
        else:
            self.fault_lbl.configure(text="FAULT  0x00", fg=GREEN)
        self.rx_lbl.configure(text="RX now", fg=GREEN)

    def _append_log(self, text: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        self.log.insert(tk.END, f"[{stamp}] {text}\n")
        self.log.see(tk.END)

    def _node_id(self) -> int:
        node_id = int(self.node_id_var.get())
        if node_id < 0 or node_id > 127:
            raise ValueError("Node ID must be 0..127")
        return node_id

    def _float_from(self, variable: tk.StringVar, name: str) -> float:
        try:
            return float(variable.get())
        except ValueError as exc:
            raise ValueError(f"Invalid {name}") from exc

    def _on_close(self) -> None:
        try:
            if self._worker.connected:
                self._worker.send(self._node_id(), CMD_DISABLE)
        except Exception:
            pass
        self._worker.stop()
        self.destroy()


def main() -> None:
    app = MotorControlApp()
    app.mainloop()


if __name__ == "__main__":
    main()
