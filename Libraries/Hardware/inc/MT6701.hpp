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
  uint32_t timestamp_cycles = 0U;
  uint32_t sequence = 0U;
  bool valid = false;
};

struct EncoderHealth {
  uint32_t crc_error_count = 0U;
  uint32_t spi_error_count = 0U;
  uint32_t status_error_count = 0U;
  uint32_t consecutive_error_count = 0U;
  uint32_t valid_sample_count = 0U;
  uint32_t dma_start_fail_count = 0U;
  uint32_t dma_error_count = 0U;
  uint32_t missed_trigger_count = 0U;
  uint32_t dma_callback_max_us = 0U;
  uint32_t last_valid_timestamp_cycles = 0U;
  uint32_t last_valid_sequence = 0U;
  float last_valid_angle_rad = 0.0f;
  float last_valid_angle_deg = 0.0f;
  uint8_t last_valid_status = 0U;
  uint8_t last_valid_crc_ok = 0U;
  uint8_t last_valid_status_ok = 0U;
};

class EncoderSampleMailbox {
 public:
  void reset();
  void publish(const EncoderSample &sample);
  bool consume(EncoderSample &sample);

 private:
  volatile uint32_t seq_ = 0U;
  EncoderSample sample_ = {};
};

class MT6701 {
 public:
  static constexpr uint32_t kDmaTimeoutCycles = 170000U;

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
  bool startReadDma();
  bool consumeLatestSample(EncoderSample &sample);
  void onDmaComplete();
  void onDmaError();
  bool timeoutStuckTransfer(uint32_t now_cycles);
  static void NotifyDmaComplete(SPI_HandleTypeDef *hspi);
  static void NotifyDmaError(SPI_HandleTypeDef *hspi);
  const EncoderHealth &health() const;
  bool isTransferInFlight() const;

 private:
  static uint32_t TimestampCycles();
  SPI_HandleTypeDef *spiHandle() const;
  void ResetSpiToReady();

  SPI_HandleTypeDef *spi_ = nullptr;
  GPIO_TypeDef *cs_port_ = nullptr;
  uint16_t cs_pin_ = 0U;
  uint8_t tx_dma_[3] = {};
  uint8_t rx_dma_[3] = {};
  volatile uint8_t transfer_in_flight_ = 0U;
  volatile uint32_t start_timestamp_cycles_ = 0U;
  uint32_t sequence_ = 0U;
  uint32_t last_consumed_sequence_ = 0U;
  EncoderSampleMailbox mailbox_;
  EncoderHealth health_ = {};
  static MT6701 *g_instance_;
};

}  // namespace hardware

#endif
