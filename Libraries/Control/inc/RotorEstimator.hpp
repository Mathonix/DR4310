#ifndef ROTOR_ESTIMATOR_HPP
#define ROTOR_ESTIMATOR_HPP

#include <cstdint>

namespace control {

struct RotorState {
  float angle_wrapped_rad = 0.0f;
  float position_rad = 0.0f;
  float velocity_rad_s = 0.0f;
  float legacy_window_velocity_rad_s = 0.0f;
  float acceleration_rad_s2 = 0.0f;
  float raw_velocity_rad_s = 0.0f;
  float raw_delta_rad = 0.0f;
  float window_delta_rad = 0.0f;
  float window_dt_s = 0.0f;
  uint32_t window_samples = 0U;
  float theta_mech_est_rad = 0.0f;
  float omega_est_rad_s = 0.0f;
  float pll_angle_error_rad = 0.0f;
  float pll_measurement_dt_us = 0.0f;
  float encoder_sample_age_us = 0.0f;
  uint32_t pll_sample_count = 0U;
  uint32_t pll_locked = 0U;
};

class RotorEstimator {
 public:
  static constexpr uint32_t kVelocityWindowSamples = 5U;
  /* 5 samples at 1 kHz ~ 5 ms: quantization improves about 5x vs raw 1ms
   * while keeping less phase lag than a 10ms window. */
  static constexpr float kPllBandwidthHz = 20.0f;
  static constexpr float kPllDamping = 0.8f;
  static constexpr float kMaxInnovationRad = 0.25f;

  void reset(float angle_rad);
  void reset(float angle_rad, uint32_t timestamp_cycles);
  void setPllParams(float bandwidth_hz, float damping);
  const RotorState &update(float angle_rad, float dt);
  void predict(float dt_s);
  void correct(float angle_rad,
               uint32_t measurement_timestamp_cycles,
               uint32_t now_timestamp_cycles);
  const RotorState &state() const;

 private:
  static float WrapDelta(float delta);
  void UpdatePllCoefficients();

  RotorState state_ = {};
  float last_angle_ = 0.0f;
  float last_velocity_ = 0.0f;
  float last_raw_velocity_ = 0.0f;
  float history_delta_rad_[kVelocityWindowSamples] = {};
  float history_dt_s_[kVelocityWindowSamples] = {};
  uint32_t history_head_ = 0U;
  uint32_t history_count_ = 0U;
  float history_delta_sum_rad_ = 0.0f;
  float history_dt_sum_s_ = 0.0f;
  bool initialized_ = false;
  float pll_bandwidth_hz_ = kPllBandwidthHz;
  float pll_damping_ = kPllDamping;
  float pll_kp_ = 0.0f;
  float pll_ki_ = 0.0f;
  uint32_t last_sample_timestamp_cycles_ = 0U;
  uint32_t pll_sample_count_ = 0U;
  bool pll_initialized_ = false;
  bool pll_first_sample_pending_ = true;
};

}  // namespace control

#endif
