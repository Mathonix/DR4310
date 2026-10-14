#include "FOCController.hpp"

#include "SVPWM.hpp"
#include "CoggingCompensator.hpp"
#include "iq_limits.h"
#include "motor_audio.h"

#include <algorithm>
#include <cmath>

namespace control {

namespace {

constexpr float kSqrt3 = 1.73205080757f;
constexpr float kMinBusV = 6.0f;
constexpr float kDefaultMaxModulation = 0.99f;
constexpr float kDefaultIqLimitA = 2.50f;
/* 0 => no extra PI voltage clamp; use max_mod * Vbus / sqrt(3) only. */
constexpr float kDefaultCurrentOutLimitV = 0.0f;
constexpr float kDutyMin = 0.02f;
/* Vertex duty is 0.5 + m/2, so m = 0.99 asks for 0.995.
 * PWM1 centers the high pulse on the valley. A higher duty moves both
 * edges farther from the CH4 strobe (CCR 80, ~0.47 us before the valley).
 * At 0.995 the nearer edge is still ~24 us away, far outside the ADC
 * aperture. kDutyMin stays 0.02: that phase's edge is already only a few
 * counts from the strobe, and the shunts are inline so this floor is about
 * edge noise, not a low-side conduction window. */
constexpr float kDutyMax = 0.995f;
/* DRV8313 peak hard trip (instant, ISR), separate from configured Iq work limit.
 * Do not raise this to follow OL_IQ. IQ_HARD_MAX_A stays strictly below it. */
constexpr float kOvercurrentTripA = 3.50f;
static_assert(IQ_HARD_MAX_A < kOvercurrentTripA,
              "IQ_HARD_MAX_A must stay below the phase hard trip");
/* 0 = standard d=flux / q=torque; 1 = experimental swap. */
constexpr bool kSwapDq = false;
/* Refresh PI output limits every N FOC ticks (~1 kHz at 20 kHz). */
constexpr uint32_t kVmaxUpdateDivider = 20U;
/* Low-pass on electrical speed written from the 1 kHz loop. */
constexpr float kOmegaEFilterAlpha = 0.12f;
/*
 * Phase-map diagnostic: use CH1/CH2/CH3 = A/B/C while checking whether
 * the previous QDrive B/C swap is actually required on this board.
 */
constexpr bool kPwmSwapBc = false;

}  // namespace

float FocController::Clamp(float value, float low, float high) {
  return std::clamp(value, low, high);
}

float FocController::Wrap0To2Pi(float angle) {
  constexpr float kTwoPi = 6.28318530718f;
  angle = std::fmod(angle, kTwoPi);
  if (angle < 0.0f) {
    angle += kTwoPi;
  }
  return angle;
}

void FocController::WritePwm(float duty_a, float duty_b, float duty_c) {
  if (pwm_timer_ == nullptr) {
    return;
  }

  const uint32_t period = __HAL_TIM_GET_AUTORELOAD(pwm_timer_);
  const float duty_ch1 = Clamp(duty_a, 0.0f, 1.0f);
  float duty_ch2 = 0.0f;
  float duty_ch3 = 0.0f;

  if constexpr (kPwmSwapBc) {
    /* QDrive map: A->CH1, B->CH3, C->CH2 */
    duty_ch2 = Clamp(duty_c, 0.0f, 1.0f);
    duty_ch3 = Clamp(duty_b, 0.0f, 1.0f);
  } else {
    duty_ch2 = Clamp(duty_b, 0.0f, 1.0f);
    duty_ch3 = Clamp(duty_c, 0.0f, 1.0f);
  }

  __HAL_TIM_SET_COMPARE(
      pwm_timer_,
      TIM_CHANNEL_1,
      static_cast<uint32_t>(duty_ch1 * static_cast<float>(period)));
  __HAL_TIM_SET_COMPARE(
      pwm_timer_,
      TIM_CHANNEL_2,
      static_cast<uint32_t>(duty_ch2 * static_cast<float>(period)));
  __HAL_TIM_SET_COMPARE(
      pwm_timer_,
      TIM_CHANNEL_3,
      static_cast<uint32_t>(duty_ch3 * static_cast<float>(period)));
}

float FocController::VoltageLimit(float bus_v) const {
  float vmax = state_.max_modulation * bus_v / kSqrt3;
  if (pi_out_limit_v_ > 0.5f) {
    vmax = std::min(vmax, pi_out_limit_v_);
  }
  return std::max(vmax, 0.1f);
}

void FocController::LimitVoltageCircle(float &vd, float &vq, float vmax) const {
  const float mag2 = (vd * vd) + (vq * vq);
  if (mag2 <= (vmax * vmax)) {
    return;
  }

  const float mag = std::sqrt(mag2);
  if (mag < 1.0e-6f) {
    vd = 0.0f;
    vq = 0.0f;
    return;
  }

  const float scale = vmax / mag;
  vd *= scale;
  vq *= scale;
}

void FocController::ApplyModulationSc(float sin_t,
                                      float cos_t,
                                      float vd_v,
                                      float vq_v,
                                      float bus_v) {
  const float v_alpha = vd_v * cos_t - vq_v * sin_t;
  const float v_beta = vd_v * sin_t + vq_v * cos_t;

  state_.vd_v = vd_v;
  state_.vq_v = vq_v;
  state_.v_alpha = v_alpha;
  state_.v_beta = v_beta;
  state_.bus_v = bus_v;

  svpwm::DutyCycle duty;
  (void)svpwm::modulate(v_alpha,
                        v_beta,
                        bus_v,
                        kDutyMin,
                        kDutyMax,
                        duty);
  state_.duty_a = duty.a;
  state_.duty_b = duty.b;
  state_.duty_c = duty.c;
  WritePwm(state_.duty_a, state_.duty_b, state_.duty_c);
}

void FocController::TripOvercurrent() {
  audio::Global().abortSafety(audio::Reason::SafetyFault);
  state_.enabled = 0U;
  state_.open_loop_voltage_enable = 0U;
  state_.duty_a = 0.0f;
  state_.duty_b = 0.0f;
  state_.duty_c = 0.0f;
  current_loop_.reset();
  WritePwm(0.0f, 0.0f, 0.0f);
  state_.overcurrent_trip_count++;
}

void FocController::Init(TIM_HandleTypeDef *htim) {
  pwm_timer_ = htim;
  cordic_.init();
  motor_params::setDefaults(motor_);
  state_.max_modulation = kDefaultMaxModulation;
  state_.voltage_saturated = 0U;
  state_.vd_unsat_v = 0.0f;
  state_.vq_unsat_v = 0.0f;
  state_.vd_sat_v = 0.0f;
  state_.vq_sat_v = 0.0f;
  state_.decoupling_enable = 0U;
  state_.angle_override_enable = 0U;
  state_.open_loop_voltage_enable = 0U;
  state_.isr_count = 0U;
  state_.isr_overrun_count = 0U;
  state_.invalid_sample_count = 0U;
  state_.overcurrent_trip_count = 0U;
  vmax_div_ = 0U;
  angle_direct_enable_ = 0U;
  SetCurrentPi(motor_params::kDefaultCurrentKp,
               motor_params::kDefaultCurrentKi,
               kDefaultCurrentOutLimitV);
  Enable(0U);
}

void FocController::setCurrentSense(hardware::CurrentSense &sense) {
  current_sense_ = &sense;
}

void FocController::Enable(uint8_t enable) {
  if (state_.enabled == enable) {
    return;
  }

  state_.enabled = enable;
  current_loop_.reset();

  if (enable == 0U) {
    state_.duty_a = 0.0f;
    state_.duty_b = 0.0f;
    state_.duty_c = 0.0f;
    state_.open_loop_voltage_enable = 0U;
    WritePwm(0.0f, 0.0f, 0.0f);
  }
}

void FocController::SetCurrentLimit(float iq_limit_a) {
  float limit = std::fabs(iq_limit_a);
  if (!(limit <= IQ_HARD_MAX_A)) {
    limit = (!(limit >= 0.0f)) ? 0.0f : IQ_HARD_MAX_A;
  }
  iq_limit_ = limit;
}

void FocController::SetCurrentPi(float kp, float ki, float out_limit_v) {
  /* out_limit_v <= 0: bus-following only (no fixed V clamp). */
  out_limit_v = std::max(out_limit_v, 0.0f);
  pi_out_limit_v_ = out_limit_v;

  if (out_limit_v > 0.5f) {
    cached_vmax_ = out_limit_v;
    current_loop_.init(kp, ki, -out_limit_v, out_limit_v);
  } else {
    /* Wide initial limits; ISR refreshes from bus at 1 kHz. */
    cached_vmax_ = 50.0f;
    current_loop_.init(kp, ki, -50.0f, 50.0f);
  }
  /* init() clears the back-calculation gain. Put the last Kaw back so a
   * live Kp/Ki write does not disable anti-windup. */
  current_loop_.setBackCalculationGain(pi_kaw_);
}

void FocController::SetCurrentKaw(float kaw) {
  pi_kaw_ = kaw;
  current_loop_.setBackCalculationGain(pi_kaw_);
}

void FocController::SetMotorParams(const MotorParams &params) {
  MotorParams next = params;
  if (next.pole_pairs < 1.0f) {
    next.pole_pairs = 1.0f;
  }
  /* The 20 kHz ISR reads motor_ while this runs on the main loop. Build the
   * new value first, then publish the whole struct with IRQs off. */
  const uint32_t primask = __get_PRIMASK();
  __disable_irq();
  motor_ = next;
  __set_PRIMASK(primask);
}

void FocController::SetMinBusVoltage(float min_v) {
  if (!(min_v >= kMinBusV)) {
    min_v = kMinBusV;
  }
  min_bus_v_ = min_v;
}

void FocController::SetDecouplingEnable(uint8_t enable) {
  state_.decoupling_enable = enable != 0U ? 1U : 0U;
}

void FocController::SetMaxModulation(float max_mod) {
  state_.max_modulation = Clamp(max_mod, 0.1f, 0.99f);
}

void FocController::SetRefs(float id_ref_a, float iq_ref_a) {
  state_.id_ref_a = id_ref_a;
  iq_command_a_ = iq_ref_a;
  state_.iq_ref_a = Clamp(iq_ref_a, -iq_limit_, iq_limit_);
}

void FocController::SetCoggingFeedforward(float iq_a) {
  state_.cogging_iq_a = std::isfinite(iq_a) ?
      Clamp(iq_a, -COGGING_LIMIT_MAX_A, COGGING_LIMIT_MAX_A) : 0.0f;
}

void FocController::SetElectricalAngle(float electrical_angle_rad) {
  angle_direct_enable_ = 0U;
  state_.electrical_angle_rad = Wrap0To2Pi(electrical_angle_rad);
}

void FocController::SetDirectElectricalAngle(float electrical_angle_rad) {
  angle_direct_enable_ = 1U;
  state_.electrical_angle_rad = Wrap0To2Pi(electrical_angle_rad);
}

void FocController::SetOmegaE(float omega_e_rad_s) {
  state_.omega_e_rad_s +=
      kOmegaEFilterAlpha * (omega_e_rad_s - state_.omega_e_rad_s);
}

void FocController::SetAngleOverride(uint8_t enable,
                                     float electrical_angle_rad) {
  state_.angle_override_enable = enable != 0U ? 1U : 0U;
  state_.angle_override_rad = Wrap0To2Pi(electrical_angle_rad);
}

void FocController::SetOpenLoopVoltage(uint8_t enable,
                                       float vd_v,
                                       float vq_v) {
  state_.open_loop_voltage_enable = enable != 0U ? 1U : 0U;
  state_.open_loop_vd_v = vd_v;
  state_.open_loop_vq_v = vq_v;
}

void FocController::OnPwmUpdate() {
  state_.audio_cmd_a=0;
  if(audio::Global().stopRequested())Enable(0);
  if (isr_busy_ != 0U) {
    state_.isr_overrun_count++;
    return;
  }

  isr_busy_ = 1U;
  state_.isr_count++;

  if ((pwm_timer_ == nullptr) || (current_sense_ == nullptr)) {
    isr_busy_ = 0U;
    return;
  }

  hardware::CurrentSample current;
  if (current_sense_->getLatest(current) != HAL_OK) {
    state_.invalid_sample_count++;
    if (state_.enabled != 0U) {
      WritePwm(0.0f, 0.0f, 0.0f);
    }
    isr_busy_ = 0U;
    return;
  }
  last_current_ = current;

  const float bus_v = current.bus_v;
  state_.bus_v = bus_v;

  if ((std::fabs(current.ia_a) > kOvercurrentTripA) ||
      (std::fabs(current.ib_a) > kOvercurrentTripA) ||
      (std::fabs(current.ic_a) > kOvercurrentTripA)) {
    TripOvercurrent();
    isr_busy_ = 0U;
    return;
  }

  if (state_.enabled == 0U) {
    WritePwm(0.0f, 0.0f, 0.0f);
    isr_busy_ = 0U;
    return;
  }

  if (bus_v < min_bus_v_) {
    audio::Global().abortSafety(audio::Reason::SafetyFault);
    Enable(0U);
    WritePwm(0.0f, 0.0f, 0.0f);
    isr_busy_ = 0U;
    return;
  }

  /* PI voltage limits: update at ~1 kHz, not every 50 us. */
  if (++vmax_div_ >= kVmaxUpdateDivider) {
    vmax_div_ = 0U;
    cached_vmax_ = VoltageLimit(bus_v);
    current_loop_.setOutputLimits(-cached_vmax_, cached_vmax_);
  }

  float electrical_angle = state_.electrical_angle_rad;
  if (state_.angle_override_enable != 0U) {
    electrical_angle = state_.angle_override_rad;
  } else if (angle_direct_enable_ == 0U) {
    electrical_angle =
        Wrap0To2Pi(state_.electrical_angle_rad +
                   (state_.omega_e_rad_s * kFocDtS));
  }
  state_.electrical_angle_rad = electrical_angle;

  /* One CORDIC cosine call -> cos + sin (shared by Park and InvPark). */
  float sin_t = 0.0f;
  float cos_t = 0.0f;
  cordic_.sinCos(electrical_angle, sin_t, cos_t);

  const float i_alpha = current.ia_a;
  const float i_beta = (current.ia_a + (2.0f * current.ib_a)) / kSqrt3;
  const float id_calc = (i_alpha * cos_t) + (i_beta * sin_t);
  const float iq_calc = (-i_alpha * sin_t) + (i_beta * cos_t);

  if constexpr (kSwapDq) {
    state_.id_a = iq_calc;
    state_.iq_a = id_calc;
  } else {
    state_.id_a = id_calc;
    state_.iq_a = iq_calc;
  }

  if (audio::Global().gate() &&
      (state_.open_loop_voltage_enable || state_.angle_override_enable ||
       !std::isfinite(state_.id_a) || !std::isfinite(state_.iq_a) ||
       std::fabs(state_.id_a)>kOvercurrentTripA || std::fabs(state_.iq_a)>kOvercurrentTripA)) {
    audio::Global().abortSafety(audio::Reason::SafetyFault);
    Enable(0);isr_busy_=0;return;
  }
  if (state_.open_loop_voltage_enable != 0U) {
    if constexpr (kSwapDq) {
      ApplyModulationSc(sin_t,
                        cos_t,
                        state_.open_loop_vq_v,
                        state_.open_loop_vd_v,
                        bus_v);
    } else {
      ApplyModulationSc(sin_t,
                        cos_t,
                        state_.open_loop_vd_v,
                        state_.open_loop_vq_v,
                        bus_v);
    }
    isr_busy_ = 0U;
    return;
  }

  // Recompute from the base command every tick; never accumulate feedforward.
  state_.iq_ref_a = CoggingCompensator::Combine(iq_command_a_,
                                               state_.cogging_iq_a, iq_limit_);

  float id_cmd=state_.id_ref_a,iq_cmd=state_.iq_ref_a;
  if(audio::Global().gate()) {
    state_.audio_cmd_a=audio::Global().tick20kHz();
    if(audio::Global().stopRequested()) {Enable(0);isr_busy_=0;return;}
    audio::LimitAudioVector(id_cmd,iq_cmd,state_.audio_cmd_a,
                          audio::Global().axis()==audio::Axis::Q,
                          audio::Global().amplitudeA(),iq_limit_);
  }
  const CurrentLoopVoltage voltage =
      current_loop_.update(id_cmd,
                           iq_cmd,
                           state_.id_a,
                           state_.iq_a,
                           kFocDtS);
  float vd_unsat = voltage.vd_v;
  float vq_unsat = voltage.vq_v;

  if (state_.decoupling_enable != 0U) {
    vd_unsat -= state_.omega_e_rad_s * motor_.lq_h * state_.iq_a;
    vq_unsat += state_.omega_e_rad_s * motor_.ld_h * state_.id_a;
    vq_unsat += state_.omega_e_rad_s * motor_.flux_wb;
  }

  const float vmax = cached_vmax_;
  const float mag2 = (vd_unsat * vd_unsat) + (vq_unsat * vq_unsat);
  state_.voltage_saturated = mag2 > (vmax * vmax) ? 1U : 0U;
  state_.vd_unsat_v = vd_unsat;
  state_.vq_unsat_v = vq_unsat;

  float vd_sat = vd_unsat;
  float vq_sat = vq_unsat;
  LimitVoltageCircle(vd_sat, vq_sat, vmax);
  state_.vd_sat_v = vd_sat;
  state_.vq_sat_v = vq_sat;

  current_loop_.applySaturationFeedback(vd_sat - vd_unsat,
                                        vq_sat - vq_unsat,
                                        kFocDtS);

  if constexpr (kSwapDq) {
    ApplyModulationSc(sin_t, cos_t, vq_sat, vd_sat, bus_v);
  } else {
    ApplyModulationSc(sin_t, cos_t, vd_sat, vq_sat, bus_v);
  }
  isr_busy_ = 0U;
}

void FocController::ResetIsrBusy() {
  isr_busy_ = 0U;
}

void FocController::RunVoltageVector(float electrical_angle_rad,
                                     float vd_v,
                                     float vq_v,
                                     float bus_v) {
  (void)bus_v;
  Enable(1U);
  SetAngleOverride(1U, electrical_angle_rad);
  SetOpenLoopVoltage(1U, vd_v, vq_v);
  SetRefs(0.0f, 0.0f);
}

const FOCState &FocController::GetState() const {
  return state_;
}

const MotorParams &FocController::GetMotorParams() const {
  return motor_;
}

const hardware::CurrentSample &FocController::GetLastCurrent() const {
  return last_current_;
}

}  // namespace control
