import time, struct
from tools.can_motor_control import (
    make_bus, send_command, CMD_DISABLE, CMD_SPEED, CMD_POSITION,
    CMD_SET_MODE, MODE_POSITION, MODE_SPEED, status_id,
)

bus = make_bus("PCAN_USBBUS1", 1000000)
print("PCAN open", bus.status_string(), flush=True)
print("waiting status after MCU reset...", flush=True)
t0 = time.time(); got = 0
while time.time() - t0 < 10:
    m = bus.recv(0.1)
    if m and m.arbitration_id == status_id(2):
        got += 1
        fb = struct.unpack("<f", bytes(m.data[2:6]))[0]
        if got <= 3:
            print(f"  status#{got} mode={m.data[0]} fault={m.data[1]} fb={fb:.3f}", flush=True)
        if got >= 5:
            break
print("got_status", got, flush=True)
if got == 0:
    bus.shutdown(); raise SystemExit(2)

def collect(seconds, want=None):
    rows = []; t0 = time.time()
    while time.time() - t0 < seconds:
        m = bus.recv(0.1)
        if not m or m.arbitration_id != status_id(2):
            continue
        mode, fault = m.data[0], m.data[1]
        fb = struct.unpack("<f", bytes(m.data[2:6]))[0]
        if want is not None and mode != want:
            continue
        rows.append((time.time() - t0, mode, fault, fb))
    return rows

print("\n=== SPEED 40rpm 6s ===", flush=True)
send_command(bus, 2, CMD_SPEED, 40.0)
rows = collect(6.0, MODE_SPEED)
if rows:
    vals = [r[3] for r in rows]
    late = [r[3] for r in rows if r[0] >= max(0, rows[-1][0] - 1.2)]
    print(f" n={len(rows)} settle={sum(late)/len(late):.1f} peak={max(abs(v) for v in vals):.1f} last={vals[-1]:.1f}", flush=True)
else:
    print(" no samples", flush=True)
send_command(bus, 2, CMD_DISABLE); time.sleep(1.0)

print("\n=== SPEED 80rpm 6s ===", flush=True)
send_command(bus, 2, CMD_SPEED, 80.0)
rows = collect(6.0, MODE_SPEED)
if rows:
    vals = [r[3] for r in rows]
    late = [r[3] for r in rows if r[0] >= max(0, rows[-1][0] - 1.2)]
    print(f" n={len(rows)} settle={sum(late)/len(late):.1f} peak={max(abs(v) for v in vals):.1f} last={vals[-1]:.1f}", flush=True)
else:
    print(" no samples", flush=True)
send_command(bus, 2, CMD_DISABLE); time.sleep(1.0)

print("\n=== POSITION soft hold +0.5 ===", flush=True)
send_command(bus, 2, CMD_SET_MODE, 0.0, MODE_POSITION)
rows = collect(1.5, MODE_POSITION)
if not rows:
    print(" no enter", flush=True); send_command(bus, 2, CMD_DISABLE); bus.shutdown(); raise SystemExit(1)
pos0 = rows[-1][3]; target = pos0 + 0.5
print(f" pos0={pos0:.4f} -> {target:.4f}", flush=True)
send_command(bus, 2, CMD_POSITION, target)
rows = collect(5.0, MODE_POSITION)
if rows:
    vals = [r[3] for r in rows]; start = vals[0]
    final = sum(vals[-8:]) / min(8, len(vals[-8:]))
    over = max(0.0, max(vals) - target) if target >= start else max(0.0, target - min(vals))
    print(f" start={start:.3f} final={final:.3f} err={final-target:+.3f} overshoot={over:.3f}", flush=True)
else:
    print(" no samples", flush=True)
send_command(bus, 2, CMD_DISABLE); time.sleep(0.8)

print("\n=== POSITION soft hold +1.0 ===", flush=True)
send_command(bus, 2, CMD_SET_MODE, 0.0, MODE_POSITION)
rows = collect(1.2, MODE_POSITION)
pos1 = rows[-1][3] if rows else 0.0
target2 = pos1 + 1.0
print(f" pos1={pos1:.4f} -> {target2:.4f}", flush=True)
send_command(bus, 2, CMD_POSITION, target2)
rows = collect(6.0, MODE_POSITION)
if rows:
    vals = [r[3] for r in rows]; start = vals[0]
    final = sum(vals[-8:]) / min(8, len(vals[-8:]))
    over = max(0.0, max(vals) - target2) if target2 >= start else max(0.0, target2 - min(vals))
    print(f" start={start:.3f} final={final:.3f} err={final-target2:+.3f} overshoot={over:.3f}", flush=True)
else:
    print(" no samples", flush=True)
send_command(bus, 2, CMD_DISABLE)
print("\nDone", flush=True)
bus.shutdown()
