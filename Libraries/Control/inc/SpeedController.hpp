#ifndef SPEED_CONTROLLER_HPP
#define SPEED_CONTROLLER_HPP

#include "PIController.hpp"

namespace control {

class SpeedController {
 public:
  void init(float kp, float ki, float iq_limit_a);
  void reset();
  void setGains(float kp, float ki);
  void setDerivativeGain(float kd);
  void setReference(float velocity_ref_rad_s);
  float update(float velocity_rad_s, float dt);

 private:
  PIController speed_pi_;
  float iq_limit_a_ = 2.50f;
  float velocity_ref_rad_s_ = 0.0f;
  float iq_ref_applied_a_ = 0.0f;
  float kd_ = 0.0f;
  float last_velocity_rad_s_ = 0.0f;
};

}  // namespace control

#endif
