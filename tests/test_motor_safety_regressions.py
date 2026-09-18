"""Host tests of production routines extracted into a mock HAL harness; no hardware access."""
import pathlib
import subprocess
ROOT = pathlib.Path(__file__).resolve().parents[1]
def function(text, signature):
    start = text.index(signature)
    brace = text.index('{', start)
    depth, end = 1, brace + 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end]
hw = (ROOT / 'Libraries/Hardware/src/MT6701.cpp').read_text(encoding='utf-8')
app = (ROOT / 'Libraries/App/src/control_app.cpp').read_text(encoding='utf-8')
timeout = function(hw, 'bool MT6701::timeoutStuckTransfer()')
disable = function(app, 'void ApplicationController::Disable()')
gate = function(app, '  if (!arm_all_ok &&')
source = r'''
#include <cassert>
#include <cstdint>
#include <cstdio>
uint32_t mask=0, clock_cycles=0;
uint32_t __get_PRIMASK() { return mask; }
void __disable_irq() { mask=1; }
void __set_PRIMASK(uint32_t value) { mask=value; }
constexpr int GPIO_PIN_SET=1;
void HAL_GPIO_WritePin(void*, uint16_t, int) { assert(mask==1); }
struct MT6701 {
  static constexpr uint32_t kDmaTimeoutCycles=170000;
  uint8_t transfer_in_flight_=0;
  uint32_t start_timestamp_cycles_=0;
  void* cs_port_=this;
  uint16_t cs_pin_=1;
  struct { uint32_t dma_error_count=0; } health_;
  unsigned resets=0;
  static uint32_t TimestampCycles() { assert(mask==1); return clock_cycles; }
  void ResetSpiToReady() { assert(mask==1); ++resets; }
  bool timeoutStuckTransfer();
};
constexpr uint8_t kModeIdle=0, kModeCurrent=1;
struct ApplicationController {
  uint8_t requested=kModeCurrent,last_control_mode_=kModeCurrent;
  bool armed=true;
  unsigned disables=0;
  void SetMode(uint8_t mode) { requested=mode; }
  void DisarmPowerStage() { armed=false; ++disables; }
  void Disable();
  uint8_t tick(bool arm_all_ok, bool latched=false) {
    uint8_t control_mode=latched?kModeIdle:requested;
''' + gate + r'''
    if (control_mode!=kModeIdle && arm_all_ok) armed=true;
    last_control_mode_=control_mode;
    return control_mode;
  }
};
''' + timeout + '\n' + disable + r'''
int main() {
  MT6701 spi;
  assert(!spi.timeoutStuckTransfer()); assert(mask==0);
  // Old caller time=100 predates ISR start=110; fresh local clock=120 is safe.
  spi.transfer_in_flight_=1; spi.start_timestamp_cycles_=110; clock_cycles=120;
  assert(!spi.timeoutStuckTransfer()); assert(spi.resets==0); assert(mask==0);
  clock_cycles=110+170000;
  assert(spi.timeoutStuckTransfer()); assert(spi.resets==1);
  assert(spi.health_.dma_error_count==1); assert(!spi.transfer_in_flight_);
  assert(mask==0);
  mask=1; assert(!spi.timeoutStuckTransfer()); assert(mask==1); mask=0;
  spi.transfer_in_flight_=1; spi.start_timestamp_cycles_=0xfffffff0U;
  clock_cycles=0x20U;
  assert(!spi.timeoutStuckTransfer()); assert(mask==0);
  clock_cycles=spi.start_timestamp_cycles_+170000U;
  assert(spi.timeoutStuckTransfer()); assert(mask==0);

  ApplicationController motor;
  assert(motor.tick(true)==kModeCurrent);
  assert(motor.tick(false)==kModeIdle);
  assert(!motor.armed && motor.requested==kModeIdle);
  assert(motor.tick(true)==kModeIdle); assert(!motor.armed);
  motor.SetMode(kModeCurrent);
  assert(motor.tick(true)==kModeCurrent); assert(motor.armed);
  assert(motor.tick(false,true)==kModeIdle);
  assert(motor.requested==kModeIdle && !motor.armed);
  assert(motor.tick(true)==kModeIdle);
  motor.SetMode(kModeCurrent); motor.armed=true;
  motor.Disable(); assert(!motor.armed && motor.requested==kModeIdle);
  motor.SetMode(kModeCurrent);motor.last_control_mode_=kModeIdle;
  assert(motor.tick(false)==kModeIdle);assert(motor.requested==kModeIdle);
  puts("Motor interlock and DMA timeout regression tests passed");
}
'''
build=ROOT / 'build'
build.mkdir(exist_ok=True)
cpp=build / 'test_motor_safety_generated.cpp'
cpp.write_text(source, encoding='utf-8')
exe=build / 'test_motor_safety_generated.exe'
subprocess.run(['g++','-std=c++17','-Wall','-Wextra',str(cpp),'-o',str(exe)],check=True)
subprocess.run([str(exe)],check=True)
