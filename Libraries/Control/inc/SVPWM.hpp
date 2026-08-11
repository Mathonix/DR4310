#ifndef SVPWM_HPP
#define SVPWM_HPP

namespace control::svpwm {

struct DutyCycle {
  float a = 0.0f;
  float b = 0.0f;
  float c = 0.0f;
};

bool modulate(float v_alpha,
              float v_beta,
              float bus_v,
              float duty_min,
              float duty_max,
              DutyCycle &duty);

}  // namespace control::svpwm

#endif
