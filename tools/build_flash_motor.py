#!/usr/bin/env python3
"""Build an ID-specific image; optional safe J-Link flash. Never starts the motor."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
CALIBRATION_START = 0x0801F000
CALIBRATION_SIZE = 0x1000

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--motor-id', type=int, choices=range(1, 8), required=True)
    parser.add_argument('--flash', action='store_true')
    parser.add_argument('--serial-port', default='COM5')
    parser.add_argument('--jlink-serial', type=int, default=29534567)
    parser.add_argument('--jlink-dll', default=r'C:\Program Files\SEGGER\JLink_V930a\JLink_x64.dll')
    args = parser.parse_args()
    env = os.environ.copy()
    if not shutil.which('arm-none-eabi-gcc', path=env['PATH']):
        bins = sorted((Path.home() / 'tools').glob('arm-gnu-toolchain-*/bin'))
        if not bins:
            raise RuntimeError('Put arm-none-eabi-gcc on PATH first')
        env['PATH'] = str(bins[-1]) + os.pathsep + env['PATH']
    subprocess.run(['cmake', '--preset', 'Release', f'-DMOTOR_CAN_ID={args.motor_id}'],
                   cwd=ROOT, env=env, check=True)
    subprocess.run(['cmake', '--build', '--preset', 'Release'], cwd=ROOT, env=env, check=True)
    elf_path = ROOT / 'build/Release/4310_G431KBT6.elf'
    from elftools.elf.elffile import ELFFile
    with elf_path.open('rb') as file:
        elf = ELFFile(file)
        sym = elf.get_section_by_name('.symtab').get_symbol_by_name('can_node_id')[0]
        section = elf.get_section(sym['st_shndx'])
        image_id = section.data()[sym['st_value'] - section['sh_addr']]
        assert image_id == args.motor_id, 'ELF ID mismatch'
        # J-Link loads allocated sections, not ELF alignment padding between them.
        segments = []
        for section in elf.iter_sections():
            if not (section['sh_flags'] & 2) or section['sh_type'] == 'SHT_NOBITS' or not section['sh_size']:
                continue
            for segment in elf.iter_segments():
                offset = section['sh_addr'] - segment['p_vaddr']
                if (segment['p_type'] == 'PT_LOAD' and offset >= 0 and
                        offset + section['sh_size'] <= segment['p_filesz']):
                    address = segment['p_paddr'] + offset
                    if 0x08000000 <= address < 0x08020000:
                        segments.append((address, section.data()))
                    break
        assert segments
        for address, data in segments:
            assert address + len(data) <= CALIBRATION_START, (
                f'ELF overlaps calibration Flash at 0x{address:08X}')
        node_address = sym['st_value']
    manifest = {'motor_id': image_id, 'feedback_id': hex(0x204+image_id),
                'command_id': hex(0x1FE if image_id <= 4 else 0x2FE),
                'elf_sha256': hashlib.sha256(elf_path.read_bytes()).hexdigest(),
                'flash_verified': False}
    manifest_path = elf_path.with_suffix('.manifest.json')
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print('IMAGE', json.dumps(manifest), flush=True)
    if not args.flash:
        return
    import pylink
    import serial
    uart = None
    j = pylink.JLink(lib=pylink.library.Library(dllpath=args.jlink_dll))
    try:
        j.open(serial_no=args.jlink_serial)
        j.set_tif(pylink.enums.JLinkInterfaces.SWD)
        j.connect('STM32G431KB', speed=1000)
        try:
            uart = serial.Serial(args.serial_port, 115200, timeout=.1, write_timeout=1)
        except serial.SerialException as exc:
            print('UART unavailable; flash allowed only if driver already disabled:', exc)
        if uart and not j.halted():
            uart.write(b'\nSTOP\n'); uart.flush(); time.sleep(.3)
        assert not (j.memory_read32(0x48001414, 1)[0] & 1), 'Driver enabled: stop motor first'
        time.sleep(.5)
        # Snapshot the two reserved calibration pages. Firmware updates must not
        # erase motor-specific calibration data.
        calibration_before = bytes(j.memory_read8(CALIBRATION_START, CALIBRATION_SIZE))
        j.halt()
        assert j.halted()
        j.memory_write32(0x48001418, [1 << 16])  # PF0 driver disable
        # CPU halt does not stop ADC/SPI DMA. Prevent SRAM downloader corruption.
        for base in (0x40020000, 0x40020400):
            for channel in range(6):
                j.memory_write32(base + 8 + 20*channel, [0])
        j.flash_file(str(elf_path), 0x08000000)
        calibration_after = bytes(j.memory_read8(CALIBRATION_START, CALIBRATION_SIZE))
        assert calibration_after == calibration_before, (
            'Firmware flashing changed reserved calibration pages')
        for address, data in segments:
            assert bytes(j.memory_read8(address, len(data))) == data, 'Flash segment mismatch'
        assert j.memory_read8(node_address, 1)[0] == args.motor_id
        j.reset(halt=False)
        time.sleep(2)
        assert not j.halted(), 'Boot failed'
        assert not (j.memory_read32(0x48001414, 1)[0] & 1), 'Unexpected motor enable'
        manifest['flash_verified'] = True
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
        print('FLASH VERIFIED; motor ID', image_id, '; driver disabled. No RUN issued.', flush=True)
    except BaseException:
        if j.connected():
            j.halt(); j.memory_write32(0x48001418, [1 << 16])
        raise
    finally:
        if uart: uart.close()
        j.close()

if __name__ == '__main__':
    main()
