# dr4310.233688.xyz — DR4310 FOC 上位机

GitHub Pages：<https://mathonix.github.io/DR4310/>。Cloudflare：<https://dr4310.233688.xyz/>。

Browser host app for the DR4310 (STM32G431KBT6 FOC) motor firmware. A Cloudflare Worker serves a static page and bundled client JS; all device I/O happens in the browser:

- **CAN**: PEAK PCAN-USB (classic, PID 0x000C) over WebUSB at 1 Mbps (`src/pcan.ts`, from webpcan-233688). On Windows, bind the device to WinUSB with Zadig.
- **UART**: Web Serial 115200 8N1, VOFA JustFloat 16 channels and ASCII commands.

The protocol is implemented in `src/protocol.ts` (matches firmware commit 657ad58: `Core/Src/main.c`, `gm6020_can.c`, `control_app.cpp`).

```sh
npm i
npm test            # vitest: frame encoders/decoders
npm run build:pages # static index.html + app.js in dist/pages
npm run typecheck   # worker + client
npm run deploy      # esbuild client bundle + wrangler deploy (custom domain dr4310.233688.xyz)
```

## GitHub Pages

`npm run build:pages` 生成 `dist/pages/index.html`、`app.js` 和 `.nojekyll`。脚本使用相对路径 `./app.js`，可部署到仓库的 `/DR4310/` 子目录；Cloudflare Worker 仍使用原来的 `/app.js` 路径。

仓库启用 GitHub Actions 作为 Pages 发布源。推送 `main` 上的 `upper/` 或 `.github/workflows/pages.yml` 改动后，工作流自动安装依赖、构建、检查类型、执行测试并发布；也可以在 Actions 中手动运行。部署只上传静态构建目录，不需要 Cloudflare Token。

串口和 PCAN 权限由浏览器按网站地址分别保存，首次使用新地址需重新选择设备。浏览器中的参数偏好和历史日志也按网站地址保存。

## 电机设置 · 串口（可选）

「03 操作」里的 **电机设置 · 串口** 页面对应合并版固件 `4310_G431KBT6_CurrentAccelLoop_uartcfg`（串口 `@` 应答协议，见固件 `docs/UART_PROTOCOL.md`）：

- 连接串口后自动发送 `INFO` 识别固件；3 次无应答 → 判定为旧固件（只发 JustFloat），设置页禁用，CAN 与 VOFA 功能不受影响，也不会发送心跳。
- 参数表（GET/SET/SAVE/DEFAULTS/RELOAD/REBOOT），修改 CAN ID（STOP → SET CAN_ID → SAVE → REBOOT，重启后读回确认）。
- `SPD_*` / `POS_*` 与 CAN 0x400+ID / 0x500+ID 帧共用同一组变量，范围一致（速度 Kp 0–10 / Ki 0–5 / Kd 0–1，位置 Kp 0–200 / Ki 0–100 / Kd 0–100），下一帧会覆盖。
- 固件 3.2.0+：在「参数配置 → 驱动参数 → 位置环」设置 `POS_VFF`（轨迹速度前馈系数，0–1）。0 关闭前馈，0.5 一半，1 全量。点本行「写入」立即改 RAM，可在运行中调整；停机后「同步」保存，重启保留。旧固件未列出该键时不显示控件。位置模式的速度给定为 `clamp(位置 PID + POS_VFF × 轨迹速度, ±POS_VLIM)`；位置环 Kp/Ki/Kd 通过这里的 POS_* 行调节。

测试：`npx vitest run`；端到端（需本地 `wrangler dev --port 8799`）：`node test/e2e/fake-pcan.mjs`、`node test/e2e/fake-serial-cfg.mjs`。

前馈配置端到端：`node test/e2e/position-vff.mjs [URL]`，覆盖新固件 0/0.5/1 写入、运行中调整、非法范围拦截、同步/重载/重启，以及旧固件隐藏控件；串口由浏览器测试桩模拟，不操作真实电机。

## Phase 1 · 电机精灵风格（2026-10）

视图：**仪表盘**（首页）/ **参数配置** / **调试**（原示波器 + 原生控制 / GM6020 / 串口 VOFA / 帧日志）。急停按钮、`Esc`、页面隐藏看门狗保持不变；急停 / 停止 / 切换模式 / 断链 / 页面隐藏都会停止波形发生器。

- **仪表盘**：速度 / 力矩(电流) / 位置 / MIT 标签页；SVG 刻度盘（琥珀色 = 目标，灰色 = 实测，点击 / 拖动 / 方向键设定目标；停止状态下只移动指针，不发送）；中央 启动/停止；状态 空闲 / 运行 / 异常 / 离线；功率（固件 POWER 通道 → 1.5·(Vd·Id+Vq·Iq) → Kt·Iq·ω）与 Vbus 徽章；4 个小表盘；目标 vs 实测曲线。
  - 链路：自动（PCAN 优先，否则串口）/ CAN / 串口。CAN：速度 0x400+ID（增益取调试页）、电流 0x100+ID cmd 0x01、位置 0x500+ID、MIT 0x06 + Cheetah 包；停止 = 0x00。串口：`SPD` / `CUR` / `POS` / `MIT p v kp kd iq`，停止 = `STOP`；旧固件只支持电流（`RUN` + `IQ`）。
  - 位置 / MIT 启动保留用户已设目标，未设目标时保持当前实测位置。支持 TCH 的串口固件自动加入 PosRad 并等待反馈；固定通道旧固件未知位置时二次确认。
  - 指令时间（上位机斜坡，CAN 50 Hz / 串口 20 Hz）：固件存在 `SPD_RAMP_MS` / `CUR_RAMP_MS` / `POS_RAMP_MS` 时不做上位机斜坡。
  - 直驱电机（无减速器）：速度 / 位置按固件上报直接显示（电机 = 输出）；力矩 = Iq·Kt（Kt 优先用固件 `KT`，否则本机设置）。固件 `GEAR_RATIO` 键在设置页隐藏且不参与换算；旧的 localStorage gear/output 字段在加载后被清除。
  - 波形发生器：正弦 / 方波 / 三角，|偏置|+幅值 ≤ 量程，频率 ≤ 5 Hz（位置 / MIT ≤ 2 Hz）。
- **自动连接**：串口连接后 `PING` → `INFO` → `HELP` → `GET`（→ v3：`TLIST` → `TCH` → `TRATE` → `FAULT`）；PCAN 连接后只监听 0x181–0x187 / 0x205–0x20B 列出电机（点击切换 ID），不发送。可选“打开页面时自动连接已授权设备”（默认关）。
- **参数配置**：电机参数 / 驱动参数 / 通信参数 / 数据存储 /（其他）。表格由 `GET` 的 `@P` 行动态生成，未知键进入“其他”。**同步** = 写入全部修改项 + `SAVE`；**重置** = `DEFAULTS`（确认）+ 重新读取。设零（`SETZERO`）、遥测通道选择（`TLIST`/`TCH`/`TRATE`）只在固件支持时显示。参数文件导入/导出（JSON `{type:"dr4310-profile",version:1,params,host}`）。日志管理：CSV 记录停止后自动存入 IndexedDB，可下载 / 删除。
- **故障面板**（右侧）：CAN 状态帧低 8 位、串口 INFO 当前/锁存 16 位、`@FAULT` 快照；`CLEAR` 走串口（原生 CAN 协议没有清故障命令）。

### v3.0.0 固件实际回复格式（Grok Build 固件，上位机已按此适配；旧的宽容格式仍兼容）

| 命令 | 固件回复 | 上位机处理 |
|---|---|---|
| `HELP` | `@OK HELP … SETZERO TLIST TCH TRATE FAULT` | 据此开启 v3 功能 |
| `TLIST` | 一行 `@TLIST IdRef,Id,…,Mode`（28 个名字，无单位，**不跟 @OK**） | 收到该行即完成；单位由上位机按名字补（A/V/rad/s/rpm/rad/W） |
| `TCH` | 查询：一行 `@TCH <16 个名字>`（不跟 @OK）；设置：**必须正好 16 个名字** `TCH Iq,Rpm,…`，回 `@OK TCH` | 选中的通道在前，其余按 TLIST 顺序补齐到 16；设置后再发 `TCH` 读回。帧宽恒为 16 |
| `TRATE` | `@OK TRATE hz=<n> period_ms=<ms>`；超带宽 `@ERR TRATE bandwidth max=135` | 读 `hz` |
| `FAULT` | 一行 `@FAULT active=0x… latched=0x… snap=0/1 t=<ms> fault=0x… pos= omega= iq= vbus= mode=`（不跟 @OK） | `active` = 当前故障（触发停机）；`fault` = 快照里的历史故障字，只显示，不触发停机 |
| `SETZERO` | `@OK SETZERO zero=<rad>`；`@ERR SETZERO not_idle` / `no_encoder` | 随后 `GET ZERO_OFFSET` |
| `INFO` | `ver=3.0.0`，新增 `pp= baud= zoff= zset=` | 忽略未知键 |
| `GET` | `@P KEY=… min= max= [reboot=1] [choices=125000\|…]`，34 个键 | `choices` 忽略（显示范围） |

串口位置/MIT 启动会为支持 TCH 的固件自动加入 `PosRad`，读回通道配置并等待有效位置样本；只改 RAM，不写 Flash。旧固定通道固件仍保留未知位置确认。用户输入的目标会保留；未设目标时启动保持当前位置。


测试：`npm test`（vitest 90 项）、`npm run typecheck`、e2e `node test/e2e/phase1.mjs http://localhost:8799/ screenshots`（假串口 v2 / v3 / 旧固件 + 假 PCAN 发现），另有 `fake-pcan.mjs`、`fake-serial-cfg.mjs`；预览检查页 `node scripts/preview.mjs`（需先打包 `dist/page.mjs`，见下）后 `node test/e2e/checks.mjs http://localhost:8799/`；截图 `node test/e2e/shots-codex.mjs <url> screenshots`。

## 审查修复 · 2026-10-10

详细问题和验证记录见 [REVIEW.md](REVIEW.md)。首页简化为四模式、目标、表盘、响应曲线和数值卡片；高级控制、波形和电气曲线默认折叠。石墨灰/青色/琥珀色主题与亮色切换保留，手机使用单列布局。

- 停止会取消未发送的控制命令，先关闭 CAN 自动使能，再发送失能；急停保留两次 `0x03`。CAN 和串口独立停机，支持 `@` 协议的串口等待 STOP 应答（700 ms）。
- 换 CAN ID 前停止旧节点；CAN 反馈只接受本节点。同 ID 的串口可补充位置等遥测，其他节点不会参与 CAN 启动对齐。串口控制使用串口反馈。
- 反馈中断、CAN 总线/读取异常、当前故障自动停止控制。位置/MIT 启动对齐实测位置；调试页位置/MIT 进入也进行对齐或未知位置确认。
- 波形固定在转子侧计算，每帧限幅；改量程、显示换算时停止波形。停止同时关闭调试实时滑块。
- 协议编码与回复解析文件未修改；`npm test` 使用 threads 测试池，包含原 64 项协议/功能测试和新增控制/生命周期/链路身份测试。

本地构建仍可运行 `npm run build:client`。若受限 Windows 环境禁止 esbuild 启动子进程，可直接调用已安装的二进制后嵌入脚本（不下载依赖）：

```powershell
& '.\node_modules\@esbuild\win32-x64\esbuild.exe' src/client.ts --bundle --minify --format=iife --target=es2020 --outfile=dist/client.js
node scripts/build-client.mjs --embed-only
& '.\node_modules\@esbuild\win32-x64\esbuild.exe' src/page.ts --bundle --platform=node --format=esm --outfile=dist/page.mjs
node scripts/preview.mjs
```

预览入口 `http://localhost:8799/`；纯假设备浏览器检查入口 `/checks?fw=v2`、`v3`、`legacy`、`can`。这些检查页面安装假串口和假 PCAN，不访问物理设备。Puppeteer 脚本支持 `CHROME_PATH`，`puppeteer-core` 需由测试环境已有安装提供；本次未添加依赖。

浏览器界面验证和真机检查仍需在允许本地浏览器访问的环境执行。页面冻结/关闭或 USB 拔出后，浏览器无法保证把停机命令送达硬件；真机应保留独立硬件急停。

## 精简主控与自动使能 · 2026-10-10

首页保留连接、电机 ID、四模式、表盘、目标、启停、转速 / 位置 / 电流 / 母线读数和状态故障。曲线、量程、归零 / 反向、波形与辅助控制默认折叠；连接详情在「设置」，完整仪表、故障详情与记录在「调试」。电流读数固定为 A，力矩目标仍支持 Kt 换算。深色 / 亮色与手机布局保留。

- 主界面没有运行时自动使能开关，上位机不会发送 CAN `08 01` 或串口 `AE 1`。状态区的「自动使能 开/关」只读显示串口 `INFO ae=`（例如电机按 `BOOT_AE=1` 上电），停机后立即显示「关」。
- 停止、急停、Esc、隐藏 / 关闭、故障 / 掉线、换模式 / 链路 / 节点和主动断开都会取消待发运动命令，再发送 AE 关（CAN `08 00` / 串口 `AE 0`）→ 停机（固件可能因 BOOT_AE 或其他工具处于自动使能）。CAN 急停仍发两次 `0x03`，两条链路独立停止；自动使能发送未确认时也尝试安全停止。
- 「设置 → 驱动参数 → 上电行为」集中显示上电模式（BOOT_MODE）、上电目标（BOOT_TARGET）和「上电自动使能」开关（BOOT_AE）；对应表格行隐藏。开启时确认（说明将以何模式 / 目标上电即转；上电模式为空闲则提示无效果），「同步」执行 `SET` + `SAVE`，重启生效。固件不支持（旧固件 / 仅 CAN / 未连接）时开关禁用并提示。

最新验证与真机检查要点见 [REVIEW.md](REVIEW.md)。浏览器 e2e 脚本已更新控件位置与 `data-testid`；当前环境缺少 `puppeteer-core`，此次只做静态校验，没有更新截图。
