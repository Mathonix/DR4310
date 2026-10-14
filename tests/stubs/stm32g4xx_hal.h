/* Minimal host stub so App headers compile in host unit tests. */
#ifndef STM32G4XX_HAL_STUB_H
#define STM32G4XX_HAL_STUB_H
#include <stdint.h>
typedef struct { int dummy; } ADC_HandleTypeDef;
typedef struct { int dummy; } SPI_HandleTypeDef;
typedef struct { int dummy; } TIM_HandleTypeDef;
typedef struct { int dummy; } UART_HandleTypeDef;
typedef enum { HAL_OK = 0, HAL_ERROR = 1 } HAL_StatusTypeDef;
typedef struct { uint32_t TypeErase, Banks, Page, NbPages; } FLASH_EraseInitTypeDef;
#define FLASH_BASE 0x08000000UL
#define FLASH_PAGE_SIZE 2048U
#define FLASH_FLAG_ALL_ERRORS 0U
#define FLASH_TYPEERASE_PAGES 0U
#define FLASH_BANK_1 0U
#define FLASH_TYPEPROGRAM_DOUBLEWORD 0U
#define __HAL_FLASH_CLEAR_FLAG(flags) ((void)(flags))
HAL_StatusTypeDef HAL_FLASH_Unlock(void);
HAL_StatusTypeDef HAL_FLASH_Lock(void);
HAL_StatusTypeDef HAL_FLASHEx_Erase(FLASH_EraseInitTypeDef *erase, uint32_t *error);
HAL_StatusTypeDef HAL_FLASH_Program(uint32_t type, uint32_t address, uint64_t data);
#endif
