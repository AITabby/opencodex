# OpenCodex

### 把 Codex Desktop 变成你的本地 AI 工作台

OpenCodex 是运行在本机的 Codex Desktop 控制中心：把第三方模型、模型目录、语音助手、GPT-Live、会话管理和 Agent 工具集中到一个桌面应用中，同时保留 Codex 原生模型、原生登录、Computer Use 与 MCP 的独立运行方式。

<p align="center">
  <a href="https://github.com/AITabby/opencodex/releases"><img src="https://img.shields.io/github/v/release/AITabby/opencodex?display_name=tag&style=flat-square&label=release" alt="Latest Release"></a>
  <a href="https://github.com/AITabby/opencodex"><img src="https://img.shields.io/github/stars/AITabby/opencodex?style=flat-square" alt="GitHub Stars"></a>
  <a href="https://github.com/AITabby/opencodex/releases/download/v1.1.2/OpenCodex-1.1.2-arm64.dmg"><img src="https://img.shields.io/badge/macOS-v1.1.2-111111?style=flat-square&logo=apple" alt="macOS v1.1.2"></a>
  <a href="https://github.com/AITabby/opencodex/releases/download/v1.0.8/OpenCodex-1.0.8-win-x64.exe"><img src="https://img.shields.io/badge/Windows-v1.0.8-0078D6?style=flat-square&logo=windows" alt="Windows v1.0.8"></a>
  <a href="https://x.com/youngxxxxu"><img src="https://img.shields.io/badge/X-@youngxxxxu-000000?style=flat-square&logo=x" alt="X @youngxxxxu"></a>
</p>

<p align="center">
  <a href="#简体中文">简体中文</a> · <a href="#english">English</a>
</p>

<p align="center">
  <a href="https://github.com/AITabby/opencodex/releases/download/v1.1.2/OpenCodex-1.1.2-arm64.dmg">⬇️ 下载 OpenCodex v1.1.2（macOS）</a>
  ·
  <a href="https://github.com/AITabby/opencodex/releases/download/v1.0.8/OpenCodex-1.0.8-win-x64.exe">🪟 下载 Windows v1.0.8</a>
  ·
  <a href="https://github.com/AITabby/opencodex/releases/tag/v1.1.2">查看 Release</a>
  ·
  <a href="https://x.com/youngxxxxu">🐦 @youngxxxxu</a>
</p>

<p align="center">
  <img src="./assets/dashboard-home.png" alt="OpenCodex 控制中心" width="960">
</p>

## 产品截图

### 第三方模型配置与协议选择

<p align="center">
  <img src="./assets/screenshots/01-provider-model-config.png" alt="配置第三方模型并选择 Chat 或 Responses 协议" width="960">
</p>

### 语音栏与 GPT-Live 执行模型选择

<p align="center">
  <img src="./assets/screenshots/02-voice-gpt-live.png" alt="语音栏设置与 GPT-Live 执行模型选择" width="960">
</p>

### 扫描并导入本机 Agent 会话

<p align="center">
  <img src="./assets/screenshots/03-agent-session-scan.png" alt="本机 Agent 会话扫描结果" width="960">
</p>

### 按服务商管理待应用模型

<p align="center">
  <img src="./assets/screenshots/04-model-catalog.png" alt="第三方模型目录与服务商命名空间" width="960">
</p>

### Agent 路由与模型能力目录

<p align="center">
  <img src="./assets/screenshots/05-agent-routing.png" alt="Agent 路由与模型能力目录" width="960">
</p>

> 当前发布状态：macOS Apple Silicon `v1.1.2`，Windows `v1.0.8`。Linux 版本尚未发布。
>
> `v1.1.2` 在 `v1.1.1` 基础上统一了官方 GPT 与第三方模型的原生 `gpt-image-2` 生图路径，并保留 `gpt-image-1.5` 作为明确兜底；同时 GPT-Live 只在用户主动开启时启动。
>
> ✅ macOS Release DMG 已内置独立 Node.js 运行时。下载安装后即可运行网关，不需要额外安装 Node.js、npm 或 Homebrew。
>
> ⚠️ 当前 macOS DMG 未经过 Apple Developer 签名与公证。首次打开时，如果 macOS 阻止运行，请在“系统设置 → 隐私与安全性”中允许打开。

## 简体中文

### OpenCodex 是什么？

OpenCodex 不替换 Codex Desktop，也不会把官方模型强行改走第三方接口。它在 Codex 旁边提供一个本地网关和控制中心：

- 官方 Codex 模型继续走 Codex 原生路径。
- 只有用户明确添加或导入的第三方模型才进入 OpenCodex 网关。
- 每个服务商和模型都有独立身份，避免同名模型互相覆盖。
- 网关只监听本机回环地址，并为管理接口提供本地授权保护。

### 功能总览

| 模块 | 功能 |
| --- | --- |
| 🌐 本地网关 | 管理服务商、API Key、模型、协议和本机订阅，并把已启用模型接入 Codex Desktop |
| 🧠 动态模型目录 | 自动读取模型推理档位、上下文窗口、协议和其他能力元数据 |
| 🔌 多协议路由 | 支持 OpenAI Responses、OpenAI Chat Completions，以及 Anthropic、Google、DeepSeek、MiniMax 等适配路径 |
| 🎙️ 语音助手 | STT、TTS、VAD、语音系统提示、全局语音栏和可视化 HUD |
| 🤖 GPT-Live | 进行实时语音沟通，并可随时把任务安排给任意已接入模型执行；支持随时切换执行模型 |
| 🖥️ Computer Use | 让第三方模型使用 Codex 原生桌面操作执行器，支持截图结果和工具续接 |
| 💬 会话中心 | 浏览本地 Codex 会话、查看可见上下文、删除会话、扫描并导入外部 Agent 会话 |
| 🧰 Agent / MCP | 保留 Codex 原生 MCP 与工具能力，并兼容第三方模型的工具调用和连续执行 |
| 🧭 Agent 路由 | 按模型能力说明和默认推理强度自动分配子任务，也支持强制指定模型或关闭路由 |
| 🛡️ 原生保护 | 一键重启应用模型，或一键恢复原生 Codex，不破坏官方模型路径 |
| 📋 日志与诊断 | 查看网关实时日志、服务商连接状态、模型测试状态和启动状态 |

## 详细功能

### 1. 服务商与第三方模型管理

OpenCodex 控制中心提供常用服务商预设，也允许手动添加 OpenAI Compatible 服务：

- 常用预设：DeepSeek、Qwen、Z.ai、MiniMax、Kimi。
- 更多预设：OpenRouter、OpenCode Go、SiliconFlow、火山方舟。
- 自定义 OpenAI Compatible：填写 Endpoint / Base URL、API Key 和模型名称。
- 一个服务商可以配置多个模型，支持逐个测试、删除和重新测试。
- 每个模型可以单独选择 `Chat` 或 `Responses` 协议。
- 支持模型显示名与实际后端模型名分离，例如 `我的模型=backend-model-id`。
- 服务商命名空间会自动生成，例如 `deepseek/model-name`、`opencode/model-name`，避免不同服务商的同名模型冲突。
- 模型先进入“待应用模型”列表；测试通过后，重启 Codex 才会写入 Desktop 的模型菜单。
- 支持批量选择和删除已添加模型。

### 2. 模型推理档位自动识别

模型的推理档位不是按某个厂商硬编码，而是按模型实际能力生成：

- 如果厂商接口返回了推理档位，就使用该模型自己的档位列表。
- 如果模型注册表返回了明确档位，也会按注册表显示。
- 已返回的窄档位不会被强行补成其他档位；模型只有两档或四档时，就显示两档或四档。
- 如果模型没有返回可枚举的推理档位，只保留“自动”，不会猜测或发送固定档位。
- 如果服务商明确声明模型不支持推理，则不显示推理档位。
- 模型的默认档位会从该模型实际支持的列表中选择，不会发送不存在的档位。

### 3. 上下文窗口自动识别

上下文长度按模型单独保存和使用：

1. 优先使用厂商 `/models` 或其他实时接口明确返回的上下文窗口。
2. 没有实时返回时，使用模型注册表提供的上下文窗口。
3. 两者都没有时，使用 `200K` 作为保守兜底值。
4. 已经由厂商接口确认过的窗口不会被不明确的注册表数据覆盖。
5. 原生 Codex 模型继续使用 Codex 自己的上下文限制，不由第三方目录覆盖。

因此，不同第三方模型可以拥有不同的上下文长度；切换模型时，目录元数据也会跟着模型切换。

### 4. 本机订阅导入

在 macOS 上，OpenCodex 可以检测和导入部分本机桌面/CLI 登录态，并实时获取服务商可用模型：

- **Antigravity**：读取本机 OAuth 登录态，并动态获取模型目录。
- **Grok**：读取 Grok CLI 登录态、刷新令牌并获取模型目录。
- **Claude**：读取 Claude Desktop 新版加密 OAuth 缓存，同时兼容旧缓存、Claude Code 登录态和 OAuth 刷新/交换。
- **Cursor**：读取本机 Cursor 登录态、刷新令牌，并通过 Cursor AgentService 获取模型。

订阅导入不会只凭“检测到登录文件”就自动添加模型，而是需要用户点击导入，并以服务商实时返回的模型为准。导入后仍可以测试、删除或重新导入。

### 5. 网关路由与协议兼容

OpenCodex 网关会根据模型目录中的服务商、后端模型名和协议进行明确路由：

- 原生 Codex Responses 请求继续转发到官方 Codex 后端。
- 第三方模型可以使用 OpenAI Responses 或 Chat Completions。
- Anthropic Messages、Google Gemini、DeepSeek、MiniMax 等有对应的请求/响应适配器。
- 支持流式输出、推理内容、工具调用、工具结果和多轮续接。
- 第三方 Responses 不支持某项能力时，可以按协议安全回退到 Chat 路径。
- 支持请求体解压、流式背压、上游瞬时网络错误重试和响应头安全转发。
- 原生 GPT 的上下文压缩完全透传；第三方 Responses 模型仅在原生支持 `/responses/compact` 时转发并转换后端模型名，不生成网关自定义压缩结果。

### 6. Computer Use、图像和 MCP

第三方模型的 Computer Use 不会伪造一套独立的桌面执行器，而是接入 Codex 的实际工具执行链：

- 第三方模型可以请求桌面操作，再由 Codex 原生执行器执行。
- 支持屏幕截图、鼠标、键盘和工具结果的连续交互。
- 针对不同供应商对图片大小、格式和工具结果的限制，网关会做兼容处理。
- 原生 Codex Computer Use 和 MCP 不会因为启用第三方模型而被删除或替换。
- 支持原生图像生成桥接，图像请求和普通聊天模型路由保持分离。
- Cursor AgentService 支持工具调用、外部工具结果和连续会话续接。

### 7. GPT-Live 与实时通信

GPT-Live 用于实时语音沟通和任务安排：

- 进行 Live 对话时，可以随时把当前任务安排给任意已接入且可用的模型执行。
- 执行模型可以是官方模型，也可以是已经启用并测试通过的第三方模型；不需要固定使用 Live 当前的对话模型。
- 独立的 GPT-Live 模型选择悬浮球不依赖 OpenCodexBar。
- 支持在一次任务的连续续接过程中保持正确的模型绑定。
- 原生 Realtime / WebRTC 通信保留独立路径，第三方网关路由不会覆盖原生 Live。

### 8. Agent 路由与模型能力目录

Agent 路由让主 Agent 根据每个模型的实际工作说明分配子任务：

- 在“模型能力目录”中，为已接入模型填写擅长领域 / 工作说明，选择该模型支持的默认推理强度，并决定是否参与自动分配。
- 自动分配只使用用户保存的模型说明，不根据模型名称猜测能力；主 Agent 会根据任务难度决定是否拆分，以及使用 0、1 还是多个子 Agent。
- 支持“自动分配”“强制选择”和“关闭路由”三种模式；强制模式下，每个子任务使用指定模型。
- 能力说明和路由规则独立于模型导入目录，重新导入模型不会覆盖已保存的配置。

### 9. 语音助手与 OpenCodexBar

语音页包含完整的输入、输出和会话设置：

#### 语音识别 STT

- 本地 Whisper：填写 `base`、`small`、`turbo` 或本地模型文件路径，不需要 API Key。
- OpenAI Compatible / Groq API：填写 API Key、Base URL 和转写模型。

#### 语音合成 TTS

- Edge TTS。
- 火山引擎 / 豆包 TTS，可配置 AppID、Resource ID / Cluster、模型和发音人。
- MiniMax TTS。
- 小米 MiMo TTS。
- OpenAI Compatible TTS API。

#### 会话和体验

- 短按切换持续监听，或使用长按说话、松手提交。
- 配置语音使用的模型和语音系统提示。
- 配置 VAD 静音阈值、结束等待时间和 HUD 动效主题。
- 通过 OpenCodexBar 提供全局语音栏、麦克风录音、状态胶囊和语音播放。
- 支持重启 Codex、等待 CDP 就绪并启动语音助手。
- 提供 `/visualizer` 动效实验室，可预览和切换语音 HUD 主题。

### 10. 会话中心与 Agent 导入

会话中心可以浏览 Codex 本地会话，并查看完整的可见对话内容：

- 会话列表、标题、模型、工作目录、时间和消息数量。
- 查看用户消息、助手消息和会话中的可见图片。
- 不展示隐藏推理内容，避免把内部记录当作普通对话显示。
- 删除本地会话。
- 支持直接导入 JSON、JSONL、SQLite、SQLite3、DB、Markdown 和 Markdown 文件。

“扫描本机 Agent”可以发现并选择导入：

- Antigravity Agent
- Cursor Agent
- Grok CLI Agent
- Claude Code CLI
- Hermes Agent

导入后会把会话转换为 Codex 可识别的 rollout，并注册到 Codex 会话数据库，使它出现在 Desktop 侧边栏中。

### 11. 应用、安全与还原

- 网关默认只监听 `127.0.0.1`，不直接暴露到局域网。
- 管理接口使用本地 admin cookie / bearer 授权。
- 控制中心不会把 API Key 明文返回到前端；已保存的 Key 使用掩码显示。
- macOS 上的服务商 Key 使用 Keychain 保存，配置文件只保存引用和非敏感元数据。
- 网关日志会记录连接、导入、测试和重启状态，但不应包含完整令牌。
- “重启 Codex”会把待应用模型写入 Desktop 模型目录并重启相关进程。
- “恢复原生 Codex”会移除第三方模型选择、模型目录和托管配置，但保留服务商身份、Endpoint 和 Key，且不修改原生 Computer Use / MCP。
- 网关包含单实例锁和父进程退出清理，避免重复启动多个网关进程。

## 使用方式

### macOS 普通用户

1. 先安装并登录 Codex Desktop。
2. 下载 [OpenCodex-1.1.2-arm64.dmg](https://github.com/AITabby/opencodex/releases/download/v1.1.2/OpenCodex-1.1.2-arm64.dmg)。
3. 打开 DMG，把 `OpenCodex.app` 拖入 `Applications`。
4. 启动 OpenCodex，进入“网关”配置 API Key 或导入本机订阅。
5. 保存模型后，在“待应用模型”中测试连接。
6. 测试通过后点击“重启 Codex（应用模型菜单）”，让模型出现在 Codex Desktop。

DMG 已包含网关所需的独立 Node.js 和语音运行时。普通用户不需要额外安装 Node.js、npm、Homebrew 或 .NET SDK。

### Windows 10/11

当前 Windows 发布版本为 `v1.0.8`：

1. 安装 Codex Desktop。
2. 下载 [OpenCodex-1.0.8-win-x64.exe](https://github.com/AITabby/opencodex/releases/download/v1.0.8/OpenCodex-1.0.8-win-x64.exe)。
3. 运行安装程序并启动 OpenCodex。

Windows 版本以对应安装包实际提供的功能为准；当前 macOS 原生订阅导入、OpenCodexBar 和部分 CDP 集成依赖 macOS 桌面环境。

### 从源码运行网关

需要 Node.js 和 npm：

```bash
git clone https://github.com/AITabby/opencodex.git
cd opencodex
npm install
npm run build
npm start
```

启动后访问：

```text
http://127.0.0.1:8765/dashboard
```

如果要构建 macOS 桌面应用和内置语音伴侣，需要 macOS、Swift 工具链以及项目脚本要求的语音运行时：

```bash
npm run build:all
./macos-app/scripts/package-dmg.sh
```

DMG 产物位于：

```text
macos-app/build/OpenCodex-<version>-arm64.dmg
```

### 测试

```bash
npm test
```

测试覆盖模型目录、推理档位、上下文窗口、服务商命名空间、Responses / Chat 转换、Computer Use、MCP、会话导入、语音控制、Realtime 代理、凭据保护、发布包契约和 macOS 打包契约等功能。

## 工作方式

```text
Codex Desktop
  ├─ 官方模型 / 原生 Responses
  ├─ 原生 Computer Use / MCP
  └─ 原生 Live / Realtime
          │
          ▼
OpenCodex App
  ├─ 本地网关与管理 API
  ├─ 第三方模型目录与协议路由
  ├─ 动态推理档位与上下文元数据
  ├─ GPT-Live 模型交接
  ├─ 语音 STT / TTS / OpenCodexBar
  ├─ 会话浏览、扫描与导入
  └─ 日志、重启、还原与安全控制
          │
          ▼
API Key 服务商 / 本机订阅 / OpenAI Compatible 服务
```

## 项目状态

OpenCodex 正在持续迭代。当前发布状态：

- macOS Apple Silicon：`v1.1.2`，DMG 已发布。
- Windows 10/11：`v1.0.8`，安装包已发布。
- Linux：暂未发布桌面安装包。

建议通过 [GitHub Releases](https://github.com/AITabby/opencodex/releases) 获取最新版本，并在提交问题时附上系统版本、OpenCodex 版本、服务商、模型名称和脱敏后的网关日志。

## 相关链接

- [GitHub Repository](https://github.com/AITabby/opencodex)
- [GitHub Issues](https://github.com/AITabby/opencodex/issues)
- [Latest Release](https://github.com/AITabby/opencodex/releases/latest)
- [Download OpenCodex v1.1.2 for macOS](https://github.com/AITabby/opencodex/releases/download/v1.1.2/OpenCodex-1.1.2-arm64.dmg)
- [Download OpenCodex v1.0.8 for Windows](https://github.com/AITabby/opencodex/releases/download/v1.0.8/OpenCodex-1.0.8-win-x64.exe)
- [语音助手使用指南](./VOICE_GUIDE.md)
- [测试流程](./TEST_FLOW.md)
- [X / Twitter: @youngxxxxu](https://x.com/youngxxxxu)

---

## English

### A local AI workspace for Codex Desktop

OpenCodex is a local control center for Codex Desktop. It brings third-party models, provider management, dynamic model metadata, voice, GPT-Live, session import, Agent routing, Computer Use compatibility, and Agent tools into one desktop workflow while keeping native Codex routing separate.

Native Codex models, native login, native Computer Use, MCP, and native Live / Realtime remain on their original paths. Only models explicitly added or imported by the user are routed through the OpenCodex gateway.

### Screenshots

![OpenCodex control center](./assets/dashboard-home.png)

![Provider and model configuration](./assets/screenshots/01-provider-model-config.png)

![Voice and GPT-Live](./assets/screenshots/02-voice-gpt-live.png)

![Agent session scanning](./assets/screenshots/03-agent-session-scan.png)

![Enabled model catalog](./assets/screenshots/04-model-catalog.png)

![Agent routing and model capability directory](./assets/screenshots/05-agent-routing.png)

### Current releases

- macOS Apple Silicon: `v1.1.2` DMG.
- Windows 10/11: `v1.0.8` installer.
- Linux: no desktop package is published yet.

The macOS DMG includes a standalone Node.js runtime and the bundled voice runtime. End users do not need Node.js, npm, Homebrew, or the .NET SDK. The current DMG is not notarized; macOS may require allowing the first launch from **System Settings → Privacy & Security**.

### Feature overview

#### Gateway and provider management

- Presets for DeepSeek, Qwen, Z.ai, MiniMax, Kimi, OpenRouter, OpenCode Go, SiliconFlow, and Volcengine.
- Custom OpenAI-compatible endpoints.
- Multiple models per provider, per-model connection tests, deletion, and bulk deletion.
- Per-model Chat or Responses protocol selection.
- Display aliases separated from backend model IDs.
- Stable provider namespaces such as `deepseek/model-name` and `opencode/model-name`.
- Staged model changes that become visible in Codex Desktop after an explicit restart.

#### Dynamic model capabilities

- Reasoning levels come from provider metadata or the model registry when available.
- A model-specific list is authoritative: narrow or extended lists are preserved as returned.
- Models without returned selectable levels expose automatic reasoning only; no fixed levels are guessed.
- Explicitly non-reasoning models expose no reasoning picker.
- Context windows prefer live provider metadata, then the matching model-registry value, and fall back to `200K` only when neither source is available.
- Native Codex model metadata remains independent from third-party catalog metadata.

#### Local subscription imports

On macOS, the dashboard can detect and import available local login states for Antigravity, Grok, Claude, and Cursor. Imports use live provider model discovery instead of blindly relying on a hardcoded model list. Claude Desktop encrypted OAuth cache, legacy caches, Claude Code credentials, Cursor credentials, and token refresh paths are handled separately.

#### Routing and compatibility

- OpenAI Responses and Chat Completions support.
- Anthropic, Google Gemini, DeepSeek, MiniMax, and OpenAI-compatible adapters.
- Streaming, reasoning, tool calls, tool results, multi-turn continuations, request decompression, bounded streaming writes, and transient upstream retries.
- Native GPT compaction is passed through unchanged; third-party compaction is forwarded only when the provider exposes native `/responses/compact`.
- Native Codex Responses, native Live / Realtime, Computer Use, and MCP remain isolated from third-party routing.

#### Computer Use, images, and MCP

Third-party Computer Use requests are connected to the Codex-native executor rather than a fabricated gateway-only tool. Screenshot and tool-result image compatibility, multi-turn tool continuations, native image-generation bridging, and Cursor AgentService tool continuations are supported.

#### GPT-Live and voice

- GPT-Live can assign the current task to any connected and available official or third-party model at any time, without requiring the Live conversation model to perform the work.
- The independent Live model picker can switch the execution model during a task and does not depend on OpenCodexBar.
- STT: local Whisper or OpenAI-compatible / Groq transcription APIs.
- TTS: Edge TTS, Volcengine / Doubao, MiniMax, MiMo, or OpenAI-compatible TTS APIs.
- VAD threshold and silence duration, interaction mode, voice prompt, voice model, and HUD theme settings.
- OpenCodexBar global voice bar, CDP restart flow, and the `/visualizer` theme lab.

#### Agent routing and model capability directory

- Write a capability or work description for each connected model, choose a supported default reasoning level, and decide whether it participates in automatic assignment.
- Automatic assignment uses the descriptions saved by the user; the main Agent decides whether to split a task and how many sub-agents to use.
- Routing supports automatic assignment, a forced model, or routing disabled. Forced mode sends each subtask to the selected model.
- Routing rules and capability descriptions are independent from the imported model directory and survive model re-imports.

#### Sessions and Agent import

- Browse visible Codex messages, metadata, and session images.
- Delete sessions.
- Scan and import Antigravity, Cursor Agent, Grok CLI, Claude Code CLI, and Hermes Agent sessions.
- Import JSON, JSONL, SQLite, DB, and Markdown session files and register imported rollouts in the Codex Desktop sidebar.

#### Security and recovery

- Loopback-only gateway with protected admin APIs.
- Masked credentials in the dashboard and Keychain-backed provider secrets on macOS.
- Live gateway logs and provider test state.
- Native reset removes managed third-party model selections and catalog data while preserving provider identity, endpoints, and credentials.
- Single-instance gateway locking and parent-process cleanup reduce duplicate gateway processes.

### Installation

#### macOS

1. Install and sign in to Codex Desktop.
2. Download [OpenCodex v1.1.2 for Apple Silicon](https://github.com/AITabby/opencodex/releases/download/v1.1.2/OpenCodex-1.1.2-arm64.dmg).
3. Drag `OpenCodex.app` into `Applications`.
4. Configure a provider or import a local subscription, test the model, and restart Codex to apply it.

#### Windows 10/11

Download and run the [OpenCodex v1.0.8 installer](https://github.com/AITabby/opencodex/releases/download/v1.0.8/OpenCodex-1.0.8-win-x64.exe). macOS-specific local subscription, OpenCodexBar, and CDP integrations are not assumed to have full Windows parity.

#### From source

```bash
git clone https://github.com/AITabby/opencodex.git
cd opencodex
npm install
npm run build
npm start
```

Open `http://127.0.0.1:8765/dashboard` after the gateway starts. For the macOS desktop app and bundled voice companion, use `npm run build:all` and `./macos-app/scripts/package-dmg.sh` on macOS.

### Links

- [GitHub Repository](https://github.com/AITabby/opencodex)
- [GitHub Issues](https://github.com/AITabby/opencodex/issues)
- [Latest Release](https://github.com/AITabby/opencodex/releases/latest)
- [Download OpenCodex v1.1.2 for macOS](https://github.com/AITabby/opencodex/releases/download/v1.1.2/OpenCodex-1.1.2-arm64.dmg)
- [Download OpenCodex v1.0.8 for Windows](https://github.com/AITabby/opencodex/releases/download/v1.0.8/OpenCodex-1.0.8-win-x64.exe)
- [Voice Assistant Guide](./VOICE_GUIDE.md)
- [Test Flow](./TEST_FLOW.md)
- [X / Twitter: @youngxxxxu](https://x.com/youngxxxxu)
