#ifndef MOTION_CONTROL_H
#define MOTION_CONTROL_H

#include <stdint.h>

typedef struct
{
  float mech_angle_rad;
  float mech_velocity_rad_s;
  float mech_accel_rad_s2;
  float velocity_ref_rad_s;
  float accel_ref_rad_s2;
  float iq_ref_a;
  uint8_t initialized;
} MotionState_t;

#ifdef __cplusplus
extern "C" {
#endif

void MotionControl_Init(void);
void MotionControl_ResetSpeedLoop(void);
void MotionControl_SetVelocityRef(float velocity_ref_rad_s);
void MotionControl_SetAccelRef(float accel_ref_rad_s2);
float MotionControl_Update(float mech_angle_rad, float dt);
const MotionState_t *MotionControl_GetState(void);

#ifdef __cplusplus
}
#endif

#endif
