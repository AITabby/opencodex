/**
 * OpenCodex — Main Entrypoint
 * Unifies the Model Context Protocol (MCP) Computer Use Tools
 * and the Responses HTTP Proxy Gateway.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";

import { ProxyServer } from "./proxy/index.js";
import { ScreenshotTaker } from "./cu/screenshot.js";
import { ActionPerformer } from "./cu/actions.js";
import { execSync } from "node:child_process";

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
  }
];

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
          return {
            content: [
              { type: "image", data: png.toString("base64"), mimeType: "image/png" },
              { type: "text", text: `截图完成 (${(png.length / 1024).toFixed(0)} KB)` }
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
        case "focus_window": {
          const { window_id } = args as any;
          await this.actionPerformer.focusWindow(window_id);
          return { content: [{ type: "text", text: `已将焦点切换至窗口 #${window_id}` }] };
        }
        default:
          throw new Error(`未知工具: ${name}`);
      }
    });
  }

  async start() {
    this.proxy.start(8765);
    const url = "http://localhost:8765/dashboard";
    console.log(`[OpenCodex] Dashboard → ${url}`);
    try {
      execSync(`open "${url}"`, { timeout: 3000 });
    } catch {}
    const transport = new StdioServerTransport();
    await this.mcp.connect(transport);
    console.log("[OpenCodex] MCP Server connected and ready.");
  }
}

new OpenCodex().start().catch((err) => {
  console.error("[OpenCodex] Failed to start:", err);
  process.exit(1);
});
