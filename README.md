# DR4310

STM32G431KBT6 / DRV8313 的 FOC 电机控制固件，使用 MT6701 编码器，支持电流环、速度环、位置环、CAN 和 UART 通信。


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

## 目录

| 路径 | 内容 |
| --- | --- |
| `Core/` | 板级初始化、中断和 HAL 配置 |
| `Libraries/` | 控制算法、应用、硬件接口和故障管理 |
| `Drivers/` | 当前 GCC 构建实际使用的 CMSIS/HAL 文件及其许可证 |
| `cmake/` | Arm GCC 工具链和构建配置 |
| `startup_stm32g431xx.s` | 中断向量和启动代码 |
| `STM32G431XX_FLASH.ld` | Flash/RAM 布局 |

`.gitignore` 使用逐文件白名单。新增编译依赖时，需要显式更新白名单并验证全新检出能独立编译。
