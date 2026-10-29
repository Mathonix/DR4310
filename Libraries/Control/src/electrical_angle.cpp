#include "ElectricalAngle.hpp"
#include "AngleWrap.hpp"

namespace control {

float Wrap0To2Pi(float angle) {
  return angle::Wrap0To2Pi(angle);
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
