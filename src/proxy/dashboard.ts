/**
 * OpenCodex Local Web Dashboard
 * Served directly on http://localhost:8765/dashboard.
 * Features a high-fidelity futuristic glassmorphic UI, API management with provider dropdown, and live logs streaming via SSE.
 * Fully supports bilingual translation (English and Chinese).
 */

export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenCodex Control Dashboard</title>
  <!-- Google Fonts Outfit & JetBrains Mono -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=JetBrains+Mono:wght@300;400;700&display=swap" rel="stylesheet">
  
  <style>
    :root {
      --bg-gradient: linear-gradient(135deg, #0b071e 0%, #120e2e 50%, #080515 100%);
      --glass-bg: rgba(255, 255, 255, 0.03);
      --glass-border: rgba(255, 255, 255, 0.06);
      --glass-glow: rgba(147, 51, 234, 0.15);
      
      --color-primary: #a855f7; /* Purple */
      --color-secondary: #06b6d4; /* Cyan */
      --color-success: #10b981; /* Emerald */
      --color-danger: #ef4444; /* Red */
      --color-text: #f3f4f6;
      --color-text-muted: #9ca3af;
      
      --card-blur: blur(16px);
      --transition-standard: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: 'Outfit', sans-serif;
      background: var(--bg-gradient);
      color: var(--color-text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      overflow-x: hidden;
    }
    
    /* Custom Scrollbars */
    ::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    ::-webkit-scrollbar-track {
      background: rgba(0,0,0,0.2);
    }
    ::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.15);
      border-radius: 10px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: var(--color-secondary);
    }

    /* Ambient Background Glows */
    .glow-orb {
      position: absolute;
      border-radius: 50%;
      filter: blur(120px);
      z-index: -1;
      opacity: 0.25;
      pointer-events: none;
    }
    .orb-1 {
      top: -10%;
      left: 10%;
      width: 400px;
      height: 400px;
      background: var(--color-primary);
    }
    .orb-2 {
      bottom: 10%;
      right: 10%;
      width: 500px;
      height: 500px;
      background: var(--color-secondary);
    }

    /* Container */
    .app-container {
      max-width: 1400px;
      width: 100%;
      margin: 0 auto;
      padding: 2.5rem 1.5rem;
      display: flex;
      flex-direction: column;
      gap: 2rem;
      flex: 1;
    }

    /* Header Styling */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      backdrop-filter: var(--card-blur);
      padding: 1.25rem 2rem;
      border-radius: 18px;
      box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
    }
    
    .brand-section {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .logo-container {
      background: linear-gradient(135deg, var(--color-primary), var(--color-secondary));
      width: 42px;
      height: 42px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 1.5rem;
      color: #fff;
      box-shadow: 0 0 15px rgba(168, 85, 247, 0.4);
    }

    h1 {
      font-size: 1.75rem;
      font-weight: 800;
      letter-spacing: -0.5px;
      background: linear-gradient(to right, #fff 40%, var(--color-secondary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    
    .status-badge {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.25);
      padding: 0.5rem 1rem;
      border-radius: 99px;
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--color-success);
    }
    
    .status-dot {
      width: 8px;
      height: 8px;
      background-color: var(--color-success);
      border-radius: 50%;
      box-shadow: 0 0 10px var(--color-success);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0% { transform: scale(0.9); opacity: 0.6; }
      50% { transform: scale(1.2); opacity: 1; box-shadow: 0 0 14px var(--color-success); }
      100% { transform: scale(0.9); opacity: 0.6; }
    }

    /* Grid Layout */
    .grid-layout {
      display: grid;
      grid-template-columns: 1.2fr 1fr;
      gap: 2rem;
    }
    @media (max-width: 1024px) {
      .grid-layout {
        grid-template-columns: 1fr;
      }
    }

    /* Card Panels */
    .panel-card {
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      backdrop-filter: var(--card-blur);
      border-radius: 18px;
      padding: 2rem;
      box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
      position: relative;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      transition: var(--transition-standard);
    }
    .panel-card:hover {
      border-color: rgba(255, 255, 255, 0.12);
      box-shadow: 0 12px 40px 0 rgba(147, 51, 234, 0.08);
    }

    .panel-title {
      font-size: 1.25rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      padding-bottom: 0.75rem;
      color: #fff;
    }
    .panel-title svg {
      width: 20px;
      height: 20px;
      color: var(--color-secondary);
    }

    /* Form Fields */
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    
    label {
      font-size: 0.9rem;
      font-weight: 600;
      color: var(--color-text-muted);
    }

    .input-wrapper {
      position: relative;
      width: 100%;
    }

    input[type="text"], input[type="password"], select {
      width: 100%;
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid var(--glass-border);
      padding: 0.85rem 1rem;
      border-radius: 10px;
      color: #fff;
      font-family: 'Outfit', sans-serif;
      font-size: 0.95rem;
      transition: var(--transition-standard);
    }
    input[type="text"]:focus, input[type="password"]:focus, select:focus, textarea:focus {
      outline: none;
      border-color: var(--color-secondary);
      box-shadow: 0 0 12px rgba(6, 182, 212, 0.2);
      background: rgba(0, 0, 0, 0.4);
    }

    select option {
      background-color: #0b071e;
      color: #fff;
    }

    .toggle-visibility {
      position: absolute;
      right: 12px;
      top: 50%;
      transform: translateY(-50%);
      background: none;
      border: none;
      color: var(--color-text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      transition: var(--transition-standard);
    }
    .toggle-visibility:hover {
      color: var(--color-secondary);
    }

    /* Checkboxes & Custom Models */
    .models-list {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      max-height: 380px;
      overflow-y: auto;
      padding-right: 0.5rem;
    }

    .model-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(255,255,255,0.02);
      border: 1px solid rgba(255,255,255,0.04);
      padding: 1rem;
      border-radius: 12px;
      cursor: pointer;
      transition: var(--transition-standard);
    }
    .model-item:hover {
      background: rgba(255,255,255,0.04);
      border-color: rgba(255,255,255,0.08);
      transform: translateX(3px);
    }

    .model-checkbox-container {
      display: flex;
      align-items: center;
      gap: 1rem;
      flex: 1;
    }

    .model-checkbox {
      appearance: none;
      background-color: rgba(0,0,0,0.3);
      border: 1px solid var(--glass-border);
      width: 20px;
      height: 20px;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: var(--transition-standard);
    }
    .model-checkbox:checked {
      background-color: var(--color-secondary);
      border-color: var(--color-secondary);
    }
    .model-checkbox:checked::after {
      content: "✓";
      color: #0b071e;
      font-size: 0.8rem;
      font-weight: 900;
    }

    .model-info {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }

    .model-display-name {
      font-weight: 600;
      font-size: 0.95rem;
    }

    .model-slug {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      color: var(--color-text-muted);
    }
    
    .badge {
      font-size: 0.7rem;
      font-weight: 700;
      padding: 0.25rem 0.6rem;
      border-radius: 99px;
      text-transform: uppercase;
    }
    .badge-vision {
      background: rgba(6, 182, 212, 0.15);
      border: 1px solid rgba(6, 182, 212, 0.3);
      color: var(--color-secondary);
    }
    .badge-fallback {
      background: rgba(168, 85, 247, 0.15);
      border: 1px solid rgba(168, 85, 247, 0.3);
      color: var(--color-primary);
    }

    .model-delete-btn {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #ef4444;
      width: 24px;
      height: 24px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.75rem;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: var(--transition-standard);
      flex-shrink: 0;
    }
    .model-delete-btn:hover {
      background: rgba(239, 68, 68, 0.3);
    }

    /* Actions Button */
    .action-btn {
      background: linear-gradient(135deg, var(--color-primary), var(--color-secondary));
      color: #fff;
      border: none;
      font-family: 'Outfit', sans-serif;
      font-weight: 600;
      font-size: 1rem;
      padding: 1rem 2rem;
      border-radius: 12px;
      cursor: pointer;
      box-shadow: 0 4px 15px rgba(168, 85, 247, 0.3);
      transition: var(--transition-standard);
      text-align: center;
      width: 100%;
    }
    .action-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(168, 85, 247, 0.45);
    }
    .action-btn:active {
      transform: translateY(0);
    }

    /* Terminal Console */
    .console-panel {
      grid-column: span 2;
    }
    @media (max-width: 1024px) {
      .console-panel {
        grid-column: span 1;
      }
    }

    .console-header-actions {
      margin-left: auto;
      display: flex;
      gap: 0.5rem;
    }
    
    .console-btn {
      background: rgba(255,255,255,0.05);
      border: 1px solid var(--glass-border);
      color: var(--color-text);
      cursor: pointer;
      padding: 0.4rem 0.8rem;
      border-radius: 6px;
      font-size: 0.8rem;
      font-weight: 600;
      font-family: 'Outfit', sans-serif;
      transition: var(--transition-standard);
    }
    .console-btn:hover {
      background: rgba(255,255,255,0.1);
      border-color: rgba(255,255,255,0.2);
    }

    .console-content {
      background: rgba(5, 3, 15, 0.8);
      border: 1px solid rgba(255,255,255,0.04);
      border-radius: 12px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      padding: 1.25rem;
      min-height: 250px;
      max-height: 400px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }

    .log-line {
      display: flex;
      gap: 0.75rem;
      line-height: 1.5;
    }
    
    .log-time {
      color: var(--color-secondary);
      opacity: 0.6;
      flex-shrink: 0;
    }
    
    .log-tag {
      font-weight: 700;
      flex-shrink: 0;
    }
    
    .log-text {
      word-break: break-all;
    }

    .log-info { color: #f3f4f6; }
    .log-warn { color: #f59e0b; }
    .log-error { color: #ef4444; }
    
    /* Notification Toast */
    .toast {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      background: rgba(16, 185, 129, 0.95);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255,255,255,0.2);
      color: #fff;
      padding: 1rem 2rem;
      border-radius: 12px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.5);
      transform: translateY(150%);
      transition: var(--transition-standard);
      z-index: 1000;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .toast.show {
      transform: translateY(0);
    }
    .toast.toast-error {
      background: rgba(239, 68, 68, 0.95);
    }
      /* Custom Confirm Dialog */
      .modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.6);
        backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 9999;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.25s ease;
      }
      .modal-overlay.show {
        opacity: 1;
        pointer-events: all;
      }
      .modal-box {
        background: rgba(20, 15, 40, 0.95);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 18px;
        padding: 2rem 2.5rem;
        max-width: 420px;
        width: 90%;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5), 0 0 80px rgba(147,51,234,0.08);
        display: flex;
        flex-direction: column;
        gap: 1rem;
        text-align: center;
      }
      .modal-box p {
        font-size: 1rem;
        line-height: 1.5;
        color: var(--color-text);
      }
      .modal-actions {
        display: flex;
        gap: 0.75rem;
        margin-top: 0.5rem;
      }
      .modal-actions button {
        flex: 1;
        padding: 0.75rem 1rem;
        border-radius: 10px;
        font-family: 'Outfit', sans-serif;
        font-weight: 600;
        font-size: 0.95rem;
        border: none;
        cursor: pointer;
        transition: var(--transition-standard);
      }
      .modal-btn-cancel {
        background: rgba(255,255,255,0.06);
        color: var(--color-text-muted);
      }
      .modal-btn-cancel:hover {
        background: rgba(255,255,255,0.1);
      }
      .modal-btn-confirm {
        background: linear-gradient(135deg, var(--color-primary), var(--color-secondary));
        color: #fff;
        box-shadow: 0 4px 15px rgba(168,85,247,0.3);
      }
      .modal-btn-confirm:hover {
        transform: translateY(-1px);
        box-shadow: 0 6px 20px rgba(168,85,247,0.45);
      }
    </style>
</head>
<body>
  
  <div class="glow-orb orb-1"></div>
  <div class="glow-orb orb-2"></div>

  <div class="app-container">
    
    <header>
      <div class="brand-section">
        <div class="logo-container">O</div>
        <div>
          <h1 id="i18n-title">OpenCodex Gateway</h1>
          <p id="i18n-subtitle" style="font-size: 0.8rem; color: var(--color-text-muted); font-weight: 500;">Beginner-Friendly Custom Model Control Panel</p>
        </div>
      </div>
      
      <div class="header-actions">
        <button class="console-btn" id="restart-codex-btn" onclick="restartCodexDesktop()" style="padding: 0.5rem 1rem; border-radius: 99px; background: rgba(168, 85, 247, 0.15); border-color: rgba(168, 85, 247, 0.3); color: var(--color-primary); font-weight: 600;">🚀 重启 Codex / Restart</button>
        <button class="console-btn" id="reset-btn" onclick="resetCodex()" style="padding: 0.5rem 1rem; border-radius: 99px; background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.3); color: #ef4444; font-weight: 600;">↺ 还原原生 / Reset</button>
        <button class="console-btn" id="lang-btn" onclick="toggleLanguage()" style="padding: 0.5rem 1rem; border-radius: 99px;">🌐 EN / 中</button>
        
        <div class="status-badge">
          <div class="status-dot"></div>
          <span id="i18n-status">Active & Intercepting</span>
        </div>
      </div>
    </header>

    <div class="grid-layout">
      
      <!-- API Configurations -->
      <div class="panel-card">
        <div class="panel-title" id="i18n-panel-api-title">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path>
          </svg>
          API Settings & Keys
        </div>
        
        <form id="config-form" style="display: flex; flex-direction: column; gap: 1.25rem;">
          
          <!-- Providers List -->
          <div class="form-group">
            <label id="i18n-label-providers">API Providers</label>
            <div id="providers-container" style="display:flex;flex-direction:column;gap:0.75rem;"></div>
            <button type="button" class="console-btn" onclick="addProviderRow()" style="margin-top:0.5rem;width:100%;padding:0.6rem;">+ Add Provider</button>
          </div>

          <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.06); margin: 0.5rem 0;">

          <!-- Model Names -->
          <div class="form-group">
            <label for="model-names" id="i18n-label-models">Models（每行一个，格式: 供应商名:模型名）</label>
            <textarea id="model-names" rows="5" placeholder="opencode:deepseek-v4-flash
jdcloud:GLM-5
iflytek:astron-code-latest" style="width:100%;background:rgba(0,0,0,0.25);border:1px solid var(--glass-border);padding:0.85rem 1rem;border-radius:10px;color:#fff;font-family:'JetBrains Mono',monospace;font-size:0.85rem;resize:vertical;transition:var(--transition-standard);outline:none;"></textarea>
            <p style="font-size:0.75rem;color:var(--color-text-muted);margin-top:0.3rem;" id="i18n-model-hint">Format: <b>provider:model</b> — one per line. Providers are auto-created, fill in their credentials above.</p>
          </div>

          <div style="display: flex; align-items: center; gap: 0.75rem; margin-top: 0.5rem;">
            <input type="checkbox" id="config-restart-checkbox" checked style="width: 18px; height: 18px; cursor: pointer; accent-color: var(--color-secondary);">
            <label for="config-restart-checkbox" id="i18n-label-config-restart" style="cursor: pointer; user-select: none; font-size: 0.85rem; color: var(--color-text-muted);">保存后自动重启 Codex Desktop</label>
          </div>
          
          <button type="submit" class="action-btn" id="i18n-btn-save-config" style="margin-top: 0.5rem;">Save Configurations</button>
        </form>
      </div>

      <!-- Model Catalog Customized -->
      <div class="panel-card">
        <div class="panel-title" id="i18n-panel-models-title">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"></path>
          </svg>
          Model Dropdown Customizer
        </div>
        
        <p id="i18n-models-desc" style="font-size: 0.85rem; color: var(--color-text-muted); line-height: 1.4;">
          Select which models appear in the Codex model dropdown selector. Checkboxes with **Vision Bridge** enable universal visual pre-processing for text-only models.
        </p>

        <div class="models-list" id="models-list-container">
          <!-- Populated by JavaScript -->
          <div style="text-align: center; color: var(--color-text-muted); padding: 2rem;">Loading model lists...</div>
        </div>

        <div style="display: flex; align-items: center; gap: 0.75rem; margin-top: 0.5rem;">
          <input type="checkbox" id="models-restart-checkbox" checked style="width: 18px; height: 18px; cursor: pointer; accent-color: var(--color-secondary);">
          <label for="models-restart-checkbox" id="i18n-label-models-restart" style="cursor: pointer; user-select: none; font-size: 0.85rem; color: var(--color-text-muted);">更新后自动重启 Codex Desktop</label>
        </div>
        
        <button type="button" class="action-btn" id="i18n-btn-update-dropdown" onclick="saveActiveModels()">Update Dropdown List</button>
      </div>
      
      <!-- Console Logger -->
      <div class="panel-card console-panel">
        <div class="panel-title" id="i18n-panel-console-title">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
          </svg>
          Live Stream Console Logger
          
          <div class="console-header-actions">
            <button class="console-btn" id="i18n-btn-clear" onclick="clearConsole()">Clear</button>
          </div>
        </div>
        
        <div class="console-content" id="console-logs">
          <div class="log-line log-info">
            <span class="log-time">[System]</span>
            <span class="log-text" id="i18n-connecting-sse">Connecting to Live SSE logs stream...</span>
          </div>
        </div>
      </div>

    </div>

  </div>
  
  <div class="toast" id="toast">
    <span>Configuration Updated Successfully</span>
  </div>

  <div class="modal-overlay" id="confirm-modal">
    <div class="modal-box">
      <p id="confirm-msg">Are you sure?</p>
      <div class="modal-actions">
        <button class="modal-btn-cancel" id="confirm-cancel">Cancel</button>
        <button class="modal-btn-confirm" id="confirm-ok">Confirm</button>
      </div>
    </div>
  </div>

  <script>
    // i18n Dictionary
    const i18nDict = {
      en: {
        title: "OpenCodex Gateway",
        subtitle: "Beginner-Friendly Custom Model Control Panel",
        status: "Active & Intercepting",
        panelApiTitle: "API Settings & Keys",
        labelProvider: "Primary Model Provider",
        labelProviders: "API Providers",
        labelPrimaryKey: "API Key",
        labelPrimaryUrl: "Endpoint Base URL",
        labelOcKey: "Vision Fallback API Key",
        labelOcUrl: "Vision Fallback Base URL",
        labelOcModel: "Vision Fallback Model",
        labelOcModel: "Vision Fallback Model",
        btnSaveConfig: "Save Configurations",
        panelModelsTitle: "Model Dropdown Customizer",
        modelsDesc: "Select which models appear in the Codex model dropdown selector. Check **Vision Bridge** to auto-describe screenshots for text-only models (requires Vision Fallback API key).",
        btnUpdateDropdown: "Update Dropdown List",
        panelConsoleTitle: "Live Stream Console Logger",
        btnClear: "Clear",
        connectingSse: "Connecting to Live SSE logs stream...",
        sseLost: "Logs SSE connection lost. Reconnecting...",
        toastConfigSaved: "API keys saved successfully!",
        toastConfigFailed: "Failed to save configs",
        toastConnFailed: "Failed to connect to backend",
        toastModelsSaved: "Codex dropdown selector list updated!",
        toastModelsFailed: "Failed to update models list",
        toastConsoleCleared: "Console cleared",
        btnRestartCodex: "🚀 Restart Codex",
        labelConfigRestart: "Auto-restart Codex Desktop on save",
        labelModelsRestart: "Auto-restart Codex Desktop on update",
        toastRestarting: "Restarting Codex Desktop...",
        toastRestarted: "Codex Desktop restarted!",
        labelModels: "Models (One per line)",
        modelHint: "Type new model names here. Existing models are automatically preserved. Use checkboxes below to show/hide.",
        btnReset: "↺ Reset to Native",
        toastResetting: "Resetting to native Codex...",
        toastResetDone: "Reset complete. Codex restarting."
      },
      zh: {
        title: "OpenCodex 统一网关",
        subtitle: "面向新手的自定义模型控制面板",
        status: "运行中 & 实时拦截",
        panelApiTitle: "API 密钥与接口设置",
        labelProviders: "API Providers",
        labelPrimaryKey: "API 密钥 (Key)",
        labelPrimaryUrl: "接口地址 (Base URL)",
        labelModels: "模型（每行一个模型名）",
        labelOcKey: "视觉降级 API 密钥 (Vision Fallback)",
        labelOcUrl: "视觉降级接口地址 (Base URL)",
        labelOcModel: "视觉降级模型",
        btnSaveConfig: "保存 API 配置",
        panelModelsTitle: "自定义下拉框模型",
        modelsDesc: "勾选想要显示在 Codex 左上角下拉菜单中的模型。勾选 **Vision Bridge** 的模型会拦截截图并生成文字描述（需填写视觉降级 API Key）。",
        btnUpdateDropdown: "更新下拉框菜单",
        panelConsoleTitle: "实时日志控制台",
        btnClear: "清空日志",
        connectingSse: "正在连接实时日志流...",
        sseLost: "日志流连接断开，正在尝试重连...",
        toastConfigSaved: "API 配置保存成功！",
        toastConfigFailed: "保存配置失败",
        toastConnFailed: "连接后端失败",
        toastModelsSaved: "Codex 下拉框模型列表更新成功！",
        toastModelsFailed: "更新模型列表失败",
        toastConsoleCleared: "控制台已清空",
        btnRestartCodex: "🚀 重启 Codex",
        labelConfigRestart: "保存后自动重启 Codex Desktop",
        labelModelsRestart: "更新后自动重启 Codex Desktop",
        toastRestarting: "正在重启 Codex Desktop...",
        toastRestarted: "Codex Desktop 重启成功！",
        labelModels: "模型（每行一个模型名）",
        modelHint: "Format: <b>provider:model</b> — one per line. Providers are auto-created, fill in their credentials above.",
        btnReset: "↺ 还原原生",
        toastResetting: "正在还原原生 Codex...",
        toastResetDone: "还原完成，Codex 重启中.",
        labelProviders: "API Providers",
        providerName: "Name",
        providerUrl: "Base URL",
        providerKey: "API Key",
        addProvider: "+ Add Provider"
      }
    };

    const urlPresets = {
      deepseek: "https://api.deepseek.com/v1",
      siliconflow: "https://api.siliconflow.cn/v1",
      opencode: "https://opencode.ai/zen/go/v1",
      openai: "https://api.openai.com/v1",
      custom: ""
    };

    let currentLang = 'zh';

    function setLanguage(lang) {
      currentLang = lang;
      const t = i18nDict[lang];
      
      document.getElementById('i18n-title').innerText = t.title;
      document.getElementById('i18n-subtitle').innerText = t.subtitle;
      document.getElementById('i18n-status').innerText = t.status;
      
      document.getElementById('i18n-panel-api-title').innerHTML = \`
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path>
        </svg>
        \${t.panelApiTitle}\`;
      
      document.getElementById('i18n-label-providers').innerText = t.labelProviders;
      document.getElementById('i18n-label-models').innerText = t.labelModels;
      document.getElementById('i18n-model-hint').innerText = t.modelHint;
      document.getElementById('i18n-btn-save-config').innerText = t.btnSaveConfig;
      
      document.getElementById('i18n-panel-models-title').innerHTML = \`
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"></path>
        </svg>
        \${t.panelModelsTitle}\`;
      
      document.getElementById('i18n-models-desc').innerText = t.modelsDesc;
      document.getElementById('i18n-btn-update-dropdown').innerText = t.btnUpdateDropdown;
      
      document.getElementById('i18n-panel-console-title').innerHTML = \`
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
        </svg>
        \${t.panelConsoleTitle}\`;
      
      document.getElementById('i18n-btn-clear').innerText = t.btnClear;
      
      const connSse = document.getElementById('i18n-connecting-sse');
      if (connSse) connSse.innerText = t.connectingSse;
      
      document.getElementById('i18n-label-config-restart').innerText = t.labelConfigRestart;
      document.getElementById('i18n-label-models-restart').innerText = t.labelModelsRestart;
      document.getElementById('restart-codex-btn').innerText = t.btnRestartCodex;
      document.getElementById('reset-btn').innerText = t.btnReset;
      
      document.getElementById('lang-btn').innerText = lang === 'zh' ? '🌐 English' : '🌐 中文';
    }

    function toggleLanguage() {
      setLanguage(currentLang === 'zh' ? 'en' : 'zh');
    }

    // Handles provider select dropdown changes
    function addProviderRow(name, url, key) {
      const container = document.getElementById('providers-container');
      const idx = container.children.length;
      const div = document.createElement('div');
      div.className = 'provider-row';
      div.style.cssText = 'display:flex;gap:0.5rem;align-items:center;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:0.6rem;flex-wrap:wrap;';
      div.innerHTML = \`
        <input class="prov-name" placeholder="name" value="\${name || ''}" style="width:90px;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.06);padding:0.5rem;border-radius:6px;color:#fff;font-family:Outfit,sans-serif;font-size:0.85rem;">
        <input class="prov-url" placeholder="https://..." value="\${url || ''}" style="flex:1;min-width:120px;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.06);padding:0.5rem;border-radius:6px;color:#fff;font-family:Outfit,sans-serif;font-size:0.85rem;">
        <input class="prov-key" type="password" placeholder="sk-..." value="\${key || ''}" style="flex:1;min-width:100px;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.06);padding:0.5rem;border-radius:6px;color:#fff;font-family:Outfit,sans-serif;font-size:0.85rem;">
        <button type="button" onclick="this.parentElement.remove()" style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#ef4444;width:28px;height:28px;border-radius:6px;cursor:pointer;font-size:0.8rem;">✕</button>
      \`;
      container.appendChild(div);
    }

    function togglePass(id) {
      const inp = document.getElementById(id);
      inp.type = inp.type === 'password' ? 'text' : 'password';
    }

    // Toast alerts
    function showToast(text, isError = false) {
      const toast = document.getElementById('toast');
      toast.innerText = text;
      if (isError) {
        toast.classList.add('toast-error');
      } else {
        toast.classList.remove('toast-error');
      }
      toast.classList.add('show');
      setTimeout(() => {
        toast.classList.remove('show');
      }, 3000);
    }

    let allCatalogModels = [];

    // Load Configurations & Models
    async function loadConfig() {
      try {
        const [configResp, modelsResp] = await Promise.all([
          fetch('/v1/config'),
          fetch('/api/models')
        ]);
        const data = await configResp.json();
        const modelsData = await modelsResp.json();
        
        // Populate provider rows
        const container = document.getElementById('providers-container');
        container.innerHTML = '';
        (data.providers || []).forEach(p => addProviderRow(p.name, p.base_url, p.api_key));

        // Populate model names textarea from catalog
        const modelNames = (modelsData.catalog || []).map((m) => m.provider ? m.provider + ':' + m.model : m.model).join('\\n');
        document.getElementById('model-names').value = modelNames;
      } catch (err) {
        showToast(currentLang === 'zh' ? '加载配置失败' : 'Failed to load configs', true);
      }
    }

    async function loadModels() {
      try {
        const response = await fetch('/api/models');
        const data = await response.json();
        
        allCatalogModels = data.catalog || [];
        const activeIds = new Set(data.active || []);
        
        const container = document.getElementById('models-list-container');
        container.innerHTML = '';
        
        allCatalogModels.forEach(m => {
          const isActive = activeIds.has(m.id);
          const hasVision = !m.no_image_support;
          const hasBridge = !!m.vision_bridge_enabled;
          
          const badgeHtml = hasBridge 
            ? '<span class="badge badge-fallback">Vision Bridge</span>' 
            : (hasVision ? '<span class="badge badge-vision">Native Vision</span>' : '');

          const item = document.createElement('div');
          item.className = 'model-item';
          item.onclick = (e) => {
            if (e.target.type !== 'checkbox') {
              const cb = item.querySelector('.model-checkbox');
              cb.checked = !cb.checked;
            }
          };
          
            item.innerHTML = \`
            <div class="model-checkbox-container">
              <input type="checkbox" class="model-checkbox" data-id="\${m.id}" \${isActive ? 'checked' : ''}>
              <div class="model-info">
                <div class="model-display-name">\${m.display_name}</div>
                <div class="model-slug">\${m.model}</div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:0.5rem;">
              \${badgeHtml}
              <button class="model-delete-btn" data-id="\${m.id}" onclick="event.stopPropagation(); deleteModel('\${m.id}')" title="删除">✕</button>
            </div>
          \`;
          container.appendChild(item);
        });
      } catch (err) {
        showToast(currentLang === 'zh' ? '加载模型列表失败' : 'Failed to load models list', true);
      }
    }

    // Save configurations
    document.getElementById('config-form').onsubmit = async (e) => {
      e.preventDefault();
      
      const restartChecked = document.getElementById('config-restart-checkbox').checked;
      
      // Build providers array from UI
      const providerRows = document.querySelectorAll('#providers-container .provider-row');
      const providers = Array.from(providerRows).map(row => ({
        name: row.querySelector('.prov-name').value.trim(),
        base_url: row.querySelector('.prov-url').value.trim(),
        api_key: row.querySelector('.prov-key').value.trim()
      })).filter(p => p.name && p.base_url);

      // Parse model names
      const modelNames = document.getElementById('model-names').value
        .split('\\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      try {
        if (restartChecked) {
          showToast(i18nDict[currentLang].toastRestarting);
        }
        
        const response = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providers,
            models: modelNames,
            restart: restartChecked
          })
        });
        
        if (response.ok) {
          if (restartChecked) {
            setTimeout(() => {
              showToast(i18nDict[currentLang].toastRestarted);
            }, 2500);
          } else {
            showToast(i18nDict[currentLang].toastConfigSaved);
          }
          loadConfig();
          loadModels();
        } else {
          showToast(i18nDict[currentLang].toastConfigFailed, true);
        }
      } catch (err) {
        showToast(i18nDict[currentLang].toastConnFailed, true);
      }
    };

    // Save active models
    async function saveActiveModels() {
      const checkedBoxes = document.querySelectorAll('.model-checkbox:checked');
      const activeIds = Array.from(checkedBoxes).map(cb => cb.getAttribute('data-id'));
      const restartChecked = document.getElementById('models-restart-checkbox').checked;
      
      try {
        if (restartChecked) {
          showToast(i18nDict[currentLang].toastRestarting);
        }
        
        const response = await fetch('/api/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: activeIds, restart: restartChecked })
        });
        
        if (response.ok) {
          if (restartChecked) {
            setTimeout(() => {
              showToast(i18nDict[currentLang].toastRestarted);
            }, 2500);
          } else {
            showToast(i18nDict[currentLang].toastModelsSaved);
          }
          loadModels(); // Refresh
        } else {
          showToast(i18nDict[currentLang].toastModelsFailed, true);
        }
      } catch (err) {
        showToast(i18nDict[currentLang].toastConnFailed, true);
      }
    }

    // Delete a model from catalog
    async function deleteModel(id) {
      try {
        const response = await fetch('/api/models/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        });
        if (response.ok) {
          showToast(currentLang === 'zh' ? '已删除模型' : 'Model deleted');
          loadModels();
        } else {
          showToast(currentLang === 'zh' ? '删除失败' : 'Delete failed', true);
        }
      } catch (err) {
        showToast(i18nDict[currentLang].toastConnFailed, true);
      }
    }

    // Manual or programmatic restart Codex Desktop
    async function restartCodexDesktop() {
      showToast(i18nDict[currentLang].toastRestarting);
      try {
        const response = await fetch('/api/restart-codex', {
          method: 'POST'
        });
        if (response.ok) {
          setTimeout(() => {
            showToast(i18nDict[currentLang].toastRestarted);
          }, 2500);
        } else {
          showToast(currentLang === 'zh' ? '重启失败' : 'Failed to restart', true);
        }
      } catch (err) {
        showToast(i18nDict[currentLang].toastConnFailed, true);
      }
    }

    // Custom confirm dialog
    function showConfirm(msg, onConfirm) {
      const modal = document.getElementById('confirm-modal');
      document.getElementById('confirm-msg').innerText = msg;
      document.getElementById('confirm-ok').onclick = () => {
        modal.classList.remove('show');
        onConfirm();
      };
      document.getElementById('confirm-cancel').onclick = () => modal.classList.remove('show');
      modal.classList.add('show');
    }

    // Reset Codex to native state
    async function resetCodex() {
      const msg = currentLang === 'zh' ? '还原后 Codex 显示官方模型，自定义模型的对话将被隐藏。重新填写 API 即可恢复。' : 'Reset restores native Codex. Conversations for custom models will be hidden until you reconfigure your API.';
      showConfirm(msg, async () => {
        showToast(i18nDict[currentLang].toastResetting);
        try {
          const response = await fetch('/api/reset', {
            method: 'POST'
          });
          if (response.ok) {
            setTimeout(() => {
              showToast(i18nDict[currentLang].toastResetDone);
              loadConfig();
              loadModels();
            }, 2500);
          } else {
            showToast(currentLang === 'zh' ? '还原失败' : 'Reset failed', true);
          }
        } catch (err) {
          showToast(i18nDict[currentLang].toastConnFailed, true);
        }
      });
    }

    // Live Logs SSE Setup
    function setupLogsSse() {
      const consoleContainer = document.getElementById('console-logs');
      const source = new EventSource('/api/logs/stream');
      
      source.onmessage = (event) => {
        try {
          const log = JSON.parse(event.data);
          appendLogLine(log.time, log.tag, log.text, log.level);
        } catch {
          // ignore
        }
      };

      source.onerror = (err) => {
        appendLogLine('[System]', 'WARN', i18nDict[currentLang].sseLost, 'warn');
      };
    }

    function appendLogLine(time, tag, text, level) {
      const container = document.getElementById('console-logs');
      const line = document.createElement('div');
      line.className = \`log-line log-\${level || 'info'}\`;
      
      line.innerHTML = \`
        <span class="log-time">\${time}</span>
        <span class="log-tag">[\${tag}]</span>
        <span class="log-text">\${escapeHtml(text)}</span>
      \`;
      
      container.appendChild(line);
      
      // Auto scroll
      container.scrollTop = container.scrollHeight;
      
      // Keep logs size bounded (1000 lines max)
      if (container.children.length > 1000) {
        container.removeChild(container.firstChild);
      }
    }

    function clearConsole() {
      document.getElementById('console-logs').innerHTML = '';
      showToast(i18nDict[currentLang].toastConsoleCleared);
    }

    function escapeHtml(text) {
      return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    // Initial Load
    window.onload = () => {
      setLanguage('zh'); // Default to Chinese as user requested "中英文"
      loadConfig();
      loadModels();
      setupLogsSse();
    };
  </script>
</body>
</html>
`;
}
