#ifndef MOTOR_ID_H
#define MOTOR_ID_H

#include "MotorParams.hpp"
#include "foc_control.h"
#include <stdint.h>

typedef enum
{
  MOTOR_ID_IDLE = 0,
  MOTOR_ID_RS_PREP,
  MOTOR_ID_RS_MEASURE,
  MOTOR_ID_L_PREP,
  MOTOR_ID_L_MEASURE,
  MOTOR_ID_FLUX_RAMP,
  MOTOR_ID_FLUX_MEASURE,
  MOTOR_ID_DONE,
  MOTOR_ID_FAIL
} MotorIdState_t;

typedef struct
{
  MotorIdState_t state;
  control::MotorParams result;
  float rs_vd_sum;
  float rs_id_sum;
  float l_id_start;
  float l_id_peak;
  float l_time_s;
  float flux_vq_sum;
  float flux_iq_sum;
  float flux_we_sum;
  uint32_t sample_count;
  float timer_s;
  float id_ref_a;
  float iq_ref_a;
  float angle_override_rad;
  uint8_t use_angle_override;
  uint8_t use_open_loop_voltage;
  float open_loop_vd_v;
  float open_loop_vq_v;
  uint8_t fail_reason;
} MotorIdStatus_t;

#ifdef __cplusplus
extern "C" {
#endif

void MotorId_Init(void);
void MotorId_Start(void);
void MotorId_Abort(void);
uint8_t MotorId_IsActive(void);
uint8_t MotorId_IsDone(void);
uint8_t MotorId_IsFailed(void);
void MotorId_SlowTick(float dt, const FOCState_t *foc, float omega_e_rad_s, float bus_v);
const MotorIdStatus_t *MotorId_GetStatus(void);
const control::MotorParams *MotorId_GetResult(void);

#ifdef __cplusplus
}
#endif

#endif
