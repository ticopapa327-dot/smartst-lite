# SmartST Lite

SmartST Lite 是面向 Windows 手术室终端的桌面版手术示教软件项目。当前主线只保留 USB-first 手术室工作台、LiveKit/SFU 互动、Native Media Worker、本机 LiveKit 联调、SmartST Server / OR Agent / Desktop Client 三包边界相关代码。

旧版 0.1.4 的 ONVIF/RTSP 发起端、接收端、RTSP 转 HLS 前端预览和对应 Tauri 命令已从当前代码中移除。RTSP、SRT、ONVIF 只作为后续高级兼容输入方向保留在架构文档中，不再作为默认产品入口。

## 当前主线

```text
USB UVC / USB 采集卡优先
Native Media Worker 本地采集、payload queue、短时导出和采集验证
LiveKit / SFU 负责实时房间、音视频转发和权限边界
SmartST Server 负责呼叫、room、token、HIS、文件、上传和审计
SmartST OR Agent 负责手术室采集、PTZ、录像和本地设备恢复
Desktop Client 只负责 UI 和操作入口，不保存 LiveKit API secret
手机 H5 仅单向收看，手机并发由 LiveKit/SFU 承担
Android 会议平板作为可安装正式客户端规划
```

## 关键入口

- 开发文档入口：[docs/README.md](docs/README.md)
- 当前测试计划：[docs/test-plan.md](docs/test-plan.md)
- 真实连通性联调：[docs/real-connectivity-lab.md](docs/real-connectivity-lab.md)
- 下一阶段记录：[docs/next-stage-real-livekit-native-usb.md](docs/next-stage-real-livekit-native-usb.md)
- 三包部署边界：[docs/deployment-package-split.md](docs/deployment-package-split.md)

## 常用命令

```powershell
npm install
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run test:all:poc
```

本机 LiveKit 连通性联调：

```powershell
npm run connectivity:or-lab:start
npm run connectivity:or-lab:verify
npm run connectivity:or-lab:media-smoke
npm run connectivity:or-lab:or-agent-publisher-smoke
npm run connectivity:or-lab:stop
```

Tauri 构建：

```powershell
npm run tauri:build:exe
npm run tauri:build
npm run tauri:install-smoke
```

## 当前边界

- OR Agent publisher adapter 仍是 `@livekit/rtc-node` + Native Worker PPM/WAV 文件桥接 smoke，不是生产级无文件发布链路。
- `server-poc` 仍是内存业务服务原型，不是带数据库、认证和审计的生产 SmartST Server。
- Windows Service 目前只有配置模板和预检，不是已安装可自恢复服务。
- 4 路 USB 采集卡 30 分钟/2 小时现场验收尚未完成。
- 双终端人工呼叫、入会、默认画面渲染和 30 分钟双向语音/AEC 尚未完成。

## 安全要求

不得提交真实摄像机密码、医院内网地址、LiveKit API secret、HIS 凭据、FTP/SFTP/FTPS 密码、真实患者信息或真实手术录像。Desktop Client、OR Agent 和手机 H5 不得保存 LiveKit API secret。
