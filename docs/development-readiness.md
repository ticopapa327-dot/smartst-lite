# SmartST Lite 开发启动基线

> 适用仓库：`D:\我的工作\AOV\SmartST Lite`  
> 日期：2026-06-05  
> 目的：把当前文档、代码基线、架构决策和第一阶段开发任务统一起来，作为进入开发阶段的入口。

## 1. 当前结论

开发方向采用：

```text
Windows 手术室客户端
  Tauri/React UI
  Native Media Worker

Windows 示教室客户端
  Tauri/React UI
  LiveKit 订阅/交互

Android 会议平板客户端
  正式客户端
  LiveKit Android SDK

手机 H5
  web-observer
  单向收看

业务服务
  呼叫、权限、token、HIS、录像索引、上传、审计

LiveKit/SFU
  实时音视频转发
  手机多并发媒体转发
```

关键边界：

- USB UVC/USB 采集卡是默认视频输入；RTSP/SRT 是高级兼容或备选输入。
- LiveKit 只做实时房间、权限、音视频转发、Data/RPC 和可选 Egress。
- Native Media Worker 负责 Windows 本地采集、编码、录像、PTZ、设备恢复。
- 业务服务负责所有 token、呼叫、HIS、文件、上传、审计和人数控制。
- 手机端不安装客户端，只做 H5 单向收看，不发布音频/视频/Data。
- 手机多并发必须由 LiveKit/SFU 转发；手术室端只发布一次默认画面。
- Android 会议平板可以安装客户端，是正式示教/会诊终端。
- UI 配色必须参考 `D:\我的工作\AOV\SOP\shoushi-or-platform\doc\首视数字化手术室软件开发计划.md`，采用 `or-preview HMI palette v0.3` 冷灰蓝医疗设备控制屏风格。

## 2. 文档体系

| 文档 | 当前用途 | 开发阶段地位 |
| --- | --- | --- |
| `README.md` | 0.1.4 ONVIF/RTSP MVP 历史说明 | 仅作现状参考，不能作为新架构开发依据 |
| `docs/usb-first-rearchitecture.md` | USB-first 重构方向 | 架构转向依据 |
| `docs/livekit-desktop-surgery-teaching-architecture.md` | 完整功能架构 | 产品和系统架构主文档 |
| `docs/livekit-native-media-worker-service-feasibility.md` | LiveKit + Worker + 业务服务可行性 | 技术实现和 PoC 主文档 |
| `docs/livekit-desktop-surgery-teaching-development-plan.md` | 阶段计划和验收 | 排期和验收主文档 |
| `docs/ui-visual-style.md` | UI 配色和视觉 token | 前端开发强制视觉基线 |
| `docs/autonomous-development-plan.md` | 无人值守开发批次计划 | 自动执行主计划 |
| `docs/autonomous-progress.md` | 无人值守批次进度 | 批次完成/阻塞记录 |
| `docs/development-readiness.md` | 本文档 | 开发启动入口 |

进入编码前必须解决的文档问题：

- 根 `README.md` 仍以 ONVIF/RTSP MVP 为主，需要在开发分支上改成新架构入口。
- `package.json` 描述仍是 “up to two ONVIF cameras”，需要在新架构第一轮代码开始时更新。
- 当前文档已经确认不能继续把 ONVIF/RTSP 作为主流程。

## 3. 当前代码基线

当前代码状态：

- 客户端：Tauri 2 + React + TypeScript + Vite。
- Rust：Tauri commands 已实现配置、日志、ONVIF、RTSP/HLS 预览相关能力。
- `src/domain/types.ts` 仍是 `CameraConfig` / ONVIF / RTSP 模型。
- `src/services/realtimeService.ts` 仍是本地假房间状态，LiveKit 未接入。
- `package.json` 尚无 `livekit-client`，尚无业务服务、Media Worker、Android 客户端、H5 观察端。

不能误判：

- 当前仓库不是 LiveKit 可运行版本。
- 当前预览链路仍偏 RTSP/HLS，不是 USB-first 4 路采集。
- 当前呼叫状态是本地 TODO，不是实际信令。

## 4. 目标模块划分

建议从当前单体仓库逐步演进，不要一开始大规模搬目录。

第一阶段新增：

```text
src/
  domain/
    mediaTypes.ts
    roomTypes.ts
    endpointTypes.ts
  services/
    mediaWorkerClient.ts
    livekitRoomService.ts
    businessApiClient.ts
  components/
    WorkbenchPage.tsx
    ChannelGrid.tsx
    CallPanel.tsx
    RecordingPanel.tsx

server-poc/
  token-service
  endpoint-registry
  call-signaling

media-worker-poc/
  synthetic-publisher
  media-foundation-capture
  recording-poc

web-observer-poc/
  phone-watch-only-page
```

第二阶段再评估是否改成 workspace：

```text
apps/windows-client
apps/android-tablet
apps/web-observer
services/business-service
workers/media-worker
packages/contracts
infra/livekit
```

不建议第一天就重构为完整 monorepo。当前更重要的是验证媒体链路。

## 5. 开发顺序

### Sprint 0：基线整理

目标：把旧 MVP 和新架构边界固定下来。

任务：

- 更新根 `README.md`：明确 README 是新架构入口，旧 ONVIF/RTSP 是历史能力。
- 更新 `package.json` 描述和 keywords。
- 新增 shared contracts 初稿：终端类型、房间模式、默认画面、token 权限。
- 建立 UI token：冷灰蓝 HMI palette，不另起大面积蓝色科技屏风格。
- 保留旧 ONVIF/RTSP 功能，但从主 UI 路线移出或标记为高级兼容。

验收：

- 新人打开仓库不会误以为主线是 2 路 ONVIF。
- 新界面使用 `or-preview HMI palette v0.3`，不出现紫蓝渐变、玻璃拟态、大面积蓝色导航。
- `npm run build` 通过。

### Sprint 1：LiveKit UI PoC

目标：当前 Tauri UI 先跑通一路 LiveKit。

任务：

- 引入 `livekit-client`。
- 实现业务服务 token mock 或 `server-poc`。
- 手术室端发布一路摄像头和麦克风。
- 示教室端订阅默认画面和音频。
- 仅收看 token 不能发布音频。

验收：

- 30 分钟单路远程观看稳定。
- 双向语音在交互模式可用。
- token 不包含 LiveKit secret。

### Sprint 2：业务服务 PoC

目标：呼叫和权限不再靠 UI 假状态。

任务：

- endpoint register / heartbeat。
- call create / accept / reject / hangup。
- room create / token issue。
- `defaultChannelId` 写入 accept payload。
- `maxInteractiveParticipants`、`maxTabletClients`、`maxWebObservers`。

验收：

- 示教室/平板可呼叫手术室。
- 手术室接受后才签发 token。
- 手机 H5 超出并发不签发 token。

### Sprint 3：Native Media Worker synthetic PoC

目标：验证 Worker 进程和 LiveKit 发布边界。

任务：

- 独立 `smartst-media-worker.exe`。
- IPC 控制：start / stop / join / publishSynthetic。
- 发布 synthetic 视频帧和测试音频到 LiveKit。
- UI 可启动、停止、重启 Worker。

验收：

- Worker 发布 synthetic 音视频 2 小时不崩溃。
- UI 崩溃重启后能恢复 Worker 控制。

### Sprint 4：真实 USB 采集 PoC

目标：验证 Windows 真实采集链路。

任务：

- Media Foundation 枚举视频设备。
- WASAPI 枚举音频设备。
- 打开 1 路 USB 采集卡。
- 扩展到 2 路、4 路压力测试。
- 设备占用和热插拔错误事件。

验收：

- 1 路 1080p30 采集 2 小时。
- 2 路 1080p30 采集 1 小时。
- 4 路目标硬件 30 分钟。

### Sprint 5：手机 H5 单向收看 PoC

目标：验证手机并发由 SFU 承担。

任务：

- `web-observer-poc` 访问码页面。
- watch-only token。
- 只展示默认画面。
- 禁止发布音频、视频、Data/RPC。
- 5 到 20 个手机浏览器并发观看测试。

验收：

- 手机端只能收看。
- 手术室端只发布 1 路默认画面。
- 手术室端上行不随手机数量线性增长。

## 6. 第一批领域模型

```ts
export type ClientType =
  | "or-windows"
  | "teaching-windows"
  | "tablet-client"
  | "web-observer";

export type RoomMode = "watch" | "interactive" | "conference";

export type VideoChannelRole =
  | "field"
  | "panorama"
  | "endoscope"
  | "device"
  | "auxiliary";

export interface VideoChannel {
  id: string;
  displayName: string;
  role: VideoChannelRole;
  enabled: boolean;
  healthy: boolean;
  localPrimary: boolean;
  remoteDefault: boolean;
  priority: number;
}

export interface AcceptedCallMediaPolicy {
  defaultChannelId?: string;
  defaultTrackName?: string;
  defaultChannelDisplayName?: string;
  defaultSelectionReason:
    | "manual-accept"
    | "local-primary"
    | "remote-default"
    | "priority"
    | "audio-only";
  startupVideoMode: "default-video" | "audio-only";
  mode: RoomMode;
  allowedChannelIds: string[];
  publishOtherChannelsOnDemand: boolean;
}

export interface ParticipantLimits {
  maxInteractiveParticipants: number;
  maxTabletClients: number;
  maxWebObservers: number;
}
```

## 7. Go / No-Go

进入完整开发的 Go 条件：

- LiveKit 单路主画面 + 双向语音 PoC 通过。
- 业务服务能签发不同权限 token。
- Worker synthetic 发布 PoC 通过。
- 真实 USB 采集至少 1 路 2 小时稳定。
- 手机 H5 并发验证确认由 SFU 转发，手术室只发布一次。

No-Go 条件：

- 客户端需要保存 LiveKit secret。
- 手机观看需要手术室逐个推流或逐个转码。
- 仅收看和交互权限不能有效区分。
- 本地录像依赖远程连接状态。
- 目标 USB 采集卡不能稳定打开。

## 8. 当前必须避免

- 不要先做 HIS、AI、FTP、完整会议模式。
- 不要继续扩展 ONVIF/RTSP 主流程。
- 不要把 4 路视频默认全部发布给远端。
- 不要让手机端参与交互。
- 不要让手机并发压到手术室端。
- 不要在客户端硬编码 LiveKit secret。
- 不要把 WebView2 `MediaRecorder` 当作正式录像方案。
- 不要偏离 `or-preview HMI palette v0.3`，不要做互联网后台、BI 驾驶舱或蓝紫科技屏视觉。

## 9. 立即下一步

建议按以下顺序执行：

1. 按 `docs/autonomous-development-plan.md` 从 `AD-00` 开始执行。
2. 更新根 `README.md` 和 `package.json`，清理旧方向误导。
3. 新增 shared domain types，先不大改 UI。
4. 建 `server-poc`，实现 token 和 call mock。
5. 接入 `livekit-client`，跑通当前 UI 单路 LiveKit。
6. 并行建立 `media-worker-poc`，先发布 synthetic frame。
7. 再做真实 USB 采集和手机 H5 并发验证。
