#ifndef IQ_LIMITS_H
#define IQ_LIMITS_H

/*
 * Current ceilings shared by the parameter table, the overload limiter and
 * the CAN/UART command clamps.
 *
 * IQ_CONTINUOUS_MAX_A (2.50 A) is the maximum of IQ_LIM, the continuous
 * working current. It matches the DRV8313 "2.5-A Peak" feature line and the
 * historical software clamp.
 *
 * IQ_HARD_MAX_A (2.80 A) is the absolute ceiling for OL_IQ and for every
 * commanded Iq. It is strictly below every hardware trip this firmware can
 * see, and the 20 kHz phase hard trip is not changed:
 *
 *   1. Phase hard trip: foc_control.cpp kOvercurrentTripA = 3.50 A, compared
 *      with |Ia|, |Ib| and |Ic| (not with Iq). Amplitude-invariant Clarke
 *      (i_alpha = Ia, i_beta = (Ia + 2*Ib) / sqrt(3)) makes the phase peak
 *      sqrt(id^2 + iq^2). With id regulated to 0 that peak equals |Iq|, so
 *      an Iq command of 2.80 A sits 0.70 A under the trip.
 *   2. ADC full scale: CurrentSense.cpp, INA240A2 gain 50 V/V, 10 mOhm
 *      shunt, 0.50 V/A, mid-rail 1.65 V, Vref 3.3 V.
 *      (3.3 - 1.65) / 0.5 = 3.30 A at the rail. 2.80 A produces 1.40 V,
 *      output 3.05 V, 250 mV of headroom before the converter clips.
 *   3. DRV8313 overcurrent: the datasheet feature list says 2.5 A peak.
 *      TI's protection-circuit minimum OCP threshold is 3 A (the worst-case
 *      part trips there; a typical part is higher). 2.80 A stays 0.20 A
 *      under that minimum so the driver's own nFAULT is not the current
 *      limit. Do not raise this to 3.00 A.
 *   4. Stator copper loss uses Rs = 1.97 ohm (motor_params.cpp). For this
 *      Clarke scaling, Pcu = 1.5 * Rs * Iq^2: about 18.5 W at 2.50 A and
 *      23.2 W at 2.80 A. The extra heat is only allowed for OL_TIME_S.
 *   5. GM6020 command full scale is +/-3.0 A (gm6020_can.c). Commands above
 *      2.80 A are clamped here before the limiter runs.
 *
 * The shunt at 2.80 A dissipates I^2*R = 0.078 W and is not the constraint.
 */

#define IQ_CONTINUOUS_MAX_A 2.50f
#define IQ_HARD_MAX_A 2.80f
#define OL_TIME_DEFAULT_S 2.0f
#define OL_TIME_MAX_S 10.0f

/* Real seconds to refill an empty budget = this factor * OL_TIME_S.
 * Budget is stored in seconds and drains 1:1 with real time, so the refill
 * rate is 1/OL_RECOVERY_FACTOR budget-seconds per real second. */
#define OL_RECOVERY_FACTOR 4.0f

/* |demand| must clear IQ_LIM by this much before the budget drains.
 * OL_IQ must clear IQ_LIM by the same amount or the limiter stays off, so a
 * ceiling inside the deadband cannot run forever without being counted. */
#define OL_DETECT_MARGIN_A 0.02f

#endif
