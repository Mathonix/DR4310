# DR4310

STM32G431KBT6 / DRV8313 的 FOC 电机控制固件，使用 MT6701 编码器，支持电流环、速度环、位置环、CAN 和 UART 通信。

当前源码版本 3.2.0。`POS_VFF` 是位置轨迹速度前馈系数（0–1，默认 1）；0 关闭前馈，0.5 使用一半，1 使用全量。位置环仍串联速度环和电流环：`速度给定 = clamp(位置 PID + POS_VFF × 轨迹速度, ±POS_VLIM)`。轨迹参考独立于反馈推进，关闭前馈后纯 PID 仍有有效的位置误差。Ki 改为 0 时清除位置积分。

串口连接上位机后，在「参数配置 → 驱动参数 → 位置环」修改系数，点「写入」立即作用于 RAM；停机后点「同步」保存到 Flash。固件也支持 `SET POS_VFF 0` / `GET POS_VFF`。旧 v1–v4 配置迁移为 1，v5 保存时保留显式的 0 和原校准。新记录长 176 字节，旧固件不认识 v5；降级前请导出设置并保留校准记录。

`IQ_LIM` 是持续电流上限（0–2.5 A）。超限参数 `OL_EN`、`OL_IQ`、`OL_TIME_S` 的范围、2.80 A 硬上限和预算算法见 `docs/UART_PROTOCOL.md`。

## 编译环境

- CMake 3.22 或更新版本
- Ninja
- Arm GNU Toolchain（`arm-none-eabi-gcc`、`arm-none-eabi-g++` 等工具加入 `PATH`）

无需安装 STM32CubeMX，也无需下载额外的固件库。

## 编译

```sh
git clone https://github.com/Mathonix/DR4310.git
cd DR4310
cmake --preset Release
cmake --build --preset Release --parallel 8
```

输出文件：`build/Release/4310_G431KBT6.elf`。20 kHz 电流环实际运行请使用 Release；Debug 使用 `-O0`，用于调试。

默认电机 CAN ID 为 `2`，可在配置时指定 `1` 至 `7`：

```sh
cmake --preset Release -DMOTOR_CAN_ID=3
cmake --build --preset Release --parallel 8
```

生成 HEX 或 BIN：

```sh
arm-none-eabi-objcopy -O ihex build/Release/4310_G431KBT6.elf build/Release/4310_G431KBT6.hex
arm-none-eabi-objcopy -O binary build/Release/4310_G431KBT6.elf build/Release/4310_G431KBT6.bin
```

## 回归测试

外环及配置回归测试（本机需 GCC/G++ 和 Python）：

```sh
python tests/test_position_control.py
gcc -std=c11 -Wall -Wextra -Itests/stubs -ILibraries/App/inc -ILibraries/Control/inc -DMOTOR_CAN_ID=1 tests/test_uart_config.c Libraries/App/src/store_record.c Libraries/App/src/ascii_util.c Libraries/App/src/device_config.c -lm -o test_uart_config
./test_uart_config
```

外环测试使用生产位置路径和带速度滞后的理想模型，不替代电机实测。

## 烧录与校准工具

安装 Python 工具依赖后，可以通过 J-Link 编译并烧录指定 ID 的固件：

```sh
python -m pip install -r requirements-tools.txt
python tools/build_flash_motor.py --motor-id 1
python tools/build_flash_motor.py --motor-id 1 --flash --serial-port COM5 --jlink-serial 29534567
python tools/calibrate_motor.py --serial-port COM5 --jlink-serial 29534567 --out logs/calibration-result.json
```

按实际硬件修改串口、J-Link 序列号和 DLL 路径（`--jlink-dll`）。烧录前停止电机并断开上位机串口；校准会使转子对齐和缓慢转动，复位验证时需关闭已保存的上电自动使能。工具会保留配置页并读回校验。`position_hardware_test.py` 和 `observe_zero_current.py` 是本次 COM5 / ID 1 台架脚本，换用其他台架时需调整脚本中的连接设置。

协议说明见 [UART_PROTOCOL.md](docs/UART_PROTOCOL.md) 和 [CAN_USAGE.md](docs/CAN_USAGE.md)。v3.2.0 的功能及实机记录见 [POSITION_VFF_20261011.md](POSITION_VFF_20261011.md)、[FLASH_TEST_20261011.md](FLASH_TEST_20261011.md) 和 [NEW_MOTOR_FLASH_TEST_20261011.md](NEW_MOTOR_FLASH_TEST_20261011.md)。原始采样和 Flash 备份保留在本地 `logs/`。

## 目录

| 路径 | 内容 |
| --- | --- |
| `Core/` | 板级初始化、中断和 HAL 配置 |
| `Libraries/` | 控制算法、应用、硬件接口和故障管理 |
| `Drivers/` | 当前 GCC 构建实际使用的 CMSIS/HAL 文件及其许可证 |
| `cmake/` | Arm GCC 工具链和构建配置 |
| `docs/` | UART、CAN 与上位机调试协议 |
| `tests/` | 不依赖硬件的控制及配置回归测试 |
| `tools/` | 编译、烧录、校准与串口/SWD/CAN 工具 |
| `upper/` | Cloudflare DR4310 上位机源码、构建配置和测试 |
| `startup_stm32g431xx.s` | 中断向量和启动代码 |
| `STM32G431XX_FLASH.ld` | Flash/RAM 布局 |

`.gitignore` 使用逐文件白名单。源码、协议、测试和选定工具纳入版本控制；构建产物、虚拟环境、日志、Flash 备份及本地配置保持忽略。新增编译依赖时，需要显式更新白名单并验证全新检出能独立编译。

上位机源码位于 [upper/](upper/README.md)。在该目录执行 `npm ci`、`npm run build:client`、`npm run typecheck` 即可安装依赖、生成浏览器包并检查类型；Cloudflare 部署配置为 `upper/wrangler.jsonc`。

GitHub Pages 上位机：<https://mathonix.github.io/DR4310/>。`npm run build:pages` 可生成静态站点，`main` 上的上位机源码更新由 `.github/workflows/pages.yml` 自动构建、测试和发布。
