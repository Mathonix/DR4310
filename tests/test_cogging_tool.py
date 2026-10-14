import argparse
from collections import deque
import json
import math
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools import cogging_calibrate as cog


def samples():
    return [{'direction': direction, 'angle_rad': i * cog.TAU / cog.SIZE,
             'iq_a': .06 * math.sin(84 * i * cog.TAU / cog.SIZE) + .03 + direction * .02}
            for direction in (1, -1) for repeat in range(4) for i in range(cog.SIZE)]


class ToolTests(unittest.TestCase):
    def test_bidirectional_fit_removes_friction_and_dc(self):
        data = cog.fit_samples(samples(), {'zero': .13, 'dir': 1, 'pp': 14})
        self.assertAlmostEqual(data['quality']['removed_dc_a'], .03)
        for i, value in enumerate(data['current_ma']):
            self.assertLessEqual(abs(value - 60 * math.sin(84 * i * cog.TAU / cog.SIZE)), .501)
        self.assertLess(abs(sum(data['current_ma'])), 5)

    def test_incomplete_coverage_and_bad_data_rejected(self):
        with self.assertRaises(ValueError):
            cog.fit_samples(samples()[:-1], {'zero': .13, 'dir': 1, 'pp': 14})
        with self.assertRaises(ValueError):
            cog.fit_samples([{'direction': 1, 'angle_rad': float('nan'), 'iq_a': 0}], {'zero': .13, 'dir': 1, 'pp': 14})
        data = cog.fit_samples(samples(), {'zero': .13, 'dir': 1, 'pp': 14})
        data['current_ma'][0] += 1
        with self.assertRaises(ValueError): cog.validate_map(data)

    def test_binary_and_reply_fragmentation(self):
        values = [.1] * 16
        # A legitimate float can start with the ASCII '@' byte.
        values[0] = struct.unpack('<f', b'@A00')[0]
        frame = struct.pack('<16f', *values) + cog.TAIL
        payload = b'@OK PING ok\n' + frame + b'@OK COG valid=1\n' + frame
        for size in (1, 2, 7, 67, 68, 200):
            p = cog.StreamParser()
            for offset in range(0, len(payload), size): p.feed(payload[offset:offset+size])
            self.assertEqual(list(p.lines), ['@OK PING ok', '@OK COG valid=1'])
            self.assertEqual(len(p.frames), 2)
            self.assertEqual(p.frames[0][0], values[0])

    def test_calibration_requires_run_before_opening_port(self):
        with patch.object(cog, 'Uart') as uart:
            with self.assertRaises(ValueError):
                cog.calibrate(argparse.Namespace(run=False))
            uart.assert_not_called()

    def test_scan_rejects_stall_saturation_and_lost_telemetry(self):
        for failure, message in [('stall', 'Speed tracking'), ('saturation', 'saturation'), ('lost', 'Telemetry lost')]:
            class Clock:
                now = 0
                def monotonic(self): return self.now
            clock = Clock()
            class Fake:
                parser = argparse.Namespace(frames=deque())
                pings = 0
                def command(self, text, **kwargs):
                    if text == 'PING': self.pings += 1
                def pump(self):
                    clock.now += .1
                    if failure != 'lost':
                        self.parser.frames.append((clock.now * .2 % cog.TAU, 0, .2 if failure == 'saturation' else 0,
                                                   0 if failure == 'stall' else .2, 0, 2, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0))
            fake = Fake()
            with patch.object(cog.time, 'monotonic', clock.monotonic):
                with self.assertRaisesRegex(RuntimeError, message): cog.scan(fake, 1, .2, 2, .2, 1)
            self.assertGreater(fake.pings, 0)

    def test_upload_crc_persistence_and_binding_rejection(self):
        class Fake:
            def __init__(self): self.lines, self.table, self.valid, self.saved, self.closed = [], [0]*512, False, False, False
            def stop(self): self.lines.append('STOP')
            def close(self): self.closed = True
            def info(self): return {'id': '1'}
            def params(self): return {'TELEM': 1}
            def set(self, key, value): self.lines.append(f'SET {key} {value}')
            def command(self, text, **kwargs):
                self.lines.append(text)
                tokens = text.split()
                if text == 'SAVE': self.saved = True
                if text.startswith('COG SET '):
                    start = int(tokens[2]); self.table[start:start+len(tokens)-3] = map(int, tokens[3:])
                if text == 'COG COMMIT': self.valid = True
                if text == 'COG INFO':
                    return [f'@OK COG valid={int(self.valid)} enabled=0 match=1 crc=0x{cog.table_crc(self.table):08x}']
                return ['@OK ' + tokens[0]]
        data = cog.fit_samples(samples(), {'zero': .13, 'dir': 1, 'pp': 14})
        data['motor_id'] = 1
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'map.json'
            path.write_text(json.dumps(data), encoding='utf-8')
            args = argparse.Namespace(port='fake', map=str(path), save=True)
            fake = Fake()
            live = {'zero': .13, 'dir': 1, 'pp': 14, 'valid': '0', 'size': '512'}
            with patch.object(cog, 'Uart', return_value=fake) as uart, patch.object(cog, 'require_firmware', return_value=(fake.info(), live)):
                cog.upload(args)
            uart.assert_called_once_with('fake', 200000)
            self.assertEqual(fake.table, data['current_ma'])
            self.assertTrue(fake.saved and fake.closed)
            self.assertNotIn('SET COG_EN 1', fake.lines)
            fake = Fake()
            live['zero'] = .15
            args.baud = 230400
            with patch.object(cog, 'Uart', return_value=fake) as uart, patch.object(cog, 'require_firmware', return_value=(fake.info(), live)):
                with self.assertRaisesRegex(RuntimeError, 'different electrical'): cog.upload(args)
            uart.assert_called_once_with('fake', 230400)
            self.assertNotIn('COG BEGIN', fake.lines)
            self.assertNotIn('COG ABORT', fake.lines)

    def test_speed_quantization_does_not_bias_angle_coverage(self):
        class Clock:
            now = 0
            def monotonic(self): return self.now
        clock = Clock()
        class Fake:
            parser = argparse.Namespace(frames=deque())
            count, stopped = 0, False
            def command(self, text, **kwargs): pass
            def stop(self): self.stopped = True
            def pump(self):
                clock.now += .01
                # A five-ms encoder window jumps by .077 rad/s per count;
                # mean motion remains a stable .2 rad/s.
                omega = (.0767, .1534, .2301, .3068)[self.count % 4]
                self.count += 1
                self.parser.frames.append((clock.now*.2 % cog.TAU, .01, .01, omega,
                                           0, 2, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0))
        fake, raw = Fake(), []
        with patch.object(cog.time, 'monotonic', clock.monotonic), patch('builtins.print'):
            rows = cog.scan(fake, 1, .2, 2, .2, 1, raw)
        self.assertTrue(fake.stopped)
        self.assertGreater(len(rows), 6000)
        self.assertGreater(len(raw), len(rows))
        self.assertIn('speed_average_rad_s', raw[-1])

    def test_failed_scan_stops_and_restores_temporary_parameters(self):
        class FakeUart:
            def __init__(self):
                self.stops, self.closed, self.writes = 0, False, []
            def stop(self): self.stops += 1
            def close(self): self.closed = True
            def info(self): return {'latched': '0', 'calib': '1', 'id': '1'}
            def params(self): return {'TELEM': 1, 'COG_EN': 0, 'OL_EN': 1, 'IQ_LIM': .5, 'TIMEOUT_MS': 0, 'SPD_RAMP_MS': 200}
            def set(self, key, value): self.writes.append((key, value))
            def command(self, line):
                self.writes.append(line)
                return ['@TCH ' + 'IdRef,' * 15 + 'Id'] if line == 'TCH' else ['@OK TRATE hz=100']
        fake = FakeUart()
        with tempfile.TemporaryDirectory() as directory:
            args = argparse.Namespace(run=True, speed=.2, current_limit=.2, turns=2, port='fake', out=str(Path(directory) / 'map.json'))
            with patch.object(cog, 'Uart', return_value=fake), patch.object(cog, 'require_firmware', return_value=(fake.info(), {'zero': .13, 'dir': 1, 'pp': 14})), patch.object(cog, 'scan', side_effect=RuntimeError('stall')):
                with self.assertRaisesRegex(RuntimeError, 'stall'): cog.calibrate(args)
            self.assertFalse(Path(args.out).exists())
        self.assertGreaterEqual(fake.stops, 2)
        self.assertTrue(fake.closed)
        self.assertIn(('TIMEOUT_MS', 1000), fake.writes)
        self.assertIn(('TIMEOUT_MS', 0), fake.writes)
        self.assertIn(('IQ_LIM', .5), fake.writes)
        self.assertNotIn('SAVE', fake.writes)
        self.assertNotIn(('COG_EN', 1), fake.writes)


if __name__ == '__main__':
    unittest.main()
