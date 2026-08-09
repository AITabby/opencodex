# CodexSplit v2.0.0-beta.1

CodexSplit 2.0.0 Beta 1 is the first public Beta under the CodexSplit name.
The release is intentionally published as a source tag plus a macOS Apple
Silicon DMG so Windows development can continue from the exact same source.

## 中文

CodexSplit 2.0.0 Beta 1 是以 CodexSplit 名称发布的第一个公开 Beta。
本次发布同时提供源码 tag 和 macOS Apple Silicon DMG，Windows 后续可以
基于完全相同的源码继续开发。

### 本次包含

- `v2.0.0-beta.1` 对应的完整 CodexSplit 源码。
- macOS Apple Silicon 安装包：`CodexSplit-2.0.0-beta.1-arm64.dmg`。
- 官方 Codex 原生路由与第三方模型路由保持隔离。
- 第三方模型 Desktop Bridge，以及不绑定会话的官方 GPT 账号轮换。
- 服务商目录、模型发现、凭据、订阅导入、语音、GPT-Live、会话、Agent
  路由和网关诊断。

目录中的几十个 API 服务商预设参考了 [CC Switch 的 Codex provider preset
列表](https://github.com/farion1231/cc-switch/blob/main/src/config/codexProviderPresets.ts)。
CodexSplit 没有复制 CC Switch 的认证、代理、订阅、推广或图标实现；这些
预设不是官方合作，也不保证每个服务商、模型、地区、额度或接口都可用。

### Windows 开发

Windows 可以克隆仓库并切换到相同的 Beta tag：

```bash
git clone https://github.com/AITabby/codexsplit.git
cd codexsplit
git checkout v2.0.0-beta.1
```

第一个 Beta 暂不附带 Windows 安装包，Windows 安装包会在 Windows 端接入
完成后随后续 Beta 发布。

### 已知限制

- macOS DMG 是 arm64 本地 Ad-hoc 构建，尚未进行 Apple 公证。
- macOS 专属的本地订阅导入、Voice Bar 和 CDP 集成不代表 Windows 功能完全一致。
- `OPENCODEX_*`、`.opencodex` 和 `opencodex` provider namespace 等内部兼容标识
  暂时保留，避免产品改名破坏已有本地状态和路由契约。

## English

## Included

- CodexSplit source tree at tag `v2.0.0-beta.1`.
- macOS Apple Silicon package: `CodexSplit-2.0.0-beta.1-arm64.dmg`.
- Native Codex routing remains separate from third-party provider routing.
- Explicit Desktop Bridge mode for third-party models and official GPT account
  rotation without binding an account to a conversation.
- Provider catalog, model discovery, credentials, subscription imports, voice,
  GPT-Live, sessions, Agent routing, and gateway diagnostics.

The dozens of API provider presets in the catalog reference public metadata
from [CC Switch's Codex provider preset list](https://github.com/farion1231/cc-switch/blob/main/src/config/codexProviderPresets.ts).
CodexSplit does not copy CC Switch authentication, proxy, subscription,
promotion, or icon implementations, and the catalog is not an official
partnership or a guarantee of provider availability.

## Windows development

Windows can clone the repository and check out the same Beta tag:

```bash
git clone https://github.com/AITabby/codexsplit.git
cd codexsplit
git checkout v2.0.0-beta.1
```

The Windows installer is not attached to this first Beta. It will be added in
a later Beta after the Windows app packaging work is integrated.

## Known release limits

- The macOS DMG is an arm64 local Ad-hoc build and is not notarized.
- macOS-specific subscription import, Voice Bar, and CDP integrations do not
  imply Windows feature parity.
- Existing internal compatibility identifiers such as `OPENCODEX_*`,
  `.opencodex`, and provider namespace `opencodex` remain in the source so
  existing local state and routing contracts are not broken by the product
  rename.
