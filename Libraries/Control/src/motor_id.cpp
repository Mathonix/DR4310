#include "MotorIdentifier.hpp"

#include <cmath>

namespace control {

namespace {

constexpr float kRsIdRefA = 0.50f;
constexpr float kLIdRefA = 0.50f;
constexpr float kIHardLimitA = 2.00f;
constexpr float kRsPrepS = 0.30f;
constexpr float kRsMeasureS = 0.50f;
constexpr float kLPrepS = 0.20f;
constexpr float kLMeasureS = 0.40f;
constexpr float kFluxRampS = 2.00f;
constexpr float kFluxMeasureS = 1.20f;
constexpr float kStageTimeoutS = 4.00f;
constexpr float kFluxWeMin = 40.0f;
constexpr float kOpenLoopVqV = 1.20f;
/* ~1000 rpm electrical with 14 pole pairs; only rejects real free-spin. */
constexpr float kRsOmegaMax = 200.0f;

enum class FailReason : uint8_t {
  kNone = 0U,
  kTimeout = 1U,
  kOvercurrent = 2U,
  kBus = 3U,
  kMotionRs = 4U,
  kBadRs = 5U,
  kBadL = 6U,
  kBadFlux = 7U,
};

}  // namespace

float MotorIdentifier::WrapAngle(float angle) {
  constexpr float kTwoPi = 6.28318530718f;
  angle = std::fmod(angle, kTwoPi);
  if (angle < 0.0f) {
    angle += kTwoPi;
  }
  return angle;
}

void MotorIdentifier::ResetAccumulators() {
  ident_.rs_vd_sum = 0.0f;
  ident_.rs_id_sum = 0.0f;
  ident_.l_id_start = 0.0f;
  ident_.l_id_peak = 0.0f;
  ident_.l_time_s = 0.0f;
  ident_.flux_vq_sum = 0.0f;
  ident_.flux_iq_sum = 0.0f;
  ident_.flux_we_sum = 0.0f;
  ident_.sample_count = 0U;
}

void MotorIdentifier::EnterState(MotorIdState state) {
  ident_.state = state;
  ident_.timer_s = 0.0f;
  ResetAccumulators();
}

bool MotorIdentifier::CheckSafety(const FOCState &foc,
                                  float bus_v,
                                  float omega_e_rad_s) {
  if (bus_v < 6.0f) {
    ident_.fail_reason = static_cast<uint8_t>(FailReason::kBus);
    return true;
  }

  float iabs = std::fabs(foc.id_a);
  if (std::fabs(foc.iq_a) > iabs) {
    iabs = std::fabs(foc.iq_a);
  }
  if (iabs > kIHardLimitA) {
    ident_.fail_reason = static_cast<uint8_t>(FailReason::kOvercurrent);
    return true;
  }

  if (((ident_.state == MotorIdState::kRsPrep) ||
       (ident_.state == MotorIdState::kRsMeasure) ||
       (ident_.state == MotorIdState::kLPrep) ||
       (ident_.state == MotorIdState::kLMeasure)) &&
      (std::fabs(omega_e_rad_s) > kRsOmegaMax) &&
      (ident_.timer_s > 0.05f)) {
    ident_.fail_reason = static_cast<uint8_t>(FailReason::kMotionRs);
    return true;
  }

  return false;
}

void MotorIdentifier::Init() {
  motor_params::setDefaults(ident_.result);
  ident_.state = MotorIdState::kIdle;
  ident_.id_ref_a = 0.0f;
  ident_.iq_ref_a = 0.0f;
  ident_.angle_override_rad = 0.0f;
  ident_.use_angle_override = 0U;
  ident_.use_open_loop_voltage = 0U;
  ident_.open_loop_vd_v = 0.0f;
  ident_.open_loop_vq_v = 0.0f;
  ident_.fail_reason = static_cast<uint8_t>(FailReason::kNone);
  ResetAccumulators();
}

void MotorIdentifier::Start() {
  motor_params::setDefaults(ident_.result);
  ident_.fail_reason = static_cast<uint8_t>(FailReason::kNone);
  ident_.use_angle_override = 1U;
  ident_.angle_override_rad = 0.0f;
  ident_.use_open_loop_voltage = 0U;
  ident_.id_ref_a = 0.0f;
  ident_.iq_ref_a = 0.0f;
  EnterState(MotorIdState::kRsPrep);
}

void MotorIdentifier::Abort() {
  ident_.state = MotorIdState::kIdle;
  ident_.id_ref_a = 0.0f;
  ident_.iq_ref_a = 0.0f;
  ident_.use_angle_override = 0U;
  ident_.use_open_loop_voltage = 0U;
  ident_.open_loop_vd_v = 0.0f;
  ident_.open_loop_vq_v = 0.0f;
}

bool MotorIdentifier::IsActive() const {
  return (ident_.state != MotorIdState::kIdle) &&
         (ident_.state != MotorIdState::kDone) &&
         (ident_.state != MotorIdState::kFail);
}

bool MotorIdentifier::IsDone() const {
  return ident_.state == MotorIdState::kDone;
}

bool MotorIdentifier::IsFailed() const {
  return ident_.state == MotorIdState::kFail;
}

void MotorIdentifier::SlowTick(float dt,
                               const FOCState &foc,
                               float omega_e_rad_s,
                               float bus_v) {
  if (!IsActive()) {
    return;
  }

  if (dt < 1.0e-4f) {
    dt = 1.0e-3f;
  }

  ident_.timer_s += dt;
  if (ident_.timer_s > kStageTimeoutS) {
    ident_.fail_reason = static_cast<uint8_t>(FailReason::kTimeout);
    ident_.state = MotorIdState::kFail;
    ident_.id_ref_a = 0.0f;
    ident_.iq_ref_a = 0.0f;
    ident_.use_open_loop_voltage = 0U;
    return;
  }

  if (CheckSafety(foc, bus_v, omega_e_rad_s)) {
    ident_.state = MotorIdState::kFail;
    ident_.id_ref_a = 0.0f;
    ident_.iq_ref_a = 0.0f;
    ident_.use_open_loop_voltage = 0U;
    return;
  }

  switch (ident_.state) {
    case MotorIdState::kRsPrep:
      ident_.use_angle_override = 1U;
      ident_.use_open_loop_voltage = 0U;
      ident_.id_ref_a = kRsIdRefA;
      ident_.iq_ref_a = 0.0f;
      if (ident_.timer_s >= kRsPrepS) {
        EnterState(MotorIdState::kRsMeasure);
      }
      break;

    case MotorIdState::kRsMeasure:
      ident_.id_ref_a = kRsIdRefA;
      ident_.iq_ref_a = 0.0f;
      if (std::fabs(foc.id_a) > 0.05f) {
        ident_.rs_vd_sum += foc.vd_v;
        ident_.rs_id_sum += foc.id_a;
        ident_.sample_count++;
      }
      if (ident_.timer_s >= kRsMeasureS) {
        if ((ident_.sample_count < 20U) ||
            (std::fabs(ident_.rs_id_sum) < 1.0e-3f)) {
          ident_.fail_reason = static_cast<uint8_t>(FailReason::kBadRs);
          ident_.state = MotorIdState::kFail;
          break;
        }

        const float rs = ident_.rs_vd_sum / ident_.rs_id_sum;
        if ((rs < 0.02f) || (rs > 20.0f)) {
          ident_.fail_reason = static_cast<uint8_t>(FailReason::kBadRs);
          ident_.state = MotorIdState::kFail;
          break;
        }
        ident_.result.rs_ohm = rs;
        EnterState(MotorIdState::kLPrep);
      }
      break;

    case MotorIdState::kLPrep:
      ident_.id_ref_a = 0.0f;
      ident_.iq_ref_a = 0.0f;
      if (ident_.timer_s >= kLPrepS) {
        EnterState(MotorIdState::kLMeasure);
        ident_.l_id_start = foc.id_a;
        ident_.l_id_peak = foc.id_a;
        ident_.l_time_s = 0.0f;
        ident_.id_ref_a = kLIdRefA;
      }
      break;

    case MotorIdState::kLMeasure:
      ident_.id_ref_a = kLIdRefA;
      ident_.iq_ref_a = 0.0f;
      if (foc.id_a > ident_.l_id_peak) {
        ident_.l_id_peak = foc.id_a;
      }
      {
        const float id_target =
            ident_.l_id_start + (0.63f * (kLIdRefA - ident_.l_id_start));
        if ((ident_.l_time_s <= 0.0f) && (foc.id_a >= id_target)) {
          ident_.l_time_s = ident_.timer_s;
        }
      }

      if (ident_.timer_s >= kLMeasureS) {
        const float di = ident_.l_id_peak - ident_.l_id_start;
        float target_di = kLIdRefA - ident_.l_id_start;
        if (target_di < 0.05f) {
          target_di = 0.05f;
        }

        if (ident_.l_time_s <= 1.0e-4f) {
          /* t63 not observed; estimate tau from incomplete first-order rise. */
          if (di > 0.02f) {
            float ratio = di / target_di;
            if (ratio > 0.99f) {
              ratio = 0.99f;
            }
            if (ratio < 0.02f) {
              ratio = 0.02f;
            }
            ident_.l_time_s = -kLMeasureS / std::log(1.0f - ratio);
          } else {
            ident_.l_time_s = 0.001f; /* 1 ms conservative tau */
          }
        }

        if (ident_.l_time_s < 50.0e-6f) {
          ident_.l_time_s = 50.0e-6f;
        }
        if (ident_.l_time_s > 3.0e-3f) {
          ident_.l_time_s = 3.0e-3f;
        }

        float l_h = ident_.result.rs_ohm * ident_.l_time_s;
        if (l_h > 8.0e-3f) {
          l_h = 8.0e-3f;
        }
        if ((l_h < 10.0e-6f) || (l_h > 20.0e-3f)) {
          ident_.fail_reason = static_cast<uint8_t>(FailReason::kBadL);
          ident_.state = MotorIdState::kFail;
          break;
        }
        ident_.result.ld_h = l_h;
        ident_.result.lq_h = l_h;
        EnterState(MotorIdState::kFluxRamp);
      }
      break;

    case MotorIdState::kFluxRamp:
      /* Open-loop electrical angle ramp + fixed Vq. */
      ident_.use_angle_override = 1U;
      ident_.use_open_loop_voltage = 1U;
      ident_.open_loop_vd_v = 0.0f;
      ident_.open_loop_vq_v = kOpenLoopVqV;
      ident_.id_ref_a = 0.0f;
      ident_.iq_ref_a = 0.0f;
      ident_.angle_override_rad =
          WrapAngle(ident_.angle_override_rad + (80.0f * dt));
      if (ident_.timer_s >= kFluxRampS) {
        EnterState(MotorIdState::kFluxMeasure);
      }
      break;

    case MotorIdState::kFluxMeasure:
      ident_.use_angle_override = 1U;
      ident_.use_open_loop_voltage = 1U;
      ident_.open_loop_vd_v = 0.0f;
      ident_.open_loop_vq_v = kOpenLoopVqV;
      ident_.angle_override_rad =
          WrapAngle(ident_.angle_override_rad + (80.0f * dt));

      if (std::fabs(omega_e_rad_s) > kFluxWeMin) {
        ident_.flux_vq_sum += foc.vq_v;
        ident_.flux_iq_sum += foc.iq_a;
        ident_.flux_we_sum += std::fabs(omega_e_rad_s);
        ident_.sample_count++;
      } else if (ident_.timer_s > 0.3f) {
        /* Fallback: commanded open-loop voltage / commanded we. */
        ident_.flux_vq_sum += kOpenLoopVqV;
        ident_.flux_iq_sum += foc.iq_a;
        ident_.flux_we_sum += 80.0f;
        ident_.sample_count++;
      }

      if (ident_.timer_s >= kFluxMeasureS) {
        if (ident_.sample_count < 20U) {
          ident_.fail_reason = static_cast<uint8_t>(FailReason::kBadFlux);
          ident_.state = MotorIdState::kFail;
          break;
        }

        const float vq_mean =
            ident_.flux_vq_sum / static_cast<float>(ident_.sample_count);
        const float iq_mean =
            ident_.flux_iq_sum / static_cast<float>(ident_.sample_count);
        const float we_mean =
            ident_.flux_we_sum / static_cast<float>(ident_.sample_count);
        float flux = (vq_mean - (ident_.result.rs_ohm * iq_mean)) / we_mean;
        if (flux < 0.0f) {
          flux = -flux;
        }
        if ((flux < 0.0005f) || (flux > 0.5f)) {
          ident_.fail_reason = static_cast<uint8_t>(FailReason::kBadFlux);
          ident_.state = MotorIdState::kFail;
          break;
        }

        ident_.result.flux_wb = flux;
        ident_.id_ref_a = 0.0f;
        ident_.iq_ref_a = 0.0f;
        ident_.use_open_loop_voltage = 0U;
        ident_.use_angle_override = 0U;
        ident_.state = MotorIdState::kDone;
      }
      break;

    default:
      break;
  }
}

const MotorIdStatus &MotorIdentifier::GetStatus() const {
  return ident_;
}

const MotorParams &MotorIdentifier::GetResult() const {
  return ident_.result;
}

}  // namespace control
