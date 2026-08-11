#ifndef MOTOR_IDENTIFIER_HPP
#define MOTOR_IDENTIFIER_HPP

#include "FOCController.hpp"
#include "MotorParams.hpp"

#include <cstdint>

namespace control {

enum class MotorIdState : uint8_t {
  kIdle = 0U,
  kRsPrep,
  kRsMeasure,
  kLPrep,
  kLMeasure,
  kFluxRamp,
  kFluxMeasure,
  kDone,
  kFail,
};

struct MotorIdStatus {
  MotorIdState state = MotorIdState::kIdle;
  control::MotorParams result = {};
  float rs_vd_sum = 0.0f;
  float rs_id_sum = 0.0f;
  float l_id_start = 0.0f;
  float l_id_peak = 0.0f;
  float l_time_s = 0.0f;
  float flux_vq_sum = 0.0f;
  float flux_iq_sum = 0.0f;
  float flux_we_sum = 0.0f;
  uint32_t sample_count = 0U;
  float timer_s = 0.0f;
  float id_ref_a = 0.0f;
  float iq_ref_a = 0.0f;
  float angle_override_rad = 0.0f;
  uint8_t use_angle_override = 0U;
  uint8_t use_open_loop_voltage = 0U;
  float open_loop_vd_v = 0.0f;
  float open_loop_vq_v = 0.0f;
  uint8_t fail_reason = 0U;
};

class MotorIdentifier {
 public:
  void Init();
  void Start();
  void Abort();
  bool IsActive() const;
  bool IsDone() const;
  bool IsFailed() const;
  void SlowTick(float dt,
                const FOCState &foc,
                float omega_e_rad_s,
                float bus_v);
  const MotorIdStatus &GetStatus() const;
  const control::MotorParams &GetResult() const;

 private:
  static float WrapAngle(float angle);
  void ResetAccumulators();
  void EnterState(MotorIdState state);
  bool CheckSafety(const FOCState &foc,
                   float bus_v,
                   float omega_e_rad_s);

  MotorIdStatus ident_ = {};
};

}  // namespace control

#endif
