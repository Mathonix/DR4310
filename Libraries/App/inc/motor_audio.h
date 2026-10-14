#ifndef MOTOR_AUDIO_H
#define MOTOR_AUDIO_H
#include "AudioCurrent.hpp"
#include <atomic>
#include <cstddef>
#include <cstdint>

namespace audio {
enum class Axis : uint8_t { Q, D };
enum class State : uint8_t { Buffering, Playing, Paused, Draining, Finished, Halted, Fault, Exited };
enum class Reason : uint8_t { Ok, CrcError, SeqGap, BufferFull, ProtocolError, Timeout, Underrun, Cancelled, SafetyFault, ModeChanged, Ended, SessionMismatch };
enum class Type : uint8_t { Data=1, End=2, Abort=3, Ping=4, Exit=5, Pause=6, Resume=7, Status=0x81 };
constexpr uint16_t kMaxPayload=320, kGuard=128, kPrefill=800;
constexpr size_t kStatusFrameBytes=38, kMaxFrameBytes=334;
// Low-TX mode: skip per-DATA STATUS, send periodic STATUS every 100 ms.
// Reduces MCU->PC traffic ~10x to work around USB CDC bidirectional limits.
// Override with -DAUDIO_LOW_TX_MODE=0 for protocol-compliant tests.
#ifndef AUDIO_LOW_TX_MODE
#define AUDIO_LOW_TX_MODE 1
#endif
constexpr bool kLowTxMode = AUDIO_LOW_TX_MODE;
constexpr uint32_t kStatusIntervalMs = kLowTxMode ? 100 : 20;
constexpr uint16_t kWindow = kLowTxMode ? 12 : 6;
uint16_t Crc16(const uint8_t *data,size_t length);
size_t EncodeFrame(uint8_t *out,Type type,uint16_t sid,uint32_t seq,const uint8_t *payload,uint16_t length);
struct FrameView { Type type; uint16_t sid; uint32_t seq; const uint8_t *payload; uint16_t length; };
bool DecodeFrame(const uint8_t *bytes,size_t size,FrameView &out);
struct Status {
  uint32_t ack_next_seq, grant_seq_exclusive, played_samples, underrun_count;
  uint16_t buffer_samples, fault_flags;
  State state; Reason reason;
};
using StatusSink=bool (*)(const uint8_t *,size_t,void *);
class MotorAudio {
 public:
  void init(StatusSink sink,void *context);
  uint16_t open(Axis axis,uint16_t amplitude_ma,uint32_t now_ms);
  void receive(uint8_t byte,uint32_t now_ms);
  bool discardBinaryInAscii(uint8_t byte,uint32_t now_ms);
  void resetReceiver() { rx_used_=rx_expected_=0; }
  void service(uint32_t now_ms,bool safety_ok,uint16_t faults);
  float tick20kHz();
  void abortSafety(Reason reason);
  bool binary() const { return binary_.load(std::memory_order_acquire); }
  bool gate() const { return gate_.load(std::memory_order_acquire); }
  bool stopRequested() const { return stop_requested_.load(std::memory_order_acquire); }
  bool takeStopRequest() { return stop_requested_.exchange(false,std::memory_order_acq_rel); }
  Axis axis() const { return axis_; }
  float amplitudeA() const { return float(amplitude_ma_)/1000.0f; }
  Status status(Reason reason=Reason::Ok) const;
  bool asciiReady() const { return !binary(); }
 private:
  void frame(uint32_t now_ms);
  void resync();
  void emit(Reason reason);
  void flowReply(Reason reason);
  void stop(State state,Reason reason);
  void clearPlayback();
  void activity(uint32_t now) { last_input_ms_=now; watchdog_tripped_=false; }
  PcmRing pcm_;
  AudioCurrent player_;
  uint8_t rx_[kMaxFrameBytes]={};
  uint16_t rx_used_=0,rx_expected_=0,sid_=0,serial_sid_=0,amplitude_ma_=0,faults_=0;
  uint32_t ack_=0,last_input_ms_=0,last_status_ms_=0,last_rx_ms_=0;
  bool last_partial_=false,status_pending_=false,exit_pending_=false,watchdog_tripped_=false;
  Axis axis_=Axis::Q;
  State resume_state_=State::Buffering;
  Reason pending_reason_=Reason::Ok;
  Reason flow_reason_=Reason::Ok;
  std::atomic<State> state_{State::Exited};
  std::atomic<Reason> isr_reason_{Reason::Ok};
  std::atomic<Reason> terminal_reason_{Reason::Ok};
  std::atomic<bool> binary_{false},gate_{false},ended_{false},stop_requested_{false};
  StatusSink sink_=nullptr; void *context_=nullptr;
};
MotorAudio &Global();
}  // namespace audio
#endif
