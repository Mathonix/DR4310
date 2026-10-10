#include "control_app.h"
#include "calibration_store.h"
#include "ascii_util.h"
#include "device_config.h"

#include "ControlTiming.hpp"
#include "CurrentSense.hpp"
#include "MT6701.hpp"
#include "HardwareBridge.h"
#include "FOCController.hpp"
#include "OverloadLimiter.hpp"
#include "SpeedController.hpp"
#include "PositionController.hpp"
#include "TrajectoryGenerator.hpp"
#include "MotorIdentifier.hpp"
#include "MotorParams.hpp"
#include "RotorEstimator.hpp"
#include "FaultManager.hpp"
#include "ElectricalAngle.hpp"
#include "main.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <cstring>

namespace app {
/* 控制频率 单位ms*/
constexpr uint32_t kControlPeriodMs = 1U;
/* 控制周期 单位s */
constexpr float kControlDtS = 0.001f;
/* Live commutation pole count. Copied once from config before the 20 kHz ISR. */
uint8_t g_active_pole_pairs_u8 = DEVICE_DEFAULT_POLE_PAIRS;
float g_active_pole_pairs = static_cast<float>(DEVICE_DEFAULT_POLE_PAIRS);

constexpr float kTwoPi = 6.28318530718f;
constexpr float kPi = 3.14159265359f;

constexpr uint32_t kFaultEncoder = 0x00000001UL;
constexpr uint32_t kFaultCurrent = 0x00000002UL;
constexpr uint32_t kFaultDrv = 0x00000004UL;
constexpr uint32_t kFaultBusUndervolt = 0x00000008UL;
/* DRV8313 / FOC need a real bus. 5 V debug supply must NOT enable power stage.
 * Enable paths use max(this floor, VBUS_MIN). Kept equal to the shared macro. */
constexpr float kBusMinEnableV = 6.0f;
static_assert(kBusMinEnableV == DEVICE_VBUS_HARD_MIN_V,
              "undervoltage floor must match DEVICE_VBUS_HARD_MIN_V");
/* Require continuous good bus samples before arming FOC after boot/mode entry. */
constexpr uint16_t kBusOkSettleMs = 50U;
constexpr float kOpenLoopRampRadS2 = 1000.0f;
constexpr float kCurrentTestRampAS = 10000.0f;
constexpr float kSpeedRefRampRadS2 = 10000.0f;
constexpr float kCurrentLoopOmegaC = 1200.0f;
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
/* With encoder direction and electrical zero calibrated, positive Iq
 * produces positive canonical mechanical velocity on this board. */
constexpr float kTorqueIqSign = 1.0f;
/* 16 JustFloat channels at 100 Hz use about 6.8 kB/s, safely below the
 * 115200-baud UART payload limit while leaving room for RX commands. */
constexpr uint32_t kVofaDebugPeriodMs = 10U;
constexpr uint32_t kVofaDebugTimeoutMs = 20U;
constexpr uint8_t kVofaJustfloatTail0 = 0x00U;
constexpr uint8_t kVofaJustfloatTail1 = 0x00U;
constexpr uint8_t kVofaJustfloatTail2 = 0x80U;
constexpr uint8_t kVofaJustfloatTail3 = 0x7FU;
/* Board calibration measured twice on 2026-09-16: 0.12560 / 0.12596 rad. */
constexpr float kDefaultElectricalZeroRad = 0.12578f;
constexpr uint8_t kDefaultEncoderDirection = 1U;
constexpr uint32_t kEncoderValidWindowCycles = 340000U;
constexpr uint32_t kEncoderFaultTimeoutCycles = 1700000U;
constexpr uint32_t kEncoderMinValidSamplesForFault = 10U;
constexpr uint32_t kEncoderTriggerDivider = 2U;
constexpr uint16_t kDrvFaultSettleMs = 20U;
constexpr uint16_t kDrvFaultLowDebounceMs = 5U;
constexpr uint32_t kCpuClockHz = 170000000U;
constexpr size_t kVofaFrameValueCount = 16U;
constexpr size_t kVofaFrameBytes = (kVofaFrameValueCount * sizeof(float)) + 4U;
/* UART TX is one byte queue shared by JustFloat frames and '@' text replies.
 * Messages are enqueued whole (all-or-nothing), so a reply can never land in
 * the middle of a binary frame. Telemetry only uses the low part of the queue
 * so command replies always find room. */
constexpr size_t kUartTxQueueBytes = 1024U;
constexpr size_t kUartTxTelemetryHighWater = 3U * kVofaFrameBytes;
constexpr size_t kUartTxChunkBytes = 128U;
constexpr size_t kVofaRxRingBytes = 256U;
/* TCH carries 16 channel names. 191 payload characters plus the terminator. */
constexpr size_t kVofaCommandMaxBytes = 192U;
constexpr size_t kUartMaxTokens = 20U;
constexpr uint32_t kRebootDrainTimeoutMs = 300U;
constexpr float kUartSpeedLimitRpm = 500.0f;
constexpr float kUartPositionLimitRad = 500.0f;
constexpr float kMitPMax = 50.0f;
constexpr float kMitVMax = 50.0f;
constexpr float kMitKpMax = 500.0f;
constexpr float kMitKdMax = 5.0f;
constexpr float kVofaCurrentKpMax = 20.0f;
constexpr float kVofaCurrentKiMax = 2500.0f;
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

std::array<uint8_t, kUartTxQueueBytes> g_uart_txq = {};
std::array<uint8_t, kUartTxChunkBytes> g_uart_tx_chunk = {};
size_t g_uart_txq_head = 0U; /* write index (main loop only) */
size_t g_uart_txq_tail = 0U; /* read index (main loop only) */
volatile uint8_t g_vofa_tx_busy = 0U;
volatile uint32_t g_uart_tx_drop_count = 0U;
UART_HandleTypeDef *g_vofa_uart = nullptr;
uint8_t g_vofa_rx_byte = 0U;
std::array<uint8_t, kVofaRxRingBytes> g_vofa_rx_ring = {};
volatile uint16_t g_vofa_rx_head = 0U;
volatile uint16_t g_vofa_rx_tail = 0U;

void VofaRxPushFromIsr(uint8_t byte) {
  const uint16_t next_head =
      static_cast<uint16_t>((g_vofa_rx_head + 1U) % kVofaRxRingBytes);
  if (next_head != g_vofa_rx_tail) {
    g_vofa_rx_ring[g_vofa_rx_head] = byte;
    g_vofa_rx_head = next_head;
  }
}

bool VofaRxPop(uint8_t &byte) {
  if (g_vofa_rx_tail == g_vofa_rx_head) {
    return false;
  }
  byte = g_vofa_rx_ring[g_vofa_rx_tail];
  g_vofa_rx_tail =
      static_cast<uint16_t>((g_vofa_rx_tail + 1U) % kVofaRxRingBytes);
  return true;
}

void VofaStartReceive(UART_HandleTypeDef *uart) {
  if (uart != nullptr) {
    (void)HAL_UART_Receive_IT(uart, &g_vofa_rx_byte, 1U);
  }
}

size_t UartTxUsed() {
  return (g_uart_txq_head + kUartTxQueueBytes - g_uart_txq_tail) %
         kUartTxQueueBytes;
}

bool UartTxIdle() {
  return (g_vofa_tx_busy == 0U) && (UartTxUsed() == 0U);
}

/* All-or-nothing enqueue. limit = max queue fill allowed after the write. */
bool UartTxEnqueue(const uint8_t *data, size_t len, size_t limit) {
  if (limit > (kUartTxQueueBytes - 1U)) {
    limit = kUartTxQueueBytes - 1U;
  }
  if ((data == nullptr) || ((UartTxUsed() + len) > limit)) {
    g_uart_tx_drop_count++;
    return false;
  }
  for (size_t i = 0U; i < len; ++i) {
    g_uart_txq[g_uart_txq_head] = data[i];
    g_uart_txq_head = (g_uart_txq_head + 1U) % kUartTxQueueBytes;
  }
  return true;
}

void VofaPump(UART_HandleTypeDef *uart) {
  if ((uart == nullptr) || (g_vofa_tx_busy != 0U)) {
    return;
  }
  size_t n = 0U;
  while ((n < kUartTxChunkBytes) && (g_uart_txq_tail != g_uart_txq_head)) {
    g_uart_tx_chunk[n++] = g_uart_txq[g_uart_txq_tail];
    g_uart_txq_tail = (g_uart_txq_tail + 1U) % kUartTxQueueBytes;
  }
  if (n == 0U) {
    return;
  }
  g_vofa_tx_busy = 1U;
  if (HAL_UART_Transmit_IT(uart, g_uart_tx_chunk.data(),
                           static_cast<uint16_t>(n)) != HAL_OK) {
    g_vofa_tx_busy = 0U;
    g_uart_tx_drop_count++;
  }
}

}  // namespace app

/* Unified mode: boot IDLE so shaft is free until host arms a mode. */
volatile uint8_t control_mode_cmd = CTRL_MODE_IDLE;
volatile uint8_t control_auto_enable = 0U;

/* Legacy flags kept for debug/old scripts. */
volatile uint8_t control_enable = 0U;
volatile uint8_t control_open_loop_enable = 0U;
volatile uint8_t control_current_test_enable = 0U;
volatile uint8_t control_align_enable = 0U;
volatile uint8_t control_position_enable = 0U;
volatile uint8_t control_ident_enable = 0U;
volatile uint8_t control_calibrate_enable = 0U;
volatile uint8_t calibration_flash_status = 0U;
volatile uint8_t calibration_flash_valid = 0U;
volatile uint32_t calibration_flash_sequence = 0U;
volatile uint32_t calibration_flash_save_count = 0U;

volatile float control_velocity_ref_rad_s = 0.0f;
volatile float control_position_target_rad = 0.0f;
volatile float control_position_kp = 3.5f;
volatile float control_position_ki = 1.2f;
volatile float control_position_kd = 2.6f;
volatile float control_position_velocity_limit_rad_s = 100.0f;
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
volatile float control_iq_limit_a = IQ_CONTINUOUS_MAX_A;
/* Overload defaults: off, ceiling equal to the continuous limit, 2 s budget.
 * DeviceConfig_Init captures these into the v1/default image. */
volatile float control_ol_en = 0.0f;
volatile float control_ol_iq_a = IQ_CONTINUOUS_MAX_A;
volatile float control_ol_time_s = OL_TIME_DEFAULT_S;
/* 速度环默认 Kp/Ki；上电会使用这里，也可通过 RAM 实时修改。 */
volatile float control_speed_pi_kp = 0.25f;
volatile float control_speed_pi_ki = 0.02f;
volatile float control_speed_pi_kd = 0.0f;
volatile float control_accel_ref_rad_s2 = 0.0f;
volatile float control_electrical_zero_rad = app::kDefaultElectricalZeroRad;
volatile uint8_t control_encoder_direction = app::kDefaultEncoderDirection;
volatile float control_vbus_min_v = DEVICE_DEFAULT_VBUS_MIN_V;
volatile float control_vbus_max_v = DEVICE_DEFAULT_VBUS_MAX_V;
volatile float control_zero_offset_rad = 0.0f;
volatile float control_rs_ohm = DEVICE_DEFAULT_RS_OHM;
volatile float control_ls_h = DEVICE_DEFAULT_LS_H;
volatile float control_max_modulation = DEVICE_MAX_MOD_DEFAULT;
volatile uint8_t control_decoupling_enable = 0U;

/* MIT: tau = kp*(pos_des-pos) + kd*(vel_des-vel) + tau_ff -> mapped to iq. */
volatile float control_mit_pos_rad = 0.0f;
volatile float control_mit_vel_rad_s = 0.0f;
volatile float control_mit_kp = 10.0f;
volatile float control_mit_kd = 0.5f;
volatile float control_mit_iq_ff_a = 0.0f;
volatile uint32_t control_cycle_clock_recovery_count = 0U;
volatile uint8_t control_debug_cmd = 0U;
volatile float control_debug_speed_ref_rad_s = 0.0f;

namespace app {

class ApplicationController {
 public:
  void Init(ADC_HandleTypeDef *hadc,
            SPI_HandleTypeDef *hspi_encoder,
            TIM_HandleTypeDef *htim_pwm,
            UART_HandleTypeDef *huart_debug);
  void Update();
  void SetMode(uint8_t mode);
  bool PositionEncoderReady() const;
  void SetAutoEnable(uint8_t enable);
  uint8_t GetAutoEnable() const;
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
  void UpdateRotorInFocIsr(uint32_t now_cycles);
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
  void ProcessVofaCommands();
  void ExecuteVofaCommand(char *line);
  void SendVofaDebug();
  bool Reply(const TextBuf &text);
  void ReplyOk(const char *cmd, const char *detail = nullptr);
  void ReplyErr(const char *cmd, const char *reason);
  bool ReplyParam(size_t index);
  void ServiceGetStream();
  void ReplyInfo();
  void ReplyFault();
  void ReplyTlist();
  void ReplyTch();
  bool IsMotorIdle() const;
  void ApplyBootMode();
  void CheckHostTimeout(uint32_t now);
  void ServiceReboot(uint32_t now);
  void ResyncAfterFlashStall();

 public:
  void NotifyHostActivity();

 private:
  void UpdateUnwrappedPosition();
  float FeedbackPosition() const;
  void ServiceZeroAnchor();
  void ApplyBootCommutation();
  void ApplyMotorModelIfChanged();
  uint8_t ResolveControlMode() const;
  void OnModeEnter(uint8_t new_mode, uint8_t prev_mode);

  struct CmdRamp {
    float start;
    float applied;
    float last_cmd;
    uint16_t last_ms;
    uint16_t elapsed_ms;
  };
  void SyncCmdRampIdle(CmdRamp &ramp, float applied, float command);
  float StepCmdRamp(CmdRamp &ramp, float command, uint16_t dur_ms, float max_step);
  void NoteFault(safety::Fault fault);
  void BusWindow(float *min_v, float *max_v) const;
  float TelemValue(uint8_t index, const control::FOCState &foc) const;

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
  /* Independent 1 kHz window estimator for the outer speed loop. The ISR PLL
   * remains responsible for low-latency electrical angle prediction. */
  control::RotorEstimator speed_feedback_estimator_;
  uint32_t last_speed_sample_cycles_ = 0U;
  bool speed_sample_initialized_ = false;
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
  /* -1 forces the first 1 kHz tick to publish the speed-loop ceiling. */
  float applied_speed_ceiling_a_ = -1.0f;
  control::OverloadLimiter overload_{};
  float applied_speed_pi_kp_ = 0.10f;
  float applied_speed_pi_ki_ = 0.02f;
  float applied_speed_pi_kd_ = 0.0f;
  float applied_position_kp_ = 3.5f;
  float applied_position_ki_ = 1.2f;
  float applied_position_kd_ = 2.6f;
  float applied_position_vel_limit_ = 100.0f;
  float applied_position_isep_ = 0.35f;
  float applied_trajectory_accel_ = 1000.0f;
  float applied_max_modulation_ = DEVICE_MAX_MOD_DEFAULT;
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
  uint32_t last_outer_loop_cyccnt_ = 0U;
  uint32_t outer_loop_count_ = 0U;
  uint32_t outer_loop_miss_count_ = 0U;
  uint32_t outer_loop_dt_us_ = 0U;
  uint32_t outer_loop_dt_max_us_ = 0U;
  uint32_t encoder_trigger_divider_ = 0U;
  uint32_t current_isr_max_cycles_ = 0U;
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
  std::array<char, kVofaCommandMaxBytes> vofa_command_line_ = {};
  size_t vofa_command_length_ = 0U;
  uint8_t vofa_line_overflow_ = 0U;
  uint32_t last_host_cmd_tick_ = 0U;
  uint8_t host_seen_ = 0U;
  uint32_t host_timeout_trip_count_ = 0U;
  uint8_t reboot_pending_ = 0U;
  uint32_t reboot_request_tick_ = 0U;
  int32_t get_stream_index_ = -1; /* GET-all streaming cursor, -1 = idle */
  CmdRamp spd_ramp_ = {};
  CmdRamp pos_ramp_ = {};
  CmdRamp cur_ramp_ = {};
  uint8_t pos_ramp_timed_ = 0U;
  float applied_rs_ohm_ = DEVICE_DEFAULT_RS_OHM;
  float applied_ls_h_ = DEVICE_DEFAULT_LS_H;
  uint8_t zero_anchor_ready_ = 0U;
  float zero_anchor_unwrapped_ = 0.0f;
  float applied_zero_offset_ = 0.0f;
  uint8_t boot_position_pending_ = 0U;
  uint8_t boot_auto_enable_pending_ = 0U;
  uint8_t position_align_on_ready_ = 0U;
  uint8_t mit_align_on_ready_ = 0U;
  uint8_t fault_snap_valid_ = 0U;
  uint32_t fault_snap_tick_ = 0U;
  uint32_t fault_snap_word_ = 0U;
  float fault_snap_pos_ = 0.0f;
  float fault_snap_omega_ = 0.0f;
  float fault_snap_iq_ = 0.0f;
  float fault_snap_vbus_ = 0.0f;
  uint8_t fault_snap_mode_ = 0U;
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
      control::MechanicalAngleFromEncoder(
          encoder_angle_rad,
          control_encoder_direction == 0U,
          control_electrical_zero_rad);
  return control::Wrap0To2Pi(mech_cal * g_active_pole_pairs);
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
        if (calib_pair_index_ >= g_active_pole_pairs_u8) {
          const float mean_offset =
              calib_zero_sum_ /
              (g_active_pole_pairs * static_cast<float>(kCalibSampleMs));
          control_electrical_zero_rad =
              mean_offset - (kPi * (g_active_pole_pairs - 1.0f) / g_active_pole_pairs);
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

/* Latch `fault` and, the first time that bit sets, copy a short snapshot
 * before any later Disable() changes mode or current. */
void ApplicationController::NoteFault(safety::Fault fault) {
  const uint32_t bit = static_cast<uint32_t>(fault);
  const uint32_t before = fault_manager_.latchedFaults();
  fault_manager_.setFault(fault);
  if ((before & bit) != 0U) {
    return;
  }
  /* Same site as the new latch, before Disable() changes mode or current.
   * The 20 kHz ISR only raises a trip counter and leaves iq/bus in FOCState. */
  const auto &foc = foc_.GetState();
  fault_snap_valid_ = 1U;
  fault_snap_tick_ = HAL_GetTick();
  fault_snap_word_ = fault_manager_.latchedFaults() & 0xFFFFU;
  fault_snap_pos_ = FeedbackPosition();
  fault_snap_omega_ = speed_feedback_estimator_.state().velocity_rad_s;
  fault_snap_iq_ = foc.iq_a;
  fault_snap_vbus_ = foc.bus_v;
  fault_snap_mode_ = last_control_mode_;
}

void ApplicationController::BusWindow(float *min_v, float *max_v) const {
  float bus_max = control_vbus_max_v;
  if (!(bus_max <= DEVICE_VBUS_HARD_MAX_V)) {
    bus_max = DEVICE_VBUS_HARD_MAX_V;
  }
  *min_v = DeviceConfig_EffectiveVbusMin(control_vbus_min_v);
  *max_v = bus_max;
}

/*
 * Gate FOC/DRV: bus must stay inside [max(6 V, VBUS_MIN), VBUS_MAX] for
 * kBusOkSettleMs. VBUS_MAX cannot be configured above the 40 V board gate.
 * A 5 V debug supply still cannot arm the stage.
 */
uint8_t ApplicationController::UpdatePowerStageArm(float bus_v) {
  const auto &health = current_sense_.health();
  float bus_min = 0.0f;
  float bus_max = 0.0f;
  BusWindow(&bus_min, &bus_max);
  const bool bus_ok = (bus_v >= bus_min) && (bus_v <= bus_max);
  const bool drv_ok =
      HAL_GPIO_ReadPin(DRV_nFAULT_GPIO_Port, DRV_nFAULT_Pin) != GPIO_PIN_RESET;
  const bool encoder_ok =
      (encoder_valid_ != 0U) &&
      (rotor_estimator_.state().pll_sample_count != 0U);
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

void ApplicationController::SyncCmdRampIdle(CmdRamp &ramp,
                                            float applied,
                                            float command) {
  ramp.start = applied;
  ramp.applied = applied;
  ramp.last_cmd = command;
  ramp.last_ms = 0U;
  ramp.elapsed_ms = 0U;
}

float ApplicationController::StepCmdRamp(CmdRamp &ramp,
                                         float command,
                                         uint16_t dur_ms,
                                         float max_step) {
  if ((command != ramp.last_cmd) || (dur_ms != ramp.last_ms)) {
    ramp.start = ramp.applied;
    ramp.last_cmd = command;
    ramp.last_ms = dur_ms;
    ramp.elapsed_ms = 0U;
  }
  float timed = command;
  if ((dur_ms != 0U) && (ramp.elapsed_ms < dur_ms)) {
    const uint16_t next = static_cast<uint16_t>(ramp.elapsed_ms + 1U);
    ramp.elapsed_ms = (next > dur_ms) ? dur_ms : next;
    const float scale =
        static_cast<float>(ramp.elapsed_ms) / static_cast<float>(dur_ms);
    timed = ramp.start + ((command - ramp.start) * scale);
  }
  /* Timed ramp and the legacy per-step slew both apply. The slower one wins,
   * including after the timer has already elapsed. */
  ramp.applied = DeviceConfig_SlewToward(ramp.applied, timed, max_step);
  return ramp.applied;
}

float ApplicationController::FeedbackPosition() const {
  if ((DeviceConfig_ZeroIsSet() == 0U) || (zero_anchor_ready_ == 0U)) {
    return position_unwrapped_rad_;
  }
  return position_unwrapped_rad_ - zero_anchor_unwrapped_;
}

void ApplicationController::ServiceZeroAnchor() {
  if (DeviceConfig_ZeroIsSet() == 0U) {
    zero_anchor_ready_ = 0U;
    return;
  }
  if ((encoder_valid_ == 0U) || (position_inited_ == 0U)) {
    return;
  }
  if ((zero_anchor_ready_ != 0U) &&
      (control_zero_offset_rad == applied_zero_offset_)) {
    return;
  }
  /* ZERO_OFFSET is one encoder turn. The estimator starts each boot at the
   * single-turn canonical angle, so the first reported position is
   * wrap_±π(single_turn − offset) and does not jump by a whole turn.
   * Turns accumulated while powered off are gone: the encoder is single-turn.
   * GEAR_RATIO is not applied here. */
  const float reported = WrapPmPi(Wrap0To2Pi(position_unwrapped_rad_) -
                                  Wrap0To2Pi(control_zero_offset_rad));
  zero_anchor_unwrapped_ = position_unwrapped_rad_ - reported;
  applied_zero_offset_ = control_zero_offset_rad;
  zero_anchor_ready_ = 1U;
}

void ApplicationController::ApplyBootCommutation() {
  const DeviceConfigData *cfg = DeviceConfig_Live();
  uint8_t pairs = cfg->pole_pairs;
  if ((pairs < 1U) || (pairs > 40U)) {
    pairs = DEVICE_DEFAULT_POLE_PAIRS;
  }
  g_active_pole_pairs_u8 = pairs;
  g_active_pole_pairs = static_cast<float>(pairs);

  control_encoder_direction = kDefaultEncoderDirection;
  control_electrical_zero_rad = kDefaultElectricalZeroRad;
  CalibrationStoreData stored = {};
  if (CalibrationStore_Load(&stored) != 0) {
    control_encoder_direction = stored.encoder_direction;
    control_electrical_zero_rad = stored.electrical_zero_rad;
    calibration_flash_sequence = stored.sequence;
    calibration_flash_valid = 1U;
    calibration_flash_status = 1U;
  }
  /* A valid stored ENC_DIR replaces both the compile-time constant and the
   * direction saved inside the calibration record. An invalid or missing
   * config must not override a calibration that just loaded. */
  const DeviceConfigSource src = DeviceConfig_Source();
  if ((src != DEVCFG_SRC_INVALID) && (src != DEVCFG_SRC_DEFAULT)) {
    control_encoder_direction = cfg->enc_dir;
  }
}

void ApplicationController::ApplyMotorModelIfChanged() {
  if ((control_rs_ohm == applied_rs_ohm_) && (control_ls_h == applied_ls_h_)) {
    return;
  }
  applied_rs_ohm_ = control_rs_ohm;
  applied_ls_h_ = control_ls_h;
  control::MotorParams params = foc_.GetMotorParams();
  params.rs_ohm = applied_rs_ohm_;
  params.ld_h = applied_ls_h_;
  params.lq_h = applied_ls_h_;
  params.pole_pairs = g_active_pole_pairs;
  foc_.SetMotorParams(params);
}

void ApplicationController::ResetOuterLoopRamps() {
  const float position_fb = FeedbackPosition();
  speed_controller_.reset();
  position_controller_.reset();
  trajectory_.reset(position_fb);
  speed_ref_applied_rad_s_ = 0.0f;
  active_velocity_ref_rad_s_ = 0.0f;
  active_position_ref_rad_ = position_fb;
  active_accel_ref_rad_s2_ = 0.0f;
  current_test_iq_ref_a_ = 0.0f;
  SyncCmdRampIdle(spd_ramp_, 0.0f, 0.0f);
  SyncCmdRampIdle(cur_ramp_, 0.0f, 0.0f);
  SyncCmdRampIdle(pos_ramp_, position_fb, position_fb);
  pos_ramp_timed_ = 0U;
}

void ApplicationController::SetAutoEnable(uint8_t enable) {
  control_auto_enable = (enable != 0U) ? 1U : 0U;
  if (control_auto_enable != 0U) {
    /* Preserve the current CAN-selected control mode. If none exists, use a
     * zero-speed mode so the normal arm gate can retry automatically. */
    if (control_mode_cmd == kModeIdle) {
      SetMode(kModeSpeed);
      control_velocity_ref_rad_s = 0.0f;
    } else {
      control_enable = 1U;
    }
  }
}

uint8_t ApplicationController::GetAutoEnable() const {
  return control_auto_enable;
}

bool ApplicationController::PositionEncoderReady() const {
  return (encoder_valid_ != 0U) && (position_inited_ != 0U);
}

void ApplicationController::SetMode(uint8_t mode) {
  if (((mode == kModePosition) || (mode == kModeMit)) &&
      !PositionEncoderReady()) {
    /* Do not enter on a stale position target. Also drop a deferred
     * boot-into-position so it cannot start after this refusal. */
    boot_position_pending_ = 0U;
    boot_auto_enable_pending_ = 0U;
    return;
  }
  /* Any accepted mode change, including position, owns the boot request. */
  boot_position_pending_ = 0U;
  boot_auto_enable_pending_ = 0U;
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

  if (new_mode == kModePosition) {
    /* ResetOuterLoopRamps() clears the trajectory target. Put the pending
     * command back so the first POS/CAN target is not dropped. Targets are
     * in the same frame as FeedbackPosition(). Without a pending command and
     * without a position fix, do not arm the previous target. */
    position_align_on_ready_ = 0U;
    if (position_ref_pending_ == 0U) {
      if (position_inited_ != 0U) {
        control_position_target_rad = FeedbackPosition();
      } else {
        position_align_on_ready_ = 1U;
      }
    }
    if (position_align_on_ready_ == 0U) {
      trajectory_.setTarget(control_position_target_rad);
    }
    position_ref_pending_ = 0U;
  } else {
    position_align_on_ready_ = 0U;
  }
  if (new_mode == kModeMit) {
    mit_align_on_ready_ = 0U;
    if (mit_cmd_pending_ == 0U) {
      if (position_inited_ != 0U) {
        control_mit_pos_rad = FeedbackPosition();
        control_mit_vel_rad_s = 0.0f;
        control_mit_iq_ff_a = 0.0f;
      } else {
        mit_align_on_ready_ = 1U;
      }
    }
    mit_cmd_pending_ = 0U;
  } else {
    mit_align_on_ready_ = 0U;
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
  if (self == nullptr) {
    return;
  }

  // Debug probe detach can clear TRCENA after Init(). Encoder timestamps and
  // both estimators must keep working when running standalone, not just on SWD.
  if (((CoreDebug->DEMCR & CoreDebug_DEMCR_TRCENA_Msk) == 0U) ||
      ((DWT->CTRL & DWT_CTRL_CYCCNTENA_Msk) == 0U)) {
    CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
    DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
    control_cycle_clock_recovery_count++;
  }
  const uint32_t isr_start_cycles = DWT->CYCCNT;
  self->UpdateRotorInFocIsr(isr_start_cycles);
  self->foc_.OnPwmUpdate();

  if (++self->encoder_trigger_divider_ >= kEncoderTriggerDivider) {
    self->encoder_trigger_divider_ = 0U;
    (void)self->encoder_hw_.startReadDma();
  }

  const uint32_t isr_end_cycles = DWT->CYCCNT;
  const uint32_t isr_cycles = isr_end_cycles - isr_start_cycles;
  if (isr_cycles > self->current_isr_max_cycles_) {
    self->current_isr_max_cycles_ = isr_cycles;
  }
}

void ApplicationController::UpdateRotorInFocIsr(uint32_t now_cycles) {
  rotor_estimator_.predict(control::kFocDtS);

  hardware::EncoderSample sample = {};
  if (encoder_hw_.consumeLatestSample(sample)) {
    const float canonical_angle =
        control::MechanicalAngleFromEncoder(
            sample.angle_rad,
            control_encoder_direction == 0U,
            0.0f);
    rotor_estimator_.correct(canonical_angle,
                             sample.timestamp_cycles,
                             now_cycles);
  }

  const float theta_mech = rotor_estimator_.state().theta_mech_est_rad;
  const float theta_e =
      control::ElectricalAngleFromCanonicalMechanical(
          theta_mech,
          control_electrical_zero_rad,
          g_active_pole_pairs);
  foc_.SetDirectElectricalAngle(theta_e);
}

void ApplicationController::Init(ADC_HandleTypeDef *hadc,
                                 SPI_HandleTypeDef *hspi_encoder,
                                 TIM_HandleTypeDef *htim_pwm,
                                 UART_HandleTypeDef *huart_debug) {
  debug_uart_ = huart_debug;
  g_vofa_uart = huart_debug;
  g_vofa_rx_head = 0U;
  g_vofa_rx_tail = 0U;
  pwm_timer_ = htim_pwm;

  current_sense_.init(*hadc, hdma_adc1);
  (void)current_sense_.configureScan();
  encoder_hw_.init(*hspi_encoder, *GPIOA, GPIO_PIN_15);
  CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
  DWT->CYCCNT = 0U;
  DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
  rotor_estimator_.reset(0.0f, 0U);
  speed_sample_initialized_ = false;
  last_speed_sample_cycles_ = 0U;
  rotor_estimator_.setPllParams(control::RotorEstimator::kPllBandwidthHz,
                                control::RotorEstimator::kPllDamping);
  speed_controller_.init(control_speed_pi_kp,
                         control_speed_pi_ki,
                         control_iq_limit_a);
  /* Until the first 1 kHz tick the published clamp is the continuous limit.
   * The overload limiter steps in Update, not here and not in the ISR. */
  applied_speed_ceiling_a_ = control_iq_limit_a;
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
                       : 1000.0f);
  applied_trajectory_accel_ =
      (control_accel_ref_rad_s2 > 0.1f) ? control_accel_ref_rad_s2 : 1000.0f;
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

  ApplyBootCommutation();
  control::MotorParams params;
  control::motor_params::setDefaults(params);
  params.pole_pairs = g_active_pole_pairs;
  params.rs_ohm = control_rs_ohm;
  params.ld_h = control_ls_h;
  params.lq_h = control_ls_h;
  foc_.SetMotorParams(params);
  applied_rs_ohm_ = control_rs_ohm;
  applied_ls_h_ = control_ls_h;

  HAL_GPIO_WritePin(DRV_ENABLE_GPIO_Port, DRV_ENABLE_Pin, GPIO_PIN_RESET);
  if (current_sense_.calibrate(128U) != HAL_OK) {
    NoteFault(safety::Fault::CurrentSense);
  }

  (void)HAL_TIM_PWM_Start(htim_pwm, TIM_CHANNEL_1);
  (void)HAL_TIM_PWM_Start(htim_pwm, TIM_CHANNEL_2);
  (void)HAL_TIM_PWM_Start(htim_pwm, TIM_CHANNEL_3);
  (void)HAL_TIM_PWM_Start(htim_pwm, TIM_CHANNEL_4);
  current_sense_.setSampleCallback(OnCurrentSample, this);
  if (current_sense_.startHw() != HAL_OK) {
    NoteFault(safety::Fault::CurrentSense);
  }

  control_mode_cmd = kModeIdle;
  ClearLegacyModeFlags();
  control_enable = 0U;
  control_open_loop_enable = 0U;
  control_velocity_ref_rad_s = 0.0f;
  control_current_test_iq_ref_a = 0.0f;
  CalibReset();
  ResetOuterLoopRamps();
  bus_ok_ms_ = 0U;
  power_stage_armed_ = 0U;
  DisarmPowerStage();
  last_control_mode_ = kModeIdle; /* force on_mode_enter on first tick */
  last_control_tick_ = HAL_GetTick();
  VofaStartReceive(debug_uart_);
  if (DeviceConfig_CanBaudFallback() != 0U) {
    char buf[64];
    TextBuf t;
    Text_Init(&t, buf, sizeof(buf));
    Text_Str(&t, "@EVT CAN_BAUD fallback live=");
    Text_U32(&t, DEVICE_DEFAULT_CAN_BAUD);
    Text_Char(&t, '\n');
    Reply(t);
  }
  ApplyBootMode();
}

void ApplicationController::SetCurrentRef(float iq_ref_a) {
  control_current_test_iq_ref_a =
      Clamp(iq_ref_a, -IQ_HARD_MAX_A, IQ_HARD_MAX_A);
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
      Clamp(iq_ff_a, -IQ_HARD_MAX_A, IQ_HARD_MAX_A);
  mit_cmd_pending_ = 1U;
}

void ApplicationController::Disable() {
  SetMode(kModeIdle);
  // STOP must remove PWM immediately, not wait for the next scheduled update.
  DisarmPowerStage();
}

uint32_t ApplicationController::GetLatchedFaults() const {
  return fault_manager_.latchedFaults();
}

void ApplicationController::ApplyIdentResultIfReady() {
  if (!identifier_.IsDone()) {
    return;
  }

  foc_.SetMotorParams(identifier_.GetResult());
  control_rs_ohm = identifier_.GetResult().rs_ohm;
  control_ls_h = identifier_.GetResult().ld_h;
  applied_rs_ohm_ = control_rs_ohm;
  applied_ls_h_ = control_ls_h;
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

namespace {

constexpr const char *kFirmwareName = "DR4310";
constexpr const char *kFirmwareVersion = "3.1.1";

/* Index order is the default VOFA map. Slots 0..15 stay the historical frame.
 * 28 OlBudget is optional; the default 16-channel map does not include it.
 * 25 IqLimit stays the continuous IQ_LIM, not the live overload clamp. */
const char *const kTelemNames[DEVICE_TELEM_CHANNEL_COUNT] = {
    "IdRef", "Id",     "IqRef", "Iq",      "VdUnsat", "VqUnsat", "VdSat",
    "VqSat", "Vbus",   "Vsat",  "Omega",   "DutyA",   "DutyB",   "DutyC",
    "CurKp", "CurKi",  "Ia",    "Ib",      "Ic",      "Vd",      "Vq",
    "Rpm",   "PosRad", "ElecAngle", "Power", "IqLimit", "Fault", "Mode",
    "OlBudget"};

control::OverloadConfig OverloadConfigFromParams() {
  control::OverloadConfig cfg;
  cfg.iq_limit_a = control_iq_limit_a;
  cfg.ol_iq_a = control_ol_iq_a;
  cfg.ol_time_s = control_ol_time_s;
  cfg.ol_enable = (control_ol_en != 0.0f) ? 1U : 0U;
  return cfg;
}

bool TelemNameMatch(const char *canon, const char *upper) {
  if ((canon == nullptr) || (upper == nullptr)) {
    return false;
  }
  while (*canon != '\0') {
    char c = *canon;
    if ((c >= 'a') && (c <= 'z')) {
      c = static_cast<char>(c - ('a' - 'A'));
    }
    if (c != *upper) {
      return false;
    }
    ++canon;
    ++upper;
  }
  return *upper == '\0';
}

int FindTelemChannel(const char *upper) {
  for (size_t i = 0U; i < DEVICE_TELEM_CHANNEL_COUNT; ++i) {
    if (TelemNameMatch(kTelemNames[i], upper)) {
      return static_cast<int>(i);
    }
  }
  return -1;
}

const char *ModeName(uint8_t mode) {
  switch (mode) {
    case kModeIdle: return "IDLE";
    case kModeCurrent: return "CURRENT";
    case kModeSpeed: return "SPEED";
    case kModePosition: return "POSITION";
    case kModeMit: return "MIT";
    case kModeAlign: return "ALIGN";
    case kModeOpenLoop: return "OPENLOOP";
    case kModeIdent: return "IDENT";
    case kModeCalibrate: return "CALIBRATE";
    default: return "?";
  }
}

int ParseModeToken(const char *tok) {
  float v = 0.0f;
  if (Ascii_ParseFloat(tok, &v)) {
    const int m = static_cast<int>(v);
    return ((static_cast<float>(m) == v) && (m >= 0) && (m <= 4)) ? m : -1;
  }
  if ((std::strcmp(tok, "IDLE") == 0) || (std::strcmp(tok, "DISABLE") == 0)) return kModeIdle;
  if (std::strcmp(tok, "CURRENT") == 0) return kModeCurrent;
  if (std::strcmp(tok, "SPEED") == 0) return kModeSpeed;
  if (std::strcmp(tok, "POSITION") == 0) return kModePosition;
  if (std::strcmp(tok, "MIT") == 0) return kModeMit;
  return -1;
}

}  // namespace

bool ApplicationController::Reply(const TextBuf &text) {
  if (text.len == 0U) {
    return true;
  }
  /* Replies may use the whole queue; telemetry is capped lower. */
  return UartTxEnqueue(reinterpret_cast<const uint8_t *>(text.buf), text.len,
                       kUartTxQueueBytes - 1U);
}

void ApplicationController::ReplyOk(const char *cmd, const char *detail) {
  char buf[192];
  TextBuf t;
  Text_Init(&t, buf, sizeof(buf));
  Text_Str(&t, "@OK ");
  Text_Str(&t, cmd);
  if ((detail != nullptr) && (*detail != '\0')) {
    Text_Char(&t, ' ');
    Text_Str(&t, detail);
  }
  Text_Char(&t, '\n');
  Reply(t);
}

void ApplicationController::ReplyErr(const char *cmd, const char *reason) {
  char buf[192];
  TextBuf t;
  Text_Init(&t, buf, sizeof(buf));
  Text_Str(&t, "@ERR ");
  Text_Str(&t, cmd);
  Text_Char(&t, ' ');
  Text_Str(&t, reason);
  Text_Char(&t, '\n');
  Reply(t);
}

bool ApplicationController::ReplyParam(size_t index) {
  const DeviceParamInfo *info = DeviceConfig_ParamInfo(index);
  if (info == nullptr) {
    return true;
  }
  char buf[160];
  TextBuf t;
  Text_Init(&t, buf, sizeof(buf));
  Text_Str(&t, "@P ");
  Text_Str(&t, info->key);
  Text_Char(&t, '=');
  Text_Float(&t, DeviceConfig_GetParam(index));
  Text_Str(&t, " min=");
  Text_Float(&t, info->min);
  Text_Str(&t, " max=");
  Text_Float(&t, info->max);
  if (info->reboot_required != 0U) {
    Text_Str(&t, " reboot=1");
  }
  if ((info->choices != nullptr) && (info->choices[0] != '\0')) {
    Text_Str(&t, " choices=");
    Text_Str(&t, info->choices);
  }
  Text_Char(&t, '\n');
  /* Never drop a parameter line silently: wait for free space instead. */
  if ((UartTxUsed() + t.len) > (kUartTxQueueBytes - 1U)) {
    return false;
  }
  return Reply(t);
}

/* GET without a key streams all parameters from Update(): the full list is
 * larger than the TX queue, so lines are emitted as space frees up. */
void ApplicationController::ServiceGetStream() {
  if (get_stream_index_ < 0) {
    return;
  }
  const size_t count = DeviceConfig_ParamCount();
  while (static_cast<size_t>(get_stream_index_) < count) {
    if (!ReplyParam(static_cast<size_t>(get_stream_index_))) {
      return;
    }
    get_stream_index_++;
  }
  if ((UartTxUsed() + 16U) > (kUartTxQueueBytes - 1U)) {
    return;
  }
  char detail[12];
  TextBuf d;
  Text_Init(&d, detail, sizeof(detail));
  Text_U32(&d, static_cast<uint32_t>(count));
  ReplyOk("GET", detail);
  get_stream_index_ = -1;
}

void ApplicationController::ReplyInfo() {
  char buf[640];
  TextBuf t;
  Text_Init(&t, buf, sizeof(buf));
  const DeviceConfigData *cfg = DeviceConfig_Live();
  Text_Str(&t, "@INFO fw="); Text_Str(&t, kFirmwareName);
  Text_Str(&t, " ver="); Text_Str(&t, kFirmwareVersion);
  Text_Str(&t, " id="); Text_U32(&t, DeviceConfig_ActiveCanId());
  Text_Str(&t, " cfg_id="); Text_U32(&t, cfg->can_id);
  Text_Str(&t, " mode="); Text_U32(&t, control_mode_cmd);
  Text_Str(&t, " run="); Text_Str(&t, ModeName(telemetry_.control_mode));
  Text_Str(&t, " drv="); Text_U32(&t, ((DRV_ENABLE_GPIO_Port->ODR & DRV_ENABLE_Pin) != 0U) ? 1U : 0U);
  Text_Str(&t, " ae="); Text_U32(&t, control_auto_enable);
  Text_Str(&t, " telem="); Text_U32(&t, cfg->telemetry);
  Text_Str(&t, " fault=0x"); Text_Hex(&t, telemetry_.fault_flags & 0xFFFFU, 4U);
  Text_Str(&t, " latched=0x"); Text_Hex(&t, fault_manager_.latchedFaults() & 0xFFFFU, 4U);
  Text_Str(&t, " vbus="); Text_Float(&t, foc_.GetState().bus_v);
  Text_Str(&t, " calib="); Text_U32(&t, calibration_flash_valid);
  Text_Str(&t, " zero="); Text_Float(&t, control_electrical_zero_rad);
  Text_Str(&t, " dir="); Text_U32(&t, control_encoder_direction);
  Text_Str(&t, " cfg="); Text_Str(&t, DeviceConfig_SourceName());
  Text_Str(&t, " seq="); Text_U32(&t, DeviceConfig_Sequence());
  Text_Str(&t, " timeout="); Text_U32(&t, cfg->cmd_timeout_ms);
  Text_Str(&t, " trips="); Text_U32(&t, host_timeout_trip_count_);
  Text_Str(&t, " drops="); Text_U32(&t, g_uart_tx_drop_count);
  Text_Str(&t, " up="); Text_U32(&t, HAL_GetTick());
  Text_Str(&t, " pp="); Text_U32(&t, g_active_pole_pairs_u8);
  Text_Str(&t, " baud="); Text_U32(&t, cfg->can_baud);
  Text_Str(&t, " zoff="); Text_Float(&t, control_zero_offset_rad);
  Text_Str(&t, " zset="); Text_U32(&t, DeviceConfig_ZeroIsSet());
  Text_Str(&t, " zturn=1");
  Text_Str(&t, " can_fb="); Text_U32(&t, DeviceConfig_CanBaudFallback());
  /* ol=off, or ol=ready|active|recover budget=<seconds>. Text_Float strips
   * trailing zeros, so a full 2 s budget prints as budget=2. Phase off omits
   * the budget field. This is the limiter state from the last 1 kHz tick. */
  {
    const control::OverloadStatus ol = overload_.status();
    Text_Str(&t, " ol=");
    Text_Str(&t, control::OverloadPhaseName(ol.phase));
    if (ol.phase != control::OverloadPhase::Off) {
      Text_Str(&t, " budget=");
      Text_Float(&t, ol.budget_s);
    }
  }
  Text_Char(&t, '\n');
  Reply(t);
}

void ApplicationController::ReplyFault() {
  char buf[192];
  TextBuf t;
  Text_Init(&t, buf, sizeof(buf));
  Text_Str(&t, "@FAULT active=0x");
  Text_Hex(&t, fault_manager_.activeFaults() & 0xFFFFU, 4U);
  Text_Str(&t, " latched=0x");
  Text_Hex(&t, fault_manager_.latchedFaults() & 0xFFFFU, 4U);
  Text_Str(&t, " snap=");
  Text_U32(&t, fault_snap_valid_);
  Text_Str(&t, " t=");
  Text_U32(&t, fault_snap_tick_);
  Text_Str(&t, " fault=0x");
  Text_Hex(&t, fault_snap_word_ & 0xFFFFU, 4U);
  Text_Str(&t, " pos=");
  Text_Float(&t, fault_snap_pos_);
  Text_Str(&t, " omega=");
  Text_Float(&t, fault_snap_omega_);
  Text_Str(&t, " iq=");
  Text_Float(&t, fault_snap_iq_);
  Text_Str(&t, " vbus=");
  Text_Float(&t, fault_snap_vbus_);
  Text_Str(&t, " mode=");
  Text_U32(&t, fault_snap_mode_);
  Text_Char(&t, '\n');
  Reply(t);
}

void ApplicationController::ReplyTlist() {
  char buf[256];
  TextBuf t;
  Text_Init(&t, buf, sizeof(buf));
  Text_Str(&t, "@TLIST ");
  for (size_t i = 0U; i < DEVICE_TELEM_CHANNEL_COUNT; ++i) {
    if (i != 0U) {
      Text_Char(&t, ',');
    }
    Text_Str(&t, kTelemNames[i]);
  }
  Text_Char(&t, '\n');
  Reply(t);
}

void ApplicationController::ReplyTch() {
  char buf[192];
  TextBuf t;
  Text_Init(&t, buf, sizeof(buf));
  const uint8_t *map = DeviceConfig_TelemChannels();
  Text_Str(&t, "@TCH ");
  for (size_t i = 0U; i < DEVICE_TELEM_SLOTS; ++i) {
    if (i != 0U) {
      Text_Char(&t, ',');
    }
    const uint8_t id = map[i];
    if (id < DEVICE_TELEM_CHANNEL_COUNT) {
      Text_Str(&t, kTelemNames[id]);
    } else {
      Text_Str(&t, "?");
    }
  }
  Text_Char(&t, '\n');
  Reply(t);
}

bool ApplicationController::IsMotorIdle() const {
  return (control_mode_cmd == kModeIdle) &&
         (telemetry_.control_mode == kModeIdle) &&
         (control_auto_enable == 0U) &&
         ((DRV_ENABLE_GPIO_Port->ODR & DRV_ENABLE_Pin) == 0U);
}

void ApplicationController::NotifyHostActivity() {
  last_host_cmd_tick_ = HAL_GetTick();
  host_seen_ = 1U;
}

void ApplicationController::ResyncAfterFlashStall() {
  /* Flash erase/program stalls the CPU; restart the outer-loop deadline
   * reference so an intentional save is not reported as a control fault. */
  last_control_tick_ = HAL_GetTick();
  last_outer_loop_cyccnt_ = 0U;
}

void ApplicationController::ApplyBootMode() {
  const DeviceConfigData *cfg = DeviceConfig_Live();
  switch (cfg->boot_mode) {
    case kModeCurrent:
      SetCurrentRef(cfg->boot_target);
      SetMode(kModeCurrent);
      break;
    case kModeSpeed:
      SetSpeedRef(Clamp(cfg->boot_target, -kUartSpeedLimitRpm, kUartSpeedLimitRpm) * kRpmToRadS);
      SetMode(kModeSpeed);
      break;
    case kModePosition:
      /* The encoder is never ready at this point. Entering position here
       * would chase the pre-init target. Apply it on the first good sample. */
      boot_position_pending_ = 1U;
      boot_auto_enable_pending_ = (cfg->boot_auto_enable != 0U) ? 1U : 0U;
      break;
    default:
      break;
  }
  if ((cfg->boot_auto_enable != 0U) && (boot_position_pending_ == 0U)) {
    SetAutoEnable(1U);
  }
}

void ApplicationController::CheckHostTimeout(uint32_t now) {
  const uint16_t timeout = DeviceConfig_Live()->cmd_timeout_ms;
  if ((timeout == 0U) || (host_seen_ == 0U) || (control_auto_enable != 0U) ||
      (control_mode_cmd == kModeIdle) || (control_mode_cmd == kModeCalibrate)) {
    return;
  }
  if ((uint32_t)(now - last_host_cmd_tick_) > timeout) {
    SetCurrentRef(0.0f);
    Disable();
    host_timeout_trip_count_++;
    char buf[48];
    TextBuf t;
    Text_Init(&t, buf, sizeof(buf));
    Text_Str(&t, "@EVT TIMEOUT disabled ms=");
    Text_U32(&t, timeout);
    Text_Char(&t, '\n');
    Reply(t);
  }
}

void ApplicationController::ServiceReboot(uint32_t now) {
  if (reboot_pending_ == 0U) {
    return;
  }
  if (UartTxIdle() || ((uint32_t)(now - reboot_request_tick_) > kRebootDrainTimeoutMs)) {
    DisarmPowerStage();
    NVIC_SystemReset();
  }
}

void ApplicationController::ExecuteVofaCommand(char *line) {
  if (line == nullptr) {
    return;
  }
  Ascii_Upper(line);
  char *tok[kUartMaxTokens] = {};
  const size_t n = Ascii_Tokenize(line, tok, kUartMaxTokens);
  if (n == 0U) {
    return;
  }
  const char *cmd = tok[0];
  if (n > kUartMaxTokens) {
    ReplyErr(cmd, "too_many_args");
    return;
  }
  NotifyHostActivity();
  auto is = [cmd](const char *name) { return std::strcmp(cmd, name) == 0; };
  float v[kUartMaxTokens] = {};
  size_t nv = 0U;
  for (size_t i = 1U; i < n; ++i) {
    if (Ascii_ParseFloat(tok[i], &v[i - 1U])) {
      nv++;
    } else {
      break;
    }
  }
  const size_t nargs = n - 1U;
  char detail[96];
  TextBuf d;
  Text_Init(&d, detail, sizeof(detail));

  /* ---- no-argument commands ---- */
  if (is("PING")) {
    Text_Str(&d, "up="); Text_U32(&d, HAL_GetTick());
    char buf[48];
    TextBuf t;
    Text_Init(&t, buf, sizeof(buf));
    Text_Str(&t, "@PONG "); Text_Str(&t, detail); Text_Char(&t, '\n');
    Reply(t);
    return;
  }
  if (is("HELP")) {
    ReplyOk("HELP", "STOP RUN ZERO CLEAR CALIB IQ KP KI CUR SPD POS MIT MODE AE TELEM PING INFO GET SET SAVE DEFAULTS RELOAD REBOOT SETZERO TLIST TCH TRATE FAULT");
    return;
  }
  if (is("INFO")) {
    ReplyInfo();
    return;
  }
  if (is("STOP") || is("IDLE") || is("ESTOP")) {
    /* UART STOP is a real stop: it also leaves runtime auto-enable. */
    control_auto_enable = 0U;
    SetCurrentRef(0.0f);
    Disable();
    ReplyOk("STOP");
    return;
  }
  if (is("RUN") || is("CURRENT")) {
    SetMode(kModeCurrent);
    ReplyOk("RUN", "mode=CURRENT");
    return;
  }
  if (is("ZERO") || is("IQ0")) {
    SetCurrentRef(0.0f);
    ReplyOk("ZERO");
    return;
  }
  if (is("CLEAR") || is("CLR")) {
    ClearFaults();
    Text_Str(&d, "latched=0x"); Text_Hex(&d, fault_manager_.latchedFaults() & 0xFFFFU, 4U);
    ReplyOk("CLEAR", detail);
    return;
  }
  if (is("CALIB") || is("CALIBRATE")) {
    if (!IsMotorIdle()) { ReplyErr("CALIB", "not_idle"); return; }
    SetMode(kModeCalibrate);
    ReplyOk("CALIB", "started");
    return;
  }
  if (is("SAVE")) {
    if (!IsMotorIdle()) { ReplyErr("SAVE", "not_idle"); return; }
    const int bad = DeviceConfig_FirstInvalidParam();
    if (bad >= 0) {
      Text_Str(&d, "range "); Text_Str(&d, DeviceConfig_ParamInfo(static_cast<size_t>(bad))->key);
      ReplyErr("SAVE", detail);
      return;
    }
    uint32_t seq = 0U;
    const int ok = DeviceConfig_Save(&seq);
    ResyncAfterFlashStall();
    if (!ok) { ReplyErr("SAVE", "flash"); return; }
    Text_Str(&d, "seq="); Text_U32(&d, seq);
    ReplyOk("SAVE", detail);
    return;
  }
  if (is("DEFAULTS")) {
    if (!IsMotorIdle()) { ReplyErr("DEFAULTS", "not_idle"); return; }
    DeviceConfig_RestoreDefaults();
    ReplyOk("DEFAULTS", "ram_only");
    return;
  }
  if (is("RELOAD")) {
    if (!IsMotorIdle()) { ReplyErr("RELOAD", "not_idle"); return; }
    DeviceConfig_Reload();
    Text_Str(&d, "cfg="); Text_Str(&d, DeviceConfig_SourceName());
    ReplyOk("RELOAD", detail);
    return;
  }
  if (is("REBOOT")) {
    if (!IsMotorIdle()) { ReplyErr("REBOOT", "not_idle"); return; }
    ReplyOk("REBOOT");
    reboot_pending_ = 1U;
    reboot_request_tick_ = HAL_GetTick();
    return;
  }
  if (is("GET")) {
    if (nargs == 0U) {
      get_stream_index_ = 0;
      ServiceGetStream();
      return;
    }
    const int idx = DeviceConfig_FindParam(tok[1]);
    if (idx < 0) { ReplyErr("GET", "unknown_key"); return; }
    (void)ReplyParam(static_cast<size_t>(idx));
    ReplyOk("GET", "1");
    return;
  }
  if (is("SET")) {
    if (nargs != 2U) { ReplyErr("SET", "usage SET KEY VALUE"); return; }
    const int idx = DeviceConfig_FindParam(tok[1]);
    float value = 0.0f;
    if (idx < 0) { ReplyErr("SET", "unknown_key"); return; }
    if ((DeviceConfig_SetRequiresIdle(tok[1]) != 0) && !IsMotorIdle()) {
      ReplyErr("SET", "not_idle");
      return;
    }
    if (!Ascii_ParseFloat(tok[2], &value)) { ReplyErr("SET", "bad_value"); return; }
    const DeviceConfigStatus st = DeviceConfig_SetParam(static_cast<size_t>(idx), value);
    const DeviceParamInfo *info = DeviceConfig_ParamInfo(static_cast<size_t>(idx));
    if (st != DEVCFG_OK) {
      Text_Str(&d, "range "); Text_Str(&d, info->key); Text_Char(&d, ' ');
      Text_Float(&d, info->min); Text_Str(&d, ".."); Text_Float(&d, info->max);
      ReplyErr("SET", detail);
      return;
    }
    Text_Str(&d, info->key); Text_Char(&d, '=');
    Text_Float(&d, DeviceConfig_GetParam(static_cast<size_t>(idx)));
    if (info->reboot_required != 0U) {
      Text_Str(&d, " reboot=1");
    }
    ReplyOk("SET", detail);
    return;
  }
  if (is("SETZERO")) {
    if (nargs != 0U) { ReplyErr("SETZERO", "usage SETZERO"); return; }
    if (!IsMotorIdle()) { ReplyErr("SETZERO", "not_idle"); return; }
    if ((encoder_valid_ == 0U) || (position_inited_ == 0U)) {
      ReplyErr("SETZERO", "no_encoder");
      return;
    }
    const int zidx = DeviceConfig_FindParam("ZERO_OFFSET");
    const float offset = Wrap0To2Pi(position_unwrapped_rad_);
    if ((zidx < 0) ||
        (DeviceConfig_SetParam(static_cast<size_t>(zidx), offset) != DEVCFG_OK)) {
      ReplyErr("SETZERO", "range");
      return;
    }
    Text_Str(&d, "zero=");
    Text_Float(&d, control_zero_offset_rad);
    Text_Str(&d, " saved=0");
    ReplyOk("SETZERO", detail);
    return;
  }
  if (is("TLIST")) {
    ReplyTlist();
    return;
  }
  if (is("TCH")) {
    if (nargs == 0U) {
      ReplyTch();
      return;
    }
    if (nargs != DEVICE_TELEM_SLOTS) {
      ReplyErr("TCH", "usage TCH ch0,ch1,...,ch15");
      return;
    }
    uint8_t channels[DEVICE_TELEM_SLOTS] = {};
    for (size_t i = 0U; i < DEVICE_TELEM_SLOTS; ++i) {
      const int id = FindTelemChannel(tok[i + 1U]);
      if (id < 0) {
        ReplyErr("TCH", "unknown_channel");
        return;
      }
      channels[i] = static_cast<uint8_t>(id);
    }
    if (DeviceConfig_SetTelemChannels(channels, DEVICE_TELEM_SLOTS) == 0) {
      ReplyErr("TCH", "range");
      return;
    }
    ReplyOk("TCH");
    return;
  }
  if (is("TRATE")) {
    if (nargs == 0U) {
      uint32_t period_ms = 0U;
      const uint16_t hz = DeviceConfig_TelemHz();
      (void)DeviceConfig_TelemPeriodMs(hz, &period_ms);
      Text_Str(&d, "hz=");
      Text_U32(&d, hz);
      Text_Str(&d, " period_ms=");
      Text_U32(&d, period_ms);
      ReplyOk("TRATE", detail);
      return;
    }
    if (nargs != 1U) { ReplyErr("TRATE", "usage TRATE hz"); return; }
    float hz_value = 0.0f;
    if (!Ascii_ParseFloat(tok[1], &hz_value)) { ReplyErr("TRATE", "bad_value"); return; }
    const int hz_int = static_cast<int>(hz_value);
    if ((hz_int < 0) || (static_cast<float>(hz_int) != hz_value)) {
      ReplyErr("TRATE", "bad_value");
      return;
    }
    if (DeviceConfig_SetTelemHz(static_cast<uint16_t>(hz_int)) == 0) {
      Text_Str(&d, "bandwidth max=");
      Text_U32(&d, DeviceConfig_MaxTelemHz());
      ReplyErr("TRATE", detail);
      return;
    }
    uint32_t period_ms = 0U;
    (void)DeviceConfig_TelemPeriodMs(DeviceConfig_TelemHz(), &period_ms);
    Text_Str(&d, "hz=");
    Text_U32(&d, DeviceConfig_TelemHz());
    Text_Str(&d, " period_ms=");
    Text_U32(&d, period_ms);
    ReplyOk("TRATE", detail);
    return;
  }
  if (is("FAULT")) {
    if (nargs != 0U) { ReplyErr("FAULT", "too_many_args"); return; }
    ReplyFault();
    return;
  }

  /* ---- numeric-argument commands ---- */
  if (is("MODE")) {
    const int m = (nargs == 1U) ? ParseModeToken(tok[1]) : -1;
    if (m < 0) { ReplyErr("MODE", "usage MODE 0-4|IDLE|CURRENT|SPEED|POSITION|MIT"); return; }
    if ((m == kModePosition) || (m == kModeMit)) {
      if (!PositionEncoderReady()) {
        ReplyErr("MODE", "enc_not_ready");
        SetMode(static_cast<uint8_t>(m)); /* refuses entry, cancels deferred boot */
        return;
      }
    }
    if (m == kModeIdle) {
      SetCurrentRef(0.0f);
      Disable();
    } else {
      SetMode(static_cast<uint8_t>(m));
    }
    Text_Str(&d, "mode="); Text_Str(&d, ModeName(static_cast<uint8_t>(m)));
    ReplyOk("MODE", detail);
    return;
  }
  if (nv != nargs) {
    ReplyErr(cmd, "bad_value");
    return;
  }
  if (is("MIT")) {
    if (nargs != 5U) { ReplyErr("MIT", "usage MIT p v kp kd iq"); return; }
    if (!PositionEncoderReady()) {
      ReplyErr("MIT", "enc_not_ready");
      SetMode(kModeMit);
      return;
    }
    SetMode(kModeMit);
    SetMitCommand(Clamp(v[0], -kMitPMax, kMitPMax), Clamp(v[1], -kMitVMax, kMitVMax),
                  Clamp(v[2], 0.0f, kMitKpMax), Clamp(v[3], 0.0f, kMitKdMax), v[4]);
    ReplyOk("MIT");
    return;
  }
  if (nargs != 1U) {
    const bool known = is("IQ") || is("CUR") || is("SPD") || is("POS") ||
                       is("KP") || is("KI") || is("AE") || is("TELEM");
    ReplyErr(cmd, !known ? "unknown" : ((nargs == 0U) ? "missing_value" : "too_many_args"));
    return;
  }
  const float value = v[0];
  if (is("IQ")) {
    SetCurrentRef(value);
    Text_Str(&d, "iq="); Text_Float(&d, control_current_test_iq_ref_a);
    ReplyOk("IQ", detail);
  } else if (is("CUR")) {
    SetCurrentRef(value);
    SetMode(kModeCurrent);
    Text_Str(&d, "iq="); Text_Float(&d, control_current_test_iq_ref_a);
    ReplyOk("CUR", detail);
  } else if (is("SPD")) {
    const float rpm = Clamp(value, -kUartSpeedLimitRpm, kUartSpeedLimitRpm);
    SetMode(kModeSpeed);
    SetSpeedRef(rpm * kRpmToRadS);
    Text_Str(&d, "rpm="); Text_Float(&d, rpm);
    ReplyOk("SPD", detail);
  } else if (is("POS")) {
    const float rad = Clamp(value, -kUartPositionLimitRad, kUartPositionLimitRad);
    if (!PositionEncoderReady()) {
      ReplyErr("POS", "enc_not_ready");
      SetMode(kModePosition);
      return;
    }
    SetMode(kModePosition);
    SetPositionRef(rad);
    Text_Str(&d, "rad="); Text_Float(&d, rad);
    ReplyOk("POS", detail);
  } else if (is("KP")) {
    control_current_pi_kp = Clamp(value, 0.0f, kVofaCurrentKpMax);
    Text_Str(&d, "kp="); Text_Float(&d, control_current_pi_kp);
    ReplyOk("KP", detail);
  } else if (is("KI")) {
    control_current_pi_ki = Clamp(value, 0.0f, kVofaCurrentKiMax);
    Text_Str(&d, "ki="); Text_Float(&d, control_current_pi_ki);
    ReplyOk("KI", detail);
  } else if (is("AE")) {
    SetAutoEnable((value != 0.0f) ? 1U : 0U);
    Text_Str(&d, "ae="); Text_U32(&d, control_auto_enable);
    ReplyOk("AE", detail);
  } else if (is("TELEM")) {
    const int idx = DeviceConfig_FindParam("TELEM");
    if ((idx < 0) || (DeviceConfig_SetParam(static_cast<size_t>(idx), (value != 0.0f) ? 1.0f : 0.0f) != DEVCFG_OK)) {
      ReplyErr("TELEM", "internal");
      return;
    }
    Text_Str(&d, "telem="); Text_U32(&d, DeviceConfig_Live()->telemetry);
    ReplyOk("TELEM", detail);
  } else {
    ReplyErr(cmd, "unknown");
  }
}

void ApplicationController::ProcessVofaCommands() {
  uint8_t byte = 0U;
  while (VofaRxPop(byte)) {
    if ((byte == '\r') || (byte == '\n')) {
      if (vofa_line_overflow_ != 0U) {
        vofa_line_overflow_ = 0U;
        vofa_command_length_ = 0U;
        ReplyErr("LINE", "too_long");
        continue;
      }
      if (vofa_command_length_ != 0U) {
        vofa_command_line_[vofa_command_length_] = '\0';
        ExecuteVofaCommand(vofa_command_line_.data());
        vofa_command_length_ = 0U;
      }
      continue;
    }

    if ((byte >= 0x20U) && (byte <= 0x7EU)) {
      if (vofa_command_length_ < (vofa_command_line_.size() - 1U)) {
        vofa_command_line_[vofa_command_length_++] =
            static_cast<char>(byte);
      } else {
        /* Drop an overlong command instead of executing a truncated one. */
        vofa_line_overflow_ = 1U;
      }
    }
  }
}

void ApplicationController::SendVofaDebug() {
  if (debug_uart_ == nullptr) {
    return;
  }

  const uint32_t now = HAL_GetTick();
  uint32_t period_ms = kVofaDebugPeriodMs;
  if (DeviceConfig_TelemPeriodMs(DeviceConfig_TelemHz(), &period_ms) == 0) {
    period_ms = kVofaDebugPeriodMs;
  }
  if ((now - last_vofa_tick_) < period_ms) {
    return;
  }
  last_vofa_tick_ = now;
  if (DeviceConfig_Live()->telemetry == 0U) {
    return;
  }

  const auto &foc = foc_.GetState();
  const uint8_t *map = DeviceConfig_TelemChannels();
  std::array<float, kVofaFrameValueCount> frame_values = {};
  /* Default map is the historical 16 JustFloat channels. Duty values are
   * display-only; RX commands cannot write them. */
  for (size_t i = 0U; i < kVofaFrameValueCount; ++i) {
    frame_values[i] = TelemValue(map[i], foc);
  }

  std::array<uint8_t, kVofaFrameBytes> frame = {};
  std::memcpy(frame.data(),
              frame_values.data(),
              frame_values.size() * sizeof(float));
  constexpr size_t kFrameTailOffset = sizeof(float) * kVofaFrameValueCount;
  frame[kFrameTailOffset + 0U] = kVofaJustfloatTail0;
  frame[kFrameTailOffset + 1U] = kVofaJustfloatTail1;
  frame[kFrameTailOffset + 2U] = kVofaJustfloatTail2;
  frame[kFrameTailOffset + 3U] = kVofaJustfloatTail3;
  (void)UartTxEnqueue(frame.data(), frame.size(), kUartTxTelemetryHighWater);
}

float ApplicationController::TelemValue(uint8_t index,
                                        const control::FOCState &foc) const {
  const float omega = speed_feedback_estimator_.state().velocity_rad_s;
  switch (index) {
    case 0U: return foc.id_ref_a;
    case 1U: return foc.id_a;
    case 2U: return foc.iq_ref_a;
    case 3U: return foc.iq_a;
    case 4U: return foc.vd_unsat_v;
    case 5U: return foc.vq_unsat_v;
    case 6U: return foc.vd_sat_v;
    case 7U: return foc.vq_sat_v;
    case 8U: return foc.bus_v;
    case 9U: return static_cast<float>(foc.voltage_saturated);
    case 10U: return omega;
    case 11U: return foc.duty_a;
    case 12U: return foc.duty_b;
    case 13U: return foc.duty_c;
    case 14U: return control_current_pi_kp;
    case 15U: return control_current_pi_ki;
    case 16U: return current_.ia_a;
    case 17U: return current_.ib_a;
    case 18U: return -(current_.ia_a + current_.ib_a);
    case 19U: return foc.vd_v;
    case 20U: return foc.vq_v;
    case 21U: return omega * kRadSToRpm;
    case 22U: return FeedbackPosition();
    case 23U: return foc.electrical_angle_rad;
    case 24U:
      /* Amplitude-invariant Clarke: P = 1.5*(vd*id + vq*iq). */
      return 1.5f * ((foc.vd_sat_v * foc.id_a) + (foc.vq_sat_v * foc.iq_a));
    case 25U: return control_iq_limit_a;
    case 26U: return static_cast<float>(fault_manager_.latchedFaults() & 0xFFFFU);
    case 27U: return static_cast<float>(telemetry_.control_mode);
    case 28U: return overload_.status().budget_s;
    default: return 0.0f;
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
  ProcessVofaCommands();
  VofaPump(debug_uart_);
  ServiceGetStream();
  ServiceReboot(HAL_GetTick());

  const auto &foc_snap = foc_.GetState();
  if (foc_snap.isr_overrun_count > last_foc_overrun_count_) {
    last_foc_overrun_count_ = foc_snap.isr_overrun_count;
    if (foc_snap.isr_count == last_foc_isr_count_) {
      foc_.ResetIsrBusy();
    }
  }

  // A single scheduler owns the 1 kHz loop. ISR progress is diagnostic only;
  // OR-ing independent ISR and SysTick triggers used to execute near 2 kHz.
  last_foc_isr_count_ = foc_snap.isr_count;
  const uint32_t now = HAL_GetTick();
  if (!control::ConsumePeriodicTick(now, last_control_tick_, kControlPeriodMs)) {
    return;
  }

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

  CheckHostTimeout(now);
  fault_manager_.clearActiveFaults();

  // Keep angle and timestamp from the same DMA publication.
  const uint32_t encoder_snapshot_primask = __get_PRIMASK();
  __disable_irq();
  const auto encoder_health = encoder_hw_.health();
  __set_PRIMASK(encoder_snapshot_primask);
  const uint32_t last_valid_timestamp_cycles =
      encoder_health.last_valid_timestamp_cycles;
  const uint32_t encoder_now_cycles = DWT->CYCCNT;
  uint32_t encoder_age_cycles =
      encoder_now_cycles - last_valid_timestamp_cycles;
  if ((encoder_age_cycles & 0x80000000U) != 0U) {
    /* Timestamp read race / wrap artifact: do not turn it into a 10ms fault. */
    encoder_age_cycles = 0U;
  }
  const bool has_encoder_sample = encoder_health.valid_sample_count != 0U;
  if (has_encoder_sample &&
      (encoder_age_cycles <= kEncoderValidWindowCycles)) {
    encoder_valid_ = 1U;
  } else {
    encoder_valid_ = 0U;
    if (has_encoder_sample &&
        (encoder_health.valid_sample_count >=
         kEncoderMinValidSamplesForFault) &&
        (encoder_age_cycles > kEncoderFaultTimeoutCycles)) {
      telemetry_.encoder_fault_trigger_count++;
      telemetry_.encoder_fault_age_cycles = encoder_age_cycles;
      telemetry_.encoder_fault_valid_count =
          encoder_health.valid_sample_count;
      NoteFault(safety::Fault::EncoderComm);
    }
  }
  (void)encoder_hw_.timeoutStuckTransfer();
  if (encoder_valid_ != 0U) {
    encoder_.angle_rad = encoder_health.last_valid_angle_rad;
    encoder_.angle_deg = encoder_health.last_valid_angle_deg;
    encoder_.status = encoder_health.last_valid_status;
    encoder_.crc_ok = encoder_health.last_valid_crc_ok != 0U;
    encoder_.status_ok = encoder_health.last_valid_status_ok != 0U;
    const float canonical_angle =
        control::MechanicalAngleFromEncoder(
            encoder_.angle_rad,
            control_encoder_direction == 0U,
            0.0f);
    // Use encoder sample time, not an assumed 1 ms host-loop interval.
    // A repeated sample must not advance the estimator's time window.
    if (!speed_sample_initialized_) {
      speed_feedback_estimator_.reset(canonical_angle);
      last_speed_sample_cycles_ = last_valid_timestamp_cycles;
      speed_sample_initialized_ = true;
    } else if (last_valid_timestamp_cycles != last_speed_sample_cycles_) {
      const float sample_dt_s =
          static_cast<float>(last_valid_timestamp_cycles - last_speed_sample_cycles_) /
          static_cast<float>(kCpuClockHz);
      (void)speed_feedback_estimator_.update(canonical_angle, sample_dt_s);
      last_speed_sample_cycles_ = last_valid_timestamp_cycles;
    }
  }
  position_unwrapped_rad_ = rotor_estimator_.state().position_rad;
  if (rotor_estimator_.state().pll_sample_count != 0U) {
    position_inited_ = 1U;
  }
  ServiceZeroAnchor();
  if ((boot_position_pending_ != 0U) && PositionEncoderReady() &&
      (control_mode_cmd == kModeIdle)) {
    const DeviceConfigData *boot_cfg = DeviceConfig_Live();
    const uint8_t boot_ae = boot_auto_enable_pending_;
    boot_position_pending_ = 0U;
    boot_auto_enable_pending_ = 0U;
    SetMode(kModePosition);
    SetPositionRef(Clamp(boot_cfg->boot_target, -kUartPositionLimitRad,
                         kUartPositionLimitRad));
    if (boot_ae != 0U) {
      control_auto_enable = 1U;
    }
  }

  {
    current_ = foc_.GetLastCurrent();
    const auto &foc_snap = foc_.GetState();
    const auto &health = current_sense_.health();
    if (health.invalid_sample_count > last_invalid_sample_count_) {
      NoteFault(safety::Fault::CurrentSense);
    }
    if (foc_snap.overcurrent_trip_count > last_overcurrent_trip_count_) {
      NoteFault(safety::Fault::OverCurrent);
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
      NoteFault(safety::Fault::Driver);
    }
  }
  const float arm_bus_v = foc_snap.bus_v;
  float bus_min_v = 0.0f;
  float bus_max_v = 0.0f;
  BusWindow(&bus_min_v, &bus_max_v);
  foc_.SetMinBusVoltage(bus_min_v);
  identifier_.SetMinBusV(bus_min_v);
  if (arm_bus_v < bus_min_v) {
    NoteFault(safety::Fault::BusUndervoltage);
  } else if (arm_bus_v > bus_max_v) {
    NoteFault(safety::Fault::BusOvervoltage);
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

  /* Automatic-enable mode owns the enable decision without overwriting
   * current/speed/position/MIT references received over CAN. */
  if ((control_auto_enable != 0U) &&
      !fault_manager_.hasLatchedFault() &&
      (control_mode_cmd == kModeIdle) &&
      (control_current_test_enable == 0U) &&
      (control_position_enable == 0U) &&
      (control_open_loop_enable == 0U) &&
      (control_align_enable == 0U) &&
      (control_ident_enable == 0U) &&
      (control_calibrate_enable == 0U)) {
    control_mode_cmd = kModeSpeed;
    control_enable = 1U;
    control_velocity_ref_rad_s = 0.0f;
  }

  uint8_t control_mode = ResolveControlMode();
  if ((control_align_enable != 0U) && arm_all_ok) {
    control_mode = kModeAlign;
    ArmPowerStage();
    foc_.SetAngleOverride(1U, control_align_angle_rad);
    foc_.SetOpenLoopVoltage(1U, control_align_voltage_v, 0.0f);
    foc_.SetRefs(0.0f, 0.0f);
  }
  const bool auto_retry_without_fault =
      (control_auto_enable != 0U) && !fault_manager_.hasLatchedFault();
  if (!arm_all_ok &&
      ((control_mode != kModeIdle) || (last_control_mode_ != kModeIdle)) &&
      !auto_retry_without_fault) {
    // In normal mode a transient interlock cancels the persistent request.
    // Automatic-enable mode deliberately keeps it and retries on the next
    // cycle; a latched fault still takes the motor to IDLE immediately.
    Disable();
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
  if ((position_align_on_ready_ != 0U) && PositionEncoderReady()) {
    position_align_on_ready_ = 0U;
    control_position_target_rad = FeedbackPosition();
    trajectory_.setTarget(control_position_target_rad);
    SyncCmdRampIdle(pos_ramp_, control_position_target_rad,
                    control_position_target_rad);
  }
  if ((mit_align_on_ready_ != 0U) && PositionEncoderReady()) {
    mit_align_on_ready_ = 0U;
    control_mit_pos_rad = FeedbackPosition();
    control_mit_vel_rad_s = 0.0f;
    control_mit_iq_ff_a = 0.0f;
  }

  /* Speed-loop ceiling follows the configured overload current even while
   * recovering, so a saturated speed command stays visible to the budget.
   * 1 kHz is enough: one millisecond is 0.01% of a 10 s budget, and the
   * 20 kHz ISR only clamps to the limit published after this step. */
  const control::OverloadConfig ol_cfg = OverloadConfigFromParams();
  const float speed_ceiling = control::OverloadLimiter::CommandCeiling(ol_cfg);
  if (speed_ceiling != applied_speed_ceiling_a_) {
    applied_speed_ceiling_a_ = speed_ceiling;
    speed_controller_.setIqLimit(speed_ceiling);
  }

  float iq_preclamp = 0.0f;
  const float mech_vel = speed_feedback_estimator_.state().velocity_rad_s;
  if (control_mode == kModeSpeed) {
    telemetry_.speed_branch_exec_count++;
    const uint16_t spd_ms = DeviceConfig_Live()->spd_ramp_ms;
    if (spd_ms == 0U) {
      speed_ref_applied_rad_s_ =
          SlewRateLimit(speed_ref_applied_rad_s_,
                        control_velocity_ref_rad_s,
                        kSpeedRefRampRadS2 * kControlDtS);
      SyncCmdRampIdle(spd_ramp_, speed_ref_applied_rad_s_, control_velocity_ref_rad_s);
    } else {
      speed_ref_applied_rad_s_ =
          StepCmdRamp(spd_ramp_, control_velocity_ref_rad_s, spd_ms,
                      kSpeedRefRampRadS2 * kControlDtS);
    }
    active_velocity_ref_rad_s_ = speed_ref_applied_rad_s_;
    active_accel_ref_rad_s2_ = 0.0f;
    speed_controller_.setReference(active_velocity_ref_rad_s_);
    iq_preclamp = kTorqueIqSign * speed_controller_.update(mech_vel, kControlDtS);
  } else if (control_mode == kModePosition) {
    const uint16_t pos_ms = DeviceConfig_Live()->pos_ramp_ms;
    if (pos_ms == 0U) {
      if (pos_ramp_timed_ != 0U) {
        trajectory_.setTarget(control_position_target_rad);
        pos_ramp_timed_ = 0U;
      }
      SyncCmdRampIdle(pos_ramp_, control_position_target_rad, control_position_target_rad);
    } else {
      trajectory_.setTarget(
          StepCmdRamp(pos_ramp_, control_position_target_rad, pos_ms,
                      control_position_velocity_limit_rad_s * kControlDtS));
      pos_ramp_timed_ = 1U;
    }
    const float position_fb = FeedbackPosition();
    const auto &traj = trajectory_.update(position_fb, kControlDtS);
    active_position_ref_rad_ = traj.position_rad;
    active_accel_ref_rad_s2_ = traj.acceleration_rad_s2;
    const float position_vel_cmd =
        position_controller_.update(traj.position_rad,
                                    position_fb,
                                    mech_vel,
                                    kControlDtS);
    active_velocity_ref_rad_s_ =
        Clamp(position_vel_cmd + traj.velocity_rad_s,
              -control_position_velocity_limit_rad_s,
              control_position_velocity_limit_rad_s);
    speed_controller_.setReference(active_velocity_ref_rad_s_);
    iq_preclamp = kTorqueIqSign * speed_controller_.update(mech_vel, kControlDtS);
  } else if (control_mode == kModeMit) {
    const float position_error = control_mit_pos_rad - FeedbackPosition();
    const float velocity_error = control_mit_vel_rad_s - mech_vel;
    const float mit_sum =
        kTorqueIqSign *
        ((control_mit_kp * position_error) +
         (control_mit_kd * velocity_error) +
         control_mit_iq_ff_a);
    iq_preclamp = Clamp(mit_sum, -IQ_HARD_MAX_A, IQ_HARD_MAX_A);
    active_velocity_ref_rad_s_ = control_mit_vel_rad_s;
    active_accel_ref_rad_s2_ = 0.0f;
  } else if (control_mode == kModeCurrent) {
    const uint16_t cur_ms = DeviceConfig_Live()->cur_ramp_ms;
    if (cur_ms == 0U) {
      current_test_iq_ref_a_ =
          SlewRateLimit(current_test_iq_ref_a_,
                        control_current_test_iq_ref_a,
                        kCurrentTestRampAS * kControlDtS);
      SyncCmdRampIdle(cur_ramp_, current_test_iq_ref_a_, control_current_test_iq_ref_a);
    } else {
      current_test_iq_ref_a_ =
          StepCmdRamp(cur_ramp_, control_current_test_iq_ref_a, cur_ms,
                      kCurrentTestRampAS * kControlDtS);
    }
    iq_preclamp = current_test_iq_ref_a_;
  } else {
    active_velocity_ref_rad_s_ = 0.0f;
    active_accel_ref_rad_s2_ = 0.0f;
  }

  /* Demand is the larger of the pre-clamp command and the measured Iq.
   * foc_snap.iq_a is the live FOC state, not a copy from the top of Update. */
  const float ol_demand =
      std::max(std::fabs(iq_preclamp), std::fabs(foc_snap.iq_a));
  const control::OverloadStatus ol_status =
      overload_.step(ol_cfg, ol_demand, kControlDtS);
  if (ol_status.effective_a != applied_iq_limit_a_) {
    applied_iq_limit_a_ = ol_status.effective_a;
    foc_.SetCurrentLimit(applied_iq_limit_a_);
  }
  const float iq_ref =
      Clamp(iq_preclamp, -ol_status.effective_a, ol_status.effective_a);

  float omega_e = mech_vel * g_active_pole_pairs;
  ApplyMotorModelIfChanged();
  foc_.SetOmegaE(omega_e);

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
      (control_accel_ref_rad_s2 > 0.1f) ? control_accel_ref_rad_s2 : 1000.0f;
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
    if (arm_all_ok) {
      ArmPowerStage();
    } else {
      DisarmPowerStage();
    }
    foc_.SetAngleOverride(1U, control_align_angle_rad);
    foc_.SetOpenLoopVoltage(1U, control_align_voltage_v, 0.0f);
    foc_.SetRefs(0.0f, 0.0f);
  } else if (control_mode == kModeCalibrate) {
    if (arm_all_ok) {
      ArmPowerStage();
    } else {
      DisarmPowerStage();
    }
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
      if (calib_state_ == CalibState::kFail) {
        ReplyErr("CALIB", "failed");
      }
      if (calib_state_ == CalibState::kDone) {
        CalibrationStoreData calibration = {};
        calibration.electrical_zero_rad = control_electrical_zero_rad;
        calibration.encoder_direction = control_encoder_direction;
        uint32_t saved_sequence = 0U;
        if (CalibrationStore_Save(&calibration, &saved_sequence) != 0) {
          calibration_flash_sequence = saved_sequence;
          calibration_flash_valid = 1U;
          calibration_flash_status = 2U; /* Saved and read-back verified. */
          calibration_flash_save_count++;
          DeviceConfig_OnCalibrationSaved(control_encoder_direction, saved_sequence);
          ReplyOk("CALIB", "done saved");
          calib_state_ = CalibState::kIdle;
        } else {
          calibration_flash_status = 3U; /* Calibration ran, save failed. */
          ReplyErr("CALIB", "flash");
          calib_state_ = CalibState::kFail;
        }
        /* Flash erase/program stalls the CPU; restart the outer-loop deadline
         * reference so an intentional parameter save is not a control fault. */
        last_control_tick_ = HAL_GetTick();
      }
    } else {
      foc_.SetAngleOverride(1U, calib_angle_cmd_);
      foc_.SetOpenLoopVoltage(1U, calib_voltage_cmd_, 0.0f);
      foc_.SetRefs(0.0f, 0.0f);
    }
  } else if (control_mode == kModeIdent) {
    if (arm_all_ok) {
      ArmPowerStage();
    } else {
      DisarmPowerStage();
    }
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
    foc_.SetRefs(0.0f, iq_ref);
  } else if (control_mode == kModeOpenLoop) {
    ArmPowerStage();
    open_loop_velocity_rad_s_ =
        SlewRateLimit(open_loop_velocity_rad_s_,
                      control_velocity_ref_rad_s,
                      kOpenLoopRampRadS2 * kControlDtS);
    open_loop_electrical_angle_rad_ =
        Wrap0To2Pi(open_loop_electrical_angle_rad_ +
                   (open_loop_velocity_rad_s_ * g_active_pole_pairs * kControlDtS));

    float bus_v = current_.bus_v;
    const float open_loop_floor = DeviceConfig_EffectiveVbusMin(control_vbus_min_v);
    if (bus_v < open_loop_floor) {
      bus_v = open_loop_floor;
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
  telemetry_.velocity_rad_s = speed_feedback_estimator_.state().velocity_rad_s;
  telemetry_.accel_rad_s2 = rotor_estimator_.state().acceleration_rad_s2;
  telemetry_.legacy_window_velocity_rad_s =
      speed_feedback_estimator_.state().legacy_window_velocity_rad_s;
  telemetry_.pll_angle_error_rad =
      rotor_estimator_.state().pll_angle_error_rad;
  telemetry_.pll_measurement_dt_us =
      rotor_estimator_.state().pll_measurement_dt_us;
  telemetry_.encoder_sample_age_us =
      rotor_estimator_.state().encoder_sample_age_us;
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
  telemetry_.position_rad = FeedbackPosition();
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
  telemetry_.encoder_valid_sample_count =
      encoder_hw_.health().valid_sample_count;
  telemetry_.encoder_dma_start_fail_count =
      encoder_hw_.health().dma_start_fail_count;
  telemetry_.encoder_dma_error_count =
      encoder_hw_.health().dma_error_count;
  telemetry_.encoder_missed_trigger_count =
      encoder_hw_.health().missed_trigger_count;
  telemetry_.current_isr_max_cycles = current_isr_max_cycles_;
  telemetry_.current_isr_max_us =
      current_isr_max_cycles_ / (kCpuClockHz / 1000000U);
  telemetry_.encoder_dma_callback_max_us =
      encoder_hw_.health().dma_callback_max_us;
  telemetry_.encoder_status = encoder_.status;
  telemetry_.encoder_crc_ok = encoder_.crc_ok ? 1U : 0U;
  telemetry_.encoder_status_ok = encoder_.status_ok ? 1U : 0U;
  telemetry_.voltage_saturated = foc.voltage_saturated;
  telemetry_.encoder_valid = encoder_valid_;
  telemetry_.encoder_pll_locked =
      rotor_estimator_.state().pll_locked != 0U ? 1U : 0U;
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
  telemetry_.auto_enable = control_auto_enable;
  telemetry_.ident_state = static_cast<uint8_t>(ident.state);
  telemetry_.calib_state = static_cast<uint8_t>(calib_state_);
  telemetry_.encoder_direction = control_encoder_direction;
  telemetry_.electrical_zero_rad = control_electrical_zero_rad;
  telemetry_.calibration_flash_status = calibration_flash_status;
  telemetry_.calibration_flash_valid = calibration_flash_valid;
  telemetry_.calibration_flash_sequence = calibration_flash_sequence;
  telemetry_.calibration_flash_save_count = calibration_flash_save_count;

  SendVofaDebug();
  VofaPump(debug_uart_);
  (void)pwm_timer_;
}

const ControlTelemetry_t &ApplicationController::GetTelemetry() const {
  return telemetry_;
}

ApplicationController g_application;

}  // namespace app

extern "C" void HAL_UART_TxCpltCallback(UART_HandleTypeDef *huart) {
  if (huart == app::g_vofa_uart) {
    app::g_vofa_tx_busy = 0U;
  }
}

extern "C" void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart) {
  if (huart == app::g_vofa_uart) {
    app::VofaRxPushFromIsr(app::g_vofa_rx_byte);
    app::VofaStartReceive(huart);
  }
}

extern "C" void HAL_UART_ErrorCallback(UART_HandleTypeDef *huart) {
  if (huart == app::g_vofa_uart) {
    app::g_vofa_tx_busy = 0U;
    app::VofaStartReceive(huart);
  }
}

extern "C" void ControlApp_Init(ADC_HandleTypeDef *hadc,
                                SPI_HandleTypeDef *hspi_encoder,
                                TIM_HandleTypeDef *htim_pwm,
                                UART_HandleTypeDef *huart_debug) {
  app::g_application.Init(hadc, hspi_encoder, htim_pwm, huart_debug);
}

extern "C" void ControlApp_Update(void) {
  if (control_debug_cmd == 1U) {
    app::g_application.SetSpeedRef(control_debug_speed_ref_rad_s);
    app::g_application.SetMode(app::kModeSpeed);
    control_debug_cmd = 0U;
  } else if (control_debug_cmd == 2U) {
    app::g_application.Disable();
    control_debug_cmd = 0U;
  } else if (control_debug_cmd == 3U) {
    app::g_application.ClearFaults();
    control_debug_cmd = 0U;
  }
  app::g_application.Update();
}

extern "C" const ControlTelemetry_t *ControlApp_GetTelemetry(void) {
  return &app::g_application.GetTelemetry();
}

extern "C" void ControlApp_SetMode(uint8_t mode) {
  app::g_application.SetMode(mode);
}

extern "C" uint8_t ControlApp_PositionEncoderReady(void) {
  return app::g_application.PositionEncoderReady() ? 1U : 0U;
}

extern "C" uint8_t ControlApp_GetMode(void) {
  return control_mode_cmd;
}

extern "C" void ControlApp_SetAutoEnable(uint8_t enable) {
  app::g_application.SetAutoEnable(enable);
}

extern "C" uint8_t ControlApp_GetAutoEnable(void) {
  return app::g_application.GetAutoEnable();
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

extern "C" void ControlApp_NotifyHostActivity(void) {
  app::g_application.NotifyHostActivity();
}

extern "C" uint32_t ControlApp_GetLatchedFaults(void) {
  return app::g_application.GetLatchedFaults();
}
