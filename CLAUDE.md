# DR4310 FOC Controller

STM32G431KBT6 + DRV8313 + MT6701 电机 FOC 固件，配套网页上位机。

## 构建

```powershell
# 固件（需 arm-none-eabi-gcc 在 PATH）
cmake --preset Release -DMOTOR_CAN_ID=2 -DDR4310_UART_BAUD=200000
cmake --build --preset Release --parallel 8
# 烧录（自动备份校准页、逐段校验）
.venv\Scripts\python tools\build_flash_motor.py --motor-id 2 --uart-baud 200000 --serial-baud 200000 --flash
# 内存占用
arm-none-eabi-size build/Release/4310_G431KBT6.elf
```

## 测试

```powershell
# C++ 音频协议（主机编译，不依赖 HAL）
g++ -std=c++17 -O2 -pthread -DAUDIO_LOW_TX_MODE=0 -ILibraries/App/inc -ILibraries/Control/inc tests/test_motor_audio.cpp Libraries/App/src/motor_audio.cpp Libraries/Control/src/audio_current.cpp -o test_motor_audio.exe
.\test_motor_audio.exe
# Python
.venv\Scripts\python -m unittest tests.test_audio_vectors
.venv\Scripts\python -m unittest tests.test_uart_config
# 上位机
Push-Location upper
npm run typecheck
npm test
Pop-Location
```

## 架构

- **20 kHz ISR**：ADC DMA1_Ch1 → `OnCurrentSample` → `foc_.OnPwmUpdate()`（Park→电流环→SVPWM）。音频在这里以局部变量注入 D/Q 轴。齿槽补偿也在这里叠加。
- **1 kHz 节拍**：`ApplicationController::Update()` → `ConsumePeriodicTick()`（安全检查→模式解析→SetRefs→遥测→音频 gate/STATUS）。
- **主循环**：UART DMA1_Ch5 RX → 音频帧解析/CRC/ACK（故意不进 ISR）→ ASCII 命令处理。
- **ISR 只做**：门控、SPSC 环读取、整数相位重采样、限幅。CRC/STATUS/UART 入队在主循环。
- **分层**：[Core/](Core/Src/)（CubeMX）→ [Libraries/Hardware/](Libraries/Hardware/src/)（CurrentSense/MT6701/WS2812）→ [Libraries/Control/](Libraries/Control/src/)（FOC/电流环/齿槽/音频）→ [Libraries/App/](Libraries/App/src/)（control_app.cpp ~3000行/motor_audio）→ [upper/](upper/src/)（TypeScript 网页上位机）。

## 当前状态（2026-10-14）

### 固件 3.4.4 — 音频 UART V1 + 低 TX 模式

音乐模式分支 `feature/music-mode`，从已实测的 `feature/audio-uart-v1` 工作树整理，基线 `a104bb6`。固件提交 `b0809b3` 保留 3.3.0 齿槽补偿并加入 3.4.4 音频/短 TX；上位机提交 `60b7d01` 包含电流音频、本地音乐转换及完整测试。发布目标为 `origin/feature/music-mode`，该分支独立于 main。

**已实现（冻结协议 AUDIO UART V1）：**
- `motor_audio.cpp/h`：帧解析、会话、seq/credit、CRC16-CCITT、STATUS、300ms watchdog、2s 恢复 ASCII
- `audio_current.cpp/AudioCurrent.hpp`：PCM SPSC 环、8k→20k 整数相位重采样、淡入淡出、欠载保护
- `uart_dma_cursor.h`：DMA HT/TC + NDTR 游标，覆盖和迟延检测
- `control_app.cpp`：OPEN 校验、ASCII/BINARY 互斥、外部控制中止、故障/ADC/编码器 gate
- `foc_control.cpp`：局部 D/Q 注入、矢量限幅、不回写 IdRef/IqRef
- `stm32g4xx_hal_msp.c`：USART1 RX DMA1_Ch5 circular 2048B，NVIC 优先级 5
- 上位机 audio.ts + audio-panel.ts：RAW PCM 播放、ACK/credit/retry、坏帧重同步

**低 TX 模式（J-Link 兼容的 V1 帧格式扩展，容量、窗口和回传周期不同于冻结协议）：**
J-Link VCOM 在本板双向音频流下仍会损坏部分 MCU→PC STATUS；降低回传频率改善播放。正式波特率为用户已确认的 **200000**，不要恢复为 230400。
- `AUDIO_LOW_TX_MODE=1`（motor_audio.h，可 `-DAUDIO_LOW_TX_MODE=0` 关闭）
- DATA、重复帧、CRC/序号/缓冲反馈合并到 100ms 周期；控制、故障和状态切换立即回传
- 仅 NE/FE 可恢复并重启 DMA；ORE、PE、DMA、覆盖或中断边界丢失均中止
- CRC 错误不刷新 300ms 看门狗；终止原因保持，未自动重新使能驱动
- PCM 环 2048→4096 样本，credit 12→24
- 上位机/工具：重试超时 250ms、窗口 12、STATUS 超时 500ms

**实测验证（230400, J-Link COM5, 5mA, 固定电机）：**
| 时长 | 结果 | played | underruns | 损坏STATUS | uart_errors |
|---|---|---|---|---|---|
| 1s Q/D | ✅✅ | 8000 | 0 | 0 | — |
| 10s Q | ✅ | 80000 | 0 | 5 | — |
| 60s Q | ✅ | 480000 | 0 | 35 | 2 |
| 101s Q | ✅ | 808000 | 0 | 69 | — |
| 30s D | ✅ | — | 0 | — | — |

上表是 3.4.3 的历史验证。3.4.4 已烧录并在 **200000、D 轴 1 mA** 下通过生产网页播放完整《ある雨の日.raw》：810130 样本、101.26625 秒、ACK 5064、欠载/故障为 0、UART 硬件错误为 0；独立检测丢弃 42 个坏 CRC STATUS（网页坏帧计数 56）。结束后 STOP、原参数恢复并保存，齿槽表 CRC 保持 0x0BECE80E。证据在 `logs/continue_task1_20261014/report.json`，当前电机已停止。

### 三条续作的交接
- 第 1 条：短 TX 已在真实 RAW 播放中生效，3.4.4 已烧录；实机详情见上文。
- 第 2 条：可调峰值电流、普通音乐转 S16LE、RAW 下载/直接播放均已部署并验证。
- 第 3 条：音乐分支、两层 gitignore 和提交已整理；仓库保留源码、协议向量、全部回归测试及交接文档，共 241 个文件，日志、RAW 音乐、Flash 备份、生成 bundle、构建产物、依赖和凭据文件保持本地。
- 干净 Git 索引检出验证：Python 24 项、上位机 319 项、typecheck 和 Pages 构建通过。短 TX Flash/RAM 98412/27896 B；标准 TX 94228/23800 B。新检出生成的 app.js 与已部署版本字节一致。
- 本条修复：typecheck 自动生成所需 bundle；旧诊断工具从匹配 ELF 解析 SRAM 地址、先核对 Flash、失败恢复 BRR 并关闭探针；标定/位置测试工具可指定串口与 200000/230400 波特率，浏览器标定测试不再依赖旧表的固定 CRC。
- 冻结协议文档保持不变，短 TX 扩展在 `docs/AUDIO_UART_V1_IMPLEMENTATION.md` 说明。剩余硬件限制：J-Link 回传仍有坏 CRC STATUS、Q 轴 1 A 未做实机验收。

## 关键文件

| 文件 | 说明 |
|---|---|
| `Libraries/App/src/control_app.cpp` | 主应用（~3000行）：UART 命令、遥测、模式管理、音频集成 |
| `Libraries/App/src/motor_audio.cpp` | 音频协议状态机：帧解析、会话、STATUS、watchdog |
| `Libraries/Control/src/audio_current.cpp` | 20kHz PCM 消费：重采样、淡入淡出、欠载 |
| `Libraries/Control/src/foc_control.cpp` | FOC 核心：Park、电流环、SVPWM、D/Q 注入 |
| `Libraries/App/inc/motor_audio.h` | 协议常量、kLowTxMode 开关 |
| `Libraries/Control/inc/AudioCurrent.hpp` | PCM 环、kPcmCapacity |
| `tools/audio_host_test.py` | 有界实机音频测试工具 |
| `tools/build_flash_motor.py` | 构建+烧录+校验一体化 |
| `upper/src/audio.ts` | 上位机音频会话、STATUS 解析、retry |
| `protocol/protocol_vectors.json` | 113 组共享协议向量 |

## 硬件

- MCU: STM32G431KBT6（Cortex-M4 170MHz, HSI ±1%, 无 HSE）
- 驱动: DRV8313（DRV_ENABLE = PF0）
- 编码器: MT6701（SPI3 DMA）
- 电流采样: INA240 + ADC1 DMA1_Ch1
- 调试器: J-Link SAM-ICE S/N 29534567（SWD + CDC UART COM5）
- NVIC 优先级: ADC=0, SPI3=3, WS2812=4, UART_RX_DMA=5, USART1=6

## 后续可优化项

### 低 TX 模式 → 协议合规迁移

当前低 TX 模式违反冻结协议（20ms STATUS + 即时 DATA STATUS），是 J-Link 兼容的临时方案。拿到支持 230400 的 USB-TTL 适配器（FT232/CH340/CP2102）后：
1. 用 `-DAUDIO_LOW_TX_MODE=0` 编译协议合规版固件
2. 断开 J-Link UART TX/RX，保留 SWD；适配器 TX→PB7、RX→PB6、GND 共地
3. 驱动关闭时做链路对照（应为 0 错误），再跑完整 RAW 播放
4. 成功标准：FINISHED、played=810130、ACK=5064、欠载=0、故障=0
5. 验证通过后移除低 TX 模式代码或保留为编译选项

### 代码质量

- **提交整理**：音乐分支按固件/工具、上位机、交接文档分组；当前功能耦合的齿槽/音频核心保留在同一已验证固件提交内。
- **`.gitignore` 白名单**：固件音频/齿槽源码、CLAUDE.md、共享向量、诊断工具及全部软件回归已补齐两层规则。
- **build_flash_motor.py 默认波特率**：`--uart-baud` 和 `--serial-baud` 默认为用户已确认的 200000，不要恢复为 230400
- **warning 清理**：当前干净构建 main.c 有 6 个 `unused-function` warning（BoardTest_*、CAN_RxGpioDiag*、VOFA_SendMT6701Angle），可用 `__attribute__((unused))` 或条件编译消除

### 协议与测试

- **`protocol_vectors.json` 路径**：固件和上位机共用 113 组 golden vectors，路径已确认 `protocol/protocol_vectors.json`
- **低 TX 模式测试覆盖**：模式 0/1 均有原生回归与五分钟 2400000 样本模拟，低 TX 约 3001 次 STATUS；两种模式 UART/安全保护均通过。第一条结束时上位机 314 项、Python 21 项通过。
- **1A 功率级播放**：Q 轴 1A 扩展已实现并验证边界，但未做 1A 实机播放。需人工确认安全条件后用 `--amplitude-ma 1000` 测试
- **ISR 最大耗时**：`current_isr_max_cycles` 是遥测字段（JustFloat 通道），不在 INFO 里。音频播放时应有非零值，需通过遥测采集并作为交付数据

### RAM 预算

- 当前 RAM 27896/32768 B（85%），余量约 4.9 KB。PCM 环占了 8 KB（4096×2）
- 如果需要更多功能空间，可把 PCM 环缩回 2048（恢复低 TX 模式前的 credit=12），前提是 STATUS 频率能提高（比如拿到好适配器后用协议合规的 20ms）
- 栈 8 KB（`_Min_Stack_Size=0x2000`）在音频+齿槽+位置控制同时运行时可能紧张，可考虑用 `arm-none-eabi-stackusage` 分析实际栈深度

### 上位机

- **音频面板 RAW 播放**：3.4.4 短 TX 已通过实际文件完整播放，上文记录有效。
- **续作第 2 条**：增加本地 MP3/WAV/FLAC 等浏览器支持音乐转 8k 单声道 S16LE、下载 RAW、直接播放；离线转换可用。最高电流数字输入和滑块同步，按 INFO 约束 Q≤1000 mA、D≤200 mA，轴切换自动限幅。类型检查和 319 项上位机测试通过，真实浏览器三种格式转换/下载/模拟播放、短 TX 流程及手机无横向溢出通过。本条没有运行实机电机或修改固件。
- **第 2 条部署已完成**：dr4310.233688.xyz 版本 `b0838148-2c0a-4147-93c8-e2b9bfa554f3`，app.js SHA256 `bf9623b3945cedca3556f88bf6b6e06af4abc49aa407b78ee6e1bca51d01781e` 与本地构建一致。线上转换与短 TX 浏览器验证通过，记录在本机 `logs/continue_task2_20261014/`。三条续作均已处理，后续先读本文件，按新的用户指示继续。
- **GitHub Pages 同步**：Pages 工作流跟随 main；音乐分支尚未合并 main，Cloudflare 已部署上述音乐版本。
- **浏览器串口选择**：Web Serial 在某些浏览器/系统上串口选择框无法完成设备选择（交接书提到自动化浏览器测试遇到此问题）。正式网页仍直接用 Web Serial，测试用本地串口桥

### 诊断工具

- **`tools/uart_brr_sweep.py`**：BRR 扫描工具需显式 `--run --elf <与 Flash 匹配的 ELF>`，计数器地址从 ELF 解析；诊断结束后恢复原 BRR，须在电机停机条件下复位目标，再做正常 UART 验证。分支整理没有再次执行实机扫描。
- **双向链路诊断脚本**：`logs/uart_brr_sweep_20261014/` 和 `logs/uart_repair_20261014/` 保存了完整的 J-Link VCOM 诊断数据，可作为后续适配器对比基线
