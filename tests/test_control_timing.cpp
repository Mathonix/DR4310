#include "ControlTiming.hpp"
#include "RotorEstimator.hpp"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <initializer_list>
int main() {
  uint32_t last=0; unsigned calls=0;
  // Many main-loop polls and phase-shifted ISR events must not double cadence.
  for (uint32_t us=0; us<=1000000; us+=10)
    if (control::ConsumePeriodicTick(us/1000,last,1)) ++calls;
  assert(calls==1000);
  assert(!control::ConsumePeriodicTick(1000,last,1));
  assert(control::ConsumePeriodicTick(1010,last,1));
  assert(!control::ConsumePeriodicTick(1010,last,1)); // no catch-up burst
  last=0xfffffffeU;
  assert(control::ConsumePeriodicTick(0xffffffffU,last,1));
  assert(control::ConsumePeriodicTick(0,last,1));
  assert(!control::ConsumePeriodicTick(0,last,1));
  assert(!control::ConsumePeriodicTick(1,last,0));

  // Real sample dt avoids half-speed even with 0.5ms or jittered sample gaps.
  for (bool jitter : {false,true}) {
    control::RotorEstimator speed;
    speed.reset(0.0f);
    double angle=0; uint32_t before=0xffff0000U;
    for (int i=0;i<10000;++i) {
      const uint32_t ticks=jitter ? ((i%2)?204000U:136000U) : 85000U;
      const uint32_t next=before+ticks;
      const float dt=float(next-before)/170000000.0f;
      angle+=40.0*dt;
      speed.update(float(std::fmod(angle,6.283185307179586)),dt);
      before=next;
    }
    assert(std::fabs(speed.state().velocity_rad_s-40.0f)<0.01f);
  }
  std::puts("Control timing regression tests passed");
}
