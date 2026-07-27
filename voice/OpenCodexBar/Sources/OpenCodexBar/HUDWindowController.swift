import AppKit
import WebKit

class HUDWindow: NSWindow {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

class HUDWindowController: NSWindowController, WKNavigationDelegate {
  var webView: WKWebView!
  private var hudSessionId = 0
  private var pendingState: (state: String, amplitude: Float, text: String) = ("idle", 0.0, "")

  private static func getMenuBarHeight() -> CGFloat {
    guard let screen = NSScreen.screens.first else { return 24 }
    let screenFrame = screen.frame
    let visibleFrame = screen.visibleFrame
    let height = (screenFrame.origin.y + screenFrame.height) - (visibleFrame.origin.y + visibleFrame.height)
    // Avoid abnormal values, return 24 for standard non-notch screens
    return (height >= 24 && height <= 60) ? height : 24
  }

  convenience init() {
    let width: CGFloat = 560
    let height = HUDWindowController.getMenuBarHeight()

    let screen = NSScreen.screens.first ?? NSScreen.main
    let screenFrame = screen?.frame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let x = screenFrame.origin.x + (screenFrame.width - width) / 2
    let y = screenFrame.origin.y + screenFrame.height - height

    let contentRect = NSRect(x: x, y: y, width: width, height: height)

    let window = HUDWindow(
      contentRect: contentRect,
      styleMask: [.borderless],
      backing: .buffered,
      defer: false
    )

    window.backgroundColor = .clear
    window.isOpaque = false
    window.hasShadow = false
    window.level = .statusBar
    window.ignoresMouseEvents = true
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]

    self.init(window: window)
    setupWebView(width: width, height: height)
  }

  private func setupWebView(width: CGFloat, height: CGFloat) {
    let config = WKWebViewConfiguration()
    config.preferences.setValue(true, forKey: "developerExtrasEnabled")

    webView = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: config)
    webView.navigationDelegate = self
    webView.setValue(false, forKey: "drawsBackground")
    if #available(macOS 12.0, *) {
      webView.underPageBackgroundColor = .clear
    }
    webView.wantsLayer = true
    webView.layer?.backgroundColor = NSColor.clear.cgColor
    webView.layer?.borderWidth = 0.0
    webView.layer?.borderColor = NSColor.clear.cgColor
    webView.layer?.shadowColor = NSColor.clear.cgColor

    func disableBackgroundDrawing(for view: NSView) {
      if let scrollView = view as? NSScrollView {
        scrollView.drawsBackground = false
        scrollView.backgroundColor = .clear
        scrollView.borderType = .noBorder
      }
      for subview in view.subviews {
        disableBackgroundDrawing(for: subview)
      }
    }
    disableBackgroundDrawing(for: webView)

    window?.contentView = webView
    loadVisualizer()
    startMenuBarMonitoring()
  }

  private var menuBarTimer: Timer?
  private var isCompactMode = false
  private var lastActiveRegularApp: NSRunningApplication?

  func startMenuBarMonitoring() {
    if let frontApp = NSWorkspace.shared.frontmostApplication, frontApp.activationPolicy == .regular {
      lastActiveRegularApp = frontApp
    }
    
    NSWorkspace.shared.notificationCenter.addObserver(
      self,
      selector: #selector(handleAppActivation(_:)),
      name: NSWorkspace.didActivateApplicationNotification,
      object: nil
    )

    menuBarTimer?.invalidate()
    menuBarTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
      self?.checkMenuBarWidth()
    }
  }

  @objc private func handleAppActivation(_ notification: Notification) {
    if let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
      if app.activationPolicy == .regular {
        lastActiveRegularApp = app
      }
    }
  }

  private func checkMenuBarWidth() {
    guard let activeApp = lastActiveRegularApp else { return }
    let appElement = AXUIElementCreateApplication(activeApp.processIdentifier)
    
    var menuBarVal: AnyObject?
    let result = AXUIElementCopyAttributeValue(appElement, kAXMenuBarAttribute as CFString, &menuBarVal)
    
    var maxRightX: CGFloat = 0
    
    if result == .success, let menuBar = menuBarVal {
      var childrenVal: AnyObject?
      let childrenResult = AXUIElementCopyAttributeValue(menuBar as! AXUIElement, kAXChildrenAttribute as CFString, &childrenVal)
      
      if childrenResult == .success, let children = childrenVal as? [AXUIElement] {
        for child in children {
          var positionVal: AnyObject?
          var sizeVal: AnyObject?
          
          AXUIElementCopyAttributeValue(child, kAXPositionAttribute as CFString, &positionVal)
          AXUIElementCopyAttributeValue(child, kAXSizeAttribute as CFString, &sizeVal)
          
          if let posRef = positionVal, let sizeRef = sizeVal {
            var position = CGPoint.zero
            var size = CGSize.zero
            AXValueGetValue(posRef as! AXValue, .cgPoint, &position)
            AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)
            
            let rightX = position.x + size.width
            if rightX > maxRightX {
              maxRightX = rightX
            }
          }
        }
      }
    }
    
    guard let window = self.window else { return }
    // Normal extended left wing X coordinate is around window.x + 110.
    let hudLeftBoundary = window.frame.origin.x + 180 - 70
    
    // If the menu bar extends past (hudLeftBoundary - 15), trigger compact mode.
    let shouldBeCompact = maxRightX > (hudLeftBoundary - 15)
    
    AppDelegate.shared?.log("[AX Debug] maxRightX=\(maxRightX), hudLeftBoundary=\(hudLeftBoundary), shouldBeCompact=\(shouldBeCompact), isCompactMode=\(isCompactMode)")
    
    if shouldBeCompact != isCompactMode {
      isCompactMode = shouldBeCompact
      updateCompactMode(isCompact: isCompactMode)
    }
  }

  private func updateCompactMode(isCompact: Bool) {
    let js = """
    (function() {
      if (window.updateCompactMode) {
        window.updateCompactMode(\(isCompact));
        return "compactMode updated: " + \(isCompact);
      }
      return "window.updateCompactMode not found";
    })()
    """
    let strongSelf = self
    DispatchQueue.main.async {
      strongSelf.webView.evaluateJavaScript(js) { (result, error) in
        if let err = error {
          AppDelegate.shared?.log("[AX JS Err] \(err.localizedDescription)")
        } else if let res = result as? String {
          AppDelegate.shared?.log("[AX JS Result] \(res)")
          if res == "window.updateCompactMode not found" {
            strongSelf.isCompactMode = false
          }
        }
      }
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    AppDelegate.shared?.log("[AX] WebView didFinish. Re-syncing isCompactMode: \(isCompactMode)")
    updateCompactMode(isCompact: isCompactMode)
    let state = pendingState
    updateState(state: state.state, amplitude: state.amplitude, text: state.text)
  }

  func loadVisualizer() {
    let t = Int(Date().timeIntervalSince1970)
    let h = Int(HUDWindowController.getMenuBarHeight())
    var components = URLComponents(url: GatewayLocator.url(path: "visualizer"), resolvingAgainstBaseURL: false)
    components?.queryItems = [
      URLQueryItem(name: "mode", value: "hud"),
      URLQueryItem(name: "t", value: String(t)),
      URLQueryItem(name: "h", value: String(h))
    ]
    guard let url = components?.url else { return }
    
    var request = URLRequest(url: url)
    request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    webView.load(request)
  }

  func showHUD() {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { [weak self] in self?.showHUD() }
      return
    }
    guard let window = self.window else { return }
    hudSessionId += 1

    let screen = NSScreen.screens.first ?? NSScreen.main
    let screenFrame = screen?.frame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let height = window.frame.height
    
    let finalFrame = NSRect(
      x: screenFrame.origin.x + (screenFrame.width - window.frame.width) / 2,
      y: screenFrame.origin.y + screenFrame.height - height,
      width: window.frame.width,
      height: height
    )
    
    window.setFrame(finalFrame, display: true)
    window.alphaValue = 1.0
    window.invalidateShadow()
    window.orderFrontRegardless()
    let state = pendingState
    updateState(state: state.state, amplitude: state.amplitude, text: state.text)
  }

  func hideHUD(force: Bool = false, completion: (() -> Void)? = nil) {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { [weak self] in self?.hideHUD(force: force, completion: completion) }
      return
    }
    updateState(state: "idle", amplitude: 0.0, text: "")
    
    if !force {
      completion?()
      return
    }
    
    guard let window = self.window, window.isVisible else {
      completion?()
      return
    }
    hudSessionId += 1
    let currentSession = hudSessionId

    NSAnimationContext.runAnimationGroup({ context in
      context.duration = 0.18
      context.timingFunction = CAMediaTimingFunction(name: .easeIn)
      window.animator().alphaValue = 0.0
    }) { [weak self] in
      guard let self = self, self.hudSessionId == currentSession else { return }
      window.orderOut(nil)
      completion?()
    }
  }

  func updateState(state: String, amplitude: Float, text: String = "") {
    pendingState = (state, amplitude, text)
    let safeState: String
    if let data = try? JSONEncoder().encode(state), let encoded = String(data: data, encoding: .utf8) {
      safeState = encoded
    } else {
      safeState = "\"idle\""
    }
    let safeText: String
    if let data = try? JSONEncoder().encode(text), let encoded = String(data: data, encoding: .utf8) {
      safeText = encoded
    } else {
      safeText = "\"\""
    }
    let safeAmplitude = max(0, min(1, amplitude))
    let js = "if (window.updateVoiceState) { window.updateVoiceState(\(safeState), \(safeAmplitude), \(safeText)); }"
    DispatchQueue.main.async {
      guard self.webView != nil else { return }
      self.webView.evaluateJavaScript(js) { _, error in
        if let error = error {
          AppDelegate.shared?.log("[HUD JS] \(error.localizedDescription)")
        }
      }
    }
  }
}
