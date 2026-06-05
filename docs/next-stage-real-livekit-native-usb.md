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
- 结果：通过，耗时约 32.1 秒。
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

已完成实现点：

- 已创建 Rust Worker crate。
- 已移植 `listDevices/start/stop/status` 控制面。
- 已接入 Media Foundation/WASAPI 设备枚举、连续视频线程、连续 WASAPI 统计线程和 native-only 有界视频 payload 队列。

控制面骨架实现结果：

- 已创建 `native-worker` Rust crate。
- 已接入 npm 脚本：`media-worker:native`、`media-worker:native:build`、`media-worker:native:smoke`、`media-worker:native:session`。
- 已实现 JSON Lines stdin/stdout 控制面，支持 `listDevices`、`start`、`stop`、`consumeVideoPayloadQueue`、`status`、`shutdown`。
- 已输出 worker、device、channel、recording、livekit、error 等事件类型。
- 已加入 `npm run test:all:poc` 回归链路。

当前边界：

- `listDevices` 已接入 Media Foundation 视频设备枚举和 WASAPI/Core Audio 采集端点枚举。
- 通道 `start/stop/status` 已进入真实采集会话骨架：可绑定当前 Media Foundation 视频设备、WASAPI 音频端点和默认媒体格式，并输出 `captureSession`。
- 当前 `start` 已默认启动可停止的 Media Foundation 视频线程和 WASAPI 音频统计线程；视频线程已将 SourceReader sample payload 复制到 native-only 有界队列；`consumeVideoPayloadQueue` 可在 native 侧 drain payload 队列并只返回统计；尚未接入预览纹理、AEC、LiveKit native publisher 或真实录像。
- JSON Lines 只作为控制和状态通道，真实媒体帧不得通过该 IPC 传输。

真实采集会话骨架验证：

```powershell
npm run media-worker:native:session
```

本机结果：

```text
测试时间：2026-06-06
channels=field-camera,endoscope
captureSession.mode=windows-native
captureSession.realMediaSession=true
boundVideoChannels=1
unassignedVideoChannels=1
boundAudioEndpoints=1
video[0]=HD Webcam / 1280x720 NV12 30fps / state=native-bound
video[1]=waiting-for-device / reason=no-native-video-device-for-channel-index
audio[0]=麦克风阵列 (Senary Audio) / 48000Hz 2ch IEEE_FLOAT / state=native-bound
status.videoCaptureThread.state=running
status.videoCaptureThread.sampleCount=3
status.videoCaptureThread.readCount=4
status.videoCaptureThread.measuredFps=6.41
status.videoCaptureThread.streamFlagNames=stream-tick
status.videoCaptureThread.totalLengthBytes=4147200
status.audioCaptureThread.state=running
status.audioCaptureThread.packetCount=45
status.audioCaptureThread.capturedFrames=21600
status.audioCaptureThread.capturedBytes=172800
status.audioCaptureThread.discontinuityPackets=1
stop.captureSession.state=idle
stop.stats.realMediaSession=false
continuousVideoThreads=running
continuousAudioThreads=running
```

结论：

- `start/status/stop` 已经可以表达真实 Native Worker 会话状态，不再只是固定 mock channel。
- 当前设备数量不足时不阻塞启动，缺失通道被标记为 `waiting-for-device`，符合当前“忽略摄像头数量继续开发”的阶段决策。
- `start` 在绑定 Media Foundation 视频设备和 WASAPI 音频端点后默认启动可停止的连续线程，`status` 可读取视频 sample/FPS/byte 计数、native payload queue 计数和音频 packet/frame/byte 计数。
- `stop` 会清理 `captureSession` 并重置 session 统计，避免 UI/监控误判为仍在真实采集中。
- 该能力仍不是生产采集：已有 native-only 有界帧 payload 队列，但没有预览纹理消费者、AEC、LiveKit publisher 或录像写入。

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

注意：`listDevices` 本身只做设备枚举，`capabilitiesStatus=not-enumerated`。视频能力、单帧样本、连续帧统计和音频格式/短时 buffer 需要通过后续 probe 命令单独验证。

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

## 4. Media Foundation 连续帧循环和帧率统计

Media Foundation 连续帧循环和帧率统计结果：

```powershell
npm run media-worker:native:video-loop
```

Native Worker 新增命令：

- `measureVideoFrames`：按指定 Media Foundation 原生媒体类型连续读取 SourceReader 样本，只返回统计，不通过 JSON Lines 传输帧数据。

本机结果：

```text
targetVideoIndex=0
mediaTypeIndex=0
device=HD Webcam
mediaType=1280x720 NV12 30fps
durationMs=2000
elapsedMs=2028
status=frames-measured
readCount=20
sampleCount=19
emptyReadCount=1
measuredFps=9.37
mediaTimelineFps=10.32
frameRateFromSampleDuration=30.00
totalLengthBytes=26265600
totalBufferCount=19
averageSampleDurationHns=333333
streamFlagNames=stream-tick
decodeStatus=not-decoded
transportStatus=not-published
```

结论：

- SourceReader 可以在本机第 0 路视频设备上连续返回 native sample，连续帧循环链路成立。
- 当前 HD Webcam 实测帧率约 9.37fps，低于媒体类型声明的 30fps；按当前决策，该结果只记录为开发机摄像头限制，不作为采集卡路线阻塞。
- 本次仍未做解码、预览渲染、LiveKit 发布、编码或录像；真实帧 payload 仍留在 native 侧，JSON Lines 只返回统计。
- `stream-tick` 在本机连续读取中出现，后续长时间采集统计需要保留该 flag 计数，不能只看 sample 数。

Session 内可停止视频统计线程：

```powershell
npm run media-worker:native:session
```

本机结果：

```text
测试时间：2026-06-06
holdMs=500
continuousVideoThreadCount=1
videoCaptureThreads.length=1
frameQueue.mode=native-payload-bounded
frameQueue.capacity=3
frameQueue.pushCount=3
frameQueue.dropCount=0
frameQueue.payloadQueue.mode=copied-bounded
frameQueue.payloadQueue.copyCount=3
frameQueue.payloadQueue.copyErrorCount=0
frameQueue.payloadQueue.bytes=4147200
frameQueue.payloadQueue.exportedOverJson=false
videoFrameQueuePushCount=3
videoPayloadCopyCount=3
videoPayloadCopyErrorCount=0
videoPayloadQueueBytes=4147200
audioLevel.status=measured
audioLevel.format=float32
audioLevel.rms=0.000155
audioLevel.peak=0.007249
videoCaptureThread.state=running
videoCaptureThread.channelId=field-camera
videoCaptureThread.device=HD Webcam
videoCaptureThread.mediaType=1280x720 NV12 30fps
videoCaptureThread.sampleCount=3
videoCaptureThread.readCount=4
videoCaptureThread.measuredFps=6.42
videoCaptureThread.mediaTimelineFps=13.91
videoCaptureThread.totalLengthBytes=4147200
videoCaptureThread.streamFlagNames=stream-tick
stop.join=ok
```

边界：

- 当前实现会为每个已绑定视频通道启动一个 Media Foundation 统计线程，并通过 `stats.videoCaptureThreads[]` 返回多路状态；`stats.videoCaptureThread` 保留为第一路线程的兼容字段。
- 本轮本机只枚举到 1 路视频设备，因此只验证了多路结构和单路线程实例；4 路采集卡现场验收时必须重新执行 1/2/4 路递增验证。
- 线程已实现 `native-payload-bounded` 队列：SourceReader sample payload 被复制到 native 内存中的有界 FIFO，JSON Lines 只返回统计，不传输 payload；当前仍没有预览纹理、编码或录像消费者。
- 已新增 `consumeVideoPayloadQueue` 手动 drain 命令，用于验证后续预览/发布/录像消费者可以从 native 队列取走 payload；该命令只返回 `consumedFrames`、`consumedBytes`、`remainingDepth`、`latestSequence` 等统计，不返回 payload bytes。

重复启停稳定性验证：

```powershell
npm run media-worker:native:session-stress
```

本机结果：

```text
测试时间：2026-06-06
iterations=3
holdMs=1000

iteration 1:
videoThreadCount=1
videoSamples=8
videoMeasuredFps=8.29
videoFrameQueuePushCount=8
videoFrameQueueDropCount=5
audioPackets=95
audioFrames=45600
audioLevel.status=measured
audioLevel.format=float32
stoppedState=idle

iteration 2:
videoThreadCount=1
videoSamples=8
videoMeasuredFps=8.34
videoFrameQueuePushCount=8
videoFrameQueueDropCount=5
audioPackets=96
audioFrames=46080
audioLevel.status=measured
audioLevel.format=float32
stoppedState=idle

iteration 3:
videoThreadCount=1
videoSamples=8
videoMeasuredFps=8.14
videoFrameQueuePushCount=8
videoFrameQueueDropCount=5
audioPackets=95
audioFrames=45600
audioLevel.status=measured
audioLevel.format=float32
stoppedState=idle
```

结论：

- 当前视频线程数组、元数据帧队列统计、单路音频线程和音频 RMS/peak 统计可连续完成 3 次 start/status/stop，未出现线程残留或停止后运行态误报。
- 该验证时间仍很短，只能证明启停控制链路可重复；不能替代 30 分钟/2 小时稳定性验收。

加长稳定性验证：

```powershell
$env:SMARTST_NATIVE_SESSION_STRESS_ITERATIONS="5"
$env:SMARTST_NATIVE_SESSION_HOLD_MS="5000"
npm run media-worker:native:session-stress
```

本机结果：

```text
测试时间：2026-06-06
iterations=5
holdMs=5000
boundVideoChannels=1
boundAudioEndpoints=1
videoThreadCount=1
videoSamples=48/48/48/48/48
videoMeasuredFps≈9.64
videoFrameQueuePushCount=48/48/48/48/48
videoFrameQueueDropCount=45/45/45/45/45
audioPackets=495/497/496/497/496
audioLevel.status=measured
audioLevel.format=float32
stoppedState=idle/idle/idle/idle/idle
```

说明：该测试仍只覆盖当前 1 路视频设备和 1 路音频端点；它提高了 stop/join 稳定性置信度，但不能替代 4 路采集卡的 30 分钟/2 小时现场验收。

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

## 5. WASAPI 音频格式探测和短时采集

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
- `captureAudioBuffer` 只验证短时 native buffer 可读性和基础时间戳/packet 统计；连续音频线程需通过 `media-worker:native:session` 验证。
- 首包出现 `DATA_DISCONTINUITY` 计数为 1，短时启动阶段可接受；进入连续音频管线后必须做稳定性统计，不能忽略中途 discontinuity。
- 手术室交互通话所需回音消除不能靠本次 WASAPI buffer 读取自然获得，后续应在 WebRTC/LiveKit 音频处理链路或独立 AEC 模块中验证。

WASAPI 连续音频线程验证：

```powershell
npm run media-worker:native:session
```

本机结果：

```text
测试时间：2026-06-06
holdMs=500
audioCaptureThread.state=running
audioCaptureThread.device=麦克风阵列 (Senary Audio)
audioCaptureThread.mixFormat=48000Hz / 2ch / IEEE_FLOAT / 32-bit
audioCaptureThread.packetCount=45
audioCaptureThread.capturedFrames=21600
audioCaptureThread.capturedBytes=172800
audioCaptureThread.audioLevel.status=measured
audioCaptureThread.audioLevel.format=float32
audioCaptureThread.audioLevel.rms=0.000012
audioCaptureThread.audioLevel.peak=0.000342
audioCaptureThread.pollCount=45
audioCaptureThread.silentPackets=0
audioCaptureThread.discontinuityPackets=1
audioCaptureThread.timestampErrorPackets=0
stop.join=ok
```

边界：

- 该线程只做 WASAPI capture buffer 读取、packet 统计和 RMS/peak 音量统计，尚未做重采样、环形缓冲、AEC、发布、编码或录像。
- 当前音量数值只代表本机测试环境输入电平，不作为验收阈值；后续需要增加静音、讲话声和外接全向麦的对比样本。
- `stop` 会设置停止标志并 join 线程；`shutdown` 在 worker 仍运行时也会先清理会话。

## 6. 桌面端 Native Worker readiness 入口

新增 Tauri 命令：

```text
get_native_worker_readiness
probe_native_worker_devices
start_native_worker_session
get_native_worker_session_status
consume_native_worker_video_payload_queue
stop_native_worker_session
```

返回内容：

```text
status=ready | source-only | missing
manifestPath=native-worker/Cargo.toml
executablePath=native-worker/target/debug/smartst-native-worker(.exe)
cargoAvailable=true | false
cargoVersion=<cargo --version>
```

前端工作台新增 Native Worker 状态条：

- Tauri 桌面运行时调用 `get_native_worker_readiness`。
- 浏览器/普通 Vite 环境返回 `desktop-only`，不抛异常。
- 该入口只做路径、manifest、debug binary 和 Cargo 可用性诊断，不启动采集、不占用摄像头、不发布 LiveKit。
- `probe_native_worker_devices` 会启动 Native Worker 子进程，等待 `worker.ready`，发送 `listDevices`，随后发送 `shutdown` 并清理进程；该命令只枚举 Media Foundation/WASAPI 设备，不执行 `start`，不打开连续采集线程。
- 工作台新增 `Device Probe` 面板，用户手动点击 `Probe devices` 后才调用 `probe_native_worker_devices`，显示视频/音频枚举数量和设备来源。
- 工作台新增手动 `Start session`、`Status`、`Drain payload`、`Stop` 控件；`Start session` 会按默认 `field-camera,endoscope` 参数启动 Native Worker `start`，并返回 `framesProduced`、`audioPacketsProduced` 等统计；`Drain payload` 调用 Tauri `consume_native_worker_video_payload_queue`，只 drain native queue 并刷新统计。
- start/status/drain/stop 控制面已补充失败捕获、面板内错误提示、running/idle 按钮约束、绑定视频/音频数量、native 视频线程数、frameQueue push/drop、native payload queue bytes/copy 和 payload consumed 展示；该展示仍只来自 JSON 控制面状态，不承载媒体 payload。
- Tauri 持有的 Native Worker session 在 runtime 释放时会尝试发送 `shutdown` 并 kill/wait 子进程，降低未点 `Stop` 直接退出时的残留进程风险。

验证：

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo build --manifest-path native-worker/Cargo.toml
npm run media-worker:native:session
npm run media-worker:native:session-stress
npm run media-worker:native:payload-consume
npm run build
npm run test:all:poc
```

结果：均通过；`cargo test` 当前覆盖 4 个 Tauri Native Worker helper 单元测试；native payload queue 阶段 `npm run media-worker:native:session` 验证 500ms 内 3 帧 payload copy，`npm run media-worker:native:session-stress` 验证 3 轮重复启停每轮 8 帧 payload copy 且 `copyErrorCount=0`；`npm run media-worker:native:payload-consume` 验证 1000ms 内 8 帧 copy 后手动 drain 2 帧，`consumedBytes=2764800`、`remainingDepth=1`、`exportedOverJson=false`；新增 Tauri/UI drain 控制后 `npm run test:all:poc` 完整回归耗时约 35-36 秒；`npm run build` 仍有 Vite chunk 体积超过 500 kB 警告。

## 7. 4 路 USB 验证

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

## 8. 本阶段停止条件

必须停止并先处理问题的情况：

- `npm run server:poc:real-token-smoke` 失败。
- JWT payload 中手机观察端出现 `canPublish=true` 或 `canPublishData=true`。
- `LIVEKIT_API_SECRET` 出现在客户端源码、日志或导出配置。
- `npm run media-worker:native-readiness` 返回 `blocked`。
- `npm run media-worker:usb4-validate` 在 4 路硬件接入后仍返回 `blocked` 或 `failed`。
- 4 路 30 分钟验证中任一路黑屏、无帧、错路或设备掉线。

## 9. 下一步

建议顺序：

1. 准备真实 LiveKit server 和服务端 API key/secret。
2. 用真实环境变量启动 `server-poc`，让桌面 LiveKit PoC 面板连接真实 room。
3. 接入 4 路 USB 采集卡，执行 30 分钟 `media-worker:usb4-validate`。
4. 执行 Native Worker 1/2/4 路递增 session-stress，验证多路 Media Foundation 线程和 native payload frameQueue。
5. 进入 WASAPI 静音/讲话/外接全向麦对比样本、重采样和 AEC 边界验证。
6. 将 Native Worker readiness 入口推进到真实 start/status/drain/stop 控制面板，不通过 UI 直接传输媒体 payload。
