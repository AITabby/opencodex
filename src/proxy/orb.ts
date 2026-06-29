import { app, BrowserWindow, ipcMain, screen } from "electron";

let win: BrowserWindow | null = null;

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  // Position at bottom right by default
  const winWidth = 100;
  const winHeight = 100;
  const x = width - winWidth - 10;
  const y = height - winHeight - 10;

  win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: x,
    y: y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // Always keep on top, even over fullscreen windows on Mac/Windows
  win.setHasShadow(false);
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadURL("http://localhost:8765/orb-view");

  win.on("closed", () => {
    win = null;
  });
}

// IPC Channel for manual window dragging from renderer
ipcMain.on("move-window", (event, arg) => {
  if (!win) return;
  const { deltaX, deltaY } = arg;
  const bounds = win.getBounds();
  win.setBounds({
    x: Math.round(bounds.x + deltaX),
    y: Math.round(bounds.y + deltaY),
    width: bounds.width,
    height: bounds.height
  });
});

// IPC Channel for dynamic window resizing based on click state
ipcMain.on("resize-window", (event, arg) => {
  if (!win) return;
  const { width: w, height: h } = arg;
  
  const bounds = win.getBounds();
  
  // Calculate new position relative to the CURRENT dragged coordinates
  // so the bottom-right corner stays anchored wherever it is dragged!
  const newX = bounds.x + bounds.width - w;
  const newY = bounds.y + bounds.height - h;
  
  win.setBounds({
    x: Math.round(newX),
    y: Math.round(newY),
    width: w,
    height: h
  });
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  app.quit();
});
