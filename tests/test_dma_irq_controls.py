"""Exercise the real IRQ controls/profiler with register-only host stubs."""
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
STUB = r'''
#pragma once
#include <cstdint>
struct Channel { uint32_t CCR; };
struct DMA_HandleTypeDef { Channel *Instance; uint32_t flags; };
struct CycleClock { uint32_t CYCCNT; };
extern CycleClock clock_register;
#define DWT (&clock_register)
#define DMA_IT_TC 2U
#define DMA_IT_HT 4U
#define DMA_IT_TE 8U
#define __HAL_DMA_DISABLE_IT(dma,bits) ((dma)->Instance->CCR &= ~(bits))
#define __HAL_DMA_GET_HT_FLAG_INDEX(dma) 0x40U
#define __HAL_DMA_GET_TC_FLAG_INDEX(dma) 0x20U
#define __HAL_DMA_GET_FLAG(dma,bits) ((dma)->flags & (bits))
#define __HAL_DMA_CLEAR_FLAG(dma,bits) ((dma)->flags &= ~(bits))
'''
TEST = r'''
#include "DmaIrqControls.h"
#include "dma_irq_profile.h"
#include <cassert>
CycleClock clock_register{};
#if DR4310_IRQ_PROFILE
volatile DmaIrqProfile g_dma_irq_profile[3]{};
#endif
int main() {
  constexpr uint32_t ccr=DMA_IT_HT|DMA_IT_TC|DMA_IT_TE|0x100U;
  constexpr uint32_t flags=0x40U|0x20U|0x80U;
  Channel adc{ccr},rx{ccr},uart{ccr};
  DMA_HandleTypeDef a{&adc,flags},r{&rx,flags},u{&uart,flags};
  for (unsigned repeat=0;repeat<3;++repeat) {
    // HAL SPI start reinstalls HT every transfer. The post-start control
    // must disable it again without disturbing TC, TE or unrelated flags.
    adc.CCR=rx.CCR=ccr; a.flags=r.flags=flags;
    DmaIrq_ConfigureAdc(&a); DmaIrq_ConfigureEncoderRx(&r);
    assert(adc.CCR==(DR4310_ADC_HALF_IRQ?ccr:(ccr&~DMA_IT_HT)));
    assert(rx.CCR==(DR4310_ENCODER_HALF_IRQ?ccr:(ccr&~DMA_IT_HT)));
    assert(a.flags==(DR4310_ADC_HALF_IRQ?flags:(flags&~0x40U)));
    assert(r.flags==(DR4310_ENCODER_HALF_IRQ?flags:(flags&~0x40U)));
    assert(u.Instance->CCR==ccr && u.flags==flags);
  }
  clock_register.CYCCNT=100; adc.CCR=ccr; a.flags=flags;
  uint32_t start=DmaIrqProfile_Begin(0,&a);
  clock_register.CYCCNT=160; DmaIrqProfile_End(0,start);
#if DR4310_IRQ_PROFILE
  assert(g_dma_irq_profile[0].irq_count==1);
  assert(g_dma_irq_profile[0].half_count==1 && g_dma_irq_profile[0].full_count==0);
  assert(g_dma_irq_profile[0].body_cycles==60 && g_dma_irq_profile[0].max_body_cycles==60);
  // With HT disabled a stale HT flag must not hide the real TC dispatch.
  adc.CCR &= ~DMA_IT_HT;
  clock_register.CYCCNT=0xfffffff0U; start=DmaIrqProfile_Begin(0,&a);
  clock_register.CYCCNT=0x20U; DmaIrqProfile_End(0,start);
  assert(g_dma_irq_profile[0].irq_count==2 && g_dma_irq_profile[0].full_count==1);
  assert(g_dma_irq_profile[0].body_cycles==108);
  assert(g_dma_irq_profile[1].irq_count==0 && g_dma_irq_profile[2].irq_count==0);
#endif
}
'''

class DmaIrqControls(unittest.TestCase):
    def test_flags_repeat_start_error_preservation_and_timing_wrap(self):
        for adc,rx,profile in ((1,1,1),(0,1,1),(0,0,1),(0,0,0)):
            with self.subTest(adc=adc,rx=rx,profile=profile), tempfile.TemporaryDirectory() as folder:
                folder=Path(folder)
                (folder/'stm32g4xx_hal.h').write_text(STUB,encoding='utf-8')
                source=folder/'test.cpp';source.write_text(TEST,encoding='utf-8')
                binary=folder/'test.exe'
                subprocess.run(['g++','-std=c++17','-O2','-Wall','-Wextra',
                                '-I'+str(folder),'-ILibraries/Hardware/inc','-ICore/Inc',
                                f'-DDR4310_ADC_HALF_IRQ={adc}',f'-DDR4310_ENCODER_HALF_IRQ={rx}',
                                f'-DDR4310_IRQ_PROFILE={profile}',str(source),'-o',str(binary)],
                               cwd=ROOT,check=True)
                subprocess.run([str(binary)],check=True)

if __name__=='__main__': unittest.main()
