// OpenCodex Core Verification Test Suite
// Verifies screenshot capture, OS mouse/keyboard actions, and Proxy Server binding.

import { ProxyServer } from "./dist/proxy/index.js";
import { ScreenshotTaker } from "./dist/cu/screenshot.js";
import { ActionPerformer } from "./dist/cu/actions.js";

async function main() {
  console.log("🧪 Starting OpenCodex Core Integration Verification\n");

  // 1. Screenshot Capture Verification
  console.log("📸 [1/4] Verifying Screenshot Capture...");
  try {
    const shot = new ScreenshotTaker();
    const png = await shot.capture();
    console.log(`   ✅ Success! Screenshot size: ${(png.length / 1024).toFixed(1)} KB`);
  } catch (err) {
    console.error(`   ❌ Failed: ${err.message}`);
  }

  // 2. Action clicking (Safe desk location)
  console.log("\n🖱️  [2/4] Verifying Mouse coordinates clicking...");
  try {
    const actor = new ActionPerformer();
    // Clicking a safe space at (150, 150)
    await actor.click(150, 150);
    console.log(`   ✅ Success! click(150, 150) simulated successfully`);
  } catch (err) {
    console.error(`   ❌ Failed: ${err.message}`);
  }

  // 3. Pressing standard OS keyboard shortcuts
  console.log("\n⌨️  [3/4] Verifying keyboard press simulation...");
  try {
    const actor = new ActionPerformer();
    await actor.pressKey("esc");
    console.log(`   ✅ Success! pressKey("esc") simulated successfully`);
  } catch (err) {
    console.error(`   ❌ Failed: ${err.message}`);
  }

  // 4. Proxy Server HTTP bindings
  console.log("\n🌐 [4/4] Verifying Proxy HTTP Server and Dashboard bindings...");
  try {
    const proxy = new ProxyServer();
    // Start on test port 18765 to avoid port clashes
    proxy.start(18765);
    
    // Test health endpoint
    const resHealth = await fetch("http://127.0.0.1:18765/health");
    const healthData = await resHealth.json();
    console.log(`   ✅ Success! Health check responded:`, JSON.stringify(healthData));

    // Test dashboard routing
    const resDash = await fetch("http://127.0.0.1:18765/dashboard");
    if (resDash.ok) {
      console.log(`   ✅ Success! Web Dashboard rendered successfully (HTTP ${resDash.status})`);
    } else {
      throw new Error(`Dashboard route returned status ${resDash.status}`);
    }

    proxy.stop();
  } catch (err) {
    console.error(`   ❌ Failed: ${err.message}`);
  }

  console.log("\n✨ Verification Suite Completed!");
}

main().catch(console.error);
