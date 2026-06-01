# OpenCodex Voice Assistant User Guide (语音助手使用指南) 🚀🎙️

[English](#english) | [简体中文](#简体中文)

---

# English

This guide walks you through setting up and optimizing the **OpenCodex** decoupled voice command system.

## 1. Prerequisites & Architecture Overview

The voice system consists of two parts:
* **The Thick Server (OpenCodex)**: Handles Whisper Speech-to-Text (STT), voice synthesis (TTS via EdgeTTS / MiniMax / OpenAI), and model completions.
* **The Thin Client (OpenCodexBar)**: Spans a lightweight native menu bar app to capture microphone inputs, host a floating visualizer capsule, and play returned audio.

Ensure your Node.js backend is running (`npm start`) and the client companion is compiled (`swift build -c release`).

---

## 2. Dashboard Voice Setup (http://localhost:8765/dashboard)

Open your web dashboard and configure the **Voice Assistant Config** section:

### A. Speech-to-Text (STT) Settings
* **Engine**: Select `local-whisper` for offline private transcription (automatically managed and run via a Python child process on your mac), or `openai-compatible` for cloud transcribe services.
* **API Key & Base URL**: (Optional) Required only if using an OpenAI-compatible cloud transcription model.

### B. Text-to-Speech (TTS) Settings
* **Engine**:
  * `edge-tts`: Fully open-source, offline, high-quality voice synthesis. No key needed!
  * `minimax`: High-fidelity conversational synthesis. (Requires MiniMax API key & Base URL).
  * `openai-compatible`: Standard OpenAI TTS service.
* **Voice ID**: Select or input your preferred speaker ID (e.g. `zh-CN-XiaoxiaoNeural` or `zh-CN-YunxiNeural` for EdgeTTS, or custom presenter voice for MiniMax).

### C. Voice Activity Detection (VAD) Tuning
* **VAD Threshold (dB)**: The sensitivity floor (e.g. `-42.0 dB` default). Decreasing it (e.g., to `-48 dB`) makes the mic more sensitive; increasing it (e.g., to `-36 dB`) ignores louder background hums.
* **VAD Required Silence (s)**: How long the system waits after you stop talking before ending the recording automatically. Defaults to `1.5` seconds for natural conversational pace.

---

## 3. Keyboard Shortcuts & Triggers

* **⌥Space (Option-Space)**: Global wake hotkey.
  * *Press Once*: Raises the visualizer capsule and starts recording.
  * *Speak*: Waveform ripples instantly synced to your voice.
  * *Pause*: VAD detects silence, ends the recording automatically, and flips the HUD to "Thinking..."
  * *Press Again while Listening*: Cancels active recording/synthesized speech playback immediately.
* **⌥N (Option-N)**: One-click status bar hotkey to instantly clear conversation memory (`sessionId = nil`), playing a pleasant glass chime.
* **Verbal Resets**: You can also verbally say: `"开启新对话"`, `"清空会话"`, or `"清除记忆"`. The system will automatically reset, play a pleasant sound chime, and wipe conversational history.

---

## 4. Visualizer Lab (动效实验室)

Visit `http://localhost:8765/visualizer` or click **动效实验室** on the dashboard header:
1. Preview all four interactive, high-fidelity designs:
   * **Vortex**: Aurora spectrum and high-dimensional audio-reactive environment particle stream.
   * **Siri Fluid Wave**: Apple's premium fluid sinus wave lines.
   * **Capsule Local Glow**: Micro neon box-shadow border sweeps localized directly around the capsule.
   * **Cyberpunk Halo**: Rotating scanner ring ideal for small visual icons.
2. Click **Apply Theme (应用此主题)** on any design. The floating HUD capsule will immediately adopt that visual theme!

---

## 5. Screen & Web Task Automation (Computer Use)

Under our system prompt rules, **all browser and chrome MCP plugin extensions are globally disabled**.
Whenever you issue an operational command verbally (e.g. *"Open Google Chrome and search for local weather"*):
* The agent will bypass sandboxed browser scrapers and execute native macOS CGEvent mouse clicks and keyboard keystrokes directly on your actual screen.
* The synthesized voice will respond with a smart, substantive spoken summary paragraph of what was achieved on your desktop.

---
---

# 简体中文

本指南将协助您快速配置并玩转 **OpenCodex** 的全套轻量解耦语音控制系统。

## 1. 运行前准备与架构概述

语音系统由两部分协同工作：
* **重型服务端 (OpenCodex Node.js)**：负责处理本地 Whisper 语音识别（STT）、多引擎语音合成（TTS）、以及模型提示词路由。
* **轻量客户端 (OpenCodexBar Swift)**：原生系统状态栏伴侣应用，专门负责麦克风录音捕获、悬浮流光胶囊动效渲染（HUD）以及音频流的原生播放。

请确保服务端网关已正常启动（`npm start`），且伴侣客户端已成功编译（`swift build -c release`）并运行。

---

## 2. 语音配置面板介绍 (http://localhost:8765/dashboard)

打开控制台网页，滚动至 **语音助手设置 (Voice Assistant Config)** 面板：

### A. 语音转文字 (STT) 配置
* **选择引擎**：
  * `local-whisper`：完全本地离线部署（系统启动时会自动释放微型 Python 脚本并调用本地环境），不消耗网络且完全隐私。
  * `openai-compatible`：云端 OpenAI 兼容接口转写。
* **API Key & 自定义接口**：(可选) 仅当选用云端转写服务时填写。

### B. 文字转语音 (TTS) 接口
* **选择引擎**：
  * `edge-tts`：**强烈推荐！** 微软免费离线大模型发音，极其拟真自然，**无需配置任何 Key**，开箱即用。
  * `minimax`：高拟真对话语音合成。需填写 MiniMax 接口及 API 密钥。
  * `openai-compatible`：标准云端 OpenAI 语音合成。
* **发音人 Voice ID**：输入您喜欢的发音人名（如 EdgeTTS 下输入 `zh-CN-XiaoxiaoNeural` 或 `zh-CN-YunxiNeural` 即可完成男女声秒切）。

### C. 智能 VAD（静音停顿检测）参数调优
* **VAD 分贝阈值 (dB)**：判定为说话音量的分贝底线（默认 `-42.0 dB`）。
  * 调小该值（如 `-48 dB`）使麦克风更灵敏，适合轻声细语；
  * 调大该值（如 `-36 dB`）可以过滤掉背景大功率风扇或细微杂音。
* **VAD 静音等待时长 (s)**：您说话停顿多久后，系统判定为说完并自动切断录音。默认为极佳节奏的 `1.5` 秒。

---

## 3. 快捷键与会话交互操作

* **⌥Space (Option-Space)**：全局语音唤醒热键。
  * *按一次*：底部极光悬浮毛玻璃胶囊升起，麦克风启动，进入**倾听状态**（红色边框/呼吸波形）。
  * *正常说话*：胶囊内波形会跟随您的声音实时 60fps 跳跃律动。
  * *说话完毕*：VAD 停顿检测自动切断录音，状态切换为**思考中**（蓝色炫彩/快速律动）。
  * *播放回复时再按一次*：可直接打断 AI 的语音播放并收回面板，极为灵活。
* **⌥N (Option-N)**：一键清空会话记忆。随时清除 AI 会话上下文，重置后会播放一声清脆的玻璃风铃声，表示会话已开启新纪元。
* **语音指令重置**：您也可以在说话时直接发布口令：`"开启新对话"`、`"清空会话"` 或 `"清除记忆"`。系统同样会自动执行上下文抹除，并播放风铃声通知您。

---

## 4. 动效实验室 (Visualizer Lab)

在控制台导航栏点击 **动效实验室**（或访问 `http://localhost:8765/visualizer`）：
1. 界面提供了 4 种面向小尺寸 HUD 精心打磨的高拟真概念动效：
   * **极光频谱粒子流 (Vortex)**：华丽的极光光条伴随高维麦克风分贝联动粒子。
   * **Siri流体波形 (Siri Fluid Wave)**：苹果经典流畅的流体三色正弦声波。
   * **胶囊边缘舱体流光 (Capsule Local Glow)**：专为悬浮胶囊外边框量身定制的炫彩流光跑马灯。
   * **赛博旋转扫描线 (Cyberpunk Halo)**：微型圆环呼吸扫描线。
2. 点击卡片右下角的 **应用此主题 (Apply Theme)**。您的底层悬浮胶囊 HUD 就会瞬间换装，与新主题实时完美适配！

---

## 5. 纯物理桌面级屏幕与网页操作 (Computer Use)

为了提供纯正的实体屏幕操作，本语音助手已**全局禁用了高层级的沙箱网页浏览器 MCP 插件**。
当您口头下达需要操作电脑的指令（例如：*“帮我打开谷歌浏览器搜索一下今天的本地新闻”*）时：
* 助手将彻底使用 native macOS `computer_use` 工具，在您的实体屏幕上真实地操纵鼠标移动、定位点击、模拟键盘输入敲击。
* 并在完成后，语音播报一段高度凝练、具有实质性内容的结果总结（例如：“我已经为您打开 Chrome 并搜索，今日的新闻头条是……”），让您像操控机器人管家一般便捷地遥控整台 macOS 电脑！
