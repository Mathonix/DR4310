#include "SpeedController.hpp"

#include <algorithm>
#include <cmath>

namespace control {

namespace {
/* Current board current/phase map: positive Iq produces positive encoder
 * velocity, so speed->Iq stays positive. */
constexpr float kSpeedIqSign = 1.0f;
constexpr float kIqRefSlewAPerS = 1000.0f;
}

void SpeedController::init(float kp, float ki, float iq_limit_a) {
  iq_limit_a_ = std::fabs(iq_limit_a);
  speed_pi_.init(kp, ki, -iq_limit_a_, iq_limit_a_);
  velocity_ref_rad_s_ = 0.0f;
  iq_ref_applied_a_ = 0.0f;
}

void SpeedController::reset() {
  speed_pi_.reset();
  velocity_ref_rad_s_ = 0.0f;
  iq_ref_applied_a_ = 0.0f;
  last_velocity_rad_s_ = 0.0f;
}

void SpeedController::setGains(float kp, float ki) {
  speed_pi_.init(kp, ki, -iq_limit_a_, iq_limit_a_);
}

void SpeedController::setDerivativeGain(float kd) {
  kd_ = kd;
}

void SpeedController::setReference(float velocity_ref_rad_s) {
  velocity_ref_rad_s_ = velocity_ref_rad_s;
}

float SpeedController::update(float velocity_rad_s, float dt) {
  const float error = velocity_ref_rad_s_ - velocity_rad_s;
  const float dt_safe = std::max(dt, 1.0e-6f);
  const float accel_est = (velocity_rad_s - last_velocity_rad_s_) / dt_safe;
  last_velocity_rad_s_ = velocity_rad_s;
  float iq_cmd =
      std::clamp((kSpeedIqSign * speed_pi_.update(error, dt)) -
                     (kd_ * accel_est),
                 -iq_limit_a_,
                 iq_limit_a_);

  const float max_delta = kIqRefSlewAPerS * std::max(dt, 0.0f);
  if ((iq_cmd - iq_ref_applied_a_) > max_delta) {
    iq_ref_applied_a_ += max_delta;
  } else if ((iq_cmd - iq_ref_applied_a_) < -max_delta) {
    iq_ref_applied_a_ -= max_delta;
  } else {
    iq_ref_applied_a_ = iq_cmd;
  }

  return iq_ref_applied_a_;
}

}  // namespace control
