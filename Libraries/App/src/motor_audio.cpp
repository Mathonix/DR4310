#include "motor_audio.h"
#include <algorithm>
#include <cstring>
#include <limits>

namespace audio {
namespace {
uint16_t U16(const uint8_t *p){return uint16_t(p[0])|(uint16_t(p[1])<<8);}
uint32_t U32(const uint8_t *p){return uint32_t(U16(p))|(uint32_t(U16(p+2))<<16);}
void W16(uint8_t *p,uint16_t v){p[0]=uint8_t(v);p[1]=uint8_t(v>>8);}
void W32(uint8_t *p,uint32_t v){W16(p,uint16_t(v));W16(p+2,uint16_t(v>>16));}
MotorAudio global_audio;
}
MotorAudio &Global(){return global_audio;}
uint16_t Crc16(const uint8_t *p,size_t n){
  uint16_t crc=0xffff;
  while(n--){crc^=uint16_t(*p++)<<8;for(int i=0;i<8;++i)crc=uint16_t((crc<<1)^((crc&0x8000)?0x1021:0));}
  return crc;
}
size_t EncodeFrame(uint8_t *out,Type type,uint16_t sid,uint32_t seq,const uint8_t *payload,uint16_t length){
  if(!out || !sid || length>kMaxPayload || (length&&!payload))return 0;
  out[0]=0xa5;out[1]=0x5a;out[2]=1;out[3]=uint8_t(type);
  W16(out+4,sid);W32(out+6,seq);W16(out+10,length);
  if(length)std::memcpy(out+12,payload,length);
  W16(out+12+length,Crc16(out+2,10+length));return 14+length;
}
void MotorAudio::init(StatusSink sink,void *context){
  gate_.store(false);binary_.store(false);state_.store(State::Exited);
  sink_=sink;context_=context;clearPlayback();rx_used_=rx_expected_=0;
  player_.reset();sid_=amplitude_ma_=faults_=0;ack_=0;
  last_input_ms_=last_status_ms_=last_rx_ms_=0;
  last_partial_=watchdog_tripped_=false;ended_.store(false);
  status_pending_=exit_pending_=false;isr_reason_.store(Reason::Ok);stop_requested_.store(false);
  terminal_reason_.store(Reason::Ok);
  flow_reason_=Reason::Ok;
}
bool DecodeFrame(const uint8_t *b,size_t size,FrameView &out) {
  if(!b || size<14 || b[0]!=0xa5 || b[1]!=0x5a || b[2]!=1 || U16(b+4)==0)return false;
  const uint16_t n=U16(b+10);
  if(n>kMaxPayload || size!=size_t(n)+14 || Crc16(b+2,10+n)!=U16(b+12+n))return false;
  const auto type=Type(b[3]);const uint32_t seq=U32(b+6);
  if(type==Type::Data){if(n==0 || (n&1))return false;}
  else if(type==Type::Status){if(n!=24 || seq || b[32]>7 || b[33]>11 || U16(b+34))return false;}
  else if(b[3]<2 || b[3]>7 || n || (type!=Type::End && seq))return false;
  out={type,U16(b+4),seq,b+12,n};return true;
}
void MotorAudio::clearPlayback(){gate_.store(false,std::memory_order_release);pcm_.clearQuiescent();}
uint16_t MotorAudio::open(Axis axis,uint16_t amplitude_ma,uint32_t now){
  if(binary() || amplitude_ma<1 || amplitude_ma>(axis==Axis::Q?kQMaxAmplitudeMa:kDMaxAmplitudeMa))return 0;
  clearPlayback();player_.reset();axis_=axis;amplitude_ma_=amplitude_ma;
  sid_=++serial_sid_;if(sid_==0)sid_=++serial_sid_;
  ack_=0;last_partial_=false;watchdog_tripped_=false;ended_.store(false);faults_=0;
  rx_used_=rx_expected_=0;last_input_ms_=last_status_ms_=now;
  pending_reason_=Reason::Ok;status_pending_=exit_pending_=false;
  isr_reason_.store(Reason::Ok);stop_requested_.store(false);
  terminal_reason_.store(Reason::Ok);
  flow_reason_=Reason::Ok;
  state_.store(State::Buffering);binary_.store(true,std::memory_order_release);
  gate_.store(true,std::memory_order_release);return sid_;
}
Status MotorAudio::status(Reason reason) const{
  const uint32_t used=pcm_.used(),free=kPcmCapacity-used;
  const uint32_t grant=(free>kGuard)?(free-kGuard)/160:0;
  const uint32_t extra=std::min(grant,std::numeric_limits<uint32_t>::max()-ack_);
  return {ack_,ack_+extra,player_.played(),player_.underruns(),uint16_t(used),faults_,state_.load(std::memory_order_acquire),reason};
}
void MotorAudio::emit(Reason reason){
  const State current=state_.load(std::memory_order_acquire);
  if(current==State::Halted || current==State::Fault)reason=terminal_reason_.load(std::memory_order_acquire);
  pending_reason_=reason;status_pending_=true;
  uint8_t payload[24]={},out[kStatusFrameBytes];const Status s=status(reason);
  W32(payload,s.ack_next_seq);W32(payload+4,s.grant_seq_exclusive);W32(payload+8,s.played_samples);W32(payload+12,s.underrun_count);
  W16(payload+16,s.buffer_samples);W16(payload+18,s.fault_flags);payload[20]=uint8_t(s.state);payload[21]=uint8_t(s.reason);
  EncodeFrame(out,Type::Status,sid_,0,payload,24);
  if(sink_ && sink_(out,sizeof(out),context_)) {
    status_pending_=false;
    if(exit_pending_){exit_pending_=false;binary_.store(false,std::memory_order_release);rx_used_=rx_expected_=0;}
  }
}
void MotorAudio::flowReply(Reason reason){
  if(kLowTxMode)flow_reason_=reason;
  else emit(reason);
}
void MotorAudio::stop(State state,Reason reason){
  flow_reason_=Reason::Ok;
  terminal_reason_.store(reason,std::memory_order_release);
  gate_.store(false,std::memory_order_release);state_.store(state,std::memory_order_release);
  stop_requested_.store(true,std::memory_order_release);clearPlayback();emit(reason);
}
void MotorAudio::abortSafety(Reason reason){
  if(!binary())return;
  terminal_reason_.store(reason,std::memory_order_release);
  gate_.store(false,std::memory_order_release);
  state_.store(reason==Reason::SafetyFault?State::Fault:State::Halted,std::memory_order_release);
  isr_reason_.store(reason,std::memory_order_release);stop_requested_.store(true,std::memory_order_release);
}
float MotorAudio::tick20kHz(){
  if(!gate())return 0;
  const State state=state_.load(std::memory_order_acquire);
  if(state!=State::Playing && state!=State::Draining && state!=State::Paused)return 0;
  const TickResult r=player_.tick(pcm_,state==State::Paused,ended_.load(std::memory_order_acquire));
  if(r.dc_fault){abortSafety(Reason::SafetyFault);return 0;}
  if(r.underrun){abortSafety(Reason::Underrun);return 0;}
  if(r.finished){gate_.store(false);state_.store(State::Finished);isr_reason_.store(Reason::Ended);stop_requested_.store(true);return 0;}
  return std::clamp(r.normalized*amplitudeA(),-amplitudeA(),amplitudeA());
}
void MotorAudio::resync(){
  for(uint16_t i=1;i+1<rx_used_;++i)if(rx_[i]==0xa5&&rx_[i+1]==0x5a){
    rx_used_=uint16_t(rx_used_-i);std::memmove(rx_,rx_+i,rx_used_);rx_expected_=0;return;
  }
  const bool prefix=rx_used_&&rx_[rx_used_-1]==0xa5;rx_[0]=0xa5;rx_used_=prefix?1:0;rx_expected_=0;
}
void MotorAudio::receive(uint8_t byte,uint32_t now){
  if(!binary() || exit_pending_)return;
  if(rx_used_==0){if(byte==0xa5)rx_[rx_used_++]=byte;return;}
  if(rx_used_==1){if(byte==0x5a)rx_[rx_used_++]=byte;else rx_used_=byte==0xa5?1:0;return;}
  rx_[rx_used_++]=byte;
  if(rx_used_>=12 && rx_expected_==0){
    const uint16_t n=U16(rx_+10);
    if(n>kMaxPayload){emit(Reason::ProtocolError);resync();return;}
    rx_expected_=14+n;
  }
  if(rx_expected_ && rx_used_>=rx_expected_){frame(now);rx_used_=rx_expected_=0;}
}
bool MotorAudio::discardBinaryInAscii(uint8_t byte,uint32_t now) {
  if(binary())return false;
  if(rx_used_ && now-last_rx_ms_>=100)resetReceiver();
  if(rx_used_==0){if(byte!=0xa5)return false;last_rx_ms_=now;rx_[rx_used_++]=byte;return true;}
  last_rx_ms_=now;
  if(rx_used_==1){if(byte==0x5a)rx_[rx_used_++]=byte;else rx_used_=byte==0xa5?1:0;return true;}
  rx_[rx_used_++]=byte;
  if(rx_used_==12){const uint16_t n=U16(rx_+10);if(n>kMaxPayload){resetReceiver();return true;}rx_expected_=14+n;}
  if(rx_expected_ && rx_used_==rx_expected_) {
    FrameView f;
    // Lost final ACK: retransmitted EXIT for the last sid is idempotent.
    if(sid_ && DecodeFrame(rx_,rx_used_,f) && f.sid==sid_ && f.type==Type::Exit && state_.load()==State::Exited)emit(Reason::Ok);
    resetReceiver();
  }
  return true;
}
void MotorAudio::frame(uint32_t now){
  const uint16_t length=U16(rx_+10);const uint32_t seq=U32(rx_+6);
  // Damaged input never extends the valid-input watchdog.
  if(Crc16(rx_+2,10+length)!=U16(rx_+12+length)){flowReply(Reason::CrcError);return;}
  if(U16(rx_+4)!=sid_){emit(Reason::SessionMismatch);return;}
  if(rx_[2]!=1){emit(Reason::ProtocolError);return;}
  const Type type=static_cast<Type>(rx_[3]);State state=state_.load();
  if(type==Type::Data){
    if(length==0 || (length&1)){emit(Reason::ProtocolError);return;}
    if(seq<ack_){activity(now);flowReply(Reason::Ok);return;}
    if(seq>ack_){flowReply(Reason::SeqGap);return;}
    if(last_partial_ || ended_.load() || (state!=State::Buffering && state!=State::Playing && state!=State::Paused) || ack_==UINT32_MAX){emit(Reason::ProtocolError);return;}
    if(!pcm_.pushLittleEndian(rx_+12,length/2)){flowReply(Reason::BufferFull);return;}
    ++ack_;last_partial_=length<320;activity(now);
    bool started=false;
    if(state==State::Buffering && pcm_.used()>=kPrefill)
      started=state_.compare_exchange_strong(state,State::Playing,std::memory_order_acq_rel);
    flowReply(Reason::Ok);
    if(kLowTxMode && started)emit(Reason::Ok);
    return;
  }
  if(length || (type!=Type::End && seq)){emit(Reason::ProtocolError);return;}
  switch(type){
    case Type::Ping:break;
    case Type::Abort:activity(now);stop(State::Halted,Reason::Cancelled);return;
    case Type::Exit:activity(now);exit_pending_=true;stop(State::Exited,Reason::Ok);return;
    case Type::End:
      if(seq!=ack_){emit(Reason::SeqGap);return;}
      if(state==State::Halted || state==State::Fault || state==State::Exited){emit(Reason::ProtocolError);return;}
      if(state==State::Finished){activity(now);emit(Reason::Ended);return;}
      ended_.store(true,std::memory_order_release);
      if(state!=State::Paused)state_.compare_exchange_strong(state,State::Draining,std::memory_order_acq_rel);
      break;
    case Type::Pause:
      if(state==State::Paused)break;
      if(state!=State::Buffering&&state!=State::Playing&&state!=State::Draining){emit(Reason::ProtocolError);return;}
      resume_state_=state;state_.compare_exchange_strong(state,State::Paused,std::memory_order_acq_rel);break;
    case Type::Resume:
      if(state!=State::Paused){emit(Reason::ProtocolError);return;}
      state_.compare_exchange_strong(state,ended_.load()?State::Draining:(resume_state_==State::Buffering&&pcm_.used()>=kPrefill?State::Playing:resume_state_),std::memory_order_acq_rel);break;
    default:emit(Reason::ProtocolError);return;
  }
  activity(now);emit(kLowTxMode && type==Type::Ping ? flow_reason_ : Reason::Ok);
}
void MotorAudio::service(uint32_t now,bool safety_ok,uint16_t faults){
  if(!binary()){if(rx_used_ && now-last_rx_ms_>=100)resetReceiver();if(status_pending_)emit(pending_reason_);return;}
  faults_=faults;
  const State state=state_.load();
  if(!safety_ok && (state==State::Buffering||state==State::Playing||state==State::Paused||state==State::Draining))abortSafety(Reason::SafetyFault);
  const Reason event=isr_reason_.exchange(Reason::Ok,std::memory_order_acq_rel);
  if(event!=Reason::Ok){flow_reason_=Reason::Ok;clearPlayback();emit(event);}
  if(now-last_input_ms_<300)watchdog_tripped_=false;
  if(now-last_input_ms_>=300 && !watchdog_tripped_ && !exit_pending_) {
    watchdog_tripped_=true;stop(State::Halted,Reason::Timeout);
  }
  if(now-last_input_ms_>=2000 && !exit_pending_){
    gate_.store(false);stop_requested_.store(true);clearPlayback();state_.store(State::Exited);
    rx_used_=rx_expected_=0;status_pending_=false;binary_.store(false,std::memory_order_release);return;
  }
  if(status_pending_)emit(pending_reason_);
  else if(now-last_status_ms_>=kStatusIntervalMs){last_status_ms_=now;emit(kLowTxMode?flow_reason_:Reason::Ok);}
}
}  // namespace audio
