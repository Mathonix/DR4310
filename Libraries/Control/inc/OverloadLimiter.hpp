#ifndef OVERLOAD_LIMITER_HPP
#define OVERLOAD_LIMITER_HPP

#include "iq_limits.h"

#include <cstdint>

namespace control {

/*
 * Budget + recovery Iq ceiling. No HAL. Call it from the 1 kHz outer loop,
 * not from the 20 kHz current ISR: a 1 ms quantum is 0.01% of a 10 s budget,
 * and the ISR already clamps Iq to the limit published by SetCurrentLimit.
 *
 * States (INFO uses these names):
 *   off      OL_EN=0, or OL_TIME_S==0, or OL_IQ does not clear IQ_LIM by
 *            OL_DETECT_MARGIN_A. Effective clamp = IQ_LIM. Budget is parked
 *            at the current OL_TIME_S (including 0). Enabling later, or
 *            raising OL_TIME_S from 0, starts from a full budget. Same clamp
 *            as 3.0.1 while this state holds.
 *   ready    Overload is allowed and the budget is full. Effective = OL_IQ
 *            (never above IQ_HARD_MAX_A).
 *   active   Overload is allowed and either the demand is above IQ_LIM or
 *            the budget is only partly full. Effective = OL_IQ.
 *   recover  Budget hit zero. Effective = IQ_LIM until the budget is full
 *            again. A partial refill does not re-arm, so the clamp cannot
 *            chatter on the boundary.
 *
 * Demand is max(|Iq command before this effective clamp|, |measured Iq|).
 * The speed PI ceiling stays at OL_IQ while the feature is configured, including
 * during recover, so a saturated speed loop is still seen as a request above
 * IQ_LIM and the budget does not refill until that request (and the measured
 * current) comes back to IQ_LIM.
 *
 * Spending: demand > IQ_LIM + OL_DETECT_MARGIN_A, budget -= dt.
 * Resting:  demand <= IQ_LIM, budget += dt / OL_RECOVERY_FACTOR.
 * The band in between holds the budget.
 * Turning the feature off (or OL_TIME_S to 0) refills the budget.
 */

enum class OverloadPhase : uint8_t {
  Off = 0,
  Ready = 1,
  Active = 2,
  Recover = 3,
};

struct OverloadConfig {
  float iq_limit_a = 0.0f;
  float ol_iq_a = 0.0f;
  float ol_time_s = 0.0f;
  uint8_t ol_enable = 0U;
};

struct OverloadStatus {
  float effective_a = 0.0f;
  float ceiling_a = 0.0f;
  float budget_s = 0.0f;
  float capacity_s = 0.0f;
  OverloadPhase phase = OverloadPhase::Off;
};

const char *OverloadPhaseName(OverloadPhase phase);

class OverloadLimiter {
 public:
  OverloadLimiter();

  /* Speed-loop output ceiling. Independent of the recover latch. */
  static float CommandCeiling(const OverloadConfig &cfg);

  OverloadStatus step(const OverloadConfig &cfg, float demand_abs_a, float dt_s);

  const OverloadStatus &status() const { return status_; }

 private:
  struct Norm {
    float iq_lim;
    float ol_iq;
    float capacity;
    uint8_t configured;
  };

  static Norm Normalize(const OverloadConfig &cfg);

  OverloadStatus status_;
  uint8_t allow_overload_ = 0U;
};

}  // namespace control

#endif
