#include "TrajectoryGenerator.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace control {

float TrajectoryGenerator::Clamp(float value, float low, float high) {
  return std::clamp(value, low, high);
}

void TrajectoryGenerator::init(float max_velocity_rad_s,
                               float max_acceleration_rad_s2) {
  max_velocity_rad_s_ = std::max(std::fabs(max_velocity_rad_s), 0.01f);
  max_acceleration_rad_s2_ =
      std::max(std::fabs(max_acceleration_rad_s2), 0.01f);
  ref_ = {};
  target_rad_ = 0.0f;
  last_velocity_rad_s_ = 0.0f;
  initialized_ = false;
}

void TrajectoryGenerator::reset(float position_rad) {
  ref_.position_rad = position_rad;
  ref_.velocity_rad_s = 0.0f;
  ref_.acceleration_rad_s2 = 0.0f;
  target_rad_ = position_rad;
  last_velocity_rad_s_ = 0.0f;
  initialized_ = true;
}

void TrajectoryGenerator::setTarget(float target_rad) {
  target_rad_ = target_rad;
}

void TrajectoryGenerator::setLimits(float max_velocity_rad_s,
                                    float max_acceleration_rad_s2) {
  max_velocity_rad_s_ = std::max(std::fabs(max_velocity_rad_s), 0.01f);
  max_acceleration_rad_s2_ =
      std::max(std::fabs(max_acceleration_rad_s2), 0.01f);
}

const TrajectoryRef &TrajectoryGenerator::update(float current_position_rad,
                                                 float dt) {
  dt = std::max(dt, 0.0f);
  if (!initialized_) {
    const float target = target_rad_;
    reset(current_position_rad);
    target_rad_ = target;
  }
  if (dt <= 0.0f) return ref_;

  // Advance the planned reference independently of feedback. Re-anchoring it
  // to the measured rotor every tick removes the PID error when POS_VFF=0.
  const float distance = target_rad_ - ref_.position_rad;
  const float sign = (distance >= 0.0f) ? 1.0f : -1.0f;
  const float abs_distance = std::fabs(distance);
  const float position_tolerance = std::max(
      1.0e-5f, 2.0f * std::numeric_limits<float>::epsilon() *
                   std::max(std::fabs(target_rad_), std::fabs(ref_.position_rad)));
  const float last_velocity = last_velocity_rad_s_;
  const float velocity_step = max_acceleration_rad_s2_ * dt;
  // Account for this tick's travel when choosing a speed that can stop at
  // the target. Approach it at the acceleration limit, including reversals.
  const float stop_speed = std::sqrt(velocity_step * velocity_step +
                                    2.0f * max_acceleration_rad_s2_ * abs_distance) -
                           velocity_step;
  const float desired_velocity = abs_distance <= position_tolerance ? 0.0f :
      sign * std::min(max_velocity_rad_s_, stop_speed);
  const float velocity = last_velocity +
      Clamp(desired_velocity - last_velocity, -velocity_step, velocity_step);
  ref_.velocity_rad_s = velocity;
  ref_.acceleration_rad_s2 =
      (dt > 0.0f) ? (velocity - last_velocity) / dt : 0.0f;

  ref_.position_rad += velocity * dt;
  if (std::fabs(target_rad_ - ref_.position_rad) <= position_tolerance &&
      std::fabs(last_velocity) <= velocity_step) {
    ref_.position_rad = target_rad_;
    ref_.velocity_rad_s = 0.0f;
    ref_.acceleration_rad_s2 = -last_velocity / dt;
  }
  last_velocity_rad_s_ = ref_.velocity_rad_s;

  return ref_;
}

const TrajectoryRef &TrajectoryGenerator::state() const {
  return ref_;
}

}  // namespace control
