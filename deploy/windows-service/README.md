# UST Windows Service 边界

> 范围：服务化安装设计说明。当前仓库仍处于 PoC 阶段，本文件不是生产安装脚本。

## 服务拆分

正式安装时至少拆成三个生命周期：

```text
UST Server
  livekit-server.exe
  ust-business-service.exe 或 node server service

UST OR Agent
  ust-or-agent.exe
  ust-native-worker.exe

UST Desktop Client
  ust-desktop-client.exe
```

## 原则

- `LIVEKIT_API_SECRET` 只能存在于 `UST Server` 的服务环境变量或 `C:\ProgramData\UST\server\` 受限配置中。
- `UST OR Agent` 只持有短期 token，不保存 LiveKit API secret。
- `UST Desktop Client` 只保存 Server URL、OR Agent URL 和 UI 配置，不保存 LiveKit API secret、HIS 凭据或 FTP 密码。
- Desktop Client 关闭不能停止 Server、LiveKit、OR Agent 或录像任务。
- OR Agent 可以作为 Windows Service，也可以在早期试点中作为受控后台进程随手术室端启动；但它必须和 Desktop Client 生命周期解耦。

## 端口

| 组件 | 端口 | 协议 | 方向 | 说明 |
| --- | ---: | --- | --- | --- |
| UST business service | 4780 | TCP/HTTP | 入站 | 呼叫、room、token、observer |
| UST OR Agent control | 4781 | TCP/HTTP | 本机优先 | 设备、采集、录像控制 |
| web-observer H5 | 5175 | TCP/HTTP | 入站 | PoC 手机观察页；生产可由 Server 托管 |
| LiveKit HTTP/WebSocket | 7880 | TCP | 入站 | WebSocket、RoomService |
| LiveKit ICE TCP | 7881 | TCP | 入站 | WebRTC TCP fallback |
| LiveKit ICE UDP mux | 7882 | UDP | 入站 | WebRTC 媒体 |

跨网段或公网必须另行配置 TLS、TURN、域名和证书；不能使用当前 `--dev` LiveKit 模式。

## 后续安装脚本要求

后续 NSIS 或 MSI 角色安装必须支持：

```text
[ ] UST Server
[ ] UST OR Agent
[ ] UST Desktop Client
```

安装 `UST Server` 或 `UST OR Agent` 时必须：

- 要求管理员权限。
- 写入 `C:\ProgramData\UST\...` 配置。
- 创建 Windows Service。
- 创建 Windows Defender Firewall 规则。
- 输出安装后 preflight 报告。
- 卸载时只删除本产品创建的服务、规则和文件，不影响用户录像目录。

当前可验证内容见：

```powershell
npm run service:config-preflight
npm run connectivity:or-lab:start
npm run connectivity:or-lab:verify
npm run connectivity:or-lab:media-smoke
```
