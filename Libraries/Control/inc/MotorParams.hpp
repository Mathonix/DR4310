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

/* This board's saved resistance is 5.68 ohm. J-Link identification
 * (2026-07-11) reported Rs ~ 1.97 ohm and raw L ~ 19.7 mH (an upper bound),
 * flux ~ 0.0069 Wb. L used for PI synthesis stays derated so an
 * overestimated inductance cannot inflate Kp. */
constexpr float kDefaultRsOhm = 5.68f;
constexpr float kDefaultLh = 5.0e-3f;
/* 20 kHz current loop, about 1 to 1.5 PWM periods of delay.
 * 1200 rad/s (~191 Hz) keeps phase margin when L is at or below this value. */
constexpr float kCurrentLoopOmegaCRadS = 1200.0f;
/* Parallel PI, pole cancellation on 1/(Ls+R):
 *   Kp = wc*L, Ki = wc*R, Kaw = Ki/Kp = R/L. */
constexpr float kDefaultCurrentKp = 6.0f;
constexpr float kDefaultCurrentKi = 6816.0f;
constexpr float kDefaultCurrentKaw = 1136.0f;

void setDefaults(MotorParams &params);
bool getCurrentPi(const MotorParams &params,
                  float omega_c_rad_s,
                  float &kp,
                  float &ki);

}  // namespace motor_params
}  // namespace control

#endif
