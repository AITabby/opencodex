# Third-party notices

## 中文说明

### CC Switch 服务商目录元数据

CodexSplit 控制中心中的几十个 API 服务商预设，参考了 CC Switch 公开的
Codex provider preset 列表：

<https://github.com/farion1231/cc-switch/blob/main/src/config/codexProviderPresets.ts>

该来源项目采用 MIT License。CodexSplit 只引用和整理服务商名称、公开
Endpoint 元数据、协议提示和模型 ID，没有复制 CC Switch 的认证、代理、
订阅、推荐、合作推广或图标实现。

这些内容只是目录元数据，不是官方集成或合作声明，也不保证每个服务商、
模型、地区、额度或 Endpoint 都可用。用户需要提供自己的凭据，并自行
验证实际接口和模型响应。

### Provider 图标与认证术语

已知服务商品牌的图标使用公开的 Simple Icons CDN；没有对应 slug 时使用
服务商 Endpoint 域名的 favicon，最后才使用服务商首字母。图标只用于展示，
不参与认证或路由。

API Key 服务商与 OAuth 本机订阅是两类不同配置：API Key 服务商由用户
提供 Key 并发现、测试模型；Antigravity、Grok、Claude、Cursor 等本机登录
态订阅不属于 API Key 目录。

## English

## CC Switch provider catalog metadata

CodexSplit includes a curated set of neutral provider metadata derived from
CC Switch's Codex provider preset source:

<https://github.com/farion1231/cc-switch/blob/main/src/config/codexProviderPresets.ts>

The source project is distributed under the MIT License. CodexSplit imports
only provider names, public endpoint metadata, protocol hints, and model IDs;
it does not import CC Switch's authentication, proxy, subscription, referral,
partner-promotion, or icon implementations.

In practical terms, the dozens of API provider entries shown in the CodexSplit
provider directory are a reference catalog based on that public CC Switch
metadata. They are not official integrations or a guarantee that every
provider, model, region, quota, or endpoint is available. Users must supply
their own credentials and verify the actual endpoint and model response.

The imported entries are catalog-only. Availability, billing, model access,
and protocol compatibility must be verified with the user's own endpoint and
API key before use.

## Provider icons

Known provider brands use the public Simple Icons CDN by slug. Providers
without a matching Simple Icons slug use a favicon derived from their preset
endpoint domain, with the provider initial retained as the final fallback.
The icon URLs are display-only and are not used for authentication or routing.

Simple Icons source: <https://github.com/simple-icons/simple-icons>

## Authentication terminology

CodexSplit uses a strict two-way distinction:

- `auth_mode: api_key`: every provider preset in the API catalog, including
  Coding Plan or Token Plan products. The user supplies a key, then discovers
  and tests the available models.
- `auth_mode: oauth`: local login-state subscriptions such as Antigravity,
  Grok, Claude, and Cursor. These do not belong in the API-key catalog.
