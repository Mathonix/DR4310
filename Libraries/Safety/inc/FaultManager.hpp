#ifndef FAULT_MANAGER_HPP
#define FAULT_MANAGER_HPP

#include <cstdint>

namespace safety {

enum class Fault : uint32_t {
  None = 0U,
  CurrentSense = 1U << 0,
  OverCurrent = 1U << 1,
  EncoderComm = 1U << 2,
  EncoderCrc = 1U << 3,
  EncoderMagnet = 1U << 4,
  Driver = 1U << 5,
  BusUndervoltage = 1U << 6,
  BusOvervoltage = 1U << 7,
  FocIsrOverrun = 1U << 8,
  OuterLoopDeadline = 1U << 9,
};

class FaultManager {
 public:
  void setFault(Fault fault);
  void clearActiveFaults();
  void clearFaults();

  bool hasLatchedFault() const;
  bool isSevere(Fault fault) const;
  uint32_t activeFaults() const;
  uint32_t latchedFaults() const;

 private:
  uint32_t active_faults_ = 0U;
  uint32_t latched_faults_ = 0U;
};

}  // namespace safety

#endif
