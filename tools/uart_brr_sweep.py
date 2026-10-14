"""Sweep USART1 BRR around 230400 to find the J-Link's actual baud rate.

The J-Link SAM-ICE VCOM may not generate exactly 230400; the MCU auto-baud
diagnostic measured BRR=729 (~233196) instead of 738 (230400).  This tool
sets the MCU BRR via SWD, sends bulk data PC->MCU, reads the hardware error
counter via SWD, and sends INFO to test MCU->PC reply integrity.

Usage: python tools/uart_brr_sweep.py --run --elf build/Release/4310_G431KBT6.elf
The ELF must match the running firmware. Requires a stopped motor and exclusive
UART access. Changing UE/BRR disturbs RX DMA; reset the stopped target afterwards.
Output: logs/uart_brr_sweep_YYYYMMDD/sweep.json
"""
import argparse, json, re, time
from pathlib import Path
import serial, pylink

ROOT = Path(__file__).resolve().parents[1]
OUT  = Path(ROOT/'logs'/f'uart_brr_sweep_{time.strftime("%Y%m%d")}')

DLL       = r'C:\Program Files\SEGGER\JLink_V930a\JLink_x64.dll'
SERIAL_NO = 29534567
UART      = 0x40013800            # USART1 base
CR1       = UART + 0x00           # Control register 1
BRR       = UART + 0x0C           # Baud rate register
ICR       = UART + 0x20            # Interrupt flag clear
GPIOF_ODR = 0x48001414             # DRV enable is PF0
# Resolve these from the matching image: RAM layout changes with every build.
ADDR_ERR  = None
ADDR_BITS = None
PORT = 'COM5'
CLOCK     = 170_000_000

def image_metadata(path):
    from elftools.elf.elffile import ELFFile
    with Path(path).open('rb') as file:
        elf = ELFFile(file)
        symbols = elf.get_section_by_name('.symtab')
        if symbols is None:
            raise ValueError('ELF has no symbol table')
        addresses = []
        for name in ('g_uart_rx_hw_errors', 'g_uart_rx_last_hw_error'):
            found = [s['st_value'] for s in symbols.iter_symbols()
                     if name in s.name and s['st_info']['type'] == 'STT_OBJECT'
                     and s['st_size'] == 4 and 0x20000000 <= s['st_value'] <= 0x20007ffc
                     and s['st_value'] % 4 == 0]
            if len(found) != 1:
                raise ValueError(f'ELF must contain one SRAM counter: {name}')
            addresses.append(found[0])
        sections = []
        for section in elf.iter_sections():
            if not section['sh_flags'] & 2 or section['sh_type'] == 'SHT_NOBITS' or not section['sh_size']:
                continue
            for segment in elf.iter_segments():
                offset = section['sh_addr'] - segment['p_vaddr']
                if segment['p_type'] == 'PT_LOAD' and offset >= 0 and offset + section['sh_size'] <= segment['p_filesz']:
                    address = segment['p_paddr'] + offset
                    if 0x08000000 <= address < 0x08020000:
                        sections.append((address, section.data()))
                    break
        if not sections:
            raise ValueError('ELF has no allocated Flash sections')
    return addresses, sections

def verify_image(j, sections):
    for address, data in sections:
        if bytes(j.memory_read8(address, len(data))) != data:
            raise RuntimeError('Running Flash differs from ELF; no diagnostic writes performed')

def probe():
    j = pylink.JLink(lib=pylink.library.Library(dllpath=DLL))
    try:
        j.open(serial_no=SERIAL_NO)
        j.set_tif(pylink.enums.JLinkInterfaces.SWD)
        j.connect('STM32G431KB', speed=1000)
    except BaseException:
        j.close(); raise
    return j

def set_brr(j, value):
    cr1 = j.memory_read32(CR1, 1)[0]
    j.memory_write32(CR1, [cr1 & ~1])          # UE=0 disable
    j.memory_write32(BRR, [value])
    j.memory_write32(ICR, [0xFFFFFFFF])        # clear all flags
    j.memory_write32(CR1, [cr1])               # UE=1 re-enable

def read_err(j):  return j.memory_read32(ADDR_ERR, 1)[0]
def read_bits(j): return j.memory_read32(ADDR_BITS, 1)[0]
def reset_err(j): j.memory_write32(ADDR_ERR, [0]); j.memory_write32(ADDR_BITS, [0])

def driver_ok(j): return not (j.memory_read32(GPIOF_ODR, 1)[0] & 1)

def test_pcxmcu(j, brr, duration=3.0):
    """Send 0x55 pattern PC->MCU, count hardware errors via SWD."""
    set_brr(j, brr); reset_err(j); time.sleep(0.05)
    port = serial.Serial(PORT, 230400, timeout=0.05, write_timeout=2)
    sent = 0
    try:
        pkt = bytes([0x55]) * 180
        t0 = time.monotonic()
        while time.monotonic() - t0 < duration:
            port.write(pkt); port.flush(); sent += len(pkt)
            time.sleep(0.002)
        time.sleep(0.3)
    finally:
        port.close()
    return {'sent': sent, 'errors': read_err(j), 'errbits': read_bits(j)}

def test_info(brr, attempts=4):
    """Send INFO, check if reply is a valid @INFO line (tests both directions)."""
    port = serial.Serial(PORT, 230400, timeout=0.12, write_timeout=1)
    ok = 0; samples = []
    try:
        for _ in range(attempts):
            port.reset_input_buffer()
            port.write(b'INFO\n'); port.flush()
            time.sleep(0.15)
            raw = port.read(1024)
            lines = re.findall(rb'@[A-Z][A-Za-z0-9_ =.,:/+|\-]*[\r\n]', raw)
            valid = any(l.startswith(b'@INFO ') and b'drv=' in l and b'uart_errors=' in l for l in lines)
            if valid: ok += 1
            if len(samples) < 2: samples.append(raw[:120])
    finally:
        port.close()
    return {'ok': ok, 'attempts': attempts, 'samples': [s.hex() for s in samples]}

def sweep(j):
    orig = j.memory_read32(BRR, 1)[0]
    print(f'Original BRR={orig}  baud={CLOCK//orig}')
    print(f'Output: {OUT/"sweep.json"}')

    # Stop motor at current baud (try original first, then 200000, then 230400)
    for baud_try in [CLOCK//orig, 200000, 230400]:
        try:
            with serial.Serial(PORT, baud_try, timeout=0.1, write_timeout=1) as p:
                p.reset_input_buffer(); p.write(b'STOP\n'); p.flush(); time.sleep(0.2)
                p.read(256)
            print(f'STOP sent at {baud_try}')
            break
        except Exception as e:
            print(f'STOP at {baud_try} failed: {e}')

    time.sleep(0.3)
    assert driver_ok(j), 'DRV still enabled after STOP'
    print('Driver disabled, starting sweep...\n')

    brr_values = list(range(726, 743))  # 726..742, covers 729 and 738
    results = []
    for brr in brr_values:
        assert driver_ok(j), 'Driver enabled during diagnostic'
        baud = CLOCK // brr
        tx = test_pcxmcu(j, brr, duration=3.0)
        rx = test_info(brr, attempts=4)
        r = {'brr': brr, 'baud': baud, 'delta_pct': (baud-230400)/230400*100,
             'pcxmcu_errors': tx['errors'], 'pcxmcu_errbits': tx['errbits'],
             'pcxmcu_sent': tx['sent'],
             'mcu_tx_ok': rx['ok'], 'mcu_tx_attempts': rx['attempts']}
        results.append(r)
        flag = '  <<< BEST' if tx['errors'] == 0 and rx['ok'] == rx['attempts'] else ''
        print(f'BRR={brr:3d} baud={baud:7d} Δ={r["delta_pct"]:+.2f}%  '
              f'PC→MCU err={tx["errors"]:3d}  MCU→TX ok={rx["ok"]}/{rx["attempts"]}{flag}')
        (OUT/'sweep.json').write_text(json.dumps({'original_brr': orig, 'results': results}, indent=2), encoding='utf-8')

    # Summary
    best = [r for r in results if r['pcxmcu_errors'] == 0]
    bidir = [r for r in best if r['mcu_tx_ok'] == r['mcu_tx_attempts']]
    print(f'\n=== Summary ===')
    print(f'PC→MCU clean (0 errors): BRR {[r["brr"] for r in best]}')
    print(f'Bidirectional clean:     BRR {[r["brr"] for r in bidir]}')
    if bidir:
        b = bidir[0]
        print(f'>>> Recommended BRR={b["brr"]} (baud {b["baud"]}, Δ={b["delta_pct"]:+.2f}%)')
    else:
        print('>>> No clean bidirectional BRR in this experiment; compare with an independent UART adapter')

def main():
    global ADDR_ERR, ADDR_BITS, PORT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--elf', type=Path, default=ROOT/'build/Release/4310_G431KBT6.elf')
    parser.add_argument('--port', default='COM5')
    args = parser.parse_args()
    if not args.run:
        parser.error('Hardware diagnostic requires explicit --run and a matching --elf')
    addresses, sections = image_metadata(args.elf)
    PORT = args.port
    j = probe()
    orig = None
    try:
        assert not j.halted(), 'Target halted — release reset first'
        assert driver_ok(j), 'DRV enable is ON — STOP the motor first'
        verify_image(j, sections)
        ADDR_ERR, ADDR_BITS = addresses
        orig = j.memory_read32(BRR, 1)[0]
        OUT.mkdir(parents=True, exist_ok=True)
        sweep(j)
    finally:
        try:
            if orig is not None:
                set_brr(j, orig)
                print(f'Restored BRR={orig}; reset the stopped target before normal UART use')
        finally:
            j.close()

if __name__ == '__main__':
    main()
