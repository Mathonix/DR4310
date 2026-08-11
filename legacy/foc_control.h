#ifndef FOC_CONTROL_H
#define FOC_CONTROL_H

#include "stm32g4xx_hal.h"
#include "current_sense.h"
#include "MotorParams.hpp"
#include <stdint.h>

#define FOC_DT_S                50.0e-6f
#define FOC_PWM_FREQ_HZ         20000.0f

typedef struct
{
  float id_ref_a;
  float iq_ref_a;
  float id_a;
  float iq_a;
  float vd_v;
  float vq_v;
  float v_alpha;
  float v_beta;
  float duty_a;
  float duty_b;
  float duty_c;
  float bus_v;
  float electrical_angle_rad;
  float omega_e_rad_s;
  float max_modulation;
  uint8_t enabled;
  uint8_t decoupling_enable;
  uint8_t angle_override_enable;
  uint8_t open_loop_voltage_enable;
  float angle_override_rad;
  float open_loop_vd_v;
  float open_loop_vq_v;
  uint32_t isr_count;
  uint32_t isr_overrun_count;
  uint32_t sample_fault_count;
} FOCState_t;

#ifdef __cplusplus
extern "C" {
#endif

void FOC_Init(TIM_HandleTypeDef *htim);
void FOC_Enable(uint8_t enable);
void FOC_SetCurrentLimit(float iq_limit_a);
void FOC_SetCurrentPi(float kp, float ki, float out_limit_v);
void FOC_SetMotorParams(const control::MotorParams *params);
void FOC_SetDecouplingEnable(uint8_t enable);
void FOC_SetMaxModulation(float max_mod);
void FOC_SetRefs(float id_ref_a, float iq_ref_a);
void FOC_SetElectricalAngle(float electrical_angle_rad);
void FOC_SetOmegaE(float omega_e_rad_s);
void FOC_SetAngleOverride(uint8_t enable, float electrical_angle_rad);
void FOC_SetOpenLoopVoltage(uint8_t enable, float vd_v, float vq_v);
void FOC_OnPwmUpdate(void);
const FOCState_t *FOC_GetState(void);
const control::MotorParams *FOC_GetMotorParams(void);
const CurrentSenseSample_t *FOC_GetLastCurrent(void);

/* Compatibility helpers for non-ISR callers (open-loop/align via refs). */
void FOC_RunVoltageVector(float electrical_angle_rad, float vd_v, float vq_v, float bus_v);

#ifdef __cplusplus
}
#endif

#endif
