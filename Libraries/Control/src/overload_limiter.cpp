#include "OverloadLimiter.hpp"

#include <algorithm>
#include <cmath>

namespace control {

namespace {

float FiniteNonNegative(float value) {
  if (!(value >= 0.0f)) {
    return 0.0f;
  }
  return value;
}

float ClampToHardMax(float value) {
  value = FiniteNonNegative(value);
  if (value > IQ_HARD_MAX_A) {
    return IQ_HARD_MAX_A;
  }
  return value;
}

}  // namespace

const char *OverloadPhaseName(OverloadPhase phase) {
  switch (phase) {
    case OverloadPhase::Ready:
      return "ready";
    case OverloadPhase::Active:
      return "active";
    case OverloadPhase::Recover:
      return "recover";
    case OverloadPhase::Off:
    default:
      return "off";
  }
}

OverloadLimiter::OverloadLimiter() {
  status_.phase = OverloadPhase::Off;
  status_.budget_s = OL_TIME_DEFAULT_S;
  status_.capacity_s = OL_TIME_DEFAULT_S;
  status_.effective_a = IQ_CONTINUOUS_MAX_A;
  status_.ceiling_a = IQ_CONTINUOUS_MAX_A;
  allow_overload_ = 0U;
}

OverloadLimiter::Norm OverloadLimiter::Normalize(const OverloadConfig &cfg) {
  Norm norm;
  norm.iq_lim = ClampToHardMax(cfg.iq_limit_a);
  norm.ol_iq = ClampToHardMax(cfg.ol_iq_a);
  if (norm.ol_iq < norm.iq_lim) {
    norm.ol_iq = norm.iq_lim;
  }
  norm.capacity = FiniteNonNegative(cfg.ol_time_s);
  if (norm.capacity > OL_TIME_MAX_S) {
    norm.capacity = OL_TIME_MAX_S;
  }
  const bool headroom = norm.ol_iq > (norm.iq_lim + OL_DETECT_MARGIN_A);
  norm.configured = ((cfg.ol_enable != 0U) && (norm.capacity > 0.0f) && headroom)
                        ? 1U
                        : 0U;
  return norm;
}

float OverloadLimiter::CommandCeiling(const OverloadConfig &cfg) {
  const Norm norm = Normalize(cfg);
  if (norm.configured == 0U) {
    return norm.iq_lim;
  }
  return norm.ol_iq;
}

OverloadStatus OverloadLimiter::step(const OverloadConfig &cfg,
                                     float demand_abs_a,
                                     float dt_s) {
  const Norm norm = Normalize(cfg);
  if (!(dt_s >= 0.0f)) {
    dt_s = 0.0f;
  }
  float demand = demand_abs_a;
  if (!(demand >= 0.0f)) {
    demand = 0.0f;
  }

  if (norm.configured == 0U) {
    allow_overload_ = 0U;
    status_.phase = OverloadPhase::Off;
    status_.budget_s = norm.capacity;
    status_.capacity_s = norm.capacity;
    status_.effective_a = norm.iq_lim;
    status_.ceiling_a = norm.iq_lim;
    return status_;
  }

  const float old_capacity = status_.capacity_s;
  if (status_.phase == OverloadPhase::Off) {
    /* Off parks the budget at the previous capacity, which is 0 when
     * OL_TIME_S is 0. Enabling, or raising the time from 0, starts full.
     * The first allowed tick is ready or active, not recover. */
    status_.budget_s = norm.capacity;
    allow_overload_ = 1U;
  } else {
    const bool was_full =
        (allow_overload_ != 0U) && (old_capacity > 0.0f) &&
        (status_.budget_s + 1.0e-4f >= old_capacity);
    if (was_full) {
      /* Lengthening OL_TIME_S while already full keeps the budget full. */
      status_.budget_s = norm.capacity;
    }
  }
  if (status_.budget_s > norm.capacity) {
    status_.budget_s = norm.capacity;
  }
  if (status_.budget_s < 0.0f) {
    status_.budget_s = 0.0f;
  }
  status_.capacity_s = norm.capacity;
  status_.ceiling_a = norm.ol_iq;

  if (status_.budget_s >= norm.capacity) {
    status_.budget_s = norm.capacity;
    allow_overload_ = 1U;
  }

  const bool spending = demand > (norm.iq_lim + OL_DETECT_MARGIN_A);
  const bool resting = demand <= norm.iq_lim;
  const float recover_per_s = 1.0f / OL_RECOVERY_FACTOR;

  if (allow_overload_ == 0U) {
    status_.effective_a = norm.iq_lim;
    status_.phase = OverloadPhase::Recover;
    if (resting) {
      status_.budget_s += dt_s * recover_per_s;
    }
    if (status_.budget_s < norm.capacity) {
      return status_;
    }
    /* Resting is what filled the budget, so this tick does not also spend.
     * The next tick may enter active if the demand is high again. */
    status_.budget_s = norm.capacity;
    allow_overload_ = 1U;
    status_.effective_a = norm.ol_iq;
    status_.phase = OverloadPhase::Ready;
    return status_;
  }

  status_.effective_a = norm.ol_iq;
  if (spending) {
    status_.budget_s -= dt_s;
    status_.phase = OverloadPhase::Active;
    if (status_.budget_s <= 0.0f) {
      status_.budget_s = 0.0f;
      allow_overload_ = 0U;
      status_.phase = OverloadPhase::Recover;
      status_.effective_a = norm.iq_lim;
    }
  } else if (resting) {
    status_.budget_s += dt_s * recover_per_s;
    if (status_.budget_s >= norm.capacity) {
      status_.budget_s = norm.capacity;
      status_.phase = OverloadPhase::Ready;
    } else {
      status_.phase = OverloadPhase::Active;
    }
  } else if (status_.budget_s >= norm.capacity) {
    status_.phase = OverloadPhase::Ready;
  } else {
    status_.phase = OverloadPhase::Active;
  }

  if (status_.effective_a > IQ_HARD_MAX_A) {
    status_.effective_a = IQ_HARD_MAX_A;
  }
  return status_;
}

}  // namespace control
