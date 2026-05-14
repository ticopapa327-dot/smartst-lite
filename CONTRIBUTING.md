# Contributing to SmartST Lite

感谢你考虑参与 SmartST Lite。项目定位是免费、轻量、可信赖的 Windows 手术示教/转播客户端，第一阶段优先保证清晰架构和最小可运行体验。

## 开发原则

- 不伪造已实现能力。ONVIF、RTSP、LiveKit、FFmpeg 等未接通能力必须用 `TODO` 或 disabled 状态标记。
- 第一版最多支持 2 路摄像机，不引入复杂权限、排班、收费、HIS/PACS、病例归档。
- 保持医疗软件界面克制、清晰、低学习成本。
- 涉及真实音视频、网络摄像机、文件系统的改动要补充测试步骤。

## 本地开发

```powershell
npm install
npm run tauri:dev
```

前端调试也可以单独运行：

```powershell
npm run dev
```

## 提交流程

1. Fork 仓库或创建功能分支。
2. 保持提交范围小而清晰。
3. 运行 `npm run build`。
4. 如涉及 Tauri/Rust，运行 `npm run tauri:build` 或说明未运行原因。
5. 提交 PR 时说明改动范围、测试结果和仍然保留的 TODO。

## 适合贡献的方向

- ONVIF 自动发现和 GetStreamUri。
- FFmpeg RTSP 拉流、转码和本地预览。
- LiveKit 房间/token/音频通话。
- Windows 安装包图标、签名和升级流程。
- 医疗场景可用性优化和中文文案校准。
