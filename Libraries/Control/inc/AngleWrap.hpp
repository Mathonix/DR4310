#ifndef ANGLE_WRAP_HPP
#define ANGLE_WRAP_HPP

#include <cmath>

#ifndef DR4310_FAST_ANGLE_WRAP
#define DR4310_FAST_ANGLE_WRAP 1
#endif

namespace control::angle {

constexpr float kTwoPi = 6.28318530718f;
constexpr float kPi = 3.14159265359f;

// Most ISR inputs already span less than one turn. Preserve the original
// fmod arithmetic (including signed zero) and retain it for unbounded inputs.
inline float Wrap0To2Pi(float value) {
#if DR4310_FAST_ANGLE_WRAP
  if (!(value > -kTwoPi && value < kTwoPi)) {
    value = std::fmod(value, kTwoPi);
  }
#else
  value = std::fmod(value, kTwoPi);
#endif
  if (value < 0.0f) {
    value += kTwoPi;
  }
  return value;
}

inline float WrapPmPi(float value) {
#if DR4310_FAST_ANGLE_WRAP
  if (!(value > -kTwoPi && value < kTwoPi)) {
    value = std::fmod(value, kTwoPi);
  }
#else
  value = std::fmod(value, kTwoPi);
#endif
  if (value > kPi) {
    value -= kTwoPi;
  } else if (value < -kPi) {
    value += kTwoPi;
  }
  return value;
}

}  // namespace control::angle

#endif
