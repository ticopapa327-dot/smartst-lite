# 视捷UST 真实连通性最小联调

> 日期：2026-06-06
> 范围：手术室电脑一体机部署的最小真实联调，不涉及网站发布。

## 1. 当前工作区边界

本轮只处理 视捷UST 开发联调。以下本地文件属于网站文案准备或其目录入口，不纳入真实连通性提交：

- `docs/README.md`
- `docs/website-product-introduction.md`

不得因为联调需要把网站文案、网站发布脚本或站点部署流程混入本轮开发。

## 2. 本机环境结论

本机当前具备：

- Node.js、npm、Rust、Cargo。
- 可用局域网 IPv4：`<OR-PC-LAN-IP>`。
- `4780`、`5175`、`7880` 在联调前未被占用。
- `livekit-server.exe` 已按官方 GitHub release 下载到 `runtime/livekit/`，该目录被 `.gitignore` 忽略。

本机当前不具备：

- PATH 中的系统级 `livekit-server`。
- Docker。

因此当前最小联调采用 `runtime/livekit/livekit-server.exe` 直接运行，不依赖 Docker。

## 3. 一体机拓扑

```text
手术室 Windows 电脑 <OR-PC-LAN-IP>
  LiveKit Server
    ws://<OR-PC-LAN-IP>:7880
    TCP 7880 / TCP 7881 / UDP 7882

  UST business service PoC
    http://<OR-PC-LAN-IP>:4780
    端点、房间、token、手机 observer 权限

  web-observer H5 PoC
    http://<OR-PC-LAN-IP>:5175
    手机浏览器单向收看入口

  UST Desktop Client / OR Agent
    本机 UI、Native Worker 和后续采集控制
```

示教室电脑、Android 会议平板和手机均连接 `<OR-PC-LAN-IP>`。虚拟网卡地址、VPN 地址和 Docker/Hyper-V 地址不能作为默认对外联调地址。

## 4. 启动和停止

首次准备 LiveKit 开发二进制：

```powershell
npm run livekit:install-dev
```

启动手术室一体机联调服务：

```powershell
npm run connectivity:or-lab:start
```

该命令会：

- 启动 LiveKit Server。
- 启动业务服务并绑定 `0.0.0.0:4780`。
- 启动手机 H5 observer 并绑定 `0.0.0.0:5175`。
- 在 `runtime/or-connectivity/livekit.keys` 写入本机联调用 API key/secret。
- 在 `runtime/or-connectivity/processes.json` 记录进程和访问地址。

创建真实 LiveKit room，并让业务服务签发 OR、示教室和手机 observer token：

```powershell
npm run connectivity:or-lab:verify
```

验证结果和短期 token 写入：

```text
runtime/or-connectivity/session.json
```

验证真实 LiveKit 媒体转发边界：

```powershell
npm run connectivity:or-lab:media-smoke
```

该命令使用 `@livekit/rtc-node` 创建一个 synthetic OR publisher，向真实 LiveKit room 发布 `video:field-camera` 和 `audio:or-room`，再让示教室订阅者和多个手机 observer 同时订阅。该验证只证明 LiveKit/SFU 媒体转发、订阅权限和手机只读并发边界，不等同于真实 OR Agent 已经把 USB 摄像头或采集卡视频发布到 LiveKit。

验证 OR Agent publisher adapter：

```powershell
npm run connectivity:or-lab:or-agent-publisher-smoke
```

该命令通过业务服务注册手术室端和示教室端，示教室发起呼叫，手术室端接受后生成 room 和短期 token；随后启动 Native Worker，从真实 Media Foundation / WASAPI payload queue 导出 PPM/WAV 短时样本并发布到 LiveKit。该验证证明“真实本机采集源 -> OR publisher adapter -> LiveKit -> Desktop teaching subscriber / 手机 observer”的最小闭环。

边界必须明确：当前 adapter 使用 PPM/WAV 文件交接，只适合 smoke 和工程合同验证；生产发布链路必须替换为无文件落地的 native SDK / FFI / WHIP adapter。

停止联调服务：

```powershell
npm run connectivity:or-lab:stop
```

## 5. 客户端接入

### 桌面端

启动桌面开发版：

```powershell
npm run tauri:dev
```

在 LiveKit PoC 面板中填写：

```text
LiveKit URL: ws://<OR-PC-LAN-IP>:7880
JWT token: 复制 runtime/or-connectivity/session.json 中对应角色 token
```

手术室端使用 `tokens.orHost.token`。示教室仅收看使用 `tokens.teachingWatch.token`，交互模式使用 `tokens.teachingInteractive.token`。

### 手机 H5

手机浏览器访问：

```text
http://<OR-PC-LAN-IP>:5175
```

页面会根据当前访问主机自动把业务服务地址设置为：

```text
http://<OR-PC-LAN-IP>:4780
```

房间码使用 `runtime/or-connectivity/session.json` 中的 `roomCode`。手机端只能通过 `/api/observer/token` 获取 `web-observer` 只读 token，不能发布音频、视频或 data。

## 6. 当前验证边界

已经验证的内容：

- LiveKit Server 二进制可启动。
- 业务服务可用真实 LiveKit API key/secret 签发 JWT。
- RoomService 可创建和查询真实 room。
- OR host、示教室仅收看、示教室交互、手机 observer token 权限边界可区分。
- 手机 observer 仍为 `canPublish=false`、`canPublishData=false`。
- synthetic OR publisher 可向 LiveKit 发布 1 路默认画面和 1 路手术室音频。
- 示教室订阅者和 3 个手机 observer 可同时收到同一组 OR 轨道；非 OR 参与者发布轨道数为 0，说明手机并发没有变成 OR Agent 多路上行。
- OR Agent publisher adapter 可从 Native Worker 真实 payload queue 发布 `video:field-camera` 和 `audio:or-room`；Desktop teaching subscriber 通过业务服务呼叫/同意/token 流程入会后可收到默认画面和音频。
- 三包配置模板可通过 `npm run service:config-preflight` 验证，Server、OR Agent、Desktop Client 的 secret 和端口边界清晰。

尚未完成的内容：

- OR Agent 生产级无文件桥接发布链路。
- 桌面 UI 在两台真实终端上完成手术室同意、示教室入会和远端画面长期渲染。
- 示教室端远程订阅主画面和双向语音 30 分钟稳定性。
- Android 会议平板正式客户端。
- Windows Service 化安装。
- Windows 防火墙自动开规则。
- 目标 USB 采集卡 4 路长时间现场验收。

## 7. 风险和约束

- 当前 API key/secret 是本机联调用开发凭据，只能保存在 `runtime/` 和服务端进程环境中。
- `runtime/or-connectivity/session.json` 包含短期 JWT，不得提交。
- 如果示教室或手机打不开地址，优先检查 Windows Defender 防火墙是否允许 `livekit-server.exe`、`node.exe` 或对应端口。
- 生产环境不能使用 `--dev` 启动 LiveKit，必须改为正式配置、证书、TURN 和审计策略。

## 8. 本轮执行结果

执行时间：2026-06-06。

已完成：

- 通过 LiveKit 官方 GitHub release 下载 `v1.12.0` Windows AMD64 二进制到 `runtime/livekit/`，并完成 SHA-256 校验。
- 执行 `runtime/livekit/livekit-server.exe --version`：返回 `livekit-server version 1.12.0`。
- 执行 `npm run connectivity:or-lab:start`：通过，启动 LiveKit、业务服务和 H5 observer。
- 修正脚本问题：
  - Windows PowerShell 5 不支持 `RandomNumberGenerator::Fill`，已改为兼容的 `Create().GetBytes()`。
  - `Start-Process` 参数需要显式 quoting，已修复路径含空格时的参数截断。
  - LiveKit 在 Windows 上拒绝 key-file 权限，已改为只让 LiveKit 服务进程继承 `LIVEKIT_KEYS`，`runtime/or-connectivity/livekit.keys` 仅供本地 verify 脚本读取。
  - 自动 IP 选择曾误选 `198.19.0.1`，已改为优先 RFC1918 局域网地址，当前使用 `<OR-PC-LAN-IP>`。
  - Node 读取 PowerShell UTF-8 BOM JSON 时回退默认地址，已增加 BOM 去除。

当前运行状态：

```text
LiveKit:        ws://<OR-PC-LAN-IP>:7880
Business API:   http://<OR-PC-LAN-IP>:4780
Web observer:   http://<OR-PC-LAN-IP>:5175
Room code:      ST-LAB-<timestamp>
Session file:   runtime/or-connectivity/session.json
```

端口验证：

```text
TCP 4780 listen 0.0.0.0
TCP 5175 listen 0.0.0.0
TCP 7880 listen
TCP 7881 listen
UDP 7882 bound by livekit-server
```

命令验证：

```powershell
npm run connectivity:or-lab:verify
npm run server:poc:livekit-preflight
npm run web-observer:poc:build
npm run web-observer:poc:smoke
npm run server:poc:livekit-preflight:smoke
npm run test:all:poc
```

结果：

- `connectivity:or-lab:verify` 通过，创建真实 LiveKit room，业务服务签发 OR host、示教室仅收看、示教室交互和手机 observer 真实 JWT。
- `server:poc:livekit-preflight` 通过，RoomService 创建、查询并删除测试 room，observer 仍为 subscribe-only。
- `connectivity:or-lab:media-smoke` 通过，synthetic OR publisher 发布 `video:field-camera` 和 `audio:or-room`；示教室订阅者和 3 个手机 observer 都收到两条轨道；手机 observer 保持 `canPublish=false`、`canPublishData=false`；LiveKit participant 检查显示 OR 端只发布 2 条轨道，非 OR 参与者发布 0 条轨道。
- `connectivity:or-lab:or-agent-publisher-smoke` 通过，业务服务呼叫状态为 `accepted`，roomCode=`ST-ORPUB-<timestamp>`；Native Worker 绑定 1 路视频和 1 路音频；OR publisher 发布 13 帧视频、15 个音频 frame、150 个音频 packet；Desktop teaching subscriber 和 1 个手机 observer 均收到默认画面和音频；非 OR 参与者发布轨道数为 0。
- `service:config-preflight` 通过，配置模板验证 business `4780`、OR Agent control `4781`、LiveKit HTTP `7880`、ICE TCP `7881`、ICE UDP `7882`、H5 observer `5175`，并确认 LiveKit API secret 只属于 Server。
- `http://<OR-PC-LAN-IP>:4780/health` 返回 `ok=true`。
- `http://<OR-PC-LAN-IP>:5175` 返回 HTTP 200。
- `Test-NetConnection <OR-PC-LAN-IP>:7880` 返回 `TcpTestSucceeded=True`。
- `npm run test:all:poc` 完整回归通过，最近一次耗时约 68.5 秒。

仍未验证：

- 桌面端实际使用 `runtime/or-connectivity/session.json` 中 token 入会。
- OR 端生产级 native publisher。
- 两台真实 Desktop Client 的人工呼叫、同意、订阅、交互语音 30 分钟稳定性。
- 手机浏览器跨设备实际收看。

## 9. 防火墙端口清单

| 组件 | 端口 | 协议 | 方向 | 当前用途 |
| --- | ---: | --- | --- | --- |
| UST business service | 4780 | TCP/HTTP | 入站 | 呼叫、room、token、observer |
| UST OR Agent control | 4781 | TCP/HTTP | 本机优先 | 设备、采集、录像控制；正式部署可限制为本机或可信网段 |
| web-observer H5 | 5175 | TCP/HTTP | 入站 | PoC 手机观察页；生产建议由 Server 托管或反代 |
| LiveKit HTTP/WebSocket | 7880 | TCP | 入站 | WebSocket、RoomService |
| LiveKit ICE TCP | 7881 | TCP | 入站 | WebRTC TCP fallback |
| LiveKit ICE UDP mux | 7882 | UDP | 入站 | WebRTC 媒体优先通道 |

一体机联调必须先验证手术室电脑本机监听，再从示教室电脑、Android 会议平板或手机所在网段验证访问。不能只看本机 `127.0.0.1` 成功。

## 10. LiveKit / TURN / 媒体转发配置

- 本机 PoC 使用 LiveKit `--dev` 模式和 `LIVEKIT_KEYS` 环境变量，仅限开发联调。
- 生产或跨网段部署必须改为正式 LiveKit 配置文件、`wss://`、可信证书、访问审计和 TURN/TLS。
- 手机端只作为 `web-observer` subscribe-only 参与者进入 LiveKit room，token 必须保持 `canPublish=false`、`canPublishData=false`。
- 手术室端对默认画面只发布一次，手机并发由 LiveKit/SFU 转发；不允许 OR Agent 为每个手机创建独立推流、转码或采集会话。
- `@livekit/rtc-node` 当前只用于本仓库自动化 media smoke 和 OR Agent publisher adapter smoke；生产 OR Agent publisher 仍应走 Native Worker + 稳定 SDK/FFI/WHIP 方案，不能直接把 Developer Preview SDK 当作交付依赖。

## 11. 失败排查表

| 现象 | 优先检查 | 处理要求 |
| --- | --- | --- |
| 示教室或手机打不开 `4780` / `5175` | 手术室电脑 IP、Windows 防火墙、Node 监听地址 | 确认绑定 `0.0.0.0`，再放行对应 TCP 端口 |
| LiveKit room 创建失败 | `runtime/or-connectivity/livekit.keys`、`LIVEKIT_KEYS`、`7880` 监听 | 不得把 API secret 写入客户端配置 |
| 已入会但无媒体 | `7882/UDP` 是否可达，必要时看 `7881/TCP` fallback | 跨网段必须准备 TURN；不能靠增加 OR 端推流数解决 |
| 手机 observer 能发布音视频或 data | 业务服务 token grants、JWT metadata、H5 源码入口 | 立即停止测试，修正权限后重跑 `connectivity:or-lab:verify` 和 `media-smoke` |
| 手机数量增加导致 OR 上行线性增长 | LiveKit participant track 数、OR Agent 发布策略 | OR 端只能发布一次默认画面；并发必须由 SFU 承担 |
| 默认画面不一致 | `mediaPolicy.defaultChannelId`、`defaultTrackName`、客户端布局读取逻辑 | 禁止依赖设备枚举顺序或 LiveKit track 到达顺序 |
