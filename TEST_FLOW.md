# OpenCodex Beginner Simulation Test Flow 🧪

[English](#english) | [简体中文](#简体中文)

---

# English

This document provides a step-by-step test flow to treat your current Codex Desktop setup as a **completely fresh, native beginner's installation**, and walk through the entire OpenCodex unlocking flow end-to-end.

---

## 🏁 Step 1: Simulate a Fresh, Native Codex State
Before starting, we will reset your `config.toml` to a standard state (removing all custom proxy bindings) to simulate a beginner who has just installed Codex:

1.  **Stop the active OpenCodex gateway**:
    ```bash
    pm2 stop opencodex
    ```
2.  **Restore config.toml to native state**:
    We have prepared a helper command to clean up managed blocks from `config.toml`:
    ```bash
    node -e '
    const fs = require("fs");
    const path = require("path");
    const tomlPath = path.join(process.env.HOME, ".codex", "config.toml");
    let content = fs.readFileSync(tomlPath, "utf-8");
    content = content.replace(/# >>> opencodex managed >>>[\\s\\S]*?# <<< opencodex managed <<<\\n?/gi, "");
    fs.writeFileSync(tomlPath, content.trim() + "\\n", "utf-8");
    console.log("✔ ~/.codex/config.toml successfully restored to Native/Fresh State!");
    '
    ```
    *At this point, your Codex has no custom providers and is identical to a newly installed native Codex.*

---

## 🚀 Step 2: Run the OpenCodex Setup Wizard (Beginner Simulation)
Now, simulate a beginner running the OpenCodex setup wizard for the first time:

1.  **Run the interactive setup**:
    ```bash
    cd /Users/aitabby/projects/opencodex
    npm run setup
    ```
2.  **Wizard Steps**:
    *   **Language Selection**: Enter `2` for **简体中文** (or `1` for **English**).
    *   **Conflict Clearance**: Observe the wizard automatically detecting and freeing port `8765` and unloading conflicting services.
    *   **DeepSeek Key**: Paste your OpenCode/DeepSeek API Key when prompted:
        `sk-LyjwiyqgDyyhQ5xhy8a9bALhtI7irtDHusLvy6o58qRFCdDQCajHNxIs4tmYK6ug`
    *   **OpenCode Key**: Press **Enter** to use the pre-packaged default key.
    *   **Activation**: Verify the wizard successfully surgeons `~/.codex/config.toml` and writes presets.

---

## ⚙️ Step 3: Compile and Launch the Gateway
Beginners compile and run the backend gateway daemon:

1.  **Build the TypeScript source**:
    ```bash
    npm run build
    ```
2.  **Launch via PM2**:
    ```bash
    pm2 start dist/server.js --name opencodex
    ```

---

## 🎨 Step 4: Verify with the Web Dashboard
Open the control center to verify all features:

1.  **Access the Dashboard**:
    Open your web browser and go to: **[http://localhost:8765/dashboard](http://localhost:8765/dashboard)**.
2.  **Test Bilingual Switching**:
    Click the **`🌐 EN / 中`** button in the top right. Labels, descriptors, and notifications will translate instantly!
3.  **Confirm Configuration**:
    Verify your API Key inputs and catalog checkboxes.

---

## 📸 Step 5: Test End-to-End Visual Computer Use
Finally, test Codex Desktop's visual features using the text-only DeepSeek model with visual fallback:

1.  **Open Codex Desktop**:
    Launch Codex Desktop from your Applications folder.
2.  **Select the Model**:
    In the top-left model selector dropdown, you will see your new custom catalog! Select **`OpenCode DeepSeek V4 Flash`**.
3.  **Prompt a Visual Task**:
    Type the following request into the chat bar and send:
    > "Look at my current screen, find the browser icon or a folder, and double click on it."
4.  **Watch the Magic Happen**:
    *   Codex will take a screenshot.
    *   OpenCodex intercepts this screenshot, compresses it via `sips`, sends it to OpenCode `mimo-v2.5` to generate a high-fidelity visual description, and injects it back.
    *   DeepSeek understands the screen elements and outputs coordinates.
    *   Our MCP Action performer clicks on the coordinate natively on your macOS!
    *   Open your Web Dashboard to watch the terminal logs streaming in real-time as this happens!

---

# 简体中文

本文档提供了一套完整的保姆级测试流程，将您当前的 Codex Desktop 模拟为**完全新手的原生干净安装状态**，并端到端走完 OpenCodex 的完整激活与视觉解锁过程。

---

## 🏁 第一步：模拟新手的干净原生 Codex 状态
在测试开始前，我们将还原您的 `config.toml`（清除所有自定义代理绑定），以完全模拟一个刚下载安装好 Codex 的新手状态：

1.  **停止当前的 OpenCodex 网关**：
    ```bash
    pm2 stop opencodex
    ```
2.  **还原 config.toml 至原生纯净状态**：
    运行以下命令，删除 `config.toml` 中所有历史注入块：
    ```bash
    node -e '
    const fs = require("fs");
    const path = require("path");
    const tomlPath = path.join(process.env.HOME, ".codex", "config.toml");
    let content = fs.readFileSync(tomlPath, "utf-8");
    content = content.replace(/# >>> opencodex managed >>>[\\s\\S]*?# <<< opencodex managed <<<\\n?/gi, "");
    fs.writeFileSync(tomlPath, content.trim() + "\\n", "utf-8");
    console.log("✔ ~/.codex/config.toml 成功还原为原生干净状态！");
    '
    ```
    *此时，您的 Codex 恢复为纯正的原生状态，不带任何第三方接口网关设置。*

---

## 🚀 第二步：运行 OpenCodex 安装向导（新手体验）
现在，开始模拟新手第一次下载并运行向导：

1.  **启动交互式安装**：
    ```bash
    cd /Users/aitabby/projects/opencodex
    npm run setup
    ```
2.  **向导交互步骤**：
    *   **选择语言**：输入 `2` 选择 **简体中文**（或输入 `1` 选择 **English**）。
    *   **清理冲突**：观察向导自动检测并释放占用 `8765` 端口的冲突进程。
    *   **DeepSeek Key 键入**：粘贴您的 OpenCode 密钥：
        `sk-LyjwiyqgDyyhQ5xhy8a9bALhtI7irtDHusLvy6o58qRFCdDQCajHNxIs4tmYK6ug`
    *   **OpenCode Key 键入**：直接敲击 **回车 (Enter)** 使用默认预设值。
    *   **写入激活**：观察向导对 `config.toml` 实施的手术级注入并生成预设。

---

## ⚙️ 第三步：编译并启动网关
新手编译并启动代理守护网关：

1.  **编译 TS 代码**：
    ```bash
    npm run build
    ```
2.  **在 PM2 中启动服务**：
    ```bash
    pm2 start dist/server.js --name opencodex
    ```

---

## 🎨 第四步：控制台双语验证
打开控制台，验证中英文和连接状态：

1.  **打开网页控制台**：
    在浏览器中直接打开 **[http://localhost:8765/dashboard](http://localhost:8765/dashboard)**。
2.  **验证语言切换**：
    点击右上角的 **`🌐 EN / 中`** 按钮，验证表单标签、文本描述和 Toast 悬浮弹窗是否秒切。
3.  **确认日志流**：
    控制台底部的日志区域会开始流式显示实时网关拦截报文。

---

## 📸 第五步：端到端视觉降级 Computer Use 验证
最后，也是最震撼的一步，验证非多模态的 DeepSeek 运行原生屏幕视觉操作：

1.  **打开 Codex Desktop**。
2.  **切换模型**：
    点击左上角模型选择下拉菜单，此时会发现列表更新了！选择 **`OpenCode DeepSeek V4 Flash`** 模型。
3.  **发起视觉操作任务**：
    在对话框输入并发送：
    > "帮我看看当前的屏幕，找一下浏览器或者任意文件夹，并用鼠标双击打开它。"
4.  **观看高光时刻**：
    *   Codex 会捕获一张截图。
    *   网关拦截截图，自动执行 `sips` 压缩，送往 `mimo-v2.5` 生成高保真文本描述并重新塞回 prompt。
    *   DeepSeek 完全读懂了屏幕，并吐出具体点击坐标。
    *   网关原生 MCP 接收坐标，用 Swift 原生 CGEvent 点击你的屏幕！
    *   与此同时，你可以**在网页控制台上，同步看着一行行拦截和请求日志行如流水地流过**！
