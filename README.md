# SmartST Lite

SmartST Lite 是一个面向医美医院、动物医院、民营医疗机构的轻量级 Windows 手术示教/手术转播客户端。项目目标是免费、易部署、最多接入 2 路 ONVIF 网络摄像机，并逐步接入 RTSP、FFmpeg、LiveKit/WebRTC。

当前仓库是第一阶段 MVP：桌面客户端外壳、发起端/接收端主要界面、本地配置持久化、基础日志系统已经实现；真实 ONVIF 自动发现、RTSP 播放/转码、LiveKit 通话仍是 TODO，不会伪造成功状态。

## 技术架构

- 桌面外壳：Tauri 2 + Rust
- 前端：React + TypeScript + Vite
- 本地能力：Tauri command 提供配置读写、日志追加
- 摄像机服务：预留 ONVIF 自动发现、GetStreamUri、RTSP 地址管理
- 实时通话服务：预留 LiveKit/WebRTC 房间、呼叫、加入、挂断状态
- 转码推流：预留 FFmpeg 拉取 RTSP、转码、推送到远端

## MVP 功能

- 启动页选择“示教发起端”或“示教接收端”
- 发起端摄像机列表，最多 2 路摄像机
- 添加/编辑摄像机弹窗，录入 IP、ONVIF 端口、用户名、密码、RTSP 地址
- RTSP 地址显示和主/辅画面占位预览
- 创建房间、呼叫接收端的本地状态流
- 接收端录入服务器地址/房间号，等待呼叫、主动加入、挂断
- 设置页保存服务器地址、机构名称、设备名称、日志目录
- 配置持久化到 `%APPDATA%\\SmartST Lite\\config.json`
- 日志追加到 `%APPDATA%\\SmartST Lite\\logs\\smartst-lite.log`

## 未实现但已预留

- TODO: 局域网 ONVIF 自动发现
- TODO: ONVIF 认证和 `GetStreamUri`
- TODO: FFmpeg RTSP 拉流、本地实时预览、转码推流
- TODO: LiveKit/WebRTC 房间创建、token 签发、接收端信令通知
- TODO: 麦克风采集、双端语音通话
- TODO: Windows 目录选择器、摄像机密码加密保存

## 目录结构

```text
.
├── src
│   ├── components        # 页面和 UI 组件
│   ├── domain            # TypeScript 领域类型
│   ├── services          # 配置、日志、摄像机、实时通话服务
│   ├── App.tsx
│   ├── main.tsx
│   └── styles.css
├── src-tauri
│   ├── src/main.rs       # Tauri 本地命令
│   ├── Cargo.toml
│   └── tauri.conf.json
├── .github/workflows     # GitHub Actions
├── CONTRIBUTING.md
├── LICENSE
├── package.json
└── README.md
```

## 本地开发

环境要求：

- Windows 10 / Windows 11
- Node.js 20+
- Rust stable
- Tauri 2 所需 Windows 构建工具

安装依赖：

```powershell
npm install
```

启动桌面开发版：

```powershell
npm run tauri:dev
```

只启动前端调试：

```powershell
npm run dev
```

## 本地测试步骤

1. 打开应用，确认首页展示“免费手术示教”“2 路摄像机”“快速转播”“Windows 可用”。
2. 进入“示教发起端”，添加 1 到 2 路摄像机。
3. 留空 RTSP 地址时，确认系统生成候选 RTSP 地址。
4. 设置其中一路为主画面，确认主/辅画面标签变化。
5. 点击“创建房间”，确认生成 `ST-XXXXXX` 房间号。
6. 点击“呼叫接收端”，确认进入本地呼叫状态且提示 LiveKit/信令 TODO。
7. 进入“示教接收端”，录入地址和房间号，点击“主动加入”，确认最近连接被保存。
8. 进入“设置”，修改机构名称、设备名称、日志目录，重启后确认配置仍存在。
9. 检查 `%APPDATA%\\SmartST Lite\\logs\\smartst-lite.log` 是否写入操作日志。

## Windows 打包

构建前端：

```powershell
npm run build
```

构建 Windows 安装包：

```powershell
npm run tauri:build
```

如果本机首次下载 NSIS/MSI 打包工具超时，可以先只构建可执行文件：

```powershell
npm run tauri:build:exe
```

产物通常位于：

```text
src-tauri/target/release/bundle/
```

`--no-bundle` 模式下的 exe 位于：

```text
src-tauri/target/release/smartst-lite.exe
```

正式发布前建议补充：

- 应用图标
- Windows 代码签名证书
- 安装包升级策略
- FFmpeg 二进制授权和分发说明
- LiveKit 服务端部署说明

## 开源发布到 GitHub

本项目采用 MIT License，适合公开发布。推荐首次发布流程：

```powershell
git init
git add .
git commit -m "Initial SmartST Lite MVP"
git branch -M main
git remote add origin https://github.com/<your-org>/smartst-lite.git
git push -u origin main
```

发布前请确认：

- 不提交真实摄像机密码、医院内部地址、私有 LiveKit token。
- README 明确当前能力边界和 TODO。
- 如后续捆绑 FFmpeg，需要核对 FFmpeg 编译选项和许可证兼容性。

## 后续路线图

### 0.2 摄像机接入

- ONVIF WS-Discovery 自动发现
- ONVIF 认证和 GetStreamUri
- 摄像机连通性检测
- 摄像机密码加密保存

### 0.3 本地视频预览

- FFmpeg 拉取 RTSP
- 本地低延迟预览
- 断线重连和错误提示
- 主/辅画面切换优化

### 0.4 远程示教

- LiveKit 房间创建和 token 签发
- 发起端推流到房间
- 接收端加入房间播放 1 到 2 路视频
- 麦克风语音讲解和双端通话

### 0.5 Windows 发布

- 安装包图标和签名
- 日志导出
- 简单诊断页
- 更新检查

### 高级版预留

- 多房间调度
- 用户和角色权限
- 病例归档
- HIS/PACS 对接
- 集中设备运维

## License

MIT
