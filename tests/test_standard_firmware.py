"""Compile the real disabled AUDIO command without linking any audio sources."""
from pathlib import Path
import subprocess
import tempfile
import unittest
def function(source, signature):
    start = source.index(signature)
    brace = source.index('{', start)
    depth = 0
    for index in range(brace, len(source)):
        depth += (source[index] == '{') - (source[index] == '}')
        if depth == 0:
            return source[start:index+1]
    raise ValueError(signature)

ROOT = Path(__file__).resolve().parents[1]

class StandardFirmware(unittest.TestCase):
    def test_disabled_audio_cannot_enter_a_session(self):
        app = (ROOT / 'Libraries/App/src/control_app.cpp').read_text(encoding='utf-8')
        handler = function(app, 'void ApplicationController::ExecuteAudioCommand')
        source = r'''
#include "motor_audio.h"
#include <cassert>
#include <string>
struct ApplicationController {
  std::string reply;
  void ReplyErr(const char *command,const char *reason) { reply=std::string(command)+":"+reason; }
  void ExecuteAudioCommand(char **tokens,size_t count);
};
''' + handler + r'''
int main() {
  static_assert(sizeof(audio::MotorAudio)==1,"Standard build must not allocate PCM storage");
  static_assert(!audio::kDisabledAudio.binary() && !audio::kDisabledAudio.gate());
  ApplicationController controller;
  char cmd[]="AUDIO",verb[]="OPEN",axis[]="Q",amp[]="2000";
  char *tokens[]={cmd,verb,axis,amp};
  controller.ExecuteAudioCommand(tokens,4);assert(controller.reply=="AUDIO:disabled");
  controller.ExecuteAudioCommand(nullptr,0);assert(controller.reply=="AUDIO:disabled");
  auto &disabled=audio::Global();disabled.init(nullptr,nullptr);
  disabled.receive(0xa5,0);disabled.service(1,true,0);disabled.abortSafety(audio::Reason::SafetyFault);
  assert(!disabled.binary()&&!disabled.gate()&&!disabled.takeStopRequest());
  assert(disabled.status().state==audio::State::Exited && disabled.amplitudeA()==0);
}
'''
        with tempfile.TemporaryDirectory() as folder:
            cpp=Path(folder)/'disabled.cpp';exe=Path(folder)/'disabled.exe'
            cpp.write_text(source,encoding='utf-8')
            subprocess.run(['g++','-std=c++17','-O2','-Wall','-Wextra','-DDR4310_AUDIO_ENABLED=0',
                            '-ILibraries/App/inc','-ILibraries/Control/inc',str(cpp),'-o',str(exe)],cwd=ROOT,check=True)
            subprocess.run([str(exe)],check=True)

if __name__=='__main__':unittest.main()
