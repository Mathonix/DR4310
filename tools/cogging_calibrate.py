"""DR4310 bidirectional low-speed cogging calibration and verified map upload.

calibrate requires --run and produces a JSON map without uploading/enabling it.
upload is a separate stopped-motor operation; --save persists it, still disabled.
Only pyserial is needed for device operations; fit/validate run without hardware.
"""
import argparse
from collections import deque
import csv
import json
import math
from pathlib import Path
import re
import struct
import time
import zlib

SIZE = 512
TAU = 2 * math.pi
TAIL = b'\x00\x00\x80\x7f'
CHANNELS = 'EncRad Iq IqRef Omega Fault Mode Vbus CogIq Id Vsat Ia Ib Ic DutyA DutyB DutyC'


def table_crc(values):
    return zlib.crc32(struct.pack('<512h', *values)) & 0xffffffff


def check_binding(binding):
    zero = float(binding['zero'])
    direction, poles = int(binding['dir']), int(binding['pp'])
    if not math.isfinite(zero) or not 0 <= zero < TAU or direction not in (0, 1) or not 1 <= poles <= 40:
        raise ValueError('Invalid commutation calibration metadata')
    return {'zero': zero, 'dir': direction, 'pp': poles}


def validate_map(data):
    if data.get('type') != 'dr4310-cogging' or data.get('version') != 1 or data.get('angle') != 'raw_encoder_rad':
        raise ValueError('Expected DR4310 raw-encoder cogging map version 1')
    values = data.get('current_ma')
    if not isinstance(values, list) or len(values) != SIZE or any(
            type(v) is not int or abs(v) > 1000 for v in values):
        raise ValueError('Expected 512 integer samples in -1000..1000 mA')
    check_binding(data['binding'])
    if abs(sum(values) / SIZE) > 2:
        raise ValueError('Map has a DC offset: remove load/friction bias before upload')
    if data.get('crc32') != f'{table_crc(values):08x}':
        raise ValueError('Map CRC32 mismatch')
    return data


def fit_samples(rows, binding, minimum=4):
    """Average both directions at the SAME absolute angle, then remove DC.

    Symmetric friction/velocity-loop delay cancels between directions. Samples
    are binned around LUT knots (round, not floor/half-bin-shifted centres).
    Missing/under-populated bins are rejected rather than filled with guesses.
    """
    bins = [[[] for _ in range(SIZE)] for _ in range(2)]
    for row in rows:
        direction = int(row['direction'])
        angle, current = float(row['angle_rad']), float(row['iq_a'])
        if direction not in (-1, 1) or not math.isfinite(angle) or not math.isfinite(current):
            raise ValueError('Invalid calibration sample')
        if abs(current) > 1.0:
            raise ValueError('Calibration current exceeds map range')
        index = int(math.floor((angle % TAU) * SIZE / TAU + 0.5)) % SIZE
        bins[0 if direction == 1 else 1][index].append(current)
    missing = [(side, i, len(b)) for side in range(2) for i, b in enumerate(bins[side]) if len(b) < minimum]
    if missing:
        raise ValueError(f'Insufficient bidirectional coverage in {len(missing)} bins; first: {missing[:5]}')
    means = [[sum(b) / len(b) for b in side] for side in bins]
    compensation = [(a + b) * 0.5 for a, b in zip(*means)]
    dc = sum(compensation) / SIZE
    values = [round((v - dc) * 1000) for v in compensation]
    data = {'type': 'dr4310-cogging', 'version': 1, 'angle': 'raw_encoder_rad',
            'binding': check_binding(binding), 'current_ma': values,
            'crc32': f'{table_crc(values):08x}',
            'quality': {'samples': len(rows), 'min_samples_per_bin': min(len(b) for side in bins for b in side),
                        'removed_dc_a': dc, 'peak_a': max(abs(v) for v in values) / 1000,
                        'direction_difference_rms_a': math.sqrt(sum((a-b)**2 for a, b in zip(*means)) / SIZE)}}
    return validate_map(data)


class StreamParser:
    """Whole text replies and 68-byte JustFloat frames can be interleaved."""
    def __init__(self):
        self.buffer = bytearray()
        self.lines = deque()
        self.frames = deque()

    def feed(self, chunk):
        self.buffer.extend(chunk)
        while self.buffer:
            b = self.buffer
            # Frame recognition takes priority: a float's first byte may be @.
            if len(b) >= 68 and b[64:68] == TAIL:
                values = struct.unpack('<16f', b[:64])
                del b[:68]
                self.frames.append(values)
                continue
            if b[0] == 64:
                end = b.find(b'\n')
                if end >= 0:
                    line = bytes(b[:end + 1])
                    if re.fullmatch(rb'@[A-Z][\x20-\x7e]*\r?\n', line):
                        del b[:end + 1]
                        self.lines.append(line.decode('ascii').strip())
                        continue
            if len(b) < 68:
                break
            # Keep incomplete ASCII lines (INFO can be longer than a frame).
            if b[0] == 64 and all(32 <= v <= 126 or v == 13 for v in b) and len(b) < 1024:
                break
            del b[0]
        if len(self.frames) > 4096:
            raise RuntimeError('Telemetry backlog: host cannot keep up')


class Uart:
    def __init__(self, port, baud=200000):
        import serial
        self.port = serial.Serial(port, baud, timeout=.02, write_timeout=1)
        self.parser = StreamParser()
        # CDC bridges need time to apply line coding after open. Also discard
        # any partial command left by a prior connection before issuing STOP.
        time.sleep(.15)
        self.port.write(b'\n')
        self.port.flush()

    def pump(self):
        self.parser.feed(self.port.read(max(1, self.port.in_waiting)))

    def command(self, text, timeout=2):
        if len(text) > 191 or '\n' in text:
            raise ValueError('Invalid command length')
        self.parser.lines.clear()
        self.port.write((text + '\n').encode('ascii'))
        self.port.flush()
        key = text.split()[0]
        deadline, lines = time.monotonic() + timeout, []
        while time.monotonic() < deadline:
            self.pump()
            while self.parser.lines:
                line = self.parser.lines.popleft()
                lines.append(line)
                if line.startswith('@ERR ' + key + ' '):
                    raise RuntimeError(f'{text}: {line}')
                if line.startswith('@OK ' + key) or (key in ('INFO', 'TCH', 'TRATE', 'FAULT') and line.startswith('@' + key + ' ')) or (key == 'PING' and line.startswith('@PONG ')):
                    return lines
        raise RuntimeError(f'UART timeout: {text}')

    def set(self, key, value):
        return self.command(f'SET {key} {value:.8g}')

    def params(self):
        return {m[1]: float(m[2]) for line in self.command('GET')
                if (m := re.match(r'@P (\w+)=([\deE+.\-]+)', line))}

    def info(self):
        return kv(self.command('INFO')[-1])

    def stop(self):
        self.command('STOP')
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            info = self.info()
            if info.get('run') == 'IDLE' and info.get('drv') == '0' and info.get('ae') == '0':
                return
        raise RuntimeError('Motor did not confirm IDLE/driver off')

    def close(self):
        self.port.close()


def kv(line):
    return dict(re.findall(r'(\w+)=([^ ]+)', line))


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def require_firmware(uart):
    info = uart.info()
    meta = kv(uart.command('COG INFO')[-1])
    if info.get('fw') != 'DR4310' or meta.get('size') != str(SIZE):
        raise RuntimeError('Firmware does not support this 512-point cogging table')
    return info, meta


def scan(uart, sign, speed, turns, current_limit, encoder_direction, raw_samples=None):
    uart.parser.frames.clear()
    uart.command(f'SPD {sign * speed * 60 / TAU:.8g}')
    start = time.monotonic()
    deadline = start + 6 + 1.6 * turns * TAU / speed
    next_ping, last_sample, bad_since, saturated_since = start, start, None, None
    previous, travel, rows, report_at = None, 0.0, [], start
    velocity_history = deque()
    while time.monotonic() < deadline and travel < turns * TAU:
        now = time.monotonic()
        if now >= next_ping:
            uart.command('PING', timeout=.5)
            next_ping = time.monotonic() + .2
        uart.pump()
        while uart.parser.frames:
            frame = uart.parser.frames.popleft()
            angle, iq, iq_ref, omega, fault, mode, bus = frame[:7]
            # The production speed estimate uses a 5 ms encoder window. At
            # .2 rad/s a single count is ~.077 rad/s, so per-frame +/-25%
            # selection biases angle bins. Average 100 ms for quality only;
            # current and table phase are still taken from the raw sample.
            velocity_history.append((now, omega))
            while velocity_history and velocity_history[0][0] < now - .1:
                velocity_history.popleft()
            filtered_omega = sum(v for _, v in velocity_history) / len(velocity_history)
            if raw_samples is not None:
                raw_samples.append({'direction': sign, 'elapsed_s': now-start,
                                    'angle_rad': angle, 'iq_a': iq, 'iq_ref_a': iq_ref,
                                    'omega_rad_s': omega, 'fault': fault, 'mode': mode,
                                    'vbus': bus, 'voltage_saturated': frame[9],
                                    'speed_average_rad_s': filtered_omega})
            if not all(math.isfinite(x) for x in frame) or int(fault) != 0:
                raise RuntimeError('Invalid telemetry/fault/control mode during scan')
            if not 0 <= angle < TAU + 1e-5 or abs(omega) > max(.8, 2 * speed):
                raise RuntimeError(f'Invalid encoder angle or excessive speed: angle={angle:.6g}, omega={omega:.6g}, target={sign*speed:.6g}')
            last_sample = now
            # Discard acceleration/settling and any stale pre-command frames.
            if now - start < 3:
                previous = None
                continue
            if int(mode) != 2:
                raise RuntimeError('Motor left speed mode during scan')
            valid_speed = .75 * speed <= sign * filtered_omega <= 1.25 * speed
            bad_since = None if valid_speed else (now if bad_since is None else bad_since)
            saturated = abs(iq_ref) >= .95 * current_limit or frame[9] >= .5
            saturated_since = (now if saturated_since is None else saturated_since) if saturated else None
            if bad_since is not None and now - bad_since > .8:
                raise RuntimeError('Speed tracking failed/stall: tune speed loop or reduce speed')
            if saturated_since is not None and now - saturated_since > .3:
                raise RuntimeError('Current/voltage saturation: map would be unreliable')
            if previous is not None:
                delta = (angle - previous + math.pi) % TAU - math.pi
                canonical_delta = delta if encoder_direction == 1 else -delta
                travel += sign * canonical_delta
            previous = angle
            if valid_speed and not saturated:
                rows.append({'direction': sign, 'angle_rad': angle, 'iq_a': iq,
                             'iq_ref_a': iq_ref, 'omega_rad_s': omega})
        if now - last_sample > .5:
            raise RuntimeError('Telemetry lost; stopping scan')
        if now >= report_at:
            print(f'{sign:+d}: {travel / TAU:.2f}/{turns} turns, {len(rows)} samples', flush=True)
            report_at = now + 2
    if travel < turns * TAU:
        raise RuntimeError('Scan exceeded bounded duration')
    uart.stop()
    return rows


def calibrate(args):
    if not args.run:
        raise ValueError('calibrate moves the motor; pass --run for an unloaded full-revolution scan')
    if not .05 <= args.speed <= .5 or not .02 <= args.current_limit <= 1 or not 2 <= args.turns <= 10:
        raise ValueError('Use speed .05..0.5 rad/s, current limit .02..1 A, turns 2..10')
    uart, original, channels, rate, rows, raw_samples = Uart(args.port, getattr(args, 'baud', 200000)), None, None, None, [], []
    try:
        uart.stop()
        info, meta = require_firmware(uart)
        if int(info.get('latched', '0'), 0) or info.get('calib') != '1':
            raise RuntimeError('First clear the cause of faults and complete electrical calibration')
        original = uart.params()
        channels = uart.command('TCH')[-1].removeprefix('@TCH ').replace(',', ' ')
        rate = int(kv(uart.command('TRATE')[-1])['hz'])
        write_json(args.out + '.backup.json', {'info': info, 'params': original, 'channels': channels, 'rate': rate})
        limit = min(args.current_limit, original['IQ_LIM'])
        if limit < .02:
            raise RuntimeError('Configured IQ_LIM is too small for calibration')
        for key, value in [('TELEM', 0), ('COG_EN', 0), ('OL_EN', 0),
                           ('IQ_LIM', limit), ('TIMEOUT_MS', 1000), ('SPD_RAMP_MS', 0)]:
            uart.set(key, value)
        uart.command('TCH ' + CHANNELS)
        uart.command('TRATE 100')
        uart.set('TELEM', 1)
        for sign in (1, -1):
            rows.extend(scan(uart, sign, args.speed, args.turns, limit, int(meta['dir']), raw_samples))
        raw_path = Path(args.out + '.csv')
        raw_path.parent.mkdir(parents=True, exist_ok=True)
        with raw_path.open('w', newline='', encoding='utf-8') as handle:
            writer = csv.DictWriter(handle, fieldnames=rows[0].keys())
            writer.writeheader()
            writer.writerows(rows)
        data = fit_samples(rows, meta)
        data['motor_id'] = int(info['id'])
        data['quality']['speed_rad_s'] = args.speed
        write_json(args.out, data)
        print(f'Map saved, compensation still off: {args.out}; quality={data["quality"]}')
    finally:
        try:
            uart.stop()
            if original is not None:
                uart.set('TELEM', 0)
                # Restore only temporary RAM settings. No SAVE, no AE restart.
                for key in ('IQ_LIM', 'OL_EN', 'SPD_RAMP_MS', 'TIMEOUT_MS'):
                    uart.set(key, original[key])
                if channels is not None:
                    uart.command('TCH ' + channels)
                if rate is not None:
                    uart.command(f'TRATE {rate}')
                uart.set('TELEM', original['TELEM'])
        finally:
            uart.close()
            if raw_samples:
                raw_path = Path(args.out + '.raw.csv')
                raw_path.parent.mkdir(parents=True, exist_ok=True)
                with raw_path.open('w', newline='', encoding='utf-8') as handle:
                    writer = csv.DictWriter(handle, fieldnames=raw_samples[0].keys())
                    writer.writeheader()
                    writer.writerows(raw_samples)


def upload(args):
    data = validate_map(json.loads(Path(args.map).read_text(encoding='utf-8')))
    uart, telemetry, begun = Uart(args.port, getattr(args, 'baud', 200000)), None, False
    try:
        uart.stop()
        info, live = require_firmware(uart)
        binding = check_binding(data['binding'])
        actual = check_binding(live)
        if binding['dir'] != actual['dir'] or binding['pp'] != actual['pp'] or abs(binding['zero'] - actual['zero']) > 1e-5:
            raise RuntimeError('Map belongs to a different electrical calibration; recalibrate it')
        if 'motor_id' in data and int(info['id']) != data['motor_id']:
            raise RuntimeError('Motor CAN ID differs from the calibrated device')
        params = uart.params()
        telemetry = params['TELEM']
        uart.set('TELEM', 0)
        if live['valid'] == '1':
            old = [int(kv(uart.command(f'COG GET {i}')[-1])['ma']) for i in range(SIZE)]
            write_json(args.map + '.device-backup.json', {'params': params, 'cogging': live, 'current_ma': old})
        begun = True
        uart.command('COG BEGIN')
        for start in range(0, SIZE, 16):
            uart.command(f'COG SET {start} ' + ' '.join(map(str, data['current_ma'][start:start+16])))
        uart.command('COG COMMIT')
        result = kv(uart.command('COG INFO')[-1])
        if result['valid'] != '1' or result['match'] != '1' or int(result['crc'], 0) != table_crc(data['current_ma']):
            raise RuntimeError('Uploaded map verification failed')
        # Retain user settings. Upload never enables the compensation.
        uart.set('TELEM', telemetry)
        if args.save:
            uart.command('SAVE', timeout=5)
            uart.command('RELOAD')
            result = kv(uart.command('COG INFO')[-1])
            if result['valid'] != '1' or result['enabled'] != '0' or int(result['crc'], 0) != table_crc(data['current_ma']):
                raise RuntimeError('Flash map read-back verification failed')
        print(f'512 points verified, saved={args.save}, COG_EN=0. Enable after small-gain validation.')
    except BaseException:
        try:
            uart.stop()
            if begun:
                uart.command('COG ABORT')
        except Exception as stop_error:
            print(f'Cleanup failed; command watchdog remains the fallback: {stop_error}')
        raise
    finally:
        try:
            uart.stop()
            if telemetry is not None:
                uart.set('TELEM', telemetry)
        finally:
            uart.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    cal = sub.add_parser('calibrate')
    cal.add_argument('--port', required=True)
    cal.add_argument('--baud', type=int, choices=(200000, 230400), default=200000)
    cal.add_argument('--out', required=True)
    cal.add_argument('--run', action='store_true')
    cal.add_argument('--speed', type=float, default=.2, help='Mechanical rad/s, both directions')
    cal.add_argument('--current-limit', type=float, default=.2)
    cal.add_argument('--turns', type=int, default=2, help='Full revolutions per direction after settling')
    up = sub.add_parser('upload')
    up.add_argument('--port', required=True)
    up.add_argument('--baud', type=int, choices=(200000, 230400), default=200000)
    up.add_argument('--map', required=True)
    up.add_argument('--save', action='store_true', help='Persist and RELOAD-verify the map, still disabled')
    fit = sub.add_parser('fit')
    fit.add_argument('--csv', required=True)
    fit.add_argument('--binding', required=True, help='Calibration backup JSON or raw zero/dir/pp object')
    fit.add_argument('--out', required=True)
    check = sub.add_parser('validate')
    check.add_argument('--map', required=True)
    args = parser.parse_args()
    if args.action == 'calibrate':
        calibrate(args)
    elif args.action == 'upload':
        upload(args)
    elif args.action == 'fit':
        binding = json.loads(Path(args.binding).read_text(encoding='utf-8'))
        with Path(args.csv).open(newline='', encoding='utf-8') as handle:
            rows = list(csv.DictReader(handle))
        write_json(args.out, fit_samples(rows, binding.get('info', binding)))
    else:
        data = validate_map(json.loads(Path(args.map).read_text(encoding='utf-8')))
        print(f'Valid: 512 points, peak={max(abs(v) for v in data["current_ma"])} mA, crc={data["crc32"]}')


if __name__ == '__main__':
    main()
