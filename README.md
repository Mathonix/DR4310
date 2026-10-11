# DR4310

用于 DR4310 电机的 FOC 控制与调试，硬件为 STM32G431KBT6、DRV8313 和 MT6701。

- 电流、速度、位置和 MIT 控制。
- CAN、GM6020 兼容协议和 UART 串口通信。
- PID、电流限制、轨迹速度前馈与参数保存。
- 编码器校准、位置设零和故障保护。
- `upper/` 提供网页上位机，用于运动调试、参数配置、实时曲线和日志导出。

[GitHub Pages 上位机](https://mathonix.github.io/DR4310/) · [Cloudflare 上位机](https://dr4310.233688.xyz/)
