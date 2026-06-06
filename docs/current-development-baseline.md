# 视捷UST当前开发基线

> 日期：2026-06-07  
> 范围：本对话开始后的手术示教软件开发、验证、命名和发布清理。

## 1. 产品与架构结论

产品中文名称统一为：视捷UST轻量化手术示教系统。

当前主线采用 Windows 桌面端 C/S 架构：

- UST Server：负责 LiveKit 服务编排、业务服务、呼叫、房间、JWT、人数策略、HIS 对接、文件上传和审计。
- UST OR Agent：负责手术室本地 USB 采集、Native Worker 生命周期、通道绑定、录像、PTZ 和设备恢复。
- UST Desktop Client：负责手术室端和示教室端 UI，不保存 LiveKit API secret。
- UST Web Observer：手机 H5 单向收看端，只订阅，不发布音视频或标注。
- Android 会议平板：可安装正式客户端，按示教室客户端策略接入。

USB UVC 摄像机和 HDMI/SDI USB 采集卡是默认视频输入。RTSP/SRT 只作为后续高级输入适配器预留，不作为当前默认入口。

## 2. 已完成的主要开发任务

- 完成 LiveKit + Native Media Worker + 业务服务的职责边界设计。
- 完成默认画面规则：由业务服务在接听/建房时生成 mediaPolicy，客户端不依赖 USB 设备顺序或 LiveKit track 顺序自行猜测。
- 完成手机端策略：手机不安装客户端，只作为 H5 单向收看端，并发压力由 LiveKit/SFU/媒体转发承担，不压到手术室桌面终端。
- 完成三包部署边界：UST Server、UST OR Agent、UST Desktop Client 可同机部署，也可分机部署，但配置、密钥、服务生命周期必须分离。
- 完成 Native Worker Windows 硬件验证主线：Media Foundation 视频枚举/采样，WASAPI 采集/播放格式探测，短时音频 buffer，payload queue，短时导出与 smoke。
- 完成 OR Agent publisher adapter 的 PoC 链路：Native Worker payload queue 到文件桥接，再由 LiveKit publisher smoke 验证房间发布路径。
- 完成 Desktop Client 工作台、USB 通道绑定、呼叫面板、LiveKit PoC 面板、配置和安装 smoke。
- 完成 NSIS 安装/卸载 smoke：安装文件、Worker、注册表、快捷方式、安装版内部 smoke 和静默卸载残留检查。
- 完成 `.cn` 下载站 UST 命名、下载入口、release 元数据和安装包发布。

## 3. 当前仍未完成的工程项

- OR Agent 还不是正式 Windows Service。
- UST Server 仍是内存业务服务原型，未接数据库、正式认证、审计和 HIS。
- Native Worker 到 LiveKit 的生产级无文件发布链路尚未完成。
- 本地录像、回放、导出、FTP 上传、患者绑定和 AI 任务接口仍未落地为生产模块。
- 双端真实人工呼叫、入会、默认画面渲染、双向音频和 AEC 仍需现场联调。
- 多 USB 采集卡长时间稳定性、4 路采集和多显示器扩展仍需硬件验收。

## 4. 当前验证入口

```powershell
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run test:all:poc
npm run service:config-preflight
npm run tauri:build
npm run tauri:install-smoke
npm run media-worker:native:release-smoke
```

本机 LiveKit 联调：

```powershell
npm run connectivity:or-lab:start
npm run connectivity:or-lab:verify
npm run connectivity:or-lab:media-smoke
npm run connectivity:or-lab:or-agent-publisher-smoke
npm run connectivity:or-lab:stop
```

## 5. 2026-06-07 清理固化结果

- 主仓库旧代号扫描已清零；当前源码、配置和文档入口不再使用旧代号作为产品名、包名、安装名或公开说明。工作区物理目录名仍沿用历史名称，不作为产品名或发布内容使用。
- 旧过程文档已移除：`docs/autonomous-development-plan.md`、`docs/autonomous-progress.md`、`docs/next-stage-real-livekit-native-usb.md`、`docs/poc-baseline-freeze.md`、`docs/website-product-introduction.md`。
- 旧生成物已通过 `cargo clean` 清除，并重新生成当前安装包：`src-tauri/target/release/bundle/nsis/UST Desktop Client_0.1.4_x64-setup.exe`。
- 当前安装包 SHA256：`4A6D588BA054B072075D50C4201C9CFAC2F73C8746BE685CB24B20A23338A0F4`，大小 `2.10 MB`。
- 下载站 `.cn` 已同步发布元数据和页面文案，旧研发代号字段和旧 SHA 已从源码和构建产物扫描中清除。
- RTSP/SRT/ONVIF 只保留在架构或类型边界中作为后续高级适配方向；当前 UI、Tauri 命令和工作台默认入口为 USB-first。

## 6. 清理原则

- 不再使用旧研发代号作为产品名、安装包名、注册表名、快捷方式名、日志目录名或公开说明。
- 不保留旧 ONVIF/RTSP/HLS 主流程代码和旧下载入口。
- 不删除仍被当前 smoke、构建或联调用到的 PoC 代码；PoC 代码必须以 UST 命名并明确边界。
- 历史过程日志不作为主开发入口；当前开发以本文件和测试计划为准。
