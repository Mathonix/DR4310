"""Local stdio transport for explicitly invoked browser hardware tests.

No web listener. All device responses and telemetry come from the real UART.
Production browser builds do not import or call this script.
"""
import base64
import argparse
import json
import sys
import threading
import serial

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--run', action='store_true')
parser.add_argument('--port', default='COM5')
parser.add_argument('--baud', type=int, choices=(200000,230400), default=200000)
args = parser.parse_args()
if not args.run:
    raise SystemExit('Hardware test transport requires --run')
uart = serial.Serial(args.port, args.baud, timeout=.02, write_timeout=1)
done = threading.Event()

def read():
    while not done.is_set():
        try:
            data = uart.read(min(4096, max(1, uart.in_waiting)))
            if data:
                print(json.dumps({'data': base64.b64encode(data).decode('ascii')}), flush=True)
        except serial.SerialException:
            done.set()

reader = threading.Thread(target=read, daemon=True)
reader.start()
try:
    for line in sys.stdin:
        data = base64.b64decode(json.loads(line)['data'], validate=True)
        # ASCII <=192 B; AUDIO V1 full DATA frames are 334 B.
        if len(data) > 334:
            raise ValueError('Test transport write too large')
        uart.write(data)
        uart.flush()
finally:
    try:
        uart.write(b'\nSTOP\n')
        uart.flush()
    finally:
        done.set()
        reader.join(timeout=.5)
        uart.close()
