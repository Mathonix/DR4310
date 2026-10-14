"""Diagnostic entry checks and cleanup without opening UART or a real probe."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools import uart_brr_sweep as diagnostic


class FakeProbe:
    closed = False

    def __init__(self, flash=b'\x01\x02'):
        self.flash = flash

    def halted(self):
        return False

    def memory_read32(self, address, count):
        return [850 if address == diagnostic.BRR else 0]

    def memory_read8(self, address, count):
        return self.flash

    def close(self):
        self.closed = True


class DiagnosticSafety(unittest.TestCase):
    def test_no_run_does_not_read_elf_or_open_probe(self):
        with patch.object(sys, 'argv', ['uart_brr_sweep.py']), \
             patch.object(diagnostic, 'probe') as probe, \
             patch.object(diagnostic, 'image_metadata') as metadata:
            with self.assertRaises(SystemExit):
                diagnostic.main()
            probe.assert_not_called()
            metadata.assert_not_called()

    def test_mismatched_flash_closes_without_any_diagnostic_writes(self):
        probe = FakeProbe(b'\x03\x04')
        with patch.object(sys, 'argv', ['uart_brr_sweep.py', '--run']), \
             patch.object(diagnostic, 'probe', return_value=probe), \
             patch.object(diagnostic, 'image_metadata', return_value=([0x20001234, 0x20005678], [(0x08000000, b'\x01\x02')])), \
             patch.object(diagnostic, 'set_brr') as write, \
             patch.object(diagnostic, 'sweep') as sweep:
            with self.assertRaisesRegex(RuntimeError, 'differs from ELF'):
                diagnostic.main()
            write.assert_not_called()
            sweep.assert_not_called()
            self.assertTrue(probe.closed)

    def test_sweep_failure_restores_original_brr_and_closes_probe(self):
        probe = FakeProbe()
        with tempfile.TemporaryDirectory() as folder, \
             patch.object(sys, 'argv', ['uart_brr_sweep.py', '--run']), \
             patch.object(diagnostic, 'probe', return_value=probe), \
             patch.object(diagnostic, 'image_metadata', return_value=([0x20001234, 0x20005678], [(0x08000000, b'\x01\x02')])), \
             patch.object(diagnostic, 'OUT', Path(folder)), \
             patch.object(diagnostic, 'ADDR_ERR', None), \
             patch.object(diagnostic, 'ADDR_BITS', None), \
             patch.object(diagnostic, 'set_brr') as write, \
             patch.object(diagnostic, 'sweep', side_effect=RuntimeError('serial failed')):
            with self.assertRaisesRegex(RuntimeError, 'serial failed'):
                diagnostic.main()
            self.assertEqual(diagnostic.ADDR_ERR, 0x20001234)
            self.assertEqual(diagnostic.ADDR_BITS, 0x20005678)
            write.assert_called_once_with(probe, 850)
            self.assertTrue(probe.closed)
