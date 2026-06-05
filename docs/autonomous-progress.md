# SmartST Lite 无人值守开发进度

> 本文件用于记录后续自动开发批次的状态。每个批次完成或阻塞后追加记录。

## AD-00 文档与仓库基线

- 状态：done
- 开始时间：2026-06-05
- 完成时间：2026-06-05
- 修改文件：
  - `README.md`
  - `package.json`
  - `docs/autonomous-progress.md`
- 验证：
  - 开始前执行 `npm run build`：通过，仅有 Vite chunk 体积警告。
  - 完成后执行 `npm run build`：通过，仅有 Vite chunk 体积警告。
- 阻塞：无。
- 下一步：执行 AD-01，新增领域模型与 HMI 视觉 token，保留旧 ONVIF/RTSP 类型兼容。

## AD-01 领域模型与 HMI 视觉 token

- 状态：done
- 开始时间：2026-06-05
- 完成时间：2026-06-05
- 修改文件：
  - `src/domain/mediaTypes.ts`
  - `src/domain/roomTypes.ts`
  - `src/domain/endpointTypes.ts`
  - `src/styles.css`
  - `docs/autonomous-progress.md`
- 验证：
  - 执行 `npm run build`：通过，仅有 Vite chunk 体积警告。
- 阻塞：无。
- 下一步：执行 AD-02，建立 USB-first 手术室工作台 UI 骨架，使用 HMI token，不删除旧发起端/接收端功能。

## AD-02 工作台 UI 骨架

- 状态：done
- 开始时间：2026-06-05
- 完成时间：2026-06-05
- 修改文件：
  - `src/domain/types.ts`
  - `src/App.tsx`
  - `src/components/AppShell.tsx`
  - `src/components/StartupPage.tsx`
  - `src/components/WorkbenchPage.tsx`
  - `src/components/ChannelGrid.tsx`
  - `src/components/CallPanel.tsx`
  - `src/components/RecordingPanel.tsx`
  - `src/styles.css`
  - `docs/autonomous-progress.md`
- 验证：
  - 执行 `npm run build`：通过，仅有 Vite chunk 体积警告。
- 阻塞：无。
- 下一步：执行 AD-03，建立业务服务 PoC，提供端点注册、呼叫、accept/reject 和 mock token。

## AD-03 业务服务 PoC

- 状态：done
- 开始时间：2026-06-05
- 完成时间：2026-06-05
- 修改文件：
  - `package.json`
  - `server-poc/README.md`
  - `server-poc/server.mjs`
  - `server-poc/smoke.mjs`
  - `docs/autonomous-progress.md`
- 验证：
  - 执行 `npm run server:poc:smoke`：通过。
  - 执行 `npm run build`：通过，仅有 Vite chunk 体积警告。
- 阻塞：无。
- 下一步：执行 AD-04，接入 `livekit-client` UI PoC。不得写入真实 LiveKit secret；无 LiveKit 服务时必须显示可读配置提示。

## AD-04 LiveKit UI PoC

- 状态：done
- 开始时间：2026-06-05
- 完成时间：2026-06-05
- 修改文件：
  - `package.json`
  - `package-lock.json`
  - `src/services/livekitRoomService.ts`
  - `src/components/LiveKitPocPanel.tsx`
  - `src/components/WorkbenchPage.tsx`
  - `src/styles.css`
  - `docs/autonomous-progress.md`
- 验证：
  - 执行 `npm run build`：通过，仅有 Vite chunk 体积警告；接入 `livekit-client` 后主 JS chunk 约 1.23 MB，后续需要 code split。
  - 执行 `npm run server:poc:smoke`：通过。
- 阻塞：
  - 未接入真实 LiveKit server 和真实短期 JWT，不能声明已完成端到端音视频实测。
  - `server-poc` 当前只签发 mock token，UI 已明确禁止 mock token 连接真实 LiveKit。
- 下一步：执行 AD-05，建立手机 H5 单向观察 PoC；必须保持手机端只订阅、不发布、不请求互动，并继续由 LiveKit/SFU 承担并发转发。

## AD-05 手机 H5 单向观察 PoC

- 状态：done
- 开始时间：2026-06-05
- 完成时间：2026-06-05
- 修改文件：
  - `.gitignore`
  - `package.json`
  - `server-poc/README.md`
  - `server-poc/server.mjs`
  - `server-poc/smoke.mjs`
  - `web-observer-poc/README.md`
  - `web-observer-poc/index.html`
  - `web-observer-poc/src/main.ts`
  - `web-observer-poc/src/styles.css`
  - `web-observer-poc/tsconfig.json`
  - `web-observer-poc/vite.config.ts`
  - `web-observer-poc/smoke.mjs`
  - `docs/autonomous-progress.md`
- 验证：
  - 执行 `npm run web-observer:poc:build`：通过；接入 `livekit-client` 后 H5 JS chunk 约 508 KB，后续生产化需要按 LiveKit 模块 code split 或独立部署优化。
  - 执行 `npm run web-observer:poc:smoke`：通过；扫描确认手机端源码不包含摄像头、麦克风、本地轨道发布、数据发布入口，并验证观察端并发限制。
  - 执行 `npm run server:poc:smoke`：通过。
  - 执行 `npm run build`：通过，仅有 Vite chunk 体积警告。
- 阻塞：
  - `server-poc` 仍只返回 mock token，手机 H5 当前只能验证只读授权策略；真实收看必须接入服务端真实 LiveKit JWT。
  - 未做公网移动网络、TURN、HTTPS、浏览器自动播放策略的现场验证。
- 下一步：执行 AD-06，建立 Media Worker IPC 骨架；先实现 mock 控制面和状态机，不进入真实 Windows 采集 API。

## AD-06 Media Worker IPC 骨架

- 状态：done
- 开始时间：2026-06-05
- 完成时间：2026-06-05
- 修改文件：
  - `package.json`
  - `media-worker-poc/README.md`
  - `media-worker-poc/worker.mjs`
  - `media-worker-poc/smoke.mjs`
  - `docs/autonomous-progress.md`
- 验证：
  - 执行 `npm run media-worker:poc:smoke`：通过；验证 `listDevices`、`start`、`status`、`stop`、重复启动和 `shutdown` ACK。
  - 执行 `npm run build`：通过，仅有 Vite chunk 体积警告。
  - 执行 `npm run server:poc:smoke`：通过。
  - 执行 `npm run web-observer:poc:smoke`：通过。
- 阻塞：
  - 当前 worker 只通过 JSON Lines 验证控制面，未接入 Media Foundation、WASAPI、USB 采集卡或真实 LiveKit 发布。
  - 真实媒体数据不能走该 IPC；后续 Native Worker 必须保持控制面和高带宽媒体面分离。
- 下一步：执行 AD-07，建立 Media Worker synthetic 发布 PoC；如无法真实接入 LiveKit native publisher，必须明确保持 mock publisher 状态，不得假报真实发布。

## AD-07 Media Worker synthetic 发布 PoC

- 状态：done
- 开始时间：2026-06-05
- 完成时间：2026-06-05
- 修改文件：
  - `media-worker-poc/README.md`
  - `media-worker-poc/worker.mjs`
  - `media-worker-poc/smoke.mjs`
  - `docs/autonomous-progress.md`
- 验证：
  - 执行 `npm run media-worker:poc:smoke`：通过；验证 `startSyntheticPublisher`、`stopSyntheticPublisher`、mock track 命名、`realPublisher=false`、`requiresNativeSdk=true`。
  - 执行 `npm run build`：通过，仅有 Vite chunk 体积警告。
  - 执行 `npm run server:poc:smoke`：通过。
  - 执行 `npm run web-observer:poc:smoke`：通过。
- 阻塞：
  - 未接入 LiveKit native SDK、真实 LiveKit server、真实 JWT 或真实媒体帧，因此不能声明已经完成媒体发布。
  - 当前只定义后续 Native Worker 发布控制契约和状态字段。
- 下一步：执行 AD-08，进入 USB 采集验证 PoC；该阶段可能受本机是否插入 USB 采集卡、麦克风、PTZ 设备影响，如无设备只能输出“无设备/仅 mock”结果。

## AD-08 USB 采集验证 PoC

- 状态：done
- 开始时间：2026-06-05
- 完成时间：2026-06-05
- 修改文件：
  - `package.json`
  - `media-worker-poc/README.md`
  - `media-worker-poc/device-probe.mjs`
  - `media-worker-poc/device-probe-smoke.mjs`
  - `docs/autonomous-progress.md`
- 验证：
  - 执行 `npm run media-worker:device-probe:smoke`：通过。
  - 执行 `npm run media-worker:device-probe`：通过；本机 ffmpeg DirectShow 枚举到 1 路视频 `HD Webcam` 和 1 路音频 `麦克风阵列 (Senary Audio)`。
  - 短时打开 `HD Webcam`：640x480@30，2 秒采集 21 帧，返回 `opened=true`。
  - 短时打开 `麦克风阵列 (Senary Audio)`：返回 `opened=true`，格式 `pcm_s16le, 44100 Hz, stereo`。
  - 执行 `npm run build`：通过，仅有 Vite chunk 体积警告。
  - 执行 `npm run media-worker:poc:smoke`：通过。
  - 执行 `npm run server:poc:smoke`：通过。
  - 执行 `npm run web-observer:poc:smoke`：通过。
- 阻塞：
  - 当前为 ffmpeg DirectShow 预检，不是最终 Media Foundation 视频采集，也不是 WASAPI 音频采集。
  - 未验证 USB 视频采集卡、腹腔镜 HDMI 采集、四路并发、PTZ USB 控制或长时间稳定性。
- 下一步：执行 AD-09，建立录像 manifest 与单路录像 PoC；可先用 worker/mock 或 DirectShow 短时文件写入验证元数据和异常恢复策略。

## AD-09 录像 manifest 与单路录像 PoC

- 状态：done
- 开始时间：2026-06-05
- 完成时间：2026-06-05
- 修改文件：
  - `.gitignore`
  - `package.json`
  - `docs/recording-manifest.md`
  - `media-worker-poc/README.md`
  - `media-worker-poc/recording-poc.mjs`
  - `media-worker-poc/recording-poc-smoke.mjs`
  - `docs/autonomous-progress.md`
- 验证：
  - 执行 `npm run recording:poc:smoke`：通过；校验 schema、患者未绑定、FTP 未配置、AI 预留接口、文件大小和 SHA-256。
  - 执行 `npm run recording:poc`：通过；本机生成 `runtime/recordings-poc/rec-20260605080233/manifest.json` 和 `field-camera.mkv`。
  - 单路短时录像结果：`HD Webcam`，640x480@30，2 秒，21 帧，文件约 798975 bytes，SHA-256 已写入 manifest。
  - 执行 `npm run build`：通过，仅有 Vite chunk 体积警告。
  - 执行 `npm run web-observer:poc:build`：通过，仅有 Vite chunk 体积警告。
  - 执行 `npm run server:poc:smoke`：通过。
  - 执行 `npm run web-observer:poc:smoke`：通过。
  - 执行 `npm run media-worker:poc:smoke`：通过。
  - 执行 `npm run media-worker:device-probe:smoke`：通过。
- 阻塞：
  - 当前录像仍基于 ffmpeg DirectShow 预检，不是最终 Native Media Worker 医疗录像链路。
  - 未验证多路同步录像、断电恢复、磁盘满处理、移动存储导出、FTP 上传、HIS 患者绑定、长期稳定性和隐私审计。
- 下一步：
  - 进入正式开发阶段前，应先固化真实 LiveKit JWT 签发服务、Native Worker 技术选型和 4 路 USB 采集硬件测试计划。

## PoC 基线固化

- 状态：done
- 开始时间：2026-06-05
- 完成时间：2026-06-05
- 修改文件：
  - `package.json`
  - `scripts/run-poc-tests.mjs`
  - `docs/test-plan.md`
  - `docs/poc-baseline-freeze.md`
  - `docs/README.md`
  - `docs/autonomous-progress.md`
- 验证：
  - 执行 `npm run test:all:poc`：通过，顺序完成桌面构建、手机 H5 构建、业务服务 smoke、手机观察端 smoke、Media Worker smoke、设备预检 smoke、录像 smoke。
- 阻塞：
  - 无人值守功能扩展已暂停。
  - 当前仍未提交 git；提交 PoC 基线需要用户明确确认。
- 下一步：
  - 建议先提交当前 PoC 基线，再进入真实 LiveKit JWT、Native Worker 技术路线和 4 路 USB 采集卡现场验证。

## 真实 LiveKit JWT / Native Worker / 4 路 USB 验证阶段

- 状态：in_progress
- 开始时间：2026-06-05
- 修改文件：
  - `package.json`
  - `package-lock.json`
  - `scripts/run-poc-tests.mjs`
  - `server-poc/server.mjs`
  - `server-poc/README.md`
  - `server-poc/real-token-smoke.mjs`
  - `media-worker-poc/native-readiness.mjs`
  - `media-worker-poc/native-readiness-smoke.mjs`
  - `media-worker-poc/usb4-validate.mjs`
  - `media-worker-poc/usb4-validate-smoke.mjs`
  - `.gitignore`
  - `native-worker/Cargo.toml`
  - `native-worker/Cargo.lock`
  - `native-worker/README.md`
  - `native-worker/list-devices.mjs`
  - `native-worker/smoke.mjs`
  - `native-worker/src/main.rs`
  - `native-worker/video-probe.mjs`
  - `native-worker/video-loop.mjs`
  - `native-worker/audio-probe.mjs`
  - `native-worker/session.mjs`
  - `native-worker/session-stress.mjs`
  - `src-tauri/src/main.rs`
  - `src/services/nativeWorkerService.ts`
  - `src/components/WorkbenchPage.tsx`
  - `src/styles.css`
  - `docs/next-stage-real-livekit-native-usb.md`
  - `docs/README.md`
- 验证：
  - 执行 `npm run server:poc:real-token-smoke`：通过，真实 JWT 结构和权限边界正确。
  - 执行 `npm run server:poc:smoke`：通过，mock 模式未被破坏。
  - 执行 `npm run media-worker:native-readiness`：通过，状态 `ready`。
  - 执行 `npm run media-worker:native-readiness:smoke`：通过。
  - 执行 `npm run media-worker:usb4-validate:smoke`：通过。
  - 执行 `npm run media-worker:usb4-validate`：返回 `blocked`，原因是当前仅检测到 1 路视频设备 `HD Webcam`，不足 4 路。
  - 执行 `npm run test:all:poc`：通过，已包含真实 JWT smoke、Native readiness smoke 和 USB4 validate smoke。
  - 执行 `npm run media-worker:native:build`：通过，Rust Native Worker 可构建。
  - 执行 `npm run media-worker:native:smoke`：通过，验证 `listDevices`、`start`、`status`、`stop`、`shutdown` 和事件输出。
  - 执行 `npm run media-worker:native:list-devices`：通过，返回 `source=windows-native`，Media Foundation 枚举 4 路视频设备，WASAPI 枚举 4 路采集音频端点。
  - 执行 `npm run media-worker:native:video-probe`：通过，第 0 路 `HD Webcam` 枚举 17 个原生媒体类型，并通过 SourceReader 读到 1 帧 `1280x720 NV12 30fps` 样本，`totalLengthBytes=1382400`。
  - 执行 `npm run media-worker:native:video-loop`：通过，第 0 路 `HD Webcam` 以 `1280x720 NV12 30fps` 媒体类型连续读取 2 秒，返回 `status=frames-measured`、`sampleCount=19`、`readCount=20`、`measuredFps=9.37`、`mediaTimelineFps=10.32`、`streamFlagNames=stream-tick`、`totalLengthBytes=26265600`。
  - WASAPI 阶段复测 `npm run media-worker:native:list-devices`：通过，当前 Windows 活跃设备为 1 路视频 `HD Webcam` 和 1 路音频 `麦克风阵列 (Senary Audio)`；该结果只反映当前接入状态，不覆盖前一次 4 路摄像头测试结果。
  - 执行 `npm run media-worker:native:audio-probe`：通过，第 0 路 `麦克风阵列 (Senary Audio)` mix format 为 48000Hz、2ch、EXTENSIBLE/IEEE_FLOAT、32-bit、blockAlign=8；500ms WASAPI capture 返回 `status=buffer-captured`、`packetCount=49`、`capturedFrames=23520`、`capturedBytes=188160`、`silentPackets=0`、`discontinuityPackets=1`。
  - 此前 metadata-only 阶段执行 `npm run media-worker:native:session`：通过，`start/status/stop` 返回真实采集会话骨架并默认启动 Media Foundation 视频统计线程和 WASAPI 音频统计线程；当前绑定 1 路视频 `HD Webcam`、1 路音频 `麦克风阵列 (Senary Audio)`，第 2 个请求通道为 `waiting-for-device`；500ms status 返回 `continuousVideoThreadCount=1`、`videoCaptureThreads.length=1`、`frameQueue.mode=metadata-only-bounded`、`frameQueue.capacity=3`、`frameQueue.pushCount=3`、`frameQueue.dropCount=0`、`videoCaptureThread.state=running`、`sampleCount=3`、`readCount=4`、`measuredFps=6.45`、`streamFlagNames=stream-tick`，以及 `audioCaptureThread.state=running`、`packetCount=45`、`capturedFrames=21600`、`capturedBytes=172800`、`audioLevel.status=measured`、`audioLevel.format=float32`、`audioLevel.rms=0.000012`、`audioLevel.peak=0.000342`、`discontinuityPackets=1`；`stop` 后 `captureSession.state=idle` 且 `stats.realMediaSession=false`。
  - 执行 `npm run media-worker:native:session-stress`：通过，连续 3 轮 start/status/stop，每轮 hold 1000ms；当前 1 路硬件下 `videoThreadCount=1`，视频样本数均为 8，`videoFrameQueuePushCount` 均为 8，`videoFrameQueueDropCount` 均为 5，音频 packet 数为 95/96/95，三轮 `audioLevel.status=measured`、`audioLevel.format=float32`，三轮 `stoppedState=idle`。
  - 执行 `$env:SMARTST_NATIVE_SESSION_STRESS_ITERATIONS=5; $env:SMARTST_NATIVE_SESSION_HOLD_MS=5000; npm run media-worker:native:session-stress`：通过，连续 5 轮 start/status/stop，每轮 hold 5000ms；当前 1 路硬件下每轮 `videoSamples=48`、`videoFrameQueuePushCount=48`、`videoFrameQueueDropCount=45`，音频 packet 数为 495/497/496/497/496，五轮均 `audioLevel.status=measured`、`stoppedState=idle`。
  - native payload queue 阶段复测 `npm run media-worker:native:session`：通过，500ms 内当前 1 路 `HD Webcam` 复制 3 帧 SourceReader sample payload 到 native-only 有界队列，`frameQueue.mode=native-payload-bounded`、`payloadQueue.mode=copied-bounded`、`payloadQueue.copyCount=3`、`payloadQueue.copyErrorCount=0`、`payloadQueue.bytes=4147200`、`payloadQueue.exportedOverJson=false`，`videoPayloadCopyCount=3`、`videoPayloadQueueBytes=4147200`。
  - native payload queue 阶段复测 `npm run media-worker:native:smoke` 和 `npm run media-worker:native:session-stress`：均通过，连续 3 轮 start/status/stop，每轮 hold 1000ms；当前 1 路硬件下每轮 `videoSamples=8`、`videoPayloadCopyCount=8`、`videoPayloadQueueBytes=4147200`、`payloadQueue.copyErrorCount=0`、`videoFrameQueueDropCount=5`。
  - native payload queue consume 阶段新增 `consumeVideoPayloadQueue` 和 `npm run media-worker:native:payload-consume`：通过，1000ms 内当前 1 路 `HD Webcam` 复制 8 帧 payload，手动 drain 2 帧，`consumedBytes=2764800`、`remainingDepth=1`、`videoPayloadConsumeCount=2`、`videoPayloadConsumedBytes=2764800`、`consumerStatus=manual-drain`、`exportedOverJson=false`。
  - 桌面控制面新增 Tauri `consume_native_worker_video_payload_queue` 命令、前端服务封装和工作台 `Drain payload` 按钮；按钮只触发 native queue drain 并刷新 JSON 状态，不显示或传输帧字节。
  - native payload queue 阶段复测 `cargo check --manifest-path src-tauri/Cargo.toml`、`cargo test --manifest-path src-tauri/Cargo.toml`、`npm run build`、`cargo build --manifest-path native-worker/Cargo.toml`、`npm run test:all:poc`：均通过，Tauri helper 单元测试 4/4 通过，新增 payload-consume 后完整回归耗时约 35-36 秒；仍有 Vite chunk 体积超过 500 kB 警告。
  - WASAPI audio payload queue 阶段新增 native-only 有界 PCM packet 队列：`audioCaptureThread.payloadQueue.mode=pcm-packet-bounded`、`transport=native-only`、`exportedOverJson=false`；`start/status` 汇总 `audioPayloadCopyCount`、`audioPayloadCopyErrorCount`、`audioPayloadQueueBytes`、`audioPayloadTotalCopiedBytes`。
  - 执行 `npm run media-worker:native:smoke` 和 `npm run media-worker:native:session-stress`：均通过，连续 3 轮 start/status/stop，每轮 hold 1000ms；当前 1 路音频端点下 `audioPackets=94/95/95`、`audioPayloadCopyCount=94/95/95`、`audioPayloadQueueBytes=192000`、`audioLevel.status=measured`、`audioLevel.format=float32`、`stoppedState=idle`。
  - WASAPI audio payload queue 阶段复测 `cargo check --manifest-path src-tauri/Cargo.toml`、`cargo test --manifest-path src-tauri/Cargo.toml`、`cargo build --manifest-path native-worker/Cargo.toml`、`npm run build`、`npm run test:all:poc`：均通过，Tauri helper 单元测试 4/4 通过，完整回归耗时约 35.2 秒；仍有 Vite chunk 体积超过 500 kB 警告。
  - audio payload queue consume 阶段新增 `consumeAudioPayloadQueue` 和 `npm run media-worker:native:audio-payload-consume`：通过，1000ms 内当前 1 路 `麦克风阵列 (Senary Audio)` 复制 94 个 PCM packet，手动 drain 5 个 packet，`consumedBytes=19200`、`remainingDepth=45`、`audioPayloadConsumeCount=5`、`audioPayloadConsumedBytes=19200`、`consumerStatus=manual-drain`、`exportedOverJson=false`。
  - 桌面控制面新增 Tauri `consume_native_worker_audio_payload_queue` 命令、前端服务封装和工作台 `Drain audio` 按钮；按钮只触发 native PCM queue drain 并刷新 JSON 状态，不显示或传输 PCM 字节。
  - audio payload queue consume 阶段复测 `cargo check --manifest-path src-tauri/Cargo.toml`、`cargo test --manifest-path src-tauri/Cargo.toml`、`npm run build`、`npm run media-worker:native:smoke`、`npm run media-worker:native:audio-payload-consume`、`npm run test:all:poc`：均通过，Tauri helper 单元测试 5/5 通过，完整回归耗时约 36.9 秒；仍有 Vite chunk 体积超过 500 kB 警告。
  - WASAPI audio profile 阶段新增 `npm run media-worker:native:audio-profile`：默认只启动音频线程并按 500ms 间隔读取 status，不传输 PCM payload；支持 `SMARTST_NATIVE_AUDIO_PROFILE_LABEL`、`SMARTST_NATIVE_AUDIO_PROFILE_DURATION_MS`、`SMARTST_NATIVE_AUDIO_PROFILE_SAMPLE_INTERVAL_MS`、`SMARTST_NATIVE_AUDIO_PROFILE_OUTPUT`，用于静音/讲话/外接全向麦对比样本。
  - 执行 `npm run media-worker:native:audio-profile`：通过，2 秒内采样 4 次，`packetCountStart=44`、`packetCountEnd=197`、`packetsProduced=153`、`capturedFramesEnd=94560`、`capturedBytesEnd=756480`、`audioLevelStatus=measured`、`audioLevelFormat=float32`、`rms.average=0.0002509`、`peak.max=0.0020614`、`payloadCopyDelta=153`、`payloadCopyErrorCountEnd=0`、`stoppedState=idle`。
  - audio profile 阶段复测 `npm run test:all:poc`：通过，完整回归耗时约 39.1 秒；仍有 Vite chunk 体积超过 500 kB 警告。
  - 执行 `cargo check --manifest-path src-tauri/Cargo.toml`：通过，新增 Tauri `get_native_worker_readiness`、`probe_native_worker_devices`、`start_native_worker_session`、`get_native_worker_session_status`、`stop_native_worker_session` 命令可编译。
  - 执行 `cargo test --manifest-path src-tauri/Cargo.toml`：通过，3 个 Tauri Native Worker helper 单元测试全部通过，覆盖默认 start 参数、workspace manifest 定位和 debug binary 路径命名。
  - 执行 `npm run build`：通过，Workbench 已接入 Native Worker readiness 状态条、手动 `Device Probe` 面板和手动 start/status/stop 控件；普通浏览器环境返回 `desktop-only`，不启动采集。
  - 执行 `npm run test:all:poc`：通过，完整回归耗时约 32.1 秒；仍有 Vite chunk 体积超过 500 kB 警告。
  - 执行控制面硬化后复测 `cargo check --manifest-path src-tauri/Cargo.toml`、`npm run build`、`npm run test:all:poc`：均通过，完整回归耗时约 32.3 秒；仍有 Vite chunk 体积超过 500 kB 警告。
- 4 路 USB 基础测试：
  - 接入设备：`HD Webcam`、`thinkplus Video Camera FHD`、`罗技高清网络摄像机 C930c`、`Rapoo Camera`。
  - 修正 `media-worker:usb4-validate` 为 4 路并发打开，不再逐路顺序打开。
  - 执行 60 秒 4 路并发测试：`status=degraded`，4 路均能打开，但 `HD Webcam` 约 10fps，`Rapoo Camera` wallFps 约 19.6、realtimeRatio 约 0.65。
  - 执行 `npm run test:all:poc`：通过。
- Native Worker 控制面骨架：
  - 已创建独立 Rust crate `native-worker`。
  - 已实现 JSON Lines stdin/stdout 控制面，支持 `listDevices`、`start`、`stop`、`consumeVideoPayloadQueue`、`consumeAudioPayloadQueue`、`status`、`shutdown`。
  - `listDevices` 已接入 Windows 原生枚举：Media Foundation 视频设备和 WASAPI/Core Audio 采集端点。
  - `start/status/stop` 已进入真实采集会话骨架：绑定当前视频/音频设备和默认媒体格式，缺失通道标记为 `waiting-for-device`，并在绑定设备时默认为每个已绑定视频通道启动可停止的 Media Foundation 视频统计线程，同时启动 WASAPI 音频统计线程。
  - 已增加 `media-worker:native:session-stress`，用于重复验证 start/status/stop 和线程 stop/join 清理。
  - 已增加 `probeVideoCapabilities` 和 `captureVideoSample`，可验证单路 Media Foundation 原生媒体类型和首帧样本读取。
  - 已增加 `measureVideoFrames`，可验证单路 Media Foundation 连续帧读取和帧率统计；真实帧 payload 仍留在 native 侧，不通过 JSON Lines 传输。
  - 已增加 `probeAudioFormat` 和 `captureAudioBuffer`，可验证 WASAPI mix format 和短时 capture buffer 读取。
  - 已增加 `media-worker:native:audio-profile`，可对当前 WASAPI capture endpoint 做短时 RMS/peak/profile 基线采样。
  - 当前已接入多路视频线程结构、native-only 有界帧 payload 队列、视频手动 drain 消费验证、Tauri/工作台 Drain video 控制、WASAPI RMS/peak 音量统计、native-only 有界 PCM packet payload 队列、音频手动 drain 消费验证和 stop/join 清理，但本轮本机只枚举到 1 路视频设备；尚未接入预览纹理、音频重采样/AEC、LiveKit native publisher 或真实录像。
  - 桌面端已新增 Native Worker readiness 诊断入口、工作台状态条、手动 `Device Probe` 面板、手动 start/status/stop 控件、`Drain video` 控件和 `Drain audio` 控件；`probe_native_worker_devices` 只通过 Native Worker 执行 `listDevices` 枚举，不执行 `start`，不启动连续采集线程；start/status/stop/drain 控件只展示 JSON 状态统计，不传输媒体 payload。
  - start/status/stop 控制面已补充失败捕获、面板内错误提示、running/idle 按钮约束、绑定视频/音频数量、native 视频线程数、frameQueue push/drop、视频 native payload queue bytes/copy/consume 和音频 native PCM queue bytes/copy/consume 展示；该展示仍是控制面状态展示，不承载媒体 payload。
  - Tauri 持有的 Native Worker session 已增加 Drop 清理，runtime 释放时会尝试发送 `shutdown` 并 kill/wait 子进程，降低未点 `Stop` 直接退出时的残留进程风险。
- 阻塞：
  - 当前 4 路摄像头基础链路可打开，但不满足 4 路 30fps 实时验收；按当前阶段决策，该性能降级只记录为开发机限制，不阻塞后续 Native Worker 开发。
  - 正式现场验证仍需要目标 USB 采集卡、目标摄像机和 30 分钟/2 小时压力测试。
- 下一步：
  - 用真实 `LIVEKIT_URL`、`LIVEKIT_API_KEY`、`LIVEKIT_API_SECRET` 启动业务服务，并由桌面 LiveKit PoC 面板连接真实房间。
  - 使用 `media-worker:native:audio-profile` 分别采集静音、讲话、外接全向麦样本，再推进重采样和 AEC 边界验证。
  - 将 Native Worker start/status/stop 控制面板推进到更完整的通道状态展示、错误恢复和 4 路硬件递增验证。
