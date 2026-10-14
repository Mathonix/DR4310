#include "AudioCurrent.hpp"
#include <algorithm>
#include <cmath>

namespace audio {
bool PcmRing::pushLittleEndian(const uint8_t *bytes, uint32_t samples) {
  const uint32_t h = head_.load(std::memory_order_relaxed);
  const uint32_t t = tail_.load(std::memory_order_acquire);
  if (!bytes || samples > kPcmCapacity || h - t > kPcmCapacity - samples) return false;
  for (uint32_t i = 0; i < samples; ++i) {
    const uint16_t value = uint16_t(bytes[2*i]) | (uint16_t(bytes[2*i+1]) << 8);
    data_[(h+i) & (kPcmCapacity-1)] = static_cast<int16_t>(value);
  }
  head_.store(h+samples, std::memory_order_release);
  return true;
}
bool PcmRing::pop(int16_t &sample) {
  const uint32_t t = tail_.load(std::memory_order_relaxed);
  if (t == head_.load(std::memory_order_acquire)) return false;
  sample = data_[t & (kPcmCapacity-1)];
  tail_.store(t+1, std::memory_order_release);
  return true;
}
bool PcmRing::peek(int16_t &sample) const {
  const uint32_t t = tail_.load(std::memory_order_relaxed);
  if (t == head_.load(std::memory_order_acquire)) return false;
  sample = data_[t & (kPcmCapacity-1)];
  return true;
}
uint32_t PcmRing::used() const {
  // Load tail first: a producer publication cannot make occupancy negative.
  const uint32_t t=tail_.load(std::memory_order_acquire);
  return std::min(kPcmCapacity, head_.load(std::memory_order_acquire)-t);
}
void PcmRing::clearQuiescent() { tail_.store(0); head_.store(0); }
void AudioCurrent::reset() {
  played_.store(0); underruns_.store(0);
  phase_=empty_ticks_=drain_ticks_=constant_samples_=0; constant_value_=0;
  current_=gain_=last_=drain_hold_=0; draining_=false;
}
TickResult AudioCurrent::tick(PcmRing &pcm, bool paused, bool ended) {
  gain_ = paused ? std::max(0.0f,gain_-.01f) : std::min(1.0f,gain_+.01f);
  if (paused) return {last_*gain_,false,false,false};
  if (draining_) {
    if (++drain_ticks_ >= 200) { last_=0; return {0,true,false,false}; }
    last_=drain_hold_*(1.0f-float(drain_ticks_)/200.0f);
    return {last_*gain_,false,false,false};
  }
  int16_t next=0;
  const bool available=pcm.peek(next);
  if (!available && !ended) {
    current_=last_=0;
    ++empty_ticks_;
  } else empty_ticks_=0;
  phase_+=2;
  if (phase_>=5) {
    phase_-=5;
    int16_t value=0;
    if (pcm.pop(value)) {
      played_.fetch_add(1,std::memory_order_release);
      current_=float(value)/32768.0f;
      constant_samples_=(value!=0 && value==constant_value_) ? constant_samples_+1 : (value!=0 ? 1 : 0);
      constant_value_=value;
      if (constant_samples_>=800) return {0,false,false,true};
    } else if (!ended) underruns_.fetch_add(1,std::memory_order_release);
  }
  if (empty_ticks_>=1200) return {0,false,true,false};
  if (!pcm.peek(next)) {
    if (ended) {
      draining_=true; drain_ticks_=0;
      drain_hold_=last_*gain_;  // hold actual output, never grow a short tail
      last_=drain_hold_; gain_=1;
      return {drain_hold_,false,false,false};
    }
    last_=0; return {0,false,false,false};
  }
  last_=current_+(float(next)/32768.0f-current_)*float(phase_)/5.0f;
  return {last_*gain_,false,false,false};
}
void LimitAudioVector(float &id,float &iq,float sample_a,bool q_axis,
                      float amplitude_a,float limit) {
  amplitude_a=std::clamp(amplitude_a,0.0f,float(q_axis?kQMaxAmplitudeMa:kDMaxAmplitudeMa)/1000.0f);
  sample_a=std::clamp(sample_a,-amplitude_a,amplitude_a);
  if (q_axis) iq+=sample_a; else id+=sample_a;
  const float d_limit=std::min(amplitude_a,float(kDMaxAmplitudeMa)/1000.0f);
  id=std::clamp(id,-d_limit,d_limit);
  limit=std::max(0.0f,limit);
  const float mag2=id*id+iq*iq;
  if (mag2>limit*limit) {
    const float scale=limit/std::sqrt(mag2);
    id*=scale; iq*=scale;
  }
}
}  // namespace audio
