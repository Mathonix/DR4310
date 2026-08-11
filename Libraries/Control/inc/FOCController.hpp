#ifndef FOC_CONTROLLER_HPP
#define FOC_CONTROLLER_HPP

#include "CurrentSense.hpp"
#include "CurrentLoopController.hpp"
#include "CordicMath.hpp"
#include "MotorParams.hpp"

#include "stm32g4xx_hal.h"

#include <cstdint>

namespace control {

constexpr float kFocDtS = 50.0e-6f;
constexpr float kFocPwmFreqHz = 20000.0f;

struct FOCState {
  float id_ref_a = 0.0f;
  float iq_ref_a = 0.0f;
  float id_a = 0.0f;
  float iq_a = 0.0f;
  float vd_v = 0.0f;
  float vq_v = 0.0f;
  float vd_unsat_v = 0.0f;
  float vq_unsat_v = 0.0f;
  float vd_sat_v = 0.0f;
  float vq_sat_v = 0.0f;
  float v_alpha = 0.0f;
  float v_beta = 0.0f;
  float duty_a = 0.0f;
  float duty_b = 0.0f;
  float duty_c = 0.0f;
  float bus_v = 0.0f;
  float electrical_angle_rad = 0.0f;
  float omega_e_rad_s = 0.0f;
  float max_modulation = 0.0f;
  uint8_t voltage_saturated = 0U;
  uint8_t enabled = 0U;
  uint8_t decoupling_enable = 0U;
  uint8_t angle_override_enable = 0U;
  uint8_t open_loop_voltage_enable = 0U;
  float angle_override_rad = 0.0f;
  float open_loop_vd_v = 0.0f;
  float open_loop_vq_v = 0.0f;
  uint32_t isr_count = 0U;
  uint32_t isr_overrun_count = 0U;
  uint32_t invalid_sample_count = 0U;
  uint32_t overcurrent_trip_count = 0U;
};

class FocController {
 public:
  void Init(TIM_HandleTypeDef *htim);
  void Enable(uint8_t enable);
  void SetCurrentLimit(float iq_limit_a);
  void SetCurrentPi(float kp, float ki, float out_limit_v);
  void SetCurrentKaw(float kaw);
  void SetMotorParams(const control::MotorParams &params);
  void SetDecouplingEnable(uint8_t enable);
  void SetMaxModulation(float max_mod);
  void SetRefs(float id_ref_a, float iq_ref_a);
  void SetElectricalAngle(float electrical_angle_rad);
  void SetOmegaE(float omega_e_rad_s);
  void SetAngleOverride(uint8_t enable, float electrical_angle_rad);
  void SetOpenLoopVoltage(uint8_t enable, float vd_v, float vq_v);
  void OnPwmUpdate();
  void ResetIsrBusy();
  void RunVoltageVector(float electrical_angle_rad,
                        float vd_v,
                        float vq_v,
                        float bus_v);

  void setCurrentSense(hardware::CurrentSense &sense);
  const FOCState &GetState() const;
  const control::MotorParams &GetMotorParams() const;
  const hardware::CurrentSample &GetLastCurrent() const;

 private:
  static float Clamp(float value, float low, float high);
  static float Wrap0To2Pi(float angle);
  void WritePwm(float duty_a, float duty_b, float duty_c);
  float VoltageLimit(float bus_v) const;
  void LimitVoltageCircle(float &vd, float &vq, float vmax) const;
  void ApplyModulationSc(float sin_t,
                         float cos_t,
                         float vd_v,
                         float vq_v,
                         float bus_v);
  void TripOvercurrent();

  TIM_HandleTypeDef *pwm_timer_ = nullptr;
  hardware::CurrentSense *current_sense_ = nullptr;
  control::cordic::CordicMath cordic_;
  FOCState state_ = {};
  control::MotorParams motor_ = {};
  CurrentLoopController current_loop_;
  hardware::CurrentSample last_current_ = {};
  float iq_limit_ = 2.50f;
  float pi_out_limit_v_ = 0.0f;
  float cached_vmax_ = 0.0f;
  uint8_t vmax_div_ = 0U;
  volatile uint8_t isr_busy_ = 0U;
};

}  // namespace control

#endif
