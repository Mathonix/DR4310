"""Compile the actual COG UART handler against RAM/flash stubs, with no hardware."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
app = (ROOT / 'Libraries/App/src/control_app.cpp').read_text(encoding='utf-8')
start = app.index('void ApplicationController::ExecuteCoggingCommand(')
end = app.index('void ApplicationController::ExecuteAudioCommand(', start)
handler = app[start:end]
config_test = (ROOT / 'tests/test_uart_config.c').read_text(encoding='utf-8')
stubs = config_test[:config_test.index('int main(void)')]
source = r'''
#include "device_config.h"
#include "ascii_util.h"
#include "control_app.h"
#include "CoggingCompensator.hpp"
#include <string>
#include <cstring>
#include <cmath>
#include <cassert>
#include <cstdio>
#include <vector>
uint8_t g_active_pole_pairs_u8 = 14;
struct ApplicationController {
  bool idle = true;
  std::string reply;
  bool IsMotorIdle() const { return idle; }
  void ReplyOk(const char *, const char *detail = nullptr) {
    reply = "OK "; if (detail) reply += detail;
  }
  void ReplyErr(const char *, const char *detail) { reply = std::string("ERR ") + detail; }
  void ExecuteCoggingCommand(char **tok, size_t n);
  void send(std::string line) {
    std::vector<char> buffer(line.begin(), line.end()); buffer.push_back(0);
    Ascii_Upper(buffer.data()); char *tokens[20] = {};
    const size_t n = Ascii_Tokenize(buffer.data(), tokens, 20);
    ExecuteCoggingCommand(tokens, n);
  }
};
''' + handler + r'''
int main() {
  DeviceConfig_Init();
  ApplicationController app;
  app.idle = false;
  app.send("COG BEGIN"); assert(app.reply == "ERR not_idle");
  assert(!DeviceConfig_CoggingUploading());
  app.send("COG INFO"); assert(app.reply.find("valid=0") != std::string::npos);
  app.idle = true;
  app.send("cog begin"); assert(DeviceConfig_CoggingUploading());
  app.send("COG COMMIT"); assert(app.reply == "ERR incomplete");
  app.send("COG SET 0 2.5"); assert(app.reply == "ERR sample_range");
  app.send("COG SET 0 NAN"); assert(app.reply == "ERR sample_range");
  app.send("COG SET -1 5"); assert(app.reply == "ERR index");
  app.send("COG SET 511 5 5"); assert(app.reply == "ERR upload_range");
  app.send("COG SET 0 1001"); assert(app.reply == "ERR sample_range");
  app.send("COG GET 512"); assert(app.reply == "ERR index");
  assert(DeviceConfig_CoggingWritten() == 0);
  for (unsigned index = 0; index < 512; index += 16) {
    std::string line = "COG SET " + std::to_string(index);
    for (int j = 0; j < 16; ++j) line += (j % 2 == 0 ? " 100" : " -100");
    app.send(line); assert(app.reply.substr(0, 3) == "OK ");
  }
  app.send("COG COMMIT"); assert(app.reply.find("enabled=0 saved=0") != std::string::npos);
  app.send("COG INFO"); assert(app.reply.find("valid=1") != std::string::npos);
  assert(app.reply.find("match=1") != std::string::npos);
  assert(app.reply.find("crc=0x") != std::string::npos);
  assert(app.reply.find("crc=0x012C15B1") != std::string::npos);
  app.send("COG GET 511"); assert(app.reply == "OK index=511 ma=-100");
  app.idle = false;
  app.send("COG CLEAR"); assert(app.reply == "ERR not_idle");
  assert(DeviceConfig_Live()->cogging.valid);
  app.idle = true; app.send("COG ABORT");
  assert(!DeviceConfig_Live()->cogging.valid && DeviceConfig_Live()->cog_en == 0);
  puts("production COG UART parser and upload/idle interlocks passed");
}
'''
build = ROOT / 'build/cogging-uart-test'
build.mkdir(parents=True, exist_ok=True)
(build / 'handler.cpp').write_text(source, encoding='utf-8')
(build / 'stubs.c').write_text(stubs, encoding='utf-8')
includes = ['-I'+str(ROOT / p) for p in ('tests/stubs', 'Libraries/App/inc', 'Libraries/Control/inc')]
objects = []
for p in [build / 'stubs.c'] + [ROOT / 'Libraries/App/src' / name for name in ('device_config.c', 'store_record.c', 'ascii_util.c')]:
    obj = build / (p.stem + '.o')
    subprocess.run(['gcc', '-std=c11', '-DMOTOR_CAN_ID=1', *includes, '-c', str(p), '-o', str(obj)], check=True)
    objects.append(str(obj))
exe = build / 'test.exe'
subprocess.run(['g++', '-std=c++17', '-Wall', '-Wextra', *includes, str(build / 'handler.cpp'),
                str(ROOT / 'Libraries/Control/src/cogging_compensator.cpp'), *objects, '-o', str(exe)], check=True)
subprocess.run([str(exe)], check=True)
