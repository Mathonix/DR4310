#include "MotorParams.hpp"

#include <algorithm>

namespace control::motor_params {

/* Seeded from J-Link identification (2026-07-11):
 * Rs~1.97 ohm, raw L~19.7mH (likely upper-bound), flux~0.0069Wb.
 * L is stored derated for safer PI synthesis.
 */
constexpr float kDefaultRsOhm = 1.97f;
constexpr float kDefaultLh = 5.0e-3f;
constexpr float kDefaultFluxWb = 0.00693f;
constexpr float kDefaultPolePairs = 14.0f;

constexpr float kMinOmegaRadS = 100.0f;
constexpr float kMinLh = 1.0e-6f;
constexpr float kMaxLh = 8.0e-3f;
constexpr float kMinRsOhm = 0.05f;
constexpr float kMaxRsOhm = 10.0f;
constexpr float kMinKp = 0.5f;
constexpr float kMaxKp = 20.0f;
constexpr float kMinKi = 50.0f;
constexpr float kMaxKi = 2500.0f;

void setDefaults(MotorParams &params) {
  params.rs_ohm = kDefaultRsOhm;
  params.ld_h = kDefaultLh;
  params.lq_h = kDefaultLh;
  params.flux_wb = kDefaultFluxWb;
  params.pole_pairs = kDefaultPolePairs;
}

bool getCurrentPi(const MotorParams &params,
                  float omega_c_rad_s,
                  float &kp,
                  float &ki) {
  omega_c_rad_s = std::max(omega_c_rad_s, kMinOmegaRadS);

  const float l_h = std::clamp(0.5f * (params.ld_h + params.lq_h), kMinLh, kMaxLh);
  const float rs = std::clamp(params.rs_ohm, kMinRsOhm, kMaxRsOhm);

  /* Parallel form: u = Kp*e + Ki*integral(e) */
  kp = std::clamp(omega_c_rad_s * l_h, kMinKp, kMaxKp);
  ki = std::clamp(omega_c_rad_s * rs, kMinKi, kMaxKi);
  return true;
}

}  // namespace control::motor_params
