export function getOrbHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>OpenCodex Orb</title>
  <style>
    :root {
      --bg-transparent: rgba(0, 0, 0, 0);
      --glass-bg: rgba(18, 14, 46, 0.7);
      --glass-border: rgba(255, 255, 255, 0.08);
      --color-success: #10b981;
      --color-warning: #f59e0b;
      --color-danger: #ef4444;
      --color-primary: #a855f7;
      --color-secondary: #06b6d4;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      user-select: none;
    }

    body {
      background: var(--bg-transparent);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #fff;
      overflow: hidden;
      width: 100vw;
      height: 100vh;
      display: flex;
      justify-content: flex-end;
      align-items: flex-end;
      padding: 10px;
    }

    /* Floating Orb element */
    .orb-container {
      position: absolute;
      right: 10px;
      bottom: 10px;
      width: 50px;
      height: 50px;
      border-radius: 50%;
      background: radial-gradient(circle at 30% 30%, rgba(255,255,255,0.2) 0%, rgba(0,0,0,0) 80%),
                  linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%);
      box-shadow: 0 0 20px rgba(168, 85, 247, 0.6);
      cursor: grab;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.3s ease, opacity 0.3s ease;
      z-index: 100;
    }
    .orb-container:active {
      cursor: grabbing;
    }

    .orb-container.hidden {
      transform: scale(0.6) translate(15px, 15px);
      opacity: 0;
      pointer-events: none;
    }

    .orb-inner {
      font-size: 11px;
      font-weight: 800;
      color: #fff;
      text-shadow: 0 1px 4px rgba(0,0,0,0.5);
      letter-spacing: -0.5px;
      pointer-events: none;
    }

    /* Glassmorphic Panel (revealed on click) */
    .panel {
      position: absolute;
      right: 10px;
      bottom: 10px;
      width: 250px;
      height: 165px;
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 16px;
      padding: 1rem;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      opacity: 0;
      transform: scale(0.85) translate(10px, 10px);
      transform-origin: bottom right;
      transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
      pointer-events: none;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      z-index: 50;
    }

    .panel.show {
      opacity: 1;
      transform: scale(1) translate(0, 0);
      pointer-events: auto;
    }

    .panel-title {
      font-size: 0.85rem;
      font-weight: 700;
      color: #9ca3af;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: grab;
      padding-bottom: 0.25rem;
    }
    .panel-title:active {
      cursor: grabbing;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--color-success);
      box-shadow: 0 0 8px var(--color-success);
      pointer-events: none;
    }

    .progress-section {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      pointer-events: none;
    }

    .progress-bar-container {
      width: 100%;
      height: 8px;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 4px;
      overflow: hidden;
    }

    .progress-bar-fill {
      height: 100%;
      width: 0%;
      background: var(--color-success);
      transition: width 0.4s ease;
    }

    .progress-text {
      font-size: 0.75rem;
      color: #d1d5db;
      display: flex;
      justify-content: space-between;
    }

    .btn-group {
      display: flex;
      gap: 0.5rem;
      margin-top: auto;
    }

    .btn {
      flex: 1;
      padding: 0.5rem;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.04);
      color: #e5e7eb;
      font-size: 0.75rem;
      font-weight: 600;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.25rem;
    }

    .btn:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.15);
      color: #fff;
    }

    .btn-compact {
      background: rgba(168, 85, 247, 0.15);
      color: #d8b4fe;
      border-color: rgba(168, 85, 247, 0.25);
    }
    .btn-compact:hover {
      background: rgba(168, 85, 247, 0.25);
      border-color: rgba(168, 85, 247, 0.4);
    }

    /* Pulses animation */
    @keyframes pulse {
      0% { transform: scale(1); opacity: 0.3; }
      100% { transform: scale(1.1); opacity: 0.7; }
    }
  </style>
</head>
<body>

  <div class="wrapper" id="orb-wrapper" style="width: 100%; height: 100%; position: relative;">
    
    <!-- Orb Widget -->
    <div class="orb-container" id="orb-widget">
      <div class="orb-inner" id="orb-pct">AI</div>
    </div>

    <!-- Hover Panel -->
    <div class="panel" id="orb-panel">
      <div class="panel-title" id="orb-panel-title">
        <span>AI 上下文状态</span>
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <div class="status-dot" id="status-indicator"></div>
          <span style="cursor: pointer; font-size: 14px; font-weight: bold; color: #9ca3af; padding: 2px; line-height: 1;" onclick="closePanel(event)">✕</span>
        </div>
      </div>
      
      <div class="progress-section">
        <div class="progress-bar-container">
          <div class="progress-bar-fill" id="progress-fill"></div>
        </div>
        <div class="progress-text">
          <span id="progress-val">0K / 200K (0%)</span>
          <span id="progress-type" style="color: #6b7280; font-size: 0.65rem;">估算</span>
        </div>
      </div>

      <div class="btn-group">
        <button class="btn btn-compact" onclick="compactContext(event)">立即压缩</button>
        <button class="btn" id="btn-toggle-1m" onclick="toggle1M(event)">开启 1M</button>
      </div>
    </div>

  </div>

  <script>
    const ipcRenderer = window.require ? window.require('electron').ipcRenderer : null;
    let activeSessionId = "";
    let is1mEnabled = false;
    let activeModel = "";
    let isExpanded = false;

    const orbWidget = document.getElementById('orb-widget');
    const panel = document.getElementById('orb-panel');
    const panelTitle = document.getElementById('orb-panel-title');

    // Custom Dragging variables
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let hasMoved = false;

    // 1. Dragging the circular Orb
    orbWidget.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.screenX;
      startY = e.screenY;
      hasMoved = false;
    });

    // 2. Dragging the expanded Panel title
    panelTitle.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.screenX;
      startY = e.screenY;
      hasMoved = false;
    });

    // Move window event handler
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const deltaX = e.screenX - startX;
      const deltaY = e.screenY - startY;
      
      if (Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1) {
        hasMoved = true;
      }
      
      startX = e.screenX;
      startY = e.screenY;
      
      if (ipcRenderer && hasMoved) {
        ipcRenderer.send('move-window', { deltaX, deltaY });
      }
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });

    // Click handler to toggle expansion (ignored if dragged)
    orbWidget.onclick = (e) => {
      e.stopPropagation();
      if (hasMoved) return;
      isExpanded = !isExpanded;
      if (isExpanded) {
        orbWidget.classList.add('hidden');
        panel.classList.add('show');
        if (ipcRenderer) {
          ipcRenderer.send('resize-window', { width: 280, height: 190 });
        }
      }
    };

    // Close panel and return to circular orb when clicking outside or anywhere in panel background
    document.addEventListener('click', (e) => {
      if (isExpanded && (!panel.contains(e.target) || e.target === panel)) {
        isExpanded = false;
        panel.classList.remove('show');
        orbWidget.classList.remove('hidden');
        if (ipcRenderer) {
          ipcRenderer.send('resize-window', { width: 70, height: 70 });
        }
      }
    });

    // Prevent panel clicks from closing the panel (except buttons)
    panel.onclick = (e) => {
      e.stopPropagation();
    };

    function closePanel(e) {
      if (e) e.stopPropagation();
      isExpanded = false;
      panel.classList.remove('show');
      orbWidget.classList.remove('hidden');
      if (ipcRenderer) {
        ipcRenderer.send('resize-window', { width: 70, height: 70 });
      }
    }
    window.closePanel = closePanel;

    // Periodic state polling
    async function updateOrbState() {
      try {
        const response = await fetch('/api/sessions');
        const sessions = await response.json();
        if (!sessions || sessions.length === 0) return;

        const s = sessions[0];
        activeSessionId = s.id;
        activeModel = s.model;
        is1mEnabled = s.context_window === 1000000;

        const tokens = s.tokens || 0;
        const limit = s.context_window || 200000;
        const pct = Math.min(100, Math.round(tokens / limit * 100));

        // Update Orb text & progress
        document.getElementById('orb-pct').innerText = pct + '%';
        document.getElementById('progress-fill').style.width = pct + '%';
        document.getElementById('progress-val').innerText = 
          Math.round(tokens / 1000) + 'K / ' + Math.round(limit / 1000) + 'K (' + pct + '%)';
        document.getElementById('progress-type').innerText = s.is_estimated ? '估算' : '实际';

        // Update colors based on percentage
        const color = pct > 80 ? 'var(--color-danger)' : (pct > 60 ? 'var(--color-warning)' : 'var(--color-success)');
        document.getElementById('progress-fill').style.background = color;
        document.getElementById('status-indicator').style.background = color;
        document.getElementById('status-indicator').style.boxShadow = '0 0 8px ' + color;

        // Update 1M toggle text
        document.getElementById('btn-toggle-1m').innerText = is1mEnabled ? '关闭 1M' : '开启 1M';
      } catch (err) {}
    }

    // Call Actions
    async function compactContext(e) {
      if (e) e.stopPropagation();
      if (!activeSessionId) return;
      try {
        const r = await fetch('/api/sessions/compact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: activeSessionId })
        });
        if (r.ok) {
          updateOrbState();
        }
      } catch (err) {}
    }

    async function toggle1M(e) {
      if (e) e.stopPropagation();
      if (!activeModel) return;
      try {
        const modelResponse = await fetch('/api/models');
        const modelData = await modelResponse.json();

        const activeModels = modelData.active || [];
        const visionBridgeModels = modelData.catalog.filter(m => m.vision_bridge_enabled).map(m => m.id);
        const context1mModels = modelData.catalog.filter(m => m.context_window === 1000000).map(m => m.id);

        const idx = context1mModels.indexOf(activeModel);
        if (is1mEnabled) {
          if (idx !== -1) context1mModels.splice(idx, 1);
        } else {
          if (idx === -1) context1mModels.push(activeModel);
        }

        const r = await fetch('/api/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            active: activeModels,
            vision_bridge: visionBridgeModels,
            context_1m: context1mModels,
            restart: true
          })
        });
        if (r.ok) {
          updateOrbState();
        }
      } catch (err) {}
    }

    setInterval(updateOrbState, 1500);
    updateOrbState();
  </script>
</body>
</html>
`;
}
