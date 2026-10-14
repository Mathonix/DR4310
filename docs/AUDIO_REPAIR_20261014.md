# 音乐播放检查与修复（2026-10-14）

软件修复已完成，固件 3.4.1 已烧录，上位机已更新到 https://dr4310.233688.xyz/。完整音乐播放验收仍未通过：当前 J-Link COM5 在 230400 下记录到 UART 噪声和帧错误，驱动关闭时也可复现。用户目前没有可用的替代串口适配器，暂停功率级音乐重试；尚不能确定适配器、接线或 MCU 接收时序中哪一项导致错误。

## 已修复的软件问题

- 固件在 HAL UART 错误处理前保存错误位和次数；INFO 区分硬件错误、DMA 覆盖、迟延观测、丢失边界 IRQ 与 TX 启动失败。错误位使用本项目 HAL 定义，NE=2、FE=4。
- HALTED/FAULT 的周期和 PING STATUS 保留中止原因，避免第一次异常 STATUS 丢失后仅看到 reason=OK。公共协议格式与时限未变。
- 上位机接收行扫描上限由 400 增至 768 字节，能够解析约 410 字节的新 INFO，修复连接握手超时。
- 上位机若收到 HALTED/FAULT 且 reason=0，显示「中止原因未收到」，避免误报「正常」。
- 测试桥与浏览器实机工具支持 `--port`；默认仍是 COM5，波特率仍是 230400。

未降低 UART 错误停机、CRC、欠载或电流保护要求。临时尝试的波特率分频和 GPIO 配置均已恢复，未纳入固件。

## 实测证据

文件《ある雨の日.raw》为 810130 样本、101.26625 秒。测试使用 D 轴，OPEN 峰值上限 1 mA；该数值是给定限幅，不是实测相电流。

| 测试 | 结果 |
| --- | --- |
| 初次在线音乐测试 | 播放约 1.5235 秒后中止，欠载 0、FOC 故障 0；原中止原因丢失 |
| 3.4.1 本地上位机音乐测试 | 播放约 5.85 秒，ACK 302，HALTED / PROTOCOL_ERROR；欠载 0、FOC 故障 0 |
| 该次诊断 INFO | uart_errors=1、uart_errbits=6，即噪声及帧错误；DMA 覆盖、迟延、IRQ 丢失和 TX 启动失败均为 0 |
| 驱动关闭的 ASCII 压力测试 | 3 秒发送 35476 字节，uart_errors 由 2 增至 5；末次错误位为 4，即帧错误 |

错误恢复及临时诊断实验期间还产生一次 DMA 游标重新开始后的超大无符号跨度。这是后续恢复观测，不能把它当作首次音乐失败由 DMA 覆盖导致的证据。

证据保存在 `logs/audio_fix_20261014/diagnostic-music2/result.json`、`diag-after2.json`、`idle-link-load.json`、`after-flash.json`、`final.json`。首次测试的 summary/final 位于 `logs/upper_audio_20261014/music-live/`；首次原始收包文件已被后续启动失败的尝试覆盖，不作为原始线路证据使用。

## 验证与部署

- 固件音频原生测试通过，包含中止原因保留及 5 分钟 PCM 仿真；113 组公共协议向量与生产 UART/FOC/CAN 集成测试通过，Python 音频测试共 5 项通过。
- 上位机类型检查通过，14 个测试文件、308 项测试通过。线上浏览器模拟设备流程验证播放、暂停、损坏 STATUS、末尾短 DATA、Esc 和参数恢复；该模拟测试不证明物理串口可靠性。
- Cloudflare Worker：`dr4310-233688`，部署版本 `fa288c4f-285c-4e52-9cf3-e635ca411544`。线上 `/app.js` 与本地构建 SHA256 一致：`e115bdd7e7cc12c1ec647ad89ab91224aa3c22e634f01d02b168f628120999f5`。
- 已烧录 ID2 ELF SHA256：`a78c29daed823361cfa3e77352db240ef315bba0aac820dbaebe738512e12d0a`，Flash 93892 B、RAM 23800 B。烧录流程逐段校验通过，预备配置页逐字节保持一致。

最后实机核对为 IDLE、drv=0、ae=0、fault/latched=0。校准 zero=0.134657、dir=1、pp=14，齿槽表 CRC=0x0BECE80E、valid/match=1，原参数已恢复并保存。原 BOOT_MODE=1、BOOT_AE=1 已恢复，下次重新上电仍按原自动使能配置运行。

## 下一步验收

取得支持 230400、3.3V 电平的 USB-TTL 后，断开 J-Link 的 UART TX/RX，保留 SWD；适配器 TX 接 PB7、RX 接 PB6，GND 共地。首先在驱动关闭时做链路对照，再用同一 RAW、D 轴 1 mA 验证完整播放。成功标准为 FINISHED、played_samples=810130、ACK=5064、欠载与故障为 0，并完成 EXIT/STOP 和参数恢复。当前未达到该标准。
