/**
 * Protocol Adapter Factory for CodexBridge (OpenCodex V2)
 * Protocol is selected from explicit provider metadata first, then from the
 * protocol spec or URL endpoint path. The fallback remains OpenAI-compatible.
 */

import { ProtocolAdapter } from "./base.js";
import { OpenAiAdapter } from "./openai.js";
import { AnthropicAdapter } from "./anthropic.js";
import { GoogleGeminiAdapter } from "./google.js";
import { DeepSeekModelAdapter } from "./deepseek.js";
import { MiniMaxModelAdapter } from "./minimax.js";

export class AdapterFactory {
  private static openAiAdapter = new OpenAiAdapter();
  private static anthropicAdapter = new AnthropicAdapter();
  private static googleAdapter = new GoogleGeminiAdapter();
  private static deepSeekAdapter = new DeepSeekModelAdapter();
  private static miniMaxAdapter = new MiniMaxModelAdapter();

  public static getAdapter(protocol?: string, providerUrl?: string, adapterName?: string): ProtocolAdapter {
    const p = (protocol || "").toLowerCase();
    const url = (providerUrl || "").toLowerCase();
    const explicit = (adapterName || "").trim().toLowerCase();

    if (explicit === "deepseek") return AdapterFactory.deepSeekAdapter;
    if (explicit === "minimax") return AdapterFactory.miniMaxAdapter;
    if (explicit === "anthropic") return AdapterFactory.anthropicAdapter;
    if (explicit === "google" || explicit === "gemini") return AdapterFactory.googleAdapter;
    if (explicit === "openai") return AdapterFactory.openAiAdapter;

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
