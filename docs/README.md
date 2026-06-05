# SmartST Lite 文档入口

本文档目录记录新一阶段手术示教软件开发依据。根目录 `README.md` 目前仍保留 0.1.4 ONVIF/RTSP MVP 的历史说明，不能单独作为新架构开发依据。

## 阅读顺序

1. `development-readiness.md`  
   开发启动入口，说明当前基线、文档关系、模块划分、Sprint 0 到 Sprint 5。

2. `autonomous-development-plan.md`  
   无人值守开发执行计划，定义 AD-00 到 AD-09 批次、验证命令、停止条件和进度记录方式。

3. `livekit-desktop-surgery-teaching-architecture.md`  
   产品功能架构，包含手术室端、示教室端、Android 会议平板、手机 H5、默认画面、权限、录像、HIS、AI 预留。

4. `livekit-native-media-worker-service-feasibility.md`  
   技术可行性，重点是 LiveKit + Native Media Worker + 业务服务的职责边界、PoC 和 Go / No-Go。

5. `ui-visual-style.md`  
   UI 配色和视觉 token。界面必须参考 `shoushi-or-platform` 的 `or-preview HMI palette v0.3`。

6. `livekit-desktop-surgery-teaching-development-plan.md`  
   阶段计划、验收标准、测试矩阵。

7. `usb-first-rearchitecture.md`  
   USB-first 重构背景和旧 ONVIF/RTSP 主线降级依据。

8. `recording-manifest.md`  
   录像文件 manifest v0.1 合同，说明患者绑定、通道文件、导出、FTP 状态和 AI 预留接口。

9. `test-plan.md`  
   当前 PoC 到院内试点的测试分层、停止条件和执行计划。

10. `poc-baseline-freeze.md`  
    AD-00 到 AD-09 暂停无人值守开发后的成果固化记录。

11. `next-stage-real-livekit-native-usb.md`  
    真实 LiveKit JWT、Native Worker 就绪检查和 4 路 USB 硬件验证阶段记录。

## 当前开发主线

```text
USB 采集优先
LiveKit/SFU 实时互动
Native Media Worker 本地采集和录像
业务服务统一权限和呼叫
Android 会议平板作为正式客户端
手机 H5 仅单向收看
冷灰蓝 HMI 医疗设备控制屏视觉
无人值守批次化开发
```

当前 AD-00 到 AD-09 PoC 状态见 `autonomous-progress.md`。

当前固化基线验证入口：

```powershell
npm run test:all:poc
```

## 非主线

- ONVIF/RTSP 不再作为默认接入流程。
- 手机端不安装客户端，不做交互。
- 手机并发不由手术室终端承担。
- WebView2 `MediaRecorder` 不作为正式录像方案。
- 不使用大面积蓝色、紫蓝渐变、霓虹发光、玻璃拟态、BI 驾驶舱式视觉。
