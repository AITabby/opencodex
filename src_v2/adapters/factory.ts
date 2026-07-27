/**
 * Protocol Adapter Factory for CodexBridge (OpenCodex V2)
 * 100% Generic Protocol Selection with ZERO Hardcoded Provider Names or Domain Names.
 * Protocol is determined purely by explicit protocol spec or URL endpoint path format.
 */

import { ProtocolAdapter } from "./base.js";
import { OpenAiAdapter } from "./openai.js";
import { AnthropicAdapter } from "./anthropic.js";
import { GoogleGeminiAdapter } from "./google.js";

export class AdapterFactory {
  private static openAiAdapter = new OpenAiAdapter();
  private static anthropicAdapter = new AnthropicAdapter();
  private static googleAdapter = new GoogleGeminiAdapter();

  public static getAdapter(protocol?: string, providerUrl?: string): ProtocolAdapter {
    const p = (protocol || "").toLowerCase();
    const url = (providerUrl || "").toLowerCase();

    // 1. Explicit Anthropic Messages Protocol
    if (p === "anthropic" || url.endsWith("/v1/messages") || url.endsWith("/messages")) {
      return AdapterFactory.anthropicAdapter;
    }

    // 2. Explicit Google Gemini Native Protocol
    if (p === "google" || p === "gemini" || url.includes(":generatecontent") || url.includes(":streamgeneratecontent")) {
      return AdapterFactory.googleAdapter;
    }

    // 3. Standard OpenAI-compatible Chat Protocol (Default for ALL providers)
    return AdapterFactory.openAiAdapter;
  }
}
