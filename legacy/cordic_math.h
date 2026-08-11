#ifndef CORDIC_MATH_H
#define CORDIC_MATH_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

void CordicMath_Init(void);
/* angle_rad any real; returns sin/cos via G4 CORDIC (cosine fn, dual result). */
void CordicMath_SinCos(float angle_rad, float *sine, float *cosine);

#ifdef __cplusplus
}
#endif

#endif
