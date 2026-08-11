#include "CordicMath.hpp"

#include "stm32g4xx.h"

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace control::cordic {

namespace {

constexpr float kRadToQ31Scale = 683565275.5764316f;
constexpr float kQ31ToF32Scale = 1.0f / 2147483648.0f;
constexpr float kTwoPi = 6.28318530718f;
constexpr float kPi = 3.14159265359f;
constexpr uint32_t kMaxReadyWait = 32U;

}  // namespace

void CordicMath::init() {
  /*
   * FUNC = COSINE (0): RES1=cos, RES2=sin
   * PRECISION = 6 cycles (~20 bit, enough for FOC)
   * SCALE = 0
   * NARGS = 0 ? one write (angle only, modulus defaults to 1.0)
   * NRES  = 1 ? two reads (cos then sin)
   * ARGSIZE/RESSIZE = 32-bit q1.31
   */
  RCC->AHB1ENR |= RCC_AHB1ENR_CORDICEN;
  (void)RCC->AHB1ENR;

  CORDIC->CSR =
      (0U << CORDIC_CSR_FUNC_Pos) |
      (6U << CORDIC_CSR_PRECISION_Pos) |
      (0U << CORDIC_CSR_SCALE_Pos) |
      (0U) |
      CORDIC_CSR_NRES |
      (0U) |
      (0U);

  ready_ = true;
}

float CordicMath::WrapPmPi(float angle) {
  angle = std::fmod(angle, kTwoPi);
  if (angle > kPi) {
    angle -= kTwoPi;
  } else if (angle < -kPi) {
    angle += kTwoPi;
  }
  return angle;
}

int32_t CordicMath::RadToQ31(float angle_rad) {
  const float scaled = WrapPmPi(angle_rad) * kRadToQ31Scale;
  const float clamped =
      std::clamp(scaled, -2147483648.0f, 2147483647.0f);
  return static_cast<int32_t>(clamped);
}

void CordicMath::sinCos(float angle_rad, float &sine, float &cosine) {
  if (!ready_) {
    init();
  }

  const int32_t arg = RadToQ31(angle_rad);
  CORDIC->WDATA = static_cast<uint32_t>(arg);

  uint32_t guard = kMaxReadyWait;
  while (((CORDIC->CSR & CORDIC_CSR_RRDY) == 0U) && (guard > 0U)) {
    guard--;
  }

  const int32_t res_cos = static_cast<int32_t>(CORDIC->RDATA);
  const int32_t res_sin = static_cast<int32_t>(CORDIC->RDATA);

  cosine = static_cast<float>(res_cos) * kQ31ToF32Scale;
  sine = static_cast<float>(res_sin) * kQ31ToF32Scale;
}

}  // namespace control::cordic
