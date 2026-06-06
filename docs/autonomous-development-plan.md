# SmartST Lite 无人值守开发执行计划

> 适用仓库：`D:\我的工作\AOV\SmartST Lite`  
> 日期：2026-06-05  
> 目的：为后续大量无人值守开发提供可执行、可验证、可中断恢复的计划。  
> 执行原则：小批次推进，每批必须可构建、可回滚思路清晰、可继续接手；不得为了速度跳过边界、权限、安全和媒体链路验证。

## 1. 总体策略

无人值守开发按批次执行，不按“大功能一次性完成”执行。

每个批次必须满足：

- 明确输入文档。
- 明确允许修改的目录。
- 明确禁止修改的目录或能力。
- 明确完成定义。
- 明确验证命令。
- 明确失败停止条件。

默认执行顺序：

```text
AD-00 文档与仓库基线
AD-01 领域模型与 HMI 视觉 token
AD-02 工作台 UI 骨架
AD-03 业务服务 PoC
AD-04 LiveKit UI PoC
AD-05 手机 H5 单向观察 PoC
AD-06 Media Worker IPC 骨架
AD-07 Media Worker synthetic 发布 PoC
AD-08 USB 采集验证 PoC
AD-09 录像 manifest 与单路录像 PoC
```

当前不进入：

- HIS 正式对接。
- FTP 上传。
- AI 识别。
- Android 会议平板正式 App。
- Native Media Worker 完整 C++/Rust 媒体链路。
- 多路正式医疗归档录像。

这些功能必须等 PoC 通过后再进入正式开发。

## 2. 无人值守通用规则

每一批开始前必须执行：

```powershell
git status --short --untracked-files=all
npm run build
```

如果构建失败：

- 先判断是否由上一批改动导致。
- 只修复本批相关问题。
- 不得顺手重构无关模块。

每一批结束前必须执行：

```powershell
npm run build
git status --short --untracked-files=all
```

如涉及 Rust/Tauri command：

```powershell
npm run tauri:build:exe
```

仅在本机依赖允许且耗时可控时执行；失败时必须记录失败原因。

## 3. 自动停止条件

遇到以下情况必须停止并报告，不继续无人值守推进：

- 需要真实 LiveKit secret、HIS 凭据、FTP 密码、医院内网地址。
- 需要真实 USB 采集卡、全向麦、PTZ 摄像机等硬件才能判断。
- `npm run build` 连续两次因同一问题失败且无法在当前批次内明确修复。
- 需要删除或重写大量现有功能，影响 README 中记录的 0.1.4 现状。
- 需要改变手机端单向收看原则。
- 需要让手术室端承担手机多并发转发。
- 需要在客户端硬编码 LiveKit secret。
- 需要偏离 `or-preview HMI palette v0.3` 视觉标准。
- 发现用户新增或修改的未提交文件与当前批次冲突。

可自动处理的情况：

- 新增类型、服务、组件骨架。
- 更新文档引用。
- 修复 TypeScript 类型错误。
- 修复样式 token 和布局问题。
- 添加 mock 服务和 fake token，用于 PoC，但必须明确不是生产 secret。
- 添加测试或脚本。

## 4. 目录策略

当前阶段允许新增：

```text
src/domain/
src/services/
src/components/
src/features/
server-poc/
media-worker-poc/
web-observer-poc/
docs/
```

当前阶段谨慎修改：

```text
src-tauri/src/main.rs
src-tauri/Cargo.toml
package-lock.json
README.md
package.json
```

当前阶段禁止：

```text
真实凭据文件
真实患者数据
真实医院内网地址
真实录像文件
```

## 5. 批次计划

### AD-00 文档与仓库基线

目标：清除旧方向误导，明确新开发入口。

输入：

- `docs/development-readiness.md`
- `docs/README.md`
- `docs/ui-visual-style.md`

允许修改：

- `README.md`
- `package.json`
- `docs/*`

任务：

- 根 `README.md` 改为新架构入口。
- 不保留旧 0.1.4 ONVIF/RTSP UI 和旧 RTSP/HLS 预览代码；RTSP/SRT 后续按高级输入重新设计。
- `package.json` description 和 keywords 改成 USB-first / LiveKit / surgery teaching。
- 明确 `docs/README.md` 是当前文档入口。

完成定义：

- 新人打开仓库不会误以为主线是 2 路 ONVIF。
- `npm run build` 通过。

停止条件：

- 根 README 有用户未保存的重要重写，无法判断保留内容。

### AD-01 领域模型与 HMI 视觉 token

目标：先建立类型和视觉约束，不大改业务 UI。

允许修改：

- `src/domain/*`
- `src/styles.css`
- 少量组件引用 token。

任务：

- 新增 `mediaTypes.ts`、`roomTypes.ts`、`endpointTypes.ts`。
- 定义 `ClientType`、`RoomMode`、`VideoChannel`、`AcceptedCallMediaPolicy`、`ParticipantLimits`。
- 写入 HMI CSS token。
- 旧 `CameraConfig` / ONVIF / RTSP-HLS 前端路径不再作为兼容负担；当前主线按 USB-first 通道模型推进。

完成定义：

- TypeScript 编译通过。
- 页面视觉不出现大面积蓝色、紫蓝渐变、玻璃拟态。

验证：

```powershell
npm run build
```

### AD-02 工作台 UI 骨架

目标：建立 USB-first 手术室工作台骨架，暂不接真实采集。

允许修改：

- `src/components/*`
- `src/features/*`
- `src/App.tsx`
- `src/styles.css`

任务：

- 新增 `WorkbenchPage`。
- 新增 `ChannelGrid`，默认 4 路占位：全景、术野、医疗设备、辅助。
- 新增 `CallPanel`，显示呼叫、默认画面、仅收看/交互策略。
- 新增 `RecordingPanel`，仅做 disabled 或 mock 状态。
- UI 使用 HMI token。
- 旧发起端/接收端可保留入口，但新工作台成为开发主入口。

完成定义：

- 无真实设备时界面可打开。
- 4 路通道卡片稳定，不因状态文字变化产生布局跳动。
- `npm run build` 通过。

### AD-03 业务服务 PoC

目标：用本地 mock 服务跑通端点、呼叫、token 策略模型。

允许新增：

```text
server-poc/
```

任务：

- 建立最小 Node/TypeScript 或轻量 JS 服务。
- API：endpoint register、heartbeat、call create、accept、reject、room token mock。
- token 暂用 mock string，不包含真实 LiveKit secret。
- 实现 `maxInteractiveParticipants`、`maxTabletClients`、`maxWebObservers` 的内存检查。

完成定义：

- 可本地启动。
- 可用 curl/PowerShell Invoke-WebRequest 验证主要 API。
- 手机 H5 超出并发时不返回 token。

停止条件：

- 需要真实认证体系或数据库时停止，不扩大范围。

### AD-04 LiveKit UI PoC

目标：当前 Windows UI 用 `livekit-client` 跑通一路音视频。

允许修改：

- `package.json`
- `package-lock.json`
- `src/services/livekitRoomService.ts`
- `src/components/*`

任务：

- 安装 `livekit-client`。
- 建立 LiveKit room service。
- 支持填入 LiveKit URL 和 mock token。
- 发布一路摄像头和麦克风。
- 订阅远端默认画面。
- 仅收看模式禁止发布音频。

完成定义：

- 无真实 LiveKit 时 UI 不崩溃，提示需要配置。
- 有 LiveKit 环境变量或配置时可手动验证。
- 构建通过。

停止条件：

- 需要真实 LiveKit secret。
- 需要公网 TURN 配置。

### AD-05 手机 H5 单向观察 PoC

目标：实现手机端只读入口模型。

允许新增：

```text
web-observer-poc/
```

任务：

- 建立 H5 单页或 Vite 子应用。
- 输入访问码或 room code。
- 从 `server-poc` 获取 watch-only token。
- 只展示默认画面和手术室音频。
- 不渲染麦克风、摄像头、标注、PTZ、requestTrack。
- 使用 HMI 色板的移动布局。

完成定义：

- 代码层没有发布音视频入口。
- token metadata 标记 `clientType=web-observer`、`mode=watch-only`。
- 构建通过。

### AD-06 Media Worker IPC 骨架

目标：先做 Worker 控制面，不碰真实采集。

允许新增：

```text
media-worker-poc/
```

任务：

- 建立独立 worker 进程骨架。
- 提供 `listDevices`、`start`、`stop`、`status` mock。
- UI 或脚本可启动 worker 并获取 JSON 状态。
- 定义事件模型：device、channel、recording、livekit、stats、error。

完成定义：

- worker 可启动、停止、重复启动。
- 主进程或脚本能调用状态接口。

停止条件：

- 需要真实 Windows 摄像头 API 时先停止到 AD-08。

### AD-07 Media Worker synthetic 发布 PoC

目标：验证 Worker 发布边界，但先不接摄像头。

任务：

- Worker 生成 synthetic video/audio 状态。
- 如果 LiveKit C++ SDK 暂不可控，先输出 mock publisher 状态和接口。
- 记录后续 C++ SDK 接入点。

完成定义：

- Worker 控制 API 和状态机完整。
- 不假装已经真实发布 LiveKit。

停止条件：

- LiveKit C++ SDK 依赖不可下载或不可构建。

### AD-08 USB 采集验证 PoC

目标：验证真实 Windows 采集能力。该阶段可能需要人工插入硬件。

任务：

- Media Foundation 枚举视频设备。
- WASAPI 枚举音频设备。
- 输出设备列表和能力。
- 打开 1 路设备并记录帧率、分辨率、错误。

完成定义：

- 有硬件时能输出真实设备快照。
- 无硬件时能给出明确“无设备”结果，不崩溃。

停止条件：

- 需要现场硬件验证 2 小时或 4 路压力测试。

### AD-09 录像 manifest 与单路录像 PoC

目标：先建立录像元数据和恢复策略。

任务：

- 定义 `RecordingManifest`。
- 写入 mock manifest。
- 如果已有真实采集，尝试单路短时文件写入。
- 不承诺正式医疗录像。

完成定义：

- manifest 结构稳定。
- 异常结束状态可记录。

## 6. 状态记录要求

每个无人值守批次结束后，必须在最终回复中报告：

- 本批次编号。
- 修改文件。
- 验证命令和结果。
- 未完成项。
- 下一批次建议。

如果批次跨多轮执行，建议维护：

```text
docs/autonomous-progress.md
```

记录格式：

```md
## AD-xx 批次名

- 状态：pending / in_progress / done / blocked
- 开始时间：
- 完成时间：
- 修改文件：
- 验证：
- 阻塞：
- 下一步：
```

## 7. 验证矩阵

| 批次 | 必跑验证 |
| --- | --- |
| AD-00 | `npm run build` |
| AD-01 | `npm run build` |
| AD-02 | `npm run build` |
| AD-03 | 服务启动 + API smoke |
| AD-04 | `npm run build`，有环境时 LiveKit 手测 |
| AD-05 | H5 构建或静态页面 smoke |
| AD-06 | Worker 启停 smoke |
| AD-07 | Worker synthetic 状态 smoke |
| AD-08 | 设备枚举 smoke |
| AD-09 | manifest 写入 smoke |

## 8. 质量门槛

必须保持：

- TypeScript 严格编译通过。
- Rust 侧不引入未验证的大型依赖。
- UI token 统一，不出现偏离视觉基线的页面。
- 旧功能不被无意删除。
- 敏感信息不进入仓库。
- 手机端始终只读。
- LiveKit secret 永远只在服务端。

## 9. 优先级判断

遇到取舍时按以下顺序：

1. 本地预览和录像稳定性。
2. 权限、token、安全边界。
3. 默认画面和呼叫流程正确性。
4. 手机 H5 并发不压手术室端。
5. UI 视觉一致性和触控可用性。
6. 功能丰富度。

不要为了提前展示更多按钮牺牲前五项。

## 10. 下一步自动执行入口

下一轮无人值守开发应从 `AD-00 文档与仓库基线` 开始。

建议第一条执行命令：

```powershell
git status --short --untracked-files=all
npm run build
```

然后按 AD-00 修改 `README.md` 和 `package.json`，完成后再次构建。
