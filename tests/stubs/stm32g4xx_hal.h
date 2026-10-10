/* Minimal host stub so App headers compile in host unit tests. */
#ifndef STM32G4XX_HAL_STUB_H
#define STM32G4XX_HAL_STUB_H
#include <stdint.h>
typedef struct { int dummy; } ADC_HandleTypeDef;
typedef struct { int dummy; } SPI_HandleTypeDef;
typedef struct { int dummy; } TIM_HandleTypeDef;
typedef struct { int dummy; } UART_HandleTypeDef;
#endif
