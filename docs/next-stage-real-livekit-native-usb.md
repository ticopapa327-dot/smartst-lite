# SmartST Lite 下一阶段执行记录

> 日期：2026-06-05  
> 阶段：真实 LiveKit JWT / Native Worker / 4 路 USB 硬件验证  
> 状态：已进入，但 4 路 USB 现场验证受硬件数量阻塞。

## 1. 本阶段目标

本阶段不再扩展 mock UI，而是验证三条生产关键链路：

- 真实 LiveKit JWT：业务服务使用服务端 API key/secret 签发短期 JWT。
- Native Worker：确认正式 Worker 技术路线和本机原生工具链就绪。
- 4 路 USB：用真实 USB 采集卡验证 4 路并发打开能力。

最近一次完整回归：

- 命令：`npm run test:all:poc`
- 结果：通过，耗时约 31.5 秒。
- 剩余警告：Vite chunk 体积超过 500 kB，需要后续 code split。

## 2. LiveKit JWT 签发

新增入口：

```powershell
npm run server:poc:real-token-smoke
```

验证内容：

- 使用 `livekit-server-sdk` 的 `AccessToken` 生成真实 JWT。
- 校验 JWT payload 中的 `iss`、`sub`、`video.room`、`roomJoin`、`canPublish`、`canSubscribe`、`canPublishData`。
- 手机观察端 token 仍为 `canPublish=false`、`canPublishData=false`。
- smoke 不连接真实 LiveKit server，只验证签发结构和权限边界。

真实运行方式：

```powershell
$env:LIVEKIT_TOKEN_MODE="real"
$env:LIVEKIT_URL="ws://127.0.0.1:7880"
$env:LIVEKIT_API_KEY="..."
$env:LIVEKIT_API_SECRET="..."
npm run server:poc
```

边界：

- `LIVEKIT_API_SECRET` 只能在服务端环境变量中出现。
- 桌面端、手机 H5、Android 平板端不得保存或传入 API secret。

## 3. Native Worker 就绪检查

新增入口：

```powershell
npm run media-worker:native-readiness
npm run media-worker:native-readiness:smoke
```

本机结果：

- `status=ready`
- Windows platform：通过。
- Node.js：通过。
- Rust `rustc`：通过。
- Cargo：通过。
- FFmpeg：通过。
- FFprobe：通过。

当前技术路线：

- 继续保留 JSON Lines stdin/stdout 控制面。
- 正式 Worker 采用 Rust native worker process。
- 视频生产采集路径：Media Foundation。
- 音频生产采集路径：WASAPI。
- FFmpeg/DirectShow 只作为验证和兜底，不作为正式采集 API。

下一步实现点：

- 创建 Rust Worker crate。
- 先移植 `listDevices/start/stop/status` 控制面。
- 再接 Media Foundation/WASAPI 设备枚举。

## 4. 4 路 USB 验证

新增入口：

```powershell
npm run media-worker:usb4-validate
npm run media-worker:usb4-validate:smoke
```

本机结果：

```text
status=blocked
requiredVideoChannels=4
detectedVideoChannels=1
detectedDevice=HD Webcam
blocker=insufficient-video-devices
```

结论：

- 本机当前只有 1 路视频设备，不能代表手术室 4 路 USB 采集能力。
- 4 路 USB 验证必须在插入 4 路采集卡或 4 路 UVC 设备后执行。
- 当前脚本不会把 1 路内置摄像头误判为 4 路验证通过。

现场验证命令：

```powershell
$env:SMARTST_USB4_DURATION_SECONDS="1800"
npm run media-worker:usb4-validate
```

30 分钟通过后，再提升到 2 小时：

```powershell
$env:SMARTST_USB4_DURATION_SECONDS="7200"
npm run media-worker:usb4-validate
```

## 5. 本阶段停止条件

必须停止并先处理问题的情况：

- `npm run server:poc:real-token-smoke` 失败。
- JWT payload 中手机观察端出现 `canPublish=true` 或 `canPublishData=true`。
- `LIVEKIT_API_SECRET` 出现在客户端源码、日志或导出配置。
- `npm run media-worker:native-readiness` 返回 `blocked`。
- `npm run media-worker:usb4-validate` 在 4 路硬件接入后仍返回 `blocked` 或 `failed`。
- 4 路 30 分钟验证中任一路黑屏、无帧、错路或设备掉线。

## 6. 下一步

建议顺序：

1. 准备真实 LiveKit server 和服务端 API key/secret。
2. 用真实环境变量启动 `server-poc`，让桌面 LiveKit PoC 面板连接真实 room。
3. 接入 4 路 USB 采集卡，执行 30 分钟 `media-worker:usb4-validate`。
4. 创建 Rust Native Worker crate，移植现有 JSON Lines 控制面。
5. 进入 Media Foundation/WASAPI 设备枚举实现。
