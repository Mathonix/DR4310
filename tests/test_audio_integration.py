"""Compile production UART/FOC function bodies with peripheral-only mocks."""
from pathlib import Path
import re,subprocess,tempfile,unittest
ROOT=Path(__file__).resolve().parents[1]
APP=(ROOT/'Libraries/App/src/control_app.cpp').read_text(encoding='utf-8')
FOC=(ROOT/'Libraries/Control/src/foc_control.cpp').read_text(encoding='utf-8')
def function(source,name):
    start=source.index(name);brace=source.index('{',start);depth=0
    for i in range(brace,len(source)):
        if source[i]=='{':depth+=1
        if source[i]=='}':
            depth-=1
            if depth==0:return source[start:i+1]
    raise ValueError(name)
def compile_run(code,low_tx=0):
    with tempfile.TemporaryDirectory() as d:
        cpp=Path(d)/'integration.cpp';exe=Path(d)/'integration.exe';cpp.write_text(code,encoding='utf-8')
        subprocess.run(['g++','-std=c++17','-O2','-Wall','-Wextra',f'-DAUDIO_LOW_TX_MODE={low_tx}','-Itests/stubs','-ILibraries/App/inc','-ILibraries/Control/inc',str(cpp),'Libraries/App/src/motor_audio.cpp','Libraries/Control/src/audio_current.cpp','Libraries/App/src/ascii_util.c','Libraries/Control/src/cogging_compensator.cpp','-o',str(exe)],cwd=ROOT,check=True)
        subprocess.run([str(exe)],check=True)
COMMON=r'''
#include "motor_audio.h"
#include "uart_dma_cursor.h"
#include "ascii_util.h"
#include "CoggingCompensator.hpp"
#include <array>
#include <vector>
#include <string>
#include <cassert>
#include <cmath>
#include <cstring>
#include <algorithm>
#include <cstdio>
'''
class ProductionIntegration(unittest.TestCase):
    def test_real_uart_error_restart_preserves_rx_epoch_and_stops_audio(self):
        receiver='\n'.join(function(APP,n) for n in ['uint32_t UartRxWriteTotal()', 'bool VofaRxPop(uint8_t &byte)', 'void VofaStartReceive(UART_HandleTypeDef *uart)'])
        callback=function(APP,'extern "C" void HAL_UART_ErrorCallback(UART_HandleTypeDef *huart)')
        code=COMMON+r'''
struct DMA_HandleTypeDef{uint32_t ndtr=2048;};
struct UART_HandleTypeDef{DMA_HandleTypeDef *hdmarx;uint32_t ErrorCode=0;};
static uint32_t irq_mask=0,now=0;static int starts=0,clears=0,flushes=0,disabled=0,result=0;
constexpr int HAL_OK=0,DRV_ENABLE_GPIO_Port=0,DRV_ENABLE_Pin=0,GPIO_PIN_RESET=0;
constexpr uint32_t HAL_UART_ERROR_NE=2,HAL_UART_ERROR_FE=4;
constexpr uint32_t UART_CLEAR_PEF=1,UART_CLEAR_FEF=2,UART_CLEAR_NEF=4,UART_CLEAR_OREF=8,UART_RXDATA_FLUSH_REQUEST=1;
uint32_t __get_PRIMASK(){return irq_mask;}void __disable_irq(){irq_mask=1;}void __set_PRIMASK(uint32_t m){irq_mask=m;}
uint32_t HAL_GetTick(){return now;}
#define __HAL_DMA_GET_COUNTER(dma) ((dma)->ndtr)
#define __HAL_UART_CLEAR_FLAG(uart,bits) do{assert(irq_mask&&(bits)==15);++clears;}while(0)
#define __HAL_UART_SEND_REQ(uart,req) do{assert(irq_mask&&(req)==1);++flushes;}while(0)
int HAL_UART_Receive_DMA(UART_HandleTypeDef *uart,uint8_t*,size_t size){assert(irq_mask&&size==2048);++starts;uart->hdmarx->ndtr=2048;return result;}
void HAL_GPIO_WritePin(int,int,int){++disabled;}
namespace app{
UART_HandleTypeDef *g_vofa_uart=nullptr;
std::array<uint8_t,2048> g_uart_rx_dma{};
volatile uint32_t g_uart_rx_halves=0,g_uart_rx_errors=0,g_uart_rx_hw_errors=0,g_uart_rx_last_hw_error=0;
volatile uint8_t g_uart_rx_ready=0;audio::DmaCursor g_uart_rx_cursor;
'''+receiver+'\n}\n'+callback+r'''
int main(){
 DMA_HandleTypeDef dma;UART_HandleTypeDef uart{&dma,6};app::g_vofa_uart=&uart;
 app::g_uart_rx_ready=1;app::g_uart_rx_halves=8;app::g_uart_rx_cursor.reset(8190,0);
 audio::Global().init(nullptr,nullptr);assert(audio::Global().open(audio::Axis::Q,20,0));
 HAL_UART_ErrorCallback(&uart);
 assert(!app::g_uart_rx_ready&&starts==0&&disabled==(audio::kLowTxMode?0:1));
 assert(audio::Global().gate()==audio::kLowTxMode);
 assert(app::g_uart_rx_hw_errors==1&&app::g_uart_rx_last_hw_error==6&&app::g_uart_rx_errors==2);
 uint8_t byte;assert(!app::VofaRxPop(byte)&&app::g_uart_rx_cursor.overruns()==0);
 app::g_uart_rx_errors=0;app::VofaStartReceive(&uart);
 assert(app::g_uart_rx_ready&&starts==1&&clears==1&&flushes==1&&app::g_uart_rx_halves==0&&irq_mask==0);
 app::g_uart_rx_dma[0]=77;dma.ndtr=2047;assert(app::VofaRxPop(byte)&&byte==77);
 assert(app::g_uart_rx_cursor.overwrites()==0&&app::g_uart_rx_cursor.lastDistance()==0);
 HAL_UART_ErrorCallback(&uart);result=1;app::g_uart_rx_errors=0;app::VofaStartReceive(&uart);
 assert(!app::g_uart_rx_ready&&app::g_uart_rx_errors==2&&!app::VofaRxPop(byte)&&irq_mask==0);
 result=0;app::g_uart_rx_errors=0;app::VofaStartReceive(&uart);assert(app::g_uart_rx_ready&&!app::VofaRxPop(byte));
 uart.ErrorCode=8;HAL_UART_ErrorCallback(&uart); // ORE is always fatal
 assert(app::g_uart_rx_cursor.overruns()==0&&audio::Global().status().state==audio::State::Halted&&!audio::Global().gate());
 for(uint32_t error:{1U,16U}){uart.ErrorCode=error;const int count=disabled;HAL_UART_ErrorCallback(&uart);assert(disabled==count+1&&!audio::Global().gate());}
 std::puts("production UART error ISR / deferred DMA restart / cursor epoch / failure retry passed");
}
'''
        for low_tx in (0,1):
            compile_run(code,low_tx)

    def test_can_emergency_stop_bypasses_auto_enable_during_audio(self):
        main=(ROOT/'Core/Src/main.c').read_text(encoding='utf-8')
        defines='\n'.join(re.findall(r'^#define\s+CAN_\w+\b.*$',main,re.M))
        handler=function(main,'static void CAN_ApplyControlFrame(uint32_t id, const uint8_t *data)\n{')
        code=COMMON+'\n#include "control_app.h"\n'+defines+r'''
constexpr float IQ_HARD_MAX_A=3.5f;
uint8_t can_node_id=2,can_control_last_cmd=0,can_control_mode=0;
uint32_t can_control_rx_count=0;float can_control_target=0;
volatile float control_current_pi_kp=0,control_current_pi_ki=0,control_current_pi_out_limit_v=0;
volatile float control_position_kp=0,control_position_ki=0,control_position_kd=0,control_position_i_sep_rad=0;
volatile float control_mit_kp=0,control_mit_kd=0;
static uint8_t ae=0,active=0;static unsigned disabled=0;
void ControlApp_NotifyHostActivity(){}
uint8_t ControlApp_GetAutoEnable(){return ae;}
uint8_t ControlApp_AudioActive(){return active;}
void ControlApp_SetAutoEnable(uint8_t value){ae=value;}
void ControlApp_Disable(){++disabled;}
void ControlApp_SetMode(uint8_t){}
void ControlApp_SetCurrentRef(float){}
uint8_t ControlApp_PositionEncoderReady(){return 1;}
void ControlApp_SetMitCommand(float,float,float,float,float){}
static void CAN_UnpackMit(const uint8_t*,float*,float*,float*,float*,float*){}
'''+handler+r'''
int main(){
  for(uint8_t command:{uint8_t(CAN_CMD_DISABLE),uint8_t(CAN_CMD_ESTOP)}){
    uint8_t frame[8]={command};ae=1;active=0;disabled=0;can_control_mode=CAN_MODE_CURRENT;
    CAN_ApplyControlFrame(CAN_CONTROL_BASE_ID+2,frame);assert(disabled==0);
    active=1;CAN_ApplyControlFrame(CAN_CONTROL_BASE_ID+2,frame);assert(disabled==1&&can_control_mode==CAN_MODE_DISABLED);
    can_control_mode=CAN_MODE_MIT;CAN_ApplyControlFrame(CAN_CONTROL_BASE_ID+2,frame);assert(disabled==2&&can_control_mode==CAN_MODE_DISABLED);
    ae=0;active=0;CAN_ApplyControlFrame(CAN_CONTROL_BASE_ID+2,frame);assert(disabled==3);
    CAN_ApplyControlFrame(CAN_CONTROL_BASE_ID+3,frame);assert(disabled==3);
  }
  std::puts("production CAN STOP/ESTOP audio AE bypass and legacy policy passed");
}
'''
        compile_run(code)
    def test_uart_dma_mode_ownership_open_exit_and_external_control(self):
        functions='\n'.join(function(APP,'void ApplicationController::'+n) for n in ['ExecuteAudioCommand','ProcessVofaCommands','Disable','StopAudioMotion','BeforeExternalAudioCommand','SetCurrentRef','SetSpeedRef'])
        code=COMMON+r'''
constexpr unsigned kVofaCommandMaxBytes=192,kUartTxQueueBytes=1024,kModeIdle=0,kModeCurrent=1;
constexpr float IQ_HARD_MAX_A=3.5f;
uint32_t now_ms=0;uint32_t HAL_GetTick(){return now_ms;}
uint32_t __get_PRIMASK(){return 0;}void __disable_irq(){}void __set_PRIMASK(uint32_t){}
uint32_t control_mode_cmd=1,control_auto_enable=0,control_align_enable=0,control_ident_enable=0,control_calibrate_enable=0;
uint8_t calibration_flash_valid=1;
float control_current_test_iq_ref_a=0,control_iq_limit_a=1.9f,control_velocity_ref_rad_s=0;
struct Config{bool telemetry=false;}config;
const Config* DeviceConfig_Live(){return &config;}bool DeviceConfig_CoggingUploading(){return false;}
std::array<uint8_t,2048> dma{};audio::DmaCursor cursor;
auto &g_uart_rx_cursor=cursor;
bool g_uart_rx_ready=true,g_audio_exit_draining=false,tx_busy=false;
uint32_t g_uart_rx_errors=0,write_total=0;
std::vector<uint8_t> tx;
uint32_t UartRxWriteTotal(){return write_total;}
void VofaStartReceive(void*){g_uart_rx_ready=true;}
bool VofaRxPop(uint8_t &b){if(!cursor.observe(write_total,now_ms)){g_uart_rx_errors=1;audio::Global().abortSafety(audio::Reason::ProtocolError);return false;}return cursor.pop(dma.data(),write_total,b);}
bool UartTxIdle(){return !tx_busy;}
bool UartTxEnqueue(const uint8_t *p,size_t n,size_t){tx.insert(tx.end(),p,p+n);return true;}
bool sink(const uint8_t *p,size_t n,void*){return UartTxEnqueue(p,n,1023);}
struct FocFake{struct S{float iq_ref_a=0,id_a=0,iq_a=0;bool enabled=true,open_loop_voltage_enable=false;}s;const S&GetState(){return s;}};
struct FaultFake{bool fault=false;bool hasLatchedFault(){return fault;}};
struct ApplicationController{
  FocFake foc_;FaultFake fault_manager_;struct{unsigned control_mode=1;}telemetry_;
  bool audio_internal_stop_=false,arm_all_ok_=true,encoder_valid_=true,drv=true,reboot_pending_=false;
  int get_stream_index_=-1,ascii_commands=0;void*debug_uart_=nullptr;
  std::array<char,192>vofa_command_line_{};unsigned vofa_command_length_=0,vofa_line_overflow_=0;
  std::string reply;
  static float Clamp(float v,float a,float b){return std::clamp(v,a,b);}
  bool CurrentSampleFresh() const{return true;}
  void ReplyErr(const char*cmd,const char*r){reply=std::string("@ERR ")+cmd+" "+r;}
  void NotifyHostActivity(){}
  void DisarmPowerStage(){drv=false;foc_.s.enabled=false;}
  void SetMode(uint8_t mode){BeforeExternalAudioCommand();control_mode_cmd=mode;}
  void ExecuteVofaCommand(char *line){Ascii_Upper(line);char *tokens[20];auto n=Ascii_Tokenize(line,tokens,20);if(n&&std::strcmp(tokens[0],"AUDIO")==0)ExecuteAudioCommand(tokens,n);else ++ascii_commands;}
  void ExecuteAudioCommand(char**,size_t);void ProcessVofaCommands();void Disable();void StopAudioMotion();void BeforeExternalAudioCommand();void SetCurrentRef(float);void SetSpeedRef(float);
};
'''+functions+r'''
void bytes(const uint8_t *p,size_t n){for(size_t i=0;i<n;i++)dma[(write_total++)&2047]=p[i];}
void ascii(ApplicationController &a,const char *s){bytes(reinterpret_cast<const uint8_t*>(s),strlen(s));a.ProcessVofaCommands();}
void setup(ApplicationController &a){audio::Global().init(sink,nullptr);cursor.reset(0,now_ms);write_total=0;g_uart_rx_errors=0;g_audio_exit_draining=false;control_mode_cmd=1;control_auto_enable=0;control_current_test_iq_ref_a=0;config.telemetry=false;a=ApplicationController{};tx.clear();}
int main(){
  ApplicationController a;setup(a);
  for(const char *s:{"AUDIO OPEN Q 2001\n","AUDIO OPEN Q 1000000000000000000\n"}){ascii(a,s);assert(a.reply=="@ERR AUDIO bad_arg"&&!audio::Global().binary());}
  control_iq_limit_a=.5f;ascii(a,"AUDIO OPEN Q 1000\n");assert(a.reply=="@ERR AUDIO safety"&&!audio::Global().binary());control_iq_limit_a=1.9f;
  for(const char *s:{"AUDIO OPEN Q 0\n","AUDIO OPEN D 1501\n","AUDIO OPEN Q 20.0\n","AUDIO OPEN Q -1\n","AUDIO OPEN X 20\n","AUDIO OPEN Q 20 EXTRA\n"}){ascii(a,s);assert(a.reply=="@ERR AUDIO bad_arg"&&!audio::Global().binary());}
  control_mode_cmd=2;ascii(a,"AUDIO OPEN Q 20\n");assert(a.reply=="@ERR AUDIO bad_state");control_mode_cmd=1;
  a.fault_manager_.fault=true;ascii(a,"AUDIO OPEN Q 20\n");assert(a.reply=="@ERR AUDIO fault");a.fault_manager_.fault=false;
  a.arm_all_ok_=false;ascii(a,"AUDIO OPEN Q 20\n");assert(a.reply=="@ERR AUDIO not_ready");a.arm_all_ok_=true;
  config.telemetry=true;ascii(a,"AUDIO OPEN Q 20\n");assert(a.reply=="@ERR AUDIO safety");config.telemetry=false;
  tx_busy=true;ascii(a,"AUDIO OPEN Q 20\n");assert(a.reply=="@ERR AUDIO busy");tx_busy=false;
  ascii(a,"audio open q 20\n");assert(audio::Global().binary());
  const auto sid=audio::Global().status().state;assert(sid==audio::State::Buffering);
  std::string ok(tx.begin(),tx.end());assert(ok.find("@OK AUDIO OPEN v=1 sid=")==0&&ok.find("cap=2048 guard=128 prefill=800 window=6\n")!=std::string::npos);
  // PCM contains printable commands and delimiters. Split input randomly and
  // across the physical DMA wrap; none may reach the ASCII command dispatcher.
  uint8_t payload[320],frame[334];for(unsigned i=0;i<320;i++)payload[i]="IQ 1\n\r@\xa5\x5a"[i%9];
  for(unsigned seq=0;seq<3;seq++){auto n=audio::EncodeFrame(frame,audio::Type::Data,1,seq,payload,320);bytes(frame,n);}
  a.ProcessVofaCommands();assert(audio::Global().status().ack_next_seq==3);
  for(unsigned seq=3;seq<9;seq++){
    auto n=audio::EncodeFrame(frame,audio::Type::Data,1,seq,payload,320);
    for(size_t i=0;i<n;){size_t c=std::min(size_t(1+(i*7)%43),n-i);bytes(frame+i,c);a.ProcessVofaCommands();i+=c;}
  }
  assert(a.ascii_commands==0&&audio::Global().status().ack_next_seq==9);
  auto n=audio::EncodeFrame(frame,audio::Type::Exit,1,0,nullptr,0);bytes(frame,n);bytes(reinterpret_cast<const uint8_t *>("IQ 1\n"),5);a.ProcessVofaCommands();
  assert(!audio::Global().binary()&&g_audio_exit_draining&&a.ascii_commands==0&&!a.drv);
  tx_busy=true;a.ProcessVofaCommands();tx_busy=false;a.ProcessVofaCommands();ascii(a,"PING\n");assert(a.ascii_commands==1);
  // Retransmitted EXIT re-ACKs the last sid even after ASCII restoration;
  // an old DATA carrying printable commands is discarded in ASCII mode.
  now_ms=30;bytes(frame,n);a.ProcessVofaCommands();assert(a.ascii_commands==1);
  n=audio::EncodeFrame(frame,audio::Type::Data,1,10,payload,320);bytes(frame,n);a.ProcessVofaCommands();assert(a.ascii_commands==1);
  setup(a);ascii(a,"AUDIO OPEN D 20\n");assert(audio::Global().binary());
  a.SetMode(1);a.SetCurrentRef(.1f);assert(!audio::Global().gate()&&!a.drv&&control_mode_cmd==1&&control_current_test_iq_ref_a==.1f);
  control_auto_enable=1;a.Disable();assert(control_auto_enable==0&&!a.drv);
  setup(a);ascii(a,"AUDIO OPEN Q 20\n");std::array<uint8_t,2049>overflow{};bytes(overflow.data(),overflow.size());a.ProcessVofaCommands();a.ProcessVofaCommands();assert(!audio::Global().gate()&&!a.drv&&audio::Global().status().state==audio::State::Halted);
  setup(a);control_iq_limit_a=1.9f;ascii(a,"AUDIO OPEN Q 2000\n");assert(a.reply=="@ERR AUDIO safety"&&!audio::Global().binary());
  setup(a);control_iq_limit_a=2.0f;ascii(a,"AUDIO OPEN Q 2000\n");assert(audio::Global().binary()&&audio::Global().amplitudeA()==2.0f);
  setup(a);control_iq_limit_a=1.5f;ascii(a,"AUDIO OPEN D 1500\n");assert(audio::Global().binary()&&audio::Global().amplitudeA()==1.5f);
  std::puts("production UART OPEN / DMA split / binary ownership / EXIT / external control passed");
}
'''
        compile_run(code)

    def test_real_foc_body_d_q_limits_fault_and_legacy_refs(self):
        h=(ROOT/'Libraries/Control/inc/FOCController.hpp').read_text(encoding='utf-8')
        state=h[h.index('struct FOCState'):h.index('class FocController')]
        methods='\n'.join(function(FOC,'void FocController::'+name) for name in ['OnPwmUpdate','Enable','TripOvercurrent'])
        code=COMMON+r'''
constexpr int HAL_OK=0;
namespace hardware {struct CurrentSample{float ia_a=0,ib_a=0,ic_a=0,bus_v=12.4f;};}
namespace control {
constexpr float kFocDtS=.00005f,kOvercurrentTripA=3.5f,kSqrt3=1.7320508f;
constexpr bool kSwapDq=false;constexpr unsigned kVmaxUpdateDivider=20;
'''+state+r'''
struct FakeSense {hardware::CurrentSample sample;int status=HAL_OK;int getLatest(hardware::CurrentSample &out){out=sample;return status;}};
struct CurrentLoopVoltage{float vd_v,vq_v;};
struct FakeLoop{float id=0,iq=0;void reset(){}void setOutputLimits(float,float){}void applySaturationFeedback(float,float,float){}CurrentLoopVoltage update(float d,float q,float,float,float){id=d;iq=q;return {d,q};}};
struct FocController {
  FakeLoop current_loop_;FOCState state_;hardware::CurrentSample last_current_;
  struct{float ld_h=0,lq_h=0,flux_wb=0;}motor_;
  struct{void sinCos(float,float &s,float &c){s=0;c=1;}}cordic_;
  int timer=1,*pwm_timer_=&timer;FakeSense sense;FakeSense *current_sense_=&sense;
  bool isr_busy_=false;unsigned vmax_div_=0;uint8_t angle_direct_enable_=0;
  float iq_command_a_=0,iq_limit_=1,min_bus_v_=6,cached_vmax_=10;
  static float Wrap0To2Pi(float a){return a;}
  float VoltageLimit(float bus){return bus;}
  void WritePwm(float a,float b,float c){state_.duty_a=a;state_.duty_b=b;state_.duty_c=c;}
  void ApplyModulationSc(float,float,float,float,float){}
  void LimitVoltageCircle(float&,float&,float){}
  void OnPwmUpdate();void Enable(uint8_t);void TripOvercurrent();
};
'''+methods+r'''
}
void open(audio::Axis axis){auto &a=audio::Global();a.init(nullptr,nullptr);auto sid=a.open(axis,20,0);uint8_t payload[320],frame[334];for(unsigned i=0;i<160;i++){int16_t s=(i&1)?-32768:32767;payload[2*i]=uint8_t(s);payload[2*i+1]=uint8_t(uint16_t(s)>>8);}for(unsigned j=0;j<5;j++){auto n=audio::EncodeFrame(frame,audio::Type::Data,sid,j,payload,320);for(unsigned i=0;i<n;i++)a.receive(frame[i],0);}}
int main(){
  for(auto axis:{audio::Axis::Q,audio::Axis::D}){
    open(axis);control::FocController f;f.state_.enabled=1;f.iq_command_a_=.001f;f.iq_limit_=.01f;
    for(unsigned i=0;i<500;i++){
      f.OnPwmUpdate();assert(f.state_.id_ref_a==0&&f.state_.iq_ref_a==.001f);
      assert(std::hypot(f.current_loop_.id,f.current_loop_.iq)<=.010001f);
      if(axis==audio::Axis::Q)assert(f.current_loop_.id==0);
      else assert(std::fabs(f.current_loop_.id)<=.01f);
    }
    audio::Global().abortSafety(audio::Reason::Cancelled);f.OnPwmUpdate();assert(f.state_.audio_cmd_a==0&&!f.state_.enabled);
  }
  open(audio::Axis::D);control::FocController f;f.state_.enabled=1;f.sense.sample.ia_a=3.6f;f.OnPwmUpdate();assert(!audio::Global().gate()&&!f.state_.enabled&&f.state_.overcurrent_trip_count==1);
  open(audio::Axis::Q);control::FocController low;low.state_.enabled=1;low.sense.sample.bus_v=5;low.OnPwmUpdate();assert(!audio::Global().gate()&&!low.state_.enabled);
  audio::Global().init(nullptr,nullptr);control::FocController legacy;legacy.state_.enabled=1;legacy.iq_command_a_=.3f;legacy.state_.cogging_iq_a=.05f;legacy.OnPwmUpdate();assert(std::fabs(legacy.current_loop_.iq-.35f)<1e-6f&&legacy.current_loop_.id==0);
  std::puts("production FOC D/Q routing / vector cap / STOP / overcurrent / undervoltage / cogging passed");
}
'''
        compile_run(code)
if __name__=='__main__':unittest.main()
