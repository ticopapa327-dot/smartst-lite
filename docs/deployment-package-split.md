# UST 三包部署标准

> 日期：2026-06-06
> 适用范围：视捷UST 后续开发、安装器设计、现场部署和测试验收。
> 结论：服务端程序、手术室后端和桌面客户端必须逻辑分离、独立生命周期管理；物理部署可以同机，也可以分机。

## 1. 决策

真实项目环境通常没有专用服务器，LiveKit 和业务服务可能安装在手术室电脑上。这不等于把所有能力塞进一个桌面进程。

后续开发按三个部署单元推进：

1. `UST Server`
   - LiveKit Server。
   - UST 业务服务。
   - 房间、呼叫、JWT、权限、人数限制。
   - 手机 H5 访问码和 subscribe-only token。
   - 可选 HIS、录像索引、上传、审计。
   - 只在该单元保存 `LIVEKIT_API_SECRET`。

2. `UST OR Agent`
   - USB 采集卡、摄像机、音频设备和 PTZ 控制。
   - Native Media Worker 生命周期管理。
   - 本地预览、录像、导出、设备恢复。
   - 向 LiveKit 发布默认画面和音频，或向发布组件提供媒体帧。
   - 不保存 LiveKit API secret，只使用业务服务签发的短期 token。

3. `UST Desktop Client`
   - 手术室 UI、示教室 UI、配置和人工操作入口。
   - 调用 `UST Server` 和 `UST OR Agent`。
   - UI 崩溃不应导致 LiveKit、业务服务、采集或录像中断。
   - 不保存 LiveKit API secret、HIS 凭据或 FTP 密码。

## 2. 物理部署模式

### 2.1 一体机部署

默认适用于大多数现场：

```text
手术室 Windows 电脑
  UST Server
    livekit-server.exe
    ust-business-service.exe 或 node service
  UST OR Agent
    ust-or-agent.exe
    ust-native-worker.exe
  UST Desktop Client
    ust-desktop-client.exe
```

特点：

- 不需要额外服务器。
- 示教室客户端、Android 会议平板、手机 H5 连接手术室电脑 IP 或内网域名。
- 手术室电脑必须使用有线网络和固定 IP。
- 安装器需要管理员权限创建 Windows Service 和防火墙规则。

### 2.2 分机部署

适用于更规范的院内部署：

```text
院内服务节点
  UST Server

手术室 Windows 电脑
  UST OR Agent
  UST Desktop Client

示教室 Windows 电脑
  UST Desktop Client
```

特点：

- Server 升级、日志和防火墙管理更清晰。
- 手术室电脑资源压力更低。
- 需要额外主机或虚拟机。

### 2.3 客户端部署

适用于示教室和会议平板：

```text
示教室 Windows 电脑
  UST Desktop Client

Android 会议平板
  UST Tablet Client

手机
  web-observer H5
```

特点：

- 不部署 LiveKit Server。
- 不部署业务服务。
- 不保存 API secret。

## 3. 进程与生命周期

正式环境要求：

- `UST Server` 作为 Windows Service 运行。
- `UST OR Agent` 作为 Windows Service 或受控后台进程运行。
- `UST Desktop Client` 作为普通桌面应用运行。
- Desktop Client 可以显示服务状态、发起重启请求和打开日志，但不直接持有服务密钥。
- UI 关闭时，本地录像和 LiveKit 房间服务不得被强制结束。

禁止：

- LiveKit 作为 Tauri UI 的普通子进程随窗口启停。
- 业务服务 API secret 写入客户端配置。
- OR Agent 和 Desktop Client 通过高带宽 JSON IPC 传输整帧视频。
- 手机端绕过业务服务直接拿管理员 token。

## 4. 安装器要求

安装器必须支持角色选择：

```text
[ ] UST Server
[ ] UST OR Agent
[ ] UST Desktop Client
```

组合建议：

- 手术室电脑默认安装三项。
- 示教室电脑只安装 `UST Desktop Client`。
- 独立服务节点只安装 `UST Server`。

安装 `UST Server` 或 `UST OR Agent` 时必须：

- 要求管理员权限。
- 写入 `C:\ProgramData\UST\`。
- 创建 Windows Service。
- 创建 Windows 防火墙规则。
- 生成或导入 `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`。
- 校验端口占用。
- 输出安装后 preflight 报告。

## 5. 配置和端口

默认一体机配置：

```text
UST Server
  businessApi: http://0.0.0.0:4780
  livekitUrl: ws://<手术室固定IP>:7880
  livekitApi: http://127.0.0.1:7880
  livekitUdpMuxPort: 7882

UST OR Agent
  controlApi: http://127.0.0.1:4781
  mediaWorkerPath: C:\Program Files\UST\or-agent\ust-native-worker.exe

Desktop Client
  serverUrl: http://<手术室固定IP>:4780
  orAgentUrl: http://127.0.0.1:4781
```

端口必须可配置。正式跨网或手机复杂网络场景，应使用 `wss://`、可信证书和 TURN/TLS。

当前配置模板：

| 角色 | 模板 |
| --- | --- |
| UST Server | `deploy/config/ust-server.example.json` |
| UST OR Agent | `deploy/config/ust-or-agent.example.json` |
| UST Desktop Client | `deploy/config/ust-desktop-client.example.json` |

配置模板必须通过：

```powershell
npm run service:config-preflight
```

该预检只验证配置边界和默认端口，不代表 Windows Service 已经安装完成。

## 6. 开发迁移路径

当前仓库继续保留 PoC，但后续代码按目标目录演进：

```text
apps/
  desktop-client/
  web-observer/
services/
  ust-server/
agents/
  or-agent/
workers/
  native-media-worker/
packages/
  contracts/
infra/
  livekit/
  windows-service/
```

迁移顺序：

1. 把 `server-poc` 固化为 `UST Server` 原型。
2. 把 Tauri 后端中 Native Worker 管理能力下沉到 `UST OR Agent`。
3. Desktop Client 改为调用 Server 和 OR Agent，不直接承担服务端职责。
4. NSIS 增加角色安装和 Windows Service 管理。
5. 增加一体机 preflight：Server、LiveKit、OR Agent、Native Worker、端口、防火墙、默认 room。

## 7. 验收标准

一体机部署通过标准：

- 重启 Windows 后 `UST Server` 和 `UST OR Agent` 自动启动。
- Desktop Client 关闭后，Server 和 OR Agent 仍保持运行。
- `server:poc:livekit-preflight` 或等价生产 preflight 通过。
- OR Agent 能枚举采集设备并启动默认采集会话。
- 示教室客户端可通过手术室电脑 IP 呼叫并进入 LiveKit room。
- 手机 H5 可单向订阅默认画面，不能发布音视频或 data。
- 多个手机 H5 观察者并发时，由 LiveKit/SFU 转发同一组 OR 轨道；OR Agent 不能按手机数量增加上行发布。
- 本地录像不依赖 LiveKit room 存活。

分机部署通过标准：

- Desktop Client 只需配置 Server URL 和 OR Agent URL。
- Server 与 OR Agent 可以分别升级和重启。
- API secret 只存在 Server 配置和服务环境中。
