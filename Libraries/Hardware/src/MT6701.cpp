#include "MT6701.hpp"

namespace hardware {

namespace {

constexpr float kResolutionF = 16384.0f;
constexpr float kTwoPiF = 6.28318530718f;
constexpr float kRadToDegF = 57.2957795131f;
constexpr uint8_t kCrcPoly = 0x30U;
constexpr uint8_t kCrcInit = 0x00U;
constexpr uint8_t kCrcXorOut = 0x00U;

uint8_t crc6(uint32_t data) {
  uint8_t crc = kCrcInit;
  for (uint8_t bit = 0U; bit < 18U; ++bit) {
    crc ^= static_cast<uint8_t>((data >> (17U - bit)) & 0x01U);
    if ((crc & 0x01U) != 0U) {
      crc = static_cast<uint8_t>((crc >> 1U) ^ kCrcPoly);
    } else {
      crc = static_cast<uint8_t>(crc >> 1U);
    }
  }
  uint8_t reflected = 0U;
  for (uint8_t bit = 0U; bit < 6U; ++bit) {
    if ((crc & (1U << bit)) != 0U) {
      reflected |= static_cast<uint8_t>(1U << (5U - bit));
    }
  }
  return static_cast<uint8_t>((reflected ^ kCrcXorOut) & 0x3FU);
}

}  // namespace

MT6701::MT6701(SPI_HandleTypeDef &spi,
               GPIO_TypeDef &cs_port,
               uint16_t cs_pin) {
  init(spi, cs_port, cs_pin);
}

void MT6701::init(SPI_HandleTypeDef &spi,
                  GPIO_TypeDef &cs_port,
                  uint16_t cs_pin) {
  spi_ = &spi;
  cs_port_ = &cs_port;
  cs_pin_ = cs_pin;

  HAL_GPIO_WritePin(cs_port_, cs_pin_, GPIO_PIN_SET);

  GPIO_InitTypeDef gpio = {};
  gpio.Pin = cs_pin_;
  gpio.Mode = GPIO_MODE_OUTPUT_PP;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_HIGH;
  HAL_GPIO_Init(cs_port_, &gpio);
}

HAL_StatusTypeDef MT6701::read(EncoderSample &sample) {
  if ((spi_ == nullptr) || (cs_port_ == nullptr)) {
    return HAL_ERROR;
  }

  uint8_t tx[3] = {};
  uint8_t rx[3] = {};

  HAL_GPIO_WritePin(cs_port_, cs_pin_, GPIO_PIN_RESET);
  const HAL_StatusTypeDef status =
      HAL_SPI_TransmitReceive(spi_, tx, rx, sizeof(rx), 2U);
  HAL_GPIO_WritePin(cs_port_, cs_pin_, GPIO_PIN_SET);

  if (status != HAL_OK) {
    health_.spi_error_count++;
    health_.consecutive_error_count++;
    return status;
  }

  const uint32_t raw24 =
      (static_cast<uint32_t>(rx[0]) << 16) |
      (static_cast<uint32_t>(rx[1]) << 8) |
      static_cast<uint32_t>(rx[2]);
  sample.rx[0] = rx[0];
  sample.rx[1] = rx[1];
  sample.rx[2] = rx[2];
  sample.angle_raw = static_cast<uint16_t>((raw24 >> 10) & 0x3FFFU);
  sample.status = static_cast<uint8_t>((raw24 >> 6) & 0x0FU);
  sample.crc = static_cast<uint8_t>(raw24 & 0x3FU);
  sample.crc_ok = sample.crc == crc6((raw24 >> 6U) & 0x3FFFFU);
  sample.status_ok = (sample.status == 0U);
  sample.angle_rad =
      (static_cast<float>(sample.angle_raw) / kResolutionF) * kTwoPiF;
  sample.angle_deg = sample.angle_rad * kRadToDegF;

  if (!sample.crc_ok || !sample.status_ok) {
    if (!sample.crc_ok) {
      health_.crc_error_count++;
    }
    if (!sample.status_ok) {
      health_.status_error_count++;
    }
    health_.consecutive_error_count++;
    return HAL_ERROR;
  }

  health_.consecutive_error_count = 0U;
  return HAL_OK;
}

const EncoderHealth &MT6701::health() const {
  return health_;
}

}  // namespace hardware
