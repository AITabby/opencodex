# OpenCodex macOS 应用壳

这是 OpenCodex 的原生 macOS 外壳。它保留现有 Node 网关和 Dashboard，负责窗口、网关 sidecar 生命周期以及未来的 macOS 权限与菜单栏能力。

## 开发运行

在仓库根目录执行：

```bash
./macos-app/scripts/run-dev.sh
```

开发运行会使用仓库内的 `dist/server.js`，并通过 `OPENCODEX_PORT` 给网关传入动态端口。

## 构建应用

```bash
./macos-app/scripts/package-app.sh
```

产物为 `macos-app/build/OpenCodex.app`。打包时会把当前 Node runtime、`dist/`、`node_modules/`、VAD Python 资源，以及 `uv`、`uvx`、`ffmpeg` 语音运行时放入应用资源，因此用户不需要预装 Node、PM2、Python 或 Homebrew 音频工具。首次使用本地 Whisper 或 Edge TTS 时，内置 `uvx` 可能需要联网准备对应 Python 包；本地模型路径会直接传给 Whisper，不要求重新下载模型。若本机 Python 缺少 Silero/PyTorch，VAD 会自动降级为内置能量 VAD。

语音 STT/TTS API Key 只保存到 macOS Keychain；`voice_settings.json` 只保存 Keychain 引用，Dashboard 和 API 只返回掩码。旧版本遗留的明文 Key 会在首次读取语音设置时迁移；如果 Keychain 不可用则会清除明文并提示重新填写。

TTS 支持 API 引擎和 macOS 系统语音。选择 macOS 系统语音时直接调用系统 `/usr/bin/say` 生成本地音频，不需要 API Key；选择豆包、MiniMax、OpenAI 兼容接口等 API 时仍按对应配置请求远程服务。

发布版会把 OpenCodexBar 内置到 `OpenCodex.app/Contents/Resources/OpenCodexBar.app`，主 App 会优先启动这个内置语音组件，用户不需要单独下载或安装 OpenCodexBar。开发运行仍会探测常见外部路径，也支持 `OPENCODEX_BAR_PATH` 指向 `.app` 或源码构建目录。

打包时默认从仓库内的 `voice/OpenCodexBar` 读取或构建语音组件，因此克隆 OpenCodex 后不再要求旁边另有一个 `opencodex-bar` 仓库；发布构建也可以显式传入 `OPENCODEX_BAR_APP_PATH=/path/to/OpenCodexBar.app`，或者用 `OPENCODEX_BAR_SOURCE=/path/to/opencodex-bar` 覆盖源码路径。

## 构建 DMG

```bash
./macos-app/scripts/package-dmg.sh
```

产物为 `macos-app/build/OpenCodex-1.0.3-arm64.dmg`。当前是本地 arm64 未签名构建；正式分发前还需要 Apple Developer 签名和公证。

DMG 采用标准拖拽安装方式：打开镜像后，把 `OpenCodex.app` 拖到旁边的 `Applications` 快捷入口，应用就会安装到 `/Applications`。DMG 本身不会在用户打开镜像时静默复制或自动安装应用；如果需要全自动安装，应另外制作 `.pkg` 安装包。

发布前可运行完整资源与签名检查：

```bash
./macos-app/scripts/verify-release.sh
```

当前构建跟随执行构建机器架构；这台机器产出 arm64。Intel 或 universal 版本需要在对应架构环境准备 Node runtime 后再单独构建，不能把 arm64 Node 直接冒充 universal 包。

如果本机已安装 Developer ID 证书，可以这样签名并校验：

```bash
OPENCODEX_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
  ./macos-app/scripts/sign-app.sh
```

设置同一个环境变量后运行 `package-dmg.sh`，DMG 会自动使用已签名的 App 生成。

公证需要先在钥匙串中配置 `notarytool` profile，然后执行：

```bash
OPENCODEX_NOTARY_PROFILE="opencodex-notary" \
  ./macos-app/scripts/notarize-app.sh
```

sidecar 设置 `OPENCODEX_PARENT_PID`。当应用异常退出时，网关会自动检测宿主进程消失并结束，避免遗留端口和后台进程。

主窗口红色关闭按钮只关闭窗口，网关和内置语音组件继续运行；从 App 菜单或 Dock 选择“退出 OpenCodex”才会停止后台服务。
