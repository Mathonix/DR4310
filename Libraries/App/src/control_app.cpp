#include "control_app.h"

#include "CurrentSense.hpp"
#include "MT6701.hpp"
#include "HardwareBridge.h"
#include "FOCController.hpp"
#include "SpeedController.hpp"
#include "PositionController.hpp"
#include "TrajectoryGenerator.hpp"
#include "MotorIdentifier.hpp"
#include "MotorParams.hpp"
#include "RotorEstimator.hpp"
#include "FaultManager.hpp"
#include "main.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>

namespace app {
/* 控制频率 单位ms*/
constexpr uint32_t kControlPeriodMs = 1U;
/* 控制周期 单位s */
constexpr float kControlDtS = 0.001f;
/* 电机极对数 */
constexpr uint8_t kMotorPolePairsU8 = 14U;
constexpr float kMotorPolePairs = 14.0f;

constexpr float kTwoPi = 6.28318530718f;
constexpr float kPi = 3.14159265359f;

constexpr uint32_t kFaultEncoder = 0x00000001UL;
constexpr uint32_t kFaultCurrent = 0x00000002UL;
constexpr uint32_t kFaultDrv = 0x00000004UL;
constexpr uint32_t kFaultBusUndervolt = 0x00000008UL;
/* DRV8313 / FOC need a real bus. 5 V debug supply must NOT enable power stage. */
constexpr float kBusMinEnableV = 6.0f;
/* Require continuous good bus samples before arming FOC after boot/mode entry. */
constexpr uint16_t kBusOkSettleMs = 50U;
constexpr float kOpenLoopRampRadS2 = 10.0f;
constexpr float kCurrentTestRampAS = 0.50f;
constexpr float kSpeedRefRampRadS2 = 3.1416f; /* ~30 rpm/s */
constexpr float kCurrentLoopOmegaC = 1200.0f;
constexpr float kIqSoftLimitA = 2.50f;
constexpr float kRpmToRadS = 0.10471975512f;
constexpr float kRadSToRpm = 1.0f / kRpmToRadS;
/* 上电后自动进入速度闭环，并以该转速启动；改这里即可改默认目标转速。 */
constexpr float kBootSpeedRpm = 100.0f;
constexpr float kBootSpeedRadS = kBootSpeedRpm * kRpmToRadS;
/*
 * Open-loop Vq tracks bus:
 *   Vq = bus_v * mod   (mod ramps with |omega|/omega_ref)
 */
constexpr float kOpenLoopModMin = 0.015f;
constexpr float kOpenLoopModMax = 0.050f;
/* Encoder increasing angle vs +iq rotation polarity on this board.
 * With the corrected phase/current map, +iq still decreases encoder
 * angle, so MIT maps torque to -iq. */
constexpr float kTorqueIqSign = -1.0f;
constexpr uint32_t kVofaDebugPeriodMs = 10U;
constexpr uint32_t kVofaDebugTimeoutMs = 20U;
constexpr uint8_t kVofaJustfloatTail0 = 0x00U;
constexpr uint8_t kVofaJustfloatTail1 = 0x00U;
constexpr uint8_t kVofaJustfloatTail2 = 0x80U;
constexpr uint8_t kVofaJustfloatTail3 = 0x7FU;
constexpr float kDefaultElectricalZeroRad = 0.0f;
constexpr uint8_t kDefaultEncoderDirection = 1U;
constexpr uint32_t kEncoderFaultThreshold = 10U;
constexpr uint16_t kDrvFaultSettleMs = 20U;
constexpr uint16_t kDrvFaultLowDebounceMs = 5U;
constexpr uint32_t kOuterLoopIsrTicks = 20U;
constexpr uint32_t kCpuClockHz = 170000000U;
constexpr size_t kVofaFrameValueCount = 6U;
constexpr size_t kVofaFrameBytes = (kVofaFrameValueCount * sizeof(float)) + 4U;
constexpr size_t kVofaRingFrames = 4U;
constexpr float kCalibAlignVoltageV = 1.20f;
constexpr float kCalibDirVoltageV = 0.72f;
constexpr uint16_t kCalibDirHoldMs = 120U;
constexpr uint16_t kCalibDirSweepMs = 500U;
constexpr uint16_t kCalibZeroSweepMs = 250U;
constexpr uint16_t kCalibZeroHoldMs = 300U;
constexpr uint16_t kCalibSampleMs = 100U;

constexpr uint8_t kModeIdle = CTRL_MODE_IDLE;
constexpr uint8_t kModeCurrent = CTRL_MODE_CURRENT;
constexpr uint8_t kModeSpeed = CTRL_MODE_SPEED;
constexpr uint8_t kModePosition = CTRL_MODE_POSITION;
constexpr uint8_t kModeMit = CTRL_MODE_MIT;
constexpr uint8_t kModeAlign = CTRL_MODE_ALIGN;
constexpr uint8_t kModeOpenLoop = CTRL_MODE_OPEN_LOOP;
constexpr uint8_t kModeIdent = CTRL_MODE_IDENT;
constexpr uint8_t kModeCalibrate = CTRL_MODE_CALIBRATE;

enum class CalibState : uint8_t {
  kIdle = 0U,
  kDirHold,
  kDirSweep,
  kDirSampleEnd,
  kZeroSweep,
  kZeroHold,
  kZeroSample,
  kDone,
  kFail,
};

std::array<uint8_t, kVofaFrameBytes * kVofaRingFrames> g_vofa_ring = {};
std::array<uint8_t, kVofaFrameBytes> g_vofa_tx_frame = {};
uint16_t g_vofa_head = 0U;
uint16_t g_vofa_tail = 0U;
volatile uint8_t g_vofa_tx_busy = 0U;

void VofaPump(UART_HandleTypeDef *uart) {
  if ((uart == nullptr) || (g_vofa_tx_busy != 0U) ||
      (g_vofa_head == g_vofa_tail)) {
    return;
  }

  std::memcpy(g_vofa_tx_frame.data(),
              &g_vofa_ring[g_vofa_tail * kVofaFrameBytes],
              kVofaFrameBytes);
  g_vofa_tail = static_cast<uint16_t>((g_vofa_tail + 1U) %
                                      kVofaRingFrames);
  g_vofa_tx_busy = 1U;
  if (HAL_UART_Transmit_IT(uart, g_vofa_tx_frame.data(),
                           static_cast<uint16_t>(g_vofa_tx_frame.size())) !=
      HAL_OK) {
    g_vofa_tx_busy = 0U;
  }
}

}  // namespace app

/* Unified mode: boot IDLE so shaft is free until host arms a mode. */
volatile uint8_t control_mode_cmd = CTRL_MODE_IDLE;

/* Legacy flags kept for debug/old scripts. */
volatile uint8_t control_enable = 0U;
volatile uint8_t control_open_loop_enable = 0U;
volatile uint8_t control_current_test_enable = 0U;
volatile uint8_t control_align_enable = 0U;
volatile uint8_t control_position_enable = 0U;
volatile uint8_t control_ident_enable = 0U;
volatile uint8_t control_calibrate_enable = 0U;

volatile float control_velocity_ref_rad_s = 0.0f;
volatile float control_position_target_rad = 0.0f;
volatile float control_position_kp = 3.5f;
volatile float control_position_ki = 1.2f;
volatile float control_position_kd = 2.6f;
volatile float control_position_velocity_limit_rad_s = 5.76f; /* ~55 rpm */
volatile float control_position_i_sep_rad = 0.35f;
volatile float control_open_loop_voltage_v = app::kOpenLoopModMax;

volatile float control_current_test_iq_ref_a = 0.0f;
volatile float control_current_test_angle_rad = 0.0f;
volatile float control_align_angle_rad = 0.0f;
volatile float control_align_voltage_v = 0.6f;
volatile float control_current_pi_kp = 12.0f;
volatile float control_current_pi_ki = 1500.0f;
volatile float control_current_pi_out_limit_v = 0.0f;
volatile float control_current_pi_kaw = 0.5f;
volatile float control_iq_limit_a = 0.50f;
/* 速度环默认 Kp/Ki；上电会使用这里，也可通过 RAM 实时修改。 */
volatile float control_speed_pi_kp = 0.10f;
volatile float control_speed_pi_ki = 0.02f;
volatile float control_speed_pi_kd = 0.0f;
volatile float control_accel_ref_rad_s2 = 0.0f;
volatile float control_electrical_zero_rad = app::kDefaultElectricalZeroRad;
volatile uint8_t control_encoder_direction = app::kDefaultEncoderDirection;
volatile float control_max_modulation = 0.90f;
volatile uint8_t control_decoupling_enable = 0U;

/* MIT: tau = kp*(pos_des-pos) + kd*(vel_des-vel) + tau_ff -> mapped to iq. */
volatile float control_mit_pos_rad = 0.0f;
volatile float control_mit_vel_rad_s = 0.0f;
volatile float control_mit_kp = 10.0f;
volatile float control_mit_kd = 0.5f;
volatile float control_mit_iq_ff_a = 0.0f;

namespace app {

class ApplicationController {
 public:
  void Init(ADC_HandleTypeDef *hadc,
            SPI_HandleTypeDef *hspi_encoder,
            TIM_HandleTypeDef *htim_pwm,
            UART_HandleTypeDef *huart_debug);
  void Update();
  void SetMode(uint8_t mode);
  void SetCurrentRef(float iq_ref_a);
  void SetSpeedRef(float velocity_ref_rad_s);
  void SetPositionRef(float position_target_rad);
  void SetMitCommand(float pos_rad, float vel_rad_s, float kp, float kd, float iq_ff_a);
  void Disable();
  void ClearFaults();
  uint32_t GetLatchedFaults() const;
  const ControlTelemetry_t &GetTelemetry() const;

 private:
  static void OnCurrentSample(void *context);
  static float Wrap0To2Pi(float angle);
  static float WrapPmPi(float angle);
  static float Clamp(float value, float low, float high);
  static float SlewRateLimit(float current_value, float target_value, float max_delta);
  void ClearLegacyModeFlags();
  float ComputeElectricalAngle(float encoder_angle_rad) const;
  void CalibReset();
  void CalibStart();
  void CalibStep(float encoder_angle_rad);
  void ArmPowerStage();
  void DisarmPowerStage();
  uint8_t UpdatePowerStageArm(float bus_v);
  void ResetOuterLoopRamps();
  void ApplyIdentResultIfReady();
  void SendVofaDebug();
  void UpdateUnwrappedPosition();
  uint8_t ResolveControlMode() const;
  void OnModeEnter(uint8_t new_mode, uint8_t prev_mode);

  UART_HandleTypeDef *debug_uart_ = nullptr;
  TIM_HandleTypeDef *pwm_timer_ = nullptr;
  uint32_t last_control_tick_ = 0U;
  ControlTelemetry_t telemetry_ = {};
  hardware::CurrentSense current_sense_;
  hardware::MT6701 encoder_hw_;
  control::FocController foc_;
  control::SpeedController speed_controller_;
  control::PositionController position_controller_;
  control::TrajectoryGenerator trajectory_;
  control::RotorEstimator rotor_estimator_;
  control::MotorIdentifier identifier_;
  safety::FaultManager fault_manager_;
  hardware::EncoderSample encoder_ = {};
  hardware::CurrentSample current_ = {};
  float open_loop_electrical_angle_rad_ = 0.0f;
  float open_loop_velocity_rad_s_ = 0.0f;
  float current_test_iq_ref_a_ = 0.0f;
  float applied_current_pi_kp_ = 12.0f;
  float applied_current_pi_ki_ = 1500.0f;
  float applied_current_pi_out_limit_v_ = 0.0f;
  float applied_current_pi_kaw_ = 0.5f;
  float applied_iq_limit_a_ = 0.0f;
  float applied_speed_pi_kp_ = 0.10f;
  float applied_speed_pi_ki_ = 0.02f;
  float applied_speed_pi_kd_ = 0.0f;
  float applied_position_kp_ = 3.5f;
  float applied_position_ki_ = 1.2f;
  float applied_position_kd_ = 2.6f;
  float applied_position_vel_limit_ = 5.76f;
  float applied_position_isep_ = 0.35f;
  float applied_trajectory_accel_ = 5.0f;
  float applied_max_modulation_ = 0.90f;
  uint8_t applied_decoupling_enable_ = 0U;
  float speed_ref_applied_rad_s_ = 0.0f;
  float active_velocity_ref_rad_s_ = 0.0f;
  float active_position_ref_rad_ = 0.0f;
  float active_accel_ref_rad_s2_ = 0.0f;
  uint8_t last_control_mode_ = kModeIdle;
  uint8_t ident_started_ = 0U;
  float last_good_electrical_angle_ = 0.0f;
  uint8_t encoder_valid_ = 0U;
  float position_unwrapped_rad_ = 0.0f;
  float last_encoder_angle_rad_ = 0.0f;
  uint8_t position_inited_ = 0U;
  uint8_t position_ref_pending_ = 0U;
  uint8_t mit_cmd_pending_ = 0U;
  uint16_t bus_ok_ms_ = 0U;
  uint16_t drv_fault_ok_ms_ = 0U;
  uint16_t drv_fault_low_ms_ = 0U;
  uint8_t arm_bus_ok_ = 0U;
  uint8_t arm_drv_ok_ = 0U;
  uint8_t arm_encoder_ok_ = 0U;
  uint8_t arm_sense_ok_ = 0U;
  uint8_t arm_no_fault_ = 0U;
  uint8_t arm_all_ok_ = 0U;
  uint8_t power_stage_armed_ = 0U;
  uint32_t last_overcurrent_trip_count_ = 0U;
  uint32_t last_invalid_sample_count_ = 0U;
  uint32_t last_foc_isr_count_ = 0U;
  uint32_t last_foc_overrun_count_ = 0U;
  uint8_t outer_loop_due_ = 0U;
  uint32_t last_outer_loop_cyccnt_ = 0U;
  uint32_t outer_loop_count_ = 0U;
  uint32_t outer_loop_miss_count_ = 0U;
  uint32_t outer_loop_dt_us_ = 0U;
  uint32_t outer_loop_dt_max_us_ = 0U;
  CalibState calib_state_ = CalibState::kIdle;
  uint16_t calib_timer_ms_ = 0U;
  uint16_t calib_sample_count_ = 0U;
  uint8_t calib_pair_index_ = 0U;
  float calib_begin_angle_ = 0.0f;
  float calib_end_angle_ = 0.0f;
  float calib_zero_sum_ = 0.0f;
  float calib_angle_cmd_ = 0.0f;
  float calib_voltage_cmd_ = 0.0f;
  uint32_t last_vofa_tick_ = 0U;
};

float ApplicationController::Wrap0To2Pi(float angle) {
  angle = std::fmod(angle, kTwoPi);
  if (angle < 0.0f) {
    angle += kTwoPi;
  }
  return angle;
}

float ApplicationController::WrapPmPi(float angle) {
  while (angle > kPi) {
    angle -= kTwoPi;
  }
  while (angle < -kPi) {
    angle += kTwoPi;
  }
  return angle;
}

float ApplicationController::Clamp(float value, float low, float high) {
  return std::clamp(value, low, high);
}

float ApplicationController::SlewRateLimit(float current_value,
                                           float target_value,
                                           float max_delta) {
  const float delta = target_value - current_value;
  if (delta > max_delta) {
    return current_value + max_delta;
  }
  if (delta < -max_delta) {
    return current_value - max_delta;
  }
  return target_value;
}

void ApplicationController::ClearLegacyModeFlags() {
  control_enable = 0U;
  control_open_loop_enable = 0U;
  control_current_test_enable = 0U;
  control_align_enable = 0U;
  control_position_enable = 0U;
  control_ident_enable = 0U;
  control_calibrate_enable = 0U;
}

float ApplicationController::ComputeElectricalAngle(float encoder_angle_rad) const {
  const float mech_cal =
      control_encoder_direction != 0U
          ? Wrap0To2Pi(control_electrical_zero_rad + encoder_angle_rad)
          : Wrap0To2Pi(control_electrical_zero_rad - encoder_angle_rad);
  return Wrap0To2Pi(mech_cal * kMotorPolePairs);
}

void ApplicationController::CalibReset() {
  calib_state_ = CalibState::kIdle;
  calib_timer_ms_ = 0U;
  calib_sample_count_ = 0U;
  calib_pair_index_ = 0U;
  calib_begin_angle_ = 0.0f;
  calib_end_angle_ = 0.0f;
  calib_zero_sum_ = 0.0f;
  calib_angle_cmd_ = 0.0f;
  calib_voltage_cmd_ = 0.0f;
}

void ApplicationController::CalibStart() {
  CalibReset();
  calib_state_ = CalibState::kDirHold;
  calib_voltage_cmd_ = kCalibDirVoltageV;
  calib_angle_cmd_ = 0.0f;
}

/*
 * QDrive calibrate() ported to 1 kHz cooperative steps:
 *  1) hold d-axis, sample begin angle
 *  2) sweep electrical +2pi, sample end angle -> encoder_direction
 *  3) for each pole pair: sweep + hold d-axis, accumulate zero offset
 *  4) zero_electric = mean(offset)
 */
void ApplicationController::CalibStep(float encoder_angle_rad) {
  if (calib_state_ == CalibState::kIdle) {
    return;
  }

  if (calib_timer_ms_ < 60000U) {
    calib_timer_ms_++;
  }

  switch (calib_state_) {
    case CalibState::kDirHold:
      calib_voltage_cmd_ = kCalibDirVoltageV;
      calib_angle_cmd_ = 0.0f;
      if (calib_timer_ms_ >= kCalibDirHoldMs) {
        calib_begin_angle_ = encoder_angle_rad;
        calib_sample_count_ = 1U;
        calib_timer_ms_ = 0U;
        calib_state_ = CalibState::kDirSweep;
      }
      break;

    case CalibState::kDirSweep: {
      float t_frac = static_cast<float>(calib_timer_ms_) /
                     static_cast<float>(kCalibDirSweepMs);
      t_frac = std::min(t_frac, 1.0f);
      calib_voltage_cmd_ = kCalibDirVoltageV;
      calib_angle_cmd_ = kTwoPi * t_frac;
      if (calib_timer_ms_ >= kCalibDirSweepMs) {
        calib_end_angle_ = 0.0f;
        calib_sample_count_ = 0U;
        calib_timer_ms_ = 0U;
        calib_state_ = CalibState::kDirSampleEnd;
      }
      break;
    }

    case CalibState::kDirSampleEnd:
      calib_voltage_cmd_ = 0.0f;
      calib_angle_cmd_ = 0.0f;
      calib_end_angle_ += encoder_angle_rad;
      calib_sample_count_++;
      if (calib_sample_count_ >= kCalibSampleMs) {
        const float end_avg =
            calib_end_angle_ / static_cast<float>(calib_sample_count_);
        const float begin = calib_begin_angle_;
        uint8_t dir_ok = 0U;

        /* Same rule as QDrive FOC::calibrate() step 3. */
        if ((end_avg > begin) && (end_avg < (begin + kPi))) {
          dir_ok = 1U;
        }
        if (end_avg < (begin - kPi)) {
          dir_ok = 1U;
        }
        control_encoder_direction = dir_ok;

        calib_zero_sum_ = 0.0f;
        calib_pair_index_ = 0U;
        calib_timer_ms_ = 0U;
        calib_state_ = CalibState::kZeroSweep;
      }
      break;

    case CalibState::kZeroSweep: {
      float t_frac = static_cast<float>(calib_timer_ms_) /
                     static_cast<float>(kCalibZeroSweepMs);
      t_frac = std::min(t_frac, 1.0f);
      calib_voltage_cmd_ = kCalibDirVoltageV;
      calib_angle_cmd_ = kTwoPi * t_frac;
      if (calib_timer_ms_ >= kCalibZeroSweepMs) {
        calib_timer_ms_ = 0U;
        calib_sample_count_ = 0U;
        calib_state_ = CalibState::kZeroHold;
      }
      break;
    }

    case CalibState::kZeroHold:
      calib_voltage_cmd_ = kCalibAlignVoltageV;
      calib_angle_cmd_ = 0.0f;
      if (calib_timer_ms_ >= kCalibZeroHoldMs) {
        calib_timer_ms_ = 0U;
        calib_sample_count_ = 0U;
        calib_state_ = CalibState::kZeroSample;
      }
      break;

    case CalibState::kZeroSample:
      calib_voltage_cmd_ = kCalibAlignVoltageV;
      calib_angle_cmd_ = 0.0f;
      if (control_encoder_direction != 0U) {
        calib_zero_sum_ += kTwoPi - encoder_angle_rad;
      } else {
        calib_zero_sum_ += encoder_angle_rad;
      }
      calib_sample_count_++;
      if (calib_sample_count_ >= kCalibSampleMs) {
        calib_pair_index_++;
        if (calib_pair_index_ >= kMotorPolePairsU8) {
          const float mean_offset =
              calib_zero_sum_ /
              (kMotorPolePairs * static_cast<float>(kCalibSampleMs));
          control_electrical_zero_rad =
              mean_offset - (kPi * (kMotorPolePairs - 1.0f) / kMotorPolePairs);
          control_electrical_zero_rad = Wrap0To2Pi(control_electrical_zero_rad);
          calib_voltage_cmd_ = 0.0f;
          calib_state_ = CalibState::kDone;
        } else {
          calib_timer_ms_ = 0U;
          calib_state_ = CalibState::kZeroSweep;
        }
      }
      break;

    case CalibState::kDone:
    case CalibState::kFail:
    default:
      calib_voltage_cmd_ = 0.0f;
      break;
  }
}

void ApplicationController::ArmPowerStage() {
  foc_.Enable(1U);
  HAL_GPIO_WritePin(DRV_ENABLE_GPIO_Port, DRV_ENABLE_Pin, GPIO_PIN_SET);
  power_stage_armed_ = 1U;
}

void ApplicationController::DisarmPowerStage() {
  foc_.Enable(0U);
  foc_.SetOpenLoopVoltage(0U, 0.0f, 0.0f);
  foc_.SetRefs(0.0f, 0.0f);
  HAL_GPIO_WritePin(DRV_ENABLE_GPIO_Port, DRV_ENABLE_Pin, GPIO_PIN_RESET);
  power_stage_armed_ = 0U;
  /* Do NOT clear bus_ok_ms here: IDLE-while-waiting-for-bus must keep counting. */
}

void ApplicationController::ClearFaults() {
  fault_manager_.clearFaults();
  DisarmPowerStage();
  ClearLegacyModeFlags();
  control_mode_cmd = kModeIdle;
  control_enable = 0U;
  control_velocity_ref_rad_s = 0.0f;
  control_current_test_iq_ref_a = 0.0f;
  ResetOuterLoopRamps();
  bus_ok_ms_ = 0U;
  drv_fault_ok_ms_ = 0U;
  drv_fault_low_ms_ = 0U;
}

/*
 * Gate FOC/DRV: bus must stay above BUS_MIN_ENABLE_V for BUS_OK_SETTLE_MS.
 * Prevents boot-time arming on stale/zero ADC or 5 V debug supply.
 */
uint8_t ApplicationController::UpdatePowerStageArm(float bus_v) {
  const auto &health = current_sense_.health();
  const bool bus_ok = (bus_v >= kBusMinEnableV) && (bus_v <= 40.0f);
  const bool drv_ok =
      HAL_GPIO_ReadPin(DRV_nFAULT_GPIO_Port, DRV_nFAULT_Pin) != GPIO_PIN_RESET;
  const bool encoder_ok = encoder_valid_ != 0U;
  const bool sense_ok =
      health.calibrated && health.zero_a_valid && health.zero_b_valid &&
      health.dma_running && health.latest_sample_valid;
  const bool no_latched_fault = !fault_manager_.hasLatchedFault();
  arm_bus_ok_ = bus_ok ? 1U : 0U;
  arm_drv_ok_ = drv_ok ? 1U : 0U;
  arm_encoder_ok_ = encoder_ok ? 1U : 0U;
  arm_sense_ok_ = sense_ok ? 1U : 0U;
  arm_no_fault_ = no_latched_fault ? 1U : 0U;

  if (bus_ok) {
    if (bus_ok_ms_ < kBusOkSettleMs) {
      bus_ok_ms_++;
    }
  } else {
    bus_ok_ms_ = 0U;
    power_stage_armed_ = 0U;
  }

  if ((bus_ok_ms_ >= kBusOkSettleMs) && drv_ok && encoder_ok && sense_ok &&
      no_latched_fault) {
    power_stage_armed_ = 1U;
  }
  return power_stage_armed_;
}

void ApplicationController::ResetOuterLoopRamps() {
  speed_controller_.reset();
  position_controller_.reset();
  trajectory_.reset(position_unwrapped_rad_);
  speed_ref_applied_rad_s_ = 0.0f;
  active_velocity_ref_rad_s_ = 0.0f;
  active_position_ref_rad_ = position_unwrapped_rad_;
  active_accel_ref_rad_s2_ = 0.0f;
  current_test_iq_ref_a_ = 0.0f;
}

void ApplicationController::SetMode(uint8_t mode) {
  ClearLegacyModeFlags();

  switch (mode) {
    case kModeCurrent:
      control_mode_cmd = kModeCurrent;
      control_current_test_enable = 1U;
      control_enable = 1U;
      break;

    case kModeSpeed:
      control_mode_cmd = kModeSpeed;
      control_enable = 1U;
      break;

    case kModePosition:
      control_mode_cmd = kModePosition;
      control_position_enable = 1U;
      control_enable = 1U;
      break;

    case kModeMit:
      control_mode_cmd = kModeMit;
      control_enable = 1U;
      break;

    case kModeCalibrate:
      control_mode_cmd = kModeCalibrate;
      control_calibrate_enable = 1U;
      control_enable = 1U;
      break;

    case kModeIdle:
    default:
      control_mode_cmd = kModeIdle;
      control_current_test_iq_ref_a = 0.0f;
      control_velocity_ref_rad_s = 0.0f;
      control_mit_iq_ff_a = 0.0f;
      break;
  }
}

uint8_t ApplicationController::ResolveControlMode() const {
  if ((control_calibrate_enable != 0U) && !fault_manager_.hasLatchedFault()) {
    return kModeCalibrate;
  }
  if ((control_ident_enable != 0U) && !fault_manager_.hasLatchedFault()) {
    return kModeIdent;
  }
  if ((control_align_enable != 0U) && !fault_manager_.hasLatchedFault()) {
    return kModeAlign;
  }
  if ((control_open_loop_enable != 0U) && !fault_manager_.hasLatchedFault()) {
    return kModeOpenLoop;
  }

  if ((control_mode_cmd == kModeCurrent) && !fault_manager_.hasLatchedFault()) {
    return kModeCurrent;
  }
  if ((control_mode_cmd == kModeSpeed) && !fault_manager_.hasLatchedFault()) {
    return kModeSpeed;
  }
  if ((control_mode_cmd == kModePosition) && !fault_manager_.hasLatchedFault()) {
    return kModePosition;
  }
  if ((control_mode_cmd == kModeMit) && !fault_manager_.hasLatchedFault()) {
    return kModeMit;
  }
  if ((control_mode_cmd == kModeCalibrate) && !fault_manager_.hasLatchedFault()) {
    return kModeCalibrate;
  }

  if ((control_current_test_enable != 0U) && !fault_manager_.hasLatchedFault()) {
    return kModeCurrent;
  }
  if ((control_enable != 0U) && (control_position_enable != 0U) &&
      !fault_manager_.hasLatchedFault()) {
    return kModePosition;
  }
  if ((control_enable != 0U) && !fault_manager_.hasLatchedFault() &&
      (control_mode_cmd == kModeIdle) && (control_position_enable == 0U) &&
      (control_current_test_enable == 0U)) {
    /* Old scripts: control_enable alone meant speed mode. */
    return kModeSpeed;
  }
  return kModeIdle;
}

void ApplicationController::OnModeEnter(uint8_t new_mode, uint8_t prev_mode) {
  (void)prev_mode;
  ResetOuterLoopRamps();

  if (new_mode == kModeOpenLoop) {
    open_loop_electrical_angle_rad_ = last_good_electrical_angle_;
    open_loop_velocity_rad_s_ = 0.0f;
  }

  if (new_mode == kModeCalibrate) {
    CalibStart();
  } else if ((prev_mode == kModeCalibrate) &&
             (calib_state_ != CalibState::kDone)) {
    CalibReset();
  }

  if ((new_mode == kModePosition) && (position_inited_ != 0U)) {
    if (position_ref_pending_ == 0U) {
      control_position_target_rad = position_unwrapped_rad_;
    }
    position_ref_pending_ = 0U;
  }
  if ((new_mode == kModeMit) && (position_inited_ != 0U)) {
    if (mit_cmd_pending_ == 0U) {
      control_mit_pos_rad = position_unwrapped_rad_;
      control_mit_vel_rad_s = 0.0f;
      control_mit_iq_ff_a = 0.0f;
    }
    mit_cmd_pending_ = 0U;
  }

  if (new_mode != kModeIdent) {
    if (ident_started_ != 0U) {
      identifier_.Abort();
      ident_started_ = 0U;
    }
  }
}

void ApplicationController::OnCurrentSample(void *context) {
  auto *self = static_cast<ApplicationController *>(context);
  if (self != nullptr) {
    self->foc_.OnPwmUpdate();
  }
}

void ApplicationController::Init(ADC_HandleTypeDef *hadc,
                                 SPI_HandleTypeDef *hspi_encoder,
                                 TIM_HandleTypeDef *htim_pwm,
                                 UART_HandleTypeDef *huart_debug) {
  debug_uart_ = huart_debug;
  pwm_timer_ = htim_pwm;

  current_sense_.init(*hadc, hdma_adc1);
  (void)current_sense_.configureScan();
  encoder_hw_.init(*hspi_encoder, *GPIOA, GPIO_PIN_15);
  CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
  DWT->CYCCNT = 0U;
  DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
  rotor_estimator_.reset(0.0f);
  speed_controller_.init(control_speed_pi_kp,
                         control_speed_pi_ki,
                         control_iq_limit_a);
  speed_controller_.setDerivativeGain(control_speed_pi_kd);
  applied_speed_pi_kd_ = control_speed_pi_kd;
  position_controller_.init(control_position_kp,
                            control_position_ki,
                            control_position_kd,
                            control_position_velocity_limit_rad_s,
                            control_position_i_sep_rad);
  trajectory_.init(control_position_velocity_limit_rad_s,
                   (control_accel_ref_rad_s2 > 0.1f)
                       ? control_accel_ref_rad_s2
                       : 5.0f);
  applied_trajectory_accel_ =
      (control_accel_ref_rad_s2 > 0.1f) ? control_accel_ref_rad_s2 : 5.0f;
  applied_position_kp_ = control_position_kp;
  applied_position_ki_ = control_position_ki;
  applied_position_kd_ = control_position_kd;
  applied_position_vel_limit_ = control_position_velocity_limit_rad_s;
  applied_position_isep_ = control_position_i_sep_rad;
  applied_speed_pi_kp_ = control_speed_pi_kp;
  applied_speed_pi_ki_ = control_speed_pi_ki;
  identifier_.Init();
  foc_.Init(htim_pwm);
  foc_.setCurrentSense(current_sense_);
  foc_.SetCurrentLimit(control_iq_limit_a);
  applied_iq_limit_a_ = control_iq_limit_a;
  foc_.SetCurrentPi(applied_current_pi_kp_,
                    applied_current_pi_ki_,
                    applied_current_pi_out_limit_v_);
  foc_.SetCurrentKaw(applied_current_pi_kaw_);
  foc_.SetMaxModulation(applied_max_modulation_);
  foc_.SetDecouplingEnable(applied_decoupling_enable_);

  control::MotorParams params;
  control::motor_params::setDefaults(params);
  params.pole_pairs = kMotorPolePairs;
  foc_.SetMotorParams(params);

  HAL_GPIO_WritePin(DRV_ENABLE_GPIO_Port, DRV_ENABLE_Pin, GPIO_PIN_RESET);
  if (current_sense_.calibrate(128U) != HAL_OK) {
    fault_manager_.setFault(safety::Fault::CurrentSense);
  }

  (void)HAL_TIM_PWM_Start(htim_pwm, TIM_CHANNEL_1);
  (void)HAL_TIM_PWM_Start(htim_pwm, TIM_CHANNEL_2);
  (void)HAL_TIM_PWM_Start(htim_pwm, TIM_CHANNEL_3);
  (void)HAL_TIM_PWM_Start(htim_pwm, TIM_CHANNEL_4);
  current_sense_.setSampleCallback(OnCurrentSample, this);
  if (current_sense_.startHw() != HAL_OK) {
    fault_manager_.setFault(safety::Fault::CurrentSense);
  }

  control_mode_cmd = kModeIdle;
  ClearLegacyModeFlags();
  control_enable = 0U;
  control_open_loop_enable = 0U;
  control_velocity_ref_rad_s = 0.0f;
  control_current_test_iq_ref_a = 0.0f;
  control_encoder_direction = kDefaultEncoderDirection;
  control_electrical_zero_rad = kDefaultElectricalZeroRad;
  CalibReset();
  ResetOuterLoopRamps();
  bus_ok_ms_ = 0U;
  power_stage_armed_ = 0U;
  DisarmPowerStage();
  last_control_mode_ = kModeIdle; /* force on_mode_enter on first tick */
  last_control_tick_ = HAL_GetTick();
}

void ApplicationController::SetCurrentRef(float iq_ref_a) {
  control_current_test_iq_ref_a =
      Clamp(iq_ref_a, -kIqSoftLimitA, kIqSoftLimitA);
}

void ApplicationController::SetSpeedRef(float velocity_ref_rad_s) {
  control_velocity_ref_rad_s = velocity_ref_rad_s;
}

void ApplicationController::SetPositionRef(float position_target_rad) {
  const float delta = position_target_rad - control_position_target_rad;
  control_position_target_rad = position_target_rad;
  trajectory_.setTarget(position_target_rad);
  position_ref_pending_ = 1U;
  if ((control_mode_cmd == kModePosition) &&
      ((delta > 0.05f) || (delta < -0.05f))) {
    position_controller_.reset();
    speed_controller_.reset();
  }
}

void ApplicationController::SetMitCommand(float pos_rad,
                                          float vel_rad_s,
                                          float kp,
                                          float kd,
                                          float iq_ff_a) {
  control_mit_pos_rad = pos_rad;
  control_mit_vel_rad_s = vel_rad_s;
  control_mit_kp = kp < 0.0f ? 0.0f : kp;
  control_mit_kd = kd < 0.0f ? 0.0f : kd;
  control_mit_iq_ff_a =
      Clamp(iq_ff_a, -kIqSoftLimitA, kIqSoftLimitA);
  mit_cmd_pending_ = 1U;
}

void ApplicationController::Disable() {
  SetMode(kModeIdle);
}

uint32_t ApplicationController::GetLatchedFaults() const {
  return fault_manager_.latchedFaults();
}

void ApplicationController::ApplyIdentResultIfReady() {
  if (!identifier_.IsDone()) {
    return;
  }

  foc_.SetMotorParams(identifier_.GetResult());
  float kp = 0.0f;
  float ki = 0.0f;
  (void)control::motor_params::getCurrentPi(identifier_.GetResult(),
                                            kCurrentLoopOmegaC,
                                            kp,
                                            ki);
  control_current_pi_kp = kp;
  control_current_pi_ki = ki;
  foc_.SetCurrentPi(kp, ki, control_current_pi_out_limit_v);
  applied_current_pi_kp_ = kp;
  applied_current_pi_ki_ = ki;
  applied_current_pi_out_limit_v_ = control_current_pi_out_limit_v;
  control_decoupling_enable = 1U;
  foc_.SetDecouplingEnable(1U);
  applied_decoupling_enable_ = 1U;
  control_ident_enable = 0U;
  ident_started_ = 0U;
  control_mode_cmd = kModeIdle;
}

void ApplicationController::SendVofaDebug() {
  if (debug_uart_ == nullptr) {
    return;
  }

  const uint32_t now = HAL_GetTick();
  if ((now - last_vofa_tick_) < kVofaDebugPeriodMs) {
    return;
  }
  last_vofa_tick_ = now;

  const auto &foc = foc_.GetState();
  std::array<float, kVofaFrameValueCount> frame_values = {};
  frame_values[0] = control_current_test_iq_ref_a;
  frame_values[1] = telemetry_.iq_ref_a;
  frame_values[2] = foc.iq_a;
  frame_values[3] = foc.id_a;
  frame_values[4] = foc.vq_v;
  frame_values[5] = telemetry_.velocity_rad_s * kRadSToRpm;

  std::array<uint8_t, (sizeof(float) * kVofaFrameValueCount) + 4U> frame = {};
  std::memcpy(frame.data(),
              frame_values.data(),
              frame_values.size() * sizeof(float));
  constexpr size_t kFrameTailOffset = sizeof(float) * kVofaFrameValueCount;
  frame[kFrameTailOffset + 0U] = kVofaJustfloatTail0;
  frame[kFrameTailOffset + 1U] = kVofaJustfloatTail1;
  frame[kFrameTailOffset + 2U] = kVofaJustfloatTail2;
  frame[kFrameTailOffset + 3U] = kVofaJustfloatTail3;
  if (debug_uart_ != nullptr) {
    const uint16_t next_head =
        static_cast<uint16_t>((g_vofa_head + 1U) % kVofaRingFrames);
    if (next_head != g_vofa_tail) {
      std::memcpy(&g_vofa_ring[g_vofa_head * kVofaFrameBytes],
                  frame.data(),
                  kVofaFrameBytes);
      g_vofa_head = next_head;
    }
    VofaPump(debug_uart_);
  }
}

void ApplicationController::UpdateUnwrappedPosition() {
  if (encoder_valid_ == 0U) {
    return;
  }

  if (position_inited_ == 0U) {
    position_unwrapped_rad_ = encoder_.angle_rad;
    last_encoder_angle_rad_ = encoder_.angle_rad;
    position_inited_ = 1U;
    return;
  }

  const float delta =
      WrapPmPi(encoder_.angle_rad - last_encoder_angle_rad_);
  position_unwrapped_rad_ += delta;
  last_encoder_angle_rad_ = encoder_.angle_rad;
}

void ApplicationController::Update() {
  const auto &foc_snap = foc_.GetState();
  if (foc_snap.isr_overrun_count > last_foc_overrun_count_) {
    last_foc_overrun_count_ = foc_snap.isr_overrun_count;
    if (foc_snap.isr_count == last_foc_isr_count_) {
      foc_.ResetIsrBusy();
    }
  }

  const uint32_t foc_isr_count = foc_snap.isr_count;
  if ((foc_isr_count - last_foc_isr_count_) >= kOuterLoopIsrTicks) {
    last_foc_isr_count_ = foc_isr_count;
    outer_loop_due_ = 1U;
  }
  const uint32_t now = HAL_GetTick();
  if ((now - last_control_tick_) >= kControlPeriodMs) {
    last_control_tick_ += kControlPeriodMs;
    outer_loop_due_ = 1U;
  }
  if (outer_loop_due_ == 0U) {
    return;
  }
  outer_loop_due_ = 0U;

  const uint32_t cyccnt = DWT->CYCCNT;
  if (last_outer_loop_cyccnt_ != 0U) {
    const uint32_t dt_cycles = cyccnt - last_outer_loop_cyccnt_;
    outer_loop_dt_us_ = dt_cycles / (kCpuClockHz / 1000000U);
    if (outer_loop_dt_us_ > outer_loop_dt_max_us_) {
      outer_loop_dt_max_us_ = outer_loop_dt_us_;
    }
    if (outer_loop_dt_us_ > 1250U) {
      outer_loop_miss_count_++;
    }
  }
  last_outer_loop_cyccnt_ = cyccnt;
  outer_loop_count_++;

  fault_manager_.clearActiveFaults();

  if (encoder_hw_.read(encoder_) != HAL_OK) {
    encoder_valid_ = 0U;
    if (encoder_hw_.health().consecutive_error_count >= kEncoderFaultThreshold) {
      fault_manager_.setFault(safety::Fault::EncoderComm);
    }
  } else {
    encoder_valid_ = 1U;
    const auto &rotor = rotor_estimator_.update(encoder_.angle_rad, kControlDtS);
    position_unwrapped_rad_ = rotor.position_rad;
  }

  {
    current_ = foc_.GetLastCurrent();
    const auto &foc_snap = foc_.GetState();
    const auto &health = current_sense_.health();
    if (health.invalid_sample_count > last_invalid_sample_count_) {
      fault_manager_.setFault(safety::Fault::CurrentSense);
    }
    if (foc_snap.overcurrent_trip_count > last_overcurrent_trip_count_) {
      fault_manager_.setFault(safety::Fault::OverCurrent);
    }
    last_invalid_sample_count_ = health.invalid_sample_count;
    last_overcurrent_trip_count_ = foc_snap.overcurrent_trip_count;
  }

  if (HAL_GPIO_ReadPin(DRV_nFAULT_GPIO_Port, DRV_nFAULT_Pin) == GPIO_PIN_SET) {
    if (drv_fault_ok_ms_ < kDrvFaultSettleMs) {
      drv_fault_ok_ms_++;
    }
    drv_fault_low_ms_ = 0U;
  } else {
    if (drv_fault_low_ms_ < kDrvFaultLowDebounceMs) {
      drv_fault_low_ms_++;
    }
    if ((drv_fault_ok_ms_ >= kDrvFaultSettleMs) &&
        (drv_fault_low_ms_ >= kDrvFaultLowDebounceMs)) {
      fault_manager_.setFault(safety::Fault::Driver);
    }
  }
  const float arm_bus_v = foc_snap.bus_v;
  if (arm_bus_v < kBusMinEnableV) {
    fault_manager_.setFault(safety::Fault::BusUndervoltage);
  } else if (arm_bus_v > 40.0f) {
    fault_manager_.setFault(safety::Fault::BusOvervoltage);
  }
  telemetry_.fault_flags = fault_manager_.latchedFaults();

  (void)UpdatePowerStageArm(arm_bus_v);
  const bool arm_all_ok =
      (arm_bus_ok_ != 0U) && (arm_drv_ok_ != 0U) &&
      (arm_encoder_ok_ != 0U) && (arm_sense_ok_ != 0U) &&
      (arm_no_fault_ != 0U) && (bus_ok_ms_ >= kBusOkSettleMs);
  arm_all_ok_ = arm_all_ok ? 1U : 0U;
  if (arm_all_ok) {
    power_stage_armed_ = 1U;
  }

  uint8_t control_mode = ResolveControlMode();
  if ((control_align_enable != 0U) && arm_all_ok) {
    control_mode = kModeAlign;
    ArmPowerStage();
    foc_.SetAngleOverride(1U, control_align_angle_rad);
    foc_.SetOpenLoopVoltage(1U, control_align_voltage_v, 0.0f);
    foc_.SetRefs(0.0f, 0.0f);
  }
  if ((control_mode != kModeIdle) && !arm_all_ok) {
    DisarmPowerStage();
    control_mode = kModeIdle;
  }

  float electrical_angle = 0.0f;
  if (encoder_valid_ != 0U) {
    electrical_angle = ComputeElectricalAngle(encoder_.angle_rad);
    last_good_electrical_angle_ = electrical_angle;
  } else {
    electrical_angle = last_good_electrical_angle_;
  }

  if (control_mode != last_control_mode_) {
    OnModeEnter(control_mode, last_control_mode_);
    last_control_mode_ = control_mode;
  }

  float iq_ref = 0.0f;
  const float mech_vel = rotor_estimator_.state().velocity_rad_s;
  if (control_mode == kModeSpeed) {
    speed_ref_applied_rad_s_ =
        SlewRateLimit(speed_ref_applied_rad_s_,
                      control_velocity_ref_rad_s,
                      kSpeedRefRampRadS2 * kControlDtS);
    active_velocity_ref_rad_s_ = speed_ref_applied_rad_s_;
    active_accel_ref_rad_s2_ = 0.0f;
    speed_controller_.setReference(active_velocity_ref_rad_s_);
    iq_ref = speed_controller_.update(mech_vel, kControlDtS);
  } else if (control_mode == kModePosition) {
    const auto &traj = trajectory_.update(position_unwrapped_rad_, kControlDtS);
    active_position_ref_rad_ = traj.position_rad;
    active_accel_ref_rad_s2_ = traj.acceleration_rad_s2;
    const float position_vel_cmd =
        position_controller_.update(traj.position_rad,
                                    position_unwrapped_rad_,
                                    mech_vel,
                                    kControlDtS);
    active_velocity_ref_rad_s_ =
        Clamp(position_vel_cmd + traj.velocity_rad_s,
              -control_position_velocity_limit_rad_s,
              control_position_velocity_limit_rad_s);
    speed_controller_.setReference(active_velocity_ref_rad_s_);
    iq_ref = speed_controller_.update(mech_vel, kControlDtS);
  } else if (control_mode == kModeMit) {
    const float position_error = control_mit_pos_rad - position_unwrapped_rad_;
    const float velocity_error = control_mit_vel_rad_s - mech_vel;
    iq_ref =
        kTorqueIqSign *
        ((control_mit_kp * position_error) +
         (control_mit_kd * velocity_error) +
         control_mit_iq_ff_a);
    iq_ref = Clamp(iq_ref, -kIqSoftLimitA, kIqSoftLimitA);
    active_velocity_ref_rad_s_ = control_mit_vel_rad_s;
    active_accel_ref_rad_s2_ = 0.0f;
  } else {
    active_velocity_ref_rad_s_ = 0.0f;
    active_accel_ref_rad_s2_ = 0.0f;
  }

  float omega_e = rotor_estimator_.state().velocity_rad_s * kMotorPolePairs;
  if (control_encoder_direction == 0U) {
    omega_e = -omega_e;
  }
  foc_.SetOmegaE(omega_e);
  foc_.SetElectricalAngle(electrical_angle);

  if ((control_current_pi_kp != applied_current_pi_kp_) ||
      (control_current_pi_ki != applied_current_pi_ki_) ||
      (control_current_pi_out_limit_v != applied_current_pi_out_limit_v_)) {
    applied_current_pi_kp_ = control_current_pi_kp;
    applied_current_pi_ki_ = control_current_pi_ki;
    applied_current_pi_out_limit_v_ = control_current_pi_out_limit_v;
    foc_.SetCurrentPi(applied_current_pi_kp_,
                      applied_current_pi_ki_,
                      applied_current_pi_out_limit_v_);
  }

  if (control_current_pi_kaw != applied_current_pi_kaw_) {
    applied_current_pi_kaw_ = control_current_pi_kaw;
    foc_.SetCurrentKaw(applied_current_pi_kaw_);
  }

  if (control_iq_limit_a != applied_iq_limit_a_) {
    applied_iq_limit_a_ = control_iq_limit_a;
    foc_.SetCurrentLimit(applied_iq_limit_a_);
    speed_controller_.init(applied_speed_pi_kp_,
                           applied_speed_pi_ki_,
                           applied_iq_limit_a_);
  }

  if ((control_speed_pi_kp != applied_speed_pi_kp_) ||
      (control_speed_pi_ki != applied_speed_pi_ki_)) {
    applied_speed_pi_kp_ = control_speed_pi_kp;
    applied_speed_pi_ki_ = control_speed_pi_ki;
    speed_controller_.setGains(applied_speed_pi_kp_, applied_speed_pi_ki_);
  }
  if (control_speed_pi_kd != applied_speed_pi_kd_) {
    applied_speed_pi_kd_ = control_speed_pi_kd;
    speed_controller_.setDerivativeGain(applied_speed_pi_kd_);
  }

  if ((control_position_kp != applied_position_kp_) ||
      (control_position_ki != applied_position_ki_) ||
      (control_position_kd != applied_position_kd_) ||
      (control_position_velocity_limit_rad_s != applied_position_vel_limit_) ||
      (control_position_i_sep_rad != applied_position_isep_)) {
    applied_position_kp_ = control_position_kp;
    applied_position_ki_ = control_position_ki;
    applied_position_kd_ = control_position_kd;
    applied_position_vel_limit_ = control_position_velocity_limit_rad_s;
    applied_position_isep_ = control_position_i_sep_rad;
    position_controller_.setGains(applied_position_kp_,
                                  applied_position_ki_,
                                  applied_position_kd_,
                                  applied_position_isep_);
    position_controller_.setVelocityLimit(applied_position_vel_limit_);
  }

  const float trajectory_accel =
      (control_accel_ref_rad_s2 > 0.1f) ? control_accel_ref_rad_s2 : 5.0f;
  if (trajectory_accel != applied_trajectory_accel_) {
    applied_trajectory_accel_ = trajectory_accel;
    trajectory_.setLimits(control_position_velocity_limit_rad_s,
                          trajectory_accel);
  }

  if (control_max_modulation != applied_max_modulation_) {
    applied_max_modulation_ = control_max_modulation;
    foc_.SetMaxModulation(applied_max_modulation_);
  }

  if (control_decoupling_enable != applied_decoupling_enable_) {
    applied_decoupling_enable_ = control_decoupling_enable;
    foc_.SetDecouplingEnable(applied_decoupling_enable_);
  }

  if (control_mode == kModeAlign) {
    ArmPowerStage();
    foc_.SetAngleOverride(1U, control_align_angle_rad);
    foc_.SetOpenLoopVoltage(1U, control_align_voltage_v, 0.0f);
    foc_.SetRefs(0.0f, 0.0f);
  } else if (control_mode == kModeCalibrate) {
    ArmPowerStage();
    if (encoder_valid_ != 0U) {
      CalibStep(encoder_.angle_rad);
    } else {
      calib_state_ = CalibState::kFail;
      calib_voltage_cmd_ = 0.0f;
    }

    if ((calib_state_ == CalibState::kDone) ||
        (calib_state_ == CalibState::kFail)) {
      foc_.SetOpenLoopVoltage(0U, 0.0f, 0.0f);
      foc_.SetRefs(0.0f, 0.0f);
      foc_.SetAngleOverride(0U, electrical_angle);
      DisarmPowerStage();
      control_calibrate_enable = 0U;
      control_enable = 0U;
      control_mode_cmd = kModeIdle;
      if (calib_state_ == CalibState::kDone) {
        calib_state_ = CalibState::kIdle;
      }
    } else {
      foc_.SetAngleOverride(1U, calib_angle_cmd_);
      foc_.SetOpenLoopVoltage(1U, calib_voltage_cmd_, 0.0f);
      foc_.SetRefs(0.0f, 0.0f);
    }
  } else if (control_mode == kModeIdent) {
    ArmPowerStage();
    if (ident_started_ == 0U) {
      identifier_.Start();
      ident_started_ = 1U;
    }

    const auto &foc = foc_.GetState();
    identifier_.SlowTick(kControlDtS, foc, omega_e, current_.bus_v);
    const auto &ident = identifier_.GetStatus();

    if (ident.use_angle_override != 0U) {
      foc_.SetAngleOverride(1U, ident.angle_override_rad);
    } else {
      foc_.SetAngleOverride(0U, electrical_angle);
    }

    if (ident.use_open_loop_voltage != 0U) {
      foc_.SetOpenLoopVoltage(1U, ident.open_loop_vd_v, ident.open_loop_vq_v);
      foc_.SetRefs(0.0f, 0.0f);
    } else {
      foc_.SetOpenLoopVoltage(0U, 0.0f, 0.0f);
      foc_.SetRefs(ident.id_ref_a, ident.iq_ref_a);
    }

    if (identifier_.IsDone()) {
      ApplyIdentResultIfReady();
    } else if (identifier_.IsFailed()) {
      DisarmPowerStage();
      control_ident_enable = 0U;
      ident_started_ = 0U;
      control_mode_cmd = kModeIdle;
    }
  } else if (control_mode == kModeCurrent) {
    ArmPowerStage();
    foc_.SetAngleOverride(0U, electrical_angle);
    foc_.SetOpenLoopVoltage(0U, 0.0f, 0.0f);
    current_test_iq_ref_a_ =
        SlewRateLimit(current_test_iq_ref_a_,
                      control_current_test_iq_ref_a,
                      kCurrentTestRampAS * kControlDtS);
    iq_ref = current_test_iq_ref_a_;
    foc_.SetRefs(0.0f, iq_ref);
  } else if (control_mode == kModeOpenLoop) {
    ArmPowerStage();
    open_loop_velocity_rad_s_ =
        SlewRateLimit(open_loop_velocity_rad_s_,
                      control_velocity_ref_rad_s,
                      kOpenLoopRampRadS2 * kControlDtS);
    open_loop_electrical_angle_rad_ =
        Wrap0To2Pi(open_loop_electrical_angle_rad_ +
                   (open_loop_velocity_rad_s_ * kMotorPolePairs * kControlDtS));

    float bus_v = current_.bus_v;
    if (bus_v < kBusMinEnableV) {
      bus_v = kBusMinEnableV;
    }

    const float speed_abs = std::fabs(open_loop_velocity_rad_s_);
    float speed_ref_abs = std::fabs(control_velocity_ref_rad_s);
    if (speed_ref_abs < 0.1f) {
      speed_ref_abs = 0.1f;
    }
    float speed_frac = speed_abs / speed_ref_abs;
    speed_frac = std::min(speed_frac, 1.0f);

    float mod_max = control_open_loop_voltage_v;
    mod_max = std::max(mod_max, kOpenLoopModMin);
    mod_max = std::min(mod_max, 0.30f); /* hard safety cap: 30% of bus */
    const float mod =
        kOpenLoopModMin + ((mod_max - kOpenLoopModMin) * speed_frac);
    float vq_cmd = bus_v * mod;
    if (open_loop_velocity_rad_s_ < 0.0f) {
      vq_cmd = -vq_cmd;
    }

    foc_.SetAngleOverride(1U, open_loop_electrical_angle_rad_);
    foc_.SetOpenLoopVoltage(1U, 0.0f, vq_cmd);
    foc_.SetRefs(0.0f, 0.0f);
  } else if ((control_mode == kModeSpeed) ||
             (control_mode == kModePosition) ||
             (control_mode == kModeMit)) {
    ArmPowerStage();
    foc_.SetAngleOverride(0U, electrical_angle);
    foc_.SetOpenLoopVoltage(0U, 0.0f, 0.0f);
    foc_.SetRefs(0.0f, iq_ref);
  } else {
    DisarmPowerStage();
    foc_.SetAngleOverride(0U, electrical_angle);
  }

  const auto &foc = foc_.GetState();
  const auto &ident = identifier_.GetStatus();

  telemetry_.angle_deg = encoder_.angle_deg;
  telemetry_.velocity_rad_s = rotor_estimator_.state().velocity_rad_s;
  telemetry_.accel_rad_s2 = rotor_estimator_.state().acceleration_rad_s2;
  telemetry_.accel_ref_rad_s2 = active_accel_ref_rad_s2_;
  telemetry_.ia_a = current_.ia_a;
  telemetry_.ib_a = current_.ib_a;
  telemetry_.iq_ref_a = foc.iq_ref_a;
  telemetry_.iq_a = foc.iq_a;
  telemetry_.id_a = foc.id_a;
  telemetry_.vd_v = foc.vd_v;
  telemetry_.vq_v = foc.vq_v;
  telemetry_.vd_unsat_v = foc.vd_unsat_v;
  telemetry_.vq_unsat_v = foc.vq_unsat_v;
  telemetry_.vd_sat_v = foc.vd_sat_v;
  telemetry_.vq_sat_v = foc.vq_sat_v;
  telemetry_.bus_v = foc.bus_v;
  telemetry_.rs_est = ident.result.rs_ohm;
  telemetry_.l_est = ident.result.ld_h;
  telemetry_.flux_est = ident.result.flux_wb;
  telemetry_.position_rad = position_unwrapped_rad_;
  if (control_mode == kModeMit) {
    telemetry_.position_ref_rad = control_mit_pos_rad;
  } else {
    telemetry_.position_ref_rad = active_position_ref_rad_;
  }
  telemetry_.loop_count++;
  telemetry_.isr_count = foc.isr_count;
  telemetry_.latched_faults = fault_manager_.latchedFaults();
  telemetry_.encoder_error_count =
      encoder_hw_.health().consecutive_error_count;
  telemetry_.encoder_crc_error_count = encoder_hw_.health().crc_error_count;
  telemetry_.encoder_status = encoder_.status;
  telemetry_.encoder_crc_ok = encoder_.crc_ok ? 1U : 0U;
  telemetry_.encoder_status_ok = encoder_.status_ok ? 1U : 0U;
  telemetry_.voltage_saturated = foc.voltage_saturated;
  telemetry_.encoder_valid = encoder_valid_;
  telemetry_.power_stage_armed = power_stage_armed_;
  telemetry_.bus_ok_ms = bus_ok_ms_;
  telemetry_.drv_fault_ok_ms = drv_fault_ok_ms_;
  telemetry_.arm_bus_ok = arm_bus_ok_;
  telemetry_.arm_drv_ok = arm_drv_ok_;
  telemetry_.arm_encoder_ok = arm_encoder_ok_;
  telemetry_.arm_sense_ok = arm_sense_ok_;
  telemetry_.arm_no_fault = arm_no_fault_;
  telemetry_.arm_all_ok = arm_all_ok_;
  telemetry_.outer_loop_count = outer_loop_count_;
  telemetry_.outer_loop_miss_count = outer_loop_miss_count_;
  telemetry_.outer_loop_dt_us = outer_loop_dt_us_;
  telemetry_.outer_loop_dt_max_us = outer_loop_dt_max_us_;
  telemetry_.control_mode = control_mode;
  telemetry_.ident_state = static_cast<uint8_t>(ident.state);
  telemetry_.calib_state = static_cast<uint8_t>(calib_state_);
  telemetry_.encoder_direction = control_encoder_direction;
  telemetry_.electrical_zero_rad = control_electrical_zero_rad;

  SendVofaDebug();
  (void)pwm_timer_;
}

const ControlTelemetry_t &ApplicationController::GetTelemetry() const {
  return telemetry_;
}

ApplicationController g_application;

}  // namespace app

extern "C" void HAL_UART_TxCpltCallback(UART_HandleTypeDef *huart) {
  (void)huart;
  app::g_vofa_tx_busy = 0U;
}

extern "C" void HAL_UART_ErrorCallback(UART_HandleTypeDef *huart) {
  (void)huart;
  app::g_vofa_tx_busy = 0U;
}

extern "C" void ControlApp_Init(ADC_HandleTypeDef *hadc,
                                SPI_HandleTypeDef *hspi_encoder,
                                TIM_HandleTypeDef *htim_pwm,
                                UART_HandleTypeDef *huart_debug) {
  app::g_application.Init(hadc, hspi_encoder, htim_pwm, huart_debug);
}

extern "C" void ControlApp_Update(void) {
  app::g_application.Update();
}

extern "C" const ControlTelemetry_t *ControlApp_GetTelemetry(void) {
  return &app::g_application.GetTelemetry();
}

extern "C" void ControlApp_SetMode(uint8_t mode) {
  app::g_application.SetMode(mode);
}

extern "C" uint8_t ControlApp_GetMode(void) {
  return control_mode_cmd;
}

extern "C" void ControlApp_SetCurrentRef(float iq_ref_a) {
  app::g_application.SetCurrentRef(iq_ref_a);
}

extern "C" void ControlApp_SetSpeedRef(float velocity_ref_rad_s) {
  app::g_application.SetSpeedRef(velocity_ref_rad_s);
}

extern "C" void ControlApp_SetPositionRef(float position_target_rad) {
  app::g_application.SetPositionRef(position_target_rad);
}

extern "C" void ControlApp_SetMitCommand(float pos_rad,
                                         float vel_rad_s,
                                         float kp,
                                         float kd,
                                         float iq_ff_a) {
  app::g_application.SetMitCommand(pos_rad, vel_rad_s, kp, kd, iq_ff_a);
}

extern "C" void ControlApp_Disable(void) {
  app::g_application.Disable();
}

extern "C" void ControlApp_ClearFault(void) {
  app::g_application.ClearFaults();
}

extern "C" uint32_t ControlApp_GetLatchedFaults(void) {
  return app::g_application.GetLatchedFaults();
}
