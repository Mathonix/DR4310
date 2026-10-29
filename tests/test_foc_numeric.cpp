// Compile the complete production FOC with only peripherals replaced on host.
#include "FOCController.hpp"
#include "AngleWrap.hpp"
#include "ElectricalAngle.hpp"

#include <array>
#include <cassert>
#include <cmath>
#include <cstdio>

namespace {
hardware::CurrentSample input;
HAL_StatusTypeDef sample_status = HAL_OK;
}
namespace hardware {
HAL_StatusTypeDef CurrentSense::getLatest(CurrentSample &sample) {
  sample = input;
  return sample_status;
}
}
namespace control::cordic {
void CordicMath::init() { ready_ = true; }
void CordicMath::sinCos(float radians, float &sine, float &cosine) {
  // Hardware CORDIC is not simulated: compare its exact input and model
  // sine/cosine consistently for both builds of the surrounding FOC.
  radians = angle::WrapPmPi(radians);
  sine = std::sin(radians); cosine = std::cos(radians);
}
}

int main(int argc, char **argv) {
  assert(argc == 2);
  FILE *out = std::fopen(argv[1], "wb");
  assert(out);
  TIM_HandleTypeDef timer{};
  hardware::CurrentSense sense;
  control::FocController foc;
  foc.Init(&timer);
  foc.setCurrentSense(sense);
  foc.SetCurrentLimit(1.9f);
  for (unsigned i=0; i<20000; ++i) {
    const float phase = static_cast<float>(i % 1000) * 0.00628318530718f;
    input.ia_a = (static_cast<int>(i % 53) - 26) * 0.1f;
    input.ib_a = (static_cast<int>(i % 31) - 15) * 0.08f;
    input.ic_a = -input.ia_a - input.ib_a;
    input.bus_v = 8.0f + static_cast<float>(i % 401) * 0.05f;
    sample_status = i % 701 == 0 ? HAL_ERROR : HAL_OK;
    foc.Enable(i % 107 == 0 ? 0 : 1);
    foc.SetRefs((static_cast<int>(i % 17) - 8) * 0.03f,
                (static_cast<int>(i % 73) - 36) * 0.09f);
    foc.SetCoggingFeedforward((static_cast<int>(i % 11) - 5) * 0.01f);
    const float theta = control::ElectricalAngleFromCanonicalMechanical(
        phase + static_cast<float>(i / 1000) * 5000.0f, 0.18569493f, 14);
    foc.SetDirectElectricalAngle(theta);
    foc.SetAngleOverride(i % 233 < 4 ? 1 : 0, -phase);
    foc.SetOpenLoopVoltage(i % 233 < 2 ? 1 : 0, 0.3f, -0.2f);
    foc.SetDecouplingEnable(i % 149 < 50 ? 1 : 0);
    foc.SetOmegaE(phase * 100.0f);
    foc.SetMaxModulation(i % 37 < 3 ? 0.3f : 0.99f);
    if (i % 503 == 0) foc.SetCurrentPi(6.0f, i % 2 ? 29000.0f : 6816.0f, 0);
    foc.OnPwmUpdate();
    const auto &s = foc.GetState();
    const std::array<float, 22> values = {
      s.id_ref_a, s.iq_ref_a, s.cogging_iq_a, s.id_a, s.iq_a,
      s.vd_v, s.vq_v, s.vd_unsat_v, s.vq_unsat_v, s.vd_sat_v, s.vq_sat_v,
      s.v_alpha, s.v_beta, s.duty_a, s.duty_b, s.duty_c, s.bus_v,
      s.electrical_angle_rad, s.omega_e_rad_s, s.angle_override_rad,
      s.open_loop_vd_v, s.open_loop_vq_v};
    for (float value : values) assert(std::isfinite(value));
    const std::array<uint32_t, 8> flags = {
      s.enabled, s.isr_count, s.isr_overrun_count, s.invalid_sample_count,
      s.overcurrent_trip_count, timer.compare[0], timer.compare[1], timer.compare[2]};
    assert(std::fwrite(values.data(), sizeof(values), 1, out) == 1);
    assert(std::fwrite(flags.data(), sizeof(flags), 1, out) == 1);
  }
  assert(std::fclose(out) == 0);
}
