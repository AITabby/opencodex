import { app, Tray, Menu, BrowserWindow, nativeImage } from "electron";
import { OpenCodex } from "./server.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure single instance lock to avoid port 8765 conflict
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log("[OpenCodex App] Another instance is already running. Exiting.");
  app.quit();
  process.exit(0);
}

let tray: Tray | null = null;
let serverInstance: OpenCodex | null = null;
let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

async function startServer() {
  try {
    console.log("[OpenCodex App] Booting OpenCodex Server...");
    serverInstance = new OpenCodex();
    await serverInstance.start();
    console.log("[OpenCodex App] OpenCodex Server started successfully.");
    
    // Once server is ready, reload the main dashboard window to show the control panel
    if (mainWindow) {
      mainWindow.loadURL("http://localhost:8765/dashboard");
    }
  } catch (err: any) {
    console.error("[OpenCodex App] Failed to start OpenCodex Server:", err);
  }
}

function showDashboard() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  console.log("[OpenCodex App] Creating main window...");
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "OpenCodex 控制台",
    show: true, // Show instantly on creation
    autoHideMenuBar: true, // Hide default File/Edit menu bar
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Load a simple inline loading message first to show instant feedback
  mainWindow.loadURL("data:text/html,<html><body style='background:#1e1e2e;color:#cdd6f4;font-family:sans-serif;display:flex;justify-content:center;align-serif;align-items:center;height:100vh;margin:0;'><h2>OpenCodex Loading...</h2></body></html>");

  // Instead of destroying the window on close, hide it to tray!
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createTray() {
  // Use a fallback empty image if a custom icon is not present
  let iconPath = path.join(__dirname, "..", "assets", "icon.png");
  let trayImage = nativeImage.createFromPath(iconPath);
  
  if (trayImage.isEmpty()) {
    const buffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVR42mP8z8BAP2AEYgYgZgBiBiBmAGIGIGYAYgYgZgBiBiBmAGIGIGYAYgYgZgBgYAD74w9+V5vN1QAAAABJRU5ErkJggg==",
      "base64"
    );
    trayImage = nativeImage.createFromBuffer(buffer);
  }

  tray = new Tray(trayImage);
  tray.setToolTip("OpenCodex 代理服务");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "显示控制台 (Show Console)",
      click: () => {
        showDashboard();
      }
    },
    { type: "separator" },
    {
      label: "重启 Codex (Restart Codex)",
      click: async () => {
        if (serverInstance && (serverInstance as any).proxy) {
          console.log("[OpenCodex App] Triggering Codex restart...");
          (serverInstance as any).proxy.restartCodexDesktop();
        }
      }
    },
    {
      label: "还原官方状态 (Restore Native)",
      click: async () => {
        if (serverInstance && (serverInstance as any).proxy) {
          console.log("[OpenCodex App] Restoring config to original official state...");
          (serverInstance as any).proxy.restoreOriginalConfig();
        }
      }
    },
    { type: "separator" },
    {
      label: "退出 (Exit)",
      click: () => {
        cleanupAndQuit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  // Single click on tray shows the dashboard window
  tray.on("click", () => {
    showDashboard();
  });
}

function cleanupAndQuit() {
  console.log("[OpenCodex App] Shutting down and clearing tray...");
  isQuitting = true;
  
  if (mainWindow) {
    mainWindow.close();
    mainWindow = null;
  }

  if (tray) {
    tray.destroy();
    tray = null;
  }
  
  // Gracefully terminate child processes (like MCP) before quitting
  if (serverInstance) {
    try {
      const proxy = (serverInstance as any).proxy;
      if (proxy) {
        if (proxy.mcpProcess) {
          console.log("[OpenCodex App] Killing MCP Process...");
          proxy.mcpProcess.kill("SIGTERM");
        }
        if (proxy.execServerProcess) {
          console.log("[OpenCodex App] Killing Exec Server Process...");
          proxy.execServerProcess.kill("SIGTERM");
        }
        if (proxy.vadProcess) {
          console.log("[OpenCodex App] Killing VAD Process...");
          proxy.vadProcess.kill("SIGTERM");
        }
      }
    } catch (e) {}
  }

  app.quit();
  setTimeout(() => process.exit(0), 500);
}

app.whenReady().then(async () => {
  // Hide Dock icon on Mac
  if (app.dock) {
    app.dock.hide();
  }

  createTray();
  showDashboard(); // Show window immediately on startup!
  await startServer(); // Then boot server in background
});

// Avoid quitting when all windows are closed since it's a tray app
app.on("window-all-closed", () => {
  // Do not call app.quit() to keep the tray app active
});

// Clean termination handling
process.on("SIGINT", cleanupAndQuit);
process.on("SIGTERM", cleanupAndQuit);
