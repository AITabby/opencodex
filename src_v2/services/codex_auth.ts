import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type CodexChatGptAuth = {
  accessToken: string;
  accountId: string;
};

export function readCodexChatGptAuth(
  authPath = path.join(os.homedir(), ".codex", "auth.json")
): CodexChatGptAuth | null {
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    const accessToken = String(auth?.tokens?.access_token || "").trim();
    const accountId = String(auth?.tokens?.account_id || "").trim();
    if (!accessToken) return null;
    return { accessToken, accountId };
  } catch {
    return null;
  }
}

export function applyCodexChatGptAuthHeaders(
  headers: Record<string, string>,
  auth: CodexChatGptAuth
): Record<string, string> {
  const authenticated = { ...headers };
  authenticated.authorization = `Bearer ${auth.accessToken}`;
  if (auth.accountId) authenticated["chatgpt-account-id"] = auth.accountId;
  else delete authenticated["chatgpt-account-id"];
  return authenticated;
}
