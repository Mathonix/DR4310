#include "SVPWM.hpp"

#include <algorithm>
#include <array>

namespace control::svpwm {

constexpr float kHalfSqrt3 = 0.86602540378f;
constexpr float kMinBusVoltage = 1.0f;

bool modulate(float v_alpha,
              float v_beta,
              float bus_v,
              float duty_min,
              float duty_max,
              DutyCycle &duty) {
  if (bus_v < kMinBusVoltage) {
    duty = {0.5f, 0.5f, 0.5f};
    return false;
  }

  /* Inverse Clarke (amplitude-invariant form used by existing FOC path). */
  std::array<float, 3> phase_voltages = {
      v_alpha,
      -0.5f * v_alpha + kHalfSqrt3 * v_beta,
      -0.5f * v_alpha - kHalfSqrt3 * v_beta,
  };

  const auto voltage_range = std::minmax_element(phase_voltages.begin(), phase_voltages.end());

  /* Zero-sequence injection (centered SVPWM). */
  const float vcom = 0.5f * (*voltage_range.first + *voltage_range.second);
  const float inv_bus = 1.0f / bus_v;

  duty.a = std::clamp(0.5f + ((phase_voltages[0] - vcom) * inv_bus), duty_min, duty_max);
  duty.b = std::clamp(0.5f + ((phase_voltages[1] - vcom) * inv_bus), duty_min, duty_max);
  duty.c = std::clamp(0.5f + ((phase_voltages[2] - vcom) * inv_bus), duty_min, duty_max);
  return true;
}

}  // namespace control::svpwm
