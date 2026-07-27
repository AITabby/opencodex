import http from "node:http";
import { ResponsesStreamEngine } from "../core/stream_engine.js";
import { transformResponsesToChat } from "../core/transformer.js";
import { AdapterFactory } from "../adapters/factory.js";
import { GoogleGeminiAdapter } from "../adapters/google.js";
import { SubscriptionAuthService } from "../services/subscription_auth.js";

export class GatewayRouter {
  public async handleResponses(
    reqBody: any,
    upstreamModel: string,
    apiKey: string,
    providerUrl: string,
    res: http.ServerResponse,
    providerName = ""
  ): Promise<void> {
    const sessionId = reqBody?.client_metadata?.session_id || reqBody?.session_id;
    const chatBody = transformResponsesToChat(reqBody, upstreamModel, sessionId);
    chatBody.stream = true;

    const adapter = AdapterFactory.getAdapter(reqBody?.protocol, providerUrl);
    const { urlEndpoint, headers: adapterHeaders, body: payloadBody } = adapter.transformPayload(chatBody);

    const targetUrl = (urlEndpoint && !providerUrl.endsWith(urlEndpoint))
      ? `${providerUrl.replace(/\/$/, "")}${urlEndpoint}`
      : providerUrl;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...adapterHeaders,
    };

    // Clean V2 Antigravity Subscription Routing
    const isAntigravityModel = (
      providerName.toLowerCase() === "antigravity" ||
      apiKey === "antigravity-cli-auto" ||
      providerUrl.includes("antigravity") ||
      providerUrl.includes("generativelanguage")
    ) && !apiKey.startsWith("AIzaSy");

    let finalTargetUrl = targetUrl;
    let finalHeaders = { ...headers };
    let finalPayloadBody = payloadBody;

    let activeAdapter = adapter;

    if (isAntigravityModel) {
      const oauthToken = await SubscriptionAuthService.getAntigravityAccessToken();

      console.log(`[OpenCodex V2] Antigravity token resolved: ${Boolean(oauthToken)}`);

      if (oauthToken) {
        finalTargetUrl = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
        finalHeaders["Authorization"] = `Bearer ${oauthToken}`;
        finalHeaders["User-Agent"] = "antigravity/hub/2.2.1 darwin/arm64";

        activeAdapter = new GoogleGeminiAdapter();
        const geminiPayload = activeAdapter.transformPayload(chatBody).body;

        finalPayloadBody = {
          project: "default-cli-project",
          model: upstreamModel,
          request: geminiPayload
        };
      }
    }

    // Grok Subscription Routing
    const isGrokModel = (
      providerName.toLowerCase() === "grok" ||
      apiKey === "grok-cli-auto" ||
      providerUrl.includes("x.ai")
    ) && !apiKey.startsWith("xai-") && !isAntigravityModel;

    if (isGrokModel) {
      const grokToken = await SubscriptionAuthService.getGrokAccessToken();
      if (grokToken) {
        finalHeaders["Authorization"] = `Bearer ${grokToken}`;
        finalHeaders["User-Agent"] = "grok-cli/1.89.0";
        if (!providerUrl || providerUrl.includes("generativelanguage")) {
          finalTargetUrl = "https://api.x.ai/v1/chat/completions";
        }
      }
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.socket?.setNoDelay(true);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 600000);

    const writeSse = async (payload: any) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };

    const engine = new ResponsesStreamEngine(upstreamModel, reqBody?.client_metadata?.turn_id);

    try {
      let response = await fetch(finalTargetUrl, {
        method: "POST",
        headers: finalHeaders,
        body: JSON.stringify(finalPayloadBody),
        signal: controller.signal,
      });

      // A provider can rotate/revoke a token before its advertised expiry.
      // Refresh once and retry the same request; never route to another
      // provider as an implicit fallback.
      let firstAuthErrorText: string | undefined;
      if ((isGrokModel || isAntigravityModel) && (response.status === 401 || response.status === 403)) {
        firstAuthErrorText = await response.text();
        const refreshedToken = isGrokModel
          ? await SubscriptionAuthService.getGrokAccessToken(true)
          : await SubscriptionAuthService.getAntigravityAccessToken(true);
        if (refreshedToken) {
          finalHeaders["Authorization"] = `Bearer ${refreshedToken}`;
          response = await fetch(finalTargetUrl, {
            method: "POST",
            headers: finalHeaders,
            body: JSON.stringify(finalPayloadBody),
            signal: controller.signal,
          });
        }
      }

      clearTimeout(timeoutId);

      if (!response.ok || !response.body) {
        const errText = firstAuthErrorText && (response.status === 401 || response.status === 403)
          ? firstAuthErrorText
          : await response.text();
        console.error(`[CodexBridge V2] Upstream error (${response.status}) for ${finalTargetUrl}: ${errText}`);
        let msg = `Upstream API Error (${response.status})`;
        try {
          const parsed = JSON.parse(errText);
          msg = parsed.error?.message || parsed.error || parsed.message || errText || msg;
        } catch {
          msg = errText || msg;
        }

        if (isGrokModel && (response.status === 401 || response.status === 403 || errText.includes("Incorrect API key") || errText.includes("bad-credentials"))) {
          msg = "Grok 本机登录凭证已失效/撤销，请在终端运行 \"grok login\" 重新登录，或在 OpenCodex 控制面板保存 x.AI API Key。";
        }

        await engine.start(writeSse);
        await writeSse({
          type: "response.output_item.added",
          response_id: engine.getResponseId(),
          output_index: 0,
          item: {
            id: `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: `⚠️ ${msg}` }]
          }
        });
        await engine.finish(writeSse);
        res.end();
        return;
      }

      await engine.start(writeSse);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const readWithTimeout = (timeoutMs = 600000): Promise<ReadableStreamReadResult<Uint8Array>> => {
        return Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Stream read timeout (600s)")), timeoutMs)
          ),
        ]);
      };

      while (true) {
        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await readWithTimeout(600000);
        } catch (readErr: any) {
          console.warn(`[CodexBridge V2] ${readErr.message}; closing stream cleanly.`);
          break;
        }

        const { done, value } = readResult;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            const dataStr = trimmed.slice(6);
            if (dataStr === "[DONE]") continue;
            try {
              const chunk = JSON.parse(dataStr);
              if (activeAdapter.processStreamChunk) {
                const normalizedChunks = activeAdapter.processStreamChunk(chunk);
                for (const nc of normalizedChunks) {
                  await engine.processChatChunk(writeSse, nc);
                }
              } else {
                await engine.processChatChunk(writeSse, chunk);
              }
            } catch {
              // Ignore parse errors on individual chunk lines
            }
          }
        }
      }

      await engine.finish(writeSse);
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } catch (err: any) {
      clearTimeout(timeoutId);
      console.error(`[CodexBridge V2] Stream error for ${finalTargetUrl}:`, err.stack || err.message);
      const detailMsg = err.message === "fetch failed"
        ? `无法连接服务商接口 (${finalTargetUrl})：网络连接或 TLS 握手失败。请在 OpenCodex 控制面板检查该服务商 Endpoint / Base URL 是否填写正确。`
        : err.message;
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: detailMsg }));
      } else if (!res.writableEnded) {
        try { await engine.finish(writeSse); } catch {}
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  }
}
