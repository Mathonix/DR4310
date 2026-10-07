#ifndef HARDWARE_BRIDGE_H
#define HARDWARE_BRIDGE_H

#include "stm32g4xx_hal.h"

#ifdef __cplusplus
extern "C" {
#endif

extern DMA_HandleTypeDef hdma_adc1;
extern DMA_HandleTypeDef hdma_spi3_rx;
extern DMA_HandleTypeDef hdma_spi3_tx;

void CurrentSense_OnAdcComplete(ADC_HandleTypeDef *hadc);

#ifdef __cplusplus
}
#endif

#endif
