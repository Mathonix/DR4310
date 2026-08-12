#include "RotorEstimator.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace control {

namespace {
constexpr float kTwoPi = 6.28318530718f;
constexpr float kPi = 3.14159265359f;
constexpr float kVelocityFilterAlpha = 1.0f;
constexpr float kMinDt = 1.0e-6f;
constexpr float kMinSampleDtS = 1.0e-6f;
constexpr float kMaxSampleDtS = 1.0e-2f;
constexpr float kCpuClockHzF = 170000000.0f;
constexpr float kCyclesPerUs = 170.0f;
}

float RotorEstimator::WrapDelta(float delta) {
  delta = std::fmod(delta, kTwoPi);
  if (delta > kPi) {
    delta -= kTwoPi;
  } else if (delta < -kPi) {
    delta += kTwoPi;
  }
  return delta;
}

void RotorEstimator::reset(float angle_rad) {
  reset(angle_rad, 0U);
}

void RotorEstimator::reset(float angle_rad, uint32_t timestamp_cycles) {
  state_ = {};
  state_.angle_wrapped_rad = angle_rad;
  state_.position_rad = angle_rad;
  state_.theta_mech_est_rad = angle_rad;
  last_angle_ = angle_rad;
  last_velocity_ = 0.0f;
  last_raw_velocity_ = 0.0f;
  initialized_ = true;
  history_head_ = 0U;
  history_count_ = 0U;
  history_delta_sum_rad_ = 0.0f;
  history_dt_sum_s_ = 0.0f;
  for (auto &d : history_delta_rad_) {
    d = 0.0f;
  }
  for (auto &t : history_dt_s_) {
    t = 0.0f;
  }
  last_sample_timestamp_cycles_ = timestamp_cycles;
  pll_sample_count_ = 0U;
  pll_initialized_ = true;
  pll_first_sample_pending_ = true;
  UpdatePllCoefficients();
}

void RotorEstimator::setPllParams(float bandwidth_hz, float damping) {
  pll_bandwidth_hz_ = std::max(bandwidth_hz, 1.0f);
  pll_damping_ = std::max(damping, 0.1f);
  UpdatePllCoefficients();
}

void RotorEstimator::UpdatePllCoefficients() {
  constexpr float kTwoPi = 6.28318530718f;
  const float wn = kTwoPi * pll_bandwidth_hz_;
  pll_kp_ = 2.0f * pll_damping_ * wn;
  pll_ki_ = wn * wn;
}

const RotorState &RotorEstimator::update(float angle_rad, float dt) {
  dt = std::max(dt, kMinDt);
  state_.angle_wrapped_rad = angle_rad;

  if (!initialized_) {
    last_angle_ = angle_rad;
    last_velocity_ = 0.0f;
    state_.position_rad = angle_rad;
    state_.angle_wrapped_rad = angle_rad;
    state_.velocity_rad_s = 0.0f;
    state_.acceleration_rad_s2 = 0.0f;
    initialized_ = true;
    return state_;
  }

  const float delta = WrapDelta(angle_rad - last_angle_);
  state_.position_rad += delta;

  state_.raw_delta_rad = delta;
  const float raw_velocity_new = delta / dt;
  state_.raw_velocity_rad_s =
      last_raw_velocity_ +
      (kVelocityFilterAlpha * (raw_velocity_new - last_raw_velocity_));
  last_raw_velocity_ = state_.raw_velocity_rad_s;

  if (history_count_ == kVelocityWindowSamples) {
    history_delta_sum_rad_ -= history_delta_rad_[history_head_];
    history_dt_sum_s_ -= history_dt_s_[history_head_];
  }
  history_delta_rad_[history_head_] = delta;
  history_dt_s_[history_head_] = dt;
  history_delta_sum_rad_ += delta;
  history_dt_sum_s_ += dt;
  history_head_ =
      (history_head_ + 1U) % kVelocityWindowSamples;
  if (history_count_ < kVelocityWindowSamples) {
    history_count_++;
  }

  /* Window covers N samples: sum of N deltas spans N outer-loop intervals. */
  state_.window_delta_rad = history_delta_sum_rad_;
  state_.window_dt_s = history_dt_sum_s_;
  state_.window_samples = history_count_;

  float estimated_velocity = state_.raw_velocity_rad_s;
  if ((history_count_ >= 2U) && (state_.window_dt_s > kMinDt)) {
    estimated_velocity =
        state_.window_delta_rad / state_.window_dt_s;
  }
  state_.velocity_rad_s = estimated_velocity;
  state_.legacy_window_velocity_rad_s = estimated_velocity;
  state_.acceleration_rad_s2 =
      (estimated_velocity - last_velocity_) / dt;

  last_angle_ = angle_rad;
  last_velocity_ = estimated_velocity;
  return state_;
}

void RotorEstimator::predict(float dt_s) {
  if (!pll_initialized_) {
    return;
  }
  dt_s = std::max(dt_s, 0.0f);
  state_.theta_mech_est_rad += state_.omega_est_rad_s * dt_s;
  state_.position_rad = state_.theta_mech_est_rad;
}

void RotorEstimator::correct(float angle_rad,
                             uint32_t measurement_timestamp_cycles,
                             uint32_t now_timestamp_cycles) {
  if (!pll_initialized_) {
    reset(angle_rad, measurement_timestamp_cycles);
    return;
  }
  if (pll_first_sample_pending_) {
    state_.theta_mech_est_rad = angle_rad;
    state_.position_rad = angle_rad;
    state_.angle_wrapped_rad = angle_rad;
    state_.omega_est_rad_s = 0.0f;
    state_.velocity_rad_s = 0.0f;
    state_.pll_angle_error_rad = 0.0f;
    state_.pll_measurement_dt_us = 0.0f;
    state_.encoder_sample_age_us = 0.0f;
    state_.pll_sample_count = 0U;
    state_.pll_locked = 0U;
    last_sample_timestamp_cycles_ = measurement_timestamp_cycles;
    pll_first_sample_pending_ = false;
    return;
  }

  const uint32_t raw_measurement_dt_cycles =
      measurement_timestamp_cycles - last_sample_timestamp_cycles_;
  float measurement_dt_s =
      static_cast<float>(raw_measurement_dt_cycles) / kCpuClockHzF;
  measurement_dt_s =
      std::clamp(measurement_dt_s, kMinSampleDtS, kMaxSampleDtS);

  const uint32_t raw_age_cycles =
      now_timestamp_cycles - measurement_timestamp_cycles;
  const float age_s = static_cast<float>(raw_age_cycles) / kCpuClockHzF;

  const float theta_est_at_meas =
      state_.theta_mech_est_rad - (state_.omega_est_rad_s * age_s);
  const float innovation = WrapDelta(angle_rad - theta_est_at_meas);

  if (std::fabs(innovation) > kMaxInnovationRad) {
    state_.pll_angle_error_rad = innovation;
    return;
  }

  const float kp = pll_kp_;
  const float ki = pll_ki_;
  state_.omega_est_rad_s += ki * innovation * measurement_dt_s;
  const float theta_est_at_meas_corrected =
      theta_est_at_meas + (kp * innovation * measurement_dt_s);
  state_.theta_mech_est_rad =
      theta_est_at_meas_corrected + (state_.omega_est_rad_s * age_s);
  state_.position_rad = state_.theta_mech_est_rad;
  state_.velocity_rad_s = state_.omega_est_rad_s;
  state_.pll_angle_error_rad = innovation;
  state_.pll_measurement_dt_us =
      static_cast<float>(raw_measurement_dt_cycles) / kCyclesPerUs;
  state_.encoder_sample_age_us =
      static_cast<float>(raw_age_cycles) / kCyclesPerUs;
  pll_sample_count_++;
  state_.pll_sample_count = pll_sample_count_;
  state_.pll_locked = (pll_sample_count_ >= 3U) ? 1U : 0U;
  last_sample_timestamp_cycles_ = measurement_timestamp_cycles;
}

const RotorState &RotorEstimator::state() const {
  return state_;
}

}  // namespace control
