/**
 * OpenCodex — Main Entrypoint
 * Unifies the Model Context Protocol (MCP) Computer Use Tools
 * and the Responses HTTP Proxy Gateway.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import dns from "node:dns";

dns.setDefaultResultOrder("ipv4first");

import { ProxyServer } from "./proxy/index.js";
import { ScreenshotTaker } from "./cu/screenshot.js";
import { ActionPerformer } from "./cu/actions.js";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";


const TOOLS: Tool[] = [
  {
    name: "screenshot",
    description: "截取当前屏幕，返回 PNG 图片。视觉模型可以直接看图识别元素位置。",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "click",
    description: "在屏幕坐标 (x, y) 处点击鼠标。替代 accessibility tree 的 element_index 方案。",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right"], default: "left" },
        clicks: { type: "number", default: 1 }
      },
      required: ["x", "y"]
    }
  },
  {
    name: "drag",
    description: "从起点拖拽到终点。用于滑动、拖拽文件、选中文本等。",
    inputSchema: {
      type: "object",
      properties: {
        from_x: { type: "number" },
        from_y: { type: "number" },
        to_x: { type: "number" },
        to_y: { type: "number" }
      },
      required: ["from_x", "from_y", "to_x", "to_y"]
    }
  },
  {
    name: "scroll",
    description: "滚轮滚动。delta_y 负值=向下滚动，正值=向上。可选指定滚动位置。",
    inputSchema: {
      type: "object",
      properties: {
        delta_x: { type: "number", default: 0 },
        delta_y: { type: "number", default: -3 },
        x: { type: "number", default: 0 },
        y: { type: "number", default: 0 }
      }
    }
  },
  {
    name: "page_scroll",
    description: "整页滚动（PageDown/PageUp 按键模拟）。",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["down", "up"] },
        pages: { type: "number", default: 1 }
      },
      required: ["direction"]
    }
  },
  {
    name: "type_text",
    description: "在当前聚焦的输入框中输入文本。",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"]
    }
  },
  {
    name: "press_key",
    description: "按下键盘快捷键。例如: cmd+l, Return, Tab, Escape, cmd+shift+p 等。",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"]
    }
  },
  {
    name: "get_windows",
    description: "获取所有可见窗口列表（ID、标题、所属 App、位置、尺寸）。",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "focus_window",
    description: "激活指定 ID 的窗口。先用 get_windows 获取窗口 ID。",
    inputSchema: {
      type: "object",
      properties: { window_id: { type: "number" } },
      required: ["window_id"]
    }
  },
  {
    name: "mouse_down",
    description: "按住鼠标（左键/右键）不放。配合 mouse_move 可以实现复杂的拖拽、圈选和画图操作。",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right"], default: "left" }
      },
      required: ["x", "y"]
    }
  },
  {
    name: "mouse_up",
    description: "释放鼠标（左键/右键）。配合 mouse_down 和 mouse_move 使用。",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right"], default: "left" }
      },
      required: ["x", "y"]
    }
  },
  {
    name: "mouse_move",
    description: "移动鼠标到屏幕坐标 (x, y) 处。可选择是否按住左键移动（拖拽/画图模式）。",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        drag: { type: "boolean", default: false }
      },
      required: ["x", "y"]
    }
  }
];

class CodexMCPClient {
  private process: any;
  private nextId = 1;
  private pendingRequests = new Map<number, (res: any) => void>();
  private stdoutBuffer = "";

  constructor(process: any) {
    this.process = process;
    this.setupStdout();
  }

  private setupStdout() {
    this.process.stdout.on("data", (data: any) => {
      this.stdoutBuffer += data.toString();
      let newlineIndex;
      while ((newlineIndex = this.stdoutBuffer.indexOf("\n")) !== -1) {
        const line = this.stdoutBuffer.substring(0, newlineIndex).trim();
        this.stdoutBuffer = this.stdoutBuffer.substring(newlineIndex + 1);
        if (line) {
          this.handleLine(line);
        }
      }
    });
  }

  private handleLine(line: string) {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
        const resolve = this.pendingRequests.get(msg.id);
        if (resolve) {
          this.pendingRequests.delete(msg.id);
          resolve(msg);
        }
      }
    } catch (e: any) {
      console.error("[CodexMCPClient] Parse line error:", e.message, line);
    }
  }

  private write(msg: any) {
    this.process.stdin.write(JSON.stringify(msg) + "\n");
  }

  public callCodex(prompt: string, threadId?: string): Promise<{ threadId: string; content: string }> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      let method = "tools/call";
      let params: any = {};
      
      if (threadId) {
        params = {
          name: "codex-reply",
          arguments: {
            threadId,
            prompt
          }
        };
      } else {
        params = {
          name: "codex",
          arguments: {
            prompt
          }
        };
      }

      const msg = {
        jsonrpc: "2.0",
        method,
        params,
        id
      };
      
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error("Timeout waiting for Codex MCP response"));
      }, 90000); // 90s timeout

      this.pendingRequests.set(id, (res: any) => {
        clearTimeout(timeout);
        if (res.error) {
          reject(new Error(res.error.message || "Unknown error"));
        } else {
          const result = res.result;
          if (result) {
            const struct = result.structuredContent;
            if (struct && typeof struct.threadId === "string" && typeof struct.content === "string") {
              resolve({ threadId: struct.threadId, content: struct.content });
              return;
            }
            if (typeof result.threadId === "string" && typeof result.content === "string") {
              resolve({ threadId: result.threadId, content: result.content });
              return;
            }
            if (Array.isArray(result.content)) {
              const text = result.content.map((c: any) => {
                if (typeof c === "object" && c !== null) {
                  return c.text || "";
                }
                return String(c);
              }).join("\n");
              resolve({ threadId: result.threadId || "", content: text });
              return;
            }
          }
          resolve({ threadId: "", content: "" });
        }
      });

      this.write(msg);
    });
  }
}

class OpenCodex {
  private mcp: Server;
  private proxy: ProxyServer;
  private screenshotTaker: ScreenshotTaker;
  private actionPerformer: ActionPerformer;

  constructor() {
    this.mcp = new Server({ name: "opencodex", version: "1.0.0" }, { capabilities: { tools: {} } });
    this.screenshotTaker = new ScreenshotTaker();
    this.actionPerformer = new ActionPerformer();
    this.proxy = new ProxyServer();
    this.setupMcpHandlers();
  }

  private setupMcpHandlers() {
    this.mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    this.mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args } = req.params;

      switch (name) {
        case "screenshot": {
          const png = await this.screenshotTaker.capture();
          const cachePath = path.join(os.tmpdir(), "opencodex_screenshot.png");
          fs.writeFileSync(cachePath, png);

          let desc = "";
          try {
            const { describeImageB64 } = await import("./proxy/translator.js");
            const b64 = png.toString("base64");
            const fetchedDesc = await describeImageB64(b64, this.proxy.config);
            if (fetchedDesc) {
              desc = fetchedDesc;
            }
          } catch (err: any) {
            console.error("[OpenCodex-ScreenshotTool] Direct describe image failed:", err.message);
          }

          const responseText = desc 
            ? `[截图描述: ${desc}]\n(本地缓存路径: ${cachePath})`
            : `[OpenCodexScreenshotCached: ${cachePath}] 截图完成 (${(png.length / 1024).toFixed(0)} KB)`;

          return {
            content: [
              { type: "text", text: responseText }
            ]
          };
        }
        case "click": {
          const { x, y, button = "left", clicks = 1 } = args as any;
          await this.actionPerformer.click(x, y, button, clicks);
          return { content: [{ type: "text", text: `已点击屏幕坐标 (${x}, ${y})` }] };
        }
        case "drag": {
          const { from_x, from_y, to_x, to_y } = args as any;
          await this.actionPerformer.drag(from_x, from_y, to_x, to_y);
          return { content: [{ type: "text", text: `已从 (${from_x}, ${from_y}) 拖拽至 (${to_x}, ${to_y})` }] };
        }
        case "scroll": {
          const { delta_x = 0, delta_y = -3, x = 0, y = 0 } = args as any;
          await this.actionPerformer.scroll(x, y, delta_x, delta_y);
          return { content: [{ type: "text", text: `已完成滚轮滚动 (dx=${delta_x}, dy=${delta_y})` }] };
        }
        case "page_scroll": {
          const { direction, pages = 1 } = args as any;
          await this.actionPerformer.pageScroll(direction, pages);
          return { content: [{ type: "text", text: `已${direction === "down" ? "向下" : "向上"}翻页 ${pages} 次` }] };
        }
        case "type_text": {
          const { text } = args as any;
          await this.actionPerformer.typeText(text);
          return { content: [{ type: "text", text: `已成功输入文本 (${text.length} 字符)` }] };
        }
        case "press_key": {
          const { key } = args as any;
          await this.actionPerformer.pressKey(key);
          return { content: [{ type: "text", text: `已按键: ${key}` }] };
        }
        case "get_windows": {
          const windows = await this.actionPerformer.getWindows();
          const lines = windows.map((w: any) => {
            return `  [${w.id}] ${w.app} - "${w.title}" (${w.x},${w.y}) ${w.width}x${w.height}`;
          });
          return { content: [{ type: "text", text: `共获取到 ${windows.length} 个可见窗口:\n${lines.join("\n")}` }] };
        }
        case "mouse_down": {
          const { x, y, button = "left" } = args as any;
          await this.actionPerformer.mouseDown(x, y, button);
          return { content: [{ type: "text", text: `已在 (${x}, ${y}) 按下鼠标 ${button} 键` }] };
        }
        case "mouse_up": {
          const { x, y, button = "left" } = args as any;
          await this.actionPerformer.mouseUp(x, y, button);
          return { content: [{ type: "text", text: `已在 (${x}, ${y}) 释放鼠标 ${button} 键` }] };
        }
        case "mouse_move": {
          const { x, y, drag = false } = args as any;
          await this.actionPerformer.mouseMove(x, y, drag);
          return { content: [{ type: "text", text: `已将鼠标移动至 (${x}, ${y})` + (drag ? " (拖拽模式)" : "") }] };
        }
        default:
          throw new Error(`未知工具: ${name}`);
      }
    });
  }

  private checkAndCleanupLogsDatabase() {
    try {
      const homeDir = os.homedir();
      const logsPath = path.join(homeDir, ".codex", "logs_2.sqlite");
      if (fs.existsSync(logsPath)) {
        const stats = fs.statSync(logsPath);
        const sizeMB = stats.size / (1024 * 1024);
        console.error(`[OpenCodex] Checking logs_2.sqlite size: ${sizeMB.toFixed(2)} MB`);
        if (sizeMB > 150) {
          console.error(`[OpenCodex] logs_2.sqlite size (${sizeMB.toFixed(2)} MB) exceeds 150MB threshold. Initiating auto-cleanup...`);
          const filesToDelete = [
            logsPath,
            `${logsPath}-wal`,
            `${logsPath}-shm`
          ];

          for (const f of filesToDelete) {
            if (fs.existsSync(f)) {
              fs.unlinkSync(f);
            }
          }
          console.error("[OpenCodex] Auto-cleanup complete. logs_2.sqlite has been successfully reset!");
        }
      }
    } catch (err: any) {
      console.error(`[OpenCodex] Error during logs_2.sqlite auto-cleanup:`, err.message);
    }
  }

  async start() {
    this.checkAndCleanupLogsDatabase();
    try {
      this.proxy.start(8765);
    } catch (err: any) {
      console.error(`[OpenCodex] Proxy server port conflict (could be running as a background daemon): ${err.message}`);
    }

    // Launch codex mcp-server in background via stdio transport
    try {
      console.error("[OpenCodex] Starting resident codex mcp-server background daemon...");
      const { spawn } = await import("node:child_process");
      let codexMcpBinary = "/Applications/ChatGPT.app/Contents/Resources/codex";
      if (os.platform() === "darwin") {
        if (!fs.existsSync(codexMcpBinary)) {
          codexMcpBinary = "/Applications/Codex.app/Contents/Resources/codex";
        }
      }

      const execServer = spawn(codexMcpBinary, [
        "--dangerously-bypass-approvals-and-sandbox",
        "mcp-server"
      ], {
        env: {
          ...process.env,
          HOME: os.homedir()
        }
      });

      execServer.stderr.on("data", (data) => {
        const line = data.toString().trim();
        if (line) {
          console.error(`[OpenCodex MCP-Server STDERR] ${line.split("\n")[0]}`);
        }
      });

      execServer.on("close", (code) => {
        console.error(`[OpenCodex] Background mcp-server exited with code ${code}`);
      });

      // Expose to proxy for voice session queries
      (this.proxy as any).execServerProcess = execServer;
      (this.proxy as any).codexMcpClient = new CodexMCPClient(execServer);
    } catch (e: any) {
      console.error("[OpenCodex] Failed to spawn background mcp-server:", e.message);
    }

    const url = "http://localhost:8765/dashboard";
    console.error(`[OpenCodex] Dashboard → ${url}`);
    // Commented out to prevent infinite browser tabs opening when MCP server restarts
    // try {
    //   execSync(`open "${url}"`, { timeout: 3000 });
    // } catch {}
    const transport = new StdioServerTransport();
    await this.mcp.connect(transport);
    console.error("[OpenCodex] MCP Server connected and ready.");
  }
}

export { OpenCodex };

import { fileURLToPath } from "node:url";

const isMain = process.argv[1] && (
  fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]) ||
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) ||
  process.argv[1].endsWith("server.js")
);

if (isMain) {
  new OpenCodex().start().catch((err) => {
    console.error("[OpenCodex] Failed to start:", err);
    process.exit(1);
  });
}
