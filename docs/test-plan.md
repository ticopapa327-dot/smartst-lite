# 视捷UST 测试方案与计划

> 适用仓库：`<repo-root>`
> 当前阶段：AD-00 到 AD-09 PoC 基线。  
> 原则：先证明底层媒体链路，再承诺业务功能；先自动化回归，再现场硬件验收。

## 1. 测试分层

### L0 PoC 自动化回归

目标：确认当前源码没有破坏既有 PoC。

必跑命令：

```powershell
npm run test:all:poc
```

等价命令：

```powershell
npm run build
npm run web-observer:poc:build
npm run server:poc:smoke
npm run web-observer:poc:smoke
npm run media-worker:poc:smoke
npm run media-worker:device-probe:smoke
npm run recording:poc:smoke
```

通过标准：

- 所有命令退出码为 0。
- 允许 Vite chunk 体积警告，但不能有 TypeScript 错误。
- 生成产物只能位于 `dist/`、`dist-web-observer-poc/`、`runtime/`，不能进入 git 跟踪。

### L0.5 桌面发布产物验证

目标：确认 Windows 桌面端不是只依赖源码目录和调试 Worker。

必跑命令：

```powershell
npm run media-worker:native:build:release
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri:build:exe
npm run media-worker:native:release-smoke
npm run tauri:build
npm run tauri:install-smoke
```

通过标准：

- `src-tauri\target\release\ust-desktop-client.exe` 生成。
- `native-worker\target\release\ust-native-worker.exe` 生成。
- `src-tauri\target\release\bin\ust-native-worker.exe` 生成。
- `media-worker:native:release-smoke` 可直接启动 `src-tauri\target\release\bin\ust-native-worker.exe`，完成 `worker.ready -> listDevices -> shutdown`。
- `src-tauri\target\release\bundle\nsis\UST Desktop Client_0.1.4_x64-setup.exe` 生成。
- `src-tauri\target\release\nsis\x64\installer.nsi` 中必须包含 `File /a "/oname=bin\ust-native-worker.exe"` 和卸载删除项。
- `tauri:install-smoke` 只允许安装到 `USTDesktopClientNsisSmoke-*` 或 `USTDesktopClientNsisTest-*` 测试目录；必须验证安装文件、HKCU 卸载项、桌面/开始菜单快捷方式、安装目录 Worker 控制面、安装版主程序内部 smoke，以及静默卸载后无目录/注册表/快捷方式残留。安装版主程序内部 smoke 必须通过 `UST_DESKTOP_SMOKE=1` 启动 installed exe，并要求 `UST_DESKTOP_SMOKE_REQUIRE_PACKAGED=1`、`UST_DESKTOP_SMOKE_REQUIRE_AV=1` 下 packaged Worker ready、`start`、视频 drain、音频 drain 和 `stop` 全部通过。

### L0.6 三包部署边界验证

目标：确认后续发布不再把 LiveKit、业务服务、OR Agent 和 UI 混成同一生命周期。

当前阶段先做文档和脚本级验证，正式 Windows Service 验证在服务化实现后补齐。

命令：

```powershell
npm run service:config-preflight
```

通过标准：

- 安装角色必须能表达 `UST Server`、`UST OR Agent`、`UST Desktop Client`。
- Server 可同装手术室电脑，也可独立安装；Desktop Client 只配置 Server URL 和 OR Agent URL。
- `LIVEKIT_API_SECRET` 只允许存在于 Server 配置或服务环境中。
- Desktop Client 关闭不应作为 Server、LiveKit、OR Agent 或录像停止条件。
- OR Agent 必须能在无 UI 场景下执行设备枚举、短时采集和 stop 清理 smoke。
- 一体机 preflight 必须覆盖 Server、LiveKit、OR Agent、Native Worker、端口、防火墙和默认 room。

### L1 本机设备预检

目标：验证 Windows 本机能枚举并短时打开媒体设备。

命令：

```powershell
npm run media-worker:device-probe
```

通过标准：

- 输出 `probeApi=ffmpeg-directshow-preflight`。
- 明确 `mediaFoundation=false`、`wasapi=false`，不得误报为最终 Native Worker。
- 有设备时至少记录设备名、能力、打开结果。
- 无设备时必须返回可读结果，不崩溃。

### L2 真实硬件验证

目标：验证手术室目标硬件，而不是开发机内置摄像头。

必测场景：

| 场景 | 通过标准 |
| --- | --- |
| 无设备启动 | 应用正常启动，提示明确 |
| Native AV soak | `media-worker:native:av-soak` 至少 5 秒连续采集，视频/音频 copy counters 增长，周期 drain 成功，queue depth 有界，copy error 为 0 |
| WASAPI render 枚举、格式探测、静音写入和 loopback 初始化 | `media-worker:native:list-devices` 返回 `audioRender` 数组和 `diagnostics.wasapiRender.status`；`media-worker:native:audio-render-probe` 返回 render mix format；`media-worker:native:audio-render-silence` 返回 `renderClientStatus=opened-stopped` 和 `audibleOutput=silence`；`media-worker:native:audio-loopback-probe` 返回 `loopbackClientStatus=opened-stopped`，允许安静系统返回 `no-loopback-packets`；该项不等同有声回放、回放内容捕获或 AEC 通过 |
| 1 路 USB 采集卡 | 可预览、可短时录像、manifest 正确 |
| 4 路 USB 采集卡 | 30 分钟不黑屏、不崩溃 |
| 腹腔镜/内镜 HDMI 输入 | 分辨率、帧率、色彩和延迟可接受 |
| 热插拔 | 单路故障不影响其他路 |
| 设备占用 | 错误提示可读，可重试 |
| USB Hub 满载 | 不出现周期性掉线或通道错乱 |
| PTZ 摄像机 | 支持项可控，不支持项不显示误导按钮 |

### L3 LiveKit 与业务服务

目标：验证 UST Server、真实 JWT、真实房间互动。

命令：

```powershell
npm run server:poc:livekit-preflight:smoke

$env:LIVEKIT_URL="ws://127.0.0.1:7880"
$env:LIVEKIT_API_KEY="..."
$env:LIVEKIT_API_SECRET="..."
npm run server:poc:livekit-preflight
```

前置条件：

- UST Server 可访问；一体机部署时可通过手术室电脑固定 IP 访问。
- UST Server 能签发短期 JWT。
- 客户端没有 LiveKit API secret。
- TURN/TLS 策略明确。

必测场景：

| 场景 | 通过标准 |
| --- | --- |
| 端点注册 | 手术室、示教室、平板均在线 |
| 示教室呼叫手术室 | 待接、接受、拒绝、挂断状态正确 |
| 手术室呼叫示教室 | 反向呼叫成立 |
| 真实 LiveKit preflight | `server:poc:livekit-preflight` 能用真实 API key/secret 创建、查询并删除唯一测试 room，业务服务能为同一 room 签发真实 OR host 和手机观察端 JWT；无凭据时必须返回 `missing-livekit-env`，不得误报通过 |
| 仅收看模式 | 远端不能发布音视频 |
| 交互模式 | 双向语音稳定 |
| 默认画面 | 业务服务返回 `mediaPolicy`，默认画面选择原因可审计；token metadata 和真实 JWT metadata 与 `mediaPolicy` 一致；无可用视频时进入 audio-only |
| 请求其他通道 | 按需订阅，不默认全量推送 |
| 手机 H5 并发 | 手机端只订阅，手术室端只发布一次默认画面 |
| 人数超限 | 新用户收到明确提示 |

### L3.1 一体机真实连通性最小联调

目标：验证没有专用服务器时，手术室电脑可同时承担 LiveKit、业务服务和手机 H5 入口，远端设备通过手术室电脑固定 IP 接入。

命令：

```powershell
npm run livekit:install-dev
npm run connectivity:or-lab:start
npm run connectivity:or-lab:verify
npm run connectivity:or-lab:media-smoke
npm run connectivity:or-lab:or-agent-publisher-smoke
npm run connectivity:or-lab:stop
```

通过标准：

- `runtime/livekit/livekit-server.exe` 来自官方 release，下载后通过 SHA-256 校验。
- `connectivity:or-lab:start` 能启动 LiveKit、业务服务和 web-observer，并输出局域网访问地址。
- `connectivity:or-lab:verify` 能通过 RoomService 创建或确认真实 LiveKit room。
- 业务服务能为 OR host、示教室仅收看、示教室交互和手机 observer 分别签发真实 JWT。
- 手机 observer token 必须保持 `canPublish=false`、`canPublishData=false`。
- H5 observer 通过 `http://<手术室IP>:5175` 访问时，默认业务服务地址应自动指向 `http://<手术室IP>:4780`。
- `connectivity:or-lab:media-smoke` 能让 synthetic OR publisher 发布 `video:field-camera` 和 `audio:or-room`，示教室订阅者和多个手机 observer 都能收到轨道。
- `connectivity:or-lab:media-smoke` 必须确认非 OR 参与者发布轨道数为 0，手机 observer 仍不能发布音视频或 data。
- `connectivity:or-lab:or-agent-publisher-smoke` 必须通过业务服务完成呼叫、接受、room、token、入会和默认画面订阅，且 OR publisher 的源必须来自 Native Worker 真实视频/音频 payload queue。
- `connectivity:or-lab:or-agent-publisher-smoke` 当前允许使用 PPM/WAV 文件桥接；该项通过不代表生产发布链路已经完成。
- 联调停止命令只停止 `runtime/or-connectivity/processes.json` 中记录的本轮进程。

### L4 录像、导出和恢复

目标：验证医疗录像链路稳定性。

必测场景：

| 场景 | 通过标准 |
| --- | --- |
| 单路 10 分钟 | 文件可播放，manifest 有大小和 SHA-256 |
| 单路 2 小时 | 文件完整，无明显音画问题 |
| 4 路 30 分钟 | 多文件完整，CPU/内存稳定 |
| 4 路 2 小时 | 不崩溃，manifest 可检索 |
| 录制中断电/崩溃 | 已写片段可恢复，事件记录完整 |
| 磁盘不足 | 提前预警，不写坏 manifest |
| U 盘导出 | 文件大小和校验一致 |
| FTP/SFTP/FTPS 上传 | 失败可重试，错误原因可读 |

### L5 HIS、隐私和审计

目标：确保患者信息和敏感凭据不泄漏。

必测项：

- LiveKit secret 不进入客户端、日志和配置文件。
- HIS 凭据、FTP 密码不明文落盘。
- 录像文件名不包含患者姓名、身份证号。
- 示教室和手机端默认脱敏。
- 手机 H5 源码不包含发布音视频、PTZ、标注、data publish 入口。
- 呼叫、录像、导出、上传、删除、患者绑定均有审计记录。

## 2. 执行计划

| 阶段 | 周期 | 目标 | 退出标准 |
| --- | --- | --- | --- |
| T0 | 当前 | 固化 PoC 基线 | `npm run test:all:poc` 通过 |
| T1 | 1 周 | 真实设备预检 | 输出硬件兼容和风险清单 |
| T2 | 1-2 周 | 4 路 USB 采集压力测试 | 4 路 30 分钟稳定 |
| T3 | 1-2 周 | 真实 LiveKit 呼叫互动 | 1 路主画面 + 语音 30 分钟稳定 |
| T4 | 2-3 周 | 多路录像和恢复 | 4 路 2 小时录像可回放 |
| T5 | 1-2 周 | HIS/隐私/审计 | 无敏感信息泄漏 |
| T6 | 1 周 | 部署和验收 | 输出院内试点验收报告 |

## 3. 停止条件

出现以下情况必须停止开发并先处理测试问题：

- `npm run test:all:poc` 失败。
- 手机 H5 出现发布音视频或 data 的代码入口。
- 客户端出现 LiveKit secret、HIS 凭据或 FTP 密码。
- 4 路采集在 30 分钟内黑屏、错路或崩溃。
- 录像 manifest 与实际文件不一致。
- 手机并发导致手术室端上行按人数增长。

## 4. 当前已知边界

- 当前 LiveKit 已完成本机真实 JWT、RoomService、一体机服务连通、synthetic 媒体转发 smoke 和 Native Worker 文件桥接 publisher smoke；尚未完成生产级无文件 native publisher、双终端人工呼叫验收和 30 分钟双向语音稳定性。
- 当前设备验证是 ffmpeg DirectShow 预检，不是最终 Media Foundation/WASAPI。
- 当前录像是短时 DirectShow 文件写入，不是正式 Native Media Worker 医疗录像。
- 当前业务服务是内存 PoC，没有数据库、认证和审计持久化。
- 当前 Windows Service 仍是配置模板和预检，不是已安装的生产服务。
