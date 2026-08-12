#include "MT6701.hpp"

#include <algorithm>

namespace hardware {

namespace {

constexpr float kResolutionF = 16384.0f;
constexpr float kTwoPiF = 6.28318530718f;
constexpr float kRadToDegF = 57.2957795131f;
constexpr uint8_t kFrameBytes = 3U;
constexpr uint32_t kCyclesPerUs = 170U;

void DecodeFrame(const uint8_t rx[3], EncoderSample &sample) {
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
  sample.crc_ok = true;
  sample.status_ok = (sample.status == 0U);
  sample.angle_rad =
      (static_cast<float>(sample.angle_raw) / kResolutionF) * kTwoPiF;
  sample.angle_deg = sample.angle_rad * kRadToDegF;
}

}  // namespace

extern "C" {
DMA_HandleTypeDef hdma_spi3_rx;
DMA_HandleTypeDef hdma_spi3_tx;
}

MT6701 *MT6701::g_instance_ = nullptr;

void EncoderSampleMailbox::reset() {
  seq_ = 0U;
  sample_ = {};
}

void EncoderSampleMailbox::publish(const EncoderSample &sample) {
  seq_++;
  __DMB();
  sample_ = sample;
  __DMB();
  seq_++;
}

bool EncoderSampleMailbox::consume(EncoderSample &sample) {
  const uint32_t seq1 = seq_;
  if ((seq1 & 1U) != 0U) {
    return false;
  }
  EncoderSample copy = sample_;
  __DMB();
  const uint32_t seq2 = seq_;
  if ((seq1 != seq2) || ((seq2 & 1U) != 0U)) {
    return false;
  }
  sample = copy;
  return sample.valid;
}

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
  g_instance_ = this;

  HAL_GPIO_WritePin(cs_port_, cs_pin_, GPIO_PIN_SET);

  GPIO_InitTypeDef gpio = {};
  gpio.Pin = cs_pin_;
  gpio.Mode = GPIO_MODE_OUTPUT_PP;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_HIGH;
  HAL_GPIO_Init(cs_port_, &gpio);

  __HAL_RCC_DMAMUX1_CLK_ENABLE();
  __HAL_RCC_DMA1_CLK_ENABLE();

  hdma_spi3_rx.Instance = DMA1_Channel2;
  hdma_spi3_rx.Init.Request = DMA_REQUEST_SPI3_RX;
  hdma_spi3_rx.Init.Direction = DMA_PERIPH_TO_MEMORY;
  hdma_spi3_rx.Init.PeriphInc = DMA_PINC_DISABLE;
  hdma_spi3_rx.Init.MemInc = DMA_MINC_ENABLE;
  hdma_spi3_rx.Init.PeriphDataAlignment = DMA_PDATAALIGN_BYTE;
  hdma_spi3_rx.Init.MemDataAlignment = DMA_MDATAALIGN_BYTE;
  hdma_spi3_rx.Init.Mode = DMA_NORMAL;
  hdma_spi3_rx.Init.Priority = DMA_PRIORITY_HIGH;
  if (HAL_DMA_Init(&hdma_spi3_rx) != HAL_OK) {
    return;
  }

  hdma_spi3_tx.Instance = DMA1_Channel3;
  hdma_spi3_tx.Init.Request = DMA_REQUEST_SPI3_TX;
  hdma_spi3_tx.Init.Direction = DMA_MEMORY_TO_PERIPH;
  hdma_spi3_tx.Init.PeriphInc = DMA_PINC_DISABLE;
  hdma_spi3_tx.Init.MemInc = DMA_MINC_ENABLE;
  hdma_spi3_tx.Init.PeriphDataAlignment = DMA_PDATAALIGN_BYTE;
  hdma_spi3_tx.Init.MemDataAlignment = DMA_MDATAALIGN_BYTE;
  hdma_spi3_tx.Init.Mode = DMA_NORMAL;
  hdma_spi3_tx.Init.Priority = DMA_PRIORITY_HIGH;
  if (HAL_DMA_Init(&hdma_spi3_tx) != HAL_OK) {
    return;
  }

  __HAL_LINKDMA(spi_, hdmarx, hdma_spi3_rx);
  __HAL_LINKDMA(spi_, hdmatx, hdma_spi3_tx);

  HAL_NVIC_SetPriority(DMA1_Channel2_IRQn, 3, 0);
  HAL_NVIC_EnableIRQ(DMA1_Channel2_IRQn);
  HAL_NVIC_SetPriority(DMA1_Channel3_IRQn, 3, 0);
  HAL_NVIC_EnableIRQ(DMA1_Channel3_IRQn);

  mailbox_.reset();
  health_ = {};
}

uint32_t MT6701::TimestampCycles() {
  return DWT->CYCCNT;
}

void MT6701::ResetSpiToReady() {
  if (spi_ == nullptr) {
    return;
  }
  __HAL_SPI_DISABLE(spi_);
  CLEAR_BIT(spi_->Instance->CR2, SPI_CR2_TXDMAEN | SPI_CR2_RXDMAEN);
  spi_->State = HAL_SPI_STATE_READY;
  spi_->ErrorCode = HAL_SPI_ERROR_NONE;
  spi_->Lock = HAL_UNLOCKED;
  spi_->TxXferCount = 0U;
  spi_->RxXferCount = 0U;

  __HAL_DMA_DISABLE(&hdma_spi3_rx);
  __HAL_DMA_DISABLE_IT(&hdma_spi3_rx, DMA_IT_TC | DMA_IT_HT | DMA_IT_TE);
  if (hdma_spi3_rx.DmaBaseAddress != nullptr) {
    hdma_spi3_rx.DmaBaseAddress->IFCR =
        DMA_ISR_GIF1 << (hdma_spi3_rx.ChannelIndex & 0x1FU);
  }
  if (hdma_spi3_rx.DMAmuxChannelStatus != nullptr) {
    hdma_spi3_rx.DMAmuxChannelStatus->CFR =
        hdma_spi3_rx.DMAmuxChannelStatusMask;
  }
  hdma_spi3_rx.State = HAL_DMA_STATE_READY;
  hdma_spi3_rx.ErrorCode = HAL_DMA_ERROR_NONE;
  hdma_spi3_rx.Lock = HAL_UNLOCKED;

  __HAL_DMA_DISABLE(&hdma_spi3_tx);
  __HAL_DMA_DISABLE_IT(&hdma_spi3_tx, DMA_IT_TC | DMA_IT_HT | DMA_IT_TE);
  if (hdma_spi3_tx.DmaBaseAddress != nullptr) {
    hdma_spi3_tx.DmaBaseAddress->IFCR =
        DMA_ISR_GIF1 << (hdma_spi3_tx.ChannelIndex & 0x1FU);
  }
  if (hdma_spi3_tx.DMAmuxChannelStatus != nullptr) {
    hdma_spi3_tx.DMAmuxChannelStatus->CFR =
        hdma_spi3_tx.DMAmuxChannelStatusMask;
  }
  hdma_spi3_tx.State = HAL_DMA_STATE_READY;
  hdma_spi3_tx.ErrorCode = HAL_DMA_ERROR_NONE;
  hdma_spi3_tx.Lock = HAL_UNLOCKED;
}

SPI_HandleTypeDef *MT6701::spiHandle() const {
  return spi_;
}

bool MT6701::isTransferInFlight() const {
  return transfer_in_flight_ != 0U;
}

bool MT6701::startReadDma() {
  if ((spi_ == nullptr) || (cs_port_ == nullptr)) {
    return false;
  }
  if (transfer_in_flight_ != 0U) {
    health_.missed_trigger_count++;
    return false;
  }

  tx_dma_[0] = 0U;
  tx_dma_[1] = 0U;
  tx_dma_[2] = 0U;
  start_timestamp_cycles_ = TimestampCycles();
  transfer_in_flight_ = 1U;

  if (spi_->State != HAL_SPI_STATE_READY) {
    ResetSpiToReady();
  }

  HAL_GPIO_WritePin(cs_port_, cs_pin_, GPIO_PIN_RESET);

  const HAL_StatusTypeDef status =
      HAL_SPI_TransmitReceive_DMA(spi_, tx_dma_, rx_dma_, kFrameBytes);
  if (status != HAL_OK) {
    HAL_GPIO_WritePin(cs_port_, cs_pin_, GPIO_PIN_SET);
    transfer_in_flight_ = 0U;
    health_.dma_start_fail_count++;
    ResetSpiToReady();
    return false;
  }
  return true;
}

bool MT6701::consumeLatestSample(EncoderSample &sample) {
  EncoderSample copy = {};
  if (!mailbox_.consume(copy)) {
    return false;
  }
  if (copy.sequence == last_consumed_sequence_) {
    return false;
  }
  last_consumed_sequence_ = copy.sequence;
  sample = copy;
  return true;
}

void MT6701::onDmaComplete() {
  const uint32_t callback_start_cycles = TimestampCycles();
  if ((spi_ == nullptr) || (cs_port_ == nullptr)) {
    return;
  }

  HAL_GPIO_WritePin(cs_port_, cs_pin_, GPIO_PIN_SET);
  transfer_in_flight_ = 0U;

  EncoderSample sample = {};
  DecodeFrame(rx_dma_, sample);
  sample.timestamp_cycles = start_timestamp_cycles_;
  sample.sequence = ++sequence_;
  sample.valid = sample.status_ok;

  if (sample.valid) {
    health_.valid_sample_count++;
    health_.consecutive_error_count = 0U;
    health_.last_valid_timestamp_cycles = sample.timestamp_cycles;
    health_.last_valid_sequence = sample.sequence;
    health_.last_valid_angle_rad = sample.angle_rad;
    health_.last_valid_angle_deg = sample.angle_deg;
    health_.last_valid_status = sample.status;
    health_.last_valid_crc_ok = sample.crc_ok ? 1U : 0U;
    health_.last_valid_status_ok = sample.status_ok ? 1U : 0U;
    mailbox_.publish(sample);
  } else {
    if (!sample.status_ok) {
      health_.status_error_count++;
    }
    health_.consecutive_error_count++;
  }

  const uint32_t elapsed_cycles = TimestampCycles() - callback_start_cycles;
  const uint32_t elapsed_us = elapsed_cycles / kCyclesPerUs;
  if (elapsed_us > health_.dma_callback_max_us) {
    health_.dma_callback_max_us = elapsed_us;
  }
}

void MT6701::onDmaError() {
  if (cs_port_ != nullptr) {
    HAL_GPIO_WritePin(cs_port_, cs_pin_, GPIO_PIN_SET);
  }
  transfer_in_flight_ = 0U;
  health_.dma_error_count++;
  ResetSpiToReady();
}

bool MT6701::timeoutStuckTransfer(uint32_t now_cycles) {
  if (transfer_in_flight_ == 0U) {
    return false;
  }
  const uint32_t elapsed_cycles = now_cycles - start_timestamp_cycles_;
  if (elapsed_cycles < kDmaTimeoutCycles) {
    return false;
  }

  if (cs_port_ != nullptr) {
    HAL_GPIO_WritePin(cs_port_, cs_pin_, GPIO_PIN_SET);
  }
  transfer_in_flight_ = 0U;
  health_.dma_error_count++;
  ResetSpiToReady();
  return true;
}

void MT6701::NotifyDmaComplete(SPI_HandleTypeDef *hspi) {
  if ((g_instance_ != nullptr) && (hspi == g_instance_->spiHandle())) {
    g_instance_->onDmaComplete();
  }
}

void MT6701::NotifyDmaError(SPI_HandleTypeDef *hspi) {
  if ((g_instance_ != nullptr) && (hspi == g_instance_->spiHandle())) {
    g_instance_->onDmaError();
  }
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

  sample = {};
  DecodeFrame(rx, sample);
  sample.timestamp_cycles = TimestampCycles();
  sample.sequence = ++sequence_;
  sample.valid = sample.status_ok;

  if (!sample.valid) {
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
