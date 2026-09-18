# CAN 使用说明

> 最后更新：2026-09-17
> 适用工程：`4310_G431KBT6_CurrentAccelLoop`
> 当前默认实机配置：电机 CAN ID = `2`

本文档汇总当前固件实际实现的 CAN 接口。固件同时支持：

1. **GM6020 风格协议**：适合多电机周期电流控制，带零帧启动握手和 100 ms 超时停机。
2. **项目原生协议**：适合调试电流环、速度环、位置环、MIT 模式和在线修改控制参数。

## 1. 安全注意事项

- 首次测试必须固定电机，确保转子和负载周围无人、无松动物体。
- 电流模式只控制转矩，不限制转速；空载时很小的电流也可能使电机持续加速。
- 上电、烧录、切换 CAN ID 或更换接线后，先发送停机帧并确认功率级关闭。
- 当前命令电流软件限幅为 **±2.5 A**；相电流瞬时硬保护约为 **3.5 A**。两者不是同一个限制。
- 原生协议的命令会持续生效，当前没有 100 ms 命令超时保护；主机异常时应主动发送 `disable`/`estop`，并保留硬件急停手段。
- GM6020 风格协议具有 100 ms 会话超时，但不能替代固件保护和硬件急停。
- CAN 总线两端应各接一个 120 Ω 终端电阻；断电测量 CAN_H 与 CAN_L 之间通常约为 60 Ω。

## 2. 总线参数

| 项目 | 配置 |
|---|---|
| CAN 类型 | Classic CAN |
| 标识符 | 11 位标准帧 |
| 波特率 | 1 Mbps |
| 数据长度 | DLC = 8 |
| CAN FD/BRS | 不使用 |
| 远程帧 | 不作为控制命令 |
| GM6020 多字节数据 | 大端 |
| 原生协议 float/int16 | 小端 |

PCAN 默认通道为 `PCAN_USBBUS1`。

## 3. CAN ID 速查

### 3.1 当前 ID=2

| 用途 | CAN ID |
|---|---:|
| 原生控制命令 | `0x102` |
| 原生状态反馈 | `0x182` |
| GM6020 电流命令组 | `0x1FE` |
| GM6020 状态反馈 | `0x206` |

### 3.2 GM6020 风格 ID 映射

| 电机 ID | 电流命令 ID | 本机字节槽位 | 反馈 ID |
|---:|---:|---:|---:|
| 1 | `0x1FE` | Byte 0–1 | `0x205` |
| 2 | `0x1FE` | Byte 2–3 | `0x206` |
| 3 | `0x1FE` | Byte 4–5 | `0x207` |
| 4 | `0x1FE` | Byte 6–7 | `0x208` |
| 5 | `0x2FE` | Byte 0–1 | `0x209` |
| 6 | `0x2FE` | Byte 2–3 | `0x20A` |
| 7 | `0x2FE` | Byte 4–5 | `0x20B` |

原生协议的 ID 计算方式：

```text
控制 ID = 0x100 + motor_id
状态 ID = 0x180 + motor_id
```

电机 ID 在编译时固化，只允许 `1..7`。

---

## 4. GM6020 风格协议

该协议建议用于上位机以固定周期控制多台电机的 Iq 电流。

### 4.1 电流命令

本机槽位为一个大端有符号 `int16`：

```text
raw  = round(Iq_A × 16384 / 3)
Iq_A = raw × 3 / 16384
```

线上编码量程为 ±3 A，但固件最终将目标限制在 **±2.5 A**。

ID=2 的帧示例：

```text
CAN ID=0x1FE，DLC=8

准备/停机：00 00 00 00 00 00 00 00
+0.1 A：   00 00 02 22 00 00 00 00
-0.1 A：   00 00 FD DE 00 00 00 00
```

同一组内其他电机槽位应按实际目标填写；单电机台架测试时其余槽位置零。

### 4.2 启动握手与超时

1. 上电默认不使能功率级。
2. 先发送一次或连续发送本机槽位为零的有效命令，建立 `ready` 状态。
3. 再发送非零电流，固件才进入电流环并使能功率级。
4. 建议以 **10 ms 周期（100 Hz）**持续刷新命令。
5. 活动会话连续 **100 ms** 没有收到有效本机电流帧时自动停机，并取消 `ready`。
6. 超时、旧协议 STOP 或安全联锁后，持续发送非零帧不会重新启动；必须重新发送零帧完成握手。
7. 零电流帧的含义是关闭当前 GM6020 会话的功率级，同时为下一次启动准备；它不是“保持使能但目标为 0 A”。

兼容的旧 STOP 帧：

```text
CAN ID = 0x100 + motor_id
Data   = 00 00 00 00 00 00 00 00
```

ID=2 时 STOP ID 为 `0x102`。

### 4.3 GM6020 反馈帧

反馈周期约为 **1 ms（约 1 kHz）**，反馈 ID 为 `0x204 + motor_id`。

| 字节 | 类型 | 内容 |
|---|---|---|
| 0–1 | uint16，大端 | 机械角度，范围 0..8191 |
| 2–3 | int16，大端 | 转速 rpm |
| 4–5 | int16，大端 | 实际 Iq，比例为 `3/16384 A` |
| 6 | uint8 | 固定 `0xFF`，表示温度不可用 |
| 7 | uint8 | 保留，固定 0 |

角度换算：

```text
angle_deg = angle_raw × 360 / 8192
```

功率级失能时，反馈 Iq 被置为零，避免继续发送停机前的残留值。Byte 6 的 `0xFF` 不是 255 ℃。

---

## 5. 项目原生控制协议

原生协议用于调试和控制各闭环。当前 ID=2 时，向 `0x102` 发送命令，从 `0x182` 接收状态。

### 5.1 通用命令格式

```text
Byte 0    command
Byte 1    parameter 或 mode
Byte 2–5  float32 little-endian target
Byte 6–7  reserved，置零
```

| command | 功能 | target |
|---:|---|---|
| `0x00` | Disable | 无 |
| `0x01` | 进入电流环 | Iq，单位 A |
| `0x02` | 进入速度环 | 转速，单位 rpm |
| `0x03` | E-stop/停机 | 无 |
| `0x04` | 修改参数 | 参数值 |
| `0x05` | 进入位置环 | 位置，单位 rad |
| `0x06` | 进入 MIT 模式 | 后续帧使用 MIT 打包格式 |
| `0x07` | 设置控制模式 | Byte 1 为模式号 |

模式号：

| mode | 模式 |
|---:|---|
| `0x00` | Disabled/Idle |
| `0x01` | Current |
| `0x02` | Speed |
| `0x03` | Position |
| `0x04` | MIT |

### 5.2 原始帧示例（ID=2，发送到 0x102）

```text
Disable：       00 00 00 00 00 00 00 00
E-stop：       03 00 00 00 00 00 00 00
Iq = +0.1 A：  01 00 CD CC CC 3D 00 00
Speed = 100：  02 00 00 00 C8 42 00 00
Position=1.57：05 00 C3 F5 C8 3F 00 00
Current Kp=.5：04 01 00 00 00 3F 00 00
Current Ki=50：04 02 00 00 48 42 00 00
```

### 5.3 命令限幅

| 目标 | 固件限幅 |
|---|---:|
| 电流目标 | ±2.5 A |
| 速度目标 | ±500 rpm |
| 位置目标 | ±500 rad |
| MIT 前馈电流 | ±2.5 A |

超出范围的命令会在固件中被钳制到边界值。

### 5.4 在线控制参数

设置参数时：

```text
Byte 0 = 0x04
Byte 1 = parameter ID
Byte 2–5 = float32 little-endian value
```

| parameter ID | 参数 | 说明 |
|---:|---|---|
| `0x01` | Current Kp | 电流环比例系数 |
| `0x02` | Current Ki | 电流环积分系数 |
| `0x03` | Current PI output limit | 电流 PI 输出电压限制，单位 V；**不是 Iq 电流上限** |
| `0x04` | Position Kp | 位置环比例系数 |
| `0x05` | Position Kd | 位置环微分系数 |
| `0x06` | MIT Kp | MIT 默认 Kp |
| `0x07` | MIT Kd | MIT 默认 Kd |
| `0x08` | Position Ki | 位置环积分系数 |
| `0x09` | Position integral separation | 位置积分分离阈值，单位 rad |

注意：

- 负参数在固件中会被钳制为 0。
- 这些 CAN 在线参数只修改运行时 RAM，当前不会写入校准 Flash；复位或重新上电后恢复固件编译值。
- `parameter 0x03` 只能调 PI 电压输出限幅，不能把 `CAN_CURRENT_LIMIT_A` 从 2.5 A 在线改大。

---

## 6. 原生状态反馈

状态 ID：

```text
0x180 + motor_id
```

当前状态帧约每 **100 ms（10 Hz）**发送一次。

| 字节 | 类型 | 内容 |
|---|---|---|
| 0 | uint8 | 当前模式 |
| 1 | uint8 | 故障标志低 8 位 |
| 2–5 | float32，小端 | 当前模式的主要反馈 |
| 6–7 | int16，小端 | 实时转速 `rpm × 10` |

主要反馈的含义：

| 模式 | Byte 2–5 |
|---|---|
| Current | 实际 Iq，A |
| Speed | 实际速度，rpm |
| Position | 实际位置，rad |
| MIT | 实际位置，rad |
| Disabled | 母线电压，V |

Byte 6–7 的转速解码：

```text
rpm = int16_le(data[6:8]) / 10
```

> 当前 `tools/can_motor_control.py` 的 `decode_status()` 仍将 Byte 6/7 当作 node ID 和 counter，落后于固件实际格式。使用该脚本的 `monitor` 输出时，Byte 2–5 仍可参考，但 Byte 6/7 的文字解释不正确；原始帧应按本文档解码。

### 6.1 故障位

| bit | mask | 故障 |
|---:|---:|---|
| 0 | `0x01` | CurrentSense |
| 1 | `0x02` | OverCurrent |
| 2 | `0x04` | EncoderComm |
| 3 | `0x08` | EncoderCrc |
| 4 | `0x10` | EncoderMagnet |
| 5 | `0x20` | Driver |
| 6 | `0x40` | BusUndervoltage |
| 7 | `0x80` | BusOvervoltage |
| 8 | `0x0100` | FocIsrOverrun |
| 9 | `0x0200` | OuterLoopDeadline |

状态帧 Byte 1 只发送低 8 位，所以 bit 8 和 bit 9 无法通过该单字节完整观察，需要通过 SWD/调试变量查看完整 `fault_flags`。

---

## 7. MIT 模式

先发送普通命令 `0x06` 进入 MIT 模式，之后相同控制 ID 上的帧按 8 字节 Cheetah 格式解析。

| 字段 | 位数 | 范围 |
|---|---:|---:|
| `p_des` | 16 | -50..50 rad |
| `v_des` | 12 | -50..50 rad/s |
| `kp` | 12 | 0..500 |
| `kd` | 12 | 0..5 |
| `iq_ff` | 12 | -2.5..2.5 A |

字节布局：

```text
Byte 0 = p[15:8]
Byte 1 = p[7:0]
Byte 2 = v[11:4]
Byte 3 = v[3:0] << 4 | kp[11:8]
Byte 4 = kp[7:0]
Byte 5 = kd[11:4]
Byte 6 = kd[3:0] << 4 | iq_ff[11:8]
Byte 7 = iq_ff[7:0]
```

进入 MIT 后，普通命令可能被当作 MIT 数据。只有以下逃生帧例外：

- `00 00 00 00 00 00 00 00`：Disable。
- `03 00 00 00 00 00 00 00`：E-stop。
- Byte 0 为 `0x07` 的 Set Mode 帧：切换或退出 MIT。

---

## 8. Python + PCAN 使用

### 8.1 安装依赖

在工程虚拟环境中执行：

```powershell
python -m pip install -r requirements-tools.txt
```

确认当前 Python 来自工程 `.venv`：

```powershell
python -c "import sys; print(sys.executable)"
```

### 8.2 原生协议命令

以下示例均使用电机 ID=2：

```powershell
# 监听状态 10 秒
python tools/can_motor_control.py --id 2 monitor --seconds 10

# 停机
python tools/can_motor_control.py --id 2 disable

# 电流环：0.1 A
python tools/can_motor_control.py --id 2 current 0.1

# 速度环：100 rpm
python tools/can_motor_control.py --id 2 speed 100

# 位置环：1.57 rad
python tools/can_motor_control.py --id 2 position 1.57

# 在线修改电流环 PI
python tools/can_motor_control.py --id 2 set-pid current-kp 0.5
python tools/can_motor_control.py --id 2 set-pid current-ki 50

# 修改电流 PI 输出电压限幅；这不是电流限幅
python tools/can_motor_control.py --id 2 set-pid current-limit 6.0

# MIT 单帧示例：pos vel kp kd iq_ff
python tools/can_motor_control.py --id 2 mit 0 0 5 0.1 0
```

指定其他 PCAN 通道或波特率：

```powershell
python tools/can_motor_control.py --channel PCAN_USBBUS1 --bitrate 1000000 --id 2 monitor --seconds 10
```

### 8.3 GM6020 协议验证

```powershell
# 被动检查，不主动启动电机
python tools/pcan_gm6020_test.py --motor-id 2

# 允许脚本短时发送小电流并验证启动、超时、重启和停机
python tools/pcan_gm6020_test.py --motor-id 2 --run
```

`--run` 会使电机转动，只能在固定好的独立单电机台架上执行。测试日志写入 `logs/`。

---

## 9. 编译、设置 CAN ID 与烧录

```powershell
# 仅编译，CAN ID=2
python tools/build_flash_motor.py --motor-id 2

# 编译、烧录并校验，CAN ID=2
python tools/build_flash_motor.py --motor-id 2 --flash
```

说明：

- `--motor-id` 只允许 `1..7`。
- ID 会同时决定原生协议和 GM6020 风格协议的标识符。
- 烧录前必须停机；如果脚本提示 `Driver enabled: stop motor first`，先发送 disable/STOP，确认功率级关闭后再重试。
- 正常固件烧录不会擦除工程预留的校准 Flash 区，因此不会覆盖已经保存的电角度零点和编码器方向；执行全片擦除或修改链接脚本/校准区地址时除外。

当前已保存的校准数据：

```text
electrical_zero_rad = 0.1341035366
encoder_direction   = 1
sequence            = 1
```

---

## 10. 推荐测试流程

### 10.1 上电检查

1. 电机固定，电源限流设为安全值。
2. 检查 CAN_H/CAN_L 接线和终端电阻。
3. 打开 PCAN，设置 Classic CAN、1 Mbps。
4. 确认能收到 ID=2 的 `0x206`（约 1 kHz）和 `0x182`（约 10 Hz）。
5. 检查状态帧 fault Byte 是否为 0。

### 10.2 原生协议测试

```powershell
python tools/can_motor_control.py --id 2 disable
python tools/can_motor_control.py --id 2 current 0.05
python tools/can_motor_control.py --id 2 disable
python tools/can_motor_control.py --id 2 speed 100
python tools/can_motor_control.py --id 2 disable
```

每一步都先观察电流、速度、母线电压和故障位，再逐步提高目标，不要直接从零跳到 2.5 A。

### 10.3 GM6020 风格测试

1. 周期发送全零帧到 `0x1FE`。
2. 将 ID=2 对应 Byte 2–3 设置为小电流，如 0.05 A。
3. 保持 10 ms 周期发送。
4. 观察 `0x206` 的角度、rpm 和 Iq。
5. 发送零帧停机。
6. 停止发送并确认 100 ms 超时能够关闭功率级。

---

## 11. 常见问题

### 收不到反馈

- 检查是否设置为 1 Mbps、标准帧、Classic CAN。
- 检查 PCAN 通道是否为 `PCAN_USBBUS1`。
- 检查 CAN_H/CAN_L 是否接反、是否共地、终端电阻是否正确。
- 检查固件烧录的 motor ID；ID=2 应看到 `0x182` 和 `0x206`。
- PCAN 只有一个节点且没有其他节点 ACK 时，发送端可能累计 CAN 错误；确保总线上有正常工作的收发器节点。

### GM6020 非零电流无法启动

- 上电或超时后必须先发送本机槽位为零的握手帧。
- 检查帧是否为标准数据帧、DLC 是否为 8、命令组 ID 是否正确。
- 检查是否存在故障、编码器异常、驱动器异常或安全联锁未满足。
- 其他控制模式正在运行时，GM6020 会话不会直接抢占。

### 电流达不到 2.5 A

- 2.5 A 是目标上限，不保证所有母线电压、转速和负载下都能达到。
- 检查电流 PI 的 Kp、Ki 和输出电压限幅。
- 高转速时反电动势会占用电压裕量，PI 输出饱和后电流无法继续上升。
- 检查供电限流、母线压降、驱动能力和相电流保护。
- `set-pid current-limit` 调的是 PI 输出电压限制，不是 Iq 上限。

### 修改 PI 后重启失效

CAN `set-pid` 当前只修改 RAM，不保存到 Flash。需要永久生效时，应修改固件默认参数后重新编译烧录，或另行实现参数持久化。

### 状态监控中的 ID/counter 看起来异常

这是主机脚本解码格式落后导致的。当前固件 Byte 6–7 实际是小端 `rpm × 10`，不是 ID/counter。

## 12. 相关文件

```text
Core/Src/main.c                         原生 CAN 协议、状态帧、MIT 解析
Libraries/App/inc/gm6020_can.h          GM6020 协议接口和 ID 定义
Libraries/App/src/gm6020_can.c          GM6020 编解码及会话逻辑
tools/can_motor_control.py              原生协议 PCAN 命令行工具
tools/pcan_gm6020_test.py               GM6020 协议 PCAN 自动验证
tools/build_flash_motor.py              按电机 ID 编译和烧录
docs/GM6020_CAN_PROTOCOL.md             GM6020 风格协议专项说明
```
