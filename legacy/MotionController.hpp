#ifndef MOTION_CONTROLLER_HPP
#define MOTION_CONTROLLER_HPP

#include "PIController.hpp"

#include <cstdint>

namespace control {

struct MotionState {
  float mech_angle_rad = 0.0f;
  float mech_velocity_rad_s = 0.0f;
  float mech_accel_rad_s2 = 0.0f;
  float velocity_ref_rad_s = 0.0f;
  float accel_ref_rad_s2 = 0.0f;
  float iq_ref_a = 0.0f;
  uint8_t initialized = 0U;
};

class MotionController {
 public:
  void Init();
  void ResetSpeedLoop();
  void SetSpeedPi(float kp, float ki);
  void SetVelocityRef(float velocity_ref_rad_s);
  void SetAccelRef(float accel_ref_rad_s2);
  float Update(float mech_angle_rad, float dt);
  const MotionState &GetState() const;

 private:
  static float WrapDelta(float delta);

  MotionState state_ = {};
  PIController speed_pi_;
  float last_angle_ = 0.0f;
  float last_velocity_ = 0.0f;
  float iq_ref_applied_ = 0.0f;
};

}  // namespace control

#endif
