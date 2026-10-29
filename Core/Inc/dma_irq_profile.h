#ifndef DMA_IRQ_PROFILE_H
#define DMA_IRQ_PROFILE_H

#include "stm32g4xx_hal.h"
#ifndef DR4310_IRQ_PROFILE
#define DR4310_IRQ_PROFILE 0
#endif

#if DR4310_IRQ_PROFILE
typedef struct {
  uint32_t irq_count;
  uint32_t half_count;
  uint32_t full_count;
  uint32_t other_count;
  uint32_t body_cycles;
  uint32_t max_body_cycles;
} DmaIrqProfile;

/* 0 = ADC1, 1 = encoder RX, 2 = encoder TX. Independent slots are safe
 * against ADC preemption. RX/TX elapsed time can include ADC preemption;
 * do not sum channels and call that total CPU load. */
extern volatile DmaIrqProfile g_dma_irq_profile[3];

static inline uint32_t DmaIrqProfile_Begin(unsigned slot, DMA_HandleTypeDef *dma) {
  const uint32_t start = DWT->CYCCNT;
  g_dma_irq_profile[slot].irq_count++;
  if (__HAL_DMA_GET_FLAG(dma, __HAL_DMA_GET_HT_FLAG_INDEX(dma)) &&
      (dma->Instance->CCR & DMA_IT_HT)) {
    g_dma_irq_profile[slot].half_count++;
  } else if (__HAL_DMA_GET_FLAG(dma, __HAL_DMA_GET_TC_FLAG_INDEX(dma)) &&
             (dma->Instance->CCR & DMA_IT_TC)) {
    g_dma_irq_profile[slot].full_count++;
  } else {
    g_dma_irq_profile[slot].other_count++;
  }
  return start;
}

static inline void DmaIrqProfile_End(unsigned slot, uint32_t start) {
  const uint32_t cycles = DWT->CYCCNT - start;
  g_dma_irq_profile[slot].body_cycles += cycles;
  if (cycles > g_dma_irq_profile[slot].max_body_cycles)
    g_dma_irq_profile[slot].max_body_cycles = cycles;
}
#else
static inline uint32_t DmaIrqProfile_Begin(unsigned slot, DMA_HandleTypeDef *dma) {
  (void)slot; (void)dma; return 0;
}
static inline void DmaIrqProfile_End(unsigned slot, uint32_t start) {
  (void)slot; (void)start;
}
#endif
#endif
