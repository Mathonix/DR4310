#ifndef DMA_IRQ_CONTROLS_H
#define DMA_IRQ_CONTROLS_H

#include "stm32g4xx_hal.h"

#ifndef DR4310_ADC_HALF_IRQ
#define DR4310_ADC_HALF_IRQ 0
#endif
#ifndef DR4310_ENCODER_HALF_IRQ
#define DR4310_ENCODER_HALF_IRQ 0
#endif

/* Only the unused HT source/flag changes. Completion and error handling stay
 * enabled. Call after HAL start: HAL installs its own half callbacks each time. */
static inline void DmaIrq_ConfigureAdc(DMA_HandleTypeDef *dma) {
#if !DR4310_ADC_HALF_IRQ
  __HAL_DMA_DISABLE_IT(dma, DMA_IT_HT);
  __HAL_DMA_CLEAR_FLAG(dma, __HAL_DMA_GET_HT_FLAG_INDEX(dma));
#else
  (void)dma;
#endif
}

static inline void DmaIrq_ConfigureEncoderRx(DMA_HandleTypeDef *dma) {
#if !DR4310_ENCODER_HALF_IRQ
  __HAL_DMA_DISABLE_IT(dma, DMA_IT_HT);
  __HAL_DMA_CLEAR_FLAG(dma, __HAL_DMA_GET_HT_FLAG_INDEX(dma));
#else
  (void)dma;
#endif
}

#endif
