import AppKit

enum AppStatus {
  case idle     // ● green
  case loading  // ◐ spinning
  case listening // 🎙️ animating
  case sending  // ⟳ pulsing
  case error    // ⚠️ red
  case offline  // ○ gray
}

class StatusBarController {
  private let statusItem: NSStatusItem
  private let popover: NSPopover
  private let apiClient: APIClient
  private let liveModelPickerController: LiveModelPickerController
  private var liveModelPickerItem: NSMenuItem!
  private(set) var currentStatus: AppStatus = .idle
  private var animationTimer: Timer?
  private var frameIndex = 0

  init(apiClient: APIClient, liveModelPickerController: LiveModelPickerController) {
    self.apiClient = apiClient
    self.liveModelPickerController = liveModelPickerController
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    popover = NSPopover()

    if let button = statusItem.button {
      button.image = NSImage(systemSymbolName: "circle.dashed", accessibilityDescription: "OpenCodex")
      button.action = #selector(togglePopover)
      button.target = self
    }

    updateIcon()
    try? "idle".write(toFile: "/tmp/ocb_status.txt", atomically: true, encoding: .utf8)
    buildMenu()
  }

  func setStatus(_ status: AppStatus) {
    currentStatus = status
    updateIcon()

    let statusStr: String
    switch status {
    case .idle: statusStr = "idle"
    case .loading: statusStr = "loading"
    case .listening: statusStr = "listening"
    case .sending: statusStr = "sending"
    case .error: statusStr = "error"
    case .offline: statusStr = "offline"
    }
    try? statusStr.write(toFile: "/tmp/ocb_status.txt", atomically: true, encoding: .utf8)

    if status == .loading || status == .listening || status == .sending {
      startAnimation()
    } else {
      stopAnimation()
    }
  }

  private func updateIcon() {
    guard let button = statusItem.button else { return }
    let color: NSColor

    switch currentStatus {
    case .idle:
      color = .systemGreen
    case .loading, .sending:
      color = .systemBlue
    case .listening:
      color = .systemRed
    case .error:
      color = .systemYellow
    case .offline:
      color = .systemGray
    }

    let size = NSSize(width: 18, height: 18)
    let img = NSImage(size: size)
    img.lockFocus()
    
    let dotSize: CGFloat = 8
    let rect = NSRect(
      x: (size.width - dotSize) / 2,
      y: (size.height - dotSize) / 2,
      width: dotSize,
      height: dotSize
    )
    
    color.set()
    let path = NSBezierPath(ovalIn: rect)
    path.fill()
    
    img.unlockFocus()
    button.image = img
  }

  private func startAnimation() {
    animationTimer?.invalidate()
    animationTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
      self?.frameIndex += 1
      // Pulse the alpha for visual feedback
      let alpha: CGFloat = (self?.frameIndex ?? 0) % 2 == 0 ? 0.4 : 1.0
      self?.statusItem.button?.alphaValue = alpha
    }
  }

  private func stopAnimation() {
    animationTimer?.invalidate()
    animationTimer = nil
    statusItem.button?.alphaValue = 1.0
    frameIndex = 0
  }

  private func buildMenu() {
    let menu = NSMenu()
    menu.autoenablesItems = false

    let titleItem = NSMenuItem(title: "OpenCodex", action: nil, keyEquivalent: "")
    titleItem.isEnabled = false
    menu.addItem(titleItem)

    menu.addItem(NSMenuItem.separator())

    let dashItem = NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "d")
    dashItem.target = self
    menu.addItem(dashItem)

    let newChatItem = NSMenuItem(title: "New Conversation (⌥N)", action: #selector(startNewConversation), keyEquivalent: "n")
    newChatItem.keyEquivalentModifierMask = [.option]
    newChatItem.target = self
    menu.addItem(newChatItem)

    let voiceItem = NSMenuItem(title: "Toggle Voice (⌥Space)", action: #selector(toggleVoice), keyEquivalent: " ")
    voiceItem.keyEquivalentModifierMask = [.option]
    voiceItem.target = self
    menu.addItem(voiceItem)

    menu.addItem(NSMenuItem.separator())

    liveModelPickerItem = NSMenuItem(
      title: "GPT-Live 模型选择悬浮球",
      action: #selector(toggleLiveModelPicker),
      keyEquivalent: ""
    )
    liveModelPickerItem.target = self
    menu.addItem(liveModelPickerItem)
    updateLiveModelPickerMenuItem()

    menu.addItem(NSMenuItem.separator())

    let restartItem = NSMenuItem(title: "Restart Codex", action: #selector(restartCodex), keyEquivalent: "r")
    restartItem.target = self
    menu.addItem(restartItem)

    let quitItem = NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q")
    quitItem.target = self
    menu.addItem(quitItem)

    statusItem.menu = menu
  }

  @objc private func openDashboard() {
    NSWorkspace.shared.open(GatewayLocator.url(path: "dashboard"))
  }

  @objc private func toggleVoice() {
    AppDelegate.shared?.toggleVoiceInput()
  }

  @objc private func toggleLiveModelPicker() {
    liveModelPickerController.toggle()
    updateLiveModelPickerMenuItem()
  }

  private func updateLiveModelPickerMenuItem() {
    guard liveModelPickerItem != nil else { return }
    liveModelPickerItem.state = liveModelPickerController.isEnabled ? .on : .off
    liveModelPickerItem.title = liveModelPickerController.isEnabled
      ? "关闭 GPT-Live 模型选择悬浮球"
      : "开启 GPT-Live 模型选择悬浮球"
  }

  @objc private func startNewConversation() {
    AppDelegate.shared?.startNewConversation()
  }

  @objc private func restartCodex() {
    apiClient.restartCodex()
  }

  @objc private func quit() {
    NSApplication.shared.terminate(nil)
  }

  @objc private func togglePopover() {
    // Menu mode: click shows menu automatically
  }
}
