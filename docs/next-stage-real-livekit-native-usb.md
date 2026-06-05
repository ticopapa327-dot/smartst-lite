# SmartST Lite 下一阶段执行记录

> 日期：2026-06-05  
> 阶段：真实 LiveKit JWT / Native Worker / 4 路 USB 硬件验证  
> 状态：已进入；4 路摄像头基础链路可并发打开，目标 USB 采集卡现场压力验证未完成。

## 1. 本阶段目标

本阶段不再扩展 mock UI，而是验证三条生产关键链路：

- 真实 LiveKit JWT：业务服务使用服务端 API key/secret 签发短期 JWT。
- Native Worker：确认正式 Worker 技术路线和本机原生工具链就绪。
- 4 路 USB：用真实 USB 采集卡验证 4 路并发打开能力。

最近一次完整回归：

- 命令：`npm run test:all:poc`
- 结果：通过，耗时约 33.1 秒。
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

控制面骨架实现结果：

- 已创建 `native-worker` Rust crate。
- 已接入 npm 脚本：`media-worker:native`、`media-worker:native:build`、`media-worker:native:smoke`。
- 已实现 JSON Lines stdin/stdout 控制面，支持 `listDevices`、`start`、`stop`、`status`、`shutdown`。
- 已输出 worker、device、channel、recording、livekit、error 等事件类型。
- 已加入 `npm run test:all:poc` 回归链路。

当前边界：

- `listDevices` 已接入 Media Foundation 视频设备枚举和 WASAPI/Core Audio 采集端点枚举。
- 通道 `start/stop` 仍是 mock native 状态机，尚未接入真实帧采集、WASAPI 音频流、LiveKit native publisher 或真实录像。
- JSON Lines 只作为控制和状态通道，真实媒体帧不得通过该 IPC 传输。

真实设备枚举结果：

```powershell
npm run media-worker:native:list-devices
```

本机结果：

```text
source=windows-native
mediaFoundation.status=ok
mediaFoundation.count=4
wasapi.status=ok
wasapi.count=4

video:
1. HD Webcam
2. thinkplus Video Camera FHD
3. 罗技高清网络摄像机 C930c
4. Rapoo Camera

audio capture:
1. 麦克风 (Rapoo Camera)
2. 麦克风阵列 (Senary Audio)
3. 麦克风 (thinkplus Video Camera FHD)
4. 麦克风 (罗技高清网络摄像机 C930c)
```

注意：当前只完成设备枚举，`capabilitiesStatus=not-enumerated`，尚未读取分辨率/帧率/音频格式能力，也未打开真实采集流。

视频能力探测和单帧采集结果：

```powershell
npm run media-worker:native:video-probe
```

本机结果：

```text
targetVideoIndex=0
device=HD Webcam
capabilityCount=17
firstMediaType=1280x720 NV12 30fps
sample.status=sample-read
sample.attempts=2
sample.elapsedMs=223
sample.totalLengthBytes=1382400
sample.bufferCount=1
sample.sampleDurationHns=333333
decodeStatus=not-decoded
```

结论：

- Media Foundation SourceReader 可以打开本机第 0 路视频设备并读到真实样本。
- 当前样本仍停留在 native buffer 验证层，未进入连续帧循环、预览渲染、LiveKit 发布、编码或录像。
- 该结果证明 Native Worker 采集技术路线可继续推进，但不能替代目标采集卡 30 分钟/2 小时现场稳定性验收。

WASAPI 阶段复测时的当前设备状态：

```text
测试时间：2026-06-05
命令：npm run media-worker:native:list-devices
source=windows-native
mediaFoundation.count=1
wasapi.count=1
video[0]=HD Webcam
audio[0]=麦克风阵列 (Senary Audio)
```

说明：该结果只反映 WASAPI 阶段复测时 Windows 当前活跃设备状态，和前一次 4 路摄像头接入测试不是同一次硬件状态。后续进入 4 路采集卡验收前，必须重新确认设备接入和枚举数量。

## 4. WASAPI 音频格式探测和短时采集

新增入口：

```powershell
npm run media-worker:native:audio-probe
```

Native Worker 新增命令：

- `probeAudioFormat`：读取 WASAPI capture endpoint 的 mix format。
- `captureAudioBuffer`：以共享模式初始化 `IAudioClient`，通过 `IAudioCaptureClient` 做短时 buffer 采集统计。

本机结果：

```text
targetAudioIndex=0
device=麦克风阵列 (Senary Audio)
mixFormat=48000Hz, 2ch, EXTENSIBLE/IEEE_FLOAT, 32-bit, blockAlign=8
devicePeriod.defaultHns=100000
devicePeriod.minimumHns=30000
capture.status=buffer-captured
capture.durationMs=500
capture.elapsedMs=506
capture.packetCount=49
capture.capturedFrames=23520
capture.capturedBytes=188160
capture.silentPackets=0
capture.discontinuityPackets=1
capture.timestampErrorPackets=0
decodeStatus=not-decoded
```

结论：

- WASAPI 可以打开当前系统第 0 路采集端点并读取真实 capture buffer。
- 当前只验证短时 native buffer 可读性和基础时间戳/packet 统计，尚未进入连续音频线程、重采样、AEC、音量表、LiveKit 发布或录像封装。
- 首包出现 `DATA_DISCONTINUITY` 计数为 1，短时启动阶段可接受；进入连续音频管线后必须做稳定性统计，不能忽略中途 discontinuity。
- 手术室交互通话所需回音消除不能靠本次 WASAPI buffer 读取自然获得，后续应在 WebRTC/LiveKit 音频处理链路或独立 AEC 模块中验证。

## 5. 4 路 USB 验证

新增入口：

```powershell
npm run media-worker:usb4-validate
npm run media-worker:usb4-validate:smoke
```

本机结果：

```text
2026-06-05 初次阶段结果：
status=blocked
requiredVideoChannels=4
detectedVideoChannels=1
detectedDevice=HD Webcam
blocker=insufficient-video-devices
```

接入 3 个外置 USB 摄像头和 1 个内置摄像头后的基础测试：

```text
测试时间：2026-06-05
测试命令：SMARTST_USB4_DURATION_SECONDS=60 npm run media-worker:usb4-validate
测试模式：parallel-ffmpeg-directshow
测试分辨率：640x480
请求帧率：30fps
最低可接受帧率：24fps
结果：status=degraded
```

设备和结果：

```text
1. HD Webcam：opened=true，frames=600，mediaFps=10，wallFps=9.83，degraded=true
2. thinkplus Video Camera FHD：opened=true，frames=1801，mediaFps=30.02，wallFps=29.62，degraded=false
3. 罗技高清网络摄像机 C930c：opened=true，frames=1801，mediaFps=30.02，wallFps=29.44，degraded=false
4. Rapoo Camera：opened=true，frames=1800，mediaFps=30，wallFps=19.6，realtimeRatio=0.65，degraded=true
```

结论：

- 当前 4 路可以并发打开，基本链路成立。
- 当前不是 4 路 30fps 实时验收通过，因为 HD Webcam 和 Rapoo Camera 低于阈值。
- 该结果只能作为基础可用性测试，不能作为正式手术室 4 路采集卡验收。
- 按当前阶段决策，现有摄像头性能降级只记录为开发机限制，不阻塞 Native Worker 后续开发；目标采集卡到位后再做采集参数和实时性优化。

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

## 6. 本阶段停止条件

必须停止并先处理问题的情况：

- `npm run server:poc:real-token-smoke` 失败。
- JWT payload 中手机观察端出现 `canPublish=true` 或 `canPublishData=true`。
- `LIVEKIT_API_SECRET` 出现在客户端源码、日志或导出配置。
- `npm run media-worker:native-readiness` 返回 `blocked`。
- `npm run media-worker:usb4-validate` 在 4 路硬件接入后仍返回 `blocked` 或 `failed`。
- 4 路 30 分钟验证中任一路黑屏、无帧、错路或设备掉线。

## 7. 下一步

建议顺序：

1. 准备真实 LiveKit server 和服务端 API key/secret。
2. 用真实环境变量启动 `server-poc`，让桌面 LiveKit PoC 面板连接真实 room。
3. 接入 4 路 USB 采集卡，执行 30 分钟 `media-worker:usb4-validate`。
4. 进入 Media Foundation 连续帧循环和帧率统计，不做 WebView IPC 传帧。
5. 进入 WASAPI 连续音频采集线程、重采样/AEC 边界验证和音频统计上报。
