#ifndef AUDIO_CURRENT_HPP
#define AUDIO_CURRENT_HPP
#include <atomic>
#include <cstddef>
#include <cstdint>

namespace audio {
#ifndef AUDIO_LOW_TX_MODE
#define AUDIO_LOW_TX_MODE 1
#endif
constexpr uint32_t kPcmCapacity = AUDIO_LOW_TX_MODE ? 4096 : 2048;
constexpr uint16_t kQMaxAmplitudeMa = 1000;
constexpr uint16_t kDMaxAmplitudeMa = 200;
static_assert(std::atomic<uint32_t>::is_always_lock_free, "PCM indexes must be lock-free");
/* Producer: main, consumer: FOC ISR. Reset only with the audio gate closed.
 * Publishing head releases initialized PCM; publishing tail releases storage. */
class PcmRing {
 public:
  bool pushLittleEndian(const uint8_t *bytes, uint32_t samples);
  bool pop(int16_t &sample);
  bool peek(int16_t &sample) const;
  uint32_t used() const;
  void clearQuiescent();
 private:
  alignas(4) int16_t data_[kPcmCapacity] = {};
  std::atomic<uint32_t> head_{0}, tail_{0};
};
struct TickResult { float normalized; bool finished; bool underrun; bool dc_fault; };
/* ISR-owned after reset; no HAL, UART, CRC, allocation or trigonometry. */
class AudioCurrent {
 public:
  void reset();
  TickResult tick(PcmRing &pcm, bool paused, bool ended);
  uint32_t played() const { return played_.load(std::memory_order_acquire); }
  uint32_t underruns() const { return underruns_.load(std::memory_order_acquire); }
 private:
  std::atomic<uint32_t> played_{0}, underruns_{0};
  uint32_t phase_ = 0, empty_ticks_ = 0, drain_ticks_ = 0, constant_samples_ = 0;
  int16_t constant_value_ = 0;
  float current_ = 0, gain_ = 0, last_ = 0, drain_hold_ = 0;
  bool draining_ = false;
};
/* Pure D/Q injection used by the real FOC path and host tests. */
void LimitAudioVector(float &id, float &iq, float sample_a, bool q_axis,
                      float amplitude_a, float effective_limit_a);
}  // namespace audio
#endif
