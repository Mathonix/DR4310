#include "ElectricalAngle.hpp"

#include <cmath>

namespace control {

namespace {
constexpr float kTwoPi = 6.28318530718f;
}

float Wrap0To2Pi(float angle) {
  angle = std::fmod(angle, kTwoPi);
  if (angle < 0.0f) {
    angle += kTwoPi;
  }
  return angle;
}

float MechanicalAngleFromEncoder(float encoder_angle_rad,
                                 bool invert_direction,
                                 float mechanical_zero_rad) {
  const float canonical =
      invert_direction ? -encoder_angle_rad : encoder_angle_rad;
  return Wrap0To2Pi(mechanical_zero_rad + canonical);
}

float ElectricalAngleFromCanonicalMechanical(float canonical_mech_rad,
                                             float mechanical_zero_rad,
                                             float pole_pairs) {
  return Wrap0To2Pi((canonical_mech_rad + mechanical_zero_rad) * pole_pairs);
}

}  // namespace control
