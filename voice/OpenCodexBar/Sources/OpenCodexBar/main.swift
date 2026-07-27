// OpenCodex Bar — macOS Menu Bar Companion
// Runs in menu bar, shows OpenCodex status, supports voice input.
//
// Build:
//   cd opencodex-bar && swift build -c release
//   .build/release/OpenCodexBar

import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // Menu bar only, no dock icon
app.run()
