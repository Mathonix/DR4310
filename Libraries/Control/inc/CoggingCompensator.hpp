#ifndef COGGING_COMPENSATOR_HPP
#define COGGING_COMPENSATOR_HPP

#include "cogging_types.h"

namespace control {

class CoggingCompensator {
 public:
  static bool Matches(const CoggingMap &map, uint8_t direction,
                      uint8_t pole_pairs, float electrical_zero_rad);
  static bool SupportsMode(uint8_t mode);
  static float Lookup(const CoggingMap &map, float raw_angle_rad);
  static float Combine(float base_iq_a, float compensation_a, float limit_a);
  // Enabling fades in over 100 ms. Disabling/interlocks drop the term at once.
  float update(const CoggingMap &map, float raw_angle_rad, bool allowed,
               float gain, float limit_a, float dt);
 private:
  float blend_ = 0.0f;
};

}  // namespace control
#endif
