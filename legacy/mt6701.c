#include "mt6701.h"

#define MT6701_RESOLUTION_F 16384.0f
#define TWO_PI_F           6.28318530718f
#define RAD_TO_DEG_F       57.2957795131f

static SPI_HandleTypeDef *mt6701_spi;
static GPIO_TypeDef *mt6701_cs_port;
static uint16_t mt6701_cs_pin;

void MT6701_Init(SPI_HandleTypeDef *hspi, GPIO_TypeDef *cs_port, uint16_t cs_pin)
{
  GPIO_InitTypeDef gpio = {0};

  mt6701_spi = hspi;
  mt6701_cs_port = cs_port;
  mt6701_cs_pin = cs_pin;

  HAL_GPIO_WritePin(mt6701_cs_port, mt6701_cs_pin, GPIO_PIN_SET);

  gpio.Pin = mt6701_cs_pin;
  gpio.Mode = GPIO_MODE_OUTPUT_PP;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_HIGH;
  HAL_GPIO_Init(mt6701_cs_port, &gpio);
}

HAL_StatusTypeDef MT6701_Read(MT6701_Sample_t *sample)
{
  uint8_t tx[3] = {0};
  uint8_t rx[3] = {0};
  uint32_t raw24;
  HAL_StatusTypeDef status;

  if ((mt6701_spi == NULL) || (mt6701_cs_port == NULL) || (sample == NULL))
  {
    return HAL_ERROR;
  }

  HAL_GPIO_WritePin(mt6701_cs_port, mt6701_cs_pin, GPIO_PIN_RESET);
  status = HAL_SPI_TransmitReceive(mt6701_spi, tx, rx, sizeof(rx), 2U);
  HAL_GPIO_WritePin(mt6701_cs_port, mt6701_cs_pin, GPIO_PIN_SET);

  if (status != HAL_OK)
  {
    return status;
  }

  raw24 = ((uint32_t)rx[0] << 16) | ((uint32_t)rx[1] << 8) | rx[2];
  sample->rx[0] = rx[0];
  sample->rx[1] = rx[1];
  sample->rx[2] = rx[2];
  sample->angle_raw = (uint16_t)((raw24 >> 10) & 0x3FFFU);
  sample->status = (uint8_t)((raw24 >> 6) & 0x0FU);
  sample->crc = (uint8_t)(raw24 & 0x3FU);
  sample->angle_rad = ((float)sample->angle_raw / MT6701_RESOLUTION_F) * TWO_PI_F;
  sample->angle_deg = sample->angle_rad * RAD_TO_DEG_F;

  return HAL_OK;
}
