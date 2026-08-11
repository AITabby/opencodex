import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = () => readFile(new URL("../src_v2/services/dashboard.ts", import.meta.url), "utf8");

test("dashboard contains the complete voice configuration and one CDP launch path", async () => {
  const text = await source();
  for (const id of ["stt-api-key", "stt-base-url", "tts-api-key", "tts-base-url", "interaction-mode", "restart-cdp"]) {
    assert.match(text, new RegExp(`id=\\"${id}\\"`));
  }
  assert.doesNotMatch(text, /launch-voice-bar/);
  assert.match(text, /CDP 注入模式/);
  assert.match(text, /updateVoiceRuntimeStatus/);
});

test("dashboard keeps session import, scan, and delete controls", async () => {
  const text = await source();
  for (const marker of ["session-import-input", "session-scan-modal", "import-scanned-sessions", "deleteActiveSession", "session-message-image"]) {
    assert.match(text, new RegExp(marker));
  }
});

test("dashboard keeps visible progress states for destructive and network actions", async () => {
  const text = await source();
  for (const marker of ["runButton(button,labels,task)", "测试中…", "删除中…", "保存中…", "重启中…", "refresh-logs"]) {
    assert.match(text, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(text, /button\.pending/);
});

test("session dashboard serializes list refreshes and always reconciles deletion", async () => {
  const text = await source();
  assert.match(text, /let sessionListRequestSeq=0/);
  assert.match(text, /if\(requestSeq!==sessionListRequestSeq\)return null/);
  assert.match(text, /state\.sessions=\(state\.sessions\|\|\[\]\)\.filter/);
  assert.match(text, /列表刷新失败/);
});

test("dashboard uses the gateway admin cookie without embedding credentials", async () => {
  const text = await source();
  assert.doesNotMatch(text, /api_key.{0,20}localStorage/i);
  assert.match(text, /fetch\(/);
  assert.match(text, /api\('\/api\/providers'\)/);
});

test("dashboard exposes the per-model Chat or Responses protocol choice", async () => {
  const text = await source();
  assert.match(text, /provider-model-rows/);
  assert.match(text, /provider-model-row/);
  assert.match(text, /add-provider-model/);
  assert.match(text, /provider-remove-model/);
  assert.match(text, /多个模型用逗号分隔/);
  assert.match(text, /children\.length>=2/);
  assert.match(text, /value="chat"/);
  assert.match(text, /value="responses"/);
  assert.match(text, /provider-test-model/);
  assert.match(text, /testProviderModelRow/);
  assert.match(text, /\/api\/providers\/test-model/);
  assert.match(text, /model_test_status/);
  assert.match(text, /providerModelTestLabel/);
  assert.match(text, /<option value="chat"[^>]*>Chat<\/option>/);
  assert.match(text, /<option value="responses"[^>]*>Responses<\/option>/);
  assert.match(text, /model_protocols/);
  assert.match(text, /readProviderModelRows/);
});

test("dashboard exposes URL and key model discovery with explicit selection", async () => {
  const text = await source();
  for (const marker of [
    "provider-discovery-results",
    "discover-provider-models",
    "provider-discovery-select-all",
    "data-provider-model-select",
    "readProviderDiscoveryModels",
    "invalidateProviderDiscovery",
    "providerDiscoveryLoaded",
    "/api/providers/discover-models",
    "保存勾选模型",
    "模型 ID 会原样保留",
    "close-modal-top",
    "modal-titlebar",
    "max-height:calc",
  ]) {
    assert.match(text, new RegExp(marker.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")));
  }
  assert.match(text, /state\.providerDiscoveryLoaded\?readProviderDiscoveryModels\(\):readProviderModelRows\(\)/);
  assert.match(text, /providerDiscoveryExistingModels/);
});

test("dashboard keeps the API-key directory searchable and height-stable when expanded", async () => {
  const text = await source();
  for (const marker of [
    "provider-search",
    "provider-search-clear",
    "provider-directory-scroll",
    "height:446px",
    "overflow-y:scroll",
    "scrollbar-gutter:stable",
    "state.providerSearch",
    "renderProviderDirectory",
    "没有匹配的 API-Key Provider",
  ]) {
    assert.match(text, new RegExp(marker.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")));
  }
  assert.ok(text.includes("scroll.appendChild(moreRow)"));
  assert.ok(text.includes("directory.appendChild(scroll)"));
  assert.ok(text.includes("Key + URL + 获取模型"));
  assert.match(text, /data-configure/);
  assert.match(text, /defaultBaseUrl/);
  assert.match(text, /auth_mode:'api_key'/);
  assert.match(text, /\/api\/providers\/discover-models/);
});

test("dashboard resolves provider brands and domain favicon fallbacks", async () => {
  const text = await source();
  for (const marker of [
    "PROVIDER_ICON_SLUGS",
    "providerIconSlug",
    "providerIconHost",
    "cdn.simpleicons.org",
    "google.com/s2/favicons",
    "zdotai",
    "microsoftazure",
  ]) {
    assert.match(text, new RegExp(marker.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")));
  }
});

test("dashboard presents API-key credentials and OAuth accounts as pools under one provider", async () => {
  const text = await source();
  for (const marker of [
    "providerCredentialCount",
    "providerPoolSummary",
    "provider-pool-preview",
    "API Key 凭证池",
    "provider-pool-new-key",
    "provider-pool-add-key",
    "provider-pool-mode",
    "data-provider-credential-test",
    "data-provider-credential-remove",
    "subscriptionPoolSummary",
    "OAuth 订阅",
    "account_count",
    "credential_count",
    "pool_mode",
  ]) {
    assert.match(text, new RegExp(marker.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")));
  }
  assert.match(text, /同一个 Provider 下管理多个 Key/);
  assert.match(text, /Key 返回 401\/403/);
  assert.match(text, /\/api\/providers\/credentials\/add/);
  assert.match(text, /\/api\/providers\/credentials\/remove/);
  assert.doesNotMatch(text, /添加 API Key（池化预留）/);
});

test("dashboard keeps provider configuration compact and exposes an OAuth add flow", async () => {
  const text = await source();
  for (const marker of [
    "width:min(620px,calc(100vw - 32px))",
    "provider-pool-preview{display:grid;grid-column:1/-1",
    "add-oauth-button",
    "oauth-modal",
    "添加 OAuth 订阅",
    "添加 OAuth 登录账号",
    "重新检测登录态",
    "data-oauth-add",
    "data-oauth-login",
    "data-oauth-capture",
    "data-oauth-cancel",
    "OAUTH_PROVIDER_GUIDES",
    "#add-oauth-button,[data-oauth-add],[data-oauth-login],[data-oauth-capture],[data-oauth-cancel],[data-oauth-refresh-provider]",
    "openOAuthAddModal(target.dataset.oauthAdd||'')",
    "正在读取 OAuth 账号池",
    "账号备注（可选）",
    "/api/cli-bridge/accounts/login",
    "/api/cli-bridge/accounts/capture",
    "/api/cli-bridge/accounts/login-cancel/",
    "导入模型中…",
    "oauthModalRenderTimer",
  ]) {
    assert.ok(text.includes(marker), `missing dashboard marker: ${marker}`);
  }
  assert.match(text, /OAuth 不填写 API Key/);
  assert.match(text, /先添加登录账号，再导入模型/);
  assert.match(text, /模型目录导入仍由外面的“导入模型”按钮完成/);
  assert.doesNotMatch(text, /data-oauth-import/);
  assert.doesNotMatch(text, /characterData:true/);
});

test("provider configuration does not show catalog placeholder models before discovery", async () => {
  const text = await source();
  assert.doesNotMatch(text, /seededModels/);
  assert.match(text, /const existingModelList=configuredModels\.map/);
  assert.match(text, /show&&root&&!q\('#provider-model-rows'\)\.children\.length/);
  assert.match(text, /showManualProviderModels\(Boolean\(existingModelList\.length\)\)/);
});

test("provider configuration keeps equal vertical spacing between form sections", async () => {
  const text = await source();
  assert.match(text, /provider-form-spacing-style/);
  assert.match(text, /form-grid\+\.form-grid\{margin-top:16px\}/);
  assert.match(text, /#provider-modal \.field\{gap:8px\}/);
});

test("dashboard exposes a persistent Chinese-English language switch", async () => {
  const text = await source();
  assert.match(text, /id="language-toggle"/);
  assert.match(text, /opencodex\.language/);
  assert.match(text, /CodexSplit Control Center/);
  assert.match(text, /setLanguage/);
  assert.match(text, /MutationObserver/);
  assert.match(text, /closest\('\.session-item,\.session-message,\.log-row/);
});

test("dashboard exposes an explicit Desktop Bridge switch below the compact subscription card", async () => {
  const text = await source();
  for (const marker of [
    "desktop-bridge-card",
    "desktop-bridge-switch",
    "subscription-card-compact",
    "/api/desktop-mode",
    "active_mode",
    "third_party_models_exposed",
    "desired_mode",
    "mode_preference",
    "mode_change_in_progress",
    "subscriptionsRequestSerial",
    "subscriptionsAppliedSerial",
    "pendingMode",
    "bridge_available",
    "official_account_rotation_enabled",
    "官方 GPT 始终走 OpenAI 原生上游",
    "重启 Codex 时将自动开启 Desktop Bridge",
    "Desktop Bridge 当前关闭；官方 GPT 仍走 OpenAI 原生上游",
    "已开启 · 等待 Desktop",
    "网关重启不会改变 Bridge 开关",
    "不会删除已保存的 Provider、账号或模型",
  ]) {
    assert.match(text, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(text, /grid-column:2/);
  assert.match(text, /mode==='native'/);
  assert.match(text, /mode==='bridge'/);
  assert.match(text, /switchButton\.getAttribute\('aria-checked'\)==='true'\?'native':'bridge'/);
  assert.match(text, /restart\.disabled=!staged\.length/);
  assert.match(text, /post\('\/api\/restart-codex',applyModels\?\{apply_models:true\}:\{\}\)/);
  assert.match(text, /q\('#restart-button'\)\.onclick=function\(\)\{restart\(this,\{applyModels:true\}\)\}/);
  assert.match(text, /waitForDesktopMode\(result&&result\.mode\|\|expectedMode,Boolean\(applyModels&&result&&result\.desktop_relaunch_required\)\)/);
});

test("dashboard distinguishes imported subscription models from Bridge exposure", async () => {
  const text = await source();
  assert.match(text, /imported=Boolean\(info\.imported\|\|info\.active\)/);
  assert.match(text, /已导入 · 等待 Bridge/);
  assert.match(text, /模型目录已建立，开启 Bridge 后可用/);
  assert.match(text, /imported\|\|detected/);
});

test("dashboard colors provider status by model addition rather than Bridge state", async () => {
  const text = await source();
  assert.match(text, /statusText=credentialIssues\?String\(credentialIssues\)\+' 个 Key 异常':hasActiveModels\?'已配置':credentialCount\?'已保存'/);
  assert.match(text, /statusClass=credentialIssues\?'error':\(hasActiveModels\?'good':''\)/);
});

test("dashboard refreshes subscription status after every model deletion path", async () => {
  const text = await source();
  assert.match(text, /post\('\/api\/models\/delete',\{id:id\}\);await syncDashboardState\(\)/);
  assert.match(text, /post\('\/api\/models\/delete',\{ids:ids\}\);await syncDashboardState\(\)/);
  assert.match(text, /post\('\/api\/providers\/delete',\{name:name\}\);await syncDashboardState\(\)/);
});

test("1.1.0 dashboard exposes the simple model capability directory", async () => {
  const text = await source();
  for (const marker of [
    "view-agent-routing",
    "agent-routing-mode",
    "agent-routing-save",
    "agent-model-add",
    "agent-model-policy-list",
    "agent-model-select",
    "agent-model-policy-compact",
    "agent-model-policy-editor",
    "agent-model-toggle",
    "agent-description",
    "agent-reasoning",
    "agent-auto",
    "模型能力目录",
    "擅长领域 / 工作说明",
    "/api/agent-profiles",
    "/api/agent-routing/settings",
  ]) {
    assert.match(text, new RegExp(marker.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")));
  }
  assert.match(text, /自动分配/);
  assert.match(text, /强制选择/);
  assert.match(text, /重新导入不会覆盖/);
  assert.match(text, /按每个子任务的能力说明分别分配/);
  assert.match(text, /主 Agent 会根据任务难度决定/);
  assert.match(text, /0、1 还是多个子 Agent/);
  assert.match(text, /强制模式需要选择一个模型/);
  assert.match(text, /agentModelDescriptionSummary/);
  assert.match(text, /supported_reasoning_levels/);
  assert.match(text, /default_reasoning_level/);
  assert.match(text, /agentReasoningSupported/);
  assert.match(text, /AGENT_DEFAULT_REASONING_LEVELS/);
  assert.match(text, /low/);
  assert.match(text, /medium/);
  assert.match(text, /high/);
  assert.match(text, /agentReasoningLabel/);
  assert.match(text, /Agent Routing/);
  assert.match(text, /Model Capability Directory/);
  assert.match(text, /Assignment Rules/);
  assert.match(text, /Loading model configurations/);
  assert.match(text, /Reasoning: \$1/);
  assert.match(text, /Strictly match task types/);
  assert.match(text, /translateText/);
  assert.doesNotMatch(text, /agentReasoningOptions\(selected\)\{return \['', 'low', 'medium', 'high', 'xhigh', 'max'\]/);
  assert.match(text, /编辑/);
  assert.match(text, /view\.active#view-agent-routing/);
});

test("1.2.0 dashboard exposes the isolated official ChatGPT account pool boundary", async () => {
  const text = await source();
  for (const marker of [
    "view-chatgpt-accounts",
    "chatgpt-account-mode",
    "chatgpt-account-default",
    "chatgpt-account-rotation-enabled",
    "rotation_enabled",
    "创建并登录官方账号",
    "官方登录流程",
    "/api/chatgpt-accounts",
    "CODEX_HOME",
    "不修改 native app-server",
    "每次官方 GPT 请求时按官方剩余额度加权选择",
    "账号不绑定会话",
    "仅替换凭证并重试当前请求",
    "额度余量加权轮询",
    "不会把官方 GPT 送进第三方网关",
    "data-chatgpt-account-card",
    "data-chatgpt-collapse",
    "chatgpt-account-summary",
    "chatgpt-active-account-indicator",
    "chatgpt-bridge-status",
    "chatgpt-account-dispatch-controls",
    "readChatgptBridgeState",
    "refreshChatgptBridgeStatus",
    "chatgptBridgeRefreshTimer",
    "Bridge 正在重连",
    "账号轮换暂不可用",
    "workingChatgptAccountId",
    "chatgpt-working-badge",
    "chatgpt-account-card.is-working",
    "当前工作账号",
    "当前使用中",
    "最近一次工作",
    "等待下一次官方 GPT 请求",
    "account-pool-ico",
    "brand-copy",
    "brand-logo-wrap",
    "transform:scale",
    "localStorage",
  ]) {
    assert.match(text, new RegExp(marker.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")));
  }
  assert.match(text, /#chatgpt-account-list\{max-height:min\(680px,calc\(100vh - 300px\)\)/);
  assert.match(text, /CodexSplit 不展示 Token/);
  assert.match(text, /chatgpt-account-rotation-row/);
  assert.match(text, /chatgpt-account-rotation-row input\[type=checkbox\]/);
  assert.match(text, /control\.disabled=unavailable/);
  assert.match(text, /save\.disabled=unavailable/);
  assert.match(text, /maxAttempts=expectedMode==='bridge'\?120:60/);
  assert.match(text, /desiredMode=before\.desired_mode\|\|before\.launch_mode\|\|before\.mode_preference/);
  assert.match(text, /q\('\[data-view="chatgpt-accounts"\]'\)\.onclick=function\(\)\{openView\('chatgpt-accounts'\)\}/);
  assert.doesNotMatch(text, /chatgpt-account-sticky/);
  assert.doesNotMatch(text, /sticky_sessions/);
  assert.doesNotMatch(text, /已有会话保持账号绑定|会话迁移时才切换账号/);
});
