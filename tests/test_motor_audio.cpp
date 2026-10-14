// g++ -std=c++17 -O2 -pthread -ILibraries/App/inc -ILibraries/Control/inc
// tests/test_motor_audio.cpp Libraries/App/src/motor_audio.cpp Libraries/Control/src/audio_current.cpp
#include "motor_audio.h"
#include "uart_dma_cursor.h"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <thread>
#include <vector>
#include <array>
#include <random>
using namespace audio;
uint16_t le16(const uint8_t *p){return uint16_t(p[0])|uint16_t(p[1])<<8;}
uint32_t le32(const uint8_t *p){return uint32_t(le16(p))|uint32_t(le16(p+2))<<16;}
struct Sink {
  std::vector<std::array<uint8_t,38>> frames;bool full=false;
  static bool send(const uint8_t *p,size_t n,void *ctx){
    auto &s=*static_cast<Sink *>(ctx);assert(n==38);if(s.full)return false;
    std::array<uint8_t,38> f;std::memcpy(f.data(),p,n);s.frames.push_back(f);return true;
  }
  Reason reason() const{return Reason(frames.back()[33]);}
};
struct Fixture {
  Sink sink;MotorAudio audio;uint16_t sid;
  Fixture(){audio.init(Sink::send,&sink);sid=audio.open(Axis::Q,20,0);assert(sid==1);}
  void send(Type t,uint32_t seq=0,uint32_t now=0,uint16_t samples=160,uint16_t other_sid=0){
    uint8_t data[320],frame[334];
    for(unsigned i=0;i<samples;i++){const int16_t v=int16_t(std::sin(float(i)*.235619449f)*20000);data[2*i]=uint8_t(v);data[2*i+1]=uint8_t(uint16_t(v)>>8);}
    const uint16_t n=t==Type::Data?2*samples:0;
    const size_t size=EncodeFrame(frame,t,other_sid?other_sid:sid,seq,data,n);
    for(size_t i=0;i<size;i++)audio.receive(frame[i],now);
  }
};
void tick(Fixture &f,unsigned n){for(unsigned i=0;i<n;i++){float a=f.audio.tick20kHz();assert(std::isfinite(a)&&std::fabs(a)<=.020001f);}}
int main(){
  assert(Crc16(reinterpret_cast<const uint8_t *>("123456789"),9)==0x29b1);
  static_assert(kLowTxMode ? kPcmCapacity==4096 && kWindow==12 : kPcmCapacity==2048 && kWindow==6);
  {
    Fixture f;f.audio.init(Sink::send,&f.sink);
    assert(f.audio.open(Axis::Q,1001,0)==0);
    assert(f.audio.open(Axis::D,201,0)==0);
    f.sid=f.audio.open(Axis::Q,1000,0);assert(f.sid&&f.audio.amplitudeA()==1.0f);
    for(unsigned i=0;i<5;i++)f.send(Type::Data,i);
    float peak=0;
    for(unsigned i=0;i<1000;i++){const float a=f.audio.tick20kHz();assert(std::fabs(a)<=1.000001f);peak=std::max(peak,std::fabs(a));}
    assert(peak>.55f); // ensure the old 0.2 A ceiling is actually removed
    f.audio.init(Sink::send,&f.sink);assert(f.audio.open(Axis::D,200,0));
  }
  if(kLowTxMode){
    {
      Fixture f;assert(f.audio.status().grant_seq_exclusive==24);
      for(unsigned i=0;i<4;i++)f.send(Type::Data,i);
      assert(f.sink.frames.empty());f.send(Type::Data,4);assert(f.sink.frames.size()==1);
      f.send(Type::Data,5);assert(f.sink.frames.size()==1);
      f.audio.service(99,true,0);assert(f.sink.frames.size()==1);
      f.audio.service(100,true,0);assert(f.sink.frames.size()==2);
      for(unsigned i=0;i<12;i++)f.send(Type::Data,99,101);
      assert(f.sink.frames.size()==2);f.audio.service(200,true,0);assert(f.sink.reason()==Reason::SeqGap);
      f.send(Type::Pause,0,201);assert(f.sink.frames.back()[32]==uint8_t(State::Paused));
      f.send(Type::Ping,0,202);assert(f.sink.frames.back()[32]==uint8_t(State::Paused));
      f.send(Type::Abort,0,203);assert(!f.audio.gate()&&f.sink.reason()==Reason::Cancelled);
      f.send(Type::Exit,0,204);assert(!f.audio.binary());
    }
    {
      Fixture f;uint8_t pcm[320]={},bad[334];EncodeFrame(bad,Type::Data,f.sid,0,pcm,320);bad[20]^=1;
      for(unsigned now=50;now<=300;now+=50){for(auto b:bad)f.audio.receive(b,now);f.audio.service(now,true,0);}
      assert(f.audio.status().state==State::Halted&&!f.audio.gate()&&f.sink.reason()==Reason::Timeout);
    }
    {
      Fixture f;f.send(Type::Data,0,0,3);f.send(Type::End,1);tick(f,300);f.audio.service(1,true,0);
      assert(f.audio.status().state==State::Finished&&f.audio.status().played_samples==3);
    }
    {
      Fixture f;uint32_t seq=0;
      for(uint32_t t=0;t<300*20000U;t++){
        if(t%400==0){const auto s=f.audio.status();unsigned window=0;while(seq<s.grant_seq_exclusive&&window<kWindow&&f.audio.status().buffer_samples<3200){f.send(Type::Data,seq++,t/20);++window;}f.audio.service(t/20,true,0);}
        const float a=f.audio.tick20kHz();assert(std::isfinite(a)&&std::fabs(a)<=.020001f);
      }
      assert(f.audio.status().played_samples==2400000&&f.audio.status().underrun_count==0);
      assert(f.sink.frames.size()<4000);f.send(Type::Abort);
      std::printf("low TX 5min: 2400000 samples, 0 underruns, %zu STATUS frames\n",f.sink.frames.size());
    }
    std::puts("motor_audio: low TX passed");return 0;
  }
  {
    Fixture f;f.audio.abortSafety(Reason::ProtocolError);f.audio.service(1,true,0);
    assert(f.sink.reason()==Reason::ProtocolError);
    f.audio.service(21,true,0);assert(f.sink.reason()==Reason::ProtocolError);
    f.send(Type::Ping,0,22);assert(f.sink.reason()==Reason::ProtocolError);
  }
  {
    constexpr uint32_t grant0=(kPcmCapacity-kGuard)/160, cap=kPcmCapacity/160;
    Fixture f;assert(f.audio.status().grant_seq_exclusive==grant0);
    for(unsigned i=0;i<cap;i++)f.send(Type::Data,i);
    auto s=f.audio.status();assert(s.ack_next_seq==cap&&s.buffer_samples==cap*160);
    f.send(Type::Data,cap);assert(f.sink.reason()==Reason::BufferFull&&f.audio.status().ack_next_seq==cap);
    f.send(Type::Data,4);assert(f.sink.reason()==Reason::Ok&&f.audio.status().buffer_samples==cap*160);
    f.send(Type::Data,cap+2);assert(f.sink.reason()==Reason::SeqGap);
    f.send(Type::Data,cap,0,160,42);assert(f.sink.reason()==Reason::SessionMismatch);
    assert(f.audio.status().state==State::Playing);
    tick(f,400);assert(f.audio.status().played_samples==160);
  }
  {
    Fixture f;f.send(Type::Data,0,0,3);assert(f.audio.status().state==State::Buffering);
    f.send(Type::Data,1);assert(f.sink.reason()==Reason::ProtocolError);
    f.send(Type::Data,0,0,3);assert(f.audio.status().buffer_samples==3);
    f.send(Type::End,2);assert(f.sink.reason()==Reason::SeqGap);
    f.send(Type::End,1);tick(f,300);f.audio.service(1,true,0);
    assert(f.audio.status().played_samples==3&&f.audio.status().state==State::Finished);
    assert(f.audio.tick20kHz()==0&&f.audio.stopRequested());
    f.send(Type::End,1);assert(f.sink.reason()==Reason::Ended);
  }
  {
    Fixture f;for(unsigned i=0;i<6;i++)f.send(Type::Data,i);
    tick(f,500);f.send(Type::Pause);auto before=f.audio.status();tick(f,4000);
    assert(f.audio.tick20kHz()==0&&f.audio.status().played_samples==before.played_samples&&f.audio.status().buffer_samples==before.buffer_samples);
    f.send(Type::Pause);assert(f.sink.reason()==Reason::Ok);
    f.send(Type::End,6);assert(f.audio.status().state==State::Paused);
    f.send(Type::Resume);assert(f.audio.status().state==State::Draining);tick(f,2400);
    assert(f.audio.status().state==State::Finished&&f.audio.status().played_samples==960);
  }
  {
    Fixture f;for(unsigned i=0;i<5;i++)f.send(Type::Data,i);
    tick(f,2000);assert(f.audio.status().played_samples==800);
    tick(f,1199);assert(f.audio.gate());tick(f,1);
    assert(f.audio.tick20kHz()==0&&f.audio.stopRequested());f.audio.service(1,true,0);assert(f.sink.reason()==Reason::Underrun);
    f.send(Type::Data,5);assert(f.audio.status().state==State::Halted);
  }
  {
    Fixture f;f.audio.service(299,true,0);assert(f.audio.gate());f.audio.service(300,true,0);
    assert(!f.audio.gate()&&f.audio.status().state==State::Halted&&f.sink.reason()==Reason::Timeout);
    f.send(Type::Ping,0,400);f.audio.service(2399,true,0);assert(f.audio.binary());f.audio.service(2400,true,0);assert(f.audio.asciiReady());
  }
  {
    Fixture f;for(unsigned i=0;i<5;i++)f.send(Type::Data,i);
    tick(f,100);f.audio.abortSafety(Reason::SafetyFault);assert(f.audio.tick20kHz()==0);f.audio.service(2,false,0x1234);
    auto &b=f.sink.frames.back();assert(f.audio.status().state==State::Fault&&le16(b.data()+30)==0x1234&&le16(b.data()+34)==0);
    assert(Crc16(b.data()+2,34)==le16(b.data()+36));
    f.send(Type::Exit);assert(f.audio.asciiReady()&&State(f.sink.frames.back()[32])==State::Exited);
    assert(f.audio.open(Axis::D,20,4)==2);
  }
  {
    Fixture f;f.send(Type::Abort);f.send(Type::Abort);assert(f.audio.status().state==State::Halted);
    f.sink.full=true;f.send(Type::Exit);assert(f.audio.binary()&&!f.audio.gate());
    f.audio.service(20,true,0);assert(f.audio.binary());f.sink.full=false;f.audio.service(21,true,0);assert(f.audio.asciiReady());
  }
  {
    Fixture f;uint8_t data[320]={},frame[334];
    const uint8_t magic[]={0xa5,0x5a,0,10,13,64,255};for(unsigned i=0;i<320;i++)data[i]=magic[i%7];
    auto n=EncodeFrame(frame,Type::Data,f.sid,0,data,320);frame[n-1]^=1;
    for(unsigned i=0;i<n;i++){f.audio.receive(frame[i],0);}assert(f.sink.reason()==Reason::CrcError&&f.audio.status().ack_next_seq==0);
    frame[n-1]^=1;for(unsigned i=0;i<n;i++)f.audio.receive(frame[i],1);assert(f.audio.status().ack_next_seq==1);
    frame[2]=2;frame[n-2]=uint8_t(Crc16(frame+2,n-4));frame[n-1]=uint8_t(Crc16(frame+2,n-4)>>8);
    for(unsigned i=0;i<n;i++){f.audio.receive(frame[i],1);}assert(f.sink.reason()==Reason::ProtocolError);
    // Oversized length header followed immediately by a valid whole packet.
    const uint8_t bad[]={0xa5,0x5a,1,1,1,0,0,0,0,0,0xff,0xff};for(auto b:bad)f.audio.receive(b,1);
    n=EncodeFrame(frame,Type::Data,f.sid,1,data,320);for(unsigned i=0;i<n;i++)f.audio.receive(frame[i],1);assert(f.audio.status().ack_next_seq==2);
  }
  {
    Fixture f;uint8_t payload[320],frame[334];for(unsigned i=0;i<160;i++){payload[2*i]=1;payload[2*i+1]=0;}
    for(unsigned i=0;i<5;i++){auto n=EncodeFrame(frame,Type::Data,f.sid,i,payload,320);for(unsigned j=0;j<n;j++)f.audio.receive(frame[j],0);}
    tick(f,2000);assert(f.audio.status().state==State::Fault&&f.audio.tick20kHz()==0);
  }
  // 5 minutes of real 20k ticks. Source sends bursts according to cumulative
  // credit/window, not one timer-driven DATA frame per 20 ms.
  {
    Fixture f;uint32_t seq=0;std::mt19937 rng(42);
    constexpr uint32_t ticks=300*20000;
    for(uint32_t t=0;t<ticks;t++) {
      if(t%20==0){
        const auto s=f.audio.status();unsigned window=0;
        while(seq<s.grant_seq_exclusive&&window<6&&f.audio.status().buffer_samples<1600){f.send(Type::Data,seq++,t/20);++window;}
        f.audio.service(t/20,true,0);
      }
      const float a=f.audio.tick20kHz();assert(std::isfinite(a)&&std::fabs(a)<=.020001f);
      if(t%20000==19999)assert(f.audio.status().played_samples==(t+1)*2/5);
      (void)rng;
    }
    assert(f.audio.status().played_samples==2400000&&f.audio.status().underrun_count==0);
    std::printf("5min: %u samples, %u underruns, bounded PCM\n",f.audio.status().played_samples,f.audio.status().underrun_count);
    f.send(Type::Abort);assert(f.audio.tick20kHz()==0);
  }
  {
    uint8_t buffer[2048]={};DmaCursor c;c.reset(0,0);
    assert(DmaCursor::produced(0,1024)==1024);assert(DmaCursor::produced(1,2048)==2048);
    assert(c.observe(2048,50));assert(!c.observe(2049,51));assert(c.overruns()==1);
    c.reset(UINT32_MAX-8,51);assert(c.observe(5,52));uint8_t b;unsigned count=0;while(c.pop(buffer,5,b))++count;assert(count==14);
    assert(!c.observe(5,140));
  }
  {
    float d=0,q=.02f;LimitAudioVector(d,q,-.2f,false,.2f,.1f);assert(d<0&&q>0&&std::hypot(d,q)<=.100001f);
    d=q=0;LimitAudioVector(d,q,-.02f,true,.02f,1);assert(d==0&&q==-.02f);
    d=q=0;LimitAudioVector(d,q,.02f,false,.02f,1);assert(d==.02f&&q==0);
    d=q=0;LimitAudioVector(d,q,1,true,1,1.9f);assert(d==0&&q==1);
    d=q=0;LimitAudioVector(d,q,-1,true,1,.5f);assert(d==0&&q==-.5f);
    d=q=0;LimitAudioVector(d,q,1,false,1,1.9f);assert(d==.2f&&q==0);
    d=.8f;q=0;LimitAudioVector(d,q,1,true,1,1.9f);assert(d==.2f&&q==1);
  }
  // Genuine concurrent SPSC publication, including many complete wraps.
  {
    PcmRing ring;std::thread producer([&]{for(unsigned i=0;i<100000;i++){uint8_t b[2]={uint8_t(i),uint8_t(i>>8)};while(!ring.pushLittleEndian(b,1))std::this_thread::yield();}});
    for(unsigned i=0;i<100000;i++){int16_t s;while(!ring.pop(s))std::this_thread::yield();assert(uint16_t(s)==uint16_t(i));}
    producer.join();assert(ring.used()==0);
  }
  std::puts("motor_audio: all passed");
}
