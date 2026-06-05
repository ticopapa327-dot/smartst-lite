# SmartST Lite PoC 基线固化记录

> 日期：2026-06-05  
> 状态：暂停无人值守功能扩展，固化当前 AD-00 到 AD-09 PoC 成果。  
> 仓库：`D:\我的工作\AOV\SmartST Lite`

## 1. 固化范围

本次固化覆盖以下成果：

- 文档基线：架构、可行性、开发计划、无人值守计划、UI 视觉、录像 manifest、测试计划。
- 桌面 UI PoC：USB-first 工作台、4 路占位、呼叫策略、录像策略、LiveKit 手动连接面板。
- 业务服务 PoC：端点注册、心跳、呼叫、房间、mock token、观察端人数限制。
- 手机 H5 PoC：`web-observer` 单向收看，禁止发布音视频和 data。
- Media Worker PoC：JSON Lines 控制面、mock 设备、状态机、synthetic publisher mock 状态。
- 设备预检 PoC：ffmpeg DirectShow 枚举和短时打开。
- 录像 PoC：manifest v0.1、单路短时文件、SHA-256、AI 和 FTP 状态预留。

## 2. 关键路径

- 文档入口：`docs/README.md`
- 进度记录：`docs/autonomous-progress.md`
- 测试计划：`docs/test-plan.md`
- 一键回归：`scripts/run-poc-tests.mjs`
- 业务服务：`server-poc/`
- 手机 H5：`web-observer-poc/`
- Media Worker：`media-worker-poc/`
- 运行产物：`runtime/`，已忽略，不提交。

## 3. 当前验证入口

```powershell
npm run test:all:poc
```

该命令顺序执行：

```text
npm run build
npm run web-observer:poc:build
npm run server:poc:smoke
npm run web-observer:poc:smoke
npm run media-worker:poc:smoke
npm run media-worker:device-probe:smoke
npm run recording:poc:smoke
```

最近一次固化验证：

- 时间：2026-06-05
- 命令：`npm run test:all:poc`
- 结果：通过，耗时约 24.1 秒。
- 剩余警告：桌面端和手机 H5 的 Vite chunk 体积超过 500 kB，后续生产化需要 code split。

## 4. 不能误读为完成的能力

- 未完成真实 LiveKit JWT 签发。
- 未完成真实 LiveKit server 端到端互动验收。
- 未完成 Native Media Worker 正式采集、编码、录像。
- 未完成 4 路 USB 采集卡压力测试。
- 未完成 PTZ USB 控制。
- 未完成 HIS 正式接口、患者绑定和审计。
- 未完成 FTP/SFTP/FTPS 上传。
- 未完成 Android 会议平板正式客户端。
- 未完成多显示器扩展和标注同步。

## 5. 下一阶段进入条件

继续开发前必须先满足：

- 当前基线 `npm run test:all:poc` 通过。
- 明确是否提交当前 PoC 基线。
- 确定真实 LiveKit 部署方式和 JWT 签发服务边界。
- 准备至少 4 路 USB 采集卡、目标摄像机、全向麦和显示器。
- 确定 Native Worker 技术路线：Rust/C++/GStreamer/FFmpeg/Media Foundation。

## 6. 建议下一步

优先级顺序：

1. 提交当前 PoC 基线。
2. 搭建真实 LiveKit + token service。
3. 做 4 路 USB 采集卡现场压力测试。
4. 决定 Native Media Worker 技术栈。
5. 把桌面 UI 与业务服务 PoC 打通为真实呼叫流程。
