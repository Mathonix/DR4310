# DR4310 网页上位机 · AUDIO UART V1

增量实现：`src/audio-protocol.ts`（协议）、`src/audio-file.ts`（文件）、`src/audio-window.ts`（流控）、`src/audio-session.ts`（会话）、`src/audio-ui.ts`（UI）；沿用现有 Web Serial/PCAN、示波器、参数页、安全停机。

## 固件与安全前提

**当前 main 固件尚未实现 AUDIO V1；仅本 PR 中上位机新增功能不意味着现有电机可以播放。** 必须先刷入另一个固件 Agent 按 `00_AUDIO_UART_PROTOCOL_V1_FROZEN.md` 实现并验收的固件，且固件 INFO 必须包含 **`audio=1 uart_baud=230400`**。原 INFO 的 `baud=` 是保存的 CAN_BAUD，不能用作串口波特率。

电机应空载、牢固固定、有可靠的独立硬件急停和功率保护，并确认周围无人员、工具或负载风险。首次应先采用 **20 mA / 300 Hz** 小信号试验。**网页不是安全保护控制器**：浏览器标签页关闭、笔记本睡眠、USB 拔线、串口写入被系统卡住时，ABORT/EXIT 可能无法到达 MCU。固件端必须保持 300 ms AUDIO watchdog、fault Disable、独立 CAN STOP 等安全机制；停机未确认时使用物理急停。不得将“播放 UI 显示 HALTED”当成硬件电流归零证据。

## 环境与构建

Chrome/Edge Web Serial、HTTPS 或 localhost，Node.js 22+/24（CI 使用 Node 24）。

```sh
cd upper
npm ci
npm run typecheck
npm run build:client
npm run test:audio
npm run dev
```

默认 UART 230400 8N1，仍保留 115200/460800/921600 用于旧固件。部署沿用项目原 Cloudflare Worker/GitHub Pages 流程；无 Python 后端或新串口设备。

## 准备 PCM 音频

音频播放器在「**调试 → 电机音乐**」。RAW 没有头信息，**无法自动从文件判断格式**；选用 8000Hz mono signed 16bit little-endian（s16le）。文件大小必须为正偶数字节，时长 = 字节数 / 16000。

```sh
ffmpeg -i music.mp3 -ac 1 -ar 8000 -acodec pcm_s16le -f s16le music.raw
```

也接受同格式 `.pcm`，或 RIFF/WAVE 中合法的 PCM 16-bit/mono/8000Hz `.wav`。WAV 会依 chunk 边界寻找 `fmt ` / `data`，不将头信息当成样本。格式不符和损坏文件会报错并禁止播放。

## UI 操作与协议流转

1. 串口以 **230400 8N1** 连接，确认为新固件；选择 RAW/PCM/WAV。
2. Q 或 D 轴，峰值 1..200 mA（默认 20mA）。点击「播放」后确认硬件安全提示。
3. 主机用 INFO 确认 `audio=1`、`uart_baud=230400`；安全停止原控制后，独占 UART，逐条发送并等待 `@OK`：`STOP`、`AE 0`、`TELEM 0`、`RUN`、`IQ 0`、`AUDIO OPEN <Q|D> <amp_ma>`。
4. 收齐 `@OK AUDIO OPEN v=1 sid=... rate=8000 bits=16 cap=2048 guard=128 prefill=800 window=6` 后，单 reader 独占切为二进制 STATUS。每帧最多160采样、320B PCM；最多6个未确认 DATA、一个底层待写 DATA。主机根据 STATUS 的累计 ACK 和绝对 grant 流控，100ms 丢 ACK 重传（上限5次），100ms PING，300ms 无 STATUS 停止新 DATA 并优先 ABORT。
5. 「暂停」等待 STATUS PAUSED，「继续」等待 PLAYING/BUFFERING/DRAINING，进度来自 MCU `played_samples / 8000`。显示 buffer samples/ms、ACK、重发、underrun 和 fault。
6. 所有 DATA 累计 ACK 后才发 END；等待 FINISHED 后发 EXIT；收到 EXITED 才改回 ASCII 并 STOP/AE 0、恢复进入前的 TELEM 0/1，不自动 SAVE。
7. 停止/急停/切页/隐藏网页/串口断联：先禁止新 DATA，优先 ABORT、EXIT，恢复 ASCII 后 STOP；串口模式无法确认时**不发裸 ASCII STOP**，关闭链路并提示使用硬件急停。CAN 安全停机仍独立运行。播放期间禁止其他 UART、CAN 普通电机控制和配置轮询。

**INFO 不含 AUDIO 能力时不会发 OPEN/DATA。** 其他参数配置、JustFloat、PCAN、旧固件正常工作路径应保持原样。

## 常见故障

| 症状 | 处理 |
|---|---|
| 固件不支持 AUDIO V1 | 检查 INFO 末尾的 `audio=1 uart_baud=230400`，别把 CAN `baud=` 当 UART |
| 无法打开串口 | HTTPS + Chrome/Edge、串口权限、USB 线、电源、串口独占占用 |
| 文件被拒绝 | 确保 RAW/PCM s16le 8k mono、正偶数长度；WAV 不能是浮点/压缩/不同采样率 |
| OPEN 被拒绝 | 原固件安全互锁、CURRENT/基线零电流、AE、编码器、电流采样、latched fault |
| STATUS/ACK 超时 | 先使用硬件急停；检查 230400 8N1、CRC、sid、串口 DMA、驱动负载 |
| underrun/fault | 不继续加大发送速率或 amp；检查流控与 MCU watchdog、功率级、CAN 竞争 |

## 测试与局限

`npm run test:audio` 包含：CCITT-FALSE、帧/STATUS roundtrip、split/噪声/CRC损坏、PCM 文件校验、20/60/300s 切片、累计 ACK/grant/窗口/丢包重传、抢占 ABORT/EXIT、模拟 60s 传输（检查 PCM 容量和无欠载）、虚拟 MCU 全链路暂停/继续/END/EXIT/ASCII 恢复。

`tests/protocol_vectors.json` 是由冻结文档字段和 CRC 算法独立计算的共享候选向量；**仍需固件 Agent 使用同一 JSON 逐字节运行 C 端 golden 测试**。CI 软件通过 ≠ MCU 实机通过，尚无物理电机、UART 信号、示波器或音质测量，急停/欠载的物理时序无法据此保证。实际构建的前端 light/dark 浏览器截图可从 PR GitHub Actions 的 dr4310-upper-audio-screenshot artifact 下载；真机录像仍需补充。

协议冲突按双 Agent 文档变更流程处理，不擅自改变 V1 号或错误码。
