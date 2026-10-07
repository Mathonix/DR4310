#ifndef PICONTROLLER_HPP
#define PICONTROLLER_HPP

namespace control {

class PIController {
 public:
  PIController() = default;

  void init(float kp, float ki, float out_min, float out_max);
  void setOutputLimits(float out_min, float out_max);
  void setBackCalculationGain(float kaw);
  void applySaturationFeedback(float delta_u, float dt);
  void reset();
  float update(float error, float dt);

 private:
  float kp_ = 0.0f;
  float ki_ = 0.0f;
  float integrator_ = 0.0f;
  float out_min_ = 0.0f;
  float out_max_ = 0.0f;
  float kaw_ = 0.0f;
  float last_out_ = 0.0f;
};

}  // namespace control

#endif
