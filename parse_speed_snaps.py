import struct, re, sys
path = sys.argv[1]
labels = sys.argv[2].split(',')
raw = open(path, 'rb').read()
text = raw.decode('utf-8', errors='ignore')
lines = text.splitlines()

def f(h):
    return struct.unpack('<f', struct.pack('<I', int(h, 16)))[0]
def u(h):
    return int(h, 16)

RAD2RPM = 9.54929658551
dumps = []
for i, l in enumerate(lines):
    if l.strip().upper().startswith('20000418 ='):
        vals = []
        j = i
        while j < len(lines) and len(vals) < 20:
            m = re.match(r'\s*([0-9A-Fa-f]{8}) = (.*)', lines[j])
            if m:
                for tok in m.group(2).split():
                    if re.fullmatch(r'[0-9A-Fa-f]{8}', tok):
                        vals.append(tok)
            elif 'J-Link>' in lines[j] or lines[j].startswith('Writing'):
                break
            j += 1
        dumps.append(vals)

print(f'file={path} snaps={len(dumps)}')
print('point         ref   meas   err%  iq_ref     iq     id    bus mode fault')
rows = []
for n, d in enumerate(dumps):
    if len(d) < 12:
        continue
    vel = f(d[1]); vref = f(d[3]); iqref = f(d[6]); iq = f(d[7]); idv = f(d[8]); bus = f(d[11])
    fault = u(d[17]) if len(d) > 17 else -1
    mode = (u(d[18]) & 0xFF) if len(d) > 18 else -1
    lab = labels[n] if n < len(labels) else str(n)
    ref = vref * RAD2RPM; meas = vel * RAD2RPM
    errp = 100.0 * (meas - ref) / ref if abs(ref) > 1e-3 else 0.0
    print(f'{lab:12} {ref:6.1f} {meas:6.1f} {errp:6.1f} {iqref:7.3f} {iq:7.3f} {idv:7.3f} {bus:6.2f} {mode:4} {fault:5}')
    rows.append((lab, ref, meas, errp, iqref, iq, bus))
