#include "PIController.hpp"

#include <algorithm>

namespace control {

void PIController::init(float kp, float ki, float out_min, float out_max) {
  kp_ = kp;
  ki_ = ki;
  integrator_ = 0.0f;
  out_min_ = out_min;
  out_max_ = out_max;
  kaw_ = 0.0f;
  last_out_ = 0.0f;
}

void PIController::setOutputLimits(float out_min, float out_max) {
  out_min_ = out_min;
  out_max_ = out_max;
  integrator_ = std::clamp(integrator_, out_min_, out_max_);
}

void PIController::setBackCalculationGain(float kaw) {
  kaw_ = kaw;
}

void PIController::applySaturationFeedback(float delta_u, float dt) {
  dt = std::max(dt, 0.0f);
  if (kaw_ > 0.0f) {
    integrator_ += kaw_ * delta_u * dt;
    integrator_ = std::clamp(integrator_, out_min_, out_max_);
  }
}

void PIController::reset() {
  integrator_ = 0.0f;
  last_out_ = 0.0f;
}

float PIController::update(float error, float dt) {
  dt = std::max(dt, 0.0f);

  const float proportional = kp_ * error;
  float u_unsat = proportional + integrator_;

  /* Conditional integration anti-windup:
   * freeze integrator when saturated and error still drives further into saturation.
   */
  bool freeze_integrator = false;
  if (u_unsat >= out_max_) {
    freeze_integrator = error > 0.0f;
  } else if (u_unsat <= out_min_) {
    freeze_integrator = error < 0.0f;
  }

  if (!freeze_integrator) {
    integrator_ += ki_ * error * dt;
  }

  u_unsat = proportional + integrator_;
  float output = std::clamp(u_unsat, out_min_, out_max_);

  /* Optional back-calculation (disabled when kaw == 0). */
  if (kaw_ > 0.0f) {
    integrator_ += kaw_ * (output - u_unsat) * dt;
    integrator_ = std::clamp(integrator_, out_min_, out_max_);
    output = std::clamp(proportional + integrator_, out_min_, out_max_);
  } else {
    integrator_ = std::clamp(integrator_, out_min_, out_max_);
  }

  last_out_ = output;
  return output;
}

}  // namespace control
