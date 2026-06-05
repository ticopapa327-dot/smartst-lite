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
- 4 路 USB 基础测试：
  - 接入设备：`HD Webcam`、`thinkplus Video Camera FHD`、`罗技高清网络摄像机 C930c`、`Rapoo Camera`。
  - 修正 `media-worker:usb4-validate` 为 4 路并发打开，不再逐路顺序打开。
  - 执行 60 秒 4 路并发测试：`status=degraded`，4 路均能打开，但 `HD Webcam` 约 10fps，`Rapoo Camera` wallFps 约 19.6、realtimeRatio 约 0.65。
  - 执行 `npm run test:all:poc`：通过。
- 阻塞：
  - 当前 4 路基础链路可打开，但不满足 4 路 30fps 实时验收。
  - 正式现场验证仍需要目标 USB 采集卡、目标摄像机和 30 分钟/2 小时压力测试。
- 下一步：
  - 用真实 `LIVEKIT_URL`、`LIVEKIT_API_KEY`、`LIVEKIT_API_SECRET` 启动业务服务，并由桌面 LiveKit PoC 面板连接真实房间。
  - 接入 4 路 USB 硬件后执行 30 分钟 `media-worker:usb4-validate`。
