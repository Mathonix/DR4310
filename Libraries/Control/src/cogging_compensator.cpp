#include "CoggingCompensator.hpp"

#include <algorithm>
#include <cmath>

namespace control {
namespace {
constexpr float kTwoPi = 6.28318530718f;
}

bool CoggingCompensator::Matches(const CoggingMap &map, uint8_t direction,
                                 uint8_t pole_pairs, float zero) {
  return map.valid == 1U && map.encoder_direction == direction &&
         map.pole_pairs == pole_pairs && std::isfinite(zero) &&
         std::isfinite(map.electrical_zero_rad) &&
         std::fabs(map.electrical_zero_rad - zero) <= 1.0e-5f;
}

bool CoggingCompensator::SupportsMode(uint8_t mode) {
  // Public SPEED / POSITION / MIT only. Raw current, align, calibration and
  // identification must retain their commanded current/voltage semantics.
  return mode == 2U || mode == 3U || mode == 4U;
}

float CoggingCompensator::Lookup(const CoggingMap &map, float angle) {
  if (map.valid != 1U || !std::isfinite(angle)) return 0.0f;
  angle = std::fmod(angle, kTwoPi);
  if (angle < 0.0f) angle += kTwoPi;
  const float x = angle * (static_cast<float>(COGGING_TABLE_SIZE) / kTwoPi);
  const unsigned whole = static_cast<unsigned>(x);
  const unsigned i = whole % COGGING_TABLE_SIZE;
  const unsigned next = (i + 1U) % COGGING_TABLE_SIZE;
  const float fraction = x - static_cast<float>(whole);
  return (static_cast<float>(map.current_ma[i]) + fraction *
          static_cast<float>(map.current_ma[next] - map.current_ma[i])) * 0.001f;
}

float CoggingCompensator::Combine(float base, float compensation, float limit) {
  if (!std::isfinite(base) || !std::isfinite(compensation) ||
      !std::isfinite(limit) || limit < 0.0f) return 0.0f;
  return std::clamp(base + compensation, -limit, limit);
}

float CoggingCompensator::update(const CoggingMap &map, float angle,
                                bool allowed, float gain, float limit, float dt) {
  if (!allowed || map.valid != 1U || !std::isfinite(angle) ||
      !std::isfinite(gain) || !std::isfinite(limit) ||
      !std::isfinite(dt) || dt <= 0.0f) {
    blend_ = 0.0f;
    return 0.0f;
  }
  blend_ = std::min(1.0f, blend_ + 10.0f * dt);
  limit = std::clamp(limit, 0.0f, COGGING_LIMIT_MAX_A);
  return blend_ * std::clamp(Lookup(map, angle) * std::clamp(gain, 0.0f, 1.0f),
                             -limit, limit);
}
}  // namespace control
