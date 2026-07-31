/**
 * OpenCodex Local Voice Visualizer Playground
 * Served directly on http://localhost:8765/visualizer.
 * Provides interactive, high-fidelity mockups of Siri fluid wave, Apple Intelligence border glow,
 * Cyberpunk rotating scanner halo, and live audio-reactive amplitude sync via real Web Audio API mic input.
 */

export function getVisualizerHtml(isHudModeStatic: boolean = false, hudTheme: string = "vortex", cspNonce = ""): string {
  return `<!DOCTYPE html>
<html lang="zh-CN" ${isHudModeStatic ? 'class="hud-mode"' : ''}>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenCodex Voice Visualizer Playground</title>
  <style nonce="${cspNonce}">
    :root {
      --bg-gradient: linear-gradient(135deg, #070416 0%, #0d0926 50%, #04020a 100%);
      --glass-bg: rgba(255, 255, 255, 0.02);
      --glass-border: rgba(255, 255, 255, 0.05);
      --glass-glow: rgba(147, 51, 234, 0.12);
      
      --color-primary: #a855f7; /* Purple */
      --color-secondary: #06b6d4; /* Cyan */
      --color-success: #10b981; /* Emerald */
      --color-danger: #ef4444; /* Red */
      --color-warning: #f59e0b; /* Amber */
      --color-text: #f3f4f6;
      --color-text-muted: #9ca3af;
      
      --card-blur: blur(20px);
      --transition-standard: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
      background: var(--bg-gradient);
      color: var(--color-text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      overflow-x: hidden;
    }
    
    /* Ambient Background Glows */
    .glow-orb {
      position: absolute;
      border-radius: 50%;
      filter: blur(140px);
      z-index: -1;
      opacity: 0.18;
      pointer-events: none;
    }
    .orb-1 {
      top: -10%;
      left: 15%;
      width: 450px;
      height: 450px;
      background: var(--color-primary);
    }
    .orb-2 {
      bottom: 5%;
      right: 15%;
      width: 550px;
      height: 550px;
      background: var(--color-secondary);
    }

    .app-container {
      max-width: 1300px;
      width: 100%;
      margin: 0 auto;
      padding: 2.5rem 1.5rem;
      display: flex;
      flex-direction: column;
      gap: 2rem;
    }

    /* Glass Header */
    header {
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      backdrop-filter: var(--card-blur);
      border-radius: 20px;
      padding: 1.75rem 2.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5), inset 0 1px 1px rgba(255, 255, 255, 0.05);
      position: relative;
    }
    header::before {
      content: '';
      position: absolute;
      bottom: 0;
      left: 10%;
      width: 80%;
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--color-primary), var(--color-secondary), transparent);
    }
    .logo-container {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .logo-container svg {
      width: 2.5rem;
      height: 2.5rem;
      color: var(--color-secondary);
      filter: drop-shadow(0 0 8px rgba(6, 182, 212, 0.4));
      animation: logoPulse 3s infinite ease-in-out;
    }
    @keyframes logoPulse {
      0%, 100% { filter: drop-shadow(0 0 5px rgba(6, 182, 212, 0.3)); }
      50% { filter: drop-shadow(0 0 15px rgba(168, 85, 247, 0.6)); color: var(--color-primary); }
    }
    .logo-text h1 {
      font-size: 1.35rem;
      font-weight: 800;
      letter-spacing: 1px;
      background: linear-gradient(90deg, #fff 0%, #cbd5e1 50%, var(--color-secondary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .logo-text p {
      font-size: 0.72rem;
      color: var(--color-text-muted);
      text-transform: uppercase;
      letter-spacing: 1.5px;
      font-family: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    }
    .back-btn {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--glass-border);
      color: var(--color-text);
      padding: 0.6rem 1.2rem;
      border-radius: 30px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      transition: var(--transition-standard);
      text-decoration: none;
    }
    .back-btn:hover {
      background: var(--color-primary);
      border-color: var(--color-primary);
      box-shadow: 0 0 15px rgba(168, 85, 247, 0.4);
      transform: translateY(-2px);
    }

    /* Visualizer Grid */
    .visualizer-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 2rem;
    }

    .visualizer-card {
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      backdrop-filter: var(--card-blur);
      border-radius: 20px;
      padding: 2rem;
      box-shadow: 0 15px 35px rgba(0, 0, 0, 0.5);
      position: relative;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      transition: var(--transition-standard);
    }
    .visualizer-card::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: radial-gradient(circle at top right, var(--glass-glow) 0%, transparent 60%);
      pointer-events: none;
      z-index: 0;
    }
    .visualizer-card:hover {
      border-color: rgba(255,255,255,0.08);
      box-shadow: 0 20px 45px rgba(0, 0, 0, 0.6);
      transform: translateY(-2px);
    }
    
    .card-title {
      font-size: 1.1rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      z-index: 1;
      position: relative;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      padding-bottom: 0.75rem;
    }
    .card-title svg {
      width: 1.35rem;
      height: 1.35rem;
    }
    .card-title-siri svg { color: var(--color-primary); }
    .card-title-glow svg { color: var(--color-secondary); }
    .card-title-halo svg { color: var(--color-warning); }
    .card-title-eq svg { color: var(--color-success); }

    /* Canvas / Screen Previews */
    .preview-area {
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.03);
      border-radius: 12px;
      height: 180px;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow: hidden;
      z-index: 1;
    }
    .preview-canvas {
      width: 100%;
      height: 100%;
      display: block;
    }



    /* Actions Panel inside Cards */
    .card-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      z-index: 1;
      position: relative;
    }
    .action-btn {
      flex: 1;
      min-width: 110px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--glass-border);
      color: var(--color-text);
      padding: 0.55rem 1rem;
      border-radius: 10px;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      transition: var(--transition-standard);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
    }
    .action-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.15);
      transform: translateY(-1px);
    }
    .action-btn.active {
      background: var(--color-secondary);
      border-color: var(--color-secondary);
      color: #000;
      box-shadow: 0 0 15px rgba(6, 182, 212, 0.4);
    }
    .action-btn-primary {
      background: linear-gradient(90deg, var(--color-primary), var(--color-secondary));
      border: none;
      box-shadow: 0 4px 15px rgba(168, 85, 247, 0.25);
    }
    .action-btn-primary:hover {
      box-shadow: 0 4px 20px rgba(168, 85, 247, 0.45);
      transform: translateY(-1px);
    }

    /* Micro-description */
    .card-desc {
      font-size: 0.78rem;
      color: var(--color-text-muted);
      line-height: 1.4;
      z-index: 1;
      position: relative;
    }

    /* Live Microphone Indicator */
    .mic-status-bar {
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      backdrop-filter: var(--card-blur);
      border-radius: 15px;
      padding: 1rem 2rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      z-index: 1;
      position: relative;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);
    }
    .mic-status-info {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .mic-pulse-indicator {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--color-text-muted);
      transition: var(--transition-standard);
    }
    .mic-pulse-indicator.active {
      background: var(--color-secondary);
      box-shadow: 0 0 10px var(--color-secondary);
      animation: micLedPulse 1.5s infinite ease-in-out;
    }
    @keyframes micLedPulse {
      0%, 100% { opacity: 0.5; }
      50% { opacity: 1; }
    }
    .mic-status-text {
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--color-text-muted);
      transition: var(--transition-standard);
    }
    .mic-status-text.active {
      color: var(--color-text);
    }

    /* Full-Screen Apple Intelligence Overlay Glow Style */
    .fullscreen-glow-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
      z-index: 9999;
      border: 16px solid transparent;
      box-sizing: border-box;
      opacity: 0;
      transition: opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: inset 0 0 40px rgba(168, 85, 247, 0.3);
    }
    .fullscreen-glow-overlay.active {
      opacity: 1;
      animation: borderGlowSweepFull 8s infinite linear, borderGlowPulseFull 3s infinite ease-in-out;
    }
    @keyframes borderGlowPulseFull {
      0%, 100% { border-width: 14px; opacity: 0.75; }
      50% { border-width: 20px; opacity: 1; }
    }
    @keyframes borderGlowSweepFull {
      0% {
        border-image: linear-gradient(0deg, rgba(168,85,247,0.7), rgba(6,182,212,0.7), rgba(245,158,11,0.7), rgba(168,85,247,0.7)) 1;
      }
      50% {
        border-image: linear-gradient(180deg, rgba(168,85,247,0.7), rgba(6,182,212,0.7), rgba(245,158,11,0.7), rgba(168,85,247,0.7)) 1;
      }
      100% {
        border-image: linear-gradient(360deg, rgba(168,85,247,0.7), rgba(6,182,212,0.7), rgba(245,158,11,0.7), rgba(168,85,247,0.7)) 1;
      }
    }
    .fullscreen-toast {
      position: fixed;
      top: 2rem;
      left: 50%;
      transform: translateX(-50%) translateY(-20px);
      background: rgba(15, 10, 30, 0.85);
      border: 1px solid rgba(255,255,255,0.1);
      backdrop-filter: blur(10px);
      padding: 0.75rem 1.5rem;
      border-radius: 30px;
      font-size: 0.85rem;
      font-weight: 500;
      color: #fff;
      pointer-events: none;
      z-index: 10000;
      opacity: 0;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .fullscreen-toast.active {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    
    /* HUD Mode Styles */
    html.hud-mode,
    body.hud-mode {
      background: transparent !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      overflow: hidden !important;
      margin: 0 !important;
      padding: 0 !important;
      width: 100% !important;
      height: 100% !important;
      border: none !important;
      outline: none !important;
      box-shadow: none !important;
      display: flex !important;
      align-items: flex-start !important;
      justify-content: center !important;
    }
    body.hud-mode :not(#hud-card):not(#hud-card *) {
      box-shadow: none !important;
      border: none !important;
      outline: none !important;
      background: transparent !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }
    body.hud-mode .app-container {
      padding: 0 !important;
      margin: 0 !important;
      width: 100% !important;
      height: 100% !important;
      max-width: none !important;
      display: flex !important;
      align-items: flex-start !important;
      justify-content: center !important;
      border: none !important;
      background: transparent !important;
    }
    body.hud-mode header,
    body.hud-mode .glow-orb,
    body.hud-mode .mic-status-bar,
    body.hud-mode .visualizer-grid > :not(#hud-card),
    body.hud-mode #hud-card .card-title,
    body.hud-mode #hud-card .card-desc,
    body.hud-mode #hud-card .card-actions {
      display: none !important;
    }
    body.hud-mode .visualizer-grid {
      display: flex !important;
      align-items: flex-start !important;
      justify-content: center !important;
      width: 100% !important;
      height: 100% !important;
      border: none !important;
      background: transparent !important;
    }
    body.hud-mode #hud-card {
      background: transparent !important;
      border: none !important;
      padding: 0 !important;
      width: 560px !important;
      height: 38px !important;
      margin: 0 !important;
      box-shadow: none !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      position: relative !important;
      z-index: 1 !important;
      overflow: visible !important;
    }

    .notch-wing-left {
      position: absolute !important;
      top: 0 !important;
      background: transparent !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      pointer-events: none !important;
      z-index: 5 !important;
      transition: none !important;
    }

    .status-indicator-led {
      width: 7.5px !important;
      height: 7.5px !important;
      border-radius: 50% !important;
      background: #ff453a;
      box-shadow: 0 0 8px 2px #ff453a;
      transition: all 0.3s ease !important;
      animation: ledBreath 2s infinite ease-in-out;
    }

    @keyframes ledBreath {
      0%, 100% { opacity: 0.55; transform: scale(0.95); }
      50% { opacity: 1; transform: scale(1.05); }
    }

    .notch-wing-right {
      position: absolute !important;
      top: 0 !important;
      background: transparent !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 2.5px !important;
      pointer-events: none !important;
      z-index: 5 !important;
      transition: none !important;
    }

    .eq-bar {
      width: 3px !important;
      height: 3px;
      background: linear-gradient(180deg, #a855f7 0%, #06b6d4 100%) !important;
      border-radius: 1.5px !important;
      transition: height 0.08s ease-in-out !important;
      flex-shrink: 0 !important;
    }

    body.hud-mode #hud-card.state-draghover {
      animation: none !important;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.65) !important;
      border: none !important;
      border-color: transparent !important;
      transition: box-shadow 0.3s ease !important;
    }
    body.hud-mode #hud-card.state-dropabsorb {
      animation: absorbSuction 0.8s cubic-bezier(0.25, 1, 0.5, 1) forwards !important;
      border: none !important;
      border-color: transparent !important;
    }
    body.hud-mode #hud-card.state-draghover #hud-text-container,
    body.hud-mode #hud-card.state-dropabsorb #hud-text-container {
      display: none !important;
    }
    @keyframes absorbSuction {
      0% {
        transform: scale(1);
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.65) !important;
      }
      30% {
        transform: scale(1.04);
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.65) !important;
      }
      100% {
        transform: scale(1);
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.65) !important;
      }
    }

    body.hud-mode #hud-card::before {
      display: none !important; /* Disable frosted glass background for notch OLED black style */
    }

    /* Keep the visual margin spacing since parent padding is 0 */
    body.hud-mode #hud-text-container {
      position: absolute !important;
      bottom: 12px !important;
      left: 15px !important;
      width: 230px !important;
      display: flex !important;
      flex-direction: column !important;
      align-items: center !important;
      text-align: center !important;
      z-index: 2 !important;
      pointer-events: none !important;
    }
    
    body.hud-mode #hud-state-label {
      justify-content: center !important;
    }

    body.hud-mode .preview-area {
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      width: 100% !important;
      height: 100% !important;
      margin: 0 !important;
      background: transparent !important;
      border: none !important;
      z-index: 0 !important;
      pointer-events: none !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
    }

    body.hud-mode .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      display: inline-block;
      margin-right: 6px;
      background-color: var(--color-success);
      box-shadow: 0 0 8px var(--color-success);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

  </style>
</head>
<body ${isHudModeStatic ? 'class="hud-mode theme-' + hudTheme + '"' : ''}>

  <div class="glow-orb orb-1"></div>
  <div class="glow-orb orb-2"></div>

  <!-- Fullscreen Apple Intelligence Glow Elements -->
  <div class="fullscreen-glow-overlay" id="fullscreen-overlay"></div>
  <div class="fullscreen-toast" id="fullscreen-toast">已开启全屏苹果智能流光！说话时分贝实时同步。按 <strong>ESC</strong> 退出预览</div>

  <div class="app-container">
    
    <header>
      <div class="logo-container">
        <svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"></path>
        </svg>
        <div class="logo-text">
          <h1>Voice Assistant Visualizer Playground</h1>
          <p>语音助手动效设计实验室 / CONCEPT PROTO PARADIGM</p>
        </div>
      </div>
      <a href="/dashboard" class="back-btn">
        <svg style="width:1.1rem;height:1.1rem;" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3"></path>
        </svg>
        返回主控制台
      </a>
    </header>

    <!-- Real-time Mic Indicator Bar -->
    <div class="mic-status-bar">
      <div class="mic-status-info">
        <div class="mic-pulse-indicator" id="mic-led"></div>
        <div class="mic-status-text" id="mic-text">未接入真实麦克风（使用模拟幅值演示）</div>
      </div>
      <button class="action-btn action-btn-primary" id="btn-connect-mic" style="flex:0;min-width:180px;">
        <svg style="width:1rem;height:1rem;" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2a3 3 0 00-3 3v7a3 3 0 006 0V5a3 3 0 00-3-3zM4.3 11a1 1 0 100 2 7.7 7.7 0 0014.7 0 1 1 0 100-2 9.7 9.7 0 01-14.7 0zm6.7 8v2a1 1 0 102 0v-2a1 1 0 10-2 0z"/>
        </svg>
        连入真实麦克风
      </button>
    </div>

    <!-- 2x2 Grid -->
    <div class="visualizer-grid">

      <!-- CARD 1: Siri Fluid Wave -->
      <div class="visualizer-card">
        <div class="card-title card-title-siri">
          <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"></path>
          </svg>
          Siri 极速流体三色声波 (Siri Fluid Wave)
        </div>
        <div class="preview-area">
          <canvas class="preview-canvas" id="canvas-siri"></canvas>
        </div>
        <div class="card-desc">
          基于 HTML5 Canvas 构建的 60fps 三色平滑正弦声波。支持流体算法插值，线条的振幅和速度会随着实际输入音频分贝实时平滑波动。
        </div>
        <div class="card-actions">
          <button class="action-btn active" id="btn-siri-sim">模拟说话中</button>
          <button class="action-btn" id="btn-siri-quiet">模拟静音</button>
          <button class="action-btn action-btn-primary apply-theme-btn" id="btn-apply-siri" style="margin-left:auto;background:var(--color-primary);color:#fff;border-radius:6px;font-weight:600;padding:0.4rem 0.8rem;transition:all 0.3s;border:none;cursor:pointer;">应用此主题</button>
        </div>
      </div>



      <!-- CARD 4: Audio Equalizer & Particle Field -->
      <div class="${isHudModeStatic ? 'hud-card-mode' : 'visualizer-card'}" id="hud-card">
        <!-- SVG Bezier Backdrop Ears -->
        <svg class="notch-bridge-svg" viewBox="0 0 560 38" fill="none" xmlns="http://www.w3.org/2000/svg" style="position: absolute; left:0; top:0; width:560px; height:38px; pointer-events:none; z-index:2;">
          <path d="M 0,0 L 135,0 Q 142,0 145,12 Q 147,24 150,24 Q 160,24 165,31 Q 165,38 175,38 L 385,38 Q 395,38 400,31 Q 400,24 410,24 Q 413,24 415,12 Q 418,0 425,0 L 560,0 Z" fill="#000000" />
        </svg>

        <div class="notch-wing-left" id="hud-left-wing" style="position: relative; display: flex; align-items: center; justify-content: center;">
          <span id="hud-status-text" style="position: absolute; font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif; font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.8px; white-space: nowrap; opacity: 1; transform: scale(1); transition: color 0.3s ease, text-shadow 0.3s ease, opacity 0.3s ease, transform 0.3s ease;"></span>
          <div class="status-indicator-led" id="hud-status-led" style="position: absolute; opacity: 0; transform: scale(0.5); transition: opacity 0.3s ease, transform 0.3s ease !important;"></div>
        </div>
        <div class="notch-wing-right" id="hud-right-wing">
          <div class="eq-bar" id="eq-bar-1"></div>
          <div class="eq-bar" id="eq-bar-2"></div>
          <div class="eq-bar" id="eq-bar-3"></div>
          <div class="eq-bar" id="eq-bar-4"></div>
          <div class="eq-bar" id="eq-bar-5"></div>
        </div>
        <div class="preview-area" style="display: none;">
          <canvas class="preview-canvas" id="canvas-eq"></canvas>
        </div>
        <div class="card-desc">
          一个融合了频段均衡器（Equalizer Bars）与高维运动环境粒子流（Environment Particles）的动效。连入真实麦克风后能直观地看到环境粒子流在您的音浪中呼啸！
        </div>
        <div class="card-actions">
          <button class="action-btn active" id="btn-eq-sim">模拟高频波动</button>
          <button class="action-btn" id="btn-eq-quiet">模拟平静</button>
          <button class="action-btn action-btn-primary apply-theme-btn" id="btn-apply-vortex" style="margin-left:auto;background:var(--color-primary);color:#fff;border-radius:6px;font-weight:600;padding:0.4rem 0.8rem;transition:all 0.3s;border:none;cursor:pointer;">应用此主题</button>
        </div>
      </div>

    </div>

  </div>

  <script nonce="${cspNonce}">
    // Audio State
    let audioContext = null;
    let analyser = null;
    let dataArray = null;
    let source = null;
    let isMicConnected = false;
    let currentAmplitude = 0; // Globally computed real or simulated amplitude (0 to 1)

    // Siri Wave Config
    const canvasSiri = document.getElementById('canvas-siri');
    const ctxSiri = canvasSiri ? canvasSiri.getContext('2d') : null;
    let siriMode = 'simulate'; // 'simulate' or 'quiet'
    let siriPhase = 0;

    // EQ & Particles Config
    const canvasEq = document.getElementById('canvas-eq');
    const ctxEq = canvasEq ? canvasEq.getContext('2d') : null;
    let eqMode = 'simulate';
    let particles = [];
    const NUM_PARTICLES = 40;

    // Parse mode parameter
    const urlParams = new URLSearchParams(window.location.search);
    const isHudMode = urlParams.get('mode') === 'hud';
    function initHudMode() {
      document.documentElement.classList.add('hud-mode');
      document.body.classList.add('hud-mode');
      const hudCard = document.getElementById('hud-card');
      const h = parseInt(urlParams.get('h') || '24', 10);
      
      if (hudCard) {
        hudCard.classList.remove('visualizer-card');
        hudCard.classList.add('hud-card-mode');
        hudCard.style.setProperty('height', h + 'px', 'important');
      }
      
      // Update dynamic notch SVG path container size
      const svg = document.querySelector('.notch-bridge-svg');
      if (svg) {
        svg.setAttribute('height', h + 'px');
        svg.style.height = h + 'px';
        svg.setAttribute('viewBox', '0 0 560 ' + h);
      }

      const hudContainer = document.getElementById('hud-text-container');
      if (hudContainer) hudContainer.style.display = 'flex';
    }

    if (isHudMode) {
      eqMode = 'quiet'; // Start quiet/thinking swirl until voice active
      if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', initHudMode);
      } else {
        initHudMode();
      }
    }

    // Expose dynamic JSBridge interface for native app integrations
    let currentSpeechText = "";
    let currentVoiceState = 'idle';
    let currentExtension = 0; // Dynamic extension factor (0.0 to 1.0)
    let compactMode = false;
    let currentWingExtLeft = 0;
    let currentWingExtRight = 0;

    window.updateCompactMode = function(isCompact) {
      compactMode = isCompact;
    };

    window.updateVoiceState = function(state, amplitude, text) {
      const statusTextElement = document.getElementById('hud-status-text');
      const statusLedElement = document.getElementById('hud-status-led');
      const hudCard = document.getElementById('hud-card');
      
      currentVoiceState = state;
      currentAmplitude = amplitude;

      if (hudCard) {
        hudCard.className = 'hud-card-mode state-' + state;
      }
      
      if (statusTextElement) {
        if (state === 'listening') {
          statusTextElement.innerText = 'Listening';
          statusTextElement.style.color = '#ff3b30';
          statusTextElement.style.textShadow = '0 0 6px rgba(255, 59, 48, 0.6)';
          if (statusLedElement) {
            statusLedElement.style.background = '#ff3b30';
            statusLedElement.style.boxShadow = '0 0 8px 2px #ff3b30';
          }
        } else if (state === 'thinking') {
          statusTextElement.innerText = 'Thinking';
          statusTextElement.style.color = '#ffcc00';
          statusTextElement.style.textShadow = '0 0 6px rgba(255, 204, 0, 0.6)';
          if (statusLedElement) {
            statusLedElement.style.background = '#ffcc00';
            statusLedElement.style.boxShadow = '0 0 8px 2px #ffcc00';
          }
        } else if (state === 'speaking') {
          statusTextElement.innerText = 'Speaking';
          statusTextElement.style.color = '#007aff';
          statusTextElement.style.textShadow = '0 0 6px rgba(0, 122, 255, 0.6)';
          if (statusLedElement) {
            statusLedElement.style.background = '#007aff';
            statusLedElement.style.boxShadow = '0 0 8px 2px #007aff';
          }
        } else {
          statusTextElement.innerText = '';
          statusTextElement.style.color = 'transparent';
          statusTextElement.style.textShadow = 'none';
          if (statusLedElement) {
            statusLedElement.style.background = '#10b981';
            statusLedElement.style.boxShadow = '0 0 8px 2px #10b981';
          }
        }
      }
      
      eqMode = (state === 'listening' || state === 'speaking') ? 'realtime' : 'quiet';
    };

    // Initialize particle field
    function initParticles() {
      particles = [];
      for (let i = 0; i < NUM_PARTICLES; i++) {
        particles.push({
          x: Math.random() * canvasEq.width,
          y: Math.random() * canvasEq.height,
          radius: Math.random() * 2 + 1,
          vx: Math.random() * 0.5 - 0.25,
          vy: Math.random() * 0.5 - 0.25,
          color: i % 2 === 0 ? 'rgba(6, 182, 212, 0.4)' : 'rgba(168, 85, 247, 0.4)'
        });
      }
    }

    // Set canvas sizes
    function resizeCanvases() {
      const siriRect = canvasSiri.parentElement.getBoundingClientRect();
      canvasSiri.width = siriRect.width;
      canvasSiri.height = siriRect.height;
      
      const eqRect = canvasEq.parentElement.getBoundingClientRect();
      canvasEq.width = eqRect.width;
      canvasEq.height = eqRect.height;
      
      initParticles();
    }
    window.addEventListener('resize', resizeCanvases);
    setTimeout(resizeCanvases, 100);

    // Audio Capture Logic
    async function toggleMicrophone() {
      if (isMicConnected) {
        disconnectMicrophone();
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        
        const bufferLength = analyser.frequencyBinCount;
        dataArray = new Uint8Array(bufferLength);
        
        isMicConnected = true;
        document.getElementById('btn-connect-mic').innerText = "断开麦克风";
        document.getElementById('btn-connect-mic').classList.add('active');
        document.getElementById('mic-led').classList.add('active');
        document.getElementById('mic-text').innerText = "麦克风已就绪！视觉效果正由您的真实人声实时驱动";
        document.getElementById('mic-text').classList.add('active');
      } catch (err) {
        console.error("Failed to access microphone", err);
        alert("无法访问麦克风。请检查浏览器权限设置！");
      }
    }

    function disconnectMicrophone() {
      if (source) {
        source.disconnect();
        source = null;
      }
      if (audioContext) {
        audioContext.close();
        audioContext = null;
      }
      isMicConnected = false;
      document.getElementById('btn-connect-mic').innerHTML = 
        '<svg style="width:1rem;height:1rem;" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
          '<path d="M12 2a3 3 0 00-3 3v7a3 3 0 006 0V5a3 3 0 00-3-3zM4.3 11a1 1 0 100 2 7.7 7.7 0 0014.7 0 1 1 0 100-2 9.7 9.7 0 01-14.7 0zm6.7 8v2a1 1 0 102 0v-2a1 1 0 10-2 0z"/>' +
        '</svg>' +
        '连入真实麦克风';
      document.getElementById('btn-connect-mic').classList.remove('active');
      document.getElementById('mic-led').classList.remove('active');
      document.getElementById('mic-text').innerText = "已断开麦克风（使用模拟幅值演示）";
      document.getElementById('mic-text').classList.remove('active');
    }

    // Siri Modes
    function setSiriMode(mode) {
      siriMode = mode;
      document.getElementById('btn-siri-sim').classList.toggle('active', mode === 'simulate');
      document.getElementById('btn-siri-quiet').classList.toggle('active', mode === 'quiet');
    }

    // EQ Modes
    function setEqMode(mode) {
      eqMode = mode;
      document.getElementById('btn-eq-sim').classList.toggle('active', mode === 'simulate');
      document.getElementById('btn-eq-quiet').classList.toggle('active', mode === 'quiet');
    }



    // Full Screen Glow Overlay
    function triggerFullscreenGlow() {
      document.getElementById('fullscreen-overlay').classList.add('active');
      document.getElementById('fullscreen-toast').classList.add('active');
      
      // Add keyboard Esc escape listener
      document.addEventListener('keydown', handleEscKey);
    }
    
    function handleEscKey(e) {
      if (e.key === 'Escape') {
        document.getElementById('fullscreen-overlay').classList.remove('active');
        document.getElementById('fullscreen-toast').classList.remove('active');
        document.removeEventListener('keydown', handleEscKey);
      }
    }

    // Animation Loop
    function animate() {
      requestAnimationFrame(animate);
      
      // Calculate target extension
      let targetExtension = (currentVoiceState === 'idle') ? 0.0 : 1.0;
      currentExtension += (targetExtension - currentExtension) * 0.15;
      if (Math.abs(targetExtension - currentExtension) < 0.001) {
        currentExtension = targetExtension;
      }
      
      // 1. Process Audio Data
      if (isMicConnected && analyser) {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        let rawAmp = sum / dataArray.length / 120.0; // scale roughly to 0..1
        // Smooth amplitude transition
        currentAmplitude += (rawAmp - currentAmplitude) * 0.2;
        if (currentAmplitude > 1) currentAmplitude = 1;
      } else {
        // Use mathematical simulators if mic not connected
        let t = Date.now() * 0.003;
        let baseVal = 0.5 + 0.3 * Math.sin(t) + 0.2 * Math.cos(t * 2.3);
        
        // Siri simulator state
        let targetSiri = (siriMode === 'simulate' && (eqMode === 'simulate' || eqMode === 'realtime')) ? baseVal : 0.03;
        currentAmplitude += (targetSiri - currentAmplitude) * 0.1;
      }

      // 2. Draw Siri Waveform
      drawSiriWave();

      // 3. Draw EQ & Particles
      drawEqAndParticles();

      // 4. Update HUD Equalizer Bars and wing positioning at 60fps
      if (isHudMode) {
        const h = parseInt(urlParams.get('h') || '24', 10);
        
        let targetWingExtLeft = compactMode ? 10 : 70;
        let targetWingExtRight = compactMode ? 20 : 55;
        
        currentWingExtLeft += (targetWingExtLeft - currentWingExtLeft) * 0.15;
        currentWingExtRight += (targetWingExtRight - currentWingExtRight) * 0.15;
        
        let xLeft = 180 - currentExtension * currentWingExtLeft;
        let xRight = 380 + currentExtension * currentWingExtRight;

        const statusTextElement = document.getElementById('hud-status-text');
        const statusLedElement = document.getElementById('hud-status-led');
        
        if (compactMode) {
          if (statusTextElement) {
            statusTextElement.style.opacity = '0';
            statusTextElement.style.transform = 'scale(0.5)';
            statusTextElement.style.pointerEvents = 'none';
          }
          if (statusLedElement) {
            statusLedElement.style.opacity = '1';
            statusLedElement.style.transform = 'scale(1)';
            statusLedElement.style.pointerEvents = 'auto';
          }
        } else {
          if (statusLedElement) {
            statusLedElement.style.opacity = '0';
            statusLedElement.style.transform = 'scale(0.5)';
            statusLedElement.style.pointerEvents = 'none';
          }
          if (statusTextElement) {
            statusTextElement.style.opacity = '1';
            statusTextElement.style.transform = 'scale(1)';
            statusTextElement.style.pointerEvents = 'auto';
          }
        }

        const svg = document.querySelector('.notch-bridge-svg');
        if (svg) {
          const path = svg.querySelector('path');
          if (path) {
            let Rt = h <= 24 ? 6 : 8;
            let Rb = h <= 24 ? 12 : 16;
            let cpRt = Rt * 0.55228;
            let cpRb = Rb * 0.55228;

            let d = 'M 0,0 L ' + (xLeft - Rt - Rb) + ',0 ' +
                'C ' + (xLeft - Rt - Rb + cpRt) + ',0 ' + (xLeft - Rb) + ',' + (Rt - cpRt) + ' ' + (xLeft - Rb) + ',' + Rt + ' ' +
                'L ' + (xLeft - Rb) + ',' + (h - Rb) + ' ' +
                'C ' + (xLeft - Rb) + ',' + (h - Rb + cpRb) + ' ' + (xLeft - cpRb) + ',' + h + ' ' + xLeft + ',' + h + ' ' +
                'L ' + xRight + ',' + h + ' ' +
                'C ' + (xRight + cpRb) + ',' + h + ' ' + (xRight + Rb) + ',' + (h - Rb + cpRb) + ' ' + (xRight + Rb) + ',' + (h - Rb) + ' ' +
                'L ' + (xRight + Rb) + ',' + Rt + ' ' +
                'C ' + (xRight + Rb) + ',' + (Rt - cpRt) + ' ' + (xRight + Rb + Rt - cpRt) + ',0 ' + (xRight + Rb + Rt) + ',0 ' +
                'L 560,0 Z';
            path.setAttribute('d', d);
          }
        }

        const leftWing = document.getElementById('hud-left-wing');
        const rightWing = document.getElementById('hud-right-wing');
        
        if (leftWing) {
          leftWing.style.left = xLeft + 'px';
          leftWing.style.width = (180 - xLeft) + 'px';
          leftWing.style.opacity = currentExtension;
          leftWing.style.transform = 'scale(' + (0.6 + 0.4 * currentExtension) + ')';
          leftWing.style.setProperty('height', h + 'px', 'important');
        }
        
        if (rightWing) {
          rightWing.style.left = '380px';
          rightWing.style.width = (xRight - 380) + 'px';
          rightWing.style.opacity = currentExtension;
          rightWing.style.transform = 'scale(' + (0.6 + 0.4 * currentExtension) + ')';
          rightWing.style.setProperty('height', h + 'px', 'important');
          rightWing.style.paddingBottom = '0px';
        }

        const factors = [0.6, 1.2, 1.6, 1.0, 0.5];
        for (let i = 1; i <= 5; i++) {
          const bar = document.getElementById('eq-bar-' + i);
          if (bar) {
            if (compactMode && i > 3) {
              bar.style.opacity = '0';
              bar.style.width = '0px';
              bar.style.margin = '0px';
              continue;
            } else {
              bar.style.opacity = '1';
              bar.style.width = '3px';
              bar.style.margin = '';
            }
            let targetHeight = 3;
            if (currentVoiceState === 'listening' || currentVoiceState === 'speaking') {
              const amp = currentAmplitude || 0;
              const noise = Math.random() * 0.15;
              targetHeight = Math.max(3, Math.min(18, (amp * 25 + noise * 6) * factors[i-1]));
            } else if (currentVoiceState === 'thinking') {
              const t = Date.now() * 0.015;
              const wave = Math.sin(t + i * 0.8) * 0.5 + 0.5;
              targetHeight = Math.max(3, Math.min(12, 3 + wave * 9 * factors[i-1]));
            } else {
              const t = Date.now() * 0.005;
              const wave = Math.sin(t + i * 0.5) * 0.5 + 0.5;
              targetHeight = Math.max(3, Math.min(6, 3 + wave * 3 * factors[i-1]));
            }
            bar.style.height = targetHeight + 'px';
          }
        }
      }
    }

    function drawSiriWave() {
      ctxSiri.clearRect(0, 0, canvasSiri.width, canvasSiri.height);
      siriPhase += 0.08 + currentAmplitude * 0.15;
      
      const width = canvasSiri.width;
      const height = canvasSiri.height;
      const midY = height / 2;
      
      // Siri uses 3 overlapping sine waves with different parameters and alpha levels
      const waves = [
        { color: 'rgba(6, 182, 212, 0.7)', amp: 45 * currentAmplitude, speed: 0.1, freq: 0.015 },
        { color: 'rgba(168, 85, 247, 0.7)', amp: 30 * currentAmplitude, speed: -0.08, freq: 0.018 },
        { color: 'rgba(236, 72, 153, 0.5)', amp: 20 * currentAmplitude, speed: 0.12, freq: 0.012 }
      ];

      waves.forEach(w => {
        ctxSiri.beginPath();
        ctxSiri.strokeStyle = w.color;
        ctxSiri.lineWidth = w === waves[0] ? 3 : (w === waves[1] ? 2.2 : 1.5);
        
        // Glow effect
        ctxSiri.shadowBlur = 10;
        ctxSiri.shadowColor = w.color;

        for (let x = 0; x < width; x++) {
          // Attenuate ends using a Gaussian bell-curve envelope so they merge at 0
          const envelope = Math.pow(Math.E, -Math.pow((x - width/2) / (width/3.5), 2));
          const y = midY + Math.sin(x * w.freq + siriPhase) * w.amp * envelope;
          
          if (x === 0) {
            ctxSiri.moveTo(x, y);
          } else {
            ctxSiri.lineTo(x, y);
          }
        }
        ctxSiri.stroke();
      });
      ctxSiri.shadowBlur = 0; // Reset shadow
    }

    function drawEqAndParticles() {
      ctxEq.clearRect(0, 0, canvasEq.width, canvasEq.height);
      const width = canvasEq.width;
      const height = canvasEq.height;
      
      const isSiriTheme = document.body.classList.contains('theme-siri');

      if (isSiriTheme) {
        // Draw Siri Wave inside the HUD Canvas!
        siriPhase += 0.08 + currentAmplitude * 0.15;
        const midY = isHudMode ? 56 : height / 2;
        
        const waves = [
          { color: 'rgba(6, 182, 212, 0.7)', amp: 22 * currentAmplitude, speed: 0.1, freq: 0.015 },
          { color: 'rgba(168, 85, 247, 0.7)', amp: 15 * currentAmplitude, speed: -0.08, freq: 0.018 },
          { color: 'rgba(236, 72, 153, 0.5)', amp: 10 * currentAmplitude, speed: 0.12, freq: 0.012 }
        ];

        waves.forEach(w => {
          ctxEq.beginPath();
          ctxEq.strokeStyle = w.color;
          ctxEq.lineWidth = w === waves[0] ? 3 : (w === waves[1] ? 2.2 : 1.5);
          
          ctxEq.shadowBlur = 10;
          ctxEq.shadowColor = w.color;

          for (let x = 0; x < width; x++) {
            const envelope = Math.pow(Math.E, -Math.pow((x - width/2) / (width/3.5), 2));
            const y = midY + Math.sin(x * w.freq + siriPhase) * w.amp * envelope;
            
            if (x === 0) {
              ctxEq.moveTo(x, y);
            } else {
              ctxEq.lineTo(x, y);
            }
          }
          ctxEq.stroke();
        });
        ctxEq.shadowBlur = 0;
        return; // Don't draw vortex particles or bars!
      }
      
      // Update & Draw Background Particles
      particles.forEach(p => {
        if (eqMode === 'quiet') {
          // Quantum gravity vortex: slowly attract particles to the center of the canvas!
          const centerX = width / 2;
          const centerY = height / 2;
          const dx = centerX - p.x;
          const dy = centerY - p.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 5) {
            // Apply a soft gravity force vector pull towards center
            p.vx += (dx / dist) * 0.08;
            p.vy += (dy / dist) * 0.08;
            
            // Dampen overall speed to prevent orbiting wildly
            p.vx *= 0.94;
            p.vy *= 0.94;
          }
          p.x += p.vx;
          p.y += p.vy;
        } else {
          // Speed scaling driven by volume in listening / active mode
          const speedScale = 1.0 + currentAmplitude * 4.5;
          p.x += p.vx * speedScale;
          p.y += p.vy * speedScale;
          
          // Bounce bounds
          if (p.x < 0 || p.x > width) p.vx *= -1;
          if (p.y < 0 || p.y > height) p.vy *= -1;
        }
        
        ctxEq.beginPath();
        ctxEq.arc(p.x, p.y, p.radius * (1.0 + currentAmplitude * 1.5), 0, Math.PI * 2);
        ctxEq.fillStyle = p.color;
        ctxEq.shadowBlur = 4;
        ctxEq.shadowColor = p.color;
        ctxEq.fill();
      });
      ctxEq.shadowBlur = 0;

      // Draw EQ Bars
      const numBars = isHudMode ? 12 : 16;
      const barWidth = isHudMode ? 4 : 6;
      const gap = isHudMode ? 6 : 8;
      const startX = (width - (numBars * barWidth + (numBars - 1) * gap)) / 2;
      
      for (let i = 0; i < numBars; i++) {
        // Compute active height for this specific frequency bar
        let ampFactor = 0;
        if (isMicConnected && analyser) {
          // Read from frequency bins
          const binIndex = Math.floor((i / numBars) * (dataArray.length / 2));
          ampFactor = (dataArray[binIndex] || 0) / 255.0;
        } else {
          // Simulated EQ behavior
          const modeAmp = (eqMode === 'simulate' || eqMode === 'realtime') ? currentAmplitude : 0.05;
          const noise = 0.3 * Math.sin(Date.now() * 0.005 + i) + 0.1 * Math.cos(Date.now() * 0.009 + i * 2.3);
          ampFactor = modeAmp * 0.7 + Math.max(0, noise) * modeAmp * 0.6;
        }
        
        const maxPossibleHeight = isHudMode ? 28 : height - 24;
        const barHeight = Math.max(4, ampFactor * maxPossibleHeight);
        const x = startX + i * (barWidth + gap);
        const y = isHudMode ? 56 - barHeight / 2 : height - barHeight - 20;
        
        // Modern curved rounded pillars with a high-fidelity linear gradient
        const grad = ctxEq.createLinearGradient(x, y, x, isHudMode ? y + barHeight : height - 20);
        if (isHudMode) {
          grad.addColorStop(0, '#06b6d4'); // Cyan top
          grad.addColorStop(0.5, '#a855f7'); // Purple middle
          grad.addColorStop(1, '#06b6d4'); // Cyan bottom
        } else {
          grad.addColorStop(0, '#06b6d4'); // Cyan top
          grad.addColorStop(0.5, '#a855f7'); // Purple middle
          grad.addColorStop(1, 'rgba(168, 85, 247, 0.1)'); // Transparent tail
        }

        ctxEq.fillStyle = grad;
        
        if (isHudMode) {
          drawPill(ctxEq, x, y, barWidth, barHeight, barWidth / 2);
        } else {
          drawRoundedRect(ctxEq, x, y, barWidth, barHeight, 3);
        }
      }
    }

    // Helper: Pill with rounded all 4 corners
    function drawPill(ctx, x, y, width, height, radius) {
      if (height < 2 * radius) radius = height / 2;
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.arcTo(x + width, y, x + width, y + height, radius);
      ctx.arcTo(x + width, y + height, x, y + height, radius);
      ctx.arcTo(x, y + height, x, y, radius);
      ctx.arcTo(x, y, x + width, y, radius);
      ctx.closePath();
      ctx.fill();
    }

    // Helper: Rounded Rectangle (straight bottom)
    function drawRoundedRect(ctx, x, y, width, height, radius) {
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + width - radius, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
      ctx.lineTo(x + width, y + height);
      ctx.lineTo(x, y + height);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
      ctx.fill();
    }

    // Live Theme Switching Playground Integration
    let activeTheme = 'vortex';
    async function checkActiveTheme() {
      try {
        const response = await fetch('/api/voice-settings');
        const data = await response.json();
        let theme = data.hud_theme || 'vortex';
        if (theme !== 'vortex' && theme !== 'siri') {
          theme = 'vortex';
        }
        activeTheme = theme;
        
        document.querySelectorAll('.apply-theme-btn').forEach(btn => {
          btn.style.background = 'var(--color-primary)';
          btn.style.boxShadow = 'none';
          btn.innerText = '应用此主题';
        });
        
        const activeBtn = document.getElementById('btn-apply-' + activeTheme);
        if (activeBtn) {
          activeBtn.style.background = 'var(--color-success)';
          activeBtn.style.boxShadow = '0 0 8px var(--color-success)';
          activeBtn.innerText = '当前正在使用';
        }
      } catch (err) {
        console.error(err);
      }
    }
    
    window.applyTheme = async function(theme) {
      try {
        const getRes = await fetch('/api/voice-settings');
        const settings = await getRes.json();
        
        settings.hud_theme = theme;
        
        const postRes = await fetch('/api/voice-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings)
        });
        
        if (postRes.ok) {
          const toast = document.getElementById('fullscreen-toast');
          if (toast) {
            let themeName = theme === 'siri' ? 'Siri 极速流体三色声波' : '极光频谱与环境粒子流';
            
            toast.innerHTML = '🎉 <strong>一键换装成功！</strong> 已成功将 <strong>' + themeName + '</strong> 应用为悬浮卡片默认主题！';
            toast.classList.add('active');
            setTimeout(() => {
              toast.classList.remove('active');
            }, 3000);
          }
          checkActiveTheme();
        }
      } catch (err) {
        console.error('Failed to apply theme:', err);
      }
    }
    
    if (!isHudMode) {
      checkActiveTheme();
    }

    document.getElementById('btn-connect-mic')?.addEventListener('click', toggleMicrophone);
    document.getElementById('btn-siri-sim')?.addEventListener('click', () => setSiriMode('simulate'));
    document.getElementById('btn-siri-quiet')?.addEventListener('click', () => setSiriMode('quiet'));
    document.getElementById('btn-apply-siri')?.addEventListener('click', () => applyTheme('siri'));
    document.getElementById('btn-eq-sim')?.addEventListener('click', () => setEqMode('simulate'));
    document.getElementById('btn-eq-quiet')?.addEventListener('click', () => setEqMode('quiet'));
    document.getElementById('btn-apply-vortex')?.addEventListener('click', () => applyTheme('vortex'));

    // Run animation on load
    animate();
  </script>
</body>
</html>
`;
}
