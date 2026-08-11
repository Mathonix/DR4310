#include "TrajectoryGenerator.hpp"

#include <algorithm>
#include <cmath>

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
    reset(current_position_rad);
  }

  ref_.position_rad = current_position_rad;
  const float distance = target_rad_ - current_position_rad;
  const float sign = (distance >= 0.0f) ? 1.0f : -1.0f;
  const float abs_distance = std::fabs(distance);
  const float decel_distance =
      (last_velocity_rad_s_ * last_velocity_rad_s_) /
      (2.0f * max_acceleration_rad_s2_);

  float velocity = last_velocity_rad_s_;
  if (abs_distance <= 1.0e-6f) {
    velocity = 0.0f;
  } else if ((velocity * sign) < 0.0f) {
    velocity += sign * max_acceleration_rad_s2_ * dt;
  } else if (abs_distance > (decel_distance + 1.0e-4f)) {
    velocity += sign * max_acceleration_rad_s2_ * dt;
  } else {
    velocity -= sign * max_acceleration_rad_s2_ * dt;
  }

  velocity = Clamp(velocity, -max_velocity_rad_s_, max_velocity_rad_s_);
  const float max_speed_for_stop =
      std::sqrt(2.0f * max_acceleration_rad_s2_ * abs_distance);
  if (std::fabs(velocity) > max_speed_for_stop) {
    velocity = sign * max_speed_for_stop;
  }
  if (std::fabs(velocity) < 1.0e-6f) {
    velocity = 0.0f;
  }

  const float last_velocity = last_velocity_rad_s_;
  last_velocity_rad_s_ = velocity;
  ref_.velocity_rad_s = velocity;
  ref_.acceleration_rad_s2 =
      (dt > 0.0f) ? (velocity - last_velocity) / dt : 0.0f;

  ref_.position_rad += velocity * dt;
  if (std::fabs(target_rad_ - ref_.position_rad) <= 1.0e-5f ||
      ((distance > 0.0f) && (ref_.position_rad >= target_rad_)) ||
      ((distance < 0.0f) && (ref_.position_rad <= target_rad_))) {
    ref_.position_rad = target_rad_;
    ref_.velocity_rad_s = 0.0f;
    ref_.acceleration_rad_s2 = 0.0f;
    last_velocity_rad_s_ = 0.0f;
  }

  return ref_;
}

const TrajectoryRef &TrajectoryGenerator::state() const {
  return ref_;
}

}  // namespace control
