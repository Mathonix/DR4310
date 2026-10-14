# DR4310

用于 DR4310 电机的 FOC 控制与调试，硬件为 STM32G431KBT6、DRV8313 和 MT6701。

- 电流、速度、位置和 MIT 控制。
- CAN、GM6020 兼容协议和 UART 串口通信（默认 200000，8N1，可编译为 230400）。
- PID、电流限制、轨迹速度前馈与参数保存。
- 编码器校准、位置设零和故障保护。
- 齿槽转矩补偿：512 点角度查表、网页发起双向低速标定、Flash 保存，默认关闭。使用方法见 [补偿与标定说明](docs/COGGING_COMPENSATION.md)。
- `upper/` 提供网页上位机，用于运动调试、参数配置、实时曲线和日志导出。
- 音乐模式：Q/D 轴电流音频、短 TX 自动协商、暂停/停止及通信故障保护。上位机可将 MP3/WAV/FLAC 等音乐本地转换为 8 kHz 单声道 S16LE RAW，下载或直接播放；Q 轴峰值最高 1 A，D 轴最高 200 mA。操作和电流限幅见 [上位机说明](upper/README.md)。

`feature/music-mode` 保存固件 3.4.4 和配套音乐上位机。标准 TX 使用 2048 样本缓冲、6 帧窗口、20 ms STATUS；默认短 TX 使用 4096 样本缓冲、12 帧窗口、100 ms STATUS。J-Link 回传仍有坏 CRC STATUS，完整 RAW 已在 D 轴 1 mA 下通过，Q 轴 1 A 尚未做实机验收。详见 [实现与测试记录](docs/AUDIO_UART_V1_IMPLEMENTATION.md)。

构建：`cmake --preset Release -DMOTOR_CAN_ID=2 -DDR4310_UART_BAUD=200000 -DAUDIO_LOW_TX_MODE=1`，随后 `cmake --build --preset Release`。将 `AUDIO_LOW_TX_MODE` 设为 `0` 可构建标准 TX。

软件验证：安装 `requirements-tools.txt` 中的 Python 依赖并提供主机 `g++` 后，执行 `python -m unittest discover -s tests -p 'test_*.py'`；进入 `upper/`，执行 `npm ci`、`npm run typecheck`、`npm test`、`npm run build:pages`。构建固件需 ARM GCC、CMake 和 Ninja。实际烧录、标定和电机播放由相应硬件工具单独发起。

[GitHub Pages 上位机](https://mathonix.github.io/DR4310/) · [Cloudflare 上位机](https://dr4310.233688.xyz/)
