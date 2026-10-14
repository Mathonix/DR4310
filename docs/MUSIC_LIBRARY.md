# 音乐列表、进度跳转与后台播放（2026-10-14）

在 [dr4310 上位机](https://dr4310.233688.xyz/) 打开「电流音频」，填写音乐库访问码并点击「连接 / 刷新云端音乐库」。访问码由本机交付文件提供，存储在当前浏览器；其他电脑输入同一个码即可读取同一份音乐列表。云端列表、音频读取、上传和删除均需要访问码，凭据不会放入网页脚本或 Git。

可一次选择多个音乐文件，浏览器将 MP3/WAV/FLAC 等转换为 8 kHz 单声道 S16LE、去除直流偏置，并上传转换后的 PCM。每首最长五分钟，原音乐文件最大 64 MiB。列表以 PCM 内容哈希去重；点击名称选择，点击「播放」直接开始。下载按钮导出所选 PCM。删除会删除云端记录及本机缓存。未连接音乐库或上传暂时失败时保留本机待同步记录，连接音乐库后补传。

进度滑块可在播放前指定起点，也可在播放或暂停期间跳转。当前 V1 没有 SEEK 帧，网页先中止并退出当前会话、确认停机，再从目标样本重新 OPEN/预缓冲。界面显示原曲的绝对进度，协议 ACK/played 以新片段为准；暂停后跳转仍保持暂停。停止、急停、断开会取消待执行的跳转。

Chrome/Edge 的正式 Web Serial 收发和音频会话运行在 dedicated worker。串口数据到达会唤醒发送循环，定时器作为备用；UI 更新最多约 25 Hz。切换网站视图或浏览器标签不会取消后台音频，普通运动/齿槽标定的隐藏页面停止策略保留。两个同型号适配器均已授权时，若无法唯一匹配，连接会拒绝并提示撤销多余授权，避免连接错设备。

要关闭原主页面，先在空闲时点击「打开独立播放窗口」，主页面释放串口；在新窗口连接并开始播放后，可关闭主页面。播放器会加载所选音乐并共享本机缓存/访问码。请保留播放窗口与浏览器运行；关闭播放窗口、浏览器退出、系统休眠或串口拔出会结束数据流，固件仍按既有看门狗停机。独立窗口不依赖 opener 提供音频数据。

Cloudflare Workers KV 保存单个内容寻址 PCM 对象及元数据，列表分页读取元数据，音频流式下载。上传逐块限制到 4,800,000 B，检查偶数字节和 SHA-256。访问码为 Worker secret；验证使用固定长度摘要的 timingSafeEqual。API 没有公开跨域授权。KV 跨区域更新可能延迟，必要时点击刷新；本机保存上传结果和缓存。GitHub Pages 静态构建包含 worker 脚本，可使用本机列表，云端库在 dr4310.233688.xyz 使用。

软件验收：325 项测试、类型检查、Pages 构建和 Worker dry run 通过。浏览器回归使用真实 IndexedDB、正式 dedicated worker 与独立 Node 外设时钟，覆盖云端跨浏览器同步/PCM 下载、多文件、去重、文件名转义、播放/暂停跳转、停止取消跳转、隐藏标签、650 ms 页面线程阻塞、关闭主页面后独立播放器完成、删除和手机无横向溢出。线上两个隔离浏览器通过实际云端上传/读取/选择及 PCM 哈希验证；验收文件已删除。

实机验证：3.4.5、ID2、COM5/200000，D 轴峰值上限 1 mA，6 秒 300 Hz PCM，播放中跳到 2 秒；随后隐藏标签并阻塞页面线程 650 ms。新片段 FINISHED、played=32000、ACK=200、欠载/故障为 0、重传 0。自动化浏览器未出现原生串口选择事件，因此实机通过测试专用 WebSocket/stdio 适配器连接真实 COM5，网页及 dedicated worker 使用正式代码。原生串口选择和权限委托未纳入该实机验收。解析器丢弃 9 个损坏状态帧，J-Link 链路仍非完全无错误。

结束后 STOP、IDLE/drv=0/ae=0、uart_errors=0，测试前后全部参数与齿槽元数据一致；保留用户当前 IQ_LIM=2.4 A、校准零位 0.134657、dir=1、pp=14 和齿槽 CRC=0x0BECE80E。此功能未变更固件或做高电流功率测试。本机证据、访问码和测试 PCM 在 `logs/music_library_20261014/`，保持 Git 忽略。

部署：Cloudflare API deployment id `d2a4fc9c7d624a07a9bc10d61b27c0d9`，app.js SHA256 `9b984ee83aa0e2bd46f7624f44b4fe1315c5d786a20d224a2c59a402654b70b8`，serial-worker.js SHA256 `b20612e3c7da6aad8c3e3d9c97e19e6c3defb68fb98529cb452e24fcabed78dc`，线上字节与本地构建一致。

开发验证：`cd upper` 后执行 `npm run typecheck`、`npm test`、`npm run build:pages` 和 `npm run test:ui:audio:library`。KV 绑定与生成的 `worker-configuration.d.ts` 入库，真实 `.dev.vars` 和访问码不入库；重新生成类型用 `npx wrangler types --include-runtime=false`。Web Serial worker 能力参考 [标准](https://serial.spec.whatwg.org/)。
