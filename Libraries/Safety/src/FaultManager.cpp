#include "FaultManager.hpp"

namespace safety {

namespace {
constexpr uint32_t kSevereFaultMask =
    static_cast<uint32_t>(Fault::CurrentSense) |
    static_cast<uint32_t>(Fault::OverCurrent) |
    static_cast<uint32_t>(Fault::EncoderComm) |
    static_cast<uint32_t>(Fault::EncoderCrc) |
    static_cast<uint32_t>(Fault::EncoderMagnet) |
    static_cast<uint32_t>(Fault::Driver) |
    static_cast<uint32_t>(Fault::BusOvervoltage);
}

void FaultManager::setFault(Fault fault) {
  const uint32_t bit = static_cast<uint32_t>(fault);
  active_faults_ |= bit;
  latched_faults_ |= bit;
}

void FaultManager::clearActiveFaults() {
  active_faults_ = 0U;
}

void FaultManager::clearFaults() {
  active_faults_ = 0U;
  latched_faults_ = 0U;
}

bool FaultManager::hasLatchedFault() const {
  return latched_faults_ != 0U;
}

bool FaultManager::isSevere(Fault fault) const {
  return (kSevereFaultMask & static_cast<uint32_t>(fault)) != 0U;
}

uint32_t FaultManager::activeFaults() const {
  return active_faults_;
}

uint32_t FaultManager::latchedFaults() const {
  return latched_faults_;
}

}  // namespace safety
