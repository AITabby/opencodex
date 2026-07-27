/**
 * OpenAI Chat Completions Adapter for OpenCode, DeepSeek, Grok, MiniMax, OpenAI
 */

import { ProtocolAdapter } from "./base.js";
import { ChatMessage, ChatCompletionRequestBody } from "../core/types.js";

export class OpenAiAdapter implements ProtocolAdapter {
  public name = "openai";

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
