#ifndef HARDWARE_BRIDGE_H
#define HARDWARE_BRIDGE_H

#include "stm32g4xx_hal.h"

#ifdef __cplusplus
extern "C" {
#endif

extern DMA_HandleTypeDef hdma_adc1;

void CurrentSense_OnAdcComplete(ADC_HandleTypeDef *hadc);

#ifdef __cplusplus
}
#endif

#endif
