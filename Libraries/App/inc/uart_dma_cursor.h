#ifndef UART_DMA_CURSOR_H
#define UART_DMA_CURSOR_H
#include <cstdint>
namespace audio {
/* HT/TC count + current NDTR, not a modulo-only polling cursor. IRQs must
 * execute within a half-buffer wire time (44.4 ms at 230400). A delayed-main
 * observation >= a full wire time is conservatively treated as ambiguous. */
class DmaCursor {
 public:
  static constexpr uint32_t Capacity=2048, Half=1024;
  static uint32_t produced(uint32_t halves,uint32_t ndtr) {
    const uint32_t position=(Capacity-ndtr)&(Capacity-1);
    if((halves&1)!=(position/Half))++halves; // one boundary pending in NVIC
    return halves*Half+(position&(Half-1));
  }
  void reset(uint32_t write,uint32_t now){read_=write;last_ms_=now;}
  bool observe(uint32_t write,uint32_t now) {
    const uint32_t distance=write-read_,gap=now-last_ms_;
    const bool overflow=distance>Capacity,late=gap>=88;
    const bool loss=overflow || late;
    last_ms_=now;
    if(loss){last_distance_=distance;last_gap_ms_=gap;if(overflow)++overwrites_;if(late)++late_;read_=write;++overruns_;return false;}
    return true;
  }
  bool pop(const volatile uint8_t *data,uint32_t write,uint8_t &out) {
    if(read_==write)return false;
    out=data[read_&(Capacity-1)];++read_;return true;
  }
  uint32_t overruns() const{return overruns_;}
  uint32_t overwrites() const{return overwrites_;}
  uint32_t late() const{return late_;}
  uint32_t lastDistance() const{return last_distance_;}
  uint32_t lastGapMs() const{return last_gap_ms_;}
 private:uint32_t read_=0,last_ms_=0,overruns_=0,overwrites_=0,late_=0,last_distance_=0,last_gap_ms_=0;
};
}
#endif
