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

export interface ProviderConfig {
  name: string;
  type?: string;
  preset_id?: string;
  baseUrl: string;
  api_key_env?: string;
  api_key?: string;
  models?: string[];
  /** Protocol preference per configured model. Unset entries default to Chat. */
  model_protocols?: Record<string, "chat" | "responses">;
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
  image_generation_mode?: "native_responses" | "none";
  supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
  default_reasoning_level?: string;
  reasoning?: boolean;
}
