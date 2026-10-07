#ifndef POSITION_CONTROLLER_HPP
#define POSITION_CONTROLLER_HPP

namespace control {

class PositionController {
 public:
  void init(float kp,
            float ki,
            float kd,
            float velocity_limit,
            float integral_separation);
  void reset();
  void setGains(float kp, float ki, float kd, float integral_separation);
  void setVelocityLimit(float velocity_limit);
  float update(float position_ref,
               float position,
               float velocity,
               float dt);

 private:
  static float Clamp(float value, float low, float high);

  float kp_ = 0.0f;
  float ki_ = 0.0f;
  float kd_ = 0.0f;
  float velocity_limit_ = 0.0f;
  float integral_sep_ = 0.0f;
  float integrator_ = 0.0f;
};

}  // namespace control

#endif
