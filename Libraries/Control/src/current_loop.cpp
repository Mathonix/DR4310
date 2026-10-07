#include "CurrentLoopController.hpp"

namespace control {

void CurrentLoopController::init(float kp,
                                 float ki,
                                 float out_min_v,
                                 float out_max_v) {
  id_pi_.init(kp, ki, out_min_v, out_max_v);
  iq_pi_.init(kp, ki, out_min_v, out_max_v);
}

void CurrentLoopController::reset() {
  id_pi_.reset();
  iq_pi_.reset();
}

void CurrentLoopController::setOutputLimits(float out_min_v,
                                            float out_max_v) {
  id_pi_.setOutputLimits(out_min_v, out_max_v);
  iq_pi_.setOutputLimits(out_min_v, out_max_v);
}

void CurrentLoopController::setBackCalculationGain(float kaw) {
  id_pi_.setBackCalculationGain(kaw);
  iq_pi_.setBackCalculationGain(kaw);
}

void CurrentLoopController::applySaturationFeedback(float delta_vd_v,
                                                    float delta_vq_v,
                                                    float dt) {
  id_pi_.applySaturationFeedback(delta_vd_v, dt);
  iq_pi_.applySaturationFeedback(delta_vq_v, dt);
}

CurrentLoopVoltage CurrentLoopController::update(float id_ref_a,
                                                 float iq_ref_a,
                                                 float id_a,
                                                 float iq_a,
                                                 float dt) {
  CurrentLoopVoltage voltage;
  voltage.vd_v = id_pi_.update(id_ref_a - id_a, dt);
  voltage.vq_v = iq_pi_.update(iq_ref_a - iq_a, dt);
  return voltage;
}

}  // namespace control
