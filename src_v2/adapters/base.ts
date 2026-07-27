/**
 * Base Protocol Adapter Interface for CodexBridge (OpenCodex V2)
 */

import { ChatMessage, ChatTool, ChatCompletionRequestBody } from "../core/types.js";

export interface ProtocolAdapter {
  name: string;
  sanitizeMessages(messages: ChatMessage[]): ChatMessage[];
  transformPayload(chatBody: ChatCompletionRequestBody): {
    urlEndpoint: string;
    headers: Record<string, string>;
    body: any;
  };
  processStreamChunk?(eventData: any): any[];
}

