#!/usr/bin/env python3
"""Safely run one motor electrical calibration and verify Flash persistence."""
import argparse
import json
import math
from pathlib import Path
import struct
import time
from position_hardware_test import telemetry_layout, word_bytes

ROOT = Path(__file__).resolve().parents[1]
DRIVER_GPIO_ODR = 0x48001414  # GPIOF ODR, PF0 = DRV enable


def load_symbols(elf_path, names):
    from elftools.elf.elffile import ELFFile
    result = {}
    with elf_path.open('rb') as f:
        elf = ELFFile(f)
        table = elf.get_section_by_name('.symtab')
        if table is None:
            raise RuntimeError('ELF has no symbol table')
        for name in names:
            found = table.get_symbol_by_name(name)
            if not found:
                raise RuntimeError(f'Missing ELF symbol: {name}')
            result[name] = found[0]['st_value']
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial-port', default='COM5')
    parser.add_argument('--jlink-serial', type=int, default=29534567)
    parser.add_argument('--jlink-dll', default=r'C:\Program Files\SEGGER\JLink_V930a\JLink_x64.dll')
    parser.add_argument('--timeout', type=float, default=25.0)
    parser.add_argument('--out', type=Path, help='Write calibration measurements and result as JSON')
    args = parser.parse_args()

    elf_path = ROOT / 'build/Release/4310_G431KBT6.elf'
    if not elf_path.exists():
        raise RuntimeError('Build the ID-specific firmware before calibration')
    names = [
        'control_mode_cmd', 'control_enable', 'control_calibrate_enable',
        'control_electrical_zero_rad', 'control_encoder_direction',
        'calibration_flash_status', 'calibration_flash_valid',
        'calibration_flash_sequence', 'calibration_flash_save_count',
        'can_node_id',
        'control_debug_cmd',
    ]
    symbols = load_symbols(elf_path, names)
    from elftools.elf.elffile import ELFFile
    with elf_path.open('rb') as file:
        elf = ELFFile(file)
        address, size, layout, _ = telemetry_layout(elf)
        text = elf.get_section_by_name('.text')
        text_address, text_image = text['sh_addr'], text.data()
    result = {'samples': [], 'passed': False}

    import pylink
    import serial
    try:
        uart = serial.Serial(args.serial_port, 200000, timeout=0.05, write_timeout=1)
    except serial.SerialException as exc:
        raise RuntimeError(
            f'{args.serial_port} is unavailable. Send STOP, stop cyclic commands, '
            'then disconnect/close VOFA+ before calibration.') from exc

    j = pylink.JLink(lib=pylink.library.Library(dllpath=args.jlink_dll))
    firmware_matches = False
    try:
        j.open(serial_no=args.jlink_serial)
        j.set_tif(pylink.enums.JLinkInterfaces.SWD)
        j.connect('STM32G431KB', speed=1000)
        if bytes(j.memory_read8(text_address, len(text_image))) != text_image:
            raise RuntimeError('Running firmware does not match the calibration ELF')
        firmware_matches = True
        if j.halted():
            j.restart()
            time.sleep(0.5)

        def bytes_at(name, count):
            return bytes(j.memory_read8(symbols[name], count))

        def u8(name):
            return bytes_at(name, 1)[0]

        def u32(name):
            return j.memory_read32(symbols[name], 1)[0]

        def f32(name):
            return struct.unpack('<f', word_bytes(j, symbols[name], 4))[0]

        def driver_enabled():
            return bool(j.memory_read32(DRIVER_GPIO_ODR, 1)[0] & 1)

        node_id = u8('can_node_id')
        if not 1 <= node_id <= 7:
            raise RuntimeError(f'Invalid firmware CAN ID read over SWD: {node_id}')

        uart.reset_output_buffer()
        uart.write(b'\nSTOP\n')
        uart.flush()
        time.sleep(0.5)
        if driver_enabled() or u8('control_enable') != 0 or u8('control_mode_cmd') != 0:
            raise RuntimeError('Motor did not enter IDLE after STOP; calibration aborted')

        before_sequence = u32('calibration_flash_sequence')
        before_saves = u32('calibration_flash_save_count')
        result['before'] = {'sequence': before_sequence,
                            'zero': f32('control_electrical_zero_rad'),
                            'direction': u8('control_encoder_direction')}
        print(f'IDLE motor_id={node_id} persisted={u8("calibration_flash_valid")} '
              f'sequence={before_sequence}', flush=True)
        print('Starting calibration: rotor will align and rotate slowly for about 10 seconds.', flush=True)

        uart.write(b'CALIBRATE\n')
        uart.flush()
        deadline = time.monotonic() + args.timeout
        started = False
        last_print = 0.0
        while time.monotonic() < deadline:
            raw = word_bytes(j, address, size)
            row = {key: struct.unpack_from('<' + fmt, raw, offset)[0]
                   for key, (offset, fmt) in layout.items()}
            result['samples'].append(row)
            if row['fault_flags'] or row['latched_faults']:
                raise RuntimeError('Firmware fault during electrical calibration')
            if (not all(math.isfinite(row[k]) for k in ['ia_a', 'ib_a', 'velocity_rad_s', 'bus_v']) or
                    max(abs(row['ia_a']), abs(row['ib_a']), abs(-row['ia_a']-row['ib_a'])) > 1.0 or
                    abs(row['velocity_rad_s']) > 4.0):
                raise RuntimeError('Calibration current/speed guard exceeded')
            mode = u8('control_mode_cmd')
            enabled = u8('control_enable')
            calibrating = u8('control_calibrate_enable')
            status = u8('calibration_flash_status')
            sequence = u32('calibration_flash_sequence')
            saves = u32('calibration_flash_save_count')
            started |= mode == 13 or calibrating != 0
            now = time.monotonic()
            if now - last_print >= 1.0:
                print(f'  mode={mode} enable={enabled} calibrating={calibrating} '
                      f'flash_status={status} sequence={sequence}', flush=True)
                last_print = now
            if started and mode == 0 and enabled == 0 and calibrating == 0:
                if (status == 2 and u8('calibration_flash_valid') == 1 and
                        saves != before_saves and sequence != before_sequence):
                    break
                if status == 3:
                    raise RuntimeError('Calibration completed, but Flash save/read-back failed')
            time.sleep(0.1)
        else:
            raise RuntimeError('Calibration timed out or never started')

        if driver_enabled():
            raise RuntimeError('Driver remained enabled after calibration')
        saved_sequence = u32('calibration_flash_sequence')
        saved_zero = f32('control_electrical_zero_rad')
        saved_direction = u8('control_encoder_direction')
        if not (math.isfinite(saved_zero) and 0.0 <= saved_zero < 2.0 * math.pi):
            raise RuntimeError(f'Invalid calibrated zero: {saved_zero}')
        if saved_direction not in (0, 1):
            raise RuntimeError(f'Invalid encoder direction: {saved_direction}')
        print(f'SAVED sequence={saved_sequence} electrical_zero_rad={saved_zero:.8f} '
              f'encoder_direction={saved_direction}', flush=True)

        j.reset(halt=False)
        time.sleep(2.0)
        if j.halted() or driver_enabled():
            raise RuntimeError('Unsafe or failed boot after calibration reset')
        loaded_status = u8('calibration_flash_status')
        loaded_sequence = u32('calibration_flash_sequence')
        loaded_zero = f32('control_electrical_zero_rad')
        loaded_direction = u8('control_encoder_direction')
        if not (loaded_status == 1 and u8('calibration_flash_valid') == 1 and
                loaded_sequence == saved_sequence and
                loaded_direction == saved_direction and
                struct.pack('<f', loaded_zero) == struct.pack('<f', saved_zero)):
            raise RuntimeError('Calibration record was not restored correctly after reset')
        print(f'RELOAD VERIFIED sequence={loaded_sequence} '
              f'electrical_zero_rad={loaded_zero:.8f} '
              f'encoder_direction={loaded_direction}; driver disabled.', flush=True)
        result.update(passed=True, stopped=True, saved_sequence=saved_sequence,
                      electrical_zero_rad=saved_zero, encoder_direction=saved_direction,
                      reload_verified=True)
    except BaseException as exc:
        result['error'] = str(exc)
        if j.connected():
            try:
                uart.write(b'\nSTOP\n'); uart.flush()
                time.sleep(0.2)
                if driver_enabled() and firmware_matches:
                    j.memory_write8(symbols['control_debug_cmd'], [2])
                    time.sleep(0.2)
                if driver_enabled():
                    j.halt()
                    j.memory_write32(0x48001418, [1 << 16])
                result['stopped'] = not driver_enabled()
            except Exception:
                pass
        raise
    finally:
        uart.close()
        j.close()
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps(result, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
