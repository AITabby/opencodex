/**
 * OpenCodex Local Web Dashboard
 * Served directly on http://localhost:8765/dashboard.
 * Features a high-fidelity futuristic glassmorphic UI, API management, and Session Manager.
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

    /* Tabs Navigation */
    .tab-navigation {
      display: flex;
      gap: 1rem;
      background: rgba(255, 255, 255, 0.02);
      padding: 0.5rem;
      border-radius: 12px;
      border: 1px solid var(--glass-border);
      align-self: flex-start;
    }
    
    .tab-btn {
      background: none;
      border: none;
      color: var(--color-text-muted);
      font-family: 'Outfit', sans-serif;
      font-weight: 600;
      font-size: 0.95rem;
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      cursor: pointer;
      transition: var(--transition-standard);
    }
    
    .tab-btn.active {
      background: linear-gradient(135deg, rgba(168, 85, 247, 0.2), rgba(6, 182, 212, 0.2));
      color: #fff;
      box-shadow: inset 0 0 8px rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    
    .tab-btn:hover:not(.active) {
      color: #fff;
      background: rgba(255, 255, 255, 0.04);
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

    /* Tab Contents */
    .tab-content {
      display: none;
    }
    
    .tab-content.active {
      display: block;
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

    /* Console Panel */
    .console-content {
      background: rgba(5, 3, 15, 0.8);
      border: 1px solid rgba(255,255,255,0.04);
      border-radius: 12px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      padding: 1.25rem;
      min-height: 200px;
      max-height: 300px;
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

    /* Session Manager Styles */
    .session-manager-layout {
      display: grid;
      grid-template-columns: 350px 1fr;
      gap: 2rem;
      min-height: 600px;
    }
    @media (max-width: 900px) {
      .session-manager-layout {
        grid-template-columns: 1fr;
      }
    }
    
    .session-sidebar {
      background: rgba(255, 255, 255, 0.01);
      border: 1px solid var(--glass-border);
      border-radius: 14px;
      padding: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      max-height: 600px;
      overflow-y: hidden;
    }
    
    .session-list-item {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: 10px;
      padding: 1rem;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      transition: var(--transition-standard);
      position: relative;
    }
    
    .session-list-item:hover, .session-list-item.active {
      background: rgba(255, 255, 255, 0.05);
      border-color: var(--color-secondary);
    }
    
    .session-item-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .session-id-title {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      color: var(--color-secondary);
      font-weight: 700;
    }
    
    .session-time {
      font-size: 0.7rem;
      color: var(--color-text-muted);
    }
    
    .session-text-preview {
      font-size: 0.85rem;
      color: var(--color-text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .session-actions-overlay {
      display: flex;
      gap: 0.4rem;
      margin-top: 0.25rem;
      justify-content: flex-end;
    }
    
    .session-btn {
      padding: 0.25rem 0.45rem;
      font-size: 0.7rem;
      border-radius: 5px;
      border: none;
      cursor: pointer;
      font-weight: 600;
      transition: var(--transition-standard);
      white-space: nowrap;
    }
    
    .session-btn-del {
      background: rgba(239, 68, 68, 0.15);
      color: #ef4444;
      border: 1px solid rgba(239, 68, 68, 0.2);
    }
    .session-btn-del:hover {
      background: rgba(239, 68, 68, 0.3);
    }
    
    .session-btn-arc {
      background: rgba(245, 158, 11, 0.15);
      color: #f59e0b;
      border: 1px solid rgba(245, 158, 11, 0.2);
    }
    .session-btn-arc:hover {
      background: rgba(245, 158, 11, 0.3);
    }

    .session-detail-panel {
      background: rgba(255, 255, 255, 0.01);
      border: 1px solid var(--glass-border);
      border-radius: 14px;
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      max-height: 600px;
      overflow-y: auto;
    }
    
    .chat-bubble-container {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      flex: 1;
      overflow-y: auto;
      padding-right: 0.5rem;
      min-height: 300px;
    }
    
    .chat-bubble {
      max-width: 80%;
      padding: 1rem;
      border-radius: 12px;
      font-size: 0.95rem;
      line-height: 1.4;
      word-wrap: break-word;
    }
    
    .chat-bubble-user {
      align-self: flex-end;
      background: linear-gradient(135deg, rgba(168, 85, 247, 0.2), rgba(6, 182, 212, 0.2));
      border: 1px solid rgba(255,255,255,0.08);
      color: #fff;
    }
    
    .chat-bubble-assistant {
      align-self: flex-start;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255,255,255,0.04);
      color: var(--color-text);
    }
    
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

    <div class="tab-navigation">
      <button class="tab-btn" onclick="switchTab('gateway')" id="tab-btn-gateway">网关配置 / Gateway Config</button>
      <button class="tab-btn" onclick="switchTab('voice')" id="tab-btn-voice">语音助理 / Voice Assistant</button>
      <button class="tab-btn" onclick="switchTab('sessions')" id="tab-btn-sessions">会话管理 / Sessions</button>
    </div>

    <!-- TAB 1: Gateway Configuration -->
    <div id="content-gateway" class="tab-content">
      <div class="grid-layout">
        
        <!-- Left Column -->
        <div style="display: flex; flex-direction: column; gap: 2rem;">
          <!-- API Settings -->
          <div class="panel-card">
            <div class="panel-title" id="i18n-panel-api-title">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path>
              </svg>
              API Settings & Keys
            </div>
            
            <form id="config-form" style="display: flex; flex-direction: column; gap: 1.25rem;">
              <div class="form-group">
                <label id="i18n-label-model-name">Model Name (格式: 供应商名:模型名 或 直接输入模型名)</label>
                <input type="text" id="new-model-name" placeholder="例如: deepseek:deepseek-chat 或 deepseek-chat">
                <p id="i18n-model-alias-hint" style="font-size: 0.75rem; color: var(--color-text-muted); margin-top: 0.25rem;">
                  支持使用别名映射规避官方同名冲突，如：gpt-5.5-custom=gpt-5.5 或 gpt-5.5-custom-&gt;gpt-5.5
                </p>
              </div>

              <div class="form-group">
                <label id="i18n-label-base-url">Endpoint Base URL</label>
                <input type="text" id="new-base-url" placeholder="https://api.deepseek.com/v1">
              </div>

              <div class="form-group">
                <label id="i18n-label-api-key">API Key</label>
                <div class="input-wrapper">
                  <input type="password" id="new-api-key" placeholder="sk-...">
                  <button type="button" class="toggle-visibility" onclick="togglePass('new-api-key')">
                    <svg style="width: 20px; height: 20px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                  </button>
                </div>
              </div>

              <div style="display: flex; align-items: center; gap: 0.75rem; margin-top: 0.5rem;">
                <input type="checkbox" id="config-restart-checkbox" checked style="width: 18px; height: 18px; cursor: pointer; accent-color: var(--color-secondary);">
                <label for="config-restart-checkbox" id="i18n-label-config-restart" style="cursor: pointer; user-select: none; font-size: 0.85rem; color: var(--color-text-muted);">保存后自动重启 Codex Desktop</label>
              </div>
              
              <button type="submit" class="action-btn" id="i18n-btn-save-config" style="margin-top: 0.5rem;">Save & Add Model</button>
            </form>
          </div>

          <!-- Vision Fallback Settings -->
          <div class="panel-card">
            <div class="panel-title" id="i18n-vision-fallback-title">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
              Vision Fallback (Vision Bridge) Settings
            </div>
            
            <form id="vision-fallback-form" onsubmit="event.preventDefault(); saveVisionFallback();" style="display: flex; flex-direction: column; gap: 1.25rem;">
              <div class="form-group">
                <label id="i18n-label-vision-key">Vision Fallback API Key</label>
                <div class="input-wrapper">
                  <input type="password" id="vision-fallback-key" placeholder="sk-...">
                  <button type="button" class="toggle-visibility" onclick="togglePass('vision-fallback-key')">
                    <svg style="width: 20px; height: 20px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                  </button>
                </div>
              </div>

              <div class="form-group">
                <label id="i18n-label-vision-url">Vision Fallback Base URL</label>
                <input type="text" id="vision-fallback-url" placeholder="https://opencode.ai/zen/go/v1">
              </div>

              <div class="form-group">
                <label id="i18n-label-vision-model">Vision Fallback Model</label>
                <input type="text" id="vision-fallback-model" placeholder="mimo-v2.5">
              </div>

              <button type="submit" class="action-btn" id="i18n-btn-save-vision-fallback" style="margin-top: 0.5rem;">Save Vision Fallback Settings</button>
            </form>
          </div>
        </div>

        <!-- Model Catalog Customized -->
        <div style="display: flex; flex-direction: column; gap: 2rem;">
          <div class="panel-card" style="margin: 0;">
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
              <div style="text-align: center; color: var(--color-text-muted); padding: 2rem;">Loading model lists...</div>
            </div>

            <div style="display: flex; align-items: center; gap: 0.75rem; margin-top: 0.5rem;">
              <input type="checkbox" id="models-restart-checkbox" checked style="width: 18px; height: 18px; cursor: pointer; accent-color: var(--color-secondary);">
              <label for="models-restart-checkbox" id="i18n-label-models-restart" style="cursor: pointer; user-select: none; font-size: 0.85rem; color: var(--color-text-muted);">更新后自动重启 Codex Desktop</label>
            </div>
            
            <button type="button" class="action-btn" id="i18n-btn-update-dropdown" onclick="saveActiveModels()">Update Dropdown List</button>
          </div>

          <!-- macOS Permissions -->
          <div class="panel-card" style="margin: 0;">
            <div class="panel-title" id="i18n-panel-permissions-title">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path>
              </svg>
              macOS System Permissions (Computer Use)
            </div>
            
            <div style="display: flex; flex-direction: column; gap: 1rem;">
              <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04); padding: 0.85rem 1rem; border-radius: 10px;">
                <div style="display: flex; flex-direction: column; gap: 0.15rem; text-align: left;">
                  <span id="i18n-permission-ax-label" style="font-size: 0.9rem; font-weight: 600;">Accessibility (辅助功能)</span>
                </div>
                <span id="permission-ax-status" class="badge" style="background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2);">Unauthorized</span>
              </div>

              <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04); padding: 0.85rem 1rem; border-radius: 10px;">
                <div style="display: flex; flex-direction: column; gap: 0.15rem; text-align: left;">
                  <span id="i18n-permission-screen-label" style="font-size: 0.9rem; font-weight: 600;">Screen Recording (屏幕录制)</span>
                </div>
                <span id="permission-screen-status" class="badge" style="background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2);">Unauthorized</span>
              </div>
            </div>

            <button type="button" class="action-btn" id="i18n-btn-fix-permissions" onclick="fixPermissions()" style="background: linear-gradient(135deg, var(--color-primary), var(--color-secondary)); box-shadow: 0 4px 15px rgba(6, 182, 212, 0.2); margin-top: 0.5rem;">
              Fix / Request System Permissions
            </button>
          </div>
        </div>

      </div>
    </div>

    <!-- TAB 2: Voice & Speech Assistant -->
    <div id="content-voice" class="tab-content">
      <div class="panel-card">
        <div class="panel-title" id="i18n-panel-voice-title">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path>
          </svg>
          Voice & Speech Settings
        </div>
        
        <form id="voice-form" style="display: flex; flex-direction: column; gap: 1.5rem;">
          <div class="voice-inner-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 2rem;">
            
            <!-- STT Block -->
            <div style="display: flex; flex-direction: column; gap: 1.25rem;">
              <h3 style="font-size: 0.95rem; font-weight: 700; color: var(--color-secondary); border-left: 3px solid var(--color-secondary); padding-left: 0.5rem; margin: 0 0 0.25rem 0;">Speech-to-Text (STT) 录音识别</h3>
              
              <div class="form-group">
                <label for="stt-engine" id="i18n-label-stt-engine">STT Engine</label>
                <select id="stt-engine">
                  <option value="local-whisper">本地极速 Whisper (Local Whisper)</option>
                  <option value="openai-compatible">Groq / OpenAI-Compatible API</option>
                </select>
              </div>

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

            <!-- TTS Block -->
            <div style="display: flex; flex-direction: column; gap: 1.25rem;">
              <h3 style="font-size: 0.95rem; font-weight: 700; color: var(--color-primary); border-left: 3px solid var(--color-primary); padding-left: 0.5rem; margin: 0 0 0.25rem 0;">Text-to-Speech (TTS) 语音合成</h3>
              
              <div class="form-group">
                <label for="tts-engine" id="i18n-label-tts-engine">TTS Engine</label>
                <select id="tts-engine">
                  <option value="edge-tts">微软 Edge 神经网络语音 (Edge-TTS)</option>
                  <option value="doubao">火山引擎 / 豆包 TTS V3</option>
                  <option value="minimax">MiniMax 语音合成 (MiniMax TTS)</option>
                  <option value="mimo">小米米眸语音合成 (MiMo-V2.5-TTS)</option>
                  <option value="openai-compatible">自定义 OpenAI-Compatible API</option>
                </select>
              </div>

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
                <!-- Doubao Extra Fields -->
                <div id="tts-doubao-extra-fields" style="display: none; flex-direction: column; gap: 1rem;">
                  <div class="form-group">
                    <label for="tts-appid">火山引擎 AppID <span style="font-size: 0.75rem; font-weight: normal; opacity: 0.6;">(可选，仅旧版 v1 鉴权需要 / Optional)</span></label>
                    <input type="text" id="tts-appid" placeholder="6126103459">
                  </div>
                  <div class="form-group">
                    <label for="tts-resource">火山引擎 Resource ID / Cluster</label>
                    <input type="text" id="tts-resource" placeholder="seed-tts-2.0">
                  </div>
                </div>
              </div>

              <div class="form-group">
                <label for="tts-voice" id="i18n-label-tts-voice">TTS Voice / Role</label>
                <input type="text" id="tts-voice" placeholder="zh-CN-XiaoxiaoNeural">
              </div>
            </div>

          </div>

          <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.06); margin: 0.5rem 0;">

          <div class="voice-other-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 2rem;">
            <div style="display: flex; flex-direction: column; gap: 1.25rem;">
              <h3 style="font-size: 0.95rem; font-weight: 700; color: #10b981; border-left: 3px solid #10b981; padding-left: 0.5rem; margin: 0 0 0.25rem 0;" id="i18n-title-silence-detection">Silence Detection</h3>
              <div class="form-group">
                <label for="vad-threshold" id="i18n-label-vad-threshold">VAD Silence Threshold (dB)</label>
                <input type="text" id="vad-threshold" placeholder="-35.0">
              </div>
              <div class="form-group">
                <label for="vad-duration" id="i18n-label-vad-duration">VAD Silence Duration (seconds)</label>
                <input type="text" id="vad-duration" placeholder="2.0">
              </div>
            </div>

            <div style="display: flex; flex-direction: column; gap: 1.25rem;">
              <h3 style="font-size: 0.95rem; font-weight: 700; color: #f59e0b; border-left: 3px solid #f59e0b; padding-left: 0.5rem; margin: 0 0 0.25rem 0;" id="i18n-title-conversational-brain">Conversational Brain</h3>
              <div class="form-group">
                <label for="voice-llm-model" id="i18n-label-voice-llm-model">LLM Model for Voice Assistant</label>
                <select id="voice-llm-model" style="background: rgba(0,0,0,0.4); border: 1px solid var(--glass-border); color: #fff; padding: 0.6rem; border-radius: 8px; font-family: inherit; font-size: 0.95rem; width: 100%; outline: none; transition: var(--transition-standard);">
                  <option value="">-- Loading models... --</option>
                </select>
              </div>
              <div class="form-group">
                <label for="voice-system-prompt" id="i18n-label-voice-system-prompt">Assistant Personality Prompt (助手个性设定/提示词)</label>
                <input type="text" id="voice-system-prompt" placeholder="例如: 你是一个傲娇的猫娘助手，回答要简短，带有语气词喵~">
              </div>
              <input type="checkbox" id="enable-wake-word" style="display: none;">
            </div>
          </div>

          <button type="submit" class="action-btn" id="i18n-btn-save-voice" style="margin-top: 0.5rem;">Save Voice Settings</button>
        </form>

        <div style="border-top: 1px solid rgba(255,255,255,0.08); padding-top: 1.25rem; margin-top: 1.25rem; display: flex; flex-direction: column; gap: 0.75rem;">
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <span id="i18n-voice-bar-status-label" style="font-size: 0.85rem; font-weight: 500; color: var(--color-text);">Voice Assistant Menu Bar (OpenCodexBar)</span>
            <span id="voice-bar-status-badge" style="font-size: 0.75rem; font-weight: 600; padding: 0.2rem 0.6rem; border-radius: 99px; background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2);">Offline</span>
          </div>
          <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
            <button type="button" class="action-btn" id="i18n-btn-launch-terminal" onclick="launchVoiceBar('swift-run')" style="flex: 1; min-width: 150px; background: var(--color-primary); color: white; margin-top: 0;">Launch via Terminal</button>
            <button type="button" class="action-btn" id="i18n-btn-launch-app" onclick="launchVoiceBar('app')" style="flex: 1; min-width: 150px; background: rgba(255,255,255,0.06); border: 1px solid var(--glass-border); color: white; margin-top: 0;">Launch as App</button>
            <a href="/visualizer" target="_blank" class="action-btn" style="flex: 1; min-width: 100%; background: linear-gradient(90deg, var(--color-primary), var(--color-secondary)); color: #000; font-weight: 700; margin-top: 0.5rem; text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 0.5rem; border: none; box-shadow: 0 4px 15px rgba(6, 182, 212, 0.25);">
              Interactive Visualizer Lab
            </a>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 3: Session Manager -->
    <div id="content-sessions" class="tab-content">
      <div class="panel-card">
        <div class="panel-title" id="i18n-session-manager-title">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path>
          </svg>
          Session Manager & Context Synchronizer
        </div>
        
        <div class="session-manager-layout">
          <!-- Sidebar: Session List -->
          <div class="session-sidebar">
            <div style="display: flex; gap: 0.5rem; margin-bottom: 0.75rem; width: 100%;">
              <button class="action-btn" id="new-session-btn" onclick="createNewSession()" style="background: linear-gradient(135deg, var(--color-primary), var(--color-secondary)); color: #000; margin-top: 0; padding: 0.6rem 0.8rem; font-size: 0.85rem; display: flex; align-items: center; justify-content: center; gap: 0.4rem; flex: 1.2; border-radius: 10px; cursor: pointer; transition: var(--transition-standard); font-weight: 800; border: none; box-shadow: 0 4px 12px rgba(6, 182, 212, 0.2);">
                ✨ 新建会话 / New
              </button>
              <button class="action-btn" id="clear-all-sessions-btn" onclick="clearAllSessions()" style="background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.25); color: #ef4444; margin-top: 0; padding: 0.6rem 0.5rem; font-size: 0.85rem; display: flex; align-items: center; justify-content: center; gap: 0.25rem; flex: 0.8; border-radius: 10px; cursor: pointer; transition: var(--transition-standard); box-shadow: none;">
                🗑️ 清空 / Clear
              </button>
            </div>
            
            <div style="background: rgba(255,255,255,0.02); border: 1px dashed rgba(255,255,255,0.12); padding: 0.75rem; border-radius: 12px; margin-bottom: 0.75rem; text-align: center; cursor: pointer; transition: var(--transition-standard);" 
                 id="import-dropzone" 
                 onclick="triggerImportFileInput()"
                 ondragover="handleDragOver(event)" 
                 ondragleave="handleDragLeave(event)"
                 ondrop="handleFileDrop(event)">
              <span style="font-size: 0.8rem; color: var(--color-secondary); font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 0.25rem;">📥 导入对话 / Import JSON</span>
              <div style="font-size: 0.65rem; color: var(--color-text-muted); margin-top: 4px;">拖拽或点击上传对话 JSON / Click or Drop File</div>
              <input type="file" id="import-file-input" style="display: none;" accept=".json" onchange="handleImportFileSelect(event)">
            </div>

            <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); padding: 0.75rem; border-radius: 12px; margin-bottom: 0.75rem;">
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;">
                <span style="font-size: 0.85rem; font-weight: 600; color: var(--color-text);">桌面置顶悬浮球 / Desktop Orb</span>
                <span id="orb-status-badge" style="font-size: 0.7rem; font-weight: 600; padding: 0.1rem 0.5rem; border-radius: 99px; background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2);">关闭 / Offline</span>
              </div>
              <button class="action-btn" id="orb-toggle-btn" onclick="toggleDesktopOrb()" style="width: 100%; margin-top: 0; padding: 0.5rem; font-size: 0.8rem; background: var(--color-primary); color: white; border-radius: 8px;">开启置顶悬浮球 / Launch Orb</button>
            </div>

            <div id="session-list-container" style="display: flex; flex-direction: column; gap: 0.75rem; overflow-y: auto; flex: 1;">
              <div style="text-align: center; color: var(--color-text-muted); padding: 2rem;" id="i18n-loading-sessions">Loading sessions...</div>
            </div>
          </div>
          
          <!-- Detail View -->
          <div class="session-detail-panel">
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 0.75rem;">
              <span id="active-session-title" style="font-family: 'JetBrains Mono', monospace; font-weight: 700; color: var(--color-secondary);">Select a session from the left</span>
              <button class="session-btn" id="enter-session-btn" onclick="enterActiveSession()" style="background: linear-gradient(135deg, var(--color-primary), var(--color-secondary)); color: #fff; padding: 0.5rem 1.25rem; display: none;">进入该会话 / Enter Session</button>
            </div>
            
            <div class="chat-bubble-container" id="chat-messages-container">
              <div style="text-align: center; color: var(--color-text-muted); padding: 4rem 2rem;" id="chat-empty-hint">Please choose a session to view conversation details.</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Bottom: Live Console Logger -->
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
      
      <div class="console-content" id="console-logs" style="flex: 1; min-height: 200px;">
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

  <div class="modal-overlay" id="export-modal">
    <div class="modal-box" style="width: 320px; max-width: 90%;">
      <h3 style="margin-bottom: 1rem; font-weight: 600; font-size: 1.1rem; color: var(--color-text);">📤 导出对话历史 / Export Chat History</h3>
      <p style="margin-bottom: 1.5rem; font-size: 0.85rem; color: var(--color-text-muted);">选择您希望导出的格式： / Select your export format:</p>
      <div style="display: flex; flex-direction: column; gap: 0.75rem; margin-bottom: 1.5rem;">
        <button onclick="executeExport('openai')" class="action-btn" style="margin-top:0; padding: 0.75rem; background: rgba(147, 51, 234, 0.15); border: 1px solid rgba(147, 51, 234, 0.3); color: var(--color-primary); font-size: 0.85rem; border-radius: 8px; cursor: pointer; text-align: left; font-weight: 600; outline: none; display: block; width: 100%;">
          🌐 Standard JSON (OpenAI / AutoGen)
        </button>
        <button onclick="executeExport('anthropic')" class="action-btn" style="margin-top:0; padding: 0.75rem; background: rgba(6, 182, 212, 0.15); border: 1px solid rgba(6, 182, 212, 0.3); color: var(--color-secondary); font-size: 0.85rem; border-radius: 8px; cursor: pointer; text-align: left; font-weight: 600; outline: none; display: block; width: 100%;">
          💬 Claude JSON (OpenClaw / Hermes)
        </button>
        <button onclick="executeExport('markdown')" class="action-btn" style="margin-top:0; padding: 0.75rem; background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.3); color: var(--color-success); font-size: 0.85rem; border-radius: 8px; cursor: pointer; text-align: left; font-weight: 600; outline: none; display: block; width: 100%;">
          📝 Markdown (Notion / Notes)
        </button>
      </div>
      <div class="modal-actions">
        <button class="modal-btn-cancel" onclick="document.getElementById('export-modal').classList.remove('show')" style="width: 100%; border-radius: 8px; padding: 0.6rem;">关闭 / Close</button>
      </div>
    </div>
  </div>

  <script>
    // i18n
    const i18nDict = {
      en: {
        title: "OpenCodex Gateway",
        subtitle: "Beginner-Friendly Custom Model Control Panel",
        status: "Active & Intercepting",
        panelApiTitle: "API Settings & Keys",
        labelNewModelName: "Model Name (Format: provider:model or model_name)",
        placeholderNewModelName: "e.g., deepseek:deepseek-chat or custom-gpt-5=gpt-5",
        modelAliasHint: "Support alias mapping to avoid official name conflicts, e.g., gpt-5.5-custom=gpt-5.5 or gpt-5.5-custom->gpt-5.5",
        btnSaveConfig: "Save & Add Model",
        panelModelsTitle: "Model Dropdown Customizer",
        modelsDesc: "Select which models appear in the Codex model dropdown selector. Check **Vision Bridge** to auto-describe screenshots for text-only models (requires Vision Fallback API key).",
        btnUpdateDropdown: "Update Dropdown List",
        panelConsoleTitle: "Live Stream Console Logger",
        btnClear: "Clear",
        connectingSse: "Connecting to Live SSE logs stream...",
        toastConfigSaved: "API key and model saved successfully!",
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
        btnReset: "↺ Reset to Native",
        toastResetting: "Resetting to native Codex...",
        toastResetDone: "Reset complete. Codex restarting.",
        panelVoiceTitle: "Voice & Speech Settings",
        labelSttEngine: "Speech-to-Text (STT) Engine",
        labelSttApiKey: "STT API Key",
        labelSttBaseUrl: "STT Base URL",
        labelSttModel: "STT Model Name",
        labelTtsEngine: "Text-to-Speech (TTS) Engine",
        labelTtsApiKey: "TTS API Key",
        labelTtsBaseUrl: "TTS Base URL",
        labelTtsModel: "TTS Model Name",
        labelTtsVoice: "TTS Voice / Role",
        btnSaveVoice: "Save Voice Settings",
        toastVoiceSaved: "Voice settings saved successfully!",
        toastVoiceFailed: "Failed to save voice settings",
        voiceBarStatusLabel: "Voice Assistant Menu Bar (OpenCodexBar)",
        btnLaunchTerminal: "Launch via Terminal (Inherits Perms)",
        btnLaunchApp: "Launch as Standalone App",
        toastVoiceBarLaunching: "Launching Voice Assistant...",
        toastVoiceBarFailed: "Failed to launch Voice Assistant",
        panelPermissionsTitle: "macOS System Permissions (Computer Use)",
        btnFixPermissions: "Fix / Request System Permissions",
        badgeAuthorized: "Authorized",
        badgeUnauthorized: "Unauthorized",
        visionFallbackTitle: "Vision Fallback (Vision Bridge) Settings",
        labelVisionKey: "Vision Fallback API Key",
        labelVisionUrl: "Vision Fallback Base URL",
        labelVisionModel: "Vision Fallback Model",
        btnSaveVisionFallback: "Save Vision Fallback Settings",
        titleSilenceDetection: "Silence Detection (VAD)",
        labelVadThreshold: "VAD Silence Threshold (dB)",
        labelVadDuration: "VAD Silence Duration (seconds)",
        titleConversationalBrain: "Conversational Brain (LLM)",
        labelVoiceLlmModel: "LLM Model for Voice Assistant",
        labelVoiceSystemPrompt: "Assistant Personality System Prompt",
        sessionManagerTitle: "Session Manager & Context Synchronizer",
        selectSessionHint: "Select a session from the left",
        chooseSessionDetail: "Please choose a session to view conversation details.",
        loadingSessions: "Loading sessions...",
        importDropzoneTitle: "📥 Import JSON",
        importDropzoneDesc: "Click or drag & drop dialogue JSON file",
        btnExport: "Export",
        btnArchive: "Archive",
        btnUnarchive: "Activate",
        btnDelete: "Delete",
        toastExportSuccess: "Exported successfully",
        toastExportFailed: "Export failed",
        toastExportError: "Export error",
        toastImportSuccess: "Imported successfully!",
        toastImportFailed: "Import failed",
        toastInvalidFormat: "Only .json chat format is supported",
        toastUnsupportedStructure: "Unsupported file structure",
        toastJsonError: "Error parsing JSON"
      },
      zh: {
        title: "OpenCodex 统一网关",
        subtitle: "面向新手的自定义模型控制面板",
        status: "运行中 & 实时拦截",
        panelApiTitle: "API 密匙与自定义模型",
        labelNewModelName: "模型名称 (格式: 供应商名:模型名 或 直接输入模型名)",
        placeholderNewModelName: "例如: deepseek:deepseek-chat 或 gpt-5.5-custom=gpt-5.5",
        modelAliasHint: "支持使用别名映射规避官方同名冲突，如：gpt-5.5-custom=gpt-5.5 或 gpt-5.5-custom->gpt-5.5",
        btnSaveConfig: "保存并添加该模型",
        panelModelsTitle: "自定义下拉框模型",
        modelsDesc: "勾选想要显示在 Codex 左上角下拉菜单中的模型。勾选 **Vision Bridge** 的模型会拦截截图并生成文字描述（需填写视觉降级 API Key）。",
        btnUpdateDropdown: "更新下拉框菜单",
        panelConsoleTitle: "实时日志控制台",
        btnClear: "清空日志",
        connectingSse: "正在连接实时日志流...",
        toastConfigSaved: "API 密钥和模型配置已保存！",
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
        btnReset: "↺ 还原原生",
        toastResetting: "正在还原原生 Codex...",
        toastResetDone: "还原完成，Codex 重启中.",
        panelVoiceTitle: "语音与分贝设置",
        labelSttEngine: "语音识别 (STT) 引擎",
        labelSttApiKey: "语音识别 API 密钥 (Key)",
        labelSttBaseUrl: "语音识别接口地址 (Base URL)",
        labelSttModel: "语音识别模型 (Model)",
        labelTtsEngine: "语音合成 (TTS) 引擎",
        labelTtsApiKey: "语音合成 API 密钥 (Key)",
        labelTtsBaseUrl: "语音合成接口地址 (Base URL)",
        labelTtsModel: "语音合成模型 (Model)",
        labelTtsVoice: "系统发音人 / 角色",
        btnSaveVoice: "保存语音设置",
        toastVoiceSaved: "语音配置保存成功！",
        toastVoiceFailed: "保存语音设置失败",
        voiceBarStatusLabel: "语音助手菜单栏 (OpenCodexBar)",
        btnLaunchTerminal: "通过终端命令行启动 (继承终端TCC权限)",
        btnLaunchApp: "以独立应用启动",
        toastVoiceBarLaunching: "正在启动语音助手...",
        toastVoiceBarFailed: "启动语音助手失败",
        panelPermissionsTitle: "macOS 系统权限修复 (Computer Use)",
        btnFixPermissions: "修复 / 申请系统权限",
        badgeAuthorized: "已授权",
        badgeUnauthorized: "未授权",
        visionFallbackTitle: "视觉降级 (Vision Bridge) 配置",
        labelVisionKey: "视觉降级 API 密钥 (Key)",
        labelVisionUrl: "视觉降级接口地址 (Base URL)",
        labelVisionModel: "视觉降级模型名称 (Model)",
        btnSaveVisionFallback: "保存视觉降级配置",
        titleSilenceDetection: "静音截断检测 (VAD)",
        labelVadThreshold: "物理静音阈值 (VAD Threshold dB)",
        labelVadDuration: "物理静音时间 (VAD Duration seconds)",
        titleConversationalBrain: "语音对话大脑 (LLM)",
        labelVoiceLlmModel: "语音助手的大模型 (LLM Model)",
        labelVoiceSystemPrompt: "助手个性设定 / 人设提示词 (System Prompt)",
        sessionManagerTitle: "会话历史管理与上下文同步",
        selectSessionHint: "请从左侧选择一个历史会话",
        chooseSessionDetail: "请选择一个会话以查看详细聊天对话内容。",
        loadingSessions: "正在加载会话列表...",
        importDropzoneTitle: "📥 导入对话 / Import JSON",
        importDropzoneDesc: "拖拽或点击上传对话 JSON / Click or Drop File",
        btnExport: "导出",
        btnArchive: "归档",
        btnUnarchive: "激活",
        btnDelete: "删除",
        toastExportSuccess: "导出成功",
        toastExportFailed: "导出失败",
        toastExportError: "导出出错",
        toastImportSuccess: "导入成功！",
        toastImportFailed: "导入失败",
        toastInvalidFormat: "仅支持 .json 对话格式",
        toastUnsupportedStructure: "不支持的文件格式结构",
        toastJsonError: "解析 JSON 出错"
      }
    };

    let currentLang = 'zh';
    let currentTab = 'gateway';
    let activeSessionId = '';
    let configData = { providers: [] };

    function switchTab(tabName) {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
      
      document.getElementById('content-' + tabName).classList.add('active');
      document.getElementById('tab-btn-' + tabName).classList.add('active');
      currentTab = tabName;
      try { localStorage.setItem('activeTab', tabName); } catch {}
      
      if (tabName === 'sessions') {
        loadSessionsList();
      }
    }

    function setLanguage(lang) {
      currentLang = lang;
      const t = i18nDict[lang];
      
      const el = (id) => document.getElementById(id);
      const setText = (id, val) => { const e = el(id); if (e) e.innerText = val; };
      
      setText('i18n-title', t.title);
      setText('i18n-subtitle', t.subtitle);
      setText('i18n-status', t.status);
      setText('i18n-label-model-name', t.labelNewModelName);
      setText('i18n-model-alias-hint', t.modelAliasHint);
      const newModelInput = el('new-model-name');
      if (newModelInput) newModelInput.placeholder = t.placeholderNewModelName;
      setText('i18n-btn-save-config', t.btnSaveConfig);
      setText('i18n-panel-models-title', t.panelModelsTitle);
      setText('i18n-models-desc', t.modelsDesc);
      setText('i18n-btn-update-dropdown', t.btnUpdateDropdown);
      setText('i18n-panel-permissions-title', t.panelPermissionsTitle);
      setText('i18n-btn-clear', t.btnClear);
      setText('i18n-connecting-sse', t.connectingSse);
      setText('i18n-label-config-restart', t.labelConfigRestart);
      setText('i18n-label-models-restart', t.labelModelsRestart);
      setText('restart-codex-btn', t.btnRestartCodex);
      setText('reset-btn', t.btnReset);
      setText('i18n-btn-save-voice', t.btnSaveVoice);
      setText('i18n-voice-bar-status-label', t.voiceBarStatusLabel);
      setText('i18n-btn-launch-terminal', t.btnLaunchTerminal);
      setText('i18n-btn-launch-app', t.btnLaunchApp);
      setText('i18n-btn-fix-permissions', t.btnFixPermissions);
      setText('i18n-vision-fallback-title', t.visionFallbackTitle);
      setText('i18n-label-vision-key', t.labelVisionKey);
      setText('i18n-label-vision-url', t.labelVisionUrl);
      setText('i18n-label-vision-model', t.labelVisionModel);
      setText('i18n-btn-save-vision-fallback', t.btnSaveVisionFallback);
      setText('i18n-title-silence-detection', t.titleSilenceDetection);
      setText('i18n-label-vad-threshold', t.labelVadThreshold);
      setText('i18n-label-vad-duration', t.labelVadDuration);
      setText('i18n-title-conversational-brain', t.titleConversationalBrain);
      setText('i18n-label-voice-llm-model', t.labelVoiceLlmModel);
      setText('i18n-label-voice-system-prompt', t.labelVoiceSystemPrompt);
      setText('i18n-session-manager-title', t.sessionManagerTitle);
      setText('i18n-loading-sessions', t.loadingSessions);
      setText('i18n-import-title', t.importDropzoneTitle);
      setText('i18n-import-desc', t.importDropzoneDesc);
      
      const activeTitle = el('active-session-title');
      if (activeTitle && (activeTitle.innerText === 'Select a session from the left' || activeTitle.innerText === '请从左侧选择一个历史会话')) {
        activeTitle.innerText = t.selectSessionHint;
      }
      
      const chatEmptyHint = el('chat-empty-hint');
      if (chatEmptyHint && (chatEmptyHint.innerText === 'Please choose a session to view conversation details.' || chatEmptyHint.innerText === '请选择一个会话以查看详细聊天对话内容。')) {
        chatEmptyHint.innerText = t.chooseSessionDetail;
      }

      const langBtn = el('lang-btn');
      if (langBtn) langBtn.innerText = lang === 'zh' ? '🌐 English' : '🌐 中文';
      
      const voiceLlmSelect = el('voice-llm-model');
      if (voiceLlmSelect && voiceLlmSelect.options.length > 0) {
        voiceLlmSelect.options[0].text = lang === 'zh' ? '-- 未设置 (使用默认) --' : '-- Not Set (Default) --';
      }
      
      checkPermissionsStatus();
      try { loadSessionsList(); } catch {}
    }

    function toggleLanguage() {
      setLanguage(currentLang === 'zh' ? 'en' : 'zh');
    }

    function togglePass(id) {
      const inp = document.getElementById(id);
      inp.type = inp.type === 'password' ? 'text' : 'password';
    }

    function showToast(text, isError = false) {
      const toast = document.getElementById('toast');
      toast.innerText = text;
      if (isError) toast.classList.add('toast-error');
      else toast.classList.remove('toast-error');
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 3000);
    }

    // Load Configurations & Models
    async function loadConfig() {
      try {
        const response = await fetch('/v1/config');
        configData = await response.json();
        
        // Populate vision fallback fields
        const opencode = (configData.providers || []).find(p => p.name === 'opencode') || {};
        document.getElementById('vision-fallback-key').value = opencode.api_key || '';
        document.getElementById('vision-fallback-url').value = opencode.base_url || 'https://opencode.ai/zen/go/v1';
        document.getElementById('vision-fallback-model').value = opencode.vision_model || 'mimo-v2.5';
      } catch (err) {
        showToast(currentLang === 'zh' ? '加载配置失败' : 'Failed to load configs', true);
      }
    }

    async function loadModels() {
      try {
        const response = await fetch('/api/models');
        const data = await response.json();
        
        const activeIds = new Set(data.active || []);
        const container = document.getElementById('models-list-container');
        container.innerHTML = '';
        
        (data.catalog || []).forEach(m => {
          const isActive = activeIds.has(m.id);
          const hasVision = !m.no_image_support;
          const hasBridge = !!m.vision_bridge_enabled;
          
          const badgeHtml = (!hasBridge && hasVision) ? '<span class="badge badge-vision">Native Vision</span>' : '';

          const item = document.createElement('div');
          item.className = 'model-item';
          item.onclick = (e) => {
            if (e.target.type !== 'checkbox' && !e.target.classList.contains('model-delete-btn') && !e.target.closest('label')) {
              const cb = item.querySelector('.model-checkbox');
              cb.checked = !cb.checked;
            }
          };
          
          const is1m = m.context_window === 1000000;
          item.innerHTML = \`
            <div class="model-checkbox-container">
              <input type="checkbox" class="model-checkbox" data-id="\${m.id}" \x24{isActive ? 'checked' : ''}>
              <div class="model-info">
                <div class="model-display-name">\${m.display_name}</div>
                <div class="model-slug">\${m.model}</div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:0.75rem;">
              <label style="display:flex;align-items:center;gap:0.25rem;cursor:pointer;font-size:0.8rem;color:var(--color-text-muted);">
                <input type="checkbox" class="context-1m-checkbox" data-id="\${m.id}" \x24{is1m ? 'checked' : ''} style="width:14px;height:14px;accent-color:var(--color-secondary);">
                <span>1M Context</span>
              </label>
              <label style="display:flex;align-items:center;gap:0.25rem;cursor:pointer;font-size:0.8rem;color:var(--color-text-muted);">
                <input type="checkbox" class="vision-bridge-checkbox" data-id="\${m.id}" \x24{hasBridge ? 'checked' : ''} style="width:14px;height:14px;accent-color:var(--color-primary);">
                <span>Vision Bridge</span>
              </label>
              \${badgeHtml}
              <button class="model-delete-btn" onclick="deleteModel('\${m.id}')" title="删除">✕</button>
            </div>
          \`;
          container.appendChild(item);
        });
      } catch (err) {
        showToast(currentLang === 'zh' ? '加载模型列表失败' : 'Failed to load models list', true);
      }
    }

    // Save configurations (simplified form with 3 fields)
    document.getElementById('config-form').onsubmit = async (e) => {
      e.preventDefault();
      
      const restartChecked = document.getElementById('config-restart-checkbox').checked;
      const modelInput = document.getElementById('new-model-name').value.trim();
      const baseUrl = document.getElementById('new-base-url').value.trim();
      const apiKey = document.getElementById('new-api-key').value.trim();

      if (!modelInput || !baseUrl || !apiKey) {
        showToast(currentLang === 'zh' ? '请填写所有字段' : 'Please fill all fields', true);
        return;
      }

      let providerName = 'custom';
      let modelSlug = modelInput;
      if (modelInput.includes(':')) {
        const parts = modelInput.split(':');
        providerName = parts[0].trim();
        modelSlug = parts.slice(1).join(':').trim();
      } else {
        if (baseUrl.includes('deepseek')) providerName = 'deepseek';
        else if (baseUrl.includes('siliconflow')) providerName = 'siliconflow';
        else if (baseUrl.includes('openai')) providerName = 'openai';
        else providerName = 'custom_' + Math.random().toString(36).substring(2, 6);
      }

      // Append/Update the provider in current configData
      const providers = (configData.providers || []).map(p => ({
        name: p.name,
        base_url: p.base_url,
        api_key: p.api_key
      })).filter(p => p.name !== providerName);
      
      providers.push({
        name: providerName,
        base_url: baseUrl,
        api_key: apiKey
      });

      // Get existing catalog models from UI or catalog
      const modelsTextarea = [];
      document.querySelectorAll('.model-checkbox').forEach(cb => {
        const id = cb.getAttribute('data-id');
        if (id) modelsTextarea.push(id);
      });
      const newModelId = providerName + ':' + modelSlug;
      if (!modelsTextarea.includes(newModelId)) {
        modelsTextarea.push(newModelId);
      }

      try {
        if (restartChecked) {
          showToast(i18nDict[currentLang].toastRestarting);
        }
        
        const response = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providers,
            models: modelsTextarea,
            restart: restartChecked
          })
        });
        
        if (response.ok) {
          showToast(i18nDict[currentLang].toastConfigSaved);
          // Clear form inputs immediately
          document.getElementById('new-model-name').value = '';
          document.getElementById('new-base-url').value = '';
          document.getElementById('new-api-key').value = '';
          
          await loadConfig();
          await loadModels();
          await loadVoiceSettings();
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
      const visionBridgeBoxes = document.querySelectorAll('.vision-bridge-checkbox:checked');
      const visionBridgeIds = Array.from(visionBridgeBoxes).map(cb => cb.getAttribute('data-id'));
      const context1mBoxes = document.querySelectorAll('.context-1m-checkbox:checked');
      const context1mIds = Array.from(context1mBoxes).map(cb => cb.getAttribute('data-id'));
      const restartChecked = document.getElementById('models-restart-checkbox').checked;
      
      try {
        if (restartChecked) {
          showToast(i18nDict[currentLang].toastRestarting);
        }
        
        const response = await fetch('/api/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            active: activeIds,
            vision_bridge: visionBridgeIds,
            context_1m: context1mIds,
            restart: restartChecked
          })
        });
        
        if (response.ok) {
          showToast(i18nDict[currentLang].toastModelsSaved);
          loadModels();
          loadVoiceSettings();
        } else {
          showToast(i18nDict[currentLang].toastModelsFailed, true);
        }
      } catch (err) {
        showToast(i18nDict[currentLang].toastConnFailed, true);
      }
    }

    // Save Vision Fallback settings
    async function saveVisionFallback() {
      const apiKey = document.getElementById('vision-fallback-key').value.trim();
      const baseUrl = document.getElementById('vision-fallback-url').value.trim();
      const model = document.getElementById('vision-fallback-model').value.trim();
      const restartChecked = document.getElementById('config-restart-checkbox').checked;
      
      const providers = (configData.providers || []).map(p => {
        if (p.name === 'opencode') {
          return {
            ...p,
            base_url: baseUrl || 'https://opencode.ai/zen/go/v1',
            api_key: apiKey,
            vision_model: model || 'mimo-v2.5'
          };
        }
        return p;
      });
      
      if (!providers.some(p => p.name === 'opencode')) {
        providers.push({
          name: 'opencode',
          base_url: baseUrl || 'https://opencode.ai/zen/go/v1',
          api_key: apiKey,
          vision_model: model || 'mimo-v2.5'
        });
      }
      
      try {
        if (restartChecked) {
          showToast(i18nDict[currentLang].toastRestarting);
        }
        const response = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providers,
            restart: restartChecked
          })
        });
        if (response.ok) {
          showToast(currentLang === 'zh' ? '视觉降级配置已保存！' : 'Vision Fallback settings saved!');
          await loadConfig();
        } else {
          showToast(currentLang === 'zh' ? '保存失败' : 'Failed to save settings', true);
        }
      } catch (err) {
        showToast(i18nDict[currentLang].toastConnFailed, true);
      }
    }

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

    async function restartCodexDesktop() {
      showToast(i18nDict[currentLang].toastRestarting);
      try {
        const response = await fetch('/api/restart-codex', { method: 'POST' });
        if (response.ok) {
          setTimeout(() => showToast(i18nDict[currentLang].toastRestarted), 2500);
        }
      } catch (err) {}
    }

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

    async function resetCodex() {
      const msg = currentLang === 'zh' ? '还原后 Codex 显示官方模型，自定义模型的对话将被隐藏。' : 'Reset restores native Codex.';
      showConfirm(msg, async () => {
        try {
          const response = await fetch('/api/reset', { method: 'POST' });
          if (response.ok) {
            showToast(currentLang === 'zh' ? '已还原原生' : 'Reset complete');
            loadConfig();
            loadModels();
          }
        } catch (err) {}
      });
    }

    // Sessions Management
    let lastSessionsHash = '';
    async function loadSessionsList(isAutoRefresh = false) {
      try {
        const response = await fetch('/api/sessions');
        const sessions = await response.json();
        
        const hash = sessions.map(s => s.id + ':' + s.text + ':' + s.ts + ':' + s.archived + ':' + (s.tokens || 0) + ':' + (s.context_window || 0)).join('|');
        if (hash === lastSessionsHash && isAutoRefresh) {
          return;
        }
        lastSessionsHash = hash;

        const container = document.getElementById('session-list-container');
        container.innerHTML = '';
        
        if (sessions.length === 0) {
          container.innerHTML = \`<div style="text-align: center; color: var(--color-text-muted); padding: 2rem;">No active sessions found.</div>\`;
          return;
        }
        
        sessions.forEach(s => {
          const item = document.createElement('div');
          item.className = 'session-list-item' + (activeSessionId === s.id ? ' active' : '');
          if (s.archived) {
            item.style.opacity = '0.5';
          }
          item.onclick = () => selectSession(s.id);
          
          const timeStr = new Date(s.ts).toLocaleTimeString();
          
          let contextHtml = '';
          if (s.tokens !== undefined && s.tokens > 0) {
            const pct = Math.min(100, Math.round(s.tokens / s.context_window * 100));
            const color = pct > 80 ? 'var(--color-danger)' : (pct > 60 ? '#f59e0b' : 'var(--color-success)');
            contextHtml = \`
              <div class="session-context-info" style="margin-top: 0.5rem; display: flex; flex-direction: column; gap: 0.25rem; pointer-events: none;">
                <div style="background: rgba(255,255,255,0.05); border-radius: 4px; height: 6px; overflow: hidden; position: relative; width: 100%;">
                  <div style="width: \${pct}%; height: 100%; background: \${color}; transition: width 0.3s ease;"></div>
                </div>
                <div style="font-size: 0.75rem; color: var(--color-text-muted); display: flex; justify-content: space-between;">
                  <span>\${Math.round(s.tokens / 1000)}K / \${Math.round(s.context_window / 1000)}K (\${pct}%)</span>
                  <span>\${({ provider: 'Actual', rollout_actual: 'Session actual', model_tokenizer: 'Tokenizer', model_estimate: 'Model est.', generic_estimate: 'Generic est.' })[s.token_source] || (s.is_estimated ? 'Est.' : 'Act.')}</span>
                </div>
              </div>
            \`;
          }
          
          item.innerHTML = \`
            <div class="session-item-header">
              <span class="session-id-title">\${s.id.substring(0, 8)}...</span>
              <span class="session-time">\${timeStr}</span>
            </div>
            <div class="session-text-preview">\${escapeHtml(s.text)}</div>
            \${contextHtml}
            <div class="session-actions-overlay">
              <button class="session-btn session-btn-arc" onclick="event.stopPropagation(); showExportModal('\${s.id}')" style="background: rgba(6, 182, 212, 0.15); color: var(--color-secondary); border-color: rgba(6, 182, 212, 0.25);">📤 \${i18nDict[currentLang].btnExport || 'Export'}</button>
              <button class="session-btn session-btn-arc" onclick="event.stopPropagation(); toggleArchiveSession('\${s.id}', \${!s.archived})">\${s.archived ? (i18nDict[currentLang].btnUnarchive || 'Unarchive') : (i18nDict[currentLang].btnArchive || 'Archive')}</button>
              <button class="session-btn session-btn-del" onclick="event.stopPropagation(); deleteSession('\${s.id}')">\${i18nDict[currentLang].btnDelete || 'Delete'}</button>
            </div>
          \`;
          container.appendChild(item);
        });
      } catch (err) {}
    }

    let lastMessagesHash = '';
    async function selectSession(sid, isAutoRefresh = false) {
      if (!isAutoRefresh) {
        activeSessionId = sid;
        document.querySelectorAll('.session-list-item').forEach(el => el.classList.remove('active'));
        const activeEl = Array.from(document.querySelectorAll('.session-list-item')).find(el => el.innerHTML.includes(sid.substring(0, 8)));
        if (activeEl) activeEl.classList.add('active');
        
        document.getElementById('active-session-title').innerText = 'Session: ' + sid;
        document.getElementById('enter-session-btn').style.display = 'block';
      }
      
      // Load details
      try {
        const response = await fetch('/api/sessions/detail', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sid })
        });
        const data = await response.json();
        
        const hash = (data.messages || []).map(m => m.role + ':' + m.text).join('|');
        if (hash === lastMessagesHash && isAutoRefresh) {
          return;
        }
        lastMessagesHash = hash;
        
        const container = document.getElementById('chat-messages-container');
        container.innerHTML = '';
        
        if (!data.messages || data.messages.length === 0) {
          container.innerHTML = \`<div style="text-align: center; color: var(--color-text-muted); padding: 2rem;">No messages in this session.</div>\`;
          return;
        }
        
        data.messages.forEach(msg => {
          const bubble = document.createElement('div');
          if (msg.role === 'assistant') {
            bubble.className = 'chat-bubble chat-bubble-assistant';
          } else {
            bubble.className = 'chat-bubble chat-bubble-user';
          }
          bubble.innerText = msg.text;
          container.appendChild(bubble);
        });
        // Scroll detail view to the bottom
        container.scrollTop = container.scrollHeight;
      } catch (err) {}
    }

    async function enterActiveSession() {
      if (!activeSessionId) return;
      try {
        const response = await fetch('/api/sessions/enter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: activeSessionId })
        });
        if (response.ok) {
          showToast(currentLang === 'zh' ? '成功进入该会话！菜单栏已切换' : 'Entered session successfully!');
        }
      } catch (err) {}
    }

    async function deleteSession(sid) {
      showConfirm(currentLang === 'zh' ? '确定删除该会话？' : 'Delete this session?', async () => {
        try {
          const response = await fetch('/api/sessions/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: sid })
          });
          if (response.ok) {
            showToast(currentLang === 'zh' ? '会话已删除' : 'Session deleted');
            if (activeSessionId === sid) {
              activeSessionId = '';
              document.getElementById('chat-messages-container').innerHTML = \`<div style="text-align: center; color: var(--color-text-muted); padding: 4rem 2rem;" id="chat-empty-hint">Please choose a session to view conversation details.</div>\`;
              document.getElementById('enter-session-btn').style.display = 'none';
              document.getElementById('active-session-title').innerText = currentLang === 'zh' ? '请选择左侧会话' : 'Select a session';
            }
            loadSessionsList();
          }
        } catch (err) {}
      });
    }

    async function clearAllSessions() {
      const confirm1Msg = currentLang === 'zh' ? '确定要清空所有会话吗？此操作将彻底删除所有本地对话记录且无法恢复！' : 'Are you sure you want to clear all sessions? This will permanently delete all local conversation logs!';
      showConfirm(confirm1Msg, () => {
        // Double confirmation modal!
        setTimeout(() => {
          const confirm2Msg = currentLang === 'zh' ? '再次确认：请再次确认是否要彻底清空所有对话记录？' : 'Double Check: Please confirm once more to delete all conversation logs permanently.';
          showConfirm(confirm2Msg, async () => {
            try {
              const response = await fetch('/api/sessions/clear-all', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
              });
              if (response.ok) {
                showToast(currentLang === 'zh' ? '所有会话已清空' : 'All sessions cleared');
                activeSessionId = '';
                document.getElementById('chat-messages-container').innerHTML = \`<div style="text-align: center; color: var(--color-text-muted); padding: 4rem 2rem;" id="chat-empty-hint">Please choose a session to view conversation details.</div>\`;
                document.getElementById('enter-session-btn').style.display = 'none';
                document.getElementById('active-session-title').innerText = currentLang === 'zh' ? '请选择左侧会话' : 'Select a session';
                loadSessionsList();
              }
            } catch (err) {}
          });
        }, 300); // 300ms delay to make the transition look extremely polished and distinct
      });
    }

    async function toggleArchiveSession(sid, archived) {
      try {
        const response = await fetch('/api/sessions/archive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sid, archived })
        });
        if (response.ok) {
          showToast(archived ? '会话已归档' : '会话已重新激活');
          loadSessionsList();
        }
      } catch (err) {}
    }

    // Logs SSE
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
      container.scrollTop = container.scrollHeight;
      if (container.children.length > 500) {
        container.removeChild(container.firstChild);
      }
    }

    function clearConsole() {
      document.getElementById('console-logs').innerHTML = '';
    }

    function escapeHtml(text) {
      if (!text) return '';
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
      
      const showCustomTts = (ttsEngine === 'openai-compatible' || ttsEngine === 'minimax' || ttsEngine === 'doubao' || ttsEngine === 'mimo');
      document.getElementById('custom-tts-fields').style.display = showCustomTts ? 'flex' : 'none';
      
      document.getElementById('tts-doubao-extra-fields').style.display = ttsEngine === 'doubao' ? 'flex' : 'none';

      // Dynamic placeholder updates for easy configuration
      const keyInp = document.getElementById('tts-api-key');
      const urlInp = document.getElementById('tts-base-url');
      const modelInp = document.getElementById('tts-model');
      const voiceInp = document.getElementById('tts-voice');

      if (ttsEngine === 'mimo') {
        if (keyInp) keyInp.placeholder = '输入您的小米米眸 API-Key';
        if (urlInp) urlInp.placeholder = 'https://api.xiaomimimo.com';
        if (modelInp) modelInp.placeholder = 'mimo-v2.5-tts';
        if (voiceInp) voiceInp.placeholder = '例如: Chloe, Connor, Charlotte';
      } else if (ttsEngine === 'minimax') {
        if (keyInp) keyInp.placeholder = '输入您的 MiniMax API Key';
        if (urlInp) urlInp.placeholder = 'https://api.minimaxi.com';
        if (modelInp) modelInp.placeholder = 'speech-2.8-turbo';
        if (voiceInp) voiceInp.placeholder = '例如: female-shaonv';
      } else {
        if (keyInp) keyInp.placeholder = 'sk-...';
        if (urlInp) urlInp.placeholder = 'https://api.openai.com/v1';
        if (modelInp) modelInp.placeholder = 'tts-1';
        if (voiceInp) voiceInp.placeholder = 'zh-CN-XiaoxiaoNeural';
      }
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
        document.getElementById('tts-appid').value = data.tts_appid || '';
        document.getElementById('tts-resource').value = data.tts_resource || '';
        document.getElementById('voice-system-prompt').value = data.voice_system_prompt || '';
        document.getElementById('vad-threshold').value = data.vad_threshold !== undefined ? data.vad_threshold : -35.0;
        document.getElementById('vad-duration').value = data.vad_duration !== undefined ? data.vad_duration : 2.0;
        
        // Populate LLM models select dropdown
        const selectEl = document.getElementById('voice-llm-model');
        if (selectEl) {
          selectEl.innerHTML = '';
          const defaultOpt = document.createElement('option');
          defaultOpt.value = '';
          defaultOpt.textContent = currentLang === 'zh' ? '-- 未设置 (使用默认) --' : '-- Not Set (Default) --';
          selectEl.appendChild(defaultOpt);
          
          if (data.available_models && Array.isArray(data.available_models)) {
            data.available_models.forEach(model => {
              const opt = document.createElement('option');
              opt.value = model;
              opt.textContent = model;
              selectEl.appendChild(opt);
            });
          }
          selectEl.value = data.voice_llm_model || '';
        }
        
        toggleCustomFields();
      } catch (err) {}
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
      const tts_appid = document.getElementById('tts-appid').value.trim();
      const tts_resource = document.getElementById('tts-resource').value.trim();
      const voice_system_prompt = document.getElementById('voice-system-prompt').value.trim();
      const vad_threshold = parseFloat(document.getElementById('vad-threshold').value.trim() || '-35.0');
      const vad_duration = parseFloat(document.getElementById('vad-duration').value.trim() || '2.0');
      const voice_llm_model = document.getElementById('voice-llm-model').value.trim();
      
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
            tts_appid,
            tts_resource,
            voice_system_prompt,
            vad_threshold,
            vad_duration,
            voice_llm_model
          })
        });
        
        if (response.ok) {
          showToast(i18nDict[currentLang].toastVoiceSaved);
          loadVoiceSettings();
        }
      } catch (err) {}
    };

    document.getElementById('stt-engine').addEventListener('change', toggleCustomFields);
    document.getElementById('tts-engine').addEventListener('change', toggleCustomFields);

    async function checkPermissionsStatus() {
      try {
        const response = await fetch('/api/permissions');
        const data = await response.json();
        if (data.status === 'success' && data.permissions) {
          const axBadge = document.getElementById('permission-ax-status');
          const screenBadge = document.getElementById('permission-screen-status');
          const t = i18nDict[currentLang];
          
          if (axBadge) {
            if (data.permissions.accessibility) {
              axBadge.innerText = t.badgeAuthorized || 'Authorized';
              axBadge.style.color = 'var(--color-success)';
              axBadge.style.background = 'rgba(16, 185, 129, 0.1)';
              axBadge.style.borderColor = 'rgba(16, 185, 129, 0.2)';
            } else {
              axBadge.innerText = t.badgeUnauthorized || 'Unauthorized';
              axBadge.style.color = '#ef4444';
              axBadge.style.background = 'rgba(239, 68, 68, 0.1)';
              axBadge.style.borderColor = 'rgba(239, 68, 68, 0.2)';
            }
          }
          
          if (screenBadge) {
            if (data.permissions.screenRecording) {
              screenBadge.innerText = t.badgeAuthorized || 'Authorized';
              screenBadge.style.color = 'var(--color-success)';
              screenBadge.style.background = 'rgba(16, 185, 129, 0.1)';
              screenBadge.style.borderColor = 'rgba(16, 185, 129, 0.2)';
            } else {
              screenBadge.innerText = t.badgeUnauthorized || 'Unauthorized';
              screenBadge.style.color = '#ef4444';
              screenBadge.style.background = 'rgba(239, 68, 68, 0.1)';
              screenBadge.style.borderColor = 'rgba(239, 68, 68, 0.2)';
            }
          }
        }
      } catch (err) {}
    }

    async function fixPermissions() {
      try {
        const response = await fetch('/api/permissions/fix', { method: 'POST' });
        if (response.ok) {
          showToast(currentLang === 'zh' ? '系统授权弹窗已触发！' : 'Settings opened.');
        }
      } catch (err) {}
    }

    async function checkVoiceBarStatus() {
      try {
        const response = await fetch('/api/voice-bar/status');
        const data = await response.json();
        const badge = document.getElementById('voice-bar-status-badge');
        if (badge) {
          badge.innerText = data.running ? (currentLang === 'zh' ? '在线 (运行中)' : 'Online') : (currentLang === 'zh' ? '离线' : 'Offline');
          badge.style.color = data.running ? 'var(--color-success)' : '#ef4444';
          badge.style.background = data.running ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)';
          badge.style.borderColor = data.running ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)';
        }
      } catch (err) {}
    }

    async function launchVoiceBar(method) {
      showToast(i18nDict[currentLang].toastVoiceBarLaunching || 'Launching...');
      try {
        const response = await fetch('/api/voice-bar/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method })
        });
        if (response.ok) {
          setTimeout(checkVoiceBarStatus, 2000);
        }
      } catch (err) {}
    }

    let orbRunning = false;
    async function checkOrbStatus() {
      try {
        const response = await fetch('/api/orb/status');
        const data = await response.json();
        orbRunning = !!data.running;
        const badge = document.getElementById('orb-status-badge');
        const btn = document.getElementById('orb-toggle-btn');
        if (badge) {
          badge.innerText = orbRunning ? (currentLang === 'zh' ? '运行中' : 'Running') : (currentLang === 'zh' ? '关闭' : 'Offline');
          badge.style.color = orbRunning ? 'var(--color-success)' : '#ef4444';
          badge.style.background = orbRunning ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)';
          badge.style.borderColor = orbRunning ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)';
        }
        if (btn) {
          btn.innerText = orbRunning 
            ? (currentLang === 'zh' ? '关闭置顶悬浮球 / Close Orb' : 'Close Desktop Orb')
            : (currentLang === 'zh' ? '开启置顶悬浮球 / Launch Orb' : 'Launch Desktop Orb');
          btn.style.background = orbRunning ? 'rgba(239, 68, 68, 0.15)' : 'var(--color-primary)';
          btn.style.color = orbRunning ? '#ef4444' : 'white';
          btn.style.border = orbRunning ? '1px solid rgba(239, 68, 68, 0.3)' : 'none';
        }
      } catch (err) {}
    }

    async function toggleDesktopOrb() {
      const enable = !orbRunning;
      showToast(enable ? '正在启动悬浮球...' : '正在关闭悬浮球...');
      try {
        const response = await fetch('/api/orb/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enable })
        });
        if (response.ok) {
          setTimeout(checkOrbStatus, 1500);
        }
      } catch (err) {}
    }

    async function createNewSession() {
      try {
        const response = await fetch('/api/sessions/new', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        if (response.ok) {
          showToast(currentLang === 'zh' ? '已成功开启新会话！' : 'Started new session successfully!');
          activeSessionId = '';
          const msgContainer = document.getElementById('chat-messages-container');
          if (msgContainer) {
            msgContainer.innerHTML = \`<div style="text-align: center; color: var(--color-text-muted); padding: 4rem 2rem;" id="chat-empty-hint">New session created. Start talking or typing to begin conversation!</div>\`;
          }
          const enterBtn = document.getElementById('enter-session-btn');
          if (enterBtn) enterBtn.style.display = 'none';
          const activeTitle = document.getElementById('active-session-title');
          if (activeTitle) activeTitle.innerText = currentLang === 'zh' ? '新会话 (未保存)' : 'New Session (Unsaved)';
          loadSessionsList();
        }
      } catch (err) {}
    }

    let exportTargetSessionId = '';
    function showExportModal(sid) {
      exportTargetSessionId = sid;
      document.getElementById('export-modal').classList.add('show');
    }

    async function executeExport(format) {
      document.getElementById('export-modal').classList.remove('show');
      if (!exportTargetSessionId) return;
      try {
        const response = await fetch('/api/sessions/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: exportTargetSessionId, format })
        });
        if (response.ok) {
          const blob = await response.blob();
          const disp = response.headers.get('Content-Disposition');
          let filename = \`session_\${exportTargetSessionId}.\${format === 'markdown' ? 'md' : 'json'}\`;
          if (disp && disp.includes('filename="')) {
            filename = disp.split('filename="')[1].split('"')[0];
          }
          const link = document.createElement('a');
          link.href = window.URL.createObjectURL(blob);
          link.download = filename;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          showToast(i18nDict[currentLang].toastExportSuccess || 'Exported successfully');
        } else {
          showToast(i18nDict[currentLang].toastExportFailed || 'Export failed');
        }
      } catch (err) {
        showToast(i18nDict[currentLang].toastExportError || 'Export error');
      }
    }

    function triggerImportFileInput() {
      document.getElementById('import-file-input').click();
    }

    function handleImportFileSelect(e) {
      const file = e.target.files[0];
      if (file) processImportFile(file);
    }

    function handleDragOver(e) {
      e.preventDefault();
      document.getElementById('import-dropzone').style.borderColor = 'var(--color-secondary)';
      document.getElementById('import-dropzone').style.background = 'rgba(6, 182, 212, 0.05)';
    }

    function handleDragLeave(e) {
      e.preventDefault();
      document.getElementById('import-dropzone').style.borderColor = 'rgba(255,255,255,0.12)';
      document.getElementById('import-dropzone').style.background = 'rgba(255,255,255,0.02)';
    }

    function handleFileDrop(e) {
      e.preventDefault();
      handleDragLeave(e);
      const file = e.dataTransfer.files[0];
      if (file) processImportFile(file);
    }

    function processImportFile(file) {
      if (!file.name.endsWith('.json')) {
        showToast(i18nDict[currentLang].toastInvalidFormat || 'Only .json chat format is supported');
        return;
      }
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const raw = JSON.parse(e.target.result);
          let messages = [];
          if (Array.isArray(raw)) {
            messages = raw;
          } else if (raw && Array.isArray(raw.messages)) {
            if (raw.system) {
              messages.push({ role: 'system', content: raw.system });
            }
            messages = messages.concat(raw.messages);
          } else {
            showToast(i18nDict[currentLang].toastUnsupportedStructure || 'Unsupported file structure');
            return;
          }

          const threadName = file.name.replace('.json', '');
          const response = await fetch('/api/sessions/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages, name: threadName })
          });
          if (response.ok) {
            const resData = await response.json();
            showToast(i18nDict[currentLang].toastImportSuccess || 'Imported successfully!');
            loadSessionsList();
            if (resData.id) selectSession(resData.id);
          } else {
            showToast(i18nDict[currentLang].toastImportFailed || 'Import failed');
          }
        } catch (err) {
          showToast(i18nDict[currentLang].toastJsonError || 'Error parsing JSON');
        }
      };
      reader.readAsText(file);
    }

    // Explicitly expose globally called button event handler actions to the browser window object
    window.showExportModal = showExportModal;
    window.executeExport = executeExport;
    window.triggerImportFileInput = triggerImportFileInput;
    window.handleImportFileSelect = handleImportFileSelect;
    window.handleDragOver = handleDragOver;
    window.handleDragLeave = handleDragLeave;
    window.handleFileDrop = handleFileDrop;

    window.createNewSession = createNewSession;
    window.clearAllSessions = clearAllSessions;
    window.enterActiveSession = enterActiveSession;
    window.deleteSession = deleteSession;
    window.toggleArchiveSession = toggleArchiveSession;
    window.launchVoiceBar = launchVoiceBar;
    window.toggleDesktopOrb = toggleDesktopOrb;

    window.onload = async () => {
      try { setLanguage('zh'); } catch {}
      await loadConfig();
      await loadModels();
      await loadVoiceSettings();
      
      setupLogsPolling();
      setInterval(checkVoiceBarStatus, 3000);
      setInterval(checkOrbStatus, 3000);
      checkOrbStatus();
      setInterval(checkPermissionsStatus, 3000);
      setInterval(async () => {
        if (currentTab === 'sessions') {
          await loadSessionsList(true);
          if (activeSessionId) {
            await selectSession(activeSessionId, true);
          }
        }
      }, 3000);

      // Restore previously active tab from localStorage after rendering
      setTimeout(() => {
        try {
          const savedTab = localStorage.getItem('activeTab');
          switchTab(savedTab || 'gateway');
        } catch (e) {
          switchTab('gateway');
        }
      }, 50);
    };
  </script>
</body>
</html>
`;
}
