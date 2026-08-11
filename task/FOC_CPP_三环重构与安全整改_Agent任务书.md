# STM32G431 FOC 三环控制工程：C++ 重构与安全整改任务书

> 目标工程：STM32G431 + DRV8313 + INA240A2 + 10mΩ 低侧采样 + MT6701 + 20kHz FOC + 1kHz 外环
>
> 最终目标：做成**可靠、可调、可长期运行的电流环 / 速度环 / 位置环级联伺服**，而不是仅仅“能转起来”。
>
> 本任务基于当前工程源码制定。请先完整阅读工程，再按本文优先级逐项修改。**不要一次性大改后才编译；每完成一个阶段都必须重新构建并检查行为。**

---

## 0. 总原则

本轮修改同时解决两类问题：

1. **控制架构问题**：把现有“位置 PID 写在 App、速度估计和速度 PI 混在 MotionController、FOC 内部自行限幅”的结构整理成清晰的三环级联架构。
2. **安全问题**：当前板上曾发生电机失控后 INA240 采样异常，因此任何电流采样异常、编码器异常、驱动故障、母线异常都必须在使能功率级之前被拦截，并且运行中出现严重故障必须立即关断并锁存。

不要为了 C++ 而 C++：

- 有状态模块用 `class`。
- 无状态数学模块用 `namespace` / 普通函数。
- HAL / CMSIS / CubeMX 继续保持 C。
- C/C++ 边界只保留非常薄的 `extern "C"` 桥。
- 不使用动态内存、异常、RTTI。
- 不在高频控制路径使用阻塞 IO、`printf`、锁、动态分配。
- 不擅自改变电流极性、电角度方向、相序、电气零位等已经通过实验确定的板级参数。

---

# 1. 当前源码中必须优先解决的问题

## P0-1：禁止“错误电流零点被默认 1.65V 掩盖”

当前文件：

```text
Libraries/Hardware/src/CurrentSense.cpp
```

当前 `CurrentSense::calibrate()` 中存在逻辑：

```cpp
if ((ia_zero_v_ < 0.5f) || (ia_zero_v_ > 2.8f)) {
    ia_zero_v_ = 1.65f;
}

if ((ib_zero_v_ < 0.5f) || (ib_zero_v_ > 2.8f)) {
    ib_zero_v_ = 1.65f;
}
```

这个逻辑必须删除/重构。

### 原因

如果 INA240 已经损坏，实际可能出现：

```text
A相 OUT ≈ 0.58V
B相 OUT ≈ 0V
```

当前程序会把异常零点“修正”为默认 1.65V，结果上层可能误以为电流采样已经校准成功。

这对 FOC 是危险的。

### 修改要求

增加电流采样健康状态：

```cpp
struct CurrentSenseHealth {
    bool calibrated;
    bool zero_a_valid;
    bool zero_b_valid;
    bool dma_running;
    bool latest_sample_valid;

    uint16_t zero_raw_a;
    uint16_t zero_raw_b;

    uint32_t invalid_sample_count;
    uint32_t rail_sample_count;
};
```

`calibrate()` 必须：

1. 保存真实平均 ADC raw。
2. 判断两个 INA240 零点是否处于允许范围。
3. 如果任何一路不合法，**直接返回失败**。
4. 不允许使用默认 1.65V 来假装校准成功。
5. 校准失败后功率级永远不能 Arm。

建议把零点合法范围定义成明确常量，例如先使用较宽的安全窗口：

```cpp
constexpr float kCurrentZeroMinV = 1.0f;
constexpr float kCurrentZeroMaxV = 2.3f;
```

后续根据正常板实际统计再收紧。

注意：这个窗口用于判断“0A 时 INA240 是否活着”，不是电流测量范围。

### 运行中也要检测

`rawSamplePlausible()` 目前主要检查：

- 三路是否全 0
- 是否超过 12 bit
- 母线是否明显太低

还不够。

增加：

- `raw_a/raw_b` 长时间贴近 0 或 4095 → CurrentSenseFault。
- 单个异常样本可以丢弃。
- 连续 N 个异常样本必须触发故障。
- 不要因为某一个瞬时噪声就直接误停，但也不能无限继续运行。

建议把“DMA 未更新”和“INA 输出异常”区分成不同 fault reason。

---

# 2. P0-2：建立真正的 FaultManager，故障必须锁存

当前故障处理主要散落在：

```text
Libraries/App/src/control_app.cpp
Libraries/Control/src/foc_control.cpp
```

当前 `ApplicationController::Update()` 每一拍：

```cpp
telemetry_.fault_flags = 0UL;
```

这意味着当前 fault 更像“瞬时状态”，而不是可靠的锁存故障。

另外 `FocController::TripOvercurrent()` 目前只是：

- `enabled = 0`
- PI reset
- PWM 设 0
- `sample_fault_count++`

但外层又只有在类似：

```cpp
sample_fault_count > 0 && bus_v < 0.5f
```

时才设置 Current Fault。

这个关系不合理，必须拆开。

## 建议新增

```text
Libraries/Safety/inc/FaultManager.hpp
Libraries/Safety/src/FaultManager.cpp
```

或放到 `App/Safety`，但职责必须独立。

定义：

```cpp
enum class Fault : uint32_t {
    None               = 0,
    CurrentSense       = 1u << 0,
    OverCurrent        = 1u << 1,
    EncoderComm        = 1u << 2,
    EncoderCrc         = 1u << 3,
    EncoderMagnet      = 1u << 4,
    Driver             = 1u << 5,
    BusUndervoltage    = 1u << 6,
    BusOvervoltage     = 1u << 7,
    FocIsrOverrun      = 1u << 8,
    OuterLoopDeadline  = 1u << 9,
};
```

至少区分：

```text
active_faults
latched_faults
```

### 强制要求

严重故障：

```text
OverCurrent
CurrentSense invalid
DRV nFAULT
Encoder 连续失败
母线严重过压
```

必须：

```text
立即 PWM safe
→ DRV_ENABLE = LOW
→ 控制模式进入 IDLE/FAULT
→ latched_faults 保留
→ 用户显式 ClearFault 后才能重新 Arm
```

不要下一拍因为输入恢复就自动重新使能。

### 新增 API

建议：

```cpp
bool hasLatchedFault() const;
uint32_t activeFaults() const;
uint32_t latchedFaults() const;
void setFault(Fault fault);
void clearFaults();
```

外部 C API 可增加：

```c
void ControlApp_ClearFault(void);
uint32_t ControlApp_GetLatchedFaults(void);
```

---

# 3. P0-3：统一功率级使能权限

当前 `control_app.cpp` 在很多 mode 分支中直接出现：

```cpp
HAL_GPIO_WritePin(DRV_ENABLE_GPIO_Port, DRV_ENABLE_Pin, GPIO_PIN_SET);
foc_.Enable(1U);
```

这样以后很容易出现：

```text
上一段代码检测到故障并关闭
下一段 mode 逻辑又重新 SET DRV_ENABLE
```

必须改成**只有一个地方拥有功率级使能权**。

建议新增：

```cpp
class PowerStage {
public:
    void init(...);
    bool arm();
    void disarm();
    void tripFromIsr();
    bool isArmed() const;
};
```

如果不想增加新类，也至少把全部 GPIO/Foc Enable 操作集中到：

```cpp
ApplicationController::ArmPowerStage()
ApplicationController::DisarmPowerStage()
```

所有 mode 分支只表达：

```text
“请求运行什么控制模式”
```

不能直接操作 `DRV_ENABLE`。

---

# 4. P0-4：上电必须默认 IDLE，禁止自动 100rpm

当前 `control_app.cpp` 虽然有注释：

```text
boot IDLE so shaft is free until host arms a mode
```

但 `ApplicationController::Init()` 实际执行：

```cpp
control_mode_cmd = kModeSpeed;
control_enable = 1U;
control_velocity_ref_rad_s = kBootSpeedRadS;
```

必须改掉。

上电后必须：

```text
control_mode_cmd = IDLE
control_enable = 0
velocity_ref = 0
current_ref = 0
position controller reset
speed controller reset
current PI reset
DRV_ENABLE LOW
```

只有显式收到 Host/CAN/调试命令后才允许 Arm。

这是硬性安全要求。

---

# 5. P0-5：Arm 前进行完整自检

建议 PowerStage Arm 条件改成：

```text
母线有效
AND 电流采样校准成功
AND 两路 INA240 零点有效
AND ADC DMA 已经收到连续有效样本
AND Encoder 连续若干帧有效
AND DRV_nFAULT = HIGH
AND 无 latched fault
AND PWM/FOC 未检测 ISR overrun
```

建议状态机：

```text
BOOT
 ↓
SELF_TEST
 ↓
IDLE_READY
 ↓ host request
ARMING
 ↓ 连续健康状态满足
RUNNING
 ↓ fault
FAULT_LATCHED
 ↓ ClearFault + 再次通过自检
IDLE_READY
```

不要再用一个 `bus_ok_ms_` 代表所有安全条件。

---

# 6. P0-6：重新设计软件过流处理

当前：

```text
Libraries/Control/src/foc_control.cpp
FocController::TripOvercurrent()
```

### 修改要求

`OverCurrent` 和 `CurrentSenseFault` 必须是两个不同故障。

当前 `sample_fault_count` 不应同时承担：

- DMA/采样异常
- 软件过流

建议 FOCState 改成：

```cpp
uint32_t invalid_sample_count;
uint32_t overcurrent_trip_count;
uint32_t isr_overrun_count;
```

在 ISR 中过流：

```text
立刻写安全 PWM
立刻关闭功率级（最好调用非常短的 ISR-safe trip callback）
锁存 OverCurrent
return
```

如果硬件允许，最终应让 DRV nFAULT / 比较器过流接 TIM1 BKIN，软件只作为第二层保护。

当前 `TIM1` 中：

```text
BreakState = DISABLE
```

请不要在不知道 PCB 连线的情况下直接打开 BKIN；先检查实际原理图/引脚。若硬件已有可用保护信号，再启用 TIM1 Break。

---

# 7. P0-7：电流采样时刻必须重新验证

当前：

```text
Core/Src/main.c
TIM1 CH4 Pulse = 80
TRGO2 = OC4REF
```

注释称其为：

```text
near PWM valley / mid-valley sample
```

而当前硬件是：

```text
INA240A2 + low-side shunt
```

对于低侧 shunt，采样窗口必须和实际桥臂导通状态匹配。

**不要直接相信当前注释。必须重新分析 TIM1 PWM1 极性、DRV8313 输入逻辑、low-side shunt 电流路径，并用示波器验证 ADC 触发点。**

重点验证：

```text
ADC trigger 相对 CH1/2/3 PWM 的位置
INA240 OUT 在触发点前后是否稳定
高占空比 / 低占空比时是否仍有足够采样窗口
采样时是否处于有效 low-side conduction window
```

### 软件结构修改

不要把：

```cpp
sConfigOC.Pulse = 80;
```

作为散落魔法数字。

改成清晰常量或独立函数：

```cpp
constexpr uint32_t kAdcSampleOffsetTicks = ...;
ConfigureCurrentSampleTrigger(...);
```

最好支持调试阶段切换：

```text
PWM valley
PWM peak
不同 offset
```

方便示波器验证。

### 重要

这一步在没有硬件波形证明前，不要盲目宣布“已修复”。

Agent 如果只能修改代码而不能测板，必须输出：

```text
需要示波器验证的具体测试步骤
预期波形
通过/失败判据
```

---

# 8. P1-1：把 MotionController 拆成 RotorEstimator + SpeedController

当前：

```text
Libraries/Control/inc/MotionController.hpp
Libraries/Control/src/motion_control.cpp
```

现在一个类同时负责：

```text
机械角度输入
速度估计
加速度估计
速度 PI
Iq slew
```

职责过多。

更关键的是当前位置模式：

```cpp
mech_vel = motion_.GetState().mech_velocity_rad_s;
PositionPidVelocityRef(... mech_vel ...);
motion_.Update(...);
```

即位置 PID 的 D 项使用的是**上一拍速度**，然后本拍才更新速度估计。

## 重构目标

新增：

```text
Libraries/Control/inc/RotorEstimator.hpp
Libraries/Control/src/rotor_estimator.cpp

Libraries/Control/inc/SpeedController.hpp
Libraries/Control/src/speed_controller.cpp
```

### RotorEstimator

负责：

```text
角度 unwrap
机械速度
机械加速度
滤波
有效状态
```

接口类似：

```cpp
struct RotorState {
    float angle_wrapped_rad;
    float position_rad;
    float velocity_rad_s;
    float acceleration_rad_s2;
};

class RotorEstimator {
public:
    void reset(float angle_rad);
    const RotorState& update(float angle_rad, float dt);
    const RotorState& state() const;
};
```

### SpeedController

只负责：

```text
velocity_ref - velocity
→ PI
→ iq_ref
→ Iq limit / slew
```

接口类似：

```cpp
class SpeedController {
public:
    void init(...);
    void reset();
    void setReference(float velocity_ref);
    float update(float velocity_rad_s, float dt);
};
```

最终每个 1kHz 周期必须先：

```text
读取 encoder
→ RotorEstimator.update()
→ 得到“本拍” velocity
→ PositionController
→ SpeedController
```

不能位置环先用旧速度。

---

# 9. P1-2：把位置环从 ApplicationController 中独立出来

当前：

```text
ApplicationController::PositionPidVelocityRef()
position_integrator_
position_i_out_limit_
```

这些都应该移出 App。

新增：

```text
Libraries/Control/inc/PositionController.hpp
Libraries/Control/src/position_controller.cpp
```

接口建议：

```cpp
class PositionController {
public:
    void init(float kp,
              float ki,
              float kd,
              float velocity_limit,
              float integral_separation);

    void reset();
    void setGains(...);
    void setVelocityLimit(float limit);

    float update(float position_ref,
                 float position,
                 float velocity,
                 float dt);
};
```

保留当前：

```text
D on measurement: -Kd * velocity
```

方向，这是合理的，可以避免 position setpoint step 直接产生 D kick。

## 修改 anti-windup

当前位置积分逻辑：

```text
|error| < i_sep → 积分
|error| >= i_sep → integrator = 0
```

建议改成：

```text
大误差：freeze integrator，而不是每次清零
输出饱和且 error 继续推向饱和：freeze
输出开始退出饱和：允许积分恢复
```

可以保留 integral separation，但不要不断将积分器硬清零造成不连续。

位置环输出必须明确是：

```text
velocity_ref
```

并受 `velocity_limit` 限制。

---

# 10. P1-3：真正实现“三环数据流”

最终强制形成：

```text
MT6701
  ↓
RotorEstimator               1 kHz
  ↓ position / velocity
PositionController           1 kHz
  ↓ velocity_ref
SpeedController              1 kHz
  ↓ iq_ref
FOC CurrentLoopController    20 kHz
  ↓ vd / vq
SVPWM
```

其中：

```text
Id_ref 默认 0A
Iq_ref = torque command
```

速度模式：跳过 PositionController。

电流模式：跳过 Position + Speed，直接设置 `Iq_ref`。

位置模式：完整使用三环。

MIT 模式可以作为独立上层 torque command 路径保留，但不能污染标准三环逻辑。

---

# 11. P1-4：修复电流环“二维电压饱和后 PI 不知情”

当前电流 PI：

```text
CurrentLoopController
  ├─ Id PI 单独限幅
  └─ Iq PI 单独限幅
```

之后 `FocController` 又：

```text
加 decoupling/feedforward
→ LimitVoltageCircle(vd, vq, vmax)
```

问题：

```text
PI 单轴可能认为自己没饱和
但最终 vd/vq 矢量被圆限幅缩小
PI 不知道最终执行值已经改变
```

高速、母线电压不足、重载时会产生 vector windup。

## 修改要求

扩展 `PIController`：

```cpp
void setBackCalculationGain(float kaw);
void applySaturationFeedback(float delta_u, float dt);
```

或设计一个更干净的 PI result API。

在 FOC：

```cpp
vd_unsat = vd_pi + vd_ff;
vq_unsat = vq_pi + vq_ff;

vd_sat = vd_unsat;
vq_sat = vq_unsat;
LimitVoltageCircle(vd_sat, vq_sat, vmax);

current_loop_.applySaturationFeedback(
    vd_sat - vd_unsat,
    vq_sat - vq_unsat,
    dt);
```

然后输出 `vd_sat/vq_sat`。

`kaw` 不要硬编码成未经验证的神奇值，应作为控制参数或根据当前 PI 设计给出明确依据。

保持单轴 conditional integration 也可以，但必须再补上最终矢量饱和反馈。

---

# 12. P1-5：MT6701 必须检查 CRC / Status

当前：

```text
Libraries/Hardware/src/MT6701.cpp
```

代码已经解析：

```cpp
sample.angle_raw
sample.status
sample.crc
```

但解析后无条件：

```cpp
return HAL_OK;
```

必须补齐：

```text
CRC 校验
Status 合法性
连续错误计数
```

要求：

1. CRC 错误的帧不能进入位置/速度估计。
2. 一次 CRC 错误可以丢帧，继续使用 last-good 状态。
3. 连续 N 帧失败必须进入 EncoderFault 并关闭功率级。
4. 磁场过强/过弱等 status 应进入 telemetry/diagnostic。
5. CRC 算法严格按 MT6701 datasheet，不要凭记忆编写。
6. 给 CRC 函数写至少几个可重复测试用例。

建议 `EncoderSample` 增加：

```cpp
bool crc_ok;
bool status_ok;
```

也可以增加：

```cpp
struct EncoderHealth {
    uint32_t crc_error_count;
    uint32_t spi_error_count;
    uint32_t status_error_count;
    uint32_t consecutive_error_count;
};
```

---

# 13. P1-6：1kHz 外环必须去掉 HAL_GetTick + blocking UART 的抖动

当前：

```text
ApplicationController::Update()
```

用：

```cpp
HAL_GetTick()
固定 dt = 0.001f
```

同时：

```text
ApplicationController::SendVofaDebug()
```

使用阻塞：

```cpp
HAL_UART_Transmit(...)
```

当前 VOFA 12 个 float + 4 byte 尾部 = 52 byte。

115200 波特率下一帧传输时间约数毫秒，明显长于 1ms 外环周期。

## 必须改

VOFA 输出改为：

```text
UART DMA
或
非阻塞 ring buffer
```

不得阻塞控制调度。

### 外环调度

不要继续完全依赖主循环碰巧每 1ms 调到一次。

建议：

- 由硬件定时基准产生 1kHz `outer_loop_due`。
- 或从 20kHz FOC 时基每 20 次产生一个 1kHz 调度标志。
- 高优先级 ISR 只置 flag，不做阻塞 SPI/UART。
- 主循环消费该 flag。
- 记录 deadline miss。
- 如果实际执行存在抖动，使用真实 `dt`，不要永远假装等于 0.001s。

新增 telemetry：

```text
outer_loop_count
outer_loop_miss_count
outer_loop_dt_us
outer_loop_dt_max_us
```

---

# 14. P1-7：运行时修改 PI 参数必须避免 ISR 竞争

当前 1kHz `ApplicationController::Update()` 可以调用：

```cpp
foc_.SetCurrentPi(...)
```

而 20kHz ADC ISR 随时可能：

```cpp
foc_.OnPwmUpdate()
```

`SetCurrentPi()` 会同时修改多个成员并 reset PI，不能认为一次 float 写原子就足够安全。

## 修改方案

使用 pending config mailbox：

```cpp
struct CurrentLoopConfig {
    float kp;
    float ki;
    float out_limit;
    float kaw;
};
```

主循环：

```text
提交 pending config
```

20kHz ISR 在固定安全点：

```text
一次性复制/应用 config
```

或者使用极短临界区。

同理：

```text
current refs
angle
omega_e
```

跨 1kHz / 20kHz 边界的数据也要明确同步策略。

不要让一个结构体在两个上下文中被无保护地逐字段修改和读取。

---

# 15. P1-8：母线 UV/OV 改成独立、安全、有滞回的状态

当前代码：

```cpp
constexpr float kBusMinEnableV = 6.0f;
constexpr float kMinBusV = 6.0f;
```

不要把 6V 继续作为通用安全运行阈值。

应把阈值集中到硬件配置：

```cpp
struct BusVoltageLimits {
    float enable_min_v;
    float disable_min_v;
    float overvoltage_trip_v;
};
```

要求：

```text
Enable 门槛 > Disable 门槛
形成 hysteresis
```

具体数值必须结合实际母线工作范围、电源器件和 DRV8313 要求确定，不要散落在 FOC/App 两处各写一套。

母线过压同样需要 fault。

如果未来存在电机回生，必须确保回生时 VBUS 上升不会无限继续运行。

---

# 16. P1-9：修复 accel_ref 目前的假接口和 telemetry bug

当前：

```text
MotionController::SetAccelRef()
control_accel_ref_rad_s2
```

但速度控制实际并没有使用该参考值。

同时当前代码：

```cpp
telemetry_.accel_ref_rad_s2 = active_velocity_ref_rad_s_;
```

把速度值写进了加速度字段。

必须修复。

短期有两个选择：

### 方案 A：暂时删除未实现的 accel_ref

如果还没做 trajectory generator，就不要保留一个看似生效其实没作用的接口。

### 方案 B：正式增加 TrajectoryGenerator（推荐最终方案）

新增：

```text
TrajectoryGenerator.hpp/.cpp
```

目标：

```text
position_target
→ position_ref
→ velocity_ref/feedforward
→ acceleration_ref/feedforward
```

第一版可先做 trapezoidal profile：

```text
max_velocity
max_acceleration
```

以后再升级 S-curve / jerk limit。

注意：

**加速度是轨迹前馈/限制，不要做一个“加速度闭环”作为第四环。**

---

# 17. P2：最终推荐的软件架构

目标结构：

```text
ApplicationController
│
├── FaultManager
├── PowerStage
├── RotorEstimator
├── TrajectoryGenerator
├── PositionController
├── SpeedController
├── FocController
│   ├── CurrentLoopController
│   │   ├── PIController Id
│   │   └── PIController Iq
│   ├── SVPWM
│   └── CordicMath
│
├── CurrentSense
├── MT6701
└── MotorIdentifier
```

数据流：

```text
                   ┌──────────── FaultManager ────────────┐
                   │                                      ↓
MT6701 → RotorEstimator → PositionController → SpeedController → Iq_ref
             ↑                ↑                  ↑             ↓
             │                │                  │          FOC 20kHz
             │         TrajectoryGenerator       │             ↓
             │                                  CurrentSense ← ADC
             └──────────────── telemetry ──────────────────────┘
```

---

# 18. C++ 结构清理

当前工程仍同时存在：

```text
Libraries/Hardware/src/current_sense.c
Libraries/Hardware/src/CurrentSense.cpp
Libraries/Hardware/src/mt6701.c
Libraries/Hardware/src/MT6701.cpp

Libraries/Control/inc/foc_control.h
Libraries/Control/inc/FOCController.hpp
Libraries/Control/inc/motion_control.h
Libraries/Control/inc/MotionController.hpp
...
```

请检查 CMake 实际编译列表和所有 include。

如果旧 C 文件已经完全不再使用：

- 从 CMake 删除。
- 确认没有旧脚本/模块仍依赖。
- 再删除或移动到 `legacy/`。

不要让新 Agent 后续误 include 到旧 C API。

`control_app.h` 作为 `main.c / CAN / host` 的 C 边界可以保留 `extern "C"`。

内部 C++ 模块之间不要再通过旧 C API 通信。

---

# 19. MT6701 / CurrentSense 构造方式

当前类中存在带硬件参数的构造函数，其内部直接 `init()`，而 `init()` 会调用 HAL/GPIO。

为了避免以后有人把该对象改成全局静态对象后，在 `HAL_Init()` 前访问硬件，建议统一规范：

```cpp
对象构造：只保存状态/默认值
init()/begin()：真正访问 HAL
```

禁止 C++ 全局构造函数里执行：

```text
HAL_GPIO_Init
HAL_SPI_Transmit
HAL_TIM_PWM_Start
HAL_ADC_Start
```

---

# 20. 控制调参原则：重构阶段不要乱改算法参数

当前工程已经经历过大量：

```text
相序
电流符号
encoder direction
电气零位
D/Q 映射
速度→Iq 符号
```

调试。

本轮架构重构期间：

**不要顺便重新猜这些符号。**

优先保持原数值行为。

如果发现某个参数或符号值得修改：

1. 先记录。
2. 单独做 diagnostic branch。
3. 用 open-loop / current-loop 实验验证。
4. 不要和架构重构混在同一次修改中。

---

# 21. 三环调试顺序

完整三环不能同时调。

必须按：

## Stage 1：硬件健康

```text
DRV disabled
INA240 A/B zero ≈ mid-rail
ADC DMA稳定
MT6701 CRC/status正常
VBUS正常
nFAULT正常
```

全部通过以后才继续。

## Stage 2：开环电压

只验证：

```text
相序
encoder direction
电气零位
PWM映射
```

限制低电压、低速度。

## Stage 3：电流环

```text
Id_ref = 0
小 Iq step
```

检查：

```text
Iq 跟踪
Id ≈ 0
无振荡
无异常 current raw
无 voltage saturation windup
```

电流环没稳定之前禁止调速度环。

## Stage 4：速度环

先从低速、小 Iq limit 开始。

位置环保持关闭。

## Stage 5：位置环

速度环稳定后再开 PositionController。

先使用较软参数和严格速度/电流限制。

## Stage 6：Trajectory

最后加入梯形/S曲线轨迹，改善大角度阶跃。

---

# 22. 安全 bring-up 参数

在正式验证三环之前，增加一个 `SAFE_BRINGUP` 配置。

建议该模式：

```text
上电 IDLE
禁止自动转
最大 Iq 明显低于最终值
最大 modulation 降低
速度目标受严格限制
位置输出速度受严格限制
禁用或限制 identification/open-loop 高能量测试
```

具体数值不要在本文机械照抄，Agent 根据当前硬件和已有安全测试参数统一放进 `SafetyConfig`。

正常开发完成后再切换 production config。

---

# 23. Telemetry 必须补充

至少增加以下诊断字段：

```text
current_zero_raw_a
current_zero_raw_b
current_raw_a
current_raw_b
current_sample_valid
current_invalid_count

encoder_crc_ok
encoder_status
encoder_error_count

active_faults
latched_faults

power_stage_armed

outer_loop_dt_us
outer_loop_dt_max_us
outer_loop_miss_count

foc_isr_overrun_count

duty_a / duty_b / duty_c
vd_unsat / vq_unsat
vd_sat / vq_sat
voltage_saturated
```

这样下次出现“电机突然疯转”时，必须能通过数据回答：

```text
是编码器先错？
是 INA240 先掉？
是电流 PI 饱和？
是母线回生过压？
是速度环命令异常？
还是 ISR/调度异常？
```

而不是只能看到电机已经失控后的结果。

---

# 24. 编译与静态检查

每个阶段完成后：

```bash
cmake --preset Debug
cmake --build build/Debug
```

如工程支持 Release，也编译：

```bash
cmake --preset Release
cmake --build build/Release
```

建议给自己的 C++ 代码增加警告：

```text
-Wall
-Wextra
-Wshadow
-Wconversion（可逐步开启）
```

不要直接给 HAL 官方源码开启大量会导致噪音的规则。

---

# 25. 每个阶段的提交要求

不要一次改几十个文件后统一报告。

按以下顺序执行。

## Commit / Phase A：安全底座

必须完成：

```text
CurrentSense calibration fail-fast
CurrentSense health
FaultManager
latched fault
上电 IDLE
统一 DRV Enable
Arm self-test
过流 fault 分离
```

构建通过后停止并汇报。

## Phase B：传感器和调度

```text
MT6701 CRC/status
RotorEstimator
VOFA UART 非阻塞
1kHz scheduler / dt / deadline telemetry
```

构建通过后汇报。

## Phase C：三环架构

```text
SpeedController
PositionController
标准 cascaded loop
删除 MotionController 旧混合职责
```

构建通过后汇报。

## Phase D：电流环饱和改进

```text
vector saturation anti-windup
PI back calculation
voltage saturation telemetry
```

构建通过后汇报。

## Phase E：Trajectory + legacy cleanup

```text
TrajectoryGenerator
accel_ref 正式实现
legacy C API/source 清理
目录结构整理
```

---

# 26. 每完成一个 Phase 必须回答我这些问题

Agent 每次修改后必须明确输出：

1. 修改了哪些文件？
2. 每个文件为什么改？
3. 哪些行为保持不变？
4. 哪些行为发生变化？
5. 是否成功编译？
6. 是否有 warning？
7. 哪些修改已经通过源码验证？
8. 哪些必须上板/示波器才能验证？
9. 下一步上板测试的最低风险步骤是什么？
10. 如果测试失败，应该优先观察哪些 telemetry？

不能只回复“修改完成”。

---

# 27. 本轮禁止事项

Agent 不允许：

- 自动把默认模式改回 Speed。
- 在 CurrentSense 异常时偷偷 fallback 到 1.65V 并继续运行。
- 电流传感器无效时允许 Arm。
- fault 每 1ms 自动清零。
- DRV nFAULT 恢复后未经用户 ClearFault 自动重新启动。
- 在位置/速度环没稳定前提高 Iq 限制去“解决不转”。
- 一看到方向错就同时修改相序、D/Q、encoder direction、电气零位四个变量。
- 在没有示波器验证的情况下声称 ADC 采样时刻已经正确。
- 在控制循环里使用阻塞 UART。
- 在 20kHz ISR 中做 SPI/UART blocking 操作。
- 使用 `new/delete/malloc/free`。
- 引入 exception / RTTI。
- 为了 C++ 强行给无状态数学算法套全局 class。
- 大量新增 `extern "C"` 作为内部模块接口。

---

# 28. 最终验收标准

最终不是“编译通过”就完成，而应达到：

### 上电安全

```text
上电后电机自由/未使能
DRV_ENABLE LOW
任何 INA240 零点异常 → 禁止 Arm
Encoder 异常 → 禁止 Arm
nFAULT → 禁止 Arm
故障必须锁存
```

### 电流环

```text
20kHz稳定执行
无 ISR overrun
Iq step 可控
Id 接近 0
过流可立即关断
最终二维电压饱和有 anti-windup
```

### 速度环

```text
1kHz稳定调度
使用本拍速度估计
参考有 ramp
Iq 有 limit
堵转/外力情况下不会无限积分
```

### 位置环

```text
PositionController 独立
输出 velocity_ref
速度环输出 iq_ref
没有上一拍 velocity 的额外延迟结构
位置大阶跃受速度/电流限制
积分不会因为饱和持续 windup
```

### 轨迹

```text
大位置阶跃不再直接打满速度环
position / velocity / acceleration reference 可观测
```

### 可诊断

发生一次异常后，telemetry 能明确定位：

```text
传感器
编码器
母线
DRV
控制饱和
ISR
外环调度
```

哪一项先出现异常。

---

# 29. 现在先执行的第一步

**不要马上从 PositionController 开始。**

请先执行 Phase A：

```text
1. 修改 CurrentSense::calibrate()，异常零点必须返回失败，禁止 fallback 掩盖。
2. 增加 CurrentSenseHealth。
3. 增加 FaultManager + latched faults。
4. 将上电默认模式改成 IDLE。
5. 统一所有 DRV_ENABLE / FOC Enable 的管理。
6. Arm 前检查 INA240 / ADC / Encoder / VBUS / nFAULT。
7. 分离 OverCurrent 和 SampleFault。
8. 完整编译。
```

执行完 Phase A 后先停下来，把 diff、构建结果和上板验证步骤给我，不要自动继续 Phase B。
