#ifndef CURRENT_LOOP_CONTROLLER_HPP
#define CURRENT_LOOP_CONTROLLER_HPP

#include "PIController.hpp"

namespace control {

struct CurrentLoopVoltage {
  float vd_v = 0.0f;
  float vq_v = 0.0f;
};

class CurrentLoopController {
 public:
  CurrentLoopController() = default;

  void init(float kp, float ki, float out_min_v, float out_max_v);
  void reset();
  void setOutputLimits(float out_min_v, float out_max_v);
  void setBackCalculationGain(float kaw);
  void applySaturationFeedback(float delta_vd_v,
                               float delta_vq_v,
                               float dt);

  CurrentLoopVoltage update(float id_ref_a,
                            float iq_ref_a,
                            float id_a,
                            float iq_a,
                            float dt);

 private:
  PIController id_pi_;
  PIController iq_pi_;
};

}  // namespace control

#endif
