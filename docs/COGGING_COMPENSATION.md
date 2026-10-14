# DR4310 齿槽转矩补偿（固件 3.3.0）

固件增加 512 点、每圈周期的补偿电流表，在 20 kHz 电流环前按角度线性插值，叠加到速度、位置和 MIT 模式的 Iq 给定。默认 `COG_EN=0`，没有测量数据时不生成补偿电流。原始电流、开环、辨识、电角度校准模式不补偿。

补偿采用角度相关转矩前馈，思路参考 [ODrive 官方齿槽补偿文档](https://docs.odriverobotics.com/v/latest/guides/anticogging.html)。本项目的实现使用原始编码器机械角度、512 点 mA 表和现有 Iq 限幅。

## 先构建与更新固件

```powershell
cmake --preset Release
cmake --build --preset Release --parallel 8
```

正常烧录只更新应用区；最后两个 2 KiB 配置页仍位于 `0x0801F000` 和 `0x0801F800`。更新后通过串口 `INFO` 确认 `ver=3.3.0`、`COG INFO` 确认 `size=512`。2026-10-13 已完成 ID2 实机烧录与标定测试，见 [实测记录](COGGING_HARDWARE_TEST_20261013.md)。

Flash 写入升级为 v6，1224 字节，每页仍能容纳一条记录。旧 v1–v5 可读取，已有校准、PID、位置前馈等保持。旧固件无法读取 v6；降级前备份参数和校准。8 KiB 栈空间已在链接脚本中预留，覆盖大表保存与嵌套读取。

## 双向低速标定

### 从网页上位机发起

使用 Chrome/Edge 打开 [Cloudflare 上位机](https://dr4310.233688.xyz/)，选择串口并以固件匹配的波特率连接，当前默认 **200000，8N1**；旧 230400 固件需选择 230400。进入 **参数配置 → 驱动参数 → 齿槽补偿标定**，确认空载、轴可连续整圈旋转、外部 CAN 控制已停止，点击 **开始双向标定**。默认每方向 0.2 rad/s、2 圈、限流 0.2 A，约需 2 分 15 秒。网页临时使用 200 Hz 遥测提高各角度点的采样覆盖，完成后恢复原遥测频率。

面板显示方向、圈数、采样数量和进度。完成后显示 512 点补偿曲线与采样覆盖，先检查，再点击 **上传并保存**；校验通过后补偿保持关闭，点击 **启用补偿并保存** 生效。支持导入/导出与命令行工具兼容的 JSON，以及上传时原表备份下载。保存会同时保存设备当前全部 RAM 参数。

网页标定会锁住其他运动和参数操作。停止按钮、Esc、页面隐藏或断线会取消扫描；连接正常时确认停止后恢复临时配置和标定前的补偿开关，保持运行时自动使能关闭。网页不恢复运动。断线由扫描时设置的 1000 ms 设备通信超时停机，旧操作不会向重新连接后的串口发送恢复命令。上传失败且尚未保存时尝试恢复原 RAM 表；SAVE 应答不明确时重新加载 Flash，并保持补偿关闭。

### 命令行工具

先完成电角度校准并确认现有速度环能稳定低速运行。标定需要空载、可连续旋转整圈的电机，转子和负载周围应留出空间；外部 CAN 控制端应暂停发运动命令，上位机应释放串口。

```powershell
python tools/cogging_calibrate.py calibrate --port COM5 --out logs/cogging_map.json --run
```

工具默认 200000，可通过 `--baud 230400` 匹配旧固件；`upload` 同样支持 `--baud`。

默认以正反各 `0.2 rad/s`（约 1.91 rpm）扫描，每个方向稳定 3 秒后采集 2 圈，约 2 分钟。临时电流限幅取 `min(0.2 A, 原 IQ_LIM)`，关闭过载与齿槽补偿，启用 1000 ms 命令超时，每 200 ms 发送心跳。只使用已有速度 PID，不自动调大增益或电流。

可调参数：`--speed 0.05..0.5`、`--current-limit 0.02..1`、`--turns 2..10`。更高速度可能导致某些角度采样不足；增加圈数或降低速度。控制增益必须先使速度跟踪稳定，不能靠增加标定电流来掩盖振荡。

标定检查故障、速度偏差、遥测丢失和电流/电压饱和；不满足条件就停机并报错。匀速质量用 100 ms 平均速度判断，避免 5 ms 编码器速度窗口的量化噪声导致角度分桶偏置；单帧速度仍受 `max(0.8, 2×扫描速度)` rad/s 保护。电流及表坐标不做这项平均。完成或异常退出时发送 STOP、确认 IDLE/驱动关闭，然后恢复电流限制、过载开关、指令爬升、通信超时和遥测配置；运行时自动使能与齿槽补偿保持关闭，不恢复运动，不执行 SAVE。连接完全断开时不能保证 STOP 应答，由临时命令超时执行停机。原始 `.raw.csv` 即使标定失败也保留采样，用于诊断触发条件。

输出包括：

- `cogging_map.json`：补偿表、校准信息和 CRC32。
- `cogging_map.json.csv`：正反向原始角度、Iq、Iq 给定、速度。
- `cogging_map.json.backup.json`：开始前的参数和遥测配置。
- `cogging_map.json.raw.csv`：全部原始采样，失败时也保留，用于检查触发原因。

两方向在同一原始角度分桶，各桶至少 4 个有效样本。取双向平均以减小方向相关摩擦及速度环延迟影响，再去掉整圈 DC 分量。每个表项单位为 mA，符号就是需要叠加的保持/驱动电流，**不要再取负号**。缺桶、非有限数、超范围数据都拒绝，不插入猜测值。外部位置相关负载、严重静摩擦、速度振荡会污染结果，因此低速稳定性和空载条件仍需实机确认。

## 上传并保存

```powershell
python tools/cogging_calibrate.py validate --map logs/cogging_map.json
python tools/cogging_calibrate.py upload --port COM5 --map logs/cogging_map.json --save
```

上传先停机，检查电角度零点、编码器方向、极对数，以及标定文件中的 CAN ID。已有有效 RAM 表会备份到 `.device-backup.json`。512 个样本分块写入，全部写满后 COMMIT，再比较整张表的 CRC32。`--save` 使用 SAVE/RELOAD 验证 Flash 回读，**仍保持 `COG_EN=0`**。SAVE 会保存当时的全部 RAM 参数，先确认这些参数是需要保留的配置。

## 启用与观察

上传后先通过串口查询并用小系数验证：

```text
COG INFO
SET COG_GAIN 0.2
SET COG_LIM 0.2
SET COG_EN 1
```

在相同低速或位置目标下比较速度波动和跟踪误差，再逐步调整 `COG_GAIN`。上位机「驱动参数 → 齿槽转矩补偿」也能配置这三项；旧固件不显示这些键。

`CogIq` 遥测是查表输出（叠加前馈）；`IqRef` 是叠加后经过总电流限幅的实际给定。启用时 100 ms 渐入；禁用、失能、模式不适用、编码器过期或校准信息不匹配时立即取消补偿。补偿有独立限幅，叠加后的总 Iq 仍遵守 `IQ_LIM` / 过载预算和现有相电流保护。零速度给定时也可以输出抵消齿槽的电流。

```text
STOP
SAVE
```

这会保存当前表与 `COG_EN/GAIN/LIM`。停用用 `SET COG_EN 0`；清除表用 `STOP`、`COG CLEAR`、`SAVE`。

## 表坐标、失效与协议

表坐标是 **MT6701 原始角度 0..2π**，与 `SETZERO`、多圈计数、上位机显示比例无关。换电机、重新电角度校准后必须重做齿槽标定；电角度校准会使 RAM 和持久化旧表失效。方向、极对数、零点不匹配时运行路径禁止旧表输出。

| 命令 | 行为 |
| --- | --- |
| `COG INFO` / `COG` | `@OK COG valid=… enabled=… upload=… written=… size=512 match=… zero=… dir=… pp=… crc=0x…`；zero/dir/pp 是当前换相配置 |
| `COG BEGIN` | 关闭补偿、使 RAM 表无效并开始上传，清空完整性位图 |
| `COG SET <起始索引> <mA>…` | 每条 1–16 项，整数 -1000..1000；整块通过范围验证才写入，重复块不重复计数 |
| `COG GET <索引>` | `@OK COG index=… ma=…`，索引 0–511 |
| `COG COMMIT` | 全部 512 项齐全才有效，绑定当前零点/方向/极对数；不启用、不保存 |
| `COG CLEAR` / `COG ABORT` | 取消上传、关闭补偿并使 RAM 表无效；Flash 不变 |

INFO/GET 可运行中读取，其余命令要求空闲且驱动关闭。上传未提交时 SAVE 返回 `@ERR SAVE cog_incomplete`。没有有效表时 `SET COG_EN 1` 返回 range 错误。CRC32 对 512 个小端 int16（1024 字节）计算，与 JSON 文件 `crc32` 一致。

离线重算 CSV：

```powershell
python tools/cogging_calibrate.py fit --csv logs/cogging_map.json.csv --binding logs/cogging_map.json.backup.json --out logs/cogging_refit.json
```

## 验证范围

主机测试覆盖周期插值、符号/限幅、失效/渐入、完整性事务、实际 UART 解析器、旧 Flash 兼容、CRC 损坏拒绝、双向数据拟合、速度量化判据和标定异常退出。Release 构建与网页 TypeScript 检查可在本地执行。低电流实机标定、开关对比、通信超时和保存重启验证见 [2026-10-13 实测记录](COGGING_HARDWARE_TEST_20261013.md)；其结果不代表满电流、带载或所有速度下的性能。
