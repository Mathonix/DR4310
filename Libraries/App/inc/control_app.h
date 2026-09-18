#ifndef CONTROL_APP_H
#define CONTROL_APP_H

#include "stm32g4xx_hal.h"

/* Primary run modes exposed to host/CAN/debug. */
#define CTRL_MODE_IDLE       0U
#define CTRL_MODE_CURRENT    1U
#define CTRL_MODE_SPEED      2U
#define CTRL_MODE_POSITION   3U
#define CTRL_MODE_MIT        4U

/* Internal/debug modes (still reported in telemetry.control_mode). */
#define CTRL_MODE_ALIGN      10U
#define CTRL_MODE_OPEN_LOOP  11U
#define CTRL_MODE_IDENT      12U
#define CTRL_MODE_CALIBRATE  13U  /* QDrive-style e-zero + encoder direction */
#define CTRL_MODE_DISABLED   0U  /* alias of IDLE */

typedef struct
{
  float angle_deg;
  float velocity_rad_s;
  float accel_rad_s2;
  float legacy_window_velocity_rad_s;
  float pll_angle_error_rad;
  float pll_measurement_dt_us;
  float encoder_sample_age_us;
  float accel_ref_rad_s2;
  float ia_a;
  float ib_a;
  float iq_ref_a;
  float iq_a;
  float id_a;
  float vd_v;
  float vq_v;
  float vd_unsat_v;
  float vq_unsat_v;
  float vd_sat_v;
  float vq_sat_v;
  float bus_v;
  float rs_est;
  float l_est;
  float flux_est;
  float position_rad;
  float position_ref_rad;
  uint32_t loop_count;
  uint32_t speed_branch_exec_count;
  uint32_t isr_count;
  uint32_t fault_flags;
  uint32_t latched_faults;
  uint32_t encoder_error_count;
  uint32_t encoder_crc_error_count;
  uint32_t encoder_valid_sample_count;
  uint32_t encoder_dma_start_fail_count;
  uint32_t encoder_dma_error_count;
  uint32_t encoder_missed_trigger_count;
  uint32_t encoder_fault_trigger_count;
  uint32_t encoder_fault_age_cycles;
  uint32_t encoder_fault_valid_count;
  uint32_t current_isr_max_cycles;
  uint32_t current_isr_max_us;
  uint32_t encoder_dma_callback_max_us;
  uint32_t outer_loop_count;
  uint32_t outer_loop_miss_count;
  uint32_t outer_loop_dt_us;
  uint32_t outer_loop_dt_max_us;
  uint8_t encoder_status;
  uint8_t encoder_crc_ok;
  uint8_t encoder_status_ok;
  uint8_t voltage_saturated;
  uint8_t encoder_valid;
  uint8_t encoder_pll_locked;
  uint8_t power_stage_armed;
  uint16_t bus_ok_ms;
  uint16_t drv_fault_ok_ms;
  uint8_t arm_bus_ok;
  uint8_t arm_drv_ok;
  uint8_t arm_encoder_ok;
  uint8_t arm_sense_ok;
  uint8_t arm_no_fault;
  uint8_t arm_all_ok;
  uint8_t control_mode;
  uint8_t ident_state;
  uint8_t calib_state;
  uint8_t encoder_direction;
  float electrical_zero_rad;
  uint8_t calibration_flash_status; /* 0=default, 1=loaded, 2=saved, 3=save failed */
  uint8_t calibration_flash_valid;
  uint32_t calibration_flash_sequence;
  uint32_t calibration_flash_save_count;
} ControlTelemetry_t;

#ifdef __cplusplus
extern "C" {
#endif

void ControlApp_Init(ADC_HandleTypeDef *hadc, SPI_HandleTypeDef *hspi_encoder, TIM_HandleTypeDef *htim_pwm, UART_HandleTypeDef *huart_debug);
void ControlApp_Update(void);
const ControlTelemetry_t *ControlApp_GetTelemetry(void);

/* Unified mode API */
void ControlApp_SetMode(uint8_t mode);
uint8_t ControlApp_GetMode(void);
void ControlApp_SetCurrentRef(float iq_ref_a);
void ControlApp_SetSpeedRef(float velocity_ref_rad_s);
void ControlApp_SetPositionRef(float position_target_rad);
void ControlApp_SetMitCommand(float pos_rad, float vel_rad_s, float kp, float kd, float iq_ff_a);
void ControlApp_Disable(void);
void ControlApp_ClearFault(void);
uint32_t ControlApp_GetLatchedFaults(void);

/* Primary mode selector (CTRL_MODE_*). */
extern volatile uint8_t control_mode_cmd;

/* Legacy / debug flags (still supported). */
extern volatile uint8_t control_enable;
extern volatile uint8_t control_open_loop_enable;
extern volatile uint8_t control_current_test_enable;
extern volatile uint8_t control_align_enable;
extern volatile uint8_t control_position_enable;
extern volatile uint8_t control_ident_enable;
extern volatile uint8_t control_calibrate_enable;
extern volatile uint8_t calibration_flash_status;
extern volatile uint8_t calibration_flash_valid;
extern volatile uint32_t calibration_flash_sequence;
extern volatile uint32_t calibration_flash_save_count;

extern volatile float control_velocity_ref_rad_s;
extern volatile float control_position_target_rad;
extern volatile float control_position_kp;
extern volatile float control_position_ki;
extern volatile float control_position_kd;
extern volatile float control_position_velocity_limit_rad_s;
extern volatile float control_position_i_sep_rad; /* |err| above this: freeze I (integral separation) */
extern volatile float control_open_loop_voltage_v;
extern volatile float control_current_test_iq_ref_a;
extern volatile float control_current_test_angle_rad;
extern volatile float control_align_angle_rad;
extern volatile float control_align_voltage_v;
extern volatile float control_current_pi_kp;
extern volatile float control_current_pi_ki;
extern volatile float control_current_pi_out_limit_v;
extern volatile float control_current_pi_kaw;
extern volatile float control_iq_limit_a;
extern volatile float control_speed_pi_kp;
extern volatile float control_speed_pi_ki;
extern volatile float control_speed_pi_kd;
extern volatile float control_accel_ref_rad_s2;
extern volatile float control_electrical_zero_rad;
/* 1 = QDrive encoder_direction true; 0 = inverted. */
extern volatile uint8_t control_encoder_direction;
extern volatile float control_max_modulation;
extern volatile uint8_t control_decoupling_enable;

/* MIT impedance parameters */
extern volatile float control_mit_pos_rad;
extern volatile float control_mit_vel_rad_s;
extern volatile float control_mit_kp;
extern volatile float control_mit_kd;
extern volatile float control_mit_iq_ff_a;

/* Debug command mailbox consumed by ControlApp_Update().
 * 1 = set speed ref and enter speed mode; 2 = disable. */
extern volatile uint8_t control_debug_cmd;
extern volatile float control_debug_speed_ref_rad_s;

#ifdef __cplusplus
}
#endif

#endif
