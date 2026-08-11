import re
import struct

text = open(r'tools/ram_debug_raw.txt', 'r', encoding='utf-16').read()
raw = {}
for m in re.finditer(
    r'(?m)^(20[0-9A-Fa-f]{6}|48001414|40012C34|40020008)\s*=\s*((?:[0-9A-Fa-f]{2,8}\s*)+)$',
    text,
):
    addr = int(m.group(1), 16)
    for t in m.group(2).split():
        v = int(t, 16)
        if len(t) <= 2:
            raw[addr] = v
            addr += 1
        elif len(t) <= 4:
            raw[addr] = v & 0xFF
            raw[addr + 1] = (v >> 8) & 0xFF
            addr += 2
        else:
            for i in range(4):
                raw[addr + i] = (v >> (8 * i)) & 0xFF
            addr += 4


def u8(a):
    return raw.get(a)


def u16(a):
    if a in raw and (a + 1) in raw:
        return raw[a] | (raw[a + 1] << 8)
    return None


def u32(a):
    if all((a + i) in raw for i in range(4)):
        return raw[a] | (raw[a + 1] << 8) | (raw[a + 2] << 16) | (raw[a + 3] << 24)
    return None


def f32(a):
    w = u32(a)
    if w is None:
        return None
    return struct.unpack('<f', struct.pack('<I', w))[0]


mode_names = {
    0: 'IDLE',
    1: 'CURRENT',
    2: 'SPEED',
    3: 'POSITION',
    4: 'MIT',
    10: 'ALIGN',
    11: 'OPEN_LOOP',
    12: 'IDENT',
}

mode = u8(0x20000010)
print('=== CONTROL ===')
print(
    'mode_cmd=%s (%s) enable=%s open_loop_en=%s'
    % (mode, mode_names.get(mode, '?'), u8(0x20000011), u8(0x20000012))
)
vr = f32(0x20000014)
print('vel_ref=%.4f rad/s (%.2f rpm)' % (vr, vr * 9.5493))
print('open_loop_v_max=%.3f V' % f32(0x2000002c))
print(
    'pi_kp=%.2f pi_ki=%.1f e_zero=%.4f rad'
    % (f32(0x20000034), f32(0x20000038), f32(0x2000003c))
)
print('ia_zero=%.4f V  ib_zero=%.4f V' % (f32(0x2000005c), f32(0x20000060)))
print('bus_ok_ms=%s armed=%s' % (u16(0x200004f4), u8(0x200004f6)))
olv = f32(0x200004bc)
print(
    'ol_angle=%.4f ol_vel=%.4f rad/s (%.2f rpm)'
    % (f32(0x200004b8), olv, olv * 9.5493)
)
print('sample_seq=%s' % u32(0x200006dc))
rawadc = [u16(0x200006d0), u16(0x200006d2), u16(0x200006d4)]
print('adc_dma_raw=%s' % rawadc)
print('DMA %s' % [hex(u32(0x40020008 + i * 4) or 0) for i in range(4)])
odr = u32(0x48001414) or 0
print('DRV_EN=%d ODR=%s' % (odr & 1, hex(odr)))
ccr = [u32(0x40012C34 + i * 4) for i in range(4)]
print('CCR %s duty %s' % (ccr, [round((c or 0) / 4249.0, 3) for c in ccr[:3]]))

print('=== TELEMETRY ===')
base = 0x20000438
for i, n in enumerate(
    [
        'angle_deg',
        'vel_rad_s',
        'accel',
        'accel_ref',
        'ia',
        'ib',
        'iq_ref',
        'iq',
        'id',
        'vd',
        'vq',
        'bus',
        'rs',
        'l',
        'flux',
        'pos',
        'pos_ref',
    ]
):
    print('%s % .6f' % (n.ljust(12), f32(base + i * 4)))
print(
    'loop=%s isr=%s fault=%s mode=%s'
    % (
        u32(base + 17 * 4),
        u32(base + 18 * 4),
        hex(u32(base + 19 * 4) or 0),
        u8(base + 20 * 4),
    )
)

print('=== FOC ===')
fb = 0x20000500
for i, n in enumerate(
    [
        'id_ref',
        'iq_ref',
        'id',
        'iq',
        'vd',
        'vq',
        'valpha',
        'vbeta',
        'duty_a',
        'duty_b',
        'duty_c',
        'bus',
        'e_ang',
        'omega_e',
        'max_mod',
    ]
):
    print('%s % .6f' % (n.ljust(10), f32(fb + i * 4)))
flags = u32(fb + 15 * 4) or 0
print(
    'enabled=%d decouple=%d ang_ov=%d ol_en=%d'
    % (flags & 0xFF, (flags >> 8) & 0xFF, (flags >> 16) & 0xFF, (flags >> 24) & 0xFF)
)
print(
    'ang_ov_rad=%.4f ol_vd=%.3f ol_vq=%.3f'
    % (f32(fb + 16 * 4), f32(fb + 17 * 4), f32(fb + 18 * 4))
)
print(
    'isr=%s overrun=%s sample_fault=%s'
    % (u32(fb + 19 * 4), u32(fb + 20 * 4), u32(fb + 21 * 4))
)

print('=== LAST_CURRENT ===')
cb = 0x200005a4
print('ia=%.4f ib=%.4f ic=%.4f' % (f32(cb), f32(cb + 4), f32(cb + 8)))
print(
    'raw_a=%s raw_b=%s raw_bus=%s bus=%.3f'
    % (u16(cb + 12), u16(cb + 14), u16(cb + 16), f32(cb + 20))
)

print('=== HEALTH ===')
cmar = u32(0x40020014) or 0
print('OK DMA CMAR' if cmar == 0x200006D0 else ('BAD CMAR ' + hex(cmar)))
print('OK adc data' if any((x or 0) > 0 for x in rawadc) else 'BAD adc zero')
print('OK armed' if u8(0x200004f6) == 1 else 'NOT armed')
print('OK openloop' if mode == 11 else ('mode=' + str(mode)))
print(
    'SUMMARY: bus=%.2fV ia=%.3fA ib=%.3fA ol_vq=%.3fV duty=[%.2f,%.2f,%.2f] rpm_cmd=%.1f rpm_meas=%.1f'
    % (
        f32(fb + 11 * 4),
        f32(cb),
        f32(cb + 4),
        f32(fb + 18 * 4),
        f32(fb + 8 * 4),
        f32(fb + 9 * 4),
        f32(fb + 10 * 4),
        vr * 9.5493,
        f32(base + 4) * 9.5493,
    )
)
