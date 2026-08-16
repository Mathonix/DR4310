# DR4310

STM32G431KBT6 的 FOC 无刷电机驱动固件，包含电流环、速度环、MT6701 磁编码器、CAN 调试、VOFA 遥测和 WS2812 故障灯。

## 硬件

- MCU: STM32G431KBT6, 170 MHz
- 驱动: DRV8313
- 电流采样: INA240 + 低边采样电阻
- 编码器: MT6701, SPI 10 kHz DMA 读取
- PWM: TIM1 20 kHz, 电流环在 ADC DMA 中断里执行
- 上位机: UART/VOFA、FDCAN、SEGGER Ozone/J-Link
- 状态灯: WS2812

## 构建

项目使用 CMake + Ninja + `arm-none-eabi` 工具链。

```bash
cmake --preset Release
cmake --build build/Release --target 4310_G431KBT6 -j 8
```

生成烧录文件：

```bash
arm-none-eabi-objcopy -O ihex build/Release/4310_G431KBT6.elf build/Release/4310_G431KBT6.hex
```

使用 JLink 烧录：

```bash
JLink.exe -device STM32G431KB -if SWD -speed 1000 -autoconnect 1 -CommanderScript flash_release.jlink -ExitOnError 1
```

> 20 kHz FOC 请使用 Release 构建。Debug `-O0` 的 FOC ISR 过重，主循环会卡死。

## 控制结构

- FOC PWM: 20 kHz
- 电流环: 20 kHz, ADC DMA 中断内执行
- 速度环: 1 kHz, 主循环/ControlApp 执行
- 编码器: 10 kHz SPI DMA + PLL

默认控制参数：

- 电流环 Kp: `12.0`
- 电流环 Ki: `1500.0`
- 电流环输出: 跟随母线电压/最大调制
- 速度环 Kp: `0.25`
- 速度环 Ki: `0.02`
- 速度环 Kd: `0.0`
- Iq 限幅: `1.0 A`

## Ozone 调试

打开 `43110.jdebug`，工程已配置为加载 `build/Release/4310_G431KBT6.elf`，Release 保留调试符号。

常用变量：

| 变量 | 含义 | 单位 |
|---|---|---|
| `control_velocity_ref_rad_s` | 速度目标 | rad/s |
| `control_debug_speed_ref_rad_s` | debug 速度目标 | rad/s |
| `control_debug_cmd` | 1=Speed, 2=Disable, 3=ClearFaults | - |
| `control_speed_pi_kp` | 速度环 Kp | - |
| `control_speed_pi_ki` | 速度环 Ki | - |
| `control_speed_pi_kd` | 速度环 Kd | - |
| `control_iq_limit_a` | 速度环输出/Iq 限幅 | A |
| `app::g_application.telemetry_.velocity_rad_s` | 实际机械速度 | rad/s |
| `app::g_application.telemetry_.iq_ref_a` | Iq 参考 | A |
| `app::g_application.telemetry_.fault_flags` | 锁存故障位 | - |

100 rpm = `10.4722 rad/s`，10 rpm = `1.0472 rad/s`。

使能速度环：

1. Halt。
2. 写 `control_debug_speed_ref_rad_s = 10.4722`。
3. 写 `control_debug_cmd = 3`，Resume 约 0.5 s 后 Halt。
4. 写 `control_debug_cmd = 1`，Resume。

停止：

1. Halt。
2. 写 `control_debug_cmd = 2`，Resume。

速度环输出上限和积分上限都由 `control_iq_limit_a` 控制。修改该变量后，主循环会重新初始化速度 PI 和 FOC Iq 限幅。

## 故障灯与报错数组

WS2812 故障灯颜色和闪烁次数：

| index | name | 颜色 | 闪烁次数 |
|---|---:|---|---:|
| 0 | CURRENT_SENSE | 红 | 1 |
| 1 | OVERCURRENT | 橙 | 2 |
| 2 | ENCODER_COMM | 黄 | 3 |
| 3 | ENCODER_CRC | 黄绿 | 4 |
| 4 | ENCODER_MAGNET | 青绿 | 5 |
| 5 | DRIVER | 品红 | 6 |
| 6 | BUS_UNDERVOLT | 蓝 | 7 |
| 7 | BUS_OVERVOLT | 青 | 8 |
| 8 | FOC_ISR_OVERRUN | 白 | 9 |
| 9 | OUTER_DEADLINE | 亮绿 | 10 |

`g_fault_report[]` 是固定 10 项的报错数组，每项包含：

- `code`
- `first_timestamp_ms`
- `last_timestamp_ms`
- `count`
- `name`

故障位从 0 变 1 时 `count++`。Ozone Watch 已加入 `g_fault_report` 和 `g_fault_report_generation`。

## 故障位

| 位 | 含义 |
|---:|---|
| 0x01 | CurrentSense |
| 0x02 | OverCurrent |
| 0x04 | EncoderComm |
| 0x08 | EncoderCrc |
| 0x10 | EncoderMagnet |
| 0x20 | Driver |
| 0x40 | BusUndervoltage |
| 0x80 | BusOvervoltage |
| 0x100 | FocIsrOverrun |
| 0x200 | OuterLoopDeadline |

## 主要遥测

- `velocity_rad_s`: 编码器 PLL 机械速度
- `iq_ref_a` / `iq_a` / `id_a`: 电流环参考和实际值
- `vq_v` / `vd_v`: 电压输出
- `encoder_sample_age_us`: 编码器样本消费延迟
- `current_isr_max_us`: FOC ISR 最大耗时
- `encoder_dma_callback_max_us`: 编码器 DMA 回调最大耗时

## 说明

- 编码器 CRC 校验已关闭，样本有效性只看 MT6701 status。
- 长时间 100 rpm 测试如果触发 DRV 故障，请确认可调电源电流余量和电机机械负载。
