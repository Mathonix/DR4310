#include "ElectricalAngle.hpp"

#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace {

constexpr float kTwoPi = 6.28318530718f;
constexpr float kPolePairs = 14.0f;

float OldElectricalAngle(float raw_angle_rad,
                         bool invert_direction,
                         float zero_rad) {
  const float canonical =
      invert_direction ? -raw_angle_rad : raw_angle_rad;
  float mech = std::fmod(zero_rad + canonical, kTwoPi);
  if (mech < 0.0f) {
    mech += kTwoPi;
  }
  float theta_e = std::fmod(mech * kPolePairs, kTwoPi);
  if (theta_e < 0.0f) {
    theta_e += kTwoPi;
  }
  return theta_e;
}

void ExpectSame(float raw_angle_rad,
                bool invert_direction,
                float zero_rad) {
  const float canonical =
      invert_direction ? -raw_angle_rad : raw_angle_rad;
  const float old_theta =
      OldElectricalAngle(raw_angle_rad, invert_direction, zero_rad);
  const float new_theta =
      control::ElectricalAngleFromCanonicalMechanical(
          canonical, zero_rad, kPolePairs);
  const float diff = std::fabs(old_theta - new_theta);
  if (diff > 1.0e-5f) {
    std::fprintf(stderr,
                 "FAIL zero regression: raw=%.4f inv=%d zero=%.4f old=%.6f new=%.6f\n",
                 raw_angle_rad,
                 invert_direction ? 1 : 0,
                 zero_rad,
                 old_theta,
                 new_theta);
    std::abort();
  }
}

}  // namespace

int main() {
  ExpectSame(0.0f, false, 0.0f);
  ExpectSame(1.0f, false, 0.2f);
  ExpectSame(1.0f, true, 0.2f);
  ExpectSame(5.8f, false, 0.35f);
  ExpectSame(5.8f, true, 0.35f);
  ExpectSame(3.1f, false, 1.2f);
  ExpectSame(3.1f, true, 1.2f);

  std::printf("Electrical zero regression tests passed\n");
  return 0;
}
