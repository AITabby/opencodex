/**
 * CodexBridge Core Types (OpenCodex V2)
 * Clean, strict TypeScript interfaces for OpenAI Responses API and Chat Completions API.
 */

// ══════════════════════════════════════════════
// 1. OpenAI Responses API Types (/v1/responses)
// ══════════════════════════════════════════════

export type ResponseItemType =
  | "message"
  | "function_call"
  | "function_call_output"
  | "mcp_call"
  | "mcp_call_output"
  | "reasoning"
  | "compaction";

export interface ResponseImageContentPart {
  type: "input_image" | "output_image";
  image_url?: string;
  file_id?: string;
  detail?: "auto" | "low" | "high" | "original";
  annotations?: any[];
}

export type ResponseContentPart = ResponseTextContentPart | ResponseImageContentPart | Record<string, any>;

export interface ResponseTextContentPart {
  type: "input_text" | "output_text";
  text: string;
  annotations?: any[];
}

export interface ResponseMessageItem {
  id?: string;
  type?: "message";
  role: "developer" | "system" | "user" | "assistant";
  content?: string | ResponseContentPart[];
  phase?: "commentary" | "final_answer";
  internal_chat_message_metadata_passthrough?: Record<string, any>;
}

export interface ResponseFunctionCallItem {
  id?: string;
  type: "function_call";
  status?: "in_progress" | "completed";
  call_id: string;
  name: string;
  namespace?: string;
  arguments: string;
}

export interface ResponseFunctionCallOutputItem {
  id?: string;
  type: "function_call_output";
  call_id: string;
  output: string | ResponseContentPart[];
}

export interface ResponseMcpCallItem {
  id?: string;
  type: "mcp_call";
  status?: "in_progress" | "calling" | "completed" | "incomplete" | "failed";
  server_label: string;
  name: string;
  arguments: string;
  output?: string | ResponseContentPart[];
  error?: string;
}

/** Client-side MCP continuations may use this explicit output item shape. */
export interface ResponseMcpCallOutputItem {
  id?: string;
  type: "mcp_call_output";
  call_id?: string;
  output: string | ResponseContentPart[];
}

/** Native Computer Use clients may keep the tool pair under these types. */
export interface ResponseComputerCallItem {
  id?: string;
  type: "computer_call";
  call_id?: string;
  action?: Record<string, any>;
  arguments?: string | Record<string, any>;
  output?: string | ResponseContentPart[] | Record<string, any>;
}

export interface ResponseComputerCallOutputItem {
  id?: string;
  type: "computer_call_output";
  call_id?: string;
  output: string | ResponseContentPart[] | Record<string, any>;
}

export interface ResponseReasoningItem {
  id?: string;
  type: "reasoning";
  status?: "in_progress" | "completed";
  summary?: Array<{ type: "summary_text"; text: string }>;
  encrypted_content?: string | null;
}

export interface ResponseCompactionItem {
  id?: string;
  type: "compaction";
  encrypted_content: string;
}

export type ResponseInputItem =
  | ResponseMessageItem
  | ResponseFunctionCallItem
  | ResponseFunctionCallOutputItem
  | ResponseMcpCallItem
  | ResponseMcpCallOutputItem
  | ResponseComputerCallItem
  | ResponseComputerCallOutputItem
  | ResponseReasoningItem
  | ResponseCompactionItem
  | string;

export interface ResponseToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
  strict?: boolean;
}

export type ResponseTool =
  | {
      type: "function";
      name?: string;
      description?: string;
      parameters?: Record<string, any>;
      function?: ResponseToolFunction;
    }
  | {
      type: "namespace";
      name?: string;
      functions?: ResponseToolFunction[];
      tools?: ResponseToolFunction[];
    }
  | {
      type: "image_generation";
      model?: string;
      quality?: string;
      size?: string;
      background?: string;
      partial_images?: number;
    }
  | {
      type: "computer" | "computer_use_preview";
      display_width?: number;
      display_height?: number;
      environment?: "browser" | "computer";
    }
  | {
      name: string;
      description?: string;
      parameters?: Record<string, any>;
    };

export interface ResponsesRequestBody {
  model: string;
  instructions?: string;
  input?: ResponseInputItem[];
  tools?: ResponseTool[];
  tool_choice?: any;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  parallel_tool_calls?: boolean;
  reasoning?: { effort?: string };
  reasoning_effort?: string;
  client_metadata?: Record<string, any>;
}

// ══════════════════════════════════════════════
// 2. OpenAI Chat Completions Types (/v1/chat/completions)
// ══════════════════════════════════════════════

export interface ChatFunctionCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | any[];
  name?: string;
  tool_calls?: ChatFunctionCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  _reasoning_only?: boolean;
  summary?: any[];
}

export interface ChatTool {
  type: "function";
  function: ResponseToolFunction;
}

export interface ChatCompletionRequestBody {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: any;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  parallel_tool_calls?: boolean;
  reasoning_effort?: string;
  stream_options?: { include_usage?: boolean; [key: string]: any };
}

// ══════════════════════════════════════════════
// 3. Provider & Model Architecture Types
// ══════════════════════════════════════════════

export type ProviderPoolMode = "fixed" | "round_robin" | "failover";

export type ProviderCredentialStatus = "unknown" | "ready" | "expired" | "failed" | "cooldown" | "missing";

export interface ProviderModelTestState {
  status: "untested" | "connected" | "failed" | "simulated";
  tested_at?: string;
  message?: string;
  protocol?: "chat" | "responses";
}

/**
 * Metadata for one API-key credential. The secret itself is never persisted
 * here; credential_ref points at the macOS Keychain entry.
 */
export interface ProviderCredential {
  id: string;
  label?: string;
  credential_ref: string;
  status?: ProviderCredentialStatus;
  status_message?: string;
  status_code?: number;
  failure_count?: number;
  cooldown_until?: string;
  last_checked_at?: string;
  last_used_at?: string;
  created_at?: string;
}

export interface ProviderConfig {
  name: string;
  type?: string;
  preset_id?: string;
  /** Explicit payload adapter for providers that share an OpenAI endpoint shape. */
  adapter?: "openai" | "deepseek" | "minimax" | "anthropic" | "google";
  baseUrl: string;
  api_key_env?: string;
  api_key?: string;
  /** Legacy single-Keychain reference retained for migration compatibility. */
  credential_ref?: string;
  /** Multiple API-key credentials for this provider; secrets stay in Keychain. */
  credentials?: ProviderCredential[];
  pool_mode?: ProviderPoolMode;
  active_credential_id?: string;
  models?: string[];
  /** Protocol preference per configured model. Unset entries default to Chat. */
  model_protocols?: Record<string, "chat" | "responses">;
  /** Last explicit connectivity result per backend model id. */
  model_test_status?: Record<string, ProviderModelTestState>;
  /**
   * Metadata learned from the provider /models response or a model registry.
   * Keys are the provider's backend model ids, not UI aliases.
   */
  model_metadata?: Record<string, {
    context_window?: number;
    max_context_window?: number;
    context_window_source?: "provider_metadata" | "model_registry" | "unknown";
    supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
    reasoning?: boolean;
    supports_vision?: boolean;
    default_reasoning_level?: string;
    metadata_source?: string;
    metadata_updated_at?: string;
  }>;
  headers?: Record<string, string>;
  /** Connection testing is explicit; configuration alone must not imply success. */
  last_test_status?: "untested" | "connected" | "failed" | "simulated";
  last_test_at?: string;
  last_test_message?: string;
}

export interface CatalogModelEntry {
  slug: string;
  model: string;
  display_name?: string;
  backend_model?: string;
  backend_provider?: string;
  adapter?: "openai" | "deepseek" | "minimax" | "anthropic" | "google";
  protocol?: "chat" | "responses";
  backend_protocol?: "chat" | "responses";
  provider?: string;
  description?: string;
  context_window?: number;
  max_context_window?: number;
  context_window_source?: "provider_metadata" | "model_registry" | "unknown";
  context_window_confidence?: "exact" | "unknown";
  vision_bridge_enabled?: boolean;
  supports_image_generation?: boolean;
  image_generation_mode?: "native_images" | "none";
  supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
  default_reasoning_level?: string;
  reasoning?: boolean;
}
