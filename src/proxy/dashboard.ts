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
    @media (max-width: 768px) {
      .voice-inner-grid, .voice-other-grid {
        grid-template-columns: 1fr !important;
        gap: 1.5rem !important;
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
            <textarea id="model-names" rows="5" placeholder="opencode:deepseek-v4-flash" style="width:100%;background:rgba(0,0,0,0.25);border:1px solid var(--glass-border);padding:0.85rem 1rem;border-radius:10px;color:#fff;font-family:'JetBrains Mono',monospace;font-size:0.85rem;resize:vertical;transition:var(--transition-standard);outline:none;"></textarea>
            <p style="font-size:0.75rem;color:var(--color-text-muted);margin-top:0.3rem;" id="i18n-model-hint">Format: <b>provider:model</b> — one per line. Providers are auto-created, fill in their credentials above.</p>
          </div>

          <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.06); margin: 0.5rem 0;">

          <!-- Vision Fallback Settings -->
          <div class="form-group" style="display: flex; flex-direction: column; gap: 1rem; background: rgba(255, 255, 255, 0.01); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 12px; padding: 1.25rem;">
            <h3 style="font-size: 0.95rem; font-weight: 700; color: var(--color-primary); border-left: 3px solid var(--color-primary); padding-left: 0.5rem; margin: 0 0 0.25rem 0;" id="i18n-panel-vision-fallback-title">视觉降级服务 (Vision Fallback)</h3>
            
            <div class="form-group">
              <label for="oc-api-key" id="i18n-label-oc-key">视觉降级 API 密钥 (Vision Fallback)</label>
              <div class="input-wrapper">
                <input type="password" id="oc-api-key" placeholder="sk-...">
                <button type="button" class="toggle-visibility" onclick="togglePass('oc-api-key')">
                  <svg style="width: 20px; height: 20px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                </button>
              </div>
            </div>

            <div class="form-group">
              <label for="oc-base-url" id="i18n-label-oc-url">视觉降级接口地址 (Base URL)</label>
              <input type="text" id="oc-base-url" placeholder="https://opencode.ai/zen/go/v1">
            </div>

            <div class="form-group">
              <label for="oc-model" id="i18n-label-oc-model">视觉降级模型</label>
              <input type="text" id="oc-model" placeholder="mimo-v2.5">
            </div>
          </div>

          <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.06); margin: 0.5rem 0;">

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
    </div><!-- End Row 1 (Grid-Layout) -->

    <!-- Voice Settings Panel -->
      <div class="panel-card">
        <div class="panel-title" id="i18n-panel-voice-title">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path>
          </svg>
          Voice & Speech Settings
        </div>
        
        <form id="voice-form" style="display: flex; flex-direction: column; gap: 1.5rem;">
          
          <!-- Inner Grid 1: STT & TTS side-by-side -->
          <div class="voice-inner-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 2rem;">
            
            <!-- STT Block (Left Column) -->
            <div style="display: flex; flex-direction: column; gap: 1.25rem;">
              <h3 style="font-size: 0.95rem; font-weight: 700; color: var(--color-secondary); border-left: 3px solid var(--color-secondary); padding-left: 0.5rem; margin: 0 0 0.25rem 0;">Speech-to-Text (STT) 录音识别</h3>
              
              <!-- STT Dropdown -->
              <div class="form-group">
                <label for="stt-engine" id="i18n-label-stt-engine">STT Engine</label>
                <select id="stt-engine">
                  <option value="local-whisper">本地极速 Whisper (Local Whisper)</option>
                  <option value="apple-speech">macOS 原生语音识别 (macOS Native)</option>
                  <option value="openai-compatible">自定义 OpenAI-Compatible API</option>
                </select>
              </div>

              <!-- Custom STT Config Fields -->
              <div id="custom-stt-fields" style="display: none; flex-direction: column; gap: 1rem; border-left: 2px solid var(--color-secondary); padding-left: 1rem; margin-left: 0.5rem;">
                <div class="form-group">
                  <label for="stt-api-key" id="i18n-label-stt-api-key">STT API Key</label>
                  <input type="password" id="stt-api-key" placeholder="sk-...">
                </div>
                <div class="form-group">
                  <label for="stt-base-url" id="i18n-label-stt-base-url">STT Base URL</label>
                  <input type="text" id="stt-base-url" placeholder="https://api.openai.com/v1">
                </div>
                <div class="form-group">
                  <label for="stt-model" id="i18n-label-stt-model">STT Model Name</label>
                  <input type="text" id="stt-model" placeholder="whisper-1">
                </div>
              </div>
            </div>

            <!-- TTS Block (Right Column) -->
            <div style="display: flex; flex-direction: column; gap: 1.25rem;">
              <h3 style="font-size: 0.95rem; font-weight: 700; color: var(--color-primary); border-left: 3px solid var(--color-primary); padding-left: 0.5rem; margin: 0 0 0.25rem 0;">Text-to-Speech (TTS) 语音合成</h3>
              
              <!-- TTS Dropdown -->
              <div class="form-group">
                <label for="tts-engine" id="i18n-label-tts-engine">TTS Engine</label>
                <select id="tts-engine">
                  <option value="edge-tts">微软 Edge 神经网络语音 (Edge-TTS)</option>
                  <option value="apple-speech">macOS 系统说话 (say)</option>
                  <option value="minimax">MiniMax 语音合成 (MiniMax TTS)</option>
                  <option value="openai-compatible">自定义 OpenAI-Compatible API</option>
                </select>
              </div>

              <!-- Custom TTS Config Fields -->
              <div id="custom-tts-fields" style="display: none; flex-direction: column; gap: 1rem; border-left: 2px solid var(--color-primary); padding-left: 1rem; margin-left: 0.5rem;">
                <div class="form-group">
                  <label for="tts-api-key" id="i18n-label-tts-api-key">TTS API Key</label>
                  <input type="password" id="tts-api-key" placeholder="sk-...">
                </div>
                <div class="form-group">
                  <label for="tts-base-url" id="i18n-label-tts-base-url">TTS Base URL</label>
                  <input type="text" id="tts-base-url" placeholder="https://api.openai.com/v1">
                </div>
                <div class="form-group">
                  <label for="tts-model" id="i18n-label-tts-model">TTS Model Name</label>
                  <input type="text" id="tts-model" placeholder="tts-1">
                </div>
              </div>

              <!-- TTS Voice -->
              <div class="form-group">
                <label for="tts-voice" id="i18n-label-tts-voice">TTS Voice / Role</label>
                <input type="text" id="tts-voice" placeholder="zh-CN-XiaoxiaoNeural">
              </div>
            </div>

          </div>

          <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.06); margin: 0.5rem 0;">

          <!-- Inner Grid 2: VAD & Other Settings side-by-side -->
          <div class="voice-other-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 2rem;">
            
            <!-- VAD Settings (Left Column) -->
            <div style="display: flex; flex-direction: column; gap: 1.25rem;">
              <h3 style="font-size: 0.95rem; font-weight: 700; color: #10b981; border-left: 3px solid #10b981; padding-left: 0.5rem; margin: 0 0 0.25rem 0;">Voice Activity Detection (VAD) 静音检测</h3>
              
              <div class="form-group">
                <label for="vad-threshold" id="i18n-label-vad-threshold">VAD Silence Threshold (dB)</label>
                <input type="text" id="vad-threshold" placeholder="-42.0" style="font-family:'JetBrains Mono',monospace;">
                <p style="font-size:0.72rem;color:var(--color-text-muted);" id="i18n-vad-threshold-hint">Sound power below this level is treated as silence (e.g. -42.0 dB).</p>
              </div>

              <div class="form-group">
                <label for="vad-duration" id="i18n-label-vad-duration">VAD Required Silence (seconds)</label>
                <input type="text" id="vad-duration" placeholder="1.5" style="font-family:'JetBrains Mono',monospace;">
                <p style="font-size:0.72rem;color:var(--color-text-muted);" id="i18n-vad-duration-hint">Auto-stops recording after this duration of silence (e.g. 1.5s).</p>
              </div>
            </div>

            <!-- Other Settings (Right Column) -->
            <div style="display: flex; flex-direction: column; gap: 1.25rem;">
              <h3 style="font-size: 0.95rem; font-weight: 700; color: #f59e0b; border-left: 3px solid #f59e0b; padding-left: 0.5rem; margin: 0 0 0.25rem 0;">Conversational Agent 对话大脑</h3>

              <div class="form-group">
                <label for="voice-llm-model" id="i18n-label-voice-llm-model">语音助手对话大模型 (LLM Model for Voice)</label>
                <input type="text" id="voice-llm-model" placeholder="deepseek-v4-flash">
                <p style="font-size:0.72rem;color:var(--color-text-muted);" id="i18n-voice-llm-model-hint">Independent model selection for voice agent decisions.</p>
              </div>

              <!-- Wake Word Activation Toggle (Hidden to prevent JS crashes) -->
              <input type="checkbox" id="enable-wake-word" style="display: none;">
            </div>

          </div>

          <button type="submit" class="action-btn" id="i18n-btn-save-voice" style="margin-top: 0.5rem;">Save Voice Settings</button>
        </form>

        <!-- Voice Bar Launch Controller -->
        <div style="border-top: 1px solid rgba(255,255,255,0.08); padding-top: 1.25rem; margin-top: 1.25rem; display: flex; flex-direction: column; gap: 0.75rem;">
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <span id="i18n-voice-bar-status-label" style="font-size: 0.85rem; font-weight: 500; color: var(--color-text);">Voice Assistant Menu Bar (OpenCodexBar)</span>
            <span id="voice-bar-status-badge" style="font-size: 0.75rem; font-weight: 600; padding: 0.2rem 0.6rem; border-radius: 99px; background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2);">Offline</span>
          </div>
          <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
            <button type="button" class="action-btn" id="i18n-btn-launch-voice-bar" onclick="launchVoiceBar('swift-run')" style="flex: 1; min-width: 150px; background: var(--color-primary); color: white; margin-top: 0;">Launch Voice Assistant (swift run)</button>
            <button type="button" class="action-btn" id="i18n-btn-launch-voice-bar-app" onclick="launchVoiceBar('app')" style="flex: 1; min-width: 150px; background: rgba(255,255,255,0.05); color: var(--color-text); margin-top: 0; border: 1px solid rgba(255,255,255,0.1);">Open Application (.app)</button>
            <a href="/visualizer" target="_blank" class="action-btn" style="flex: 1; min-width: 100%; background: linear-gradient(90deg, var(--color-primary), var(--color-secondary)); color: #000; font-weight: 700; margin-top: 0.5rem; text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 0.5rem; border: none; box-shadow: 0 4px 15px rgba(6, 182, 212, 0.25);">
              <svg style="width:1.1rem;height:1.1rem;" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path>
              </svg>
              <span id="i18n-text-visualizer-lab">Interactive Visualizer Lab</span>
            </a>
          </div>
        </div>
      </div>

      <!-- Row 3: Live Widescreen Console Logger -->
      <div class="panel-card console-panel" style="display: flex; flex-direction: column;">
        <div class="panel-title" id="i18n-panel-console-title">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
          </svg>
          Live Stream Console Logger
          
          <div class="console-header-actions">
            <button class="console-btn" id="i18n-btn-clear" onclick="clearConsole()">Clear</button>
            <button class="console-btn" onclick="fetch('/api/test-log',{method:'POST'})">Test Log</button>
          </div>
        </div>
        
        <div class="console-content" id="console-logs" style="flex: 1; min-height: 320px;">
          <div class="log-line log-info">
            <span class="log-time">[System]</span>
            <span class="log-text" id="i18n-connecting-sse">Connecting to Live SSE logs stream...</span>
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
        toastResetDone: "Reset complete. Codex restarting.",
        panelVoiceTitle: "Voice & Speech Settings",
        labelVoiceLlmModel: "Voice Assistant LLM Model",
        labelSttEngine: "Speech-to-Text (STT) Engine",
        labelSttApiKey: "STT API Key",
        labelSttBaseUrl: "STT Base URL",
        labelSttModel: "STT Model Name",
        labelTtsEngine: "Text-to-Speech (TTS) Engine",
        labelTtsApiKey: "TTS API Key",
        labelTtsBaseUrl: "TTS Base URL",
        labelTtsModel: "TTS Model Name",
        labelTtsVoice: "TTS Voice / Role",
        labelVadThreshold: "VAD Silence Threshold (dB)",
        vadThresholdHint: "Sound power below this level is treated as silence (default: -35.0 dB).",
        labelVadDuration: "VAD Required Silence (seconds)",
        vadDurationHint: "Auto-stops recording after this duration of silence (default: 2.0s).",
        voiceLlmModelHint: "Independent model selection for voice agent decisions.",
        wakeWordHint: "Trigger words: 'Hi Codex' or '你好科代' (Coming Soon).",
        comingSoon: "Coming Soon",
        labelEnableWakeWord: "Enable Voice Wake Word (Keyword: 'Hi Codex' or '你好科代')",
        btnSaveVoice: "Save Voice Settings",
        toastVoiceSaved: "Voice settings saved successfully!",
        toastVoiceFailed: "Failed to save voice settings",
        panelConsoleInputTitle: "Interactive Command Console",
        cmdDesc: "Type text-based commands directly. They run on Codex using your primary terminal session permissions (perfect for GUI Computer Use).",
        btnSendCmd: "Send Command",
        cmdPlaceholder: "Console output will appear here...",
        cmdInputPlaceholder: "Type a command, e.g., 'open Chrome and search DeepSeek'...",
        voiceBarStatusLabel: "Voice Assistant Menu Bar (OpenCodexBar)",
        voiceBarStatusOnline: "Online",
        voiceBarStatusOffline: "Offline",
        btnLaunchVoiceBar: "Launch Voice Assistant (swift run)",
        btnLaunchVoiceBarApp: "Open Application (.app)",
        btnVisualizerLab: "Dynamic Visualizer Lab (Aurora FX)",
        toastVoiceBarLaunching: "Launching Voice Assistant...",
        toastVoiceBarFailed: "Failed to launch Voice Assistant"
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
        addProvider: "+ Add Provider",
        panelVoiceTitle: "语音与分贝设置",
        labelVoiceLlmModel: "语音助手对话大模型",
        labelSttEngine: "语音识别 (STT) 引擎",
        labelSttApiKey: "语音识别 API 密钥 (Key)",
        labelSttBaseUrl: "语音识别接口地址 (Base URL)",
        labelSttModel: "语音识别模型 (Model)",
        labelTtsEngine: "语音合成 (TTS) 引擎",
        labelTtsApiKey: "语音合成 API 密钥 (Key)",
        labelTtsBaseUrl: "语音合成接口地址 (Base URL)",
        labelTtsModel: "语音合成模型 (Model)",
        labelTtsVoice: "系统发音人 / 角色",
        labelVadThreshold: "静音检测阈值 (分贝)",
        vadThresholdHint: "环境分贝低于此值将被判定为静音（默认：-35.0 dB）。",
        labelVadDuration: "静音检测时长 (秒)",
        vadDurationHint: "说话停顿超过此时间将自动终止录音（默认：2.0s）。",
        voiceLlmModelHint: "为语音助手单独配置决策模型（默认为 Codex 当前所选模型）。",
        wakeWordHint: "快捷唤醒词：'Hi Codex' 或 '你好科代'（功能暂未开放）。",
        comingSoon: "即将上线",
        labelEnableWakeWord: "启用语音唤醒 (唤醒词: 'Hi Codex' 或 '你好科代')",
        btnSaveVoice: "保存语音设置",
        toastVoiceSaved: "语音配置保存成功！",
        toastVoiceFailed: "保存语音设置失败",
        panelConsoleInputTitle: "交互式指令控制台",
        cmdDesc: "在此直接输入文本指令。它们会以您主终端会话的系统权限运行在 Codex 中（非常适合进行屏幕 GUI 计算机操作）。",
        btnSendCmd: "发送指令",
        cmdPlaceholder: "控制台执行输出将在此显示...",
        cmdInputPlaceholder: "输入指令，例如：'打开浏览器并搜索 DeepSeek'...",
        voiceBarStatusLabel: "语音助手菜单栏 (OpenCodexBar)",
        voiceBarStatusOnline: "在线 (运行中)",
        voiceBarStatusOffline: "离线",
        btnLaunchVoiceBar: "启动语音助手 (swift run)",
        btnLaunchVoiceBarApp: "打开应用包 (.app)",
        btnVisualizerLab: "动效设计实验室 (极酷概念)",
        toastVoiceBarLaunching: "正在启动语音助手...",
        toastVoiceBarFailed: "启动语音助手失败"
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
      
      const el = (id) => document.getElementById(id);
      const setText = (id, val) => { const e = el(id); if (e) e.innerText = val; };
      const setHtml = (id, fn) => { const e = el(id); if (e) e.innerHTML = fn(t); };
      
      setText('i18n-title', t.title);
      setText('i18n-subtitle', t.subtitle);
      setText('i18n-status', t.status);
      
      setHtml('i18n-panel-api-title', (t) => \`<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>${'$'}{t.panelApiTitle}\`);
      
      setText('i18n-label-providers', t.labelProviders);
      setText('i18n-label-models', t.labelModels);
      setText('i18n-model-hint', t.modelHint);
      setText('i18n-btn-save-config', t.btnSaveConfig);
      
      setText('i18n-panel-vision-fallback-title', lang === 'zh' ? '视觉降级服务 (Vision Fallback)' : 'Vision Fallback Service');
      setText('i18n-label-oc-key', t.labelOcKey);
      setText('i18n-label-oc-url', t.labelOcUrl);
      setText('i18n-label-oc-model', t.labelOcModel);
      
      setHtml('i18n-panel-models-title', (t) => \`<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"></path></svg>${'$'}{t.panelModelsTitle}\`);
      
      setText('i18n-models-desc', t.modelsDesc);
      setText('i18n-btn-update-dropdown', t.btnUpdateDropdown);
      
      setHtml('i18n-panel-console-title', (t) => \`<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>${'$'}{t.panelConsoleTitle}\`);
      
      setText('i18n-btn-clear', t.btnClear);
      setText('i18n-connecting-sse', t.connectingSse);
      setText('i18n-label-config-restart', t.labelConfigRestart);
      setText('i18n-label-models-restart', t.labelModelsRestart);
      setText('restart-codex-btn', t.btnRestartCodex);
      setText('reset-btn', t.btnReset);
      
      setHtml('i18n-panel-voice-title', (t) => \`<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>${'$'}{t.panelVoiceTitle}\`);
      setText('i18n-label-voice-llm-model', t.labelVoiceLlmModel);
      setText('i18n-label-stt-engine', t.labelSttEngine);
      setText('i18n-label-stt-api-key', t.labelSttApiKey);
      setText('i18n-label-stt-base-url', t.labelSttBaseUrl);
      setText('i18n-label-stt-model', t.labelSttModel);
      
      setText('i18n-label-tts-engine', t.labelTtsEngine);
      setText('i18n-label-tts-api-key', t.labelTtsApiKey);
      setText('i18n-label-tts-base-url', t.labelTtsBaseUrl);
      setText('i18n-label-tts-model', t.labelTtsModel);
      
      setText('i18n-label-tts-voice', t.labelTtsVoice);
      setText('i18n-label-vad-threshold', t.labelVadThreshold);
      setText('i18n-vad-threshold-hint', t.vadThresholdHint);
      setText('i18n-label-vad-duration', t.labelVadDuration);
      setText('i18n-vad-duration-hint', t.vadDurationHint);
      setText('i18n-voice-llm-model-hint', t.voiceLlmModelHint);
      setText('i18n-wake-word-hint', t.wakeWordHint);
      setText('i18n-text-coming-soon', t.comingSoon);
      setText('i18n-label-enable-wake-word', t.labelEnableWakeWord);
      setText('i18n-btn-save-voice', t.btnSaveVoice);
      
      setText('i18n-voice-bar-status-label', t.voiceBarStatusLabel);
      setText('i18n-btn-launch-voice-bar', t.btnLaunchVoiceBar);
      setText('i18n-btn-launch-voice-bar-app', t.btnLaunchVoiceBarApp);
      setText('i18n-text-visualizer-lab', t.btnVisualizerLab);

      const langBtn = el('lang-btn');
      if (langBtn) langBtn.innerText = lang === 'zh' ? '🌐 English' : '🌐 中文';
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
        <input class="prov-name" placeholder="name" value="${'$'}{name || ''}" style="width:90px;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.06);padding:0.5rem;border-radius:6px;color:#fff;font-family:Outfit,sans-serif;font-size:0.85rem;">
        <input class="prov-url" placeholder="https://..." value="${'$'}{url || ''}" style="flex:1;min-width:120px;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.06);padding:0.5rem;border-radius:6px;color:#fff;font-family:Outfit,sans-serif;font-size:0.85rem;">
        <input class="prov-key" type="password" placeholder="sk-..." value="${'$'}{key || ''}" style="flex:1;min-width:100px;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.06);padding:0.5rem;border-radius:6px;color:#fff;font-family:Outfit,sans-serif;font-size:0.85rem;">
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
        
        let opencodeProvider = null;
        let hasOtherProviders = false;
        (data.providers || []).forEach(p => {
          if (p.name === 'opencode') {
            opencodeProvider = p;
          } else {
            addProviderRow(p.name, p.base_url, p.api_key);
            hasOtherProviders = true;
          }
        });
        
        // If there are no other providers configured, automatically add exactly one blank row
        // so that there is a slot ("口子") ready for the user to configure their first model provider!
        if (!hasOtherProviders) {
          addProviderRow('', '', '');
        }
        
        if (opencodeProvider) {
          document.getElementById('oc-api-key').value = opencodeProvider.api_key || '';
          document.getElementById('oc-base-url').value = opencodeProvider.base_url || 'https://opencode.ai/zen/go/v1';
          document.getElementById('oc-model').value = opencodeProvider.vision_model || opencodeProvider.model || 'mimo-v2.5';
        } else {
          document.getElementById('oc-api-key').value = '';
          document.getElementById('oc-base-url').value = 'https://opencode.ai/zen/go/v1';
          document.getElementById('oc-model').value = 'mimo-v2.5';
        }

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

        // Voice LLM model is now a direct text input field
        
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
              <input type="checkbox" class="model-checkbox" data-id="${'$'}{m.id}" ${'$'}{isActive ? 'checked' : ''}>
              <div class="model-info">
                <div class="model-display-name">${'$'}{m.display_name}</div>
                <div class="model-slug">${'$'}{m.model}</div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:0.5rem;">
              ${'$'}{badgeHtml}
              <button class="model-delete-btn" data-id="${'$'}{m.id}" onclick="event.stopPropagation(); deleteModel('${'$'}{m.id}')" title="删除">✕</button>
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

      // Append opencode (vision fallback) provider to the list
      const ocKey = document.getElementById('oc-api-key').value.trim();
      const ocUrl = document.getElementById('oc-base-url').value.trim() || 'https://opencode.ai/zen/go/v1';
      const ocModel = document.getElementById('oc-model').value.trim() || 'mimo-v2.5';
      providers.push({
        name: 'opencode',
        base_url: ocUrl,
        api_key: ocKey,
        vision_model: ocModel
      });

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

    // Live Logs Polling
    function setupLogsPolling() {
      let lastTotal = 0;
      setInterval(async () => {
        try {
          const r = await fetch('/api/logs/poll?since=' + lastTotal);
          const d = await r.json();
          if (d.total > lastTotal) {
            const newEntries = d.entries.slice(-(d.total - lastTotal));
            for (const log of newEntries) {
              appendLogLine(log.time, log.tag, log.text, log.level);
            }
            lastTotal = d.total;
          }
        } catch {}
      }, 1000);
      appendLogLine('[System]', 'INFO', currentLang === 'zh' ? '日志轮询已启动' : 'Log polling started', 'info');
    }

    function appendLogLine(time, tag, text, level) {
      const container = document.getElementById('console-logs');
      const line = document.createElement('div');
      line.className = \`log-line log-${'$'}{level || 'info'}\`;
      
      line.innerHTML = \`
        <span class="log-time">${'$'}{time}</span>
        <span class="log-tag">[${'$'}{tag}]</span>
        <span class="log-text">${'$'}{escapeHtml(text)}</span>
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

    function toggleCustomFields() {
      const sttEngine = document.getElementById('stt-engine').value;
      const ttsEngine = document.getElementById('tts-engine').value;
      
      document.getElementById('custom-stt-fields').style.display = sttEngine === 'openai-compatible' ? 'flex' : 'none';
      document.getElementById('custom-tts-fields').style.display = (ttsEngine === 'openai-compatible' || ttsEngine === 'minimax') ? 'flex' : 'none';
    }

    // Load Voice Settings
    async function loadVoiceSettings() {
      try {
        const response = await fetch('/api/voice-settings');
        const data = await response.json();
        
        document.getElementById('stt-engine').value = data.stt_engine || 'local-whisper';
        document.getElementById('stt-api-key').value = data.stt_api_key || '';
        document.getElementById('stt-base-url').value = data.stt_base_url || 'https://api.openai.com/v1';
        document.getElementById('stt-model').value = data.stt_model || 'whisper-1';
        
        document.getElementById('tts-engine').value = data.tts_engine || 'edge-tts';
        document.getElementById('tts-api-key').value = data.tts_api_key || '';
        document.getElementById('tts-base-url').value = data.tts_base_url || 'https://api.openai.com/v1';
        document.getElementById('tts-model').value = data.tts_model || 'tts-1';
        
        document.getElementById('tts-voice').value = data.tts_voice || 'zh-CN-XiaoxiaoNeural';
        document.getElementById('vad-threshold').value = data.vad_threshold !== undefined ? data.vad_threshold : -42.0;
        document.getElementById('vad-duration').value = data.vad_duration !== undefined ? data.vad_duration : 1.5;
        document.getElementById('voice-llm-model').value = data.voice_llm_model || '';
        document.getElementById('enable-wake-word').checked = !!data.enable_wake_word;
        
        toggleCustomFields();
      } catch (err) {
        showToast(currentLang === 'zh' ? '加载语音设置失败' : 'Failed to load voice settings', true);
      }
    }

    // Save Voice Settings
    document.getElementById('voice-form').onsubmit = async (e) => {
      e.preventDefault();
      
      const stt_engine = document.getElementById('stt-engine').value;
      const stt_api_key = document.getElementById('stt-api-key').value.trim();
      const stt_base_url = document.getElementById('stt-base-url').value.trim();
      const stt_model = document.getElementById('stt-model').value.trim();
      
      const tts_engine = document.getElementById('tts-engine').value;
      const tts_api_key = document.getElementById('tts-api-key').value.trim();
      const tts_base_url = document.getElementById('tts-base-url').value.trim();
      const tts_model = document.getElementById('tts-model').value.trim();
      
      const tts_voice = document.getElementById('tts-voice').value.trim();
      const vad_threshold = parseFloat(document.getElementById('vad-threshold').value.trim() || '-42.0');
      const vad_duration = parseFloat(document.getElementById('vad-duration').value.trim() || '1.5');
      const voice_llm_model = document.getElementById('voice-llm-model').value;
      const enable_wake_word = document.getElementById('enable-wake-word').checked;
      
      if (isNaN(vad_threshold) || isNaN(vad_duration)) {
        showToast(currentLang === 'zh' ? '数字格式无效' : 'Invalid number format', true);
        return;
      }
      
      try {
        const response = await fetch('/api/voice-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stt_engine,
            stt_api_key,
            stt_base_url,
            stt_model,
            tts_engine,
            tts_api_key,
            tts_base_url,
            tts_model,
            tts_voice,
            vad_threshold,
            vad_duration,
            voice_llm_model,
            enable_wake_word
          })
        });
        
        if (response.ok) {
          showToast(i18nDict[currentLang].toastVoiceSaved);
          loadVoiceSettings();
        } else {
          showToast(i18nDict[currentLang].toastVoiceFailed, true);
        }
      } catch (err) {
        showToast(i18nDict[currentLang].toastConnFailed, true);
      }
    };

    document.getElementById('stt-engine').addEventListener('change', toggleCustomFields);
    document.getElementById('tts-engine').addEventListener('change', toggleCustomFields);



    let voiceBarOnline = false;

    async function checkVoiceBarStatus() {
      try {
        const response = await fetch('/api/voice-bar/status');
        const data = await response.json();
        const badge = document.getElementById('voice-bar-status-badge');
        if (badge) {
          if (data.running) {
            badge.innerText = currentLang === 'zh' ? '在线 (运行中)' : 'Online';
            badge.style.color = 'var(--color-success)';
            badge.style.background = 'rgba(16, 185, 129, 0.1)';
            badge.style.borderColor = 'rgba(16, 185, 129, 0.2)';
            voiceBarOnline = true;
          } else {
            badge.innerText = currentLang === 'zh' ? '离线' : 'Offline';
            badge.style.color = '#ef4444';
            badge.style.background = 'rgba(239, 68, 68, 0.1)';
            badge.style.borderColor = 'rgba(239, 68, 68, 0.2)';
            voiceBarOnline = false;
          }
        }
      } catch (err) {}
    }

    function setupVoiceBarPolling() {
      checkVoiceBarStatus();
      setInterval(checkVoiceBarStatus, 3000);
    }

    async function launchVoiceBar(method) {
      showToast(i18nDict[currentLang].toastVoiceBarLaunching || 'Launching...');
      
      const btnSwift = document.getElementById('i18n-btn-launch-voice-bar');
      const btnApp = document.getElementById('i18n-btn-launch-voice-bar-app');
      
      if (btnSwift) { btnSwift.disabled = true; btnSwift.style.opacity = '0.5'; }
      if (btnApp) { btnApp.disabled = true; btnApp.style.opacity = '0.5'; }
      
      try {
        const response = await fetch('/api/voice-bar/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method })
        });
        
        if (response.ok) {
          setTimeout(async () => {
            await checkVoiceBarStatus();
            if (btnSwift) { btnSwift.disabled = false; btnSwift.style.opacity = '1'; }
            if (btnApp) { btnApp.disabled = false; btnApp.style.opacity = '1'; }
            
            showToast(currentLang === 'zh' ? '语音助手启动指令已发送！' : 'Voice Assistant launch command sent!');
          }, 1500);
        } else {
          showToast(i18nDict[currentLang].toastVoiceBarFailed || 'Launch failed', true);
          if (btnSwift) { btnSwift.disabled = false; btnSwift.style.opacity = '1'; }
          if (btnApp) { btnApp.disabled = false; btnApp.style.opacity = '1'; }
        }
      } catch (err) {
        showToast(i18nDict[currentLang].toastConnFailed, true);
        if (btnSwift) { btnSwift.disabled = false; btnSwift.style.opacity = '1'; }
        if (btnApp) { btnApp.disabled = false; btnApp.style.opacity = '1'; }
      }
    }

    // Initial Load
    window.onload = async () => {
      try { setLanguage('zh'); } catch {}
      loadConfig();
      await loadModels();
      await loadVoiceSettings();
      setupLogsPolling();
      setupVoiceBarPolling();
    };
  </script>
</body>
</html>
`;
}
