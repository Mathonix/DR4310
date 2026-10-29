"""Numerical regression on real math sources; never opens serial or SWD."""
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class FocOffline(unittest.TestCase):
    def test_wrap_boundaries_and_random_float_patterns(self):
        # Validate both the previous size setting and the selected speed setting.
        for optimization in ('-Os', '-O2'):
            with self.subTest(optimization=optimization), tempfile.TemporaryDirectory() as folder:
                binary = Path(folder) / 'angles.exe'
                subprocess.run(['g++', '-std=c++17', optimization, '-Wall', '-Wextra',
                                '-ILibraries/Control/inc', 'tests/test_angle_wrap.cpp',
                                'Libraries/Control/src/electrical_angle.cpp', '-o', str(binary)],
                               cwd=ROOT, check=True)
                subprocess.run([str(binary)], check=True)

    def test_complete_foc_matches_reference_trace(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            (folder / 'stm32g4xx_hal.h').write_text(r'''
#pragma once
#include <cstdint>
struct ADC_HandleTypeDef {};
struct DMA_HandleTypeDef {};
struct TIM_HandleTypeDef { uint32_t period=2124, compare[3]={}; };
enum FunctionalState { DISABLE, ENABLE };
enum HAL_StatusTypeDef { HAL_OK, HAL_ERROR };
inline uint32_t __get_PRIMASK() { return 0; }
inline void __disable_irq() {}
inline void __set_PRIMASK(uint32_t) {}
#define TIM_CHANNEL_1 0
#define TIM_CHANNEL_2 1
#define TIM_CHANNEL_3 2
#define __HAL_TIM_GET_AUTORELOAD(t) ((t)->period)
#define __HAL_TIM_SET_COMPARE(t,ch,value) ((t)->compare[ch]=(value))
''', encoding='utf-8')
            reference = folder / 'reference'
            reference.mkdir()
            # The pre-optimization wrap formulas, compiled into the same real
            # FOC sources; only the arithmetic optimization/flags differ.
            (reference / 'AngleWrap.hpp').write_text(r'''
#pragma once
#include <cmath>
namespace control::angle {
inline float Wrap0To2Pi(float a) {
  a=std::fmod(a,6.28318530718f); if(a<0) a+=6.28318530718f; return a;
}
inline float WrapPmPi(float a) {
  a=std::fmod(a,6.28318530718f);
  if(a>3.14159265359f) a-=6.28318530718f;
  else if(a< -3.14159265359f) a+=6.28318530718f; return a;
}
}
''', encoding='utf-8')
            traces = []
            for label, flags in (
                ('reference', ['-Os', '-I' + str(reference)]),
                ('optimized', ['-O2']),
            ):
                binary, trace = folder / (label + '.exe'), folder / (label + '.bin')
                subprocess.run(['g++', '-std=c++17', *flags, '-DDR4310_AUDIO_ENABLED=0',
                                '-I' + str(folder), '-ILibraries/App/inc',
                                '-ILibraries/Control/inc', '-ILibraries/Hardware/inc',
                                'tests/test_foc_numeric.cpp',
                                *['Libraries/Control/src/' + name + '.cpp' for name in (
                                    'foc_control', 'current_loop', 'pid', 'svpwm',
                                    'motor_params', 'cogging_compensator', 'electrical_angle')],
                                '-o', str(binary)], cwd=ROOT, check=True)
                subprocess.run([str(binary), str(trace)], check=True)
                traces.append(trace.read_bytes())
            self.assertEqual(len(traces[0]), 20000 * (22 + 8) * 4)
            self.assertEqual(traces[0], traces[1], 'FOC float outputs / PWM / faults must match bitwise')


if __name__ == '__main__':
    unittest.main()
