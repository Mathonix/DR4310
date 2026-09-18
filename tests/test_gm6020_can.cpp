#include "gm6020_can.h"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <limits>
static uint16_t be(const uint8_t *p) { return (p[0]<<8)|p[1]; }
int main() {
  uint8_t data[8]={0x40,0,0xC0,0,0x02,0x22,0x7F,0xFF};float a=0;
  for (uint8_t id=1;id<=7;id++) {
    auto group=id<=4 ? 0x1FE:0x2FE;
    assert(GM6020_DecodeCurrent(id,group,data,8,1,&a));
    float expected[]={3,-3,546*3.0f/16384,3};
    assert(fabsf(a-expected[(id-1)%4])<1e-6f);
    assert(!GM6020_DecodeCurrent(id,group+1,data,8,1,&a));
    assert(!GM6020_DecodeCurrent(id,group^0x300,data,8,1,&a));
  }
  assert(!GM6020_DecodeCurrent(0,0x1FE,data,8,1,&a));
  assert(!GM6020_DecodeCurrent(8,0x2FE,data,8,1,&a));
  assert(!GM6020_DecodeCurrent(2,0x1FE,data,7,1,&a));
  assert(!GM6020_DecodeCurrent(2,0x1FE,data,8,0,&a));
  assert(!GM6020_DecodeCurrent(2,0x1FE,nullptr,8,1,&a));
  data[0]=0x80;data[1]=0;assert(GM6020_DecodeCurrent(1,0x1FE,data,8,1,&a)&&a==-3);
  GM6020_PackFeedback(180,-100,-3,data);
  assert(be(data)==4096 && be(data+2)==(uint16_t)-100 && be(data+4)==(uint16_t)-16384);
  assert(data[6]==255 && data[7]==0);
  GM6020_PackFeedback(360,1e6f,-1e6f,data);
  assert(be(data)==0 && be(data+2)==32767 && be(data+4)==32768);
  GM6020_PackFeedback(-90,NAN,NAN,data);
  assert(be(data)==6144 && be(data+2)==0 && be(data+4)==0);
  GM6020_Session s={};
  assert(GM6020_Accept(&s,0,.1f,1,1)==0); // boot needs zero
  assert(GM6020_Accept(&s,0,0,1,1)==0 && s.ready);
  assert(GM6020_Accept(&s,1,.1f,1,1)==1);
  assert(!GM6020_CheckSession(&s,100,1));
  assert(GM6020_CheckSession(&s,101,1));
  assert(!GM6020_Accept(&s,102,.1f,1,1)); // resumed stream cannot restart
  GM6020_Accept(&s,103,0,1,1);
  assert(GM6020_Accept(&s,104,-.1f,1,1)==1);
  assert(GM6020_CheckSession(&s,105,0)); // STOP/interlock
  assert(!GM6020_Accept(&s,106,.1f,1,1));
  GM6020_Accept(&s,107,0,1,1);
  assert(GM6020_Accept(&s,108,.1f,1,1)==1);
  assert(GM6020_Accept(&s,109,0,1,0)==-1 && s.ready);
  assert(GM6020_Accept(&s,110,.1f,0,1)==0 && !s.ready);
  GM6020_Accept(&s,111,0,1,0);assert(!s.ready); // don't hijack speed mode
  GM6020_Accept(&s,0xfffffff0U,0,1,1);
  GM6020_Accept(&s,0xfffffff0U,.1f,1,1);
  assert(!GM6020_CheckSession(&s,0x53,1));
  assert(GM6020_CheckSession(&s,0x54,1));
  puts("GM6020 wire format and safety session tests passed");
}
