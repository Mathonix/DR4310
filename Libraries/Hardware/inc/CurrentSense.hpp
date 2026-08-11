#ifndef CURRENT_SENSE_HPP
#define CURRENT_SENSE_HPP

#include "stm32g4xx_hal.h"

#include <cstdint>

namespace hardware {

struct CurrentSample {
  float ia_a = 0.0f;
  float ib_a = 0.0f;
  float ic_a = 0.0f;
  uint16_t raw_a = 0U;
  uint16_t raw_b = 0U;
  uint16_t raw_bus = 0U;
  float bus_v = 0.0f;
};

struct CurrentSenseHealth {
  bool calibrated = false;
  bool zero_a_valid = false;
  bool zero_b_valid = false;
  bool dma_running = false;
  bool latest_sample_valid = false;

  uint16_t zero_raw_a = 0U;
  uint16_t zero_raw_b = 0U;

  uint32_t invalid_sample_count = 0U;
  uint32_t rail_sample_count = 0U;
};

class CurrentSense {
 public:
  using SampleCallback = void (*)(void *context);

  CurrentSense() = default;
  CurrentSense(ADC_HandleTypeDef &adc, DMA_HandleTypeDef &dma);
  CurrentSense(const CurrentSense &) = delete;
  CurrentSense &operator=(const CurrentSense &) = delete;

  void init(ADC_HandleTypeDef &adc, DMA_HandleTypeDef &dma);
  HAL_StatusTypeDef configureScan();
  HAL_StatusTypeDef calibrate(uint16_t samples);
  HAL_StatusTypeDef startHw();
  HAL_StatusTypeDef getLatest(CurrentSample &sample);
  HAL_StatusTypeDef read(CurrentSample &sample);

  void setSampleCallback(SampleCallback callback, void *context);
  void onAdcComplete();
  ADC_HandleTypeDef *adcHandle() const;
  const CurrentSenseHealth &health() const;

 private:
  HAL_StatusTypeDef configRanks();
  HAL_StatusTypeDef applyCommon(uint32_t external_trig,
                                uint32_t trig_edge,
                                FunctionalState dma_cont,
                                uint32_t eoc_selection);
  HAL_StatusTypeDef softwareReadOneChannel(uint32_t channel, uint16_t &raw);
  HAL_StatusTypeDef softwareReadSequence(uint16_t &raw_a,
                                         uint16_t &raw_b,
                                         uint16_t &raw_bus);
  float rawToAdcV(uint16_t raw) const;
  void linkAdcDma();
  void fillFromRaw(CurrentSample &sample,
                   uint16_t raw_a,
                   uint16_t raw_b,
                   uint16_t raw_bus);
  static bool rawSamplePlausible(uint16_t raw_a,
                                 uint16_t raw_b,
                                 uint16_t raw_bus);

  ADC_HandleTypeDef *adc_;
  DMA_HandleTypeDef *dma_;
  alignas(4) volatile uint16_t dma_buf_[4] = {};
  float ia_zero_v_ = 0.0f;
  float ib_zero_v_ = 0.0f;
  bool configured_ = false;
  bool hw_running_ = false;
  volatile uint32_t sample_seq_ = 0U;
  SampleCallback sample_callback_ = nullptr;
  void *sample_context_ = nullptr;
  CurrentSenseHealth health_ = {};
};

}  // namespace hardware

#endif
