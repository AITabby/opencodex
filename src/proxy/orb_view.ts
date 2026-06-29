export function getOrbHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>OpenCodex Orb</title>
  <style>
    :root {
      --bg-transparent: rgba(0, 0, 0, 0);
      --glass-bg: rgba(14, 10, 36, 0.88);
      --glass-border: rgba(255, 255, 255, 0.08);
      --color-success: #00f0ff; /* Electric Cyan */
      --color-warning: #bd00ff; /* Hot Purple */
      --color-danger: #ff007a;  /* Liquid Magenta */
      --glow-color: #00f0ff;
      --glow-color-alpha: rgba(0, 240, 255, 0.25);
      --glow-color-alpha-strong: rgba(0, 240, 255, 0.65);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      user-select: none;
    }

    body {
      background: var(--bg-transparent);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Outfit", sans-serif;
      color: #fff;
      overflow: hidden;
      width: 100vw;
      height: 100vh;
      display: flex;
      justify-content: flex-end;
      align-items: flex-end;
      padding: 10px;
    }

    /* Liquid Glass Orb Container */
    /* Liquid Glass Orb Container */
    .orb-container {
      position: absolute;
      right: 25px;
      bottom: 25px;
      width: 50px;
      height: 50px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: grab;
      z-index: 100;
      transition: transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.3s ease;
      animation: liquid-breathe 4s infinite ease-in-out;
      filter: drop-shadow(0 4px 10px rgba(0, 0, 0, 0.45));
    }

    /* Outer progress ring only (masked center to remove sector) */
    .orb-ring {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background: conic-gradient(var(--glow-color) var(--pct-deg, 0deg), rgba(255, 255, 255, 0.04) var(--pct-deg, 0deg));
      mask: radial-gradient(circle, transparent 20px, black 21px);
      -webkit-mask: radial-gradient(circle, transparent 20px, black 21px);
      pointer-events: none;
      z-index: 1;
    }
    
    .orb-container:active {
      cursor: grabbing;
      transform: scale(0.93);
    }

    .orb-container.hidden {
      transform: scale(0.3) translate(25px, 25px);
      opacity: 0;
      pointer-events: none;
    }

    /* Core mimicking Apple liquid glass ball */
    .orb-core {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: rgba(14, 10, 36, 0.82);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      border: 1.5px solid rgba(255, 255, 255, 0.18);
      box-shadow: inset 0 0 12px rgba(255, 255, 255, 0.15),
                  inset 0 -3px 8px rgba(0, 0, 0, 0.3);
      overflow: hidden;
      z-index: 2;
    }

    /* Liquid Glass Highlight Overlay */
    .orb-specular {
      position: absolute;
      top: 1px;
      left: 1px;
      right: 1px;
      height: 50%;
      border-radius: 50% 50% 35% 35% / 50% 50% 20% 20%;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.25) 0%, rgba(255, 255, 255, 0.02) 80%, rgba(255, 255, 255, 0) 100%);
      pointer-events: none;
    }

    .orb-inner {
      font-size: 10px;
      font-weight: 800;
      color: #fff;
      text-shadow: 0 0 6px var(--glow-color),
                   0 1px 2px rgba(0, 0, 0, 0.8),
                   0 1px 4px rgba(0, 0, 0, 0.9);
      letter-spacing: -0.5px;
      pointer-events: none;
      z-index: 10;
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
      border-radius: 16px;
      padding: 1rem;
      box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.25), 
                  0 0 0 1px rgba(255, 255, 255, 0.05);
      opacity: 0;
      transform: scale(0.85) translate(10px, 10px);
      transform-origin: bottom right;
      transition: all 0.4s cubic-bezier(0.165, 0.84, 0.44, 1);
      pointer-events: none;
      display: none; /* 🔴 COMPLETELY REMOVE FROM LAYOUT WHEN HIDDEN */
      backdrop-filter: none; /* 🔴 DISABLE BACKDROP-FILTER TO PREVENT PHANTOM BLUR SHADOW ON macOS */
      -webkit-backdrop-filter: none;
      flex-direction: column;
      gap: 0.75rem;
      z-index: 50;
    }

    .panel.show {
      display: flex; /* 🔴 ACTIVATE LAYOUT */
      opacity: 1;
      transform: scale(1) translate(0, 0);
      pointer-events: auto;
      backdrop-filter: blur(25px); /* 🔴 ONLY ACTIVATE BLUR WHEN SHOWN */
      -webkit-backdrop-filter: blur(25px);
    }

    .panel-title {
      font-size: 0.8rem;
      font-weight: 700;
      color: #9ca3af;
      text-transform: uppercase;
      letter-spacing: 0.8px;
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
      background: var(--glow-color);
      box-shadow: 0 0 8px var(--glow-color);
      pointer-events: none;
      transition: background 0.3s ease, box-shadow 0.3s ease;
    }

    .progress-section {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      pointer-events: none;
    }

    .progress-bar-container {
      width: 100%;
      height: 6px;
      background: rgba(255, 255, 255, 0.04);
      border-radius: 3px;
      overflow: hidden;
    }

    .progress-bar-fill {
      height: 100%;
      width: 0%;
      background: var(--glow-color);
      box-shadow: 0 0 8px var(--glow-color);
      transition: width 0.4s cubic-bezier(0.1, 0.8, 0.1, 1), background 0.3s ease;
    }

    .progress-text {
      font-size: 0.7rem;
      color: #9ca3af;
      display: flex;
      justify-content: space-between;
      margin-top: 2px;
    }

    .btn-group {
      display: flex;
      gap: 0.5rem;
      margin-top: auto;
    }

    .btn {
      flex: 1;
      padding: 0.5rem;
      border: 1px solid rgba(255, 255, 255, 0.06);
      background: rgba(255, 255, 255, 0.03);
      color: #d1d5db;
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
      background: rgba(255, 255, 255, 0.07);
      border-color: rgba(255, 255, 255, 0.12);
      color: #fff;
      box-shadow: 0 0 10px rgba(255,255,255,0.05);
    }

    .btn-compact {
      background: rgba(0, 240, 255, 0.1);
      color: #00f0ff;
      border-color: rgba(0, 240, 255, 0.25);
    }
    .btn-compact:hover {
      background: rgba(0, 240, 255, 0.2);
      border-color: rgba(0, 240, 255, 0.45);
      box-shadow: 0 0 10px rgba(0, 240, 255, 0.25);
    }

    /* Apple Liquid Glass organic breathing glow animation */
    @keyframes liquid-breathe {
      0% {
        transform: scale(1);
        box-shadow: 0 0 6px var(--glow-color-alpha);
      }
      50% {
        transform: scale(1.04);
        box-shadow: 0 0 16px var(--glow-color-alpha-strong);
      }
      100% {
        transform: scale(1);
        box-shadow: 0 0 6px var(--glow-color-alpha);
      }
    }
  </style>
</head>
<body>

  <div class="wrapper" id="orb-wrapper" style="width: 100%; height: 100%; position: relative;">
    
    <!-- Orb Widget -->
    <div class="orb-container" id="orb-widget">
      <div class="orb-ring"></div>
      <div class="orb-core">
        <div class="orb-specular"></div>
        <div class="orb-inner" id="orb-pct">0%</div>
      </div>
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

    let animationFrameId = null;
    let pendingDeltaX = 0;
    let pendingDeltaY = 0;

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
        pendingDeltaX += deltaX;
        pendingDeltaY += deltaY;
        
        if (!animationFrameId) {
          animationFrameId = requestAnimationFrame(() => {
            ipcRenderer.send('move-window', { deltaX: pendingDeltaX, deltaY: pendingDeltaY });
            pendingDeltaX = 0;
            pendingDeltaY = 0;
            animationFrameId = null;
          });
        }
      }
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      pendingDeltaX = 0;
      pendingDeltaY = 0;
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
        closePanel(e);
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
        ipcRenderer.send('resize-window', { width: 100, height: 100 });
      }
    }
    window.closePanel = closePanel;

    // Listen to window focus-out (blur) event to automatically collapse when clicking on other apps/Desktop
    window.addEventListener('blur', () => {
      if (isExpanded) {
        closePanel();
      }
    });

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

        // Update Orb dynamic CSS percentage variables
        orbWidget.style.setProperty('--pct-deg', (pct * 3.6) + 'deg');

        // Update Orb text & progress
        document.getElementById('orb-pct').innerText = pct + '%';
        document.getElementById('progress-fill').style.width = pct + '%';
        document.getElementById('progress-val').innerText = 
          Math.round(tokens / 1000) + 'K / ' + Math.round(limit / 1000) + 'K (' + pct + '%)';
        const tokenSourceLabels = {
          provider: '供应商实际',
          rollout_actual: '会话实际',
          model_tokenizer: '模型分词',
          model_estimate: '模型估算',
          generic_estimate: '通用估算'
        };
        document.getElementById('progress-type').innerText = tokenSourceLabels[s.token_source] || (s.is_estimated ? '估算' : '实际');

        // Update dynamic glows based on percentage
        let color = 'var(--color-success)';
        if (pct > 80) {
          color = 'var(--color-danger)';
        } else if (pct > 60) {
          color = 'var(--color-warning)';
        }

        // Apply updated color variables
        document.documentElement.style.setProperty('--glow-color', color);
        document.documentElement.style.setProperty('--glow-color-alpha', color.replace(')', ', 0.25)'));
        document.documentElement.style.setProperty('--glow-color-alpha-strong', color.replace(')', ', 0.6)'));

      } catch (err) {}
    }

    setInterval(updateOrbState, 1500);
    updateOrbState();
  </script>
</body>
</html>
`;
}
