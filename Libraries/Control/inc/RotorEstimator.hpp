#ifndef ROTOR_ESTIMATOR_HPP
#define ROTOR_ESTIMATOR_HPP

namespace control {

struct RotorState {
  float angle_wrapped_rad = 0.0f;
  float position_rad = 0.0f;
  float velocity_rad_s = 0.0f;
  float acceleration_rad_s2 = 0.0f;
};

class RotorEstimator {
 public:
  void reset(float angle_rad);
  const RotorState &update(float angle_rad, float dt);
  const RotorState &state() const;

 private:
  static float WrapDelta(float delta);

  RotorState state_ = {};
  float last_angle_ = 0.0f;
  float last_velocity_ = 0.0f;
  bool initialized_ = false;
};

}  // namespace control

#endif
