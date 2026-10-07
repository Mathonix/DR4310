#ifndef MOTORPARAMS_HPP
#define MOTORPARAMS_HPP

namespace control {

struct MotorParams {
  float rs_ohm = 0.0f;
  float ld_h = 0.0f;
  float lq_h = 0.0f;
  float flux_wb = 0.0f;
  float pole_pairs = 0.0f;
};

namespace motor_params {

void setDefaults(MotorParams &params);
bool getCurrentPi(const MotorParams &params,
                  float omega_c_rad_s,
                  float &kp,
                  float &ki);

}  // namespace motor_params
}  // namespace control

#endif
