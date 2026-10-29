#include "AngleWrap.hpp"
#include "ElectricalAngle.hpp"

#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <initializer_list>
#include <limits>

namespace {
constexpr float kTwoPi = 6.28318530718f;
constexpr float kPi = 3.14159265359f;
uint64_t comparisons = 0;

float Reference0(float value) {
  value = std::fmod(value, kTwoPi);
  if (value < 0) value += kTwoPi;
  return value;
}
float ReferencePm(float value) {
  value = std::fmod(value, kTwoPi);
  if (value > kPi) value -= kTwoPi;
  else if (value < -kPi) value += kTwoPi;
  return value;
}
uint32_t Bits(float value) {
  uint32_t bits;
  std::memcpy(&bits, &value, sizeof(bits));
  return bits;
}
void Same(float actual, float expected) {
  ++comparisons;
  // NaN payloads are not part of the angle interface. All finite values,
  // infinities and the sign of zero must otherwise match bit for bit.
  assert((std::isnan(actual) && std::isnan(expected)) ||
         Bits(actual) == Bits(expected));
}
void Check(float value) {
  Same(control::angle::Wrap0To2Pi(value), Reference0(value));
  Same(control::angle::WrapPmPi(value), ReferencePm(value));
  Same(control::Wrap0To2Pi(value), Reference0(value));
}
}

int main() {
  const float inf = std::numeric_limits<float>::infinity();
  for (float edge : {0.0f, -0.0f, kPi, -kPi, kTwoPi, -kTwoPi,
                    2*kTwoPi, -2*kTwoPi, 1.0e10f, -1.0e10f,
                    std::numeric_limits<float>::max(),
                    -std::numeric_limits<float>::max(), inf, -inf,
                    std::numeric_limits<float>::quiet_NaN()}) {
    Check(edge);
    if (!std::isfinite(edge)) continue;
    float below = edge, above = edge;
    for (int i=0; i<16; ++i) {
      below = std::nextafter(below, -inf);
      above = std::nextafter(above, inf);
      Check(below); Check(above);
    }
  }
  uint32_t random = 0x41315abc;
  for (int i=0; i<1000000; ++i) {
    random ^= random << 13; random ^= random >> 17; random ^= random << 5;
    float value;
    std::memcpy(&value, &random, sizeof(value));
    Check(value);
    // Concentrate another million inputs around the normal ISR angle range.
    const float local = (static_cast<int32_t>(random) / 2147483648.0f) * 8.0f;
    Check(local);
    for (bool reversed : {false, true}) {
      const float raw = Reference0(local);
      const float expected_mech = Reference0(reversed ? -raw : raw);
      const float mech = control::MechanicalAngleFromEncoder(raw, reversed, 0);
      Same(mech, expected_mech);
      const float expected_elec = Reference0((mech + 0.18569493f) * 14);
      const float elec = control::ElectricalAngleFromCanonicalMechanical(mech, 0.18569493f, 14);
      Same(elec, expected_elec);
      // FOC setter -> CORDIC input: also exercise a value that rounds to 2*pi.
      Same(control::angle::WrapPmPi(control::angle::Wrap0To2Pi(elec)),
           ReferencePm(Reference0(expected_elec)));
    }
  }
  std::printf("Angle wrap bitwise comparisons passed: %llu\n",
              static_cast<unsigned long long>(comparisons));
}
