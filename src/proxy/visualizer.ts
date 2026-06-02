/**
 * OpenCodex Local Voice Visualizer Playground
 * Served directly on http://localhost:8765/visualizer.
 * Provides interactive, high-fidelity mockups of Siri fluid wave, Apple Intelligence border glow,
 * Cyberpunk rotating scanner halo, and live audio-reactive amplitude sync via real Web Audio API mic input.
 */

export function getVisualizerHtml(isHudModeStatic: boolean = false, hudTheme: string = "vortex"): string {
  return `<!DOCTYPE html>
<html lang="zh-CN" ${isHudModeStatic ? 'class="hud-mode"' : ''}>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenCodex Voice Visualizer Playground</title>
  <!-- Google Fonts Outfit & JetBrains Mono -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=JetBrains+Mono:wght@300;400;700&display=swap" rel="stylesheet">
  
  <style>
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
      font-family: 'Outfit', sans-serif;
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
      font-family: 'JetBrains Mono', monospace;
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

    /* Virtual Screen for Border Glow */
    .virtual-screen {
      width: 90%;
      height: 85%;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #000;
      overflow: hidden;
      box-shadow: inset 0 0 15px rgba(0,0,0,0.8);
    }
    .virtual-screen-content {
      font-size: 0.75rem;
      color: var(--color-text-muted);
      text-transform: uppercase;
      font-family: 'JetBrains Mono', monospace;
      letter-spacing: 2px;
      text-align: center;
    }
    
    /* Virtual Apple Intelligence Border Glow Effect */
    .virtual-glow-border {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      border: 2px solid transparent;
      border-radius: 8px;
      pointer-events: none;
      box-shadow: inset 0 0 0px transparent;
      transition: all 0.5s ease;
    }
    .virtual-screen.active .virtual-glow-border {
      animation: borderGlowSweep 6s infinite linear, borderGlowPulse 2.5s infinite ease-in-out;
      box-shadow: inset 0 0 10px rgba(168, 85, 247, 0.4), 0 0 15px rgba(6, 182, 212, 0.4);
    }
    @keyframes borderGlowPulse {
      0%, 100% { opacity: 0.6; }
      50% { opacity: 1; }
    }
    @keyframes borderGlowSweep {
      0% {
        border-image: linear-gradient(0deg, var(--color-primary), var(--color-secondary), var(--color-warning), var(--color-primary)) 1;
      }
      50% {
        border-image: linear-gradient(180deg, var(--color-primary), var(--color-secondary), var(--color-warning), var(--color-primary)) 1;
      }
      100% {
        border-image: linear-gradient(360deg, var(--color-primary), var(--color-secondary), var(--color-warning), var(--color-primary)) 1;
      }
    }

    /* Cyberpunk Halo Spinner Preview */
    .halo-container {
      position: relative;
      width: 80px;
      height: 80px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .halo-ring {
      position: absolute;
      width: 100%;
      height: 100%;
      border: 3px solid rgba(255, 255, 255, 0.05);
      border-radius: 50%;
      box-sizing: border-box;
      transition: var(--transition-standard);
    }
    .halo-scan-light {
      position: absolute;
      width: 100%;
      height: 100%;
      border: 3px solid transparent;
      border-top-color: var(--color-secondary);
      border-right-color: var(--color-primary);
      border-radius: 50%;
      box-sizing: border-box;
      animation: haloRotate 1.2s infinite linear;
      opacity: 0;
      transition: var(--transition-standard);
      filter: drop-shadow(0 0 5px var(--color-secondary));
    }
    .halo-core {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      background: var(--color-success);
      box-shadow: 0 0 15px var(--color-success);
      transition: var(--transition-standard);
    }
    
    /* Halo States styling */
    .halo-container.idle .halo-core {
      background: var(--color-success);
      box-shadow: 0 0 12px var(--color-success);
      animation: haloBreathe 2s infinite ease-in-out;
    }
    .halo-container.listening .halo-core {
      background: var(--color-danger);
      box-shadow: 0 0 20px var(--color-danger);
      animation: haloRapidPulse 0.8s infinite ease-in-out;
    }
    .halo-container.sending .halo-scan-light {
      opacity: 1;
    }
    .halo-container.sending .halo-core {
      background: var(--color-warning);
      box-shadow: 0 0 12px var(--color-warning);
    }
    
    @keyframes haloRotate {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    @keyframes haloBreathe {
      0%, 100% { transform: scale(1); opacity: 0.8; }
      50% { transform: scale(1.15); opacity: 1; }
    }
    @keyframes haloRapidPulse {
      0%, 100% { transform: scale(1); box-shadow: 0 0 10px var(--color-danger); }
      50% { transform: scale(1.3); box-shadow: 0 0 25px var(--color-danger); }
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
      overflow: hidden !important;
      margin: 0 !important;
      padding: 0 !important;
      width: 100% !important;
      height: 100% !important;
      border: none !important;
      outline: none !important;
      box-shadow: none !important;
      display: flex !important;
      align-items: center !important;
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
      align-items: center !important;
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
      align-items: center !important;
      justify-content: center !important;
      width: 100% !important;
      height: 100% !important;
      border: none !important;
      background: transparent !important;
    }
    body.hud-mode #hud-card {
      background: transparent !important;
      border: 1px solid rgba(255, 255, 255, 0.18) !important;
      border-radius: 38px !important;
      padding: 0 !important; /* Set to 0 to prevent absolute children from shrinking or misaligning */
      width: calc(100% - 32px) !important;
      height: calc(100% - 24px) !important;
      margin: 12px 16px !important;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.65) !important; /* Box shadow kept here (no backdrop-filter) so WebKit renders it perfectly rounded */
      display: flex !important;
      flex-direction: row !important;
      align-items: center !important;
      gap: 1.2rem !important;
      box-sizing: border-box !important;
      position: relative !important;
      z-index: 1 !important;
      transition: border-color 0.4s ease, box-shadow 0.4s ease !important;
    }

    body.hud-mode #hud-card::before {
      content: "" !important;
      position: absolute !important;
      /* Positioned slightly offset to fully cover border areas */
      top: -1px !important;
      left: -1px !important;
      right: -1px !important;
      bottom: -1px !important;
      background: rgba(18, 18, 24, 0.65) !important;
      border-radius: 38px !important;
      backdrop-filter: blur(20px) saturate(180%) !important;
      -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
      box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.2) !important;
      z-index: -1 !important;
      overflow: hidden !important;
      transform: translate3d(0, 0, 0) !important;
      -webkit-transform: translate3d(0, 0, 0) !important;
      pointer-events: none !important;
    }

    /* Keep the visual margin spacing since parent padding is 0 */
    body.hud-mode #hud-text-container {
      margin-left: 1.6rem !important;
    }
    body.hud-mode .preview-area {
      margin-right: 1.6rem !important;
    }
    /* Glow theme overrides in HUD Mode */
    body.hud-mode.theme-glow #hud-card {
      animation: capsuleGlowFlow 6s infinite alternate ease-in-out !important;
    }
    
    @keyframes capsuleGlowFlow {
      0% {
        box-shadow: 0 0 20px rgba(6, 182, 212, 0.45), 0 0 35px rgba(168, 85, 247, 0.25), inset 0 0 8px rgba(6, 182, 212, 0.2) !important;
        border-color: rgba(6, 182, 212, 0.6) !important;
      }
      50% {
        box-shadow: 0 0 25px rgba(236, 72, 153, 0.45), 0 0 40px rgba(6, 182, 212, 0.25), inset 0 0 8px rgba(236, 72, 153, 0.2) !important;
        border-color: rgba(236, 72, 153, 0.6) !important;
      }
      100% {
        box-shadow: 0 0 20px rgba(168, 85, 247, 0.45), 0 0 35px rgba(236, 72, 153, 0.25), inset 0 0 8px rgba(168, 85, 247, 0.2) !important;
        border-color: rgba(168, 85, 247, 0.6) !important;
      }
    }
    
    /* Halo theme overrides in HUD Mode */
    body.hud-mode.theme-halo #hud-card {
      box-shadow: 0 0 20px rgba(16, 185, 129, 0.25), inset 0 0 8px rgba(16, 185, 129, 0.1) !important;
      border-color: rgba(16, 185, 129, 0.4) !important;
      animation: borderPulseHalo 3s infinite alternate ease-in-out !important;
    }
    
    @keyframes borderPulseHalo {
      0%, 100% { border-color: rgba(16, 185, 129, 0.3) !important; }
      50% { border-color: rgba(16, 185, 129, 0.6) !important; }
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
    body.hud-mode .preview-area {
      background: transparent !important;
      border: none !important;
      flex: 1 !important;
      height: 100% !important;
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
      <button class="action-btn action-btn-primary" id="btn-connect-mic" onclick="toggleMicrophone()" style="flex:0;min-width:180px;">
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
          <button class="action-btn active" id="btn-siri-sim" onclick="setSiriMode('simulate')">模拟说话中</button>
          <button class="action-btn" id="btn-siri-quiet" onclick="setSiriMode('quiet')">模拟静音</button>
          <button class="action-btn action-btn-primary apply-theme-btn" id="btn-apply-siri" onclick="applyTheme('siri')" style="margin-left:auto;background:var(--color-primary);color:#fff;border-radius:6px;font-weight:600;padding:0.4rem 0.8rem;transition:all 0.3s;border:none;cursor:pointer;">应用此主题</button>
        </div>
      </div>

      <!-- CARD 2: Capsule Local Glow -->
      <div class="visualizer-card">
        <div class="card-title card-title-glow">
          <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 4.5v15m6-15v15m-10.875 0h15.75c.621 0 1.125-.504 1.125-1.125V5.625c0-.621-.504-1.125-1.125-1.125H4.125C3.504 4.5 3 5.004 3 5.625v12.75c0 .621.504 1.125 1.125 1.125z"></path>
          </svg>
          胶囊边缘舱体流光 (Capsule Local Glow)
        </div>
        <div class="preview-area" style="display:flex;align-items:center;justify-content:center;padding:1.5rem 0;">
          <div id="capsule-preview" style="background: rgba(18, 18, 24, 0.96); border: 1px solid rgba(6, 182, 212, 0.4); border-radius: 38px; padding: 1.25rem 2rem; width: 85%; box-sizing: border-box; display: flex; align-items: center; gap: 1rem; transition: border-color 0.1s ease, box-shadow 0.1s ease;">
            <span style="width: 6px; height: 6px; background-color: var(--color-danger); border-radius: 50%; box-shadow: 0 0 8px var(--color-danger); animation: borderGlowPulse 2.5s infinite;"></span>
            <div style="flex:1; text-align:left; font-size:0.75rem; color:#fff; font-family:-apple-system; font-weight:600; letter-spacing:1.5px;">LOCAL GLOW ACTIVE</div>
          </div>
        </div>
        <div class="card-desc">
          专为底部悬浮胶囊面板定制的边缘漫反射流光。流光在胶囊外边缘如彩虹般流淌波动，避免全屏流光带来的突兀感，科技感十足！
        </div>
        <div class="card-actions">
          <button class="action-btn active" id="btn-glow-sim" onclick="setGlowMode('simulate')">模拟说话中</button>
          <button class="action-btn" id="btn-glow-quiet" onclick="setGlowMode('quiet')">模拟静音</button>
          <button class="action-btn action-btn-primary apply-theme-btn" id="btn-apply-glow" onclick="applyTheme('glow')" style="margin-left:auto;background:var(--color-primary);color:#fff;border-radius:6px;font-weight:600;padding:0.4rem 0.8rem;transition:all 0.3s;border:none;cursor:pointer;">应用此主题</button>
        </div>
      </div>

      <!-- CARD 3: Cyberpunk Scanning Halo -->
      <div class="visualizer-card">
        <div class="card-title card-title-halo">
          <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992M2.247 11.83h4.992M7.482 17.25h1.65m3.75 0h.008m-3.75-6.15h.008m3.75 0h.008m-3.75 4.075h.008m3.75 0h.008M8.288 4.144l.011.011m0 3.53l-.01-.01m3.987-4.64l.011.011M8.288 15.35l.01-.01m4.986-7.35l.01.01m1.996 1.99a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
          赛博旋转扫描光晕 (Dynamic Scan Ring)
        </div>
        <div class="preview-area">
          <div class="halo-container idle" id="halo">
            <div class="halo-ring"></div>
            <div class="halo-scan-light"></div>
            <div class="halo-core"></div>
          </div>
        </div>
        <div class="card-desc">
          一种为小尺寸图标量身定制的高拟真动效。在 'Idle'（静置空闲）、'Listening'（分贝联动红色跳跃）和 'Processing'（蓝色旋转扫描）三种状态间平滑过渡。
        </div>
        <div class="card-actions">
          <button class="action-btn active" id="btn-halo-idle" onclick="setHaloState('idle')">闲置 (Breathe)</button>
          <button class="action-btn" id="btn-halo-list" onclick="setHaloState('listening')">聆听 (Pulse)</button>
          <button class="action-btn" id="btn-halo-send" onclick="setHaloState('sending')">处理 (Scan)</button>
          <button class="action-btn action-btn-primary apply-theme-btn" id="btn-apply-halo" onclick="applyTheme('halo')" style="margin-left:auto;background:var(--color-primary);color:#fff;border-radius:6px;font-weight:600;padding:0.4rem 0.8rem;transition:all 0.3s;border:none;cursor:pointer;">应用此主题</button>
        </div>
      </div>

      <!-- CARD 4: Audio Equalizer & Particle Field -->
      <div class="${isHudModeStatic ? 'hud-card-mode' : 'visualizer-card'}" id="hud-card">
        <div class="card-title card-title-eq">
          <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"></path>
          </svg>
          极光频谱与环境粒子流 (Spectrum & Particles)
        </div>
        <!-- Left text container specifically for HUD Mode -->
        <div id="hud-text-container" style="display: none; flex-direction: column; justify-content: center; width: 230px; gap: 0.15rem; flex-shrink: 0; text-align: left; overflow: hidden; position: relative;">
          <div id="hud-state-label" style="font-size: 0.65rem; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; color: var(--color-secondary); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; z-index: 2; background: transparent;">
            <span class="status-dot" id="hud-status-dot"></span>
            <span id="hud-state-text">IDLE</span>
          </div>
          <!-- Subtext scrolling viewport wrapper -->
          <div style="width: 230px; overflow: hidden; position: relative; height: 1.2rem; z-index: 1;">
            <div id="hud-subtext" style="font-size: 0.76rem; font-weight: 500; color: rgba(255, 255, 255, 0.88); white-space: nowrap; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: inline-block; position: absolute; left: 0; top: 0; transform: translateX(0); width: max-content; max-width: none !important;">Ready</div>
          </div>
        </div>
        <div class="preview-area">
          <canvas class="preview-canvas" id="canvas-eq"></canvas>
        </div>
        <div class="card-desc">
          一个融合了频段均衡器（Equalizer Bars）与高维运动环境粒子流（Environment Particles）的动效。连入真实麦克风后能直观地看到环境粒子流在您的音浪中呼啸！
        </div>
        <div class="card-actions">
          <button class="action-btn active" id="btn-eq-sim" onclick="setEqMode('simulate')">模拟高频波动</button>
          <button class="action-btn" id="btn-eq-quiet" onclick="setEqMode('quiet')">模拟平静</button>
          <button class="action-btn action-btn-primary apply-theme-btn" id="btn-apply-vortex" onclick="applyTheme('vortex')" style="margin-left:auto;background:var(--color-primary);color:#fff;border-radius:6px;font-weight:600;padding:0.4rem 0.8rem;transition:all 0.3s;border:none;cursor:pointer;">应用此主题</button>
        </div>
      </div>

    </div>

  </div>

  <script>
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
    let glowMode = 'simulate'; // 'simulate' or 'quiet'
    let particles = [];
    const NUM_PARTICLES = 40;

    // Parse mode parameter
    const urlParams = new URLSearchParams(window.location.search);
    const isHudMode = urlParams.get('mode') === 'hud';
    function initHudMode() {
      document.documentElement.classList.add('hud-mode');
      document.body.classList.add('hud-mode');
      const hudCard = document.getElementById('hud-card');
      if (hudCard) {
        hudCard.classList.remove('visualizer-card');
        hudCard.classList.add('hud-card-mode');
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

    window.updateVoiceState = function(state, amplitude, text) {
      // state: 'listening', 'thinking', 'speaking', 'idle'
      const stateLabel = document.getElementById('hud-state-label');
      const stateText = document.getElementById('hud-state-text');
      const statusDot = document.getElementById('hud-status-dot');
      const subtext = document.getElementById('hud-subtext');
      
      currentAmplitude = amplitude;
      
      if (state === 'listening') {
        currentSpeechText = "";
        // Dynamic theme synchronization on wake-up!
        fetch('/api/voice-settings')
          .then(res => res.json())
          .then(data => {
            document.body.classList.remove('theme-vortex', 'theme-siri', 'theme-glow', 'theme-halo');
            document.body.classList.add('theme-' + (data.hud_theme || 'vortex'));
          })
          .catch(err => console.error('Failed to sync theme:', err));

        if (stateLabel) stateLabel.style.color = 'var(--color-danger)';
        if (stateText) stateText.innerText = 'Listening';
        if (statusDot) {
          statusDot.style.backgroundColor = 'var(--color-danger)';
          statusDot.style.boxShadow = '0 0 8px var(--color-danger)';
        }
        if (subtext) {
          subtext.style.transition = 'none';
          subtext.style.transform = 'translateX(0)';
          subtext.innerText = text || 'Listening to voice...';
        }
        eqMode = 'realtime';
      } else if (state === 'thinking') {
        currentSpeechText = "";
        if (stateLabel) stateLabel.style.color = 'var(--color-warning)';
        if (stateText) stateText.innerText = 'Thinking';
        if (statusDot) {
          statusDot.style.backgroundColor = 'var(--color-warning)';
          statusDot.style.boxShadow = '0 0 8px var(--color-warning)';
        }
        if (subtext) {
          subtext.style.transition = 'none';
          subtext.style.transform = 'translateX(0)';
          subtext.innerText = text || 'Thinking...';
        }
        eqMode = 'quiet';
      } else if (state === 'speaking') {
        if (stateLabel) stateLabel.style.color = 'var(--color-secondary)';
        if (stateText) stateText.innerText = 'Speaking';
        if (statusDot) {
          statusDot.style.backgroundColor = 'var(--color-secondary)';
          statusDot.style.boxShadow = '0 0 8px var(--color-secondary)';
        }
        eqMode = 'realtime';
        
        if (subtext && text && currentSpeechText !== text) {
          currentSpeechText = text;
          // 1. Reset position immediately
          subtext.style.transition = 'none';
          subtext.style.transform = 'translateX(0)';
          subtext.innerText = text;
          
          // 2. Measure and trigger smooth marquee scroll
          const textWidth = subtext.offsetWidth;
          const containerWidth = 230;
          const offset = textWidth - containerWidth;
          
          if (offset > 0) {
            // Force layout reflow so the transition starts from 0
            subtext.offsetHeight; 
            
            // Uniform speaking rate: flat 190ms per character across all text lengths and languages, plus a tiny 300ms speech initiation buffer
            const durationMs = text.length * 190 + 300;
            const durationSec = Math.max(1.2, durationMs / 1000);
            
            subtext.style.transition = 'transform ' + durationSec + 's linear';
            subtext.style.transform = 'translateX(-' + offset + 'px)';
          }
        }
      } else if (state === 'idle') {
        currentSpeechText = "";
        if (stateLabel) stateLabel.style.color = 'var(--color-success)';
        if (stateText) stateText.innerText = 'Idle';
        if (statusDot) {
          statusDot.style.backgroundColor = 'var(--color-success)';
          statusDot.style.boxShadow = '0 0 8px var(--color-success)';
        }
        if (subtext) {
          subtext.style.transition = 'none';
          subtext.style.transform = 'translateX(0)';
          subtext.innerText = text || 'Ready';
        }
        eqMode = 'quiet';
      }
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

    // Glow Modes
    function setGlowMode(mode) {
      glowMode = mode;
      document.getElementById('btn-glow-sim').classList.toggle('active', mode === 'simulate');
      document.getElementById('btn-glow-quiet').classList.toggle('active', mode === 'quiet');
    }

    // Halo States
    function setHaloState(state) {
      const halo = document.getElementById('halo');
      halo.className = 'halo-container ' + state;
      
      document.getElementById('btn-halo-idle').classList.toggle('active', state === 'idle');
      document.getElementById('btn-halo-list').classList.toggle('active', state === 'listening');
      document.getElementById('btn-halo-send').classList.toggle('active', state === 'sending');
    }

    // Border Glow Virtual Toggle
    function toggleVirtualScreen() {
      const vs = document.getElementById('vscreen');
      vs.classList.toggle('active');
      document.getElementById('btn-vscreen-toggle').classList.toggle('active', vs.classList.contains('active'));
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
        let targetSiri = siriMode === 'simulate' ? baseVal : 0.03;
        currentAmplitude += (targetSiri - currentAmplitude) * 0.1;
      }

      // 2. Draw Siri Waveform
      drawSiriWave();

      // 3. Draw EQ & Particles
      drawEqAndParticles();

      // 4. Update Card 2 Capsule Glow Preview
      const capsulePreview = document.getElementById('capsule-preview');
      if (capsulePreview) {
        let isQuiet = glowMode === 'quiet';
        let glowAmp = isQuiet ? 0.05 : currentAmplitude;
        
        const cyanAlpha = 0.25 + glowAmp * 0.5;
        const purpleAlpha = 0.12 + glowAmp * 0.4;
        const borderCyanAlpha = 0.35 + glowAmp * 0.45;
        const shadowGlow1 = 12 + glowAmp * 20;
        const shadowGlow2 = 20 + glowAmp * 25;
        
        capsulePreview.style.boxShadow = '0 0 ' + shadowGlow1 + 'px rgba(6, 182, 212, ' + cyanAlpha + '), 0 0 ' + shadowGlow2 + 'px rgba(168, 85, 247, ' + purpleAlpha + '), inset 0 0 8px rgba(6, 182, 212, 0.2)';
        capsulePreview.style.borderColor = 'rgba(6, 182, 212, ' + borderCyanAlpha + ')';
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
      const isGlowTheme = document.body.classList.contains('theme-glow');
      const isHaloTheme = document.body.classList.contains('theme-halo');

      if (isSiriTheme) {
        // Draw Siri Wave inside the HUD Canvas!
        siriPhase += 0.08 + currentAmplitude * 0.15;
        const midY = height / 2;
        
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

      if (isGlowTheme) {
        // Draw a premium, sleek flowing neon audio wave string
        siriPhase += 0.08 + currentAmplitude * 0.12;
        const midY = height / 2;
        ctxEq.beginPath();
        
        const grad = ctxEq.createLinearGradient(0, 0, width, 0);
        grad.addColorStop(0, 'rgba(6, 182, 212, 0.95)');   // Cyan
        grad.addColorStop(0.5, 'rgba(236, 72, 153, 0.95)'); // Pink
        grad.addColorStop(1, 'rgba(168, 85, 247, 0.95)');   // Purple
        
        ctxEq.strokeStyle = grad;
        ctxEq.lineWidth = 3.5;
        ctxEq.shadowBlur = 18;
        ctxEq.shadowColor = 'rgba(236, 72, 153, 0.8)';
        
        ctxEq.moveTo(0, midY);
        for (let x = 0; x < width; x++) {
          const envelope = Math.pow(Math.E, -Math.pow((x - width/2) / (width/3.2), 2));
          const y1 = Math.sin(x * 0.018 + siriPhase) * 18 * currentAmplitude * envelope;
          const y2 = Math.cos(x * 0.012 - siriPhase * 0.8) * 8 * currentAmplitude * envelope;
          ctxEq.lineTo(x, midY + y1 + y2);
        }
        ctxEq.stroke();
        ctxEq.shadowBlur = 0;
        return;
      }

      if (isHaloTheme) {
        // Draw a cyberpunk horizontal scanning grid/laser sweep and core indicators
        const midY = height / 2;
        const time = Date.now() * 0.003;
        
        // 1. Draw glowing horizontal guide laser lines
        ctxEq.beginPath();
        ctxEq.strokeStyle = 'rgba(16, 185, 129, 0.15)'; // Deep emerald glow
        ctxEq.lineWidth = 1;
        ctxEq.moveTo(0, midY - 12);
        ctxEq.lineTo(width, midY - 12);
        ctxEq.moveTo(0, midY + 12);
        ctxEq.lineTo(width, midY + 12);
        ctxEq.stroke();

        // 2. Draw a high-tech glowing horizontal laser sweep that bounces left and right
        const sweepX = (width / 2) + Math.sin(time * 1.5) * (width * 0.42);
        const sweepHeight = 18 + currentAmplitude * 20;
        ctxEq.beginPath();
        const laserGrad = ctxEq.createLinearGradient(sweepX - 30, 0, sweepX + 30, 0);
        laserGrad.addColorStop(0, 'rgba(16, 185, 129, 0)');
        laserGrad.addColorStop(0.5, 'rgba(16, 185, 129, ' + (0.4 + currentAmplitude * 0.6) + ')');
        laserGrad.addColorStop(1, 'rgba(16, 185, 129, 0)');
        ctxEq.strokeStyle = laserGrad;
        ctxEq.lineWidth = 4;
        ctxEq.shadowBlur = 12;
        ctxEq.shadowColor = 'rgba(16, 185, 129, 0.8)';
        ctxEq.moveTo(sweepX, midY - sweepHeight / 2);
        ctxEq.lineTo(sweepX, midY + sweepHeight / 2);
        ctxEq.stroke();

        // 3. Draw a circular breathing holographic scanner core in the center
        const coreRadius = 14 + currentAmplitude * 10;
        ctxEq.beginPath();
        ctxEq.arc(width / 2, midY, coreRadius, 0, Math.PI * 2);
        ctxEq.strokeStyle = 'rgba(16, 185, 129, 0.4)';
        ctxEq.lineWidth = 1.5;
        ctxEq.stroke();
        
        // Holographic core ticks (crosshairs)
        ctxEq.beginPath();
        ctxEq.strokeStyle = 'rgba(16, 185, 129, 0.6)';
        ctxEq.lineWidth = 1.5;
        ctxEq.moveTo(width / 2 - coreRadius - 4, midY);
        ctxEq.lineTo(width / 2 - coreRadius + 2, midY);
        ctxEq.moveTo(width / 2 + coreRadius - 2, midY);
        ctxEq.lineTo(width / 2 + coreRadius + 4, midY);
        ctxEq.moveTo(width / 2, midY - coreRadius - 4);
        ctxEq.lineTo(width / 2, midY - coreRadius + 2);
        ctxEq.moveTo(width / 2, midY + coreRadius - 2);
        ctxEq.lineTo(width / 2, midY + coreRadius + 4);
        ctxEq.stroke();

        // Glowing center core dot
        ctxEq.beginPath();
        ctxEq.arc(width / 2, midY, 5 + currentAmplitude * 4, 0, Math.PI * 2);
        ctxEq.fillStyle = 'rgba(16, 185, 129, ' + (0.7 + currentAmplitude * 0.3) + ')';
        ctxEq.fill();

        ctxEq.shadowBlur = 0;
        return;
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
        
        const maxPossibleHeight = height - 24;
        const barHeight = Math.max(4, ampFactor * maxPossibleHeight);
        const x = startX + i * (barWidth + gap);
        const y = isHudMode ? (height - barHeight) / 2 : height - barHeight - 20;
        
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
        activeTheme = data.hud_theme || 'vortex';
        
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
            let themeName = '极光频谱与环境粒子流';
            if (theme === 'siri') themeName = 'Siri 极速流体三色声波';
            else if (theme === 'glow') themeName = '胶囊边缘舱体流光';
            else if (theme === 'halo') themeName = '赛博旋转扫描光晕';
            
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

    // Run animation on load
    animate();
  </script>
</body>
</html>
`;
}
