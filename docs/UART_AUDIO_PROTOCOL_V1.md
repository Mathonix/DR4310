# DR4310 AUDIO UART V1 — 双 Agent 共用冻结协议（规范性文档）

> 状态：**拟新增协议 / IMPLEMENTATION CONTRACT / V1 FROZEN**。它**不是** DR4310 当前固件已经支持的命令。上位机和固件 Agent 必须各自严格实现本文，不得自行更改字段、字节序、状态值、时间、错误码；如发现矛盾应提出修订并同步双方，不得静默偏离。
>
> 固定代码基线：`Mathonix/DR4310` main @ `a104bb646e1de1fbf4b3d47fea90eaceb91c0cdb`（2026-10-11）；部署路径 `upper/`。原协议参照 `docs/UART_PROTOCOL.md`，本协议为扩展，不能冒充原有协议。

## 0. 决策表（必须一致）

| 项目 | V1 冻结值 |
|---|---|
| MCU / FOC | STM32G431 / 原有 20 kHz 电流环，保持 TIM1/ADC 时序 |
| UART | USART1 PB6 TX / PB7 RX，**230400，8N1，无流控**；全双工 |
| 音频输入 | 原始 RAW PCM，无头，**8000 Hz、单声道、有符号 16 位、小端**；`0` = 静音；禁止 8 位 unsigned 直接当 s16 |
| 音频时长 | 由文件长度算出，要求长度为 2 的倍数；短文件允许（END 后不足预缓冲也要播放） |
| DATA | 每帧最多 **160 samples = 320 bytes = 20 ms**；非末帧必须 160 samples，末帧为 1–160 samples |
| 字节序 | 除 ASCII 外，所有整数、PCM、CRC 均 **little-endian** |
| 校验 | CRC-16/CCITT-FALSE，poly `0x1021`，init `0xFFFF`，refin=false，refout=false，xorout=`0x0000` |
| 协议版本 | 固定 `0x01`；错误版本直接拒绝并回复 PROTOCOL_ERROR（有有效 sid 时） |
| 接收策略 | 固件使用一个统一 USART1 RX DMA 所有者（循环 DMA），ASCII 模式与 AUDIO 模式两套解析器互斥 |
| 接收 DMA | 推荐 2048 B DMA circular（不得与原 `HAL_UART_Receive_IT` 同时启用） |
| PCM ring | **2048 samples（4096 bytes）可用容量**，guard = 128 samples，前置缓冲 = 800 samples（100 ms） |
| 窗口 | HOST 最多 **6 个未确认 DATA 帧**；credit 由 STATUS 的绝对 `grant_seq_exclusive` 控制 |
| ACK | MCU 接收每个有效 DATA（含重复包、错序包、CRC 错等）尽快发 STATUS；此外每 20 ms 发一次或状态变化立即发 |
| 心跳与安全 | 无有效 DATA/控制帧超过 **300 ms**：停止注入、功率级失能并进入 HALTED；主机空闲时每 **100 ms** PING；断连及 fault 均安全停机 |
| 轴 | Q=转矩音频、D=磁链音频；电流音频仅允许在原工程 CURRENT 模式、基线 Iq 近零、所有安全互锁通过时启动 |
| 音频峰值 | OPEN `amp_ma` 十进制整数，**1..200 mA**，默认 UI **20 mA**；固件必须复核范围和实际电流限幅 |
| UI | 现有 Web Serial/PCAN/遥测/安全停机功能保留；音频模式下独占 UART 命令发送（CAN 安全停机仍可用） |

### 带宽预算

- 230400 波特率、8N1 => 理论每向 `23040 byte/s`。
- 正常 DATA 长度：14 字节包络 + 320 字节负载 = **334 B/帧**；50 帧/秒 = **16700 byte/s（72.48% RX 链路线速）**。
- MCU STATUS 固定 38 字节/帧，若 50 次/秒为 `1900 byte/s`，USART 全双工，不占主机至 MCU 的 RX 字节预算。
- 主机**不得**按“每 20ms `setTimeout` 发一帧”当作主流控；使用 credit + 最多 6 帧 sliding window + 实时 ACK。UART 发送 `write()` 的 Promise 不是设备接收成功凭据。

## 1. 原有协议兼容策略

当前固件串口协议：ASCII `PING`, `STOP`, `RUN`, `IQ`, `TELEM`, `INFO`, `GET`, `SET`, `SAVE`, `TCH`, `TRATE` 等；MCU->HOST JustFloat 每帧 16×float32 + `00 00 80 7F`（68 B），穿插 `@` ASCII 文本。原代码接收 `HAL_UART_Receive_IT`，默认 `115200`。**固件修改后默认 UART 改为 230400**；原 ASCII/JustFloat 的语义不变，仅速率变化。

**进入音频会话（ASCII 模式）**：

1. UI 打开 230400 Web Serial；确认 INFO 与协议支持。UI 记录原 `TELEM` 状态。
2. UI 停止其它自动命令定时器/遥测请求/其它 UART 写入源；执行现有 `STOP\n`（等 `@OK STOP`）、`AE 0\n`（如适用）、`TELEM 0\n`（等 `@OK TELEM`），`RUN\n`（等 `@OK RUN`）、`IQ 0\n`（等 `@OK IQ`）。要由主机确认固件已建立 CURRENT=0，安全互锁通过；出错则不 OPEN。原 CAN 控制与音频互斥，后述安全条款适用。
3. HOST 发送 `AUDIO OPEN Q 20\n` 或 `AUDIO OPEN D 20\n`，一般形式 `AUDIO OPEN <Q|D> <amp_ma>\n`。命令不区分大小写，参数必须分别匹配轴及十进制整数 1..200。
4. MCU 仅在 CURRENT、基准电流近零、编码器/电流采样有效、无 latched fault、功率级安全就绪、无 auto-enable/校准/开环/辨识/另一个 AUDIO 会话时允许 OPEN，回复 **单行** `@OK AUDIO OPEN v=1 sid=<sid> rate=8000 bits=16 cap=2048 guard=128 prefill=800 window=6\n`；`sid` 为 MCU 分配 1..65535 的非零 u16（十进制打印）。固件在准备好 AUDIO 二进制解析后才发 OK，UI **等完整 OK 行** 才发送首帧。
5. 不满足条件回复 `@ERR AUDIO <reason>\n`，`reason` 必须来自 `unsupported|bad_arg|bad_state|not_ready|fault|busy|safety`。此时保持 ASCII 模式、不得自动使能功率级。
6. AUDIO 会话期间 **Host->MCU 只允许下面的二进制帧**，任何 `STOP\n` 等 ASCII 必须由 UI 转成 AUDIO ABORT/EXIT，不得把 PCM 送入旧 ASCII 行解析器。MCU->Host 只发二进制 STATUS，不发 JustFloat；原串口 `@` 命令应答在会话内暂停（包括自动询问）。
7. MCU 收到 EXIT 后发**最后一个二进制 STATUS(EXITED)**，发送入队之后恢复 ASCII 模式，UI 收到 EXITED 再发 `STOP\n` 并按进入前的状态恢复 `TELEM 0/1`。**不允许**自动 SAVE 原始 TELEM 状态。
8. 超时/错误恢复时，MCU 应失能后在会话连续无有效输入 **2 秒**时自动返回 ASCII 模式并清空 parser；Host 检测失败应优先停止并重连串口、用 ASCII `PING` 探测，不能猜测会话状态。

> `INFO` 里的原 `baud=` 字段表示保存的 **CAN_BAUD**，**不是 UART 波特率**！不得复用它。新增 `audio=1` 和 `uart_baud=230400` 字段（追加在 INFO 末尾，不删旧字段）。`HELP` 追加 AUDIO。现有上位机默认波特率选择改为 230400，仍可保留其他选项供旧固件使用。

## 2. 二进制封装（双方向完全相同）

```
偏移     大小  字段                      格式 / 约束
0        2     sync                      0xA5 0x5A
2        1     version                   0x01
3        1     type                      见消息表
4        2     sid                       u16 LE, 当前会话 ID
6        4     seq                       u32 LE, DATA 帧序号；其它帧填 0
10       2     length                    u16 LE, payload 字节长度
12       N     payload                   0..320 字节
12+N     2     crc16                     u16 LE
合计     14+N 字节；CRC 覆盖 [offset=2, length=10+N] 即 version..payload；不覆盖 sync 或 CRC 自身。
```

严格规则：未知 type、未知 version、`length>320`、奇数 DATA length、sid 不匹配或 CRC 错均不接受进 PCM 缓冲；长度无效时逐字节同步寻找下一 `A5 5A`；最大帧长度 334。禁止使用 `0xA5 0x5A` 定界转义：解析器应先读固定头+长度再读 CRC，PCM 内出现同步字节不得误触发拆包。

### Type 表（冻结）

| 方向 | type | 名称 | payload | seq |
|---|---|---|---|---|
| H→D | `0x01` | DATA | `1..160` 个 s16 LE（`length=2..320` 且偶数） | 从 0 开始逐帧 +1 |
| H→D | `0x02` | END | 空 | `total_data_frames` (=最后的 next_ack) |
| H→D | `0x03` | ABORT | 空 | 0 |
| H→D | `0x04` | PING | 空 | 0 |
| H→D | `0x05` | EXIT | 空 | 0 |
| H→D | `0x06` | PAUSE | 空 | 0 |
| H→D | `0x07` | RESUME | 空 | 0 |
| D→H | `0x81` | STATUS | 固定 24 字节（见下） | 0 |

只有 OPEN 应答定义 sid，其余时刻 sid 不得为 0；对于旧 session 的旧帧，忽略并在可能时回应当前 STATUS(reason=SESSION_MISMATCH)。

### STATUS payload 固定 24 字节，offset 相对于 payload

| offset | size | 字段 | 意义 |
|---|---|---|---|
| 0 | 4 | `ack_next_seq` u32 | MCU 下一个需要的 DATA 帧序号，**累计 ACK**；正常从 0 单调递增 |
| 4 | 4 | `grant_seq_exclusive` u32 | 主机可发送的 DATA seq 的**排他上界**（需要 `seq < grant_seq_exclusive`） |
| 8 | 4 | `played_samples` u32 | 已被 8k 时间基准消费的 PCM 采样数量（不含淡出产生的人工 0），用于真实进度 |
| 12 | 4 | `underrun_count` u32 | 在应播放且未收到 END 时消耗 PCM 失败的累计次数 |
| 16 | 2 | `buffer_samples` u16 | 当前 PCM 环形缓冲区中尚未消费的采样数 |
| 18 | 2 | `fault_flags` u16 | 保留原工程 `latchedFaults() & 0xFFFF` |
| 20 | 1 | `state` u8 | 状态码如下 |
| 21 | 1 | `reason` u8 | 原因码如下（事件后的下一帧可恢复 0） |
| 22 | 2 | `reserved` u16 | 固定 0，v1 不得滥用 |

`state`：`0 BUFFERING`，`1 PLAYING`，`2 PAUSED`，`3 DRAINING`，`4 FINISHED`，`5 HALTED`，`6 FAULT`，`7 EXITED`。

`reason`：`0 OK`，`1 CRC_ERROR`，`2 SEQ_GAP`，`3 BUFFER_FULL`，`4 PROTOCOL_ERROR`，`5 TIMEOUT`，`6 UNDERRUN`，`7 CANCELLED`，`8 SAFETY_FAULT`，`9 MODE_CHANGED`，`10 ENDED`，`11 SESSION_MISMATCH`。

**ERROR 反馈用 STATUS.reason，不额外定义 ERROR 帧。** STATUS 中 `ack_next_seq`/`grant_seq_exclusive` 在可恢复错误中仍有效。状态一变立刻发送，不应阻塞 20 kHz ISR（由 1 kHz/主循环发送）。

## 3. 窗口、背压、可靠性（规范性）

- `PCM_CAPACITY=2048` 个真实可用 sample，`GUARD=128` sample。`free = 2048 - buffer_samples`。
- 固件在正常 BUFFERING/PLAYING/PAUSED/DRAINING（DRAINING 不再接新数据）计算：
  `grant_seq_exclusive = ack_next_seq + floor(max(free - 128,0) / 160)`，每次 STATUS 报告。
- HOST 仅能发满足 **`seq < grant_seq_exclusive`、`seq < ack_next_seq + 6`** 的新 DATA。已发未 ACK 的重传**不另外占用 credit**。HOST 只保留至多 6 个在途帧缓存。异步串口写队列中**最多 1 个 DATA 正在等待写完成**；不把整首曲子一次性写入底层 Web Serial。
- 固件只接受 `seq == ack_next_seq` 的 DATA 并完整写入 PCM 缓冲后才 `ack_next_seq++`；`seq < ack_next_seq` 是重复包（不重复消费、回当前 STATUS）；`seq > ack_next_seq` 回 STATUS(reason=SEQ_GAP)，丢弃该包；缓冲空间不足回 BUFFER_FULL，不变更 ACK。 若 DATA 包的样本数 `<160`，视为 **最后一个 DATA**，记录 `last_partial=true`；此后再收到任何新 DATA 即返回 PROTOCOL_ERROR（重复的最后一包仍按 duplicate 幂等处理），只能等待 `END` 或 `ABORT/EXIT`。
- HOST 收到 STATUS：累计确认所有 `seq < ack_next_seq`；以最近的 `ack_next_seq` 为回退点重发未确认帧。`grant` 作为绝对排他边界，不做普通“credit--”。STATUS 乱序/重复不得使 ACK 或 GRANT 回退；当 sid 变更必须重建发送状态。STATUS(reason=SEQ_GAP/CRC_ERROR/BUFFER_FULL) 触发从 `ack_next_seq` 重新发送未确认帧，受窗口和 grant 约束；每帧至多重传 5 次，连续重试失败则 ABORT 并报错。
- `100 ms` 内 `ack_next_seq` 未推进且存在未确认数据，重传最早未确认数据。若 300 ms 无新 STATUS，主机立即停止排队并尝试 ABORT，超时进入错误 UI；不能宣称已停止驱动。
- 固件 STATUS 更新周期固定 `20 ms`（允许任务调度轻微抖动），收到 DATA/控制帧或发现校验错误、状态切换后优先响应。不得在 20kHz ISR 进行 CRC、UART 发送、动态内存分配。
- `END` 必须在所有 DATA 已被 MCU 累计 ACK **之后**发送，`seq=total_data_frames`，`length=0`；重发同一个 END 幂等。END 标识不会再有新 DATA，不等于立即停机。若 END 的 seq != ack_next_seq，返回 SEQ_GAP，保持前态。若 END 在 PAUSED 状态到达，先记录 `end_received=true` 并继续 PAUSED，RESUME 后才进入 DRAINING；END 后缓冲消费至最后一个采样，自动淡出到 0（推荐 10ms），断开音频注入并调用原工程 DISABLE/STOP，状态 FINISHED(reason=ENDED)；短于 800 samples 的音频在 END 后应立即开始读完，不能永远等 prefill。
- OPEN 后先 BUFFERING，累计至少 `800 samples` 开始 PLAYING；缓冲中不足时保持 0 电流。正常播放中，PCM 用 20kHz 相位累加器 + 8kHz 线性插值读取；不能每次 UART 到数据就改 PI 给定。
- `PAUSE`：在 BUFFERING、PLAYING、DRAINING 下先淡出 5ms，冻结 8k 播放进度和缓冲读取，进入 PAUSED；保存原状态。保持当前会话及 credit，继续接收合法未确认 DATA；`RESUME` 时淡入 5ms，回保存的 PLAYING/DRAINING；原 BUFFERING 若不足 800 samples 回 BUFFERING；若暂停期间已经收到 END 则 RESUME 转 DRAINING。只允许上述状态，其他状态返回 PROTOCOL_ERROR、不改变模式。
- `ABORT`：无论 BUFFERING、PLAYING、PAUSED、DRAINING、FINISHED，**立即停止 PCM 注入并调用原安全 Disable（不等待淡出）**、清空缓冲，状态 HALTED(reason=CANCELLED)，保持二进制解析以便等待 EXIT。重复 ABORT 幂等。上位机的急停按钮必须优先发送 ABORT。CAN 急停/原有安全故障立即作用于驱动，不能被 AUDIO 会话屏蔽。
- `EXIT`：有效 sid 下，无论当前会话状态如何，停止音频并 Disable、清空缓冲、清理 parser，发送最后 STATUS(state=EXITED)，然后切回 ASCII 接收；再由 UI 用 ASCII `STOP` 确认原协议恢复。`EXIT` 既是正常退出也是 ABORT 丢应答时的补救，必须幂等处理同一流转。
- MCU 每次接受有效 DATA/PING/PAUSE/RESUME/END/ABORT/EXIT 更新音频 watchdog。HOST 在发送暂停、文件读取、流控等待或等待 FINISHED 时每 100ms 发 PING；若 AUDIO 活动超过 300ms 没有收到任何有效帧，MCU 立即 Disable 并发 STATUS HALTED(reason=TIMEOUT)，并保持二进制接收以供 EXIT；随后 2s 无有效帧则退回 ASCII。
- 如果在 PLAYING 且尚未 END 时 PCM 空了：输出零，`underrun_count` +1；连续 60ms 没有 PCM 恢复则 HALTED(reason=UNDERRUN)、Disable（禁止保持非零的“最后一个样本”）。
- UART 错误（ORE/FE/NE/PE）、CRC 错、不可用 DMA、缓冲覆盖、编码器故障、失能、FAULT、被外部 CAN 改变控制模式、原安全锁存，均不得导致永远保持非零 audio 值；重大错误走 Disable，状态 FAULT / HALTED，适当 reason。
- 会话独占电流控制：禁止同时叠加来自 CAN / UART 的非零 CURRENT、SPEED、POSITION、MIT 目标。**固件遇到外部控制目标变化应先 ABORT+Disable，然后再按原命令策略处理**；UI 在音频期间禁止此类发令。原 `STOP` 在 ASCII 模式不变，AUDIO 模式 UART 用 ABORT/EXIT；CAN STOP/禁用仍即时有效。

## 4. 控制/电流安全

- 峰值安培 `audio_A = clamp(sample/32768.0f * amp_ma/1000.0f, -amp_ma/1000, +amp_ma/1000)`。输入 s16：`-32768 -> -1.0`，`+32767 -> +0.999969...`。
- 20 kHz 电流 PI 前独立局部 `id_cmd`,`iq_cmd`：Q 只注入 q，D 只注入 d；不把音频**回写到**原 `state_.id_ref_a`/`state_.iq_ref_a`，避免 1kHz 外环覆盖/积累。不修改 SVPWM/电流反馈。
- 允许输出的前置条件每个 ISR 都有效：`state_.enabled`、非开环、无 trip、audio gate 当前使能、CURRENT 模式、实际 d/q 电流安全、`arm_all_ok`/encoder/CurrentSense 有效（主循环发布原子 gate）；任何不满足立即输出 0 音频且安排安全停止。
- 保留原工程 `IQ_HARD_MAX_A`、瞬时相电流过流、母线阈值、过载预算、功率级失能，额外做合成矢量限幅 `sqrt(id_cmd²+iq_cmd²) <= effective_limit`，同时 d 轴需单独安全限幅 `|Id|<=amp_ma/1000 <=0.2A`，不得把负 d 轴指令放大为弱磁。默认 `IQ_LIM` 不提高。禁止静态 0Hz/直流偏置；播放完归零。
- 用户必须先固定电机、确认急停可用、无危险负载；首次仅低幅 20mA、300Hz 测试再播放音乐；真实功率级测试仅能由人工确认。

## 5. 规范性演示流程（两个 Agent 均实现）

```text
HOST -> ASCII: PING\n                       DEVICE -> @PONG up=...\n
HOST -> ASCII: STOP\n                       DEVICE -> @OK STOP\n
HOST -> ASCII: AE 0\n                       DEVICE -> @OK AE ae=0\n
HOST -> ASCII: TELEM 0\n                    DEVICE -> @OK TELEM telem=0\n
HOST -> ASCII: RUN\n                        DEVICE -> @OK RUN mode=CURRENT\n
HOST -> ASCII: IQ 0\n                       DEVICE -> @OK IQ ...\n
HOST -> ASCII: AUDIO OPEN Q 20\n           DEVICE -> @OK AUDIO OPEN v=1 sid=42 rate=8000 bits=16 cap=2048 guard=128 prefill=800 window=6\n
HOST -> binary DATA sid=42 seq=0 payload=320B    DEVICE -> STATUS ack_next=1 grant=... BUFFERING
HOST -> binary DATA sid=42 seq=1 payload=320B    DEVICE -> STATUS ack_next=2 grant=... BUFFERING
...
HOST -> binary DATA sid=42 seq=4 payload=320B    DEVICE -> STATUS ... PLAYING (prefill 800)
...
HOST -> binary END sid=42 seq=last+1          DEVICE -> STATUS DRAINING
... playback elapsed ...                       DEVICE -> STATUS FINISHED / ENDED
HOST -> binary EXIT sid=42                     DEVICE -> STATUS EXITED; resume ASCII
HOST -> ASCII: STOP\n                       DEVICE -> @OK STOP\n
HOST -> ASCII: TELEM 1\n                    DEVICE -> @OK TELEM telem=1 (only if previously on)
```

注：上面 `sid=42` 和 `grant=...` 是**示意值**，不属于固定测试向量；实际 SID 由固件生成，实际 grant 随缓冲占用变化。

## 6. 公共验收标准

1. 双方测试同一个帧头/CRC/length/LE/状态码；双方用 `protocol_vectors.json` 通过 golden vectors，不允许只测试各自的编码器。
2. 串口模拟器跨任意读块拆分帧、将多帧拼到一次 read、payload 包含 `A5 5A 00 0A 0D 40 FF` 均正确。
3. 10s、60s、5min 的 8k mono s16 音频模拟稳态吞吐；不得持续增加 pending writes、PCM ring、消息队列；欠载显示并实际停止。
4. CRC 错误、丢帧、重复包、STATUS 丢失、重复 ACK、过期 sid、错误 length、断联、暂停重启、END、ABORT、EXIT、CAN STOP、过流逐一验证。
5. 验收证明：20 kHz tick 下 8k PCM 每秒恰好消费 8000 样本（±启动/淡入边界）；播放时不修改 20 kHz IRQ 调度，不增加 ISR UART 开销。
6. 旧功能：普通 ASCII 配置、JustFloat 16ch、原 CAN 控制、原 STOP/FAULT/MODE、无 AUDIO 功能时原上位机主要页面回归通过。
7. 各 Agent 提交测试报告并说明主机/MCU 对接尚未实测时的边界；不得声称无硬件测量也能保证音质、100ms 绝对急停响应或零机械运动。

## 7. 变更控制

- `00_AUDIO_UART_PROTOCOL_V1_FROZEN.md` 为**唯一真实协议来源**。Agent 不得独立改消息 type、sid/seq、length、CRC、状态码、预缓冲、超时或 OPEN/EXIT 时序。
- 发现缺陷：给出明确冲突条款、测试重现及统一修订建议，双方确认后将协议号升为 V1.1 或 V2，并同步更新两份任务书和 golden vectors。
