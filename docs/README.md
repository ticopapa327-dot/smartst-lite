# SmartST Lite 文档入口

本文档目录记录当前 USB-first 手术示教软件主线。根目录 `README.md` 已改为当前代码入口，不再保留旧版 ONVIF/RTSP 主流程说明。

## 阅读顺序

1. `development-readiness.md`
   当前基线、架构决策、模块划分和阶段计划。
2. `deployment-package-split.md`
   SmartST Server、SmartST OR Agent、SmartST Desktop Client 三包部署和服务化边界。
3. `livekit-desktop-surgery-teaching-architecture.md`
   产品功能架构、默认画面、权限、手机 H5、Android 平板、录像、HIS 和 AI 预留。
4. `livekit-native-media-worker-service-feasibility.md`
   LiveKit + Native Media Worker + 业务服务的可行性和职责边界。
5. `next-stage-real-livekit-native-usb.md`
   真实 LiveKit、Native Worker、USB 硬件验证阶段记录。
6. `real-connectivity-lab.md`
   本机一体机真实连通性部署、端口、防火墙、LiveKit/TURN 和排查说明。
7. `real-connectivity-acceptance-checklist.md`
   最小验收清单。
8. `test-plan.md`
   当前 PoC 到院内试点的测试分层、停止条件和执行计划。
9. `ui-visual-style.md`
   界面配色和 HMI 视觉约束。
10. `recording-manifest.md`
    录像文件 manifest 合同。

## 当前主线

```text
USB 采集优先
LiveKit/SFU 实时互动
Native Media Worker 本地采集和录像
业务服务统一权限、呼叫、token 和审计
手机 H5 仅单向收看
Android 会议平板作为正式客户端规划
冷灰蓝 HMI 医疗设备控制屏视觉
```

## 非主线

- ONVIF/RTSP 不再作为默认接入流程；旧 UI 和旧 Tauri 命令已从当前代码移除。
- 手机端不安装客户端，不做交互。
- 手机并发不由手术室终端承担。
- WebView2 `MediaRecorder` 不作为正式录像方案。
- 不使用大面积蓝色、紫蓝渐变、霓虹发光、玻璃拟态或 BI 驾驶舱式视觉。

## 固化验证入口

```powershell
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run test:all:poc
```
