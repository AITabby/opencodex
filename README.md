# OpenCodex

### 把 Codex Desktop 变成你的本地 AI 工作台

网关、语音、会话管理、第三方模型和 Agent 工具，都整合在一个 macOS / Windows 桌面应用里。

<p align="center">
  <a href="https://github.com/AITabby/opencodex/releases"><img src="https://img.shields.io/github/v/release/AITabby/opencodex?display_name=tag&style=flat-square&label=release" alt="Latest Release"></a>
  <a href="https://github.com/AITabby/opencodex"><img src="https://img.shields.io/github/stars/AITabby/opencodex?style=flat-square" alt="GitHub Stars"></a>
  <a href="https://github.com/AITabby/opencodex/releases/download/v1.0.8/OpenCodex-1.0.8-arm64.dmg"><img src="https://img.shields.io/badge/macOS-Apple%20Silicon-111111?style=flat-square&logo=apple" alt="macOS Apple Silicon"></a>
  <a href="https://github.com/AITabby/opencodex/releases/download/v1.0.3/OpenCodex-1.0.3-win-x64.exe"><img src="https://img.shields.io/badge/Windows-10%2F11-0078D6?style=flat-square&logo=windows" alt="Windows 10/11"></a>
  <a href="https://x.com/youngxxxxu"><img src="https://img.shields.io/badge/X-@youngxxxxu-000000?style=flat-square&logo=x" alt="X @youngxxxxu"></a>
</p>

<p align="center">
  <a href="#简体中文">简体中文</a> · <a href="#english">English</a>
</p>

<p align="center">
  <a href="https://github.com/AITabby/opencodex/releases/download/v1.0.8/OpenCodex-1.0.8-arm64.dmg">⬇️ 下载 OpenCodex v1.0.8（macOS）</a>
  ·
  <a href="https://github.com/AITabby/opencodex/releases/download/v1.0.3/OpenCodex-1.0.3-win-x64.exe">🪟 下载 Windows v1.0.3</a>
  ·
  <a href="https://github.com/AITabby/opencodex/releases/tag/v1.0.8">查看 Release</a>
  ·
  <a href="https://x.com/youngxxxxu">🐦 @youngxxxxu</a>
</p>

<p align="center">
  <img src="./assets/dashboard-home.png" alt="OpenCodex macOS 控制中心" width="960">
</p>

<p align="center">
  <a href="./assets/demo.mp4">▶️ 查看应用演示视频</a>
</p>

> macOS Apple Silicon arm64 v1.0.8 · Windows 10/11 v1.0.3 · 当前 macOS DMG 未经过 Apple 签名

> ✅ 当前 Release 的 DMG 已内置独立 Node.js 运行时。下载安装后即可运行网关，不需要额外安装 Node.js、npm 或 Homebrew。

## 简体中文

### OpenCodex 是什么？

OpenCodex 是一个运行在本机的 Codex Desktop 控制中心，提供 macOS 和 Windows 桌面版本。

它不替换 Codex，也不把官方模型藏起来，而是在 Codex 旁边提供一层可管理的本地能力：

- 接入 API Key、OpenAI Compatible 接口和本机订阅
- 管理第三方模型，并让它们出现在 Codex Desktop 的模型菜单中
- 使用语音助手、会话管理和本地 Agent 工具
- GPT-Live 实时沟通后，可将任务交给任意已接入的可用第三方模型执行
- 通过 GPT-Live 悬浮球随时切换执行模型，根据模型能力自由安排任务
- 让模型路由、语音和本地 Agent 能力在一个应用里协同工作

### 核心能力

| 模块 | 用途 |
| --- | --- |
| 🌐 网关 | 管理服务商、API Key、模型和本机订阅，按需启用第三方模型 |
| 🎙️ 语音 | 配置语音识别、语音合成和全局语音栏 |
| 🤖 GPT-Live | 实时沟通后选择任意已接入的第三方模型执行任务，并支持随时切换 |
| 💬 会话 | 查看本地 Codex 会话，扫描和导入其他 Agent 的完整上下文 |
| 🛡️ 原生保护 | 官方 Codex 模型和原生登录路径保持独立 |

### 为什么需要 OpenCodex？

Codex Desktop 原生体验很顺手，但第三方模型、订阅、语音和本机会话通常分散在不同工具里。OpenCodex 把这些能力集中到一个本地控制中心，同时保留 Codex 自身的原生能力。

官方 Codex 模型始终保留在原生路径；只有用户明确添加的第三方模型才会进入 OpenCodex 网关。不同服务商的模型使用独立命名空间，避免同名模型互相覆盖。

### 工作方式

```text
Codex Desktop
      │
      ▼
OpenCodex App
  ├── 本地网关：第三方模型与服务商管理
  ├── 语音栏：STT / TTS / 全局语音交互
  ├── GPT-Live：实时沟通与执行模型选择
  └── 会话中心：扫描、查看、导入 Agent 会话
```

### 当前功能

- API Key 服务商预设与自定义 OpenAI Compatible 接口
- 本机订阅登录态检测、导入、刷新和实时模型验证
- 服务商模型命名空间，避免不同厂商出现同名模型冲突
- 模型添加、测试、删除和订阅状态实时同步
- GPT-Live 实时语音沟通后，将任务交给任意已接入的可用第三方模型执行
- GPT-Live 悬浮球支持随时切换执行模型，按模型特点灵活安排任务
- 本地会话浏览、Agent 会话扫描与上下文导入
- 实时网关日志与一键重启/还原原生 Codex

### 安装使用

#### 普通用户

1. 确保已经安装 Codex Desktop。
2. 下载 [OpenCodex-1.0.8-arm64.dmg](https://github.com/AITabby/opencodex/releases/download/v1.0.8/OpenCodex-1.0.8-arm64.dmg)。
3. 将 OpenCodex 拖入 `Applications` 并打开。
4. 在应用内管理网关、语音和会话功能。

DMG 版本已经包含网关所需的独立运行时，普通用户无需在终端执行启动命令，也无需自行配置 Node.js 环境。使用前只需要安装 Codex Desktop，并在应用内完成需要的服务商或本机订阅配置。

当前 DMG 未经过 Apple 签名。首次打开时，如果 macOS 阻止运行，请前往“系统设置 → 隐私与安全性”允许打开。

#### Windows 10/11

1. 确保已经安装 Codex Desktop。
2. 下载 [OpenCodex-1.0.3-win-x64.exe](https://github.com/AITabby/opencodex/releases/download/v1.0.3/OpenCodex-1.0.3-win-x64.exe)。
3. 运行安装程序并打开 OpenCodex。

Windows 安装包已经包含本地网关和桌面应用窗口。Windows 用户不需要额外安装 Node.js 或 .NET SDK，也不需要通过终端启动网关。

> 注意：Windows 当前只发布桌面应用安装包，不提供单独的命令行版本。

#### 从源码运行

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

### 项目状态

当前 macOS 发布版本为 `v1.0.8`，Windows 发布版本为 `v1.0.3`。项目仍在持续迭代中，建议通过 [GitHub Releases](https://github.com/AITabby/opencodex/releases) 获取最新版本。

---

## English

### A local AI workspace for Codex Desktop

OpenCodex brings the gateway, voice, session management, third-party models, and agent tools into one desktop application for macOS and Windows.

It works alongside Codex Desktop instead of replacing it. Native Codex models and native routing remain separate, while explicitly added third-party models can be managed through the local OpenCodex gateway.

### What it includes

| Module | What it does |
| --- | --- |
| 🌐 Gateway | Manage providers, API keys, subscriptions, and third-party models |
| 🎙️ Voice | Configure speech recognition, speech synthesis, and the global voice bar |
| 🤖 GPT-Live | Choose any available connected third-party model to execute tasks after a live conversation, and switch models at any time |
| 💬 Sessions | Browse local Codex sessions and import external agent context |
| 🛡️ Native protection | Keep native Codex models and native login isolated |

### Why OpenCodex?

Codex Desktop provides a great native experience, but third-party models, subscriptions, voice, and local agent sessions are often scattered across separate tools. OpenCodex brings them together in one local control center while keeping Codex itself intact.

Official Codex models stay on their native route. Only models explicitly added by the user are sent through the OpenCodex gateway. Provider namespaces prevent models with the same name from overwriting each other.

### Key features

- Built-in provider presets and custom OpenAI-compatible endpoints
- Local subscription detection, import, refresh, and live model validation
- Provider-scoped model names to avoid cross-provider naming conflicts
- Real-time synchronization for adding, testing, deleting, and importing models
- GPT-Live can hand tasks from a live conversation to any available connected third-party model
- The GPT-Live floating orb lets you switch the execution model at any time based on each model's strengths
- Local session browser and external agent conversation import
- Live gateway logs and one-click restart or native reset

### Installation

1. Install Codex Desktop on macOS.
2. Download the [OpenCodex v1.0.8 Apple Silicon DMG](https://github.com/AITabby/opencodex/releases/download/v1.0.8/OpenCodex-1.0.8-arm64.dmg).
3. Drag OpenCodex into `Applications` and launch it.
4. Manage providers, voice, sessions, and third-party models from the app.

The DMG includes the standalone runtime required by the gateway. End users do not need to install Node.js, npm, or Homebrew, and do not need to start the gateway from a terminal. Install Codex Desktop first, then configure providers or local subscriptions inside OpenCodex.

The current DMG is unsigned. If macOS blocks the first launch, allow it from **System Settings → Privacy & Security**.

#### Windows 10/11

1. Install Codex Desktop.
2. Download the [OpenCodex v1.0.3 Windows installer](https://github.com/AITabby/opencodex/releases/download/v1.0.3/OpenCodex-1.0.3-win-x64.exe).
3. Run the installer and launch OpenCodex.

The Windows installer includes the local gateway and native app window. Windows users do not need Node.js or the .NET SDK, and do not need to start the gateway from a terminal.

> Note: Windows is currently distributed only as a desktop application installer. A standalone command-line version is not provided.

### Run from source

```bash
git clone https://github.com/AITabby/opencodex.git
cd opencodex
npm install
npm run build:all
npm start
```

Then open:

```text
http://localhost:8765/dashboard
```

### Project status

The current macOS release is `v1.0.8`, while Windows remains at `v1.0.3`. OpenCodex is actively evolving; see [GitHub Releases](https://github.com/AITabby/opencodex/releases) for the latest build.

### Links

- [GitHub Repository](https://github.com/AITabby/opencodex)
- [Latest Release](https://github.com/AITabby/opencodex/releases/latest)
- [Download OpenCodex v1.0.8 for macOS](https://github.com/AITabby/opencodex/releases/download/v1.0.8/OpenCodex-1.0.8-arm64.dmg)
- [Download OpenCodex v1.0.3 for Windows](https://github.com/AITabby/opencodex/releases/download/v1.0.3/OpenCodex-1.0.3-win-x64.exe)
- [X / Twitter: @youngxxxxu](https://x.com/youngxxxxu)
