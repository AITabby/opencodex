/**
 * DeepSeek Adapter for CodexBridge (OpenCodex V2)
 */

import { ProtocolAdapter } from "./base.js";
import { ChatMessage, ChatCompletionRequestBody } from "../core/types.js";

export class DeepSeekModelAdapter implements ProtocolAdapter {
  public name = "deepseek";

  public sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(m => {
      const copy = { ...m };
      if (!copy.content && copy.role === "assistant" && copy.tool_calls && copy.tool_calls.length > 0) {
        copy.content = "";
      }
      return copy;
    });
  }

  public transformPayload(chatBody: ChatCompletionRequestBody): {
    urlEndpoint: string;
    headers: Record<string, string>;
    body: any;
  } {
    return {
      urlEndpoint: "",
      headers: { "Content-Type": "application/json" },
      body: chatBody,
    };
  }
}
