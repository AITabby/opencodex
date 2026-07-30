import AppKit

private struct LiveModelPickerPending: Decodable {
  let pending: Bool
  let request_id: String?
  let models: [String]?
  let enabled: Bool?
}

/// Owns the optional Live model-picker orb. This UI deliberately lives in the
/// voice-bar process so it remains available whether the gateway was started
/// by the native macOS app or by the 8765 fallback process.
final class LiveModelPickerController: NSObject, NSWindowDelegate {
  private static let enabledKey = "OpenCodexBar.liveModelPickerEnabled"

  private(set) var isEnabled: Bool
  private var pollTimer: Timer?
  private var pollInFlight = false
  private var orbWindow: NSPanel?
  private var orbButton: NSButton?
  private var pickerWindow: NSPanel?
  private var modelPopup: NSPopUpButton?
  private var errorLabel: NSTextField?
  private var selectButton: NSButton?
  private var requestID: String?
  private var currentModels: [String] = []
  private var isResolving = false
  var onEnabledChanged: ((Bool) -> Void)?

  override init() {
    if let stored = UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool {
      isEnabled = stored
    } else {
      isEnabled = false
    }
    super.init()
  }

  func start() {
    if isEnabled { showOrb() }
    startPolling()
  }

  func toggle() {
    setEnabled(!isEnabled)
  }

  func setEnabled(_ enabled: Bool) {
    isEnabled = enabled
    UserDefaults.standard.set(enabled, forKey: Self.enabledKey)

    if enabled {
      showOrb()
      startPolling()
    } else {
      pollTimer?.invalidate()
      pollTimer = nil
      requestID = nil
      currentModels = []
      isResolving = false
      pickerWindow?.orderOut(nil)
      orbWindow?.orderOut(nil)
    }
    persistRemoteEnabled(enabled)
    onEnabledChanged?(enabled)
  }

  private func showOrb() {
    if let orbWindow {
      orbWindow.orderFrontRegardless()
      return
    }

    let size = CGFloat(56)
    let screen = NSScreen.main ?? NSScreen.screens.first
    let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let frame = NSRect(
      x: visible.maxX - size - 28,
      y: visible.minY + 72,
      width: size,
      height: size
    )
    let panel = NSPanel(
      contentRect: frame,
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.level = .floating
    panel.hidesOnDeactivate = false
    panel.isMovableByWindowBackground = true
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]

    let button = NSButton(frame: NSRect(origin: .zero, size: NSSize(width: size, height: size)))
    button.isBordered = false
    button.bezelStyle = .regularSquare
    button.image = NSImage(systemSymbolName: "waveform.and.mic", accessibilityDescription: "GPT-Live 模型选择")
    button.imagePosition = .imageOnly
    button.contentTintColor = .white
    button.toolTip = "GPT-Live 模型选择"
    button.target = self
    button.action = #selector(orbClicked)
    button.wantsLayer = true
    button.layer?.cornerRadius = size / 2
    button.layer?.backgroundColor = NSColor.systemCyan.withAlphaComponent(0.92).cgColor
    button.layer?.borderWidth = 1
    button.layer?.borderColor = NSColor.white.withAlphaComponent(0.55).cgColor

    panel.contentView = button
    orbWindow = panel
    orbButton = button
    panel.orderFrontRegardless()
  }

  private func startPolling() {
    pollTimer?.invalidate()
    pollTimer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { [weak self] _ in
      self?.pollGateway()
    }
    pollGateway()
  }

  @objc private func pollGateway() {
    guard !pollInFlight,
          let token = GatewayLocator.adminToken(), !token.isEmpty else { return }

    pollInFlight = true
    var request = URLRequest(url: GatewayLocator.url(path: "api/live-model-picker/pending"))
    request.timeoutInterval = 2
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

    URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
      guard let self else { return }
      DispatchQueue.main.async {
        self.pollInFlight = false
        guard let data,
              let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200,
              let payload = try? JSONDecoder().decode(LiveModelPickerPending.self, from: data) else { return }
        self.apply(payload)
      }
    }.resume()
  }

  private func apply(_ payload: LiveModelPickerPending) {
    if let remoteEnabled = payload.enabled, remoteEnabled != isEnabled {
      isEnabled = remoteEnabled
      UserDefaults.standard.set(remoteEnabled, forKey: Self.enabledKey)
      if remoteEnabled {
        showOrb()
      } else {
        requestID = nil
        currentModels = []
        pickerWindow?.orderOut(nil)
        orbWindow?.orderOut(nil)
      }
      onEnabledChanged?(remoteEnabled)
    }

    guard isEnabled else {
      requestID = nil
      currentModels = []
      return
    }

    guard isEnabled,
          payload.pending,
          let id = payload.request_id,
          let models = payload.models,
          !models.isEmpty else {
      if requestID != nil && !isResolving {
        requestID = nil
        currentModels = []
        pickerWindow?.orderOut(nil)
        setOrbPending(false)
      }
      return
    }

    let isNewRequest = requestID != id
    requestID = id
    currentModels = models
    updateModelMenu()
    setOrbPending(true)
    if isNewRequest {
      showPickerWindow()
    }
  }

  private func persistRemoteEnabled(_ enabled: Bool) {
    guard let token = GatewayLocator.adminToken(), !token.isEmpty else { return }
    var request = URLRequest(url: GatewayLocator.url(path: "api/live-model-picker/settings"))
    request.httpMethod = "POST"
    request.timeoutInterval = 5
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["enabled": enabled])
    URLSession.shared.dataTask(with: request).resume()
  }

  @objc private func orbClicked() {
    if requestID != nil {
      showPickerWindow()
    }
  }

  private func showPickerWindow() {
    let panel = pickerWindow ?? makePickerWindow()
    updateModelMenu()
    errorLabel?.stringValue = ""
    panel.orderFrontRegardless()
    panel.makeKey()
  }

  private func makePickerWindow() -> NSPanel {
    let panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 430, height: 230),
      styleMask: [.titled, .closable, .utilityWindow],
      backing: .buffered,
      defer: false
    )
    panel.title = "GPT-Live 选择执行模型"
    panel.isFloatingPanel = true
    panel.level = .floating
    panel.hidesOnDeactivate = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.delegate = self

    let title = NSTextField(labelWithString: "选择 GPT-Live 执行模型")
    title.font = NSFont.systemFont(ofSize: 19, weight: .semibold)

    let detail = NSTextField(labelWithString: "Live 已准备把任务交给 Codex。请选择本次真正执行的模型。")
    detail.font = NSFont.systemFont(ofSize: 12)
    detail.textColor = .secondaryLabelColor
    detail.lineBreakMode = .byWordWrapping
    detail.maximumNumberOfLines = 0

    let popup = NSPopUpButton(frame: .zero, pullsDown: false)
    popup.translatesAutoresizingMaskIntoConstraints = false
    popup.controlSize = .large
    modelPopup = popup

    let error = NSTextField(labelWithString: "")
    error.font = NSFont.systemFont(ofSize: 12)
    error.textColor = .systemRed
    error.lineBreakMode = .byWordWrapping
    error.maximumNumberOfLines = 2
    errorLabel = error

    let cancel = NSButton(title: "取消，使用桌面当前模型", target: self, action: #selector(cancelSelection))
    cancel.bezelStyle = .rounded
    let select = NSButton(title: "使用此模型", target: self, action: #selector(selectModel))
    select.bezelStyle = .rounded
    select.keyEquivalent = "\r"
    selectButton = select

    let buttons = NSStackView(views: [cancel, NSView(), select])
    buttons.orientation = .horizontal
    buttons.spacing = 10
    buttons.setHuggingPriority(.defaultLow, for: .horizontal)

    let stack = NSStackView(views: [title, detail, popup, error, buttons])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 12
    stack.edgeInsets = NSEdgeInsets(top: 20, left: 22, bottom: 20, right: 22)
    stack.translatesAutoresizingMaskIntoConstraints = false
    panel.contentView = stack
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: panel.contentView!.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: panel.contentView!.trailingAnchor),
      stack.topAnchor.constraint(equalTo: panel.contentView!.topAnchor),
      stack.bottomAnchor.constraint(equalTo: panel.contentView!.bottomAnchor),
      popup.widthAnchor.constraint(equalToConstant: 386),
      buttons.widthAnchor.constraint(equalToConstant: 386),
    ])

    pickerWindow = panel
    return panel
  }

  private func updateModelMenu() {
    guard let popup = modelPopup else { return }
    popup.removeAllItems()
    popup.addItems(withTitles: currentModels)
    selectButton?.isEnabled = !currentModels.isEmpty
  }

  private func setOrbPending(_ pending: Bool) {
    orbButton?.layer?.backgroundColor = (pending ? NSColor.systemOrange : NSColor.systemCyan)
      .withAlphaComponent(0.92).cgColor
    orbButton?.toolTip = pending ? "GPT-Live 正在等待模型选择" : "GPT-Live 模型选择"
  }

  @objc private func selectModel() {
    guard let requestID, let model = modelPopup?.titleOfSelectedItem, !model.isEmpty else { return }
    resolve(requestID: requestID, model: model)
  }

  @objc private func cancelSelection() {
    guard let requestID else { return }
    resolve(requestID: requestID, model: "")
  }

  private func resolve(requestID: String, model: String) {
    guard let token = GatewayLocator.adminToken(), !token.isEmpty else {
      errorLabel?.stringValue = "找不到网关授权，请确认网关仍在运行。"
      return
    }

    isResolving = true
    selectButton?.isEnabled = false
    var request = URLRequest(url: GatewayLocator.url(path: "api/live-model-picker/resolve"))
    request.httpMethod = "POST"
    request.timeoutInterval = 10
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: [
      "request_id": requestID,
      "model": model,
    ])

    URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
      DispatchQueue.main.async {
        guard let self else { return }
        self.isResolving = false
        self.selectButton?.isEnabled = !self.currentModels.isEmpty
        guard let httpResponse = response as? HTTPURLResponse,
              (200..<300).contains(httpResponse.statusCode) else {
          self.errorLabel?.stringValue = String(data: data ?? Data(), encoding: .utf8) ?? "模型选择请求已过期。"
          return
        }
        self.requestID = nil
        self.currentModels = []
        self.pickerWindow?.orderOut(nil)
        self.setOrbPending(false)
      }
    }.resume()
  }

  func windowWillClose(_ notification: Notification) {
    guard let requestID, !isResolving,
          (notification.object as? NSWindow) === pickerWindow else { return }
    resolve(requestID: requestID, model: "")
  }
}
