#include "PositionController.hpp"

#include <algorithm>
#include <cmath>

namespace control {

float PositionController::Clamp(float value, float low, float high) {
  return std::clamp(value, low, high);
}

void PositionController::init(float kp,
                              float ki,
                              float kd,
                              float velocity_limit,
                              float integral_separation) {
  kp_ = kp;
  ki_ = ki;
  kd_ = kd;
  velocity_limit_ = std::max(velocity_limit, 0.1f);
  integral_sep_ = std::max(integral_separation, 0.0f);
  integrator_ = 0.0f;
}

void PositionController::reset() {
  integrator_ = 0.0f;
}

void PositionController::setGains(float kp,
                                  float ki,
                                  float kd,
                                  float integral_separation) {
  kp_ = kp;
  ki_ = ki;
  kd_ = kd;
  integral_sep_ = std::max(integral_separation, 0.0f);
}

void PositionController::setVelocityLimit(float velocity_limit) {
  velocity_limit_ = std::max(velocity_limit, 0.1f);
}

float PositionController::update(float position_ref,
                                 float position,
                                 float velocity,
                                 float dt) {
  dt = std::max(dt, 0.0f);
  const float error = position_ref - position;
  const float abs_error = std::fabs(error);
  const float u_pi = (kp_ * error) + integrator_;
  const float u = Clamp(u_pi - (kd_ * velocity),
                        -velocity_limit_,
                        velocity_limit_);

  const bool large_error = abs_error >= integral_sep_;
  const bool saturated_toward_error =
      ((u_pi >= velocity_limit_) && (error > 0.0f)) ||
      ((u_pi <= -velocity_limit_) && (error < 0.0f));
  if ((ki_ > 0.0f) && (dt > 0.0f) && !large_error && !saturated_toward_error) {
    integrator_ += ki_ * error * dt;
  }
  integrator_ = Clamp(integrator_, -velocity_limit_, velocity_limit_);

  return u;
}

}  // namespace control
