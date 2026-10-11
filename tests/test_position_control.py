"""Run the production position reference path with native C++ controllers.

The planner/PID/velocity combination is extracted verbatim from the app. The
plant is an ideal velocity servo with lag, so this validates the outer loop
and configuration semantics, not physical stability of the motor.
"""
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
app = (ROOT / 'Libraries/App/src/control_app.cpp').read_text(encoding='utf-8')
start = app.index('    const float position_fb = FeedbackPosition();', app.index('iq_preclamp ='))
end = app.index('    speed_controller_.setReference', start)
path = app[start:end]
source = r'''
#include "TrajectoryGenerator.hpp"
#include "PositionController.hpp"
#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdio>
constexpr float kControlDtS = 0.001f;
float control_position_velocity_ff_gain = 1.0f;
float control_position_velocity_limit_rad_s = 2.0f;
float Clamp(float v, float lo, float hi) { return std::clamp(v, lo, hi); }
struct OuterLoop {
  control::TrajectoryGenerator trajectory_;
  control::PositionController position_controller_;
  float position = 0, velocity = 0;
  float active_position_ref_rad_ = 0, active_accel_ref_rad_s2_ = 0;
  float active_velocity_ref_rad_s_ = 0;
  float FeedbackPosition() const { return position; }
  OuterLoop() {
    trajectory_.init(2, 4); trajectory_.reset(0);
    position_controller_.init(6, 0, 0, 2, 1);
  }
  float update() {
    const float mech_vel = velocity;
''' + path + r'''
    return active_velocity_ref_rad_s_;
  }
};
bool close(float a, float b, float tol=1e-4f) { return std::fabs(a-b) < tol; }
void follow(control::TrajectoryGenerator &t, float target, int ticks, float acceleration) {
  float last = t.state().velocity_rad_s;
  for (int i=0; i<ticks; ++i) {
    // Deliberately stalled feedback: the reference must still reach target.
    const auto &r=t.update(0, kControlDtS);
    assert(std::isfinite(r.position_rad) && std::isfinite(r.velocity_rad_s));
    assert(std::fabs(r.velocity_rad_s)<=2.0001f);
    assert(std::fabs(r.velocity_rad_s-last)<=acceleration*kControlDtS+1e-6f);
    assert(close(r.acceleration_rad_s2, (r.velocity_rad_s-last)/kControlDtS, 0.001f));
    last=r.velocity_rad_s;
  }
  assert(close(t.state().position_rad, target));
  assert(t.state().velocity_rad_s == 0);
}
int main() {
  control::TrajectoryGenerator t;
  t.init(2, 4); t.setTarget(3); // The first update must preserve a pending target.
  assert(t.update(0, 0).position_rad==0);
  follow(t, 3, 5000, 4);
  t.setTarget(-2); follow(t, -2, 6000, 4);
  t.reset(1000); t.setTarget(1001); follow(t, 1001, 4000, 4);
  t.reset(0); t.setTarget(10);
  for (int i=0; i<500; ++i) t.update(0, kControlDtS);
  const auto before=t.state();
  t.setTarget(before.position_rad-0.01f);
  const auto after=t.update(0, kControlDtS);
  assert(after.velocity_rad_s>0); // Reverse commands brake before reversing.
  assert(close(after.velocity_rad_s, before.velocity_rad_s-0.004f));
  follow(t, before.position_rad-0.01f, 4000, 4);
  t.reset(0); t.setLimits(0.3f, 1); t.setTarget(1);
  follow(t, 1, 6000, 1);

  // Pure PID must track in both directions with no trajectory feedforward.
  control_position_velocity_ff_gain=0;
  OuterLoop pure;
  for (const float target : {3.0f, -2.0f}) {
    pure.trajectory_.setTarget(target);
    float peak_error=0;
    for (int i=0; i<8000; ++i) {
      const float command=pure.update();
      peak_error=std::max(peak_error, std::fabs(pure.active_position_ref_rad_-pure.position));
      pure.velocity += (command-pure.velocity)*0.02f;
      pure.position += pure.velocity*kControlDtS;
    }
    assert(peak_error>0.1f); // Old feedback-reanchoring starved the PID of error.
    assert(close(pure.position,target,0.002f));
  }

  // Exercise the actual application combination at 0, 0.5 and 1.
  OuterLoop zero, half, full;
  for (OuterLoop *o : {&zero,&half,&full}) {
    o->position_controller_.setGains(0,0,0,1);
    o->trajectory_.setTarget(3);
  }
  for (int i=0; i<250; ++i) {
    control_position_velocity_ff_gain=0; assert(zero.update()==0);
    control_position_velocity_ff_gain=0.5f; const float h=half.update();
    control_position_velocity_ff_gain=1; const float f=full.update();
    assert(close(h*2,f)); assert(f>0 && f<=2);
  }
  full.position_controller_.setGains(200,0,0,1);
  assert(full.update()==2); // PID plus FF still obeys POS_VLIM.

  control::PositionController pid;
  pid.init(0,10,0,10,1);
  for(int i=0;i<1000;++i) pid.update(0.2f,0,0,kControlDtS);
  assert(pid.update(0,0,0,kControlDtS)>1);
  pid.setGains(0,0,0,1);
  assert(pid.update(0.2f,0,0,kControlDtS)==0);
  pid.setGains(0,10,0,1);
  assert(pid.update(0,0,0,kControlDtS)==0); // Re-enabling Ki starts cleanly.
  puts("Position reference, pure PID, feedforward and integral reset tests passed");
}
'''
build = ROOT / 'build'
build.mkdir(exist_ok=True)
cpp = build / 'test_position_generated.cpp'
exe = build / 'test_position_generated.exe'
cpp.write_text(source, encoding='utf-8')
subprocess.run(['g++', '-std=c++17', '-Wall', '-Wextra',
                '-I'+str(ROOT / 'Libraries/Control/inc'), str(cpp),
                str(ROOT / 'Libraries/Control/src/trajectory_generator.cpp'),
                str(ROOT / 'Libraries/Control/src/position_controller.cpp'),
                '-o', str(exe)], check=True)
subprocess.run([str(exe)], check=True)
