#include "MotionController.hpp"

#include <algorithm>
#include <cmath>

namespace control {

namespace {

constexpr float kTwoPi = 6.28318530718f;
constexpr float kPi = 3.14159265359f;
/* DRV8313 continuous/work limit (datasheet-class rating). */
constexpr float kIqRefLimitA = 2.50f;
constexpr float kSpeedPiKp = 0.03f;
constexpr float kSpeedPiKi = 0.05f;
/*
 * Velocity observer (1 kHz):
 *   - Update every sample (was 6-sample batch -> large D lag).
 *   - EMA alpha closer to 1 = less lag, more quant noise.
 *   14-bit encoder @ 1 kHz: 1 count ~0.383 rad/s ~3.7 rpm.
 */
constexpr float kVelocityFilterAlpha = 0.42f;
/* Limit torque command rate to avoid abrupt speed jumps under hand load. */
constexpr float kIqRefSlewAPerS = 1.5f;
/* With the corrected phase/current map, +iq still produces negative
 * encoder velocity on this board, so speed->iq remains inverted. */
constexpr float kSpeedIqSign = -1.0f;
constexpr float kMinDt = 1.0e-6f;

}  // namespace

float MotionController::WrapDelta(float delta) {
  delta = std::fmod(delta, kTwoPi);
  if (delta > kPi) {
    delta -= kTwoPi;
  } else if (delta < -kPi) {
    delta += kTwoPi;
  }
  return delta;
}

void MotionController::Init() {
  speed_pi_.init(kSpeedPiKp, kSpeedPiKi, -kIqRefLimitA, kIqRefLimitA);
  state_.velocity_ref_rad_s = 0.0f;
  state_.accel_ref_rad_s2 = 0.0f;
  state_.initialized = 0U;
  iq_ref_applied_ = 0.0f;
  last_angle_ = 0.0f;
  last_velocity_ = 0.0f;
}

void MotionController::ResetSpeedLoop() {
  speed_pi_.reset();
  iq_ref_applied_ = 0.0f;
}

void MotionController::SetSpeedPi(float kp, float ki) {
  speed_pi_.init(kp, ki, -kIqRefLimitA, kIqRefLimitA);
}

void MotionController::SetVelocityRef(float velocity_ref_rad_s) {
  state_.velocity_ref_rad_s = velocity_ref_rad_s;
}

void MotionController::SetAccelRef(float accel_ref_rad_s2) {
  state_.accel_ref_rad_s2 = accel_ref_rad_s2;
}

float MotionController::Update(float mech_angle_rad, float dt) {
  state_.mech_angle_rad = mech_angle_rad;
  dt = std::max(dt, kMinDt);

  if (state_.initialized == 0U) {
    last_angle_ = mech_angle_rad;
    last_velocity_ = 0.0f;
    state_.mech_velocity_rad_s = 0.0f;
    state_.mech_accel_rad_s2 = 0.0f;
    state_.iq_ref_a = 0.0f;
    iq_ref_applied_ = 0.0f;
    state_.initialized = 1U;
    return 0.0f;
  }

  /* Per-sample velocity: no multi-tick hold of stale speed for D term. */
  const float delta = WrapDelta(mech_angle_rad - last_angle_);
  const float raw_velocity = delta / dt;
  const float velocity =
      last_velocity_ + (kVelocityFilterAlpha * (raw_velocity - last_velocity_));
  const float accel = (velocity - last_velocity_) / dt;

  const float error = state_.velocity_ref_rad_s - velocity;
  const float iq_cmd =
      std::clamp(kSpeedIqSign * speed_pi_.update(error, dt),
                 -kIqRefLimitA,
                 kIqRefLimitA);
  const float max_delta = kIqRefSlewAPerS * dt;
  if ((iq_cmd - iq_ref_applied_) > max_delta) {
    iq_ref_applied_ += max_delta;
  } else if ((iq_cmd - iq_ref_applied_) < -max_delta) {
    iq_ref_applied_ -= max_delta;
  } else {
    iq_ref_applied_ = iq_cmd;
  }

  state_.mech_velocity_rad_s = velocity;
  state_.mech_accel_rad_s2 = accel;
  state_.iq_ref_a = iq_ref_applied_;

  last_angle_ = mech_angle_rad;
  last_velocity_ = velocity;

  return state_.iq_ref_a;
}

const MotionState &MotionController::GetState() const {
  return state_;
}

}  // namespace control
