# SmartST Lite 测试方案与计划

> 适用仓库：`D:\我的工作\AOV\SmartST Lite`  
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
| WASAPI render 枚举、格式探测和静音写入 | `media-worker:native:list-devices` 返回 `audioRender` 数组和 `diagnostics.wasapiRender.status`；`media-worker:native:audio-render-probe` 返回 render mix format；`media-worker:native:audio-render-silence` 返回 `renderClientStatus=opened-stopped`、`audibleOutput=silence`、`loopbackCaptured=false` 和 `aecStatus=not-run`；该项不等同有声回放、loopback 或 AEC 通过 |
| 1 路 USB 采集卡 | 可预览、可短时录像、manifest 正确 |
| 4 路 USB 采集卡 | 30 分钟不黑屏、不崩溃 |
| 腹腔镜/内镜 HDMI 输入 | 分辨率、帧率、色彩和延迟可接受 |
| 热插拔 | 单路故障不影响其他路 |
| 设备占用 | 错误提示可读，可重试 |
| USB Hub 满载 | 不出现周期性掉线或通道错乱 |
| PTZ 摄像机 | 支持项可控，不支持项不显示误导按钮 |

### L3 LiveKit 与业务服务

目标：验证真实 server、真实 JWT、真实房间互动。

前置条件：

- LiveKit server 可访问。
- 业务服务能签发短期 JWT。
- 客户端没有 LiveKit API secret。
- TURN/TLS 策略明确。

必测场景：

| 场景 | 通过标准 |
| --- | --- |
| 端点注册 | 手术室、示教室、平板均在线 |
| 示教室呼叫手术室 | 待接、接受、拒绝、挂断状态正确 |
| 手术室呼叫示教室 | 反向呼叫成立 |
| 仅收看模式 | 远端不能发布音视频 |
| 交互模式 | 双向语音稳定 |
| 默认画面 | 业务服务返回 `mediaPolicy`，默认画面选择原因可审计；token metadata 和真实 JWT metadata 与 `mediaPolicy` 一致；无可用视频时进入 audio-only |
| 请求其他通道 | 按需订阅，不默认全量推送 |
| 手机 H5 并发 | 手机端只订阅，手术室端只发布一次默认画面 |
| 人数超限 | 新用户收到明确提示 |

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

- 当前 LiveKit 只完成 UI PoC，未完成真实 JWT 和真实 server 端到端。
- 当前设备验证是 ffmpeg DirectShow 预检，不是最终 Media Foundation/WASAPI。
- 当前录像是短时 DirectShow 文件写入，不是正式 Native Media Worker 医疗录像。
- 当前业务服务是内存 PoC，没有数据库、认证和审计持久化。
