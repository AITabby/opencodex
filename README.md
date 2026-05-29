# OpenCodex 🚀

[English](#english) | [简体中文](#简体中文)

---

# English

**OpenCodex** is a plug-and-play local gateway that unlocks Codex Desktop for third-party APIs, featuring a premium web dashboard and macOS-native Computer Use with visual fallback.

## 🌟 Key Features

*   **Zero-Configuration Auto-Setup**: Start the server and it automatically patches `~/.codex/config.toml` with backups, no CLI interaction needed.
*   **Premium Glassmorphic Web Dashboard (`http://localhost:8765/dashboard`)**:
    *   **Interactive Bilingual Switcher**: A dynamic button (`🌐 EN / 中`) translates all labels and notifications instantly.
    *   **Keys & Endpoints Manager**: Graphically update API configurations.
    *   **Model Dropdown Customizer**: Manually input model names and toggle which appear in Codex.
    *   **Live SSE Terminal Logger**: Streams proxy logs in real-time as Codex operates.
    *   **One-Click Restart**: Restart Codex Desktop directly from the dashboard.
*   **Native macOS Computer Use & Universal Vision Bridge**:
    *   **Mac-Native `sips` Compression**: Automatically downscales screenshots to `1200px` max dimension.
    *   **Multimodal Fallback**: Intercepts screenshots and generates high-fidelity textual descriptions via OpenCode's `mimo-v2.5`, enabling Computer Use for text-only models.

---

## 🚀 Getting Started

### 📋 Prerequisites
*   macOS
*   Node.js (v18+) & npm installed.
*   Codex Desktop installed.

### ⚙️ Quick Installation

```bash
cd /Users/aitabby/projects/opencodex
npm install
npm start
```

The server starts, automatically patches your Codex config, and opens the dashboard in your browser. Configure your API key and models from there.

---

# 简体中文

**OpenCodex** 是一款即插即用的本地网关，帮你解锁 Codex Desktop 的第三方 API 接入，配有高颜值 Web 控制台和 macOS 原生 Computer Use 视觉降级能力。

## 🌟 核心特性

*   **零配置自动启动**：启动服务后自动修补 `~/.codex/config.toml`，无需任何命令行交互。
*   **高颜值玻璃拟态 Web 控制台 (`http://localhost:8765/dashboard`)**：
    *   **动态零刷新翻译**：右上角 `🌐 EN / 中` 按钮一键秒切中英文。
    *   **API 配置图形化管理**：轻松填写密钥和接口地址。
    *   **自定义模型输入**：手动输入模型名，勾选决定哪些显示在 Codex 下拉框。
    *   **实时流式日志（SSE）**：彩色 Tag 实时推送代理请求日志。
    *   **一键重启 Codex**：控制台直接重启 Codex Desktop。
*   **原生 macOS Computer Use 与智能视觉降级拦截**：
    *   **原生 `sips` 压缩**：自动截屏并缩放到 `1200px`，节省带宽。
    *   **万能多模态 Fallback**：为非多模态模型拦截截图，生成高保真文字描述，流畅运行 Computer Use。

---

## 🚀 快速上手

### 📋 准备工作
*   macOS 系统
*   已安装 Node.js (v18+) 和 npm。
*   已安装并至少运行过一次 Codex Desktop。

### ⚙️ 安装与启动

```bash
cd /Users/aitabby/projects/opencodex
npm install
npm start
```

启动后自动打开浏览器控制台，在页面中填写 API Key 和模型名即可使用。
