#ifndef CONTROL_TIMING_HPP
#define CONTROL_TIMING_HPP
#include <cstdint>
namespace control {
// Wrap-safe single timebase. Drop missed periods rather than executing a
// burst of fixed-dt control updates against the same measurements.
inline bool ConsumePeriodicTick(uint32_t now, uint32_t &last, uint32_t period) {
  if ((period == 0U) || (static_cast<uint32_t>(now - last) < period)) {
    return false;
  }
  last = now;
  return true;
}
}  // namespace control
#endif
