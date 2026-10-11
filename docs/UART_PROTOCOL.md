# 串口（UART）协议与电机设置 —— 固件 v3.2.0

> 适用工程：`4310_G431KBT6_CurrentAccelLoop`（DR4310 / STM32G431KB FOC）
> 上位机：<https://dr4310.233688.xyz>（Chrome/Edge，Web Serial）
> CAN 0x100 / 0x400 / 0x500 / 0x180 帧格式与本文件无关，逐字节保持不变。

## 变更记录

### 3.2.0

- 新增 `POS_VFF`，0–1，默认 1，GET 顺序追加在 `MAX_MOD` 后。0 关闭轨迹速度前馈，0.5 使用一半，1 全量；RAM 写入后立即生效，空闲时 SAVE 可持久化。
- 位置模式仍是位置 PID → 速度 PID → 电流 PI 串级结构。速度参考为 `clamp(位置 PID 输出 + POS_VFF × 轨迹速度, ±POS_VLIM)`。
- 轨迹位置参考不再每毫秒重置为实测位置，反馈用于进入模式时初始化参考。限速及限加速度的规划能独立推进，POS_VFF=0 时 PID 仍能跟踪；反向目标先减速再反向。`POS_VLIM` 修改也会更新规划器限速。
- `POS_KI` 改为 0 时清除积分。位置 Kp/Ki/Kd 和前馈全部为 0 时位置环速度给定为 0；下游速度/电流环仍会制动已有运动，不能据此判断 PWM 必须为 0。
- Flash 写入升到 v5（176 字节，配置 152 字节），旧 v1–v4 默认 POS_VFF=1 并保留校准和参数。v5 中合法的 0 原样恢复。

### 3.1.1

电压圆限幅的最大调制比做成可保存参数。记录长度和版本仍是 v4（168 字节）。

- 新增 `MAX_MOD`，范围 0.5–0.99，出厂 0.99。`GET` 顺序接在 `OL_TIME_S` 之后。`vmax = MAX_MOD * Vbus / √3`（`CUR_VLIM=0` 时）。
- 数值放在 v4 配置末尾原来的 `ol_reserved[4]`，按 float 存。旧 v4 记录这里是 0；v1–v3 迁移后也是 0。读到 0、非数或超出 0.5–0.99 时按 0.99 装入，不把整条记录判为无效。
- 相占空比上限 `kDutyMax` 从 0.98 调到 0.995，与 0.99 在六边形顶点的占空比 `0.5 + MAX_MOD/2` 一致。下限仍是 0.02。

### 3.1.0

最大电流与超限（过载）模式。应答只在原字段后面追加。CAN 帧字节不变，20 kHz 相电流硬跳闸不放宽。

- `IQ_LIM` 仍是持续电流上限，范围 0–2.5 A。出厂 2.5 A。
- 新增 `OL_EN`（0/1，出厂 0）、`OL_IQ`（A，必须 ≥ `IQ_LIM`，且 ≤ 硬上限 2.80 A）、`OL_TIME_S`（0–10 s，出厂 2；0 等于关闭）。`GET` 顺序接在 `CUR_RAMP_MS` 之后。
- `SET OL_IQ` 低于当前 `IQ_LIM`，或高于 2.80 A，返回 `@ERR SET range OL_IQ 0..2.8`。把 `IQ_LIM` 调到超过 `OL_IQ` 时，固件把 `OL_IQ` 抬到新的 `IQ_LIM`，应答仍只回显 `IQ_LIM`。
- 有效 Iq 钳位由 1 kHz 外环的预算器给出，速度、位置、电流、MIT 共用。`OL_EN=0` 时有效钳位就是 `IQ_LIM`，与 3.0.1 相同。
- Flash 记录升到 v4（168 字节）。v1/v2/v3 仍能读：`OL_EN=0`，`OL_IQ` 取该记录里的 `IQ_LIM`，`OL_TIME_S=2`。非法的旧 `IQ_LIM` 不会被改成合法值。
- `INFO` 在 `can_fb` 后追加 `ol=`。可选遥测增加下标 28 `OlBudget`。默认 16 路 JustFloat 不变。下标 25 `IqLimit` 仍是持续电流 `IQ_LIM`。

### 3.0.1

安全修订。应答字段只在原有字段后面追加，已有字段的顺序和含义不变。CAN 帧字节不变。

- `DEFAULTS`、`RELOAD` 与 `SAVE` / `REBOOT` 一样，只允许在空闲且驱动关闭时执行。否则 `@ERR DEFAULTS not_idle`、`@ERR RELOAD not_idle`。运行中也不会改零点、母线阈值和电机模型。
- 运行中拒绝 `SET ZERO_OFFSET`、`SET ENC_DIR`、`SET POLE_PAIRS`、`SET RS`、`SET LS`，应答 `@ERR SET not_idle`。这些键会改位置坐标系或电机模型（后两个下次上电才进换相，仍拒绝，避免和正在转的电机不一致）。`KT`、`GEAR_RATIO`、增益、爬升时间和母线阈值仍可在运行中修改；母线改出窗口会按保护停机。
- `VBUS_MIN` 下限改为 6 V，不能再设成 0 去绕过欠压使能。`VBUS_MAX` 上限改回 40 V（本板原来的过压门限）。出厂值仍是 6 V / 40 V。使能、开环电压底、20 kHz 电流中断里的欠压关断、参数辨识，都用 `max(6 V, VBUS_MIN)`。
- `SPD_RAMP_MS` / `CUR_RAMP_MS` 大于 0 时，定时爬升结束之后仍受原来的 10000 rad/s² 和 10000 A/s 限制，取更慢的那个。1 ms 不能再一步跳完。`POS_RAMP_MS` 大于 0 时，轨迹目标每毫秒最多走 `POS_VLIM × 1 ms`，轨迹发生器的加速度限制仍然有效。设为 0 时这三条都与 v3.0.0 相同。
- 机械零点是编码器单圈相对零点。`INFO` 在原字段后追加 `zturn=1`。多圈位置断电丢失是单圈编码器的硬件限制，`GEAR_RATIO` 不恢复它。
- `@OK SETZERO` 在原有 `zero=` 之后追加 `saved=0`。仍只改 RAM，要 `SAVE` 才掉电保留。
- 编码器尚未就绪时，串口 `POS` / `MIT` / `MODE POSITION|MIT` 返回 `@ERR <命令> enc_not_ready`，不切换模式。CAN 的位置帧、进入 MIT、切到位置/MIT 被忽略，保持原来的模式（空闲就仍是空闲），不新增故障位。上电位模式会等到第一帧有效编码器再进入，目标用 `BOOT_TARGET`。若模式已经切入但还没有位置，编码器就绪的那一拍把目标对齐到当前位置，不追旧目标。
- `RS` / `LS` 先在主循环组好新模型，再关中断一次性写入，20 kHz 中断不会读到写了一半的结构体。
- 故障快照改在置锁存位的同一处采集，在停机处理之前。20 kHz 中断只保留原来的过流跳闸，不在中断里做快照。
- 按已保存的 `CAN_BAUD` 重新初始化 FDCAN 失败时，不再进 `Error_Handler`。退回 CubeMX 的 1 Mbps，串口照常工作，并在启动时发 `@EVT CAN_BAUD fallback live=1000000`。`INFO` 的 `baud=` 仍是已保存的 `can_baud`，末尾追加 `can_fb=0/1`。
- 保存了总线对不上的波特率时，用串口恢复：`SET CAN_BAUD 1000000`，然后 `SAVE`，然后 `REBOOT`。

### 3.0.0

- Flash 配置记录升级到 v3（152 字节）。仍可读 v1（仅校准）和 v2（72 字节配置），校准保留，新字段取默认值。写 Flash 仍只在空闲且驱动关闭时进行。
- 新增可保存参数：`POLE_PAIRS`、`GEAR_RATIO`、`KT`、`RS`、`LS`、`ENC_DIR`、`VBUS_MIN`、`VBUS_MAX`、`ZERO_OFFSET`、`CAN_BAUD`、`SPD_RAMP_MS`、`POS_RAMP_MS`、`CUR_RAMP_MS`。`GET` 无参数时按键表顺序列出全部键，每行带 `min` / `max`，需要重启的键带 `reboot=1`。`CAN_BAUD` 额外带 `choices=`。
- 新增命令：`SETZERO`、`TLIST`、`TCH`、`TRATE`、`FAULT`。`INFO` 的 `ver` 为 `3.0.0`，并增加 `pp`、`baud`、`zoff`、`zset`。
- 过压使用故障字 bit7（`BusOvervoltage`，已有定义）。欠压仍是 bit6。阈值改为 `VBUS_MIN` / `VBUS_MAX`。
- 遥测仍是 16 路 JustFloat。默认通道顺序与 v2 相同。通道表和 `TRATE` 可 `SAVE`。
- 命令行最长由 95 改为 191 个字符，以便一条 `TCH` 写下 16 个通道名。

### 2.0.0

- 串口 ASCII 配置（`GET` / `SET` / `SAVE` / `RELOAD` / `REBOOT`）、Flash v2、运行时 CAN ID。

## 1. 物理层

| 项目 | 值 |
|---|---|
| 引脚 | USART1，PB6 = TX，PB7 = RX |
| 参数 | 115200 bps，8N1，无流控 |
| 下行（主机 → 电机） | ASCII 命令行，以 `\r` 或 `\n` 结束，不区分大小写，最长 191 字符 |
| 上行（电机 → 主机） | VOFA+ JustFloat 二进制遥测帧 + 以 `@` 开头的 ASCII 应答行 |

参数分隔符可以是空格、Tab、`=` 或 `,`：`SET CUR_KP 12`、`set cur_kp=12` 等价。`TCH` 的通道名同样用逗号或空格分隔。

## 2. 上行数据流：遥测帧与文本应答如何共存

固件只用一个 1 KiB 的发送字节队列，**每次入队都是整条**（整帧或整行），因此文本应答永远不会插在一帧 JustFloat 的中间。

* **JustFloat 帧**：16 × float32（小端）+ 帧尾 `00 00 80 7F`，共 68 字节。默认 100 Hz（`TRATE` 可改）。仅在队列占用低于 3 帧时才入队（遥测在拥塞时丢帧，应答不丢）。
* **应答行**：以 `@` 开始、以 `\n` 结束的可打印 ASCII。

主机解析方法（上位机已实现）：在每个边界处，如果偏移 +64..+67 是帧尾 → 读取一帧；否则如果当前字节是 `@` → 读到 `\n` 为一行；否则逐字节向前直到重新对齐帧尾。

> 选择理由：默认 16 通道顺序与旧 VOFA+ 工程一致。VOFA+ 桌面版在收到应答行时最多丢失/错位一帧，随后自动对齐。若需要纯净波形，可 `TELEM 0` 关闭遥测再查询设置，结束后 `TELEM 1`。

### 2.1 可选通道

`TLIST` 列出全部 29 个名字。`TCH` 从中选 16 个放进 JustFloat 帧。下表前 16 项就是出厂顺序（下标 0..15）。

| 下标 | 名字 | 含义 |
|---|---|---|
| 0 | `IdRef` | Id 给定 (A) |
| 1 | `Id` | Id (A) |
| 2 | `IqRef` | Iq 给定 (A) |
| 3 | `Iq` | Iq (A) |
| 4 | `VdUnsat` | Vd 限幅前 (V) |
| 5 | `VqUnsat` | Vq 限幅前 (V) |
| 6 | `VdSat` | Vd 限幅后 (V) |
| 7 | `VqSat` | Vq 限幅后 (V) |
| 8 | `Vbus` | 母线电压 (V) |
| 9 | `Vsat` | 电压饱和标志，0 或 1 |
| 10 | `Omega` | 机械角速度 (rad/s) |
| 11 | `DutyA` | 占空比 A |
| 12 | `DutyB` | 占空比 B |
| 13 | `DutyC` | 占空比 C |
| 14 | `CurKp` | 电流环 Kp |
| 15 | `CurKi` | 电流环 Ki |
| 16 | `Ia` | A 相电流 (A) |
| 17 | `Ib` | B 相电流 (A) |
| 18 | `Ic` | C 相电流，`-(Ia+Ib)` |
| 19 | `Vd` | Vd (V) |
| 20 | `Vq` | Vq (V) |
| 21 | `Rpm` | 机械转速 (rpm) |
| 22 | `PosRad` | 位置反馈 (rad)，已减去零点 |
| 23 | `ElecAngle` | 电角度 (rad) |
| 24 | `Power` | 电磁功率估计 (W)，见下 |
| 25 | `IqLimit` | 持续电流上限 `IQ_LIM` (A)，不是超限时的有效钳位 |
| 26 | `Fault` | 锁存故障字的低 16 位，浮点数值 |
| 27 | `Mode` | 当前运行模式编号 |
| 28 | `OlBudget` | 超限预算剩余时间 (s)。关闭时停在 `OL_TIME_S` |

`Power = 1.5 * (VdSat * Id + VqSat * Iq)`。本工程 Clarke 是幅值不变形式（`iα = Ia`，`iβ = (Ia + 2·Ib) / √3`），所以功率用 3/2 而不是 1。占空比只用于显示，串口不能写占空比。

`GEAR_RATIO` 和 `KT` 不参与上述通道，也不参与控制律，只给上位机换算。

## 3. 应答格式

| 应答 | 含义 |
|---|---|
| `@OK <CMD> [细节]` | 命令成功 |
| `@ERR <CMD> <原因>` | 失败：`unknown`、`bad_value`、`missing_value`、`too_many_args`、`not_idle`、`enc_not_ready`、`unknown_key`、`unknown_channel`、`range KEY min..max`、`flash`、`no_encoder`、`bandwidth max=N`、`usage …` |
| `@P KEY=值 min=… max=… [reboot=1] [choices=…]` | 一个参数（GET 输出） |
| `@INFO k=v …` | 设备信息，一行，后面不再跟 `@OK` |
| `@PONG up=<ms>` | PING 应答 |
| `@TLIST 名字,名字,…` | 全部可选遥测通道，一行 |
| `@TCH 名字,名字,…` | 当前 16 路通道，一行 |
| `@FAULT active=0xFFFF latched=0xFFFF snap=0/1 t=<ms> fault=0xFFFF pos=<rad> omega=<rad/s> iq=<A> vbus=<V> mode=<n>` | 故障字与最近一次新故障快照。还没有快照时 `snap=0`，其余快照字段为 0 |
| `@EVT TIMEOUT disabled ms=<n>` | 主机命令超时已停机（见 TIMEOUT_MS） |
| `@EVT CAN_BAUD fallback live=1000000` | 仅启动时、且已保存波特率的 FDCAN 重初始化失败时出现。CAN 已退回 1 Mbps |
| `@ERR LINE too_long` | 命令行超长，整行丢弃 |

`INFO`、`PING`、`TLIST`、`TCH`（读）、`FAULT` 各自只回一行，不再追加 `@OK`。`TCH`（写）和 `TRATE` 回 `@OK`。`GET`（无参数）先输出全部 `@P` 行，最后 `@OK GET <数量>`。

`INFO` 字段：`fw` `ver` `id` `cfg_id` `mode` `run` `drv` `ae` `telem` `fault` `latched` `vbus` `calib` `zero` `dir` `cfg` `seq` `timeout` `trips` `drops` `up` `pp` `baud` `zoff` `zset` `zturn` `can_fb` `ol`，超限未关闭时再跟 `budget`。

* `ver` 固定为 `3.1.1`。
* `ol` 是超限状态，取值 `off` / `ready` / `active` / `recover`。`off` 不带 `budget`。其余状态带 `budget=`，秒，格式与其他浮点相同（正好 2 秒打印成 `2`，不补 `.00`）。例：`ol=off`、`ol=ready budget=2`、`ol=active budget=0.85`、`ol=recover budget=0.4`。这是上一拍 1 kHz 的状态，本行命令还没推进预算。
* `dir` 是**当前换相方向**。`GET ENC_DIR` 是已保存、下次上电才采用的方向，两者可以暂时不同。
* `pp` 是当前换相极对数。`GET POLE_PAIRS` 是下次上电的值。
* `zero` 是电角度零点（校准结果）。`zoff` / `zset` 是机械零点偏移；`zset=0` 表示位置反馈仍是未置零的展开角。`zturn=1` 表示这个零点是编码器单圈相对零点，不是多圈绝对零点。
* `baud` 就是已保存的 `can_baud`（125000 / 250000 / 500000 / 1000000）。`can_fb=1` 表示这次上电没能按它初始化 FDCAN，实际跑在 1 Mbps。
* `fault` / `latched` 是完整 16 位故障字。CAN 状态帧 0x180+id 仍只发送低 8 位，bit7 为过压。

## 4. 命令

### 4.1 运行控制

| 命令 | 说明 | 应答示例 |
|---|---|---|
| `STOP` / `IDLE` / `ESTOP` | 立即关闭功率级，进入空闲，并清除运行时自动使能 | `@OK STOP` |
| `MODE <0-4 或名称>` | 0 IDLE、1 CURRENT、2 SPEED、3 POSITION、4 MIT。位置和 MIT 在编码器未就绪时拒绝 | `@OK MODE mode=SPEED` |
| `CUR <A>` | 电流模式并设定 Iq。命令先收到 ±2.80 A，再由超限预算器钳到当前有效限幅 | `@OK CUR iq=0.3` |
| `SPD <rpm>` | 速度模式，限幅 ±1000 rpm | `@OK SPD rpm=60` |
| `POS <rad>` | 位置模式，限幅 ±500 rad。目标在位置反馈坐标系里。编码器未就绪时拒绝 | `@OK POS rad=3.14` |
| `MIT p v kp kd iq` | MIT 阻抗控制。位置目标同样在反馈坐标系里。编码器未就绪时拒绝 | `@OK MIT` |
| `AE 0/1` | 运行时自动使能（不保存，用 BOOT_AE 保存） | `@OK AE ae=1` |
| `CLEAR` / `CLR` | 清除锁存故障 | `@OK CLEAR latched=0x0000` |
| `CALIB` | 电角度零点/方向校准（需空闲），完成后自动保存 | `@OK CALIB started` … `@OK CALIB done saved` |
| `SETZERO` | 仅空闲。把当前单圈机械角记为零点，位置反馈立刻变为 0。只改 RAM | `@OK SETZERO zero=1.234 saved=0` |

兼容旧命令：`RUN`/`CURRENT`（进入电流模式）、`ZERO`/`IQ0`（Iq=0，**不是**设机械零点）、`IQ x`、`KP x`（0..20）、`KI x`（0..2500）。

`SETZERO` 失败：`@ERR SETZERO not_idle`（未空闲）、`@ERR SETZERO no_encoder`（还没有有效编码器样本）。它写入 `ZERO_OFFSET` 并置 `zset=1`。`saved=0` 表示这次没有写 Flash，要 `SAVE` 才在掉电后保留。

`POS`、`MIT`、`MODE 3/POSITION`、`MODE 4/MIT` 在编码器没有有效样本时返回 `@ERR POS enc_not_ready`、`@ERR MIT enc_not_ready` 或 `@ERR MODE enc_not_ready`，模式保持不变。CAN 上对应的进入命令被直接忽略，不置新的故障位，状态帧里的模式字节仍是原来的模式。

### 4.2 查询、遥测与故障

| 命令 | 说明 |
|---|---|
| `PING` | 心跳，`@PONG up=…` |
| `HELP` | 命令列表，含 `SETZERO TLIST TCH TRATE FAULT` |
| `INFO` | 见第 3 节 |
| `GET` / `GET KEY` | 读全部/单个参数 |
| `SET KEY VALUE` | 修改参数（RAM）。`reboot=1` 的参数重启后才进入换相或 CAN |
| `TELEM 0/1` | 遥测开关（等价 `SET TELEM`）。不改变通道和频率 |
| `TLIST` | `@TLIST IdRef,Id,...` |
| `TCH` | 无参数：`@TCH` 加当前 16 个名字。`TCH Iq,IqRef,Rpm,...`（正好 16 个）写入 RAM，`@OK TCH` |
| `TRATE` | 无参数：`@OK TRATE hz=100 period_ms=10`。`TRATE 50` 设置 10..1000 的整数 Hz |
| `FAULT` | 一行 `@FAULT …`，见第 3 节 |
| `SAVE` | 保存校准 + 全部参数 + 遥测通道/频率（需空闲） |
| `DEFAULTS` | 恢复编译默认值（仅 RAM，需空闲）。否则 `@ERR DEFAULTS not_idle` |
| `RELOAD` | 丢弃 RAM 修改，重新应用 Flash（需空闲）。否则 `@ERR RELOAD not_idle` |
| `REBOOT` | 软件复位（需空闲），先发出 `@OK REBOOT` |

`TRATE` 实际周期是 `ceil(1000/hz)` 毫秒，所以实际帧率不高于请求值，100 Hz 仍精确对应 10 ms。115200 8N1 留下 20% 给应答后，预算约 9216 字节/秒；68 字节帧对应的连续上限是 135 Hz。调度器只有 1 ms 分辨率，能放进预算的最高实际帧率是 125 Hz（8 ms）。请求 136..142 会接受并跑在 8 ms；143 Hz 及以上返回 `@ERR TRATE bandwidth max=135`。

### 4.3 参数表（GET 顺序）

| 键 | 范围 | 说明 | 生效 |
|---|---|---|---|
| `CAN_ID` | 1–7（整数） | CAN 节点 ID | 重启后 |
| `BOOT_MODE` | 0–3 | 上电模式：0 空闲、1 电流、2 速度、3 位置 | 重启后 |
| `BOOT_TARGET` | ±1000 | 上电目标：A / rpm / rad | 重启后 |
| `BOOT_AE` | 0/1 | 上电自动使能 | 重启后 |
| `TELEM` | 0/1 | JustFloat 开关 | 立即 |
| `TIMEOUT_MS` | 0–60000 | 主机命令超时；0 = 关闭 | 立即 |
| `CUR_KP` / `CUR_KI` | 0–100 / 0–1e5 | 电流环 PI | 立即 |
| `CUR_VLIM` | 0–30 V | 电流环输出限幅（0 = 自动按母线） | 立即 |
| `IQ_LIM` | 0–2.5 A | 持续电流上限。速度环在允许超限时仍可积到 `OL_IQ`，送给电流环的值再按有效限幅钳位。出厂 2.5 | 立即 |
| `SPD_KP` / `SPD_KI` / `SPD_KD` | 0–10 / 0–5 / 0–1 | 速度环 PID（与 CAN 0x400+ID 同一组变量；出厂 0.25 / 0.02 / 0） | 立即 |
| `ACCEL` | 0–1e5 rad/s² | 位置轨迹加速度上限（≤0.1 时使用内置 1000 rad/s²）。不是 `SPD_RAMP_MS` | 立即 |
| `POS_KP` / `POS_KI` / `POS_KD` | 0–200 / 0–100 / 0–100 | 位置环 PID（与 CAN 0x500+ID 同一组变量；出厂 3.5 / 1.2 / 2.6） | 立即 |
| `POS_ISEP` | 0–100 rad | 积分分离阈值 | 立即 |
| `POS_VLIM` | 0–500 rad/s | 位置环速度限幅 | 立即 |
| `MIT_KP` / `MIT_KD` | 0–500 / 0–5 | MIT 默认刚度/阻尼 | 立即 |
| `POLE_PAIRS` | 1–40 整数 | 极对数。出厂 14。只在上电时复制到换相，20 kHz 中断里不再改。运行中拒绝 | 重启后 |
| `GEAR_RATIO` | 1–100 整数 | 减速比，出厂 10。只给上位机换算，不进入控制 | 立即（仅存储） |
| `KT` | 0–10 N·m/A | 转矩常数，出厂 0。不进入控制 | 立即（仅存储） |
| `RS` | 0–20 Ω | 定子电阻，出厂 1.97。写入电机模型，不自动重算 Kp/Ki。运行中拒绝 | 空闲后立即 |
| `LS` | 0–1 H | 定子电感 Ld=Lq，出厂 0.005。同上 | 空闲后立即 |
| `ENC_DIR` | 0/1 | 下次上电的编码器方向。见 4.5。运行中拒绝 | 重启后 |
| `VBUS_MIN` | 6–39 V | 欠压阈值，出厂 6。不能低于 6 V 硬门限。须满足 `VBUS_MAX >= VBUS_MIN + 1` | 立即 |
| `VBUS_MAX` | 8–40 V | 过压阈值，出厂 40，也是上限。超过则置故障 bit7 并禁止臂功率级 | 立即 |
| `ZERO_OFFSET` | ±100000 rad | 单圈机械零点。`SET` 仅空闲，并令 `zset=1`。见 4.6 | 空闲后立即 |
| `CAN_BAUD` | 125000 / 250000 / 500000 / 1000000 | 经典 CAN 波特率，出厂 1000000。见 4.7 | 重启后 |
| `SPD_RAMP_MS` | 0–60000 | 速度给定线性过渡时间。0 = 原 10000 rad/s²。大于 0 时仍不超过该斜率 | 立即 |
| `POS_RAMP_MS` | 0–60000 | 位置给定线性过渡时间。0 = 只走原轨迹发生器。大于 0 时目标每毫秒不超过 `POS_VLIM×1 ms` | 立即 |
| `CUR_RAMP_MS` | 0–60000 | 电流给定线性过渡时间。0 = 原 10000 A/s。大于 0 时仍不超过该斜率 | 立即 |
| `OL_EN` | 0/1 | 超限模式开关。出厂 0。为 0 时有效钳位 = `IQ_LIM`，与 3.0.1 相同 | 立即 |
| `OL_IQ` | 0–2.80 A | 超限电流。必须 ≥ 当前 `IQ_LIM`。出厂等于 `IQ_LIM`（2.5 A），没有余量时限幅器保持关闭 | 立即 |
| `OL_TIME_S` | 0–10 s | 超限预算满值。出厂 2。0 等于关闭 | 立即 |
| `MAX_MOD` | 0.5–0.99 | 电压圆调制比。出厂 0.99。`CUR_VLIM=0` 时 `vmax = MAX_MOD·Vbus/√3` | 立即 |
| `POS_VFF` | 0–1 | 轨迹速度前馈系数。出厂 1；0 关闭，1 全量；3.2.0+ | 立即 |

`CAN_BAUD` 的 `@P` 行包含 `choices=125000|250000|500000|1000000`。

### 4.3.1 超限模式

硬上限 `IQ_HARD_MAX_A = 2.80 A`（`Libraries/Control/inc/iq_limits.h`）。有效钳位和 `OL_IQ` 都不得超过它。选取理由：

* 低于 DRV8313 过流保护最小值 3 A，留 0.20 A。数据手册特性写 2.5 A 峰值，保护电路最差会在 3 A 动作，所以不能放到 3.00 A。
* 低于电流采样满量程 3.30 A。INA240A2 增益 50，采样电阻 0.010 Ω，即 0.50 V/A，中点 1.65 V，基准 3.3 V。2.80 A 时放大器输出 3.05 V，离上轨还有 250 mV。
* 低于固件相电流硬跳闸 `kOvercurrentTripA = 3.50 A`（`foc_control.cpp`，比较 `|Ia|`、`|Ib|`、`|Ic|`）。该阈值不改、不放宽。幅值不变 Clarke 在 Id≈0 时相峰值等于 `|Iq|`，所以 2.80 A 比跳闸低 0.70 A。
* 高于持续电流 2.50 A，超限有 0.30 A 余量。定子电阻 1.97 Ω 时铜损约 `1.5·R·Iq²`：2.50 A 约 18.5 W，2.80 A 约 23.2 W。采样电阻在 2.80 A 约 0.078 W，不是约束。

预算在 1 kHz 外环更新（`kControlDtS = 0.001`），不放进 20 kHz 电流中断。中断只使用上一拍公布的限幅。上电后第一拍之前，电流环限幅是 `IQ_LIM`。

* 预算单位是秒，满值 = `OL_TIME_S`。
* 需求 = `max(|钳位前 Iq 指令|, |实测 Iq|)`。速度/位置指令是速度环输出（上限为可超限时的 `OL_IQ`）；电流指令是爬升之后的值；MIT 指令是阻抗和，先收到 ±2.80 A。
* 消耗：需求 > `IQ_LIM + 0.02 A` 时，预算每秒减 1 秒。减到 0 的同一拍，有效钳位回到 `IQ_LIM`，进入 `recover`。
* 保持：需求落在 `IQ_LIM` 和 `IQ_LIM + 0.02` 之间时，预算不变。
* 恢复：需求 ≤ `IQ_LIM` 时，预算每秒加 `1/4` 秒。空预算回到满值需要 `4 × OL_TIME_S`。例如满值 2 s，耗尽用 2 s，充满用 8 s。
* 滞回：只有预算回到满值才允许再次超限。充到一半仍是 `recover`，有效钳位保持 `IQ_LIM`。回到满值的那一拍不消耗预算。
* `OL_IQ` 没有比 `IQ_LIM` 高出 0.02 A 以上时，即使 `OL_EN=1` 也保持 `off`，避免死区内无限时跑在略高的电流上。`SET` 仍接受 `OL_IQ == IQ_LIM`。
* 关闭 `OL_EN` 或把 `OL_TIME_S` 设为 0，会把预算停在满值（时间为 0 时停在 0）。再次打开从满预算开始。
* 恢复期间速度环输出上限仍是 `OL_IQ`，多出来的部分在环外丢掉。堵转且速度误差很大时，预算不会回升，直到给定或负载降下来。

CAN 电流命令的接受窗口是 ±2.80 A，活的钳位仍由预算器决定。MIT 打包帧里的前馈电流仍是 ±2.50 A（12 位映射不改）；`kp`/`kd` 的和可以超过 2.50 A，然后被有效限幅钳住。GM6020 电流标度仍是 ±3.0 A，进入 `SetCurrentRef` 后先收到 ±2.80 A。

### 4.4 修改 CAN ID 示例

```text
> STOP
@OK STOP
> SET CAN_ID 3
@OK SET CAN_ID=3 reboot=1
> SAVE
@OK SAVE seq=12
> REBOOT
@OK REBOOT
（重启后）
> INFO
@INFO fw=DR4310 ver=3.0.0 id=3 cfg_id=3 ...
```

CAN 硬件过滤器只在上电时配置，运行中不会切换 ID。

### 4.5 编码器方向 `ENC_DIR`

换相使用三个来源，上电时按这个顺序覆盖：

1. 编译默认方向 `1`。
2. 若 Flash 里有有效校准，改用校准记录里的 `encoder_direction`，电角度零点也来自该记录。
3. 若配置来源不是“无记录”也不是“记录非法”，再用配置里的 `ENC_DIR` 覆盖方向。电角度零点仍来自校准。

因此一份合法的 v3 `ENC_DIR` 会替代编译常量和校准记录里的方向。v1，或 v2 里还没有配置时，`ENC_DIR` 被填成校准方向，第 3 步不会把方向改回去。配置 CRC/范围非法时，**不会**用默认方向覆盖已经加载的校准方向。

`CALIB` 成功后立刻改当前换相方向，并把配置里的 `ENC_DIR` 写成同一值，避免下次上电又被旧的 `ENC_DIR` 盖掉。校准不会把尚未 `SAVE` 的 RAM 增益写进 Flash。

`INFO` 的 `dir` 是正在使用的方向。`GET ENC_DIR` 是下次上电的值。`SET ENC_DIR` 不改变当前换相。电机不在空闲时，`SET ENC_DIR` 和 `SET POLE_PAIRS` 直接拒绝（`@ERR SET not_idle`），不会留到下一次空闲再悄悄生效。

`POLE_PAIRS` 同样只在上电复制一次。改完极对数后要先 `SAVE` + `REBOOT`，再做 `CALIB`，否则校准扫过的极对数仍是旧值。

### 4.6 机械零点

位置反馈来自转子估计器的连续机械角。估计器每次上电都从编码器的**单圈规范角**（0..2π）开始，再在本次上电内展开。`INFO` 的 `zturn=1` 标明这一点。

* `zset=0`（出厂，以及 v1/v2 迁移）：CAN 状态帧和遥测 `PosRad` 等于该展开角，与 v2 相同。
* `SETZERO` 或 `SET ZERO_OFFSET`（都要空闲）：记下相对编码器单圈角的偏移，`zset=1`。上电后第一帧有效位置 = `wrap_to_±π(单圈角 − 偏移)`，不会因为上次的多圈计数而跳一整圈。`SETZERO` 把这个值选成“当前反馈为 0”。本次上电之内转过多圈，反馈继续累加。
* 掉电后再上电，单圈磁编码器不再知道转过几圈，多圈计数丢失。这是硬件限制。`GEAR_RATIO` 只给上位机换算，固件不用它把输出轴的多圈位置补回来。带减速器时，输出轴位置会差整数圈。
* 位置模式、MIT 的位置项、串口 `POS`、CAN `0x500+id` 的位置目标，在 `zset=1` 时都处在这个反馈坐标系。`POS 0` 就是回到新零点。速度环和电流环不减零点。GM6020 反馈里的角度仍是传感器原始角。
* `DEFAULTS` 会清掉 `zset`。该命令现在只在空闲时执行，所以不会在位置模式里把坐标系抽掉。

进入位置或 MIT 时，若编码器还没就绪，串口拒绝、CAN 忽略，电机保持原模式。上电 `BOOT_MODE=3` 会等到编码器就绪再进入，目标是保存的 `BOOT_TARGET`。若当时没有新的位置命令，目标被设为当前反馈。已经排队的第一条 `POS` / `0x500` 目标会在模式切入后重新交给轨迹发生器。编码器刚就绪的那一拍，如果模式已经在位置/MIT 里且没有新命令，目标对齐到当前位置，不追进入之前留下的旧目标。

### 4.7 CAN 波特率

FDCAN 内核时钟是 PCLK1 = 170 MHz（`.ioc` 中 `FDCANFreq_Value=170000000`，时钟源 `RCC_FDCANCLKSOURCE_PCLK1`）。CubeMX 的 1 Mbps 时序保持不动：

| 项 | 值 |
|---|---|
| 预分频 | 10（1 Mbps） |
| 时间份额 | 1 + TimeSeg1 13 + TimeSeg2 3 = 17 tq |
| 采样点 | (1+13)/17 ≈ 82.4% |
| SJW | 3 |

波特率 = 170 MHz / (预分频 × 17)。四个合法值对应预分频 10 / 20 / 40 / 80。固件只在 `CAN_BAUD` 不是 1 Mbps 时，于 `HAL_FDCAN_Start` 之前再调用一次 `HAL_FDCAN_Init`，只改两个预分频，不改段长，也不改 `.ioc`。运行中不改波特率。

这一次重初始化失败时，预分频退回 10（1 Mbps），不进入 `Error_Handler`，串口保持可用。启动时多一行 `@EVT CAN_BAUD fallback live=1000000`，`INFO` 里 `can_fb=1`，`baud=` 仍是 Flash 里那个没能生效的值。

若保存的波特率和总线上其他设备不一致，CAN 会没有应答，串口仍在。恢复步骤：

```text
> INFO
@INFO ... baud=125000 ... can_fb=0
> STOP
@OK STOP
> SET CAN_BAUD 1000000
@OK SET CAN_BAUD=1000000 reboot=1
> SAVE
@OK SAVE seq=13
> REBOOT
@OK REBOOT
```

`STOP` 是为了满足 `SAVE` / `REBOOT` 的空闲条件。1 Mbps 是出厂值，也是重初始化失败时的退回值。

### 4.8 指令爬升

`SPD_RAMP_MS`、`POS_RAMP_MS`、`CUR_RAMP_MS` 默认 0，行为与 v2 相同：

* 速度给定仍按 10000 rad/s² 限斜率。
* 电流给定仍按 10000 A/s 限斜率。
* 位置给定仍交给原来的轨迹发生器（速度上限 `POS_VLIM`，加速度上限 `ACCEL`）。

设为 N>0 后，CAN 和串口带来的目标变化都从**当前已经施加的值**线性走到新目标，耗时 N 毫秒。重复的相同 CAN 帧不会重新开始。时长本身被修改也会从当前值重来。线性步长若快于原来的斜率上限，实际按上限走，所以 1 ms 不能把速度或电流一步拉到终点：

* 速度：每毫秒最多 10 rad/s（10000 rad/s²）。
* 电流：每毫秒最多 10 A（10000 A/s）。
* 位置：爬升输出仍是轨迹发生器的目标。定时爬升另外把目标步长限制在 `POS_VLIM × 1 ms`。轨迹发生器自己的速度上限（`POS_VLIM`）和加速度上限（`ACCEL`，≤0.1 时为 1000 rad/s²）继续生效，实际到位时间取更慢的那个。位置模式原来没有一条与 10000 rad/s² 对应的独立给定斜率，0 ms 时仍是“目标立即交给轨迹发生器”。

时长改回 0 时，速度和电流回到上面的斜率限制，位置目标交还最终命令，之后仍由轨迹发生器限速。

爬升在 1 kHz 外环里计算，不进 20 kHz 电流中断。

### 4.9 保护与故障快照

1 kHz 环比较母线电压：低于 `max(6 V, VBUS_MIN)` 置 bit6 欠压，高于 `VBUS_MAX`（不超过 40 V）置 bit7 过压。这两个位都会阻止功率级臂起，过压属于已有的严重故障。锁存直到 `CLEAR`。开环电压缩放、20 kHz 电流中断里的欠压关断、参数辨识的母线检查，用的是同一个 `max(6 V, VBUS_MIN)`，不再有一条路径停在固定 6 V、另一条路径可以降到 0 V。

DRV8313 推荐工作电压到 60 V（绝对最大 65 V）。本固件原来的过压门限是 40 V，`VBUS_MAX` 不允许设得比它更高。默认值仍是 40 V。Flash 里若留着旧的、超出 6..40 V 窗口的阈值，上电时只把这两个数拉回窗口，其余参数保留。

新的锁存位在**置位的同一处**记下快照，此时还没有执行停机：`HAL_GetTick` 时间、当时的锁存字、位置反馈、转速、Iq、母线、进入停机前的模式。20 kHz 中断里的过流只增加跳闸计数并关断 PWM，快照仍由 1 kHz 在置过流位时读取中断留下的 Iq，不在中断里做额外工作。`FAULT` 在下一拍清当前故障字之前读取，因此 `active` 是上一控制周期的活动故障，`latched` 是锁存字，`snap=1` 的其余字段是最近一次新故障。

### 4.10 遥测与置零示例

```text
> TLIST
@TLIST IdRef,Id,IqRef,Iq,VdUnsat,VqUnsat,VdSat,VqSat,Vbus,Vsat,Omega,DutyA,DutyB,DutyC,CurKp,CurKi,Ia,Ib,Ic,Vd,Vq,Rpm,PosRad,ElecAngle,Power,IqLimit,Fault,Mode
> TCH Iq,IqRef,Rpm,PosRad,Vbus,Id,Ia,Ib,Ic,Vd,Vq,Power,Fault,Mode,CurKp,CurKi
@OK TCH
> TRATE 50
@OK TRATE hz=50 period_ms=20
> TRATE 1000
@ERR TRATE bandwidth max=135
> STOP
@OK STOP
> SETZERO
@OK SETZERO zero=0.842 saved=0
> SAVE
@OK SAVE seq=4
> FAULT
@FAULT active=0x0000 latched=0x0000 snap=0 t=0 fault=0x0000 pos=0 omega=0 iq=0 vbus=0 mode=0
```

通道选择和 `TRATE` 随 `SAVE` 写入 v3。未 `SAVE` 时重启回到默认 16 通道和 100 Hz。

## 5. 安全语义

* `SAVE`、`DEFAULTS`、`RELOAD`、`CALIB`、`REBOOT`、`SETZERO`，以及 `SET` 的 `ZERO_OFFSET` / `ENC_DIR` / `POLE_PAIRS` / `RS` / `LS`，只在完全空闲时执行（模式空闲、未自动使能、DRV_ENABLE 为低），否则 `@ERR … not_idle`。拒绝是立即的，不会留到下一次进入空闲再生效。
* Flash 擦写期间 CPU 停顿约数十毫秒，期间串口可能丢失接收字节；主机应等待 `@OK SAVE` 后再发送下一条命令。固件在保存后会重置外环计时，不会误报控制超时故障。
* `TIMEOUT_MS`>0 时：收到第一条主机命令后开始计时，任何有效串口命令（含 `PING`）、原生 CAN 帧或 GM6020 帧都会刷新；超时后停机并发送 `@EVT TIMEOUT`。自动使能、空闲与校准状态不受此超时影响。
* `BOOT_MODE`≠0 且 `BOOT_AE`=1 时，**上电后电机会自行转动**；只在台架确认安全时使用。
* 串口 `STOP` 是真正的停机，会同时清除运行时自动使能（CAN 原生协议行为不变）。
* 母线不在 `[max(6 V, VBUS_MIN), VBUS_MAX]` 内时不臂功率级。`VBUS_MAX` 最大 40 V。把阈值收到当前电压之外会在下一毫秒锁存故障并停机。

## 6. Flash 记录（v5；兼容 v1–v4）

位置不变：最后两个 2 KiB 页 `0x0801F000` / `0x0801F800`，两槽交替写，序号递增，读取时取 CRC 正确且序号最大的槽。CRC32 多项式 `0xEDB88320`，初值/结果按位取反。记录长度是 8 的倍数，按双字编程。

| 偏移 | 字段 |
|---|---|
| 0 | magic `0x43414C31`（"CAL1"） |
| 4 | version u16 = 5 |
| 6 | size u16 = 176 |
| 8 | sequence u32 |
| 12 | electrical_zero_rad f32 |
| 16 | encoder_direction u8 |
| 17 | calib_valid u8 |
| 18 | config_valid u8 |
| 19 | reserved u8 |
| 20 | DeviceConfigData 152 字节（前 72 / 128 / 144 字节与 v2 / v3 / v4 相同） |
| 172 | CRC32（覆盖 0..171） |

DeviceConfigData（相对记录起点再加 20）：

| 配置内偏移 | 字段 |
|---|---|
| 0..71 | 与 v2 相同：`can_id`、`boot_mode`、`boot_auto_enable`、`telemetry`、`cmd_timeout_ms`、`reserved0`、`boot_target`、电流/速度/位置/MIT 增益，最后是 `mit_kd`（配置内偏移 68） |
| 72 | `pole_pairs` u8、`enc_dir` u8、`gear_ratio` u8、`zero_valid` u8 |
| 76 | `kt_nm_per_a`、`rs_ohm`、`ls_h`、`vbus_min_v`、`vbus_max_v`、`zero_offset_rad`，各 f32 |
| 100 | `can_baud` u32 |
| 104 | `spd_ramp_ms`、`pos_ramp_ms`、`cur_ramp_ms`、`telem_hz`，各 u16 |
| 112 | `telem_ch[16]` u8，到偏移 128 结束 |
| 128 | `ol_en`、`ol_iq`、`ol_time_s`，各 f32 |
| 140 | `MAX_MOD` f32（字段名仍为 `ol_reserved[4]`） |
| 144 | `pos_vff` f32，0..1 |
| 148 | `pos_reserved[4]`，写入时清零 |

兼容性：

* v1（24 字节，仅校准）读入后保留校准，参数为默认值（`cfg=flash-v1`），`ENC_DIR` 取校准方向。
* v2（96 字节）保留前 72 字节配置和校准，扩展字段取默认值；若校准有效，`ENC_DIR` 取校准方向而不是编译默认。3.2.0 的 `SAVE` 写成 v5。
* 坏掉的 CRC、版本或长度整条丢弃。配置范围非法时用默认参数（`cfg=invalid`），不覆盖已加载的校准方向。
* **降级风险**：v2 固件不认识 152 字节的 v3 记录，会当作没有记录，校准和参数都回到编译默认。降级后需要重新校准并重新设置。
* 未做过校准时 `SAVE` 也会写入记录，但 `calib_valid=0`，上电仍用编译默认电角度零点。
* 3.1.1 不改变 v4 长度。配置末尾 4 字节按 float 存放 `MAX_MOD`。读到 0、非数或超出 0.5–0.99 时按 0.99 装入，其余字段保留。
* 3.2.0 保留全部 v4 前缀，追加 POS_VFF 和 4 字节预留。旧记录（包括校准保存路径）默认前馈 1；v5 的 0 不视为未设置。非法前馈值使配置验证失败，校准仍可读取。
* 3.1.1 及更早固件不认识 v5。两槽中的旧记录可能暂时还在，不能作为可靠的降级方案；降级前需备份配置和校准。

## 7. 代码位置

| 文件 | 内容 |
|---|---|
| `Libraries/App/src/store_record.c` | v1/v2/v3 记录编解码与 CRC（无 HAL，可在主机测试） |
| `Libraries/App/src/calibration_store.c` | Flash 两槽读写；校准保存时同步 `ENC_DIR` |
| `Libraries/App/src/device_config.c` | 参数表、范围、v1/v2 迁移、遥测带宽 |
| `Libraries/App/src/ascii_util.c` | 无 printf 的数字格式化、命令分词 |
| `Libraries/App/src/control_app.cpp` | 命令、零点、爬升与斜率叠加、故障快照、遥测通道 |
| `Libraries/Control/src/foc_control.cpp` | 电机模型关中断发布，ISR 欠压门限 |
| `Core/Src/main.c` | 上电读取配置、CAN ID、按 `CAN_BAUD` 重设预分频；失败则退回 1 Mbps |
| `tests/test_uart_config.c` | 主机单元测试 |

## 与 CAN 速度 / 位置帧（0x400+ID / 0x500+ID）的关系

- 帧格式未改。0x400+ID / 0x500+ID 仍是 4 个小端 uint16，会覆盖 `SPD_*` / `POS_*`。
- 0x100+id 的电流、停机、急停、0x04 设参、MIT、切模式、自动使能字节含义未改。
- 0x180+id 状态帧布局未改。位置字段改为“相对机械零点的反馈”；未置零时数值与 v2 相同。故障字节仍是锁存字的低 8 位，bit7 为过压。
- `SAVE` 保存的是当前 RAM。CAN 帧写入的增益在本表范围内，可以通过 `SAVE`。0x04 设参没有上限，超出本表时 `SAVE` 返回 `@ERR SAVE range <键名>`。
- 速度、位置、电流目标都会经过第 4.8 节的爬升（时长为 0 时保持原来的斜率/轨迹）。
- 置零之后，0x500+id 的位置目标处在反馈坐标系，`0` 表示新的机械零点。
