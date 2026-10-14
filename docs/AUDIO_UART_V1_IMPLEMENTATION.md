# AUDIO UART V1 固件交付（2026-10-14）

音乐发布分支：`feature/music-mode`，从已实测的 `feature/audio-uart-v1` 工作树整理。HEAD 基线 `a104bb646e1de1fbf4b3d47fea90eaceb91c0cdb`，实际开发基于已有的 3.3.0 齿槽补偿工作树；分支保留固件、配套上位机、协议向量和测试。早期 AUDIO 专属增量与开发前文件快照留在本机 `logs/audio_uart_v1_20261014/audio-only.patch` 和 `baseline/`，原始日志及构建产物不进入仓库。本文后续 3.4.0/3.4.3 的验收项按历史记录阅读。

当前构建版本为 **3.4.4**，应用仍编译为电机 ID2。新增运行时音频功能，不修改 Flash 配置格式、CAN 字节格式、电流 PI、PWM/ADC 时序或旧遥测字段。冻结合同原文保留在 [UART_AUDIO_PROTOCOL_V1.md](UART_AUDIO_PROTOCOL_V1.md)。当前短 TX 是使用 V1 帧格式的扩展，缓冲容量、窗口和回传节拍与冻结合同不同；标准 TX 保留原缓冲、窗口和节拍。Q 轴峰值参数按用户要求扩展到 1 A，D 轴仍为 200 mA，具体能力协商见 [AUDIO_1A_EXTENSION.md](AUDIO_1A_EXTENSION.md)。下文 3.4.0 短测为历史验收；旧串口检查记录见 [AUDIO_REPAIR_20261014.md](AUDIO_REPAIR_20261014.md)。

## 第一条续作：短 TX 接入与问题修复

波特率沿用用户已批准的 **200000，8N1**，网页仍可选择 230400 对接旧固件。新增 `INFO audio_low_tx=0|1`；OPEN 回复是主机协商依据：

| 模式 | 编译选项 | PCM 容量 | window | STATUS 周期 | 主机重试 / STATUS 超时 |
| --- | --- | --- | --- | --- | --- |
| 标准 TX | `AUDIO_LOW_TX_MODE=0` | 2048 | 6 | 20 ms | 100 / 300 ms |
| 短 TX | `AUDIO_LOW_TX_MODE=1`，默认 | 4096 | 12 | 100 ms | 250 / 500 ms |

guard=128、prefill=800、PCM 8 kHz S16LE、帧类型/CRC/STATUS 字节格式不变。短 TX 的普通 DATA、重复 DATA、序号缺口和缓冲满反馈合并到周期 STATUS；开始播放及 PAUSE/RESUME/END/ABORT/EXIT、故障和超时仍及时回报。持续发送 DATA 时不额外插入 PING，暂停或发送空闲时每 100 ms 保持有效心跳。网页显示实际容量和短 TX 生效状态。

本回合修复：

- 主机解析 OPEN 后使用实际窗口、容量和超时，拒绝不支持的组合；旧固件 2048/6 与短 TX 4096/12 均可播放。
- 关闭短 TX 后，PCM 容量也恢复为 2048；CMake 和构建工具明确控制同一个编译开关。
- 坏 CRC 不刷新固件 300 ms 有效输入看门狗；持续损坏输入不能延长会话。
- HALTED/FAULT 回报始终保留中止原因，避免缓存的 CRC/序号缺口覆盖 TIMEOUT。
- 短 TX 仅容忍可通过整帧 CRC 和序号重传恢复的 NE/FE；ORE、PE、DMA 错误及 DMA 覆盖/边界丢失仍停机。不会自动重新使能已中止的会话。
- 修复旧安全回归测试缺少音频依赖的编译错误，并增加音频停机取消 AE、内部停机保留原因的断言。CAN GUI 测试容差按 16 位协议半个量化步长校正，CAN 字节格式未改变。

标准 TX 与短 TX 分别完成 5 分钟、240 万样本的仿真，均无欠载；短 TX 约 3000 个周期 STATUS。上位机 314 项测试、类型检查和两种模式的浏览器模拟流程通过。`logs/continue_task1_20261014/` 保存本次发布和验收记录；占用 COM5 时不会声称已完成烧录或实机音乐验收。

构建默认短 TX：`python tools/build_flash_motor.py --motor-id 2 --uart-baud 200000`；标准 TX 加 `--standard-tx`。两种版本使用相同 UART 选择。当前短 TX 构建 Flash 98412 B、RAM 27896 B。

## 源码与职责

| 文件 | 职责 |
| --- | --- |
| `Libraries/App/inc/motor_audio.h` / `src/motor_audio.cpp` | 帧解析、会话、seq/credit、原子门控、STATUS、300 ms watchdog、2 s 恢复 |
| `Libraries/Control/inc/AudioCurrent.hpp` / `src/audio_current.cpp` | 2048/4096 样本 SPSC、8k→20k 插值、5 ms 暂停/恢复、10 ms END 淡出、60 ms 欠载 |
| `Libraries/App/inc/uart_dma_cursor.h` | DMA HT/TC 总量与 NDTR 快照、整圈覆盖和迟延观测检测 |
| `control_app.cpp` | OPEN 校验、ASCII/BINARY 所有权、外部控制中止、故障/ADC/编码器 gate、原 TX 队列复用 |
| `foc_control.cpp` | 当前电流环前的局部 D/Q 注入、矢量限幅、保留 IdRef/IqRef、实际过流/欠压关断 |
| `Core/Src/stm32g4xx_hal_msp.c` / `stm32g4xx_it.c` | USART1 RX circular DMA1_Channel5 初始化、IRQ、错误恢复和释放 |
| `protocol/protocol_vectors.json` / `audio_uart_v1.ts` | 两端共用的 113 组固定向量和纯 TypeScript codec |
| `tools/audio_host_test.py` | 显式 `--run` 的有界 300 Hz、小幅实机测试工具；默认 5 mA，上限 20 mA |

上位机已实现「电流音频」页面、RAW PCM 去 DC、Web Serial 收发独占、ACK/credit/window/retry、STATUS 乱序处理、二进制心跳、急停 ABORT/EXIT，以及退出后的 TELEM 恢复，并部署到 dr4310.233688.xyz。3.4.4 / 200000 的 COM5 完整 RAW 已通过，回传仍有坏 CRC STATUS；实机结果见文末。

## DMA 与实时路径

资源核对采用本地 STM32G4 HAL、CMSIS、启动表及 [ST RM0440](https://www.st.com/resource/en/reference_manual/rm0440-stm32g4-series-advanced-armbased-32bit-mcus-stmicroelectronics.pdf)。

| 外设 | DMA/IRQ | NVIC 抢占优先级 |
| --- | --- | --- |
| ADC1 / 20 kHz FOC | DMA1_Channel1 | 0 |
| MT6701 SPI3 RX/TX | DMA1_Channel2/3 | 3 |
| WS2812 SPI1 TX | DMA1_Channel4 | 4 |
| USART1 RX / DMAMUX request 24 | DMA1_Channel5，2048 B circular，DMA LOW | 5 |
| USART1 TX/错误 | USART1_IRQn | 6 |

逐字节 `HAL_UART_Receive_IT` 已移除。HT/TC ISR 只更新半缓冲总计数；主循环取总计数和 NDTR 的短临界区快照，以绝对读写差检测覆盖。边界中断同时积压，或主循环观测间隔达到 88 ms，均视为不可确定的接收丢失并中止音频；在 230400 8N1 下整圈最短约 88.9 ms。这是保守拒绝，不继续播放可能覆盖的数据。USART ORE/FE/NE/PE 后 HAL abort 完成回调重启 DMA，并由主循环重置读游标和解析状态。

20 kHz 内只执行门控、原子 SPSC 读取、整数相位 `+2 mod 5`、线性插值、幅度及电流矢量限幅。CRC、帧解析、STATUS、UART 入队均在主循环。无 ISR malloc/new/printf/CRC/UART 或 sin。Q 仅加到局部 iq_cmd，D 仅加到局部 id_cmd；原 IdRef/IqRef 不回写。`FOCState.audio_cmd_a` 单独记录重采样给定（合成矢量限幅前），供调试采样。

## 会话与异常语义

- OPEN 只接受 Q/D 和十进制整数 1..200，要求 CURRENT、无 AE/校准/开环/辨识、有效校准/编码器/电流采样、驱动已由原 gate 使能、无锁存故障。TELEM 必须关闭、无 GET/REBOOT/COG 上传/旧 TX 排队冲突。峰值不得超过现有持续 IQ_LIM，不提高任何限制。
- OPEN 时先准备二进制解析，再原子入队精确的 ASCII OK 行；它在同一 FIFO 中先于 STATUS。旧 ASCII 回复及 JustFloat 的入口在会话期间屏蔽。
- DATA 按完整帧提交，不覆盖未播放数据。重复不重写，gap 不改 ACK，短 DATA 后拒绝新的 DATA，END 严格匹配累计 ACK。CRC 错用当前会话 sid 回复 CRC_ERROR，不信任损坏帧中的 sid，也不刷新输入 watchdog。
- DATA/控制帧响应和状态变化优先 STATUS，周期 STATUS 为 20 ms。TX 满时保留一个待发送状态并重试，累计 ACK 合并反馈，未使用无界消息队列。
- PAUSE 从收到指令起冻结 PCM 读取和进度，保留最后的音频值做 5 ms 淡出；RESUME 做 5 ms 淡入。END 在暂停期间只记录结束，恢复后 DRAINING；短于 800 样本的文件 END 后可播放。人工淡出不计 played_samples。
- ABORT、300 ms 失联、故障、DMA 丢失立即关闭原子 gate；FOC ISR 清 PWM，原应用关断 DRV。不能依靠淡出来替代安全停止，也不能自动回 PLAYING。新会话必须重新 OPEN。
- EXITED 完整帧入队后，应用等待 TX drain、丢弃同一输入批次残留再恢复 ASCII。迟到的完整二进制包在 ASCII 模式被丢弃，避免其 PCM 中的打印字符变成命令；同 sid 的重复 EXIT 可重新回复 EXITED。连续 2 s 无有效输入自动恢复 ASCII。
- 音频会话跳过用户 TIMEOUT_MS，未修改其 RAM/Flash 值；退出后恢复原 watchdog 并重新计时。非音频模式保持原行为。
- 外部 CAN 电流/模式/速度/位置/MIT/AE 的应用入口先停止音频和驱动，再按原命令流程处理。HALTED/FAULT 不会再把后续参数 setter 当作新播放；UART 音频会话仍应由主机 EXIT。音频期间 CAN STOP/ESTOP 不受 AE 的忽略停机策略屏蔽；显式 Disable 同时清除运行时 AE，防止下一拍自动重新使能。非音频模式保持原 AE 策略。

## 经用户确认的实现解释

冻结字段与定时不变。对“近零”和“禁止直流”未规定算法的部分，2026-10-14 用户确认以下策略：

1. OPEN/运行 gate 要求 `|control_current_test_iq_ref_a| < 0.001 A` 且 `|foc.iq_ref_a| < 0.05 A`。
2. 消费到连续 **800 个相同非零 PCM**（100 ms 有效播放时间）立即 SAFETY_FAULT；零值不触发，暂停不计时间。此保护识别持续常值，不代替上位机对带变化音频的 DC 去除。
3. 错误帧的 sid 不可信时，CRC_ERROR 使用当前有效会话 sid 回复。

## 保护分析

| 条件 | 注入/驱动动作 | 反馈与原保护 |
| --- | --- | --- |
| PCM 空、尚未 END | 当拍输出零，60 ms 连续空后关断 | HALTED / UNDERRUN |
| 300 ms 无有效输入 | 关闭 gate、Disable | HALTED / TIMEOUT，2 s 回 ASCII |
| UART 错误、DMA 覆盖或接收失效 | 关闭 gate、清 parser/PCM、Disable | HALTED / PROTOCOL_ERROR |
| 编码器超过既有 2 ms 有效窗口 | ADC 回调关闭 gate、PWM/DRV | SAFETY_FAULT；原 FaultManager 锁存保留 |
| ADC 采样/IRQ 停滞超过 2 ms | 1 kHz 主循环关闭 gate、Disable | 原 CurrentSense 故障锁存，SAFETY_FAULT |
| 相电流超过原 3.5 A | 既有 ISR TripOvercurrent，加音频关断 | 原 trip 与 fault latch，不提高阈值 |
| 音频时 D/Q 非有限或超过 3.5 A、开环/角度覆盖 | ISR 关断 | SAFETY_FAULT |
| 欠压 | 既有 ISR Enable(0)，关闭音频 | 原母线阈值和 latch |
| DRV fault、过压、主 gate 不通过 | 原 1 kHz 安全路径中止、Disable | 原 fault latch 与 SAFETY_FAULT |
| CAN STOP / ESTOP | 直接原 Disable，gate 归零 | HALTED / CANCELLED |
| 外部目标/模式改变 | 先关闭音频并 Disable | MODE_CHANGED；不会恢复音乐 |
| 持续非零常值 | 100 ms PCM 消费后关断 | FAULT / SAFETY_FAULT |

额外峰值上限为 0.2 A，D 轴独立限幅至 amp，合成矢量不超过已有 effective iq_limit_。过载预算使用音频峰值的保守需求，并在音频时计入实测 D/Q 矢量；无音频时仍使用原来的 Iq 需求。Flash、IQ_LIM/OL_IQ、PI、20 kHz 调度保持原值。

## 已通过的软件验证

测试命令和完整日志保存在 `logs/audio_uart_v1_20261014/`。

- C++ 与 TypeScript 编解码逐字节匹配同一份 113 组向量；CCITT-FALSE `123456789 → 0x29B1`。
- 实际生产 UART handler 的主机编译测试：OPEN 拒绝条件、任意切片/DMA 跨环、PCM 含打印命令/同步字节/换行、ASCII/BINARY 互斥、EXIT drain、迟到包、外部控制中止、DMA 覆盖。
- 实际生产 FOC OnPwmUpdate 编译测试：D/Q 路由、矢量限制、基线不累积/不改遥测、STOP、过流、欠压、原齿槽叠加。
- ACK/credit/重复/gap/stale sid/BUFFER_FULL、暂停/恢复/END/短文件/ABORT/EXIT、TX 满重试、300 ms/60 ms/2 s、常值保护与真正并发 SPSC 多次绕环。
- 5 分钟、6,000,000 个 20 kHz 模拟 tick，消费恰好 2,400,000 样本，欠载 0；每完整有效播放秒消费 8000，进度不依赖 UART burst。软件模型没有验证真实 IRQ deadline。
- 原配置/Flash 格式、COG UART/工具/控制、过载 82 项、位置控制、CAN 速度/位置回归通过。上位机 302 项测试及类型检查通过。
- 实机工具 STATUS parser 使用公共 STATUS 向量，并验证坏 CRC、同步字损坏和缺失帧尾后的重新同步；损坏帧不用于更新 ACK/credit。

当前 ID2 Release：Flash **93,452 B**（124 KiB 应用区）；RAM **23,768 B**，已包含 **8708 B heap/stack/alignment**，其中栈 8192 B、堆 512 B；RAM 余量 **9000 B**。相对 3.3.0/230400 的 Flash 83,040 B、RAM 17,312 B，增量为 Flash 10,412 B、RAM 6456 B。交接书将 size 的 bss 再加栈预算会重复计算，以上以 ELF 分节/链接图为准。

## 实机短测（2026-10-14）

用户已人工确认固定电机、无危险负载且急停可用，并随后要求声音小一点。最终采用 **5 mA OPEN 峰值上限**、300 Hz、Q/D 各 1 秒，PCM 峰值 16000/32768，音频给定峰值约 **2.44 mA**；这不是实际相电流的测量值。母线约 23.9 V。

烧录前备份完整 Flash、4 KiB 配置页和当前全部参数，临时保存 BOOT_MODE=0、BOOT_AE=0 防止复位自动使能。3.4.0 ID2 ELF 烧录逐段核验通过，烧录前后的预备配置页逐字节相同。测试后恢复所有参数，包括原 BOOT_MODE=1、BOOT_AE=1，保存后再次 STOP；这些上电参数在下次重启时仍按原配置生效。最终 UART 确认 IDLE、drv=0、ae=0，SWD 确认 PF0 驱动使能位为 0，fault/latched/trips 均为 0；TCH、TRATE、TELEM、电流/过载/watchdog 参数均恢复。电机校准保持 zero=0.134657、dir=1、pp=14，齿槽表 valid/match=1、CRC=0x0BECE80E。

| 成功短测 | ACK | played_samples | underrun_count | 状态 | 被识别并丢弃的损坏 STATUS |
| --- | --- | --- | --- | --- | --- |
| Q，1 s / 5 mA | 50 | 8000 | 0 | FINISHED / ENDED | 3 |
| D，1 s / 5 mA | 50 | 8000 | 0 | FINISHED / ENDED | 4 |

**通信稳定性存在限制。** 初始 Q 测试工具遇到损坏 STATUS 就报错停机；根据接收到的坏帧，补上丢弃和重新同步，并加入回归测试。D 的首次尝试在 played=184 时遇到接收保护，固件进入 HALTED / PROTOCOL_ERROR，随后 EXIT/STOP 确认停机；重试完成 8000 样本。原始收包和失败报告均保留。这些错误的物理/驱动原因尚未定位，成功短测不代表串口无错误或已完成长期通信稳定性验收；同步字损坏后直接跳过的数据不一定计入上表。

既有 `current_isr_max_cycles` 计数器在固件启动至双轴测试及清理结束的观察区间记录最大 **6552 cycles / 170 MHz = 38.54 µs**，低于 50 µs 周期。其范围是 `ApplicationController::OnCurrentSample` 内 DWT 起止之间的电流回调，含转子更新、FOC 与编码器触发，不含 HAL DMA/ADC 分发及 IRQ 入口/出口；不能将其当作完整 IRQ 最坏执行时间证明。没有实际音质、机械零位移或绝对急停延迟的测量。

证据：`logs/audio_uart_v1_20261014/hardware-flash.log`、`before-flash.json`、`after-flash.json`、`hardware-q-attempt4.json`、`hardware-d-attempt1.json`、`hardware-d-attempt2.json`、`hardware-final.json` 和对应 `.rx.bin`。测试工具不 SAVE，只恢复临时参数；上电配置的临时保存与恢复由烧录流程完成。复现须人工确认安全条件，再运行：

```powershell
python tools/audio_host_test.py --port COM5 --axis Q --seconds 1 --amplitude-ma 5 --out logs/audio_uart_v1_20261014/hardware-q.json --run
python tools/audio_host_test.py --port COM5 --axis D --seconds 1 --amplitude-ma 5 --out logs/audio_uart_v1_20261014/hardware-d.json --run
```

复现软件验收：`python logs/audio_uart_v1_20261014/regression.py`（本地日志工具），或按测试文件中的编译命令运行 C++ 核心，再 `python -m unittest discover -s tests -p "test_audio*.py"`、`npm test`、`npm run typecheck` 和既有 Release 构建。公共向量由 `tools/generate_audio_vectors.py` 生成；两端必须测试已固定的 JSON，不各自生成预期字节。

## ??????????

3.4.4 ID2 ?????????????????????????? `bdec81b6-5274-4bba-a764-88a20c61d24c` ????????????.raw??D ? OPEN ???? 1mA?200000 8N1?4096 ?/??12? TX?101.26625 ??????? 810130 ???ACK=5064???=0?fault=0?FINISHED ? EXITED ???? CRC ??????? INFO ? IDLE?drv=0?ae=0?UART ?????DMA??/??/?????TX??????0??????????????????CRC=0x0BECE80E?

???????? STATUS?????56?????????CRC?????? `logs/continue_task1_20261014/report.json`??????ACK/credit???????????????????????????????????????????????????????1A???????? TX ??? Flash94228B/RAM23800B?? TX ? Flash98412B/RAM27896B?
