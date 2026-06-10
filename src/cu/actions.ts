/**
 * OpenCodex Operating System Action Performer
 * Performs mouse clicks, smooth drags, scroll events, keyboard typing, key presses,
 * and window management (list and focus) using macOS-native Swift CGEvent APIs.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WindowInfo {
  id: number;
  title: string;
  app: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export class ActionPerformer {
  // ─── Mouse Actions ───

  async click(x: number, y: number, button = "left", clicks = 1) {
    for (let i = 0; i < clicks; i++) {
      this.run("click", [String(x), String(y), button === "right" ? "right" : "left"]);
    }
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number) {
    this.run("drag", [String(fromX), String(fromY), String(toX), String(toY)]);
  }

  async scroll(x: number, y: number, deltaX: number, deltaY: number) {
    this.run("scroll", [String(x), String(y), String(deltaX), String(deltaY)]);
  }

  async mouseDown(x: number, y: number, button = "left") {
    this.run("mouse_down", [String(x), String(y), button === "right" ? "right" : "left"]);
  }

  async mouseUp(x: number, y: number, button = "left") {
    this.run("mouse_up", [String(x), String(y), button === "right" ? "right" : "left"]);
  }

  async mouseMove(x: number, y: number, drag = false) {
    this.run("mouse_move", [String(x), String(y), String(drag)]);
  }

  // ─── Keyboard Actions ───

  async typeText(text: string) {
    this.run("type", [text]);
  }

  async pressKey(key: string) {
    this.run("key", [key]);
  }

  async pageScroll(direction: string, pages = 1) {
    const k = direction === "down" ? "page_down" : "page_up";
    for (let i = 0; i < pages; i++) {
      this.run("key", [k]);
    }
  }

  // ─── Window Management ───

  async getWindows(): Promise<WindowInfo[]> {
    const out = this.run("windows", []);
    return JSON.parse(out);
  }

  async focusWindow(windowId: number) {
    this.run("focus", [String(windowId)]);
  }

  // ─── Script Execution Engine ───

  private run(action: string, args: string[]): string {
    const script = this.getScript(action, args);
    const scriptPath = join(tmpdir(), `oc-act-${Date.now()}.swift`);
    try {
      writeFileSync(scriptPath, script, "utf-8");
      const r = spawnSync("/usr/bin/swift", [scriptPath], { timeout: 15000, encoding: "utf-8" });
      if (r.status !== 0) {
        const errorMsg = (r.stderr || r.stdout || "Unknown execution error").trim().split("\n").slice(0, 3).join(" | ");
        throw new Error(`Swift Execution Failed: ${errorMsg}`);
      }
      return r.stdout?.trim() || "";
    } finally {
      try { unlinkSync(scriptPath); } catch {}
    }
  }

  private getScript(action: string, a: string[]): string {
    const esc = (s: string) => s.replace(/"/g, '\\"').replace(/\\/g, "\\\\");

    switch (action) {
      case "click": {
        const [x, y, b] = a;
        const isRight = b === "right";
        return [
          "import Cocoa",
          `let p = CGPoint(x: ${x}, y: ${y})`,
          `let btn: CGMouseButton = ${isRight ? ".right" : ".left"}`,
          `CGEvent(mouseEventSource: nil, mouseType: ${isRight ? ".rightMouseDown" : ".leftMouseDown"}, mouseCursorPosition: p, mouseButton: btn)!.post(tap: .cghidEventTap)`,
          `CGEvent(mouseEventSource: nil, mouseType: ${isRight ? ".rightMouseUp" : ".leftMouseUp"}, mouseCursorPosition: p, mouseButton: btn)!.post(tap: .cghidEventTap)`,
        ].join("\n");
      }

      case "mouse_down": {
        const [x, y, b] = a;
        const isRight = b === "right";
        return [
          "import Cocoa",
          `let p = CGPoint(x: ${x}, y: ${y})`,
          `let btn: CGMouseButton = ${isRight ? ".right" : ".left"}`,
          `CGEvent(mouseEventSource: nil, mouseType: ${isRight ? ".rightMouseDown" : ".leftMouseDown"}, mouseCursorPosition: p, mouseButton: btn)!.post(tap: .cghidEventTap)`,
        ].join("\n");
      }

      case "mouse_up": {
        const [x, y, b] = a;
        const isRight = b === "right";
        return [
          "import Cocoa",
          `let p = CGPoint(x: ${x}, y: ${y})`,
          `let btn: CGMouseButton = ${isRight ? ".right" : ".left"}`,
          `CGEvent(mouseEventSource: nil, mouseType: ${isRight ? ".rightMouseUp" : ".leftMouseUp"}, mouseCursorPosition: p, mouseButton: btn)!.post(tap: .cghidEventTap)`,
        ].join("\n");
      }

      case "mouse_move": {
        const [x, y, drag] = a;
        const isDrag = drag === "true";
        return [
          "import Cocoa",
          `let p = CGPoint(x: ${x}, y: ${y})`,
          `let ev = CGEvent(mouseEventSource: nil, mouseType: ${isDrag ? ".leftMouseDragged" : ".mouseMoved"}, mouseCursorPosition: p, mouseButton: .left)!`,
          "ev.post(tap: .cghidEventTap)",
        ].join("\n");
      }

      case "drag": {
        const [fx, fy, tx, ty] = a;
        return [
          "import Cocoa",
          `let from = CGPoint(x: ${fx}, y: ${fy})`,
          `let to   = CGPoint(x: ${tx}, y: ${ty})`,
          "CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left)!.post(tap: .cghidEventTap)",
          "let steps = 20",
          "for i in 1...steps {",
          "  let t = Double(i) / Double(steps)",
          "  let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)",
          "  CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left)!.post(tap: .cghidEventTap)",
          "  Thread.sleep(forTimeInterval: 0.01)",
          "}",
          "CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left)!.post(tap: .cghidEventTap)",
        ].join("\n");
      }

      case "scroll": {
        const [x, y, dx, dy] = a;
        return [
          "import Cocoa",
          `let p = CGPoint(x: ${x}, y: ${y})`,
          `let ev = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: Int32(${dy}), wheel2: Int32(${dx}), wheel3: 0)!`,
          "ev.post(tap: .cghidEventTap)",
        ].join("\n");
      }

      case "type": {
        const t = esc(a[0]);
        return [
          "import Cocoa",
          "let src = CGEventSource(stateID: .combinedSessionState)",
          `for ch in "${t}".utf16 {`,
          "  var c = ch",
          "  let ev = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)!",
          "  ev.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c)",
          "  ev.post(tap: .cghidEventTap)",
          "  CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)!.post(tap: .cghidEventTap)",
          "}",
        ].join("\n");
      }

      case "key": {
        const k = a[0];
        const K: Record<string, number> = {
          return: 36, enter: 36, tab: 48, escape: 53, esc: 53, space: 49, backspace: 51, delete: 51,
          up: 126, down: 125, left: 123, right: 124, home: 115, end: 119, page_up: 116, page_down: 121,
          a: 0, b: 11, c: 8, d: 2, e: 14, f: 3, g: 5, h: 4, i: 34, j: 38, k: 40, l: 37, m: 46, n: 45,
          o: 31, p: 35, q: 12, r: 15, s: 1, t: 17, u: 32, v: 9, w: 13, x: 7, y: 16, z: 6,
          "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 22, "6": 23, "7": 24, "8": 25, "9": 26,
        };
        if (k === "page_down" || k === "page_up") {
          const c = k === "page_down" ? 121 : 116;
          return `import Cocoa\nlet src = CGEventSource(stateID: .combinedSessionState)\nCGEvent(keyboardEventSource: src, virtualKey: ${c}, keyDown: true)!.post(tap: .cghidEventTap)\nCGEvent(keyboardEventSource: src, virtualKey: ${c}, keyDown: false)!.post(tap: .cghidEventTap)`;
        }
        const parts = k.toLowerCase().split("+");
        const lk = parts[parts.length - 1];
        const ms = parts.slice(0, -1);
        const kc = K[lk] ?? 0;
        const flags: string[] = [];
        if (ms.includes("cmd") || ms.includes("command")) flags.push(".maskCommand");
        if (ms.includes("ctrl") || ms.includes("control")) flags.push(".maskControl");
        if (ms.includes("alt") || ms.includes("option")) flags.push(".maskAlternate");
        if (ms.includes("shift")) flags.push(".maskShift");

        if (flags.length > 0) {
          return [
            "import Cocoa",
            "let src = CGEventSource(stateID: .combinedSessionState)",
            `let d = CGEvent(keyboardEventSource: src, virtualKey: ${kc}, keyDown: true)!`,
            `d.flags = [${flags.join(", ")}]`,
            "d.post(tap: .cghidEventTap)",
            `CGEvent(keyboardEventSource: src, virtualKey: ${kc}, keyDown: false)!.post(tap: .cghidEventTap)`,
          ].join("\n");
        }
        return [
          "import Cocoa",
          "let src = CGEventSource(stateID: .combinedSessionState)",
          `CGEvent(keyboardEventSource: src, virtualKey: ${kc}, keyDown: true)!.post(tap: .cghidEventTap)`,
          `CGEvent(keyboardEventSource: src, virtualKey: ${kc}, keyDown: false)!.post(tap: .cghidEventTap)`,
        ].join("\n");
      }

      case "windows": {
        return [
          'import Cocoa',
          'let list = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as! [[String: Any]]',
          'let filtered = list.filter { $0["kCGWindowLayer"] as? Int == 0 && $0["kCGWindowOwnerName"] != nil }',
          'let json = filtered.map { w -> [String: Any] in',
          '  let bounds = w["kCGWindowBounds"] as? [String: Double] ?? [:]',
          '  return [',
          '    "id": w["kCGWindowNumber"] as? Int ?? 0,',
          '    "title": w["kCGWindowName"] as? String ?? "",',
          '    "app": w["kCGWindowOwnerName"] as? String ?? "",',
          '    "x": bounds["X"] ?? 0,',
          '    "y": bounds["Y"] ?? 0,',
          '    "width": bounds["Width"] ?? 0,',
          '    "height": bounds["Height"] ?? 0,',
          '  ]',
          '}',
          'if let d = try? JSONSerialization.data(withJSONObject: json, options: []),',
          '   let s = String(data: d, encoding: .utf8) { print(s) }',
        ].join("\n");
      }

      case "focus": {
        const [wid] = a;
        return [
          "import Cocoa",
          `let list = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as! [[String: Any]]`,
          `let target = list.first { $0["kCGWindowNumber"] as? Int == ${wid} }`,
          `if let t = target,`,
          `   let pid = t["kCGWindowOwnerPID"] as? Int,`,
          `   let app = NSRunningApplication(processIdentifier: pid_t(pid)) {`,
          `  app.activate(options: .activateIgnoringOtherApps)`,
          `}`,
        ].join("\n");
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }
}
