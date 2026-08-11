#ifndef MT6701_HPP
#define MT6701_HPP

#include "stm32g4xx_hal.h"

#include <cstdint>

namespace hardware {

struct EncoderSample {
  uint8_t rx[3] = {};
  uint16_t angle_raw = 0U;
  float angle_rad = 0.0f;
  float angle_deg = 0.0f;
  uint8_t status = 0U;
  uint8_t crc = 0U;
  bool crc_ok = false;
  bool status_ok = false;
};

struct EncoderHealth {
  uint32_t crc_error_count = 0U;
  uint32_t spi_error_count = 0U;
  uint32_t status_error_count = 0U;
  uint32_t consecutive_error_count = 0U;
};

class MT6701 {
 public:
  MT6701() = default;
  MT6701(SPI_HandleTypeDef &spi,
         GPIO_TypeDef &cs_port,
         uint16_t cs_pin);
  MT6701(const MT6701 &) = delete;
  MT6701 &operator=(const MT6701 &) = delete;

  void init(SPI_HandleTypeDef &spi,
            GPIO_TypeDef &cs_port,
            uint16_t cs_pin);
  HAL_StatusTypeDef read(EncoderSample &sample);
  const EncoderHealth &health() const;

 private:
  SPI_HandleTypeDef *spi_ = nullptr;
  GPIO_TypeDef *cs_port_ = nullptr;
  uint16_t cs_pin_ = 0U;
  EncoderHealth health_ = {};
};

}  // namespace hardware

#endif
