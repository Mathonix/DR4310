#ifndef ELECTRICAL_ANGLE_HPP
#define ELECTRICAL_ANGLE_HPP

namespace control {

float Wrap0To2Pi(float angle);
float MechanicalAngleFromEncoder(float encoder_angle_rad,
                                 bool invert_direction,
                                 float mechanical_zero_rad);
float ElectricalAngleFromCanonicalMechanical(float canonical_mech_rad,
                                             float mechanical_zero_rad,
                                             float pole_pairs);

}  // namespace control

#endif
