#include "CurrentSense.hpp"

#include "HardwareBridge.h"

namespace hardware {

namespace {

constexpr float kAdcVrefV = 3.3f;
constexpr float kAdcFullScaleF = 4095.0f;
/* INA240 bidirectional mid-rail (REF1/REF2 = 3.3 V / 2 on this board). */
constexpr float kIna240ZeroDefaultV = 1.65f;
/*
 * Board: INA240A2 + low-side shunt.
 *   A2 gain = 50 V/V  (TI datasheet)
 *   Rshunt  = 10 mOhm
 *   V/A     = Rshunt * Gain = 0.010 * 50 = 0.5 V/A
 * Sense polarity follows the INA240 datasheet convention; open-loop
 * voltage/current checks on this board show no extra inversion is needed.
 */
constexpr float kIna240AmpGainVPerV = 50.0f;
constexpr float kIna240ShuntOhm = 0.010f;
constexpr float kIna240GainVPerA =
    kIna240ShuntOhm * kIna240AmpGainVPerV;
constexpr float kCurrentSenseSign = 1.0f;
constexpr float kBusDividerGain = 11.0f;
constexpr uint32_t kAdcDmaRankCount = 3U;
constexpr float kCurrentZeroMinV = 1.0f;
constexpr float kCurrentZeroMaxV = 2.3f;
constexpr uint16_t kRailSampleRawMin = 64U;
constexpr uint16_t kRailSampleRawMax = 4032U;

CurrentSense *g_current_sense = nullptr;

}  // namespace

extern "C" {
DMA_HandleTypeDef hdma_adc1;
}

CurrentSense::CurrentSense(ADC_HandleTypeDef &adc, DMA_HandleTypeDef &dma) {
  init(adc, dma);
}

void CurrentSense::init(ADC_HandleTypeDef &adc, DMA_HandleTypeDef &dma) {
  adc_ = &adc;
  dma_ = &dma;
  configured_ = false;
  hw_running_ = false;
  ia_zero_v_ = kIna240ZeroDefaultV;
  ib_zero_v_ = kIna240ZeroDefaultV;
  dma_buf_[0] = 0U;
  dma_buf_[1] = 0U;
  dma_buf_[2] = 0U;
  dma_buf_[3] = 0U;
  sample_seq_ = 0U;
  health_ = {};
  g_current_sense = this;
}

void CurrentSense::linkAdcDma() {
  hdma_adc1.Instance = DMA1_Channel1;
  __HAL_LINKDMA(adc_, DMA_Handle, hdma_adc1);
}

float CurrentSense::rawToAdcV(uint16_t raw) const {
  return static_cast<float>(raw) * (kAdcVrefV / kAdcFullScaleF);
}

void CurrentSense::fillFromRaw(CurrentSample &sample,
                               uint16_t raw_a,
                               uint16_t raw_b,
                               uint16_t raw_bus) {
  const float va = rawToAdcV(raw_a);
  const float vb = rawToAdcV(raw_b);
  const float inv_gain = 1.0f / kIna240GainVPerA;

  sample.raw_a = raw_a;
  sample.raw_b = raw_b;
  sample.raw_bus = raw_bus;
  sample.ia_a = kCurrentSenseSign * (va - ia_zero_v_) * inv_gain;
  sample.ib_a = kCurrentSenseSign * (vb - ib_zero_v_) * inv_gain;
  sample.ic_a = -sample.ia_a - sample.ib_a;
  sample.bus_v = rawToAdcV(raw_bus) * kBusDividerGain;
}

bool CurrentSense::rawSamplePlausible(uint16_t raw_a,
                                      uint16_t raw_b,
                                      uint16_t raw_bus) {
  /* All-zero means DMA never filled the buffer (boot / misconfig). */
  if ((raw_a == 0U) && (raw_b == 0U) && (raw_bus == 0U)) {
    return false;
  }
  /* 12-bit codes; INA mid-rail idle is ~2048. */
  if ((raw_a > 4095U) || (raw_b > 4095U) || (raw_bus > 4095U)) {
    return false;
  }
  /* Bus sense with 11x divider: 6 V bus -> ~0.545 V -> raw~77. */
  if (raw_bus < 200U) {
    return false;
  }
  return true;
}

HAL_StatusTypeDef CurrentSense::configRanks() {
  if (adc_ == nullptr) {
    return HAL_ERROR;
  }

  ADC_ChannelConfTypeDef config = {};
  config.Channel = ADC_CHANNEL_1;
  config.Rank = ADC_REGULAR_RANK_1;
  config.SamplingTime = ADC_SAMPLETIME_12CYCLES_5;
  config.SingleDiff = ADC_SINGLE_ENDED;
  config.OffsetNumber = ADC_OFFSET_NONE;
  config.Offset = 0;
  if (HAL_ADC_ConfigChannel(adc_, &config) != HAL_OK) {
    return HAL_ERROR;
  }

  config.Channel = ADC_CHANNEL_2;
  config.Rank = ADC_REGULAR_RANK_2;
  if (HAL_ADC_ConfigChannel(adc_, &config) != HAL_OK) {
    return HAL_ERROR;
  }

  config.Channel = ADC_CHANNEL_3;
  config.Rank = ADC_REGULAR_RANK_3;
  if (HAL_ADC_ConfigChannel(adc_, &config) != HAL_OK) {
    return HAL_ERROR;
  }

  return HAL_OK;
}

HAL_StatusTypeDef CurrentSense::applyCommon(uint32_t external_trig,
                                            uint32_t trig_edge,
                                            FunctionalState dma_cont,
                                            uint32_t eoc_selection) {
  if (adc_ == nullptr) {
    return HAL_ERROR;
  }

  adc_->Init.ClockPrescaler = ADC_CLOCK_SYNC_PCLK_DIV4;
  adc_->Init.Resolution = ADC_RESOLUTION_12B;
  adc_->Init.DataAlign = ADC_DATAALIGN_RIGHT;
  adc_->Init.GainCompensation = 0;
  adc_->Init.ScanConvMode = ADC_SCAN_ENABLE;
  /*
   * SINGLE_CONV: software rank-by-rank poll (calibrate).
   * SEQ_CONV: DMA one-TC-per-scan (runtime FOC).
   */
  adc_->Init.EOCSelection = eoc_selection;
  adc_->Init.LowPowerAutoWait = DISABLE;
  adc_->Init.ContinuousConvMode = DISABLE;
  adc_->Init.NbrOfConversion = kAdcDmaRankCount;
  adc_->Init.DiscontinuousConvMode = DISABLE;
  adc_->Init.ExternalTrigConv = external_trig;
  adc_->Init.ExternalTrigConvEdge = trig_edge;
  adc_->Init.DMAContinuousRequests = dma_cont;
  adc_->Init.Overrun = ADC_OVR_DATA_OVERWRITTEN;
  adc_->Init.OversamplingMode = DISABLE;

  if (HAL_ADC_Init(adc_) != HAL_OK) {
    return HAL_ERROR;
  }
  return configRanks();
}

HAL_StatusTypeDef CurrentSense::softwareReadOneChannel(uint32_t channel,
                                                       uint16_t &raw) {
  if (adc_ == nullptr) {
    return HAL_ERROR;
  }

  const uint32_t old_nconv = adc_->Init.NbrOfConversion;
  adc_->Init.NbrOfConversion = 1U;
  adc_->Init.ScanConvMode = ADC_SCAN_DISABLE;
  adc_->Init.ContinuousConvMode = DISABLE;
  adc_->Init.ExternalTrigConv = ADC_SOFTWARE_START;
  adc_->Init.ExternalTrigConvEdge = ADC_EXTERNALTRIGCONVEDGE_NONE;
  adc_->Init.DMAContinuousRequests = DISABLE;
  adc_->Init.EOCSelection = ADC_EOC_SINGLE_CONV;
  if (HAL_ADC_Init(adc_) != HAL_OK) {
    adc_->Init.NbrOfConversion = old_nconv;
    return HAL_ERROR;
  }

  ADC_ChannelConfTypeDef config = {};
  config.Channel = channel;
  config.Rank = ADC_REGULAR_RANK_1;
  config.SamplingTime = ADC_SAMPLETIME_47CYCLES_5;
  config.SingleDiff = ADC_SINGLE_ENDED;
  config.OffsetNumber = ADC_OFFSET_NONE;
  config.Offset = 0;
  if (HAL_ADC_ConfigChannel(adc_, &config) != HAL_OK) {
    adc_->Init.NbrOfConversion = old_nconv;
    return HAL_ERROR;
  }

  if (HAL_ADC_Start(adc_) != HAL_OK) {
    adc_->Init.NbrOfConversion = old_nconv;
    return HAL_ERROR;
  }

  if (HAL_ADC_PollForConversion(adc_, 10U) != HAL_OK) {
    (void)HAL_ADC_Stop(adc_);
    adc_->Init.NbrOfConversion = old_nconv;
    return HAL_TIMEOUT;
  }

  raw = static_cast<uint16_t>(HAL_ADC_GetValue(adc_));
  (void)HAL_ADC_Stop(adc_);
  adc_->Init.NbrOfConversion = old_nconv;
  return HAL_OK;
}

HAL_StatusTypeDef CurrentSense::softwareReadSequence(uint16_t &raw_a,
                                                     uint16_t &raw_b,
                                                     uint16_t &raw_bus) {
  if (softwareReadOneChannel(ADC_CHANNEL_1, raw_a) != HAL_OK) {
    return HAL_ERROR;
  }
  if (softwareReadOneChannel(ADC_CHANNEL_2, raw_b) != HAL_OK) {
    return HAL_ERROR;
  }
  if (softwareReadOneChannel(ADC_CHANNEL_3, raw_bus) != HAL_OK) {
    return HAL_ERROR;
  }
  return HAL_OK;
}

HAL_StatusTypeDef CurrentSense::configureScan() {
  if (adc_ == nullptr) {
    return HAL_ERROR;
  }

  __HAL_RCC_DMAMUX1_CLK_ENABLE();
  __HAL_RCC_DMA1_CLK_ENABLE();

  hdma_adc1.Instance = DMA1_Channel1;
  hdma_adc1.Init.Request = DMA_REQUEST_ADC1;
  hdma_adc1.Init.Direction = DMA_PERIPH_TO_MEMORY;
  hdma_adc1.Init.PeriphInc = DMA_PINC_DISABLE;
  hdma_adc1.Init.MemInc = DMA_MINC_ENABLE;
  hdma_adc1.Init.PeriphDataAlignment = DMA_PDATAALIGN_HALFWORD;
  hdma_adc1.Init.MemDataAlignment = DMA_MDATAALIGN_HALFWORD;
  hdma_adc1.Init.Mode = DMA_CIRCULAR;
  hdma_adc1.Init.Priority = DMA_PRIORITY_VERY_HIGH;
  if (HAL_DMA_Init(&hdma_adc1) != HAL_OK) {
    return HAL_ERROR;
  }
  linkAdcDma();

  /* DMA TC IRQ: fires once per completed 3-channel sequence. */
  HAL_NVIC_SetPriority(DMA1_Channel1_IRQn, 0, 0);
  HAL_NVIC_EnableIRQ(DMA1_Channel1_IRQn);

  if (applyCommon(ADC_SOFTWARE_START,
                  ADC_EXTERNALTRIGCONVEDGE_NONE,
                  DISABLE,
                  ADC_EOC_SINGLE_CONV) != HAL_OK) {
    return HAL_ERROR;
  }

  (void)HAL_ADCEx_Calibration_Start(adc_, ADC_SINGLE_ENDED);
  configured_ = true;
  hw_running_ = false;
  return HAL_OK;
}

HAL_StatusTypeDef CurrentSense::calibrate(uint16_t samples) {
  if ((adc_ == nullptr) || (samples == 0U) || !configured_) {
    return HAL_ERROR;
  }

  if (hw_running_) {
    (void)HAL_ADC_Stop_DMA(adc_);
    hw_running_ = false;
  }

  uint32_t sum_a = 0U;
  uint32_t sum_b = 0U;
  uint16_t ok = 0U;
  for (uint16_t i = 0U; i < samples; ++i) {
    uint16_t raw_a = 0U;
    uint16_t raw_b = 0U;
    uint16_t raw_bus = 0U;
    if (softwareReadSequence(raw_a, raw_b, raw_bus) != HAL_OK) {
      continue;
    }
    sum_a += raw_a;
    sum_b += raw_b;
    ok++;
  }

  if (ok == 0U) {
    return HAL_ERROR;
  }

  const uint16_t zero_raw_a = static_cast<uint16_t>(sum_a / ok);
  const uint16_t zero_raw_b = static_cast<uint16_t>(sum_b / ok);
  const float zero_a_v = rawToAdcV(zero_raw_a);
  const float zero_b_v = rawToAdcV(zero_raw_b);

  health_.zero_raw_a = zero_raw_a;
  health_.zero_raw_b = zero_raw_b;
  health_.zero_a_valid =
      (zero_a_v >= kCurrentZeroMinV) && (zero_a_v <= kCurrentZeroMaxV);
  health_.zero_b_valid =
      (zero_b_v >= kCurrentZeroMinV) && (zero_b_v <= kCurrentZeroMaxV);

  if (!health_.zero_a_valid || !health_.zero_b_valid) {
    health_.calibrated = false;
    return HAL_ERROR;
  }

  ia_zero_v_ = zero_a_v;
  ib_zero_v_ = zero_b_v;
  health_.calibrated = true;

  /* Restore 3-rank software config (DMA path reconfigures again in StartHw). */
  (void)applyCommon(ADC_SOFTWARE_START,
                    ADC_EXTERNALTRIGCONVEDGE_NONE,
                    DISABLE,
                    ADC_EOC_SINGLE_CONV);
  return HAL_OK;
}

HAL_StatusTypeDef CurrentSense::startHw() {
  if ((adc_ == nullptr) || !configured_) {
    return HAL_ERROR;
  }

  if (hw_running_) {
    return HAL_OK;
  }

  if (applyCommon(ADC_EXTERNALTRIG_T1_TRGO2,
                  ADC_EXTERNALTRIGCONVEDGE_RISING,
                  ENABLE,
                  ADC_EOC_SEQ_CONV) != HAL_OK) {
    return HAL_ERROR;
  }

  /* ADC_Init can leave DMA linkage stale - re-bind every StartHw. */
  linkAdcDma();

  dma_buf_[0] = 0U;
  dma_buf_[1] = 0U;
  dma_buf_[2] = 0U;
  dma_buf_[3] = 0U;
  sample_seq_ = 0U;

  if (adc_->DMA_Handle != &hdma_adc1) {
    return HAL_ERROR;
  }

  if (HAL_ADC_Start_DMA(adc_,
                        reinterpret_cast<uint32_t *>(
                            const_cast<uint16_t *>(dma_buf_)),
                        kAdcDmaRankCount) != HAL_OK) {
    return HAL_ERROR;
  }

  /*
   * Force destination address. Observed field failure: CMAR pointed into
   * hdma_adc1 (.bss) instead of dma_buf_, so FOC always saw zero current.
   */
  hdma_adc1.Instance->CMAR =
      reinterpret_cast<uint32_t>(const_cast<uint16_t *>(dma_buf_));
  if (hdma_adc1.Instance->CMAR !=
      reinterpret_cast<uint32_t>(const_cast<uint16_t *>(dma_buf_))) {
    (void)HAL_ADC_Stop_DMA(adc_);
    return HAL_ERROR;
  }

  hw_running_ = true;
  health_.dma_running = true;
  return HAL_OK;
}

HAL_StatusTypeDef CurrentSense::getLatest(CurrentSample &sample) {
  if (!configured_ || !hw_running_) {
    health_.latest_sample_valid = false;
    return HAL_ERROR;
  }

  /* Need at least one completed DMA sequence after StartHw. */
  if (sample_seq_ == 0U) {
    health_.latest_sample_valid = false;
    return HAL_ERROR;
  }

  const uint16_t raw_a = dma_buf_[0];
  const uint16_t raw_b = dma_buf_[1];
  const uint16_t raw_bus = dma_buf_[2];
  if (!rawSamplePlausible(raw_a, raw_b, raw_bus)) {
    health_.latest_sample_valid = false;
    health_.invalid_sample_count++;
    if ((raw_a < kRailSampleRawMin) || (raw_a > kRailSampleRawMax) ||
        (raw_b < kRailSampleRawMin) || (raw_b > kRailSampleRawMax)) {
      health_.rail_sample_count++;
    }
    return HAL_ERROR;
  }

  health_.latest_sample_valid = true;
  fillFromRaw(sample, raw_a, raw_b, raw_bus);
  return HAL_OK;
}

HAL_StatusTypeDef CurrentSense::read(CurrentSample &sample) {
  if (hw_running_) {
    return getLatest(sample);
  }

  uint16_t raw_a = 0U;
  uint16_t raw_b = 0U;
  uint16_t raw_bus = 0U;
  if (softwareReadSequence(raw_a, raw_b, raw_bus) != HAL_OK) {
    return HAL_ERROR;
  }
  fillFromRaw(sample, raw_a, raw_b, raw_bus);
  return HAL_OK;
}

void CurrentSense::setSampleCallback(SampleCallback callback, void *context) {
  sample_callback_ = callback;
  sample_context_ = context;
}

void CurrentSense::onAdcComplete() {
  if ((adc_ != nullptr) && hw_running_) {
    sample_seq_++;
    if (sample_callback_ != nullptr) {
      sample_callback_(sample_context_);
    }
  }
}

ADC_HandleTypeDef *CurrentSense::adcHandle() const {
  return adc_;
}

const CurrentSenseHealth &CurrentSense::health() const {
  return health_;
}

}  // namespace hardware

extern "C" void CurrentSense_OnAdcComplete(ADC_HandleTypeDef *hadc) {
  if ((hardware::g_current_sense != nullptr) &&
      (hadc == hardware::g_current_sense->adcHandle())) {
    hardware::g_current_sense->onAdcComplete();
  }
}
