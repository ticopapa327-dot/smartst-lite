# SmartST Lite

SmartST Lite 是面向 Windows 手术室终端的桌面版手术示教软件项目。新阶段开发主线是：

```text
USB UVC / USB 采集卡优先
LiveKit / SFU 实时互动
Native Media Worker 本地采集和录像
业务服务统一呼叫、权限、token、HIS、文件和审计
Android 会议平板作为正式客户端
手机 H5 仅单向收看
冷灰蓝 HMI 医疗设备控制屏视觉
```

当前根 README 是仓库入口。详细开发依据以 [docs/README.md](docs/README.md) 为准；无人值守开发按 [docs/autonomous-development-plan.md](docs/autonomous-development-plan.md) 执行。

## 当前状态

当前代码仍是 `0.1.4` MVP 基线，不是完整 LiveKit 版本，也不是 USB-first 可交付版本。

已实现的历史能力：

- 桌面客户端外壳：Tauri 2 + React + TypeScript + Vite。
- 发起端/接收端主要界面。
- 局域网 ONVIF 自动发现。
- ONVIF GetStreamUri 获取 RTSP 地址。
- FFmpeg 将 RTSP 转为本地 HLS 预览。
- 本地配置持久化。
- 基础日志系统。

已完成的新阶段 PoC：

- USB-first 工作台 UI 骨架。
- 业务服务 PoC：端点注册、呼叫、房间、mock token、观察端并发限制。
- LiveKit UI PoC：桌面端手动连接面板、仅收看/交互模式边界、远端 track DOM 挂载。
- 手机 H5 单向观察 PoC：只获取 `web-observer` 订阅权限，不发布音视频或数据。
- Media Worker IPC PoC：JSON Lines 控制面、mock 设备、状态、事件、synthetic publisher 状态。
- USB 设备预检 PoC：ffmpeg DirectShow 枚举和短时打开验证。
- 录像 manifest 与单路短时录像 PoC。

仍未实现为正式能力：

- USB UVC / USB 采集卡 4 路本地预览。
- LiveKit 真实 JWT 签发、生产权限模型和端到端发布/订阅。
- Native Media Worker 正式媒体链路。
- Android 会议平板客户端。
- 多通道医疗录像、回放、导出、上传。
- HIS 患者绑定和录像索引。

## 架构边界

必须遵守：

- USB 采集卡是默认视频输入；ONVIF/RTSP 降级为高级兼容能力。
- LiveKit 只负责实时房间、音视频转发、权限、Data/RPC 和可选 Egress。
- Native Media Worker 负责 Windows 本地采集、编码、录像、PTZ、设备恢复。
- 业务服务负责 token、呼叫、HIS、录像索引、上传和审计。
- 手机端不安装客户端，只作为 `web-observer` 单向收看。
- 手机观看并发必须由 LiveKit/SFU 转发，手术室端只发布一次默认画面。
- Android 会议平板可以安装客户端，是正式示教/会诊终端。
- UI 必须采用 `or-preview HMI palette v0.3` 冷灰蓝医疗设备控制屏风格。

禁止：

- 客户端硬编码 LiveKit secret。
- 继续把 ONVIF/RTSP 作为主流程扩展。
- 让手机端发布音频、视频、标注、PTZ 或控制消息。
- 让手术室终端为每台手机单独推流或转码。
- 把 WebView2 `MediaRecorder` 当作正式医疗录像方案。
- 使用大面积蓝色、紫蓝渐变、霓虹发光、玻璃拟态或 BI 驾驶舱式视觉。

## 文档入口

推荐阅读顺序：

1. [docs/development-readiness.md](docs/development-readiness.md)
2. [docs/autonomous-development-plan.md](docs/autonomous-development-plan.md)
3. [docs/livekit-desktop-surgery-teaching-architecture.md](docs/livekit-desktop-surgery-teaching-architecture.md)
4. [docs/livekit-native-media-worker-service-feasibility.md](docs/livekit-native-media-worker-service-feasibility.md)
5. [docs/ui-visual-style.md](docs/ui-visual-style.md)
6. [docs/livekit-desktop-surgery-teaching-development-plan.md](docs/livekit-desktop-surgery-teaching-development-plan.md)
7. [docs/usb-first-rearchitecture.md](docs/usb-first-rearchitecture.md)

## 无人值守开发

后续自动开发按批次推进：

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

每批次状态记录在 [docs/autonomous-progress.md](docs/autonomous-progress.md)。

## 本地开发

环境要求：

- Windows 10 / Windows 11。
- Node.js 20+。
- Rust stable。
- Tauri 2 所需 Windows 构建工具。
- FFmpeg：当前历史 RTSP/HLS 预览仍需要；新阶段 Native Media Worker 会重新定义媒体依赖。

安装依赖：

```powershell
npm install
```

启动桌面开发版：

```powershell
npm run tauri:dev
```

只启动前端调试：

```powershell
npm run dev
```

构建前端：

```powershell
npm run build
```

构建 Windows 可执行文件：

```powershell
npm run tauri:build:exe
```

构建安装包：

```powershell
npm run tauri:build
```

## 发布与安全

不得提交：

- 真实摄像机密码。
- 医院内部地址。
- LiveKit API secret。
- HIS 凭据。
- FTP/SFTP/FTPS 密码。
- 真实患者信息。
- 真实手术录像。

如后续捆绑 FFmpeg、GStreamer、LiveKit SDK 或其他媒体组件，必须核对许可证、二进制分发和安装包体积。

## License

MIT
