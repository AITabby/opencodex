export type SubscriptionTransportId = "antigravity" | "grok" | "claude" | "cursor";

export interface SubscriptionTransport {
  id: SubscriptionTransportId;
  endpoint: string;
  modelsEndpoint?: string;
  apiKeySentinel: string;
  apiKeyPrefix?: string;
}

/**
 * First-party subscription transports are explicit runtime capabilities, not
 * inferred from arbitrary endpoint substrings. API-key providers stay on the
 * ordinary configured endpoint unless their provider identity selects one of
 * these subscription entries.
 */
export const SUBSCRIPTION_TRANSPORTS: Record<SubscriptionTransportId, SubscriptionTransport> = {
  antigravity: {
    id: "antigravity",
    endpoint: "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    modelsEndpoint: "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    apiKeySentinel: "antigravity-cli-auto",
    apiKeyPrefix: "AIzaSy",
  },
  grok: {
    id: "grok",
    endpoint: "https://api.x.ai/v1/chat/completions",
    apiKeySentinel: "grok-cli-auto",
    apiKeyPrefix: "xai-",
  },
  claude: {
    id: "claude",
    endpoint: "https://api.anthropic.com/v1/messages",
    apiKeySentinel: "claude-cli-auto",
    apiKeyPrefix: "sk-ant-",
  },
  cursor: {
    id: "cursor",
    endpoint: "https://agent.api5.cursor.sh/agent.v1.AgentService/Run",
    modelsEndpoint: "https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels",
    apiKeySentinel: "cursor-cli-auto",
  },
};

export function resolveSubscriptionTransport(providerName: string, apiKey: string): SubscriptionTransport | null {
  const normalizedName = String(providerName || "").trim().toLowerCase() as SubscriptionTransportId;
  const transport = SUBSCRIPTION_TRANSPORTS[normalizedName];
  if (!transport) return null;
  const key = String(apiKey || "");
  if (key && key !== transport.apiKeySentinel && transport.apiKeyPrefix && key.startsWith(transport.apiKeyPrefix)) return null;
  return transport;
}
