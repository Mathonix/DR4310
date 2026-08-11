#include "RotorEstimator.hpp"

#include <algorithm>
#include <cmath>

namespace control {

namespace {
constexpr float kTwoPi = 6.28318530718f;
constexpr float kPi = 3.14159265359f;
constexpr float kVelocityFilterAlpha = 0.5f;
constexpr float kMinDt = 1.0e-6f;
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
  initialized_ = false;
  state_ = {};
  last_angle_ = angle_rad;
  last_velocity_ = 0.0f;
}

const RotorState &RotorEstimator::update(float angle_rad, float dt) {
  dt = std::max(dt, kMinDt);
  state_.angle_wrapped_rad = angle_rad;

  if (!initialized_) {
    last_angle_ = angle_rad;
    last_velocity_ = 0.0f;
    state_.position_rad = angle_rad;
    state_.velocity_rad_s = 0.0f;
    state_.acceleration_rad_s2 = 0.0f;
    initialized_ = true;
    return state_;
  }

  const float delta = WrapDelta(angle_rad - last_angle_);
  state_.position_rad += delta;

  const float raw_velocity = delta / dt;
  const float velocity =
      last_velocity_ +
      (kVelocityFilterAlpha * (raw_velocity - last_velocity_));
  state_.velocity_rad_s = velocity;
  state_.acceleration_rad_s2 = (velocity - last_velocity_) / dt;

  last_angle_ = angle_rad;
  last_velocity_ = velocity;
  return state_;
}

const RotorState &RotorEstimator::state() const {
  return state_;
}

}  // namespace control
