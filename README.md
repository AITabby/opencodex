# OpenCodex

### 把 Codex Desktop 变成你的本地 AI 工作台

网关、语音、会话管理、第三方模型和 Agent 工具，都整合在一个 macOS 应用里。

作者：[@youngxxxxu](https://x.com/youngxxxxu)

<p align="center">
  <a href="https://github.com/AITabby/opencodex/releases/download/v1.0.3/OpenCodex-1.0.3-arm64.dmg">⬇️ 下载 OpenCodex v1.0.3</a>
  ·
  <a href="https://github.com/AITabby/opencodex/releases/tag/v1.0.3">查看 Release</a>
  ·
  <a href="https://x.com/youngxxxxu">🐦 @youngxxxxu</a>
</p>

<p align="center">
  <img src="./assets/dashboard-home.png" alt="OpenCodex macOS 控制中心" width="960">
</p>

<p align="center">
  <a href="./assets/demo.mp4">▶️ 查看应用演示视频</a>
</p>

> macOS Apple Silicon arm64 版本 · v1.0.3 · 未签名本地测试版

## OpenCodex 是什么？

OpenCodex 是一个运行在本机的 Codex Desktop 控制中心。

它不替换 Codex，也不把官方模型藏起来，而是在 Codex 旁边提供一层可管理的本地能力：

- 接入 API Key、OpenAI Compatible 接口和本机订阅
- 管理第三方模型，并让它们出现在 Codex Desktop 的模型菜单中
- 使用语音助手、会话管理和本地 Agent 工具
- 让 Computer Use、截图和模型路由在一个应用里协同工作

你只需要安装 Codex Desktop 和 OpenCodex App，打开应用后即可进入本地控制中心。

## 你可以用它做什么？

| 模块 | 用途 |
| --- | --- |
| 🌐 网关 | 管理服务商、API Key、模型和本机订阅，按需启用第三方模型 |
| 🎙️ 语音 | 配置语音识别、语音合成和全局语音栏 |
| 💬 会话 | 查看本地 Codex 会话，扫描和导入其他 Agent 的完整上下文 |
| 🖥️ Computer Use | 结合截图、鼠标、键盘和窗口控制完成桌面任务 |
| 🛡️ 原生保护 | 官方 Codex 模型、原生登录、MCP 和 Computer Use 路径保持独立 |

## 安装使用

### 普通用户

1. 确保已经安装 Codex Desktop。
2. 下载 [OpenCodex-1.0.3-arm64.dmg](https://github.com/AITabby/opencodex/releases/download/v1.0.3/OpenCodex-1.0.3-arm64.dmg)。
3. 将 OpenCodex 拖入 Applications 并打开。
4. 在应用内管理网关、语音和会话功能。

当前 DMG 未经过 Apple 签名。首次打开时，如果 macOS 阻止运行，请前往“系统设置 → 隐私与安全性”允许打开。

### 从源码运行

```bash
git clone https://github.com/AITabby/opencodex.git
cd opencodex
npm install
npm run build:all
npm start
```

启动后访问：

```text
http://localhost:8765/dashboard
```

## 工作方式

```text
Codex Desktop
      │
      ▼
OpenCodex App
  ├── 本地网关：第三方模型与服务商管理
  ├── 语音栏：STT / TTS / 全局语音交互
  ├── 会话中心：扫描、查看、导入 Agent 会话
  └── Computer Use：截图、窗口、鼠标和键盘工具
```

官方 Codex 模型始终保留在原生路径；只有用户明确添加的第三方模型才会进入 OpenCodex 网关。删除模型或还原原生模式后，不会影响 Codex 官方模型。

## 当前能力

- API Key 服务商预设与自定义 OpenAI Compatible 接口
- 本机订阅登录态检测、导入、刷新和实时模型验证
- 服务商模型命名空间，避免不同厂商出现同名模型冲突
- 模型添加、测试、删除和订阅状态实时同步
- 本地会话浏览、Agent 会话扫描与上下文导入
- macOS 原生 Computer Use 与 Vision Bridge
- 实时网关日志与一键重启/还原原生 Codex

## English

### A local AI workspace for Codex Desktop

OpenCodex brings the gateway, voice, session management, third-party models, and agent tools into one macOS application.

- Download the [OpenCodex v1.0.3 arm64 DMG](https://github.com/AITabby/opencodex/releases/download/v1.0.3/OpenCodex-1.0.3-arm64.dmg)
- Manage providers, API keys, subscriptions, and model routing locally
- Configure voice, browse sessions, and import external agent context
- Use Computer Use and vision capabilities from one control center
- Keep native Codex models and native routing protected

OpenCodex requires Codex Desktop on macOS. The current DMG is an unsigned local beta build for Apple Silicon Macs.
