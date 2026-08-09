# Provider Workspace redesign

This document records the product and engineering boundary for the macOS
Provider Workspace introduced in v1.0.2. CodexSplit is an independently
developed codebase. During an intermediate design phase, we reviewed public
provider-management products to compare product organization and architecture
ideas. The decisions below describe CodexSplit's own implementation boundary.

## Design notes

These notes describe the product and architecture decisions implemented in
this repository. They do not enumerate external projects or implementation
dependencies.

| Design concern | CodexSplit decision |
| --- | --- |
| Provider identity and capability metadata | The V2 catalog and adapter layers under `src_v2` keep provider identity, protocol, authentication paths and model capabilities as data rather than special-case routing branches. |
| Provider workspace organization | `src_v2/services/dashboard.ts` provides a macOS Provider Workspace with a rail, detail panel, route map and safety checks. |
| Usage and quota truthfulness | The UI never invents quota. It shows a real meter only after a verified official integration is added. |

## CodexSplit local constraints

| Local CodexSplit issue | Constraint | Decision in CodexSplit |
| --- | --- | --- |
| [Issue #14](https://github.com/AITabby/codexsplit/issues/14) | A gateway must not damage the desktop client or leave it in a broken state. | Provider changes are explicit; the interface makes native and gateway routes separate. |
| [Issue #9](https://github.com/AITabby/codexsplit/issues/9) | A model that does not emit a tool call must not look like a successful tool turn. | Tool-bearing Responses turns prefer `tool_choice: "required"`; a provider that rejects it is retried safely, while a text-only result is emitted as `response.failed` with `no_tool_emitted` rather than `response.completed`. |
| [Issue #8](https://github.com/AITabby/codexsplit/issues/8) | Desktop-owned state must not be casually rewritten. | The new provider flow never edits Codex history/index state. |
| [Issue #10](https://github.com/AITabby/codexsplit/issues/10) | macOS permission state must be refreshed rather than assumed. | Computer Use stays outside Provider Workspace; its status is not modified by provider actions. |

## What is now implemented

1. A static, reviewable provider catalogue for Kimi Code, Qwen/Model Studio,
   Z.AI GLM, MiniMax, DeepSeek, generic OpenAI-compatible endpoints and a local
   no-network simulator.
2. Provider capability metadata: protocol, supported authentication paths,
   context window, tools, vision and reasoning. These are UI/catalogue claims,
   not an entitlement claim.
3. New API keys are placed in **macOS Keychain**. `providers.json` stores only
   `credential_ref`; old plaintext credentials are retained only as legacy
   compatibility until a provider is saved again.
4. Explicit, user-triggered connection testing. No provider endpoint is
   contacted when CodexSplit starts or while merely browsing the catalogue.
5. A local `mock://opencodex` provider so model metadata and tool-call setup can
   be exercised on a machine with no subscription account.
6. Atomic writes for `providers.json`, a provider deletion flow, and automatic
   removal of that provider's installed third-party models.
7. The old automatic Computer Use plugin installation/enablement path has been
   removed from provider and CLI activation flows.

## Subscription rollout policy

The listed Chinese providers are **catalogue entries**, not advertised working
subscription integrations. Roll them out one at a time:

1. Add verified official endpoint/auth documentation and a recorded fixture.
2. Test plain completion, streaming, multi-turn history, tool-call streaming,
   tool result continuation, image input and a 401/429/network failure.
3. Mark the provider `stable` only after a real account regression on macOS.
4. Keep OAuth, CLI-state import and browser-cookie handling separate. Do not
   read browser cookies. Do not silently mix a subscription token with an API
   key.

## Non-negotiable invariants

- Official Codex models always use the native route.
- Third-party routing is enabled only by explicitly installed models.
- Provider operations never install, enable, disable or rewrite Computer Use
  or MCP configuration.
- A failed provider check cannot change Codex configuration.
- Credentials and request bodies must not be logged.

## Next real-account work

The first account available should validate one provider end to end, preferably
Kimi Code or Qwen. Only then add its official login/import adapter; the shared
registry and UI should be reused without altering the native routing or tool
protocol.
