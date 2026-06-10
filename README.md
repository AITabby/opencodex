# OpenCodex 🚀

[English](#english) | [简体中文](#简体中文)

<p align="center">
  <img src="preview_gateway.png" alt="OpenCodex Dashboard" width="800">
</p>

<p align="center">
  <a href="https://youtu.be/GvmXBZvvhuo">▶️ Watch Demo Video on YouTube</a>
</p>

---

# English

> [!IMPORTANT]
> **🌟 Premium Voice Companion App:** To experience the absolute state of the art in desktop voice assistants, combine this server with the native companion client [OpenCodexBar](https://github.com/AITabby/opencodex-bar)! Run the server, compile the bar, and instantly enjoy system-wide voice hotkeys (`Option + Space`), real-time decibel Audio-Reactive VAD, and a gorgeous cinematic single-line scrolling frosted-glass visualizer capsule floating right above your Dock!

**OpenCodex** is a plug-and-play local gateway that unlocks Codex Desktop for third-party APIs, featuring a premium web dashboard, custom Computer Use engine, and Vision Bridge for text-only models.

## 🌟 Key Features

* **Zero-Config Setup**: Start the server, it auto-patches `~/.codex/config.toml` with backups. No CLI, no manual editing.
* **Premium Web Dashboard** (`http://localhost:8765/dashboard`):
  * 🌐 Bilingual (EN/中文) with instant switch
  * 🔑 API key & endpoint management
  * 📝 Add/delete custom models, toggle visibility in Codex
  * 📡 Live SSE log streaming
  * 🚀 One-click Codex restart
  * ↺ One-click reset to native Codex
  * 🎙️ **Voice Integration Control**: Manage settings for Groq STT (Whisper) & Doubao TTS (Volcengine V3 API) directly from the dashboard
* **Custom Computer Use & Adaptive Router**:
  * 🖱️ Native macOS mouse/keyboard/window control via CGEvent
  * 📸 Screenshot capture with `sips` compression (1200px) & description caching
  * 🔄 **CLI & Desktop Adaptive Routing**: Automatically detects CLI requests, skips failing browser extension loops, and routes straight to Computer Use for 60%+ faster browser control in Terminal sessions
* **Vision Bridge**:
  * 👁️ For text-only models (DeepSeek, etc.)
  * Automatically compresses screenshots, describes via multimodal model, injects description into prompt
  * Supports any OpenAI-compatible vision model (configurable endpoint, model, API key)

## 🚀 Quick Start

### Prerequisites
- macOS
- Node.js v18+
- Codex Desktop installed

### Install & Run

```bash
git clone https://github.com/AITabby/opencodex.git
cd opencodex
npm install
npm start
```

Server starts, browser opens to the dashboard. Add your API key and model names, click save — done.

---

# 简体中文

> [!IMPORTANT]
> **🌟 极光语音伴侣应用：** 强烈建议配合原生伴侣客户端 [OpenCodexBar](https://github.com/AITabby/opencodex-bar) 使用！为您的 Mac 开启系统级全局语音唤醒热键（`Option + Space`）、分贝波形联动与智能静音检测（VAD），以及悬浮于 macOS Dock 栏上方的极光毛玻璃跑马灯胶囊！

**OpenCodex** 是一款即插即用的本地网关，为 Codex Desktop 解锁第三方 API。配备高颜值 Web 控制台、自研 Computer Use 引擎，以及让纯文本模型也能看图操作的 Vision Bridge。

## 🌟 核心特性

* **零配置启动**：启动后自动修补 `~/.codex/config.toml`，无需任何操作。
* **高颜值 Web 控制台**（`http://localhost:8765/dashboard`）：
  * 🌐 中英文一键切换
  * 🔑 图形化管理 API Key 和接口地址
  * 📝 自由增删模型，勾选控制哪些显示在 Codex
  * 📡 实时 SSE 日志流
  * 🚀 一键重启 Codex
  * ↺ 一键还原原生 Codex
  * 🎙️ **语音设置集成管理**：在控制面板中直接配置 Groq 语音识别 (STT) 与 火山引擎/豆包 语音合成 (TTS V3 API) 的接口与模型
* **自研 Computer Use & 自适应路由**：
  * 🖱️ macOS 原生鼠标/键盘/窗口控制（CGEvent）
  * 📸 截图自动 `sips` 压缩至 1200px 与缓存描述加速
  * 🔄 **CLI 与桌面端自适应路由**：网关自动检测请求来源，在终端 CLI 测试中自动屏蔽无法连通的 Chrome 插件环境并直接降级为 Computer Use，省去大模型 10+ 轮盲目重试，浏览器控制加速 60% 以上
* **Vision Bridge 视觉降级**：
  * 👁️ 纯文本模型（DeepSeek 等）也能跑 Computer Use
  * 自动压缩截图 → 多模态模型描述 → 注入文字到 Prompt
  * 支持任意 OpenAI 兼容的多模态模型（可配接口、模型名、Key）

## 🚀 快速上手

### 准备工作
- macOS 系统
- Node.js v18+
- 已安装 Codex Desktop

### 安装与启动

```bash
git clone https://github.com/AITabby/opencodex.git
cd opencodex
npm install
npm start
```

启动后浏览器自动打开控制台，填写 API Key 和模型名，保存即可使用。
