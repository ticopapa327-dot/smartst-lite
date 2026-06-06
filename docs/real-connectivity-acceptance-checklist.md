# SmartST Lite 真实连通性最小验收表

> 日期：2026-06-06
> 范围：进入开发阶段前的最小可验收项，不替代正式医院现场验收。

## 验收结论口径

当前只能判定“一体机服务连通、真实 JWT、RoomService、手机只读权限和 synthetic 媒体转发 smoke 通过”。不能判定“真实 USB 采集卡到 LiveKit 发布、桌面端真实互动、Windows Service 生产安装和 30 分钟稳定性已完成”。

## 最小验收表

| 编号 | 验收项 | 命令或动作 | 当前结果 | 通过标准 |
| --- | --- | --- | --- | --- |
| A1 | LiveKit 开发二进制 | `npm run livekit:install-dev` | 已通过 | 来自官方 release，SHA-256 校验通过 |
| A2 | 一体机服务启动 | `npm run connectivity:or-lab:start` | 已通过 | LiveKit、business service、web-observer 均监听 LAN 地址 |
| A3 | 真实 JWT 和 room | `npm run connectivity:or-lab:verify` | 已通过 | OR、示教室仅收看、示教室交互、手机 observer token grants 正确 |
| A4 | 手机只读权限 | `connectivity:or-lab:verify` / `media-smoke` | 已通过 | 手机 observer `canPublish=false`、`canPublishData=false` |
| A5 | SFU 媒体转发 | `npm run connectivity:or-lab:media-smoke` | 已通过 | 1 个 OR publisher 发布 2 条轨道，示教室和多个手机 observer 均收到，非 OR 发布数为 0 |
| A6 | 配置分离 | `npm run service:config-preflight` | 已通过 | Server、OR Agent、Desktop Client 配置模板分离，API secret 只属于 Server |
| A7 | H5 入口 | 手机或浏览器访问 `http://<手术室IP>:5175` | 本机 HTTP 已通过；跨设备待测 | 页面默认连接 `http://<手术室IP>:4780`，不能出现发布入口 |
| A8 | 桌面端业务呼叫入会 | 工作台“呼叫并入会”或 `or-agent-publisher-smoke` | 基础自动化已通过；双终端人工待测 | 呼叫同意后入会，默认显示 `mediaPolicy.defaultChannelId` 对应画面 |
| A9 | OR Agent publisher adapter | `npm run connectivity:or-lab:or-agent-publisher-smoke` | smoke 已通过；生产 adapter 待实现 | OR Agent 发布真实 `video:field-camera` 和 `audio:or-room` |
| A10 | 双向音频 | 手术室端与示教室端 30 分钟交互 | 未完成 | 音频稳定，回声抑制策略明确，无明显回声或断续 |
| A11 | Windows Service | 安装后重启 Windows | 未完成 | SmartST Server 和 OR Agent 自动启动，Desktop Client 关闭不影响服务 |
| A12 | 防火墙放行 | 远端设备访问 4780/5175/7880/7881/7882 | 未完成 | 远端 TCP/UDP 可达；跨网段有 TURN/TLS 策略 |

## 停止条件

- 手机 observer 出现发布音频、视频或 data 的能力。
- LiveKit API secret 出现在 Desktop Client、OR Agent、H5、日志或导出配置中。
- 手机并发导致 OR Agent 为每个手机启动独立采集、推流或转码。
- 默认画面依赖设备枚举顺序或 LiveKit track 到达顺序，而不是业务服务 `mediaPolicy`。
- Windows Service 安装、卸载或防火墙规则脚本可能影响非 SmartST 文件、用户录像目录或其他系统服务。

## 下一步验收优先级

1. 将当前 PPM/WAV 文件桥接 publisher 替换为无文件落地的 native SDK / FFI / WHIP adapter。
2. 用两台真实终端验证示教室订阅、双向音频和手机跨设备只读收看。
3. 补齐 SmartST Server 预创建 LiveKit room 的生产逻辑，Desktop Client 不得持有 LiveKit secret。
4. 实现 Windows Service 安装和防火墙规则 preflight，再做重启后验收。
