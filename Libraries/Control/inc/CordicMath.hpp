#ifndef CORDIC_MATH_HPP
#define CORDIC_MATH_HPP

#include <cstdint>

namespace control::cordic {

class CordicMath {
 public:
  void init();
  void sinCos(float angle_rad, float &sine, float &cosine);

 private:
  static float WrapPmPi(float angle);
  static int32_t RadToQ31(float angle_rad);

  bool ready_ = false;
};

}  // namespace control::cordic

#endif
