#ifndef CURRENT_SENSE_H
#define CURRENT_SENSE_H

#include "stm32g4xx_hal.h"

typedef struct
{
  float ia_a;
  float ib_a;
  float ic_a;
  uint16_t raw_a;
  uint16_t raw_b;
  uint16_t raw_bus;
  float bus_v;
} CurrentSenseSample_t;

#ifdef __cplusplus
extern "C" {
#endif

void CurrentSense_Init(ADC_HandleTypeDef *hadc);
HAL_StatusTypeDef CurrentSense_ConfigureScan(void);
HAL_StatusTypeDef CurrentSense_Calibrate(uint16_t samples);
/* Arm TIM1_TRGO2(OC4REF mid-window) + DMA circular sampling. */
HAL_StatusTypeDef CurrentSense_StartHw(void);
/* ISR-safe: convert latest DMA buffer to physical units. */
HAL_StatusTypeDef CurrentSense_GetLatest(CurrentSenseSample_t *sample);
/* Compatibility wrappers. */
HAL_StatusTypeDef CurrentSense_StartScan(void);
HAL_StatusTypeDef CurrentSense_ReadScanResult(CurrentSenseSample_t *sample);
HAL_StatusTypeDef CurrentSense_Read(CurrentSenseSample_t *sample);

/* Exposed for IRQ routing. */
extern DMA_HandleTypeDef hdma_adc1;
extern ADC_HandleTypeDef *CurrentSense_GetAdcHandle(void);

#ifdef __cplusplus
}
#endif

#endif
