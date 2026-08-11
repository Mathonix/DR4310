#ifndef MT6701_H
#define MT6701_H

#include "stm32g4xx_hal.h"

typedef struct
{
  uint8_t rx[3];
  uint16_t angle_raw;
  float angle_rad;
  float angle_deg;
  uint8_t status;
  uint8_t crc;
} MT6701_Sample_t;

#ifdef __cplusplus
extern "C" {
#endif

void MT6701_Init(SPI_HandleTypeDef *hspi, GPIO_TypeDef *cs_port, uint16_t cs_pin);
HAL_StatusTypeDef MT6701_Read(MT6701_Sample_t *sample);

#ifdef __cplusplus
}
#endif

#endif
