import AppKit
import CoreImage
import SwiftUI

private struct LivePickerRequest: Equatable {
    let id: String
    let models: [String]
}

private struct PendingResponse: Decodable {
    let pending: Bool
    let enabled: Bool?
    let request_id: String?
    let models: [String]?
    let selected_model: String?
}

@MainActor
private final class LivePickerAgent: ObservableObject {
    @Published private(set) var enabled = false
    @Published private(set) var request: LivePickerRequest?
    @Published private(set) var selectedModel = ""
    @Published private(set) var availableModels: [String] = []
    var onChange: (() -> Void)?

    private var pollTask: Task<Void, Never>?
    private let port = 8765
    private let token: String

    init() {
        let tokenPath = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".opencodex/admin_token")
        token = (try? String(contentsOf: tokenPath, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                await self?.poll()
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    func resolve(_ model: String) async {
        guard let request else { return }
        guard (try? await send(requestID: request.id, model: model)) == true else { return }
        selectedModel = model
        self.request = nil
        onChange?()
    }

    func select(_ model: String) async {
        if request != nil {
            await resolve(model)
            return
        }
        guard (try? await sendSelection(model: model)) == true else { return }
        selectedModel = model
        onChange?()
    }

    private func poll() async {
        guard !token.isEmpty,
              let url = URL(string: "http://127.0.0.1:\(port)/api/live-model-picker/pending") else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else { return }
            let payload = try JSONDecoder().decode(PendingResponse.self, from: data)
            let nextEnabled = payload.enabled == true
            if enabled != nextEnabled {
                enabled = nextEnabled
                if !nextEnabled {
                    selectedModel = ""
                    self.request = nil
                    availableModels = []
                }
                onChange?()
            }
            guard enabled else { return }
            availableModels = payload.models ?? []
            if payload.pending == false, let selected = payload.selected_model, selectedModel != selected {
                selectedModel = selected
            }
            if !payload.pending {
                if self.request != nil {
                    self.request = nil
                    onChange?()
                }
                return
            }
            guard let id = payload.request_id,
                  let models = payload.models,
                  !models.isEmpty else { return }
            let next = LivePickerRequest(id: id, models: models)
            if self.request?.id != next.id {
                self.request = next
                onChange?()
            }
        } catch {
            // The gateway remains authoritative; transient polling failures are harmless.
        }
    }

    private func send(requestID: String, model: String) async throws -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/live-model-picker/resolve") else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "request_id": requestID,
            "model": model,
        ])
        let (_, response) = try await URLSession.shared.data(for: request)
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    private func sendSelection(model: String) async throws -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/live-model-picker/select") else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["model": model])
        let (_, response) = try await URLSession.shared.data(for: request)
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    private func sendSettings(enabled: Bool) async throws -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/live-model-picker/settings") else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["enabled": enabled])
        let (_, response) = try await URLSession.shared.data(for: request)
        return (response as? HTTPURLResponse)?.statusCode == 200
    }
}

private final class LivePickerPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

private final class LiveCardHostingView: NSHostingView<LiveCardView> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor
private final class LiveOrbAnimationView: NSView {
    let onOpen: () -> Void
    let onDragStart: () -> Void
    let onDrag: (CGSize) -> Void
    let onDragEnd: () -> Void
    private var mouseStart = NSPoint.zero
    private var moved = false
    private var animationTimer: Timer?
    private var animationPhase: CGFloat = 0
    private let blurContext = CIContext(options: nil)
    private let noiseGenerator = CIFilter(name: "CIRandomGenerator")!

    init(onOpen: @escaping () -> Void, onDragStart: @escaping () -> Void, onDrag: @escaping (CGSize) -> Void, onDragEnd: @escaping () -> Void) {
        self.onOpen = onOpen
        self.onDragStart = onDragStart
        self.onDrag = onDrag
        self.onDragEnd = onDragEnd
        super.init(frame: NSRect(x: 0, y: 0, width: 66, height: 66))
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        animationTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                animationPhase += 0.018
                needsDisplay = true
            }
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func draw(_ dirtyRect: NSRect) {
        let phase = animationPhase
        let sphereRect = bounds.insetBy(dx: 0.5, dy: 0.5)
        let sphere = NSBezierPath(ovalIn: sphereRect)

        let textureWidth = 112
        let textureHeight = 112
        let time = Double(phase)
        var pixels = [UInt8](repeating: 0, count: textureWidth * textureHeight * 4)

        func clamp(_ value: Double) -> Double { min(1, max(0, value)) }
        func cloudWeight(_ u: Double, _ v: Double, _ seed: Double, _ speed: Double) -> Double {
            let warpedU = u + 0.13 * sin(v * 7.2 + time * speed + seed)
                + 0.06 * cos(u * 4.4 - time * speed * 0.7 + seed * 1.7)
            let warpedV = v + 0.14 * cos(u * 6.1 - time * speed * 0.9 + seed)
                + 0.05 * sin(v * 5.3 + time * speed * 0.6 + seed * 1.2)
            let wave = 0.54 * sin(warpedU * 8.0 + warpedV * 2.1 + time * speed)
                + 0.31 * sin(warpedV * 9.2 - warpedU * 3.4 - time * speed * 0.72 + seed)
                + 0.21 * sin((warpedU + warpedV) * 7.1 + time * speed * 0.48 + seed * 2.3)
            return pow(clamp((wave + 0.30) * 1.2), 2.2)
        }

        for y in 0..<textureHeight {
            for x in 0..<textureWidth {
                let u = Double(x) / Double(textureWidth - 1)
                let v = Double(y) / Double(textureHeight - 1)
                let cyan = cloudWeight(u, v, 0.4, 1.00)
                let pink = cloudWeight(u, v, 2.1, 0.83)
                let blue = cloudWeight(u, v, 4.3, 1.17)
                let violet = cloudWeight(u, v, 6.4, 0.69)
                let total = cyan + pink + blue + violet
                let alpha = clamp(0.16 + total * 0.19)
                let red = (pink * 1.0 + blue * 0.16 + violet * 0.52) / max(total, 0.001)
                let green = (cyan * 0.95 + blue * 0.42 + violet * 0.30 + pink * 0.12) / max(total, 0.001)
                let blueChannel = (cyan * 0.90 + pink * 0.72 + blue * 1.0 + violet * 1.0) / max(total, 0.001)
                let index = (y * textureWidth + x) * 4
                pixels[index] = UInt8(clamp(red * alpha) * 255)
                pixels[index + 1] = UInt8(clamp(green * alpha) * 255)
                pixels[index + 2] = UInt8(clamp(blueChannel * alpha) * 255)
                pixels[index + 3] = UInt8(alpha * 255)
            }
        }

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
        if let provider = CGDataProvider(data: Data(pixels) as CFData),
           let texture = CGImage(
               width: textureWidth,
               height: textureHeight,
               bitsPerComponent: 8,
               bitsPerPixel: 32,
               bytesPerRow: textureWidth * 4,
               space: colorSpace,
               bitmapInfo: bitmapInfo,
               provider: provider,
               decode: nil,
               shouldInterpolate: true,
               intent: .defaultIntent
           ) {
            NSGraphicsContext.saveGraphicsState()
            sphere.addClip()
            NSImage(cgImage: texture, size: bounds.size).draw(in: bounds)
            NSGraphicsContext.restoreGraphicsState()
        }

    }

    override func mouseDown(with event: NSEvent) {
        mouseStart = NSEvent.mouseLocation
        moved = false
        onDragStart()
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDragged(with event: NSEvent) {
        let point = NSEvent.mouseLocation
        let delta = CGSize(width: point.x - mouseStart.x, height: point.y - mouseStart.y)
        moved = moved || abs(delta.width) + abs(delta.height) > 3
        if moved { onDrag(delta) }
    }

    override func mouseUp(with event: NSEvent) {
        if !moved { onOpen() }
        onDragEnd()
        moved = false
    }
}

@MainActor
private final class LiveOrbHaloView: NSView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func draw(_ dirtyRect: NSRect) {
        let sphereRect = bounds.insetBy(dx: 0.5, dy: 0.5)
        let sphere = NSBezierPath(ovalIn: sphereRect)

        NSGraphicsContext.saveGraphicsState()
        sphere.addClip()

        func drawGlassColor(center: NSPoint, width: CGFloat, height: CGFloat, color: NSColor, seed: CGFloat) {
            let colorRect = NSRect(
                x: center.x - width / 2,
                y: center.y - height / 2,
                width: width,
                height: height
            )
            NSGradient(colors: [
                color.withAlphaComponent(0.38),
                color.withAlphaComponent(0.14),
                NSColor.clear,
            ])?.draw(in: NSBezierPath(ovalIn: colorRect), relativeCenterPosition: NSPoint(x: sin(seed) * 0.25, y: cos(seed) * 0.25))
        }

        // A stable full-sphere chromatic haze. Every field fades to transparent
        // before its own edge, so this layer has no visible inner boundary.
        drawGlassColor(
            center: NSPoint(x: bounds.midX - 13, y: bounds.midY + 11),
            width: 64,
            height: 56,
            color: NSColor(calibratedRed: 0.0, green: 0.86, blue: 0.92, alpha: 1),
            seed: 0.6
        )
        drawGlassColor(
            center: NSPoint(x: bounds.midX + 15, y: bounds.midY + 8),
            width: 62,
            height: 58,
            color: NSColor(calibratedRed: 0.94, green: 0.18, blue: 0.78, alpha: 1),
            seed: 2.8
        )
        drawGlassColor(
            center: NSPoint(x: bounds.midX + 2, y: bounds.midY - 15),
            width: 68,
            height: 50,
            color: NSColor(calibratedRed: 0.18, green: 0.40, blue: 1.0, alpha: 1),
            seed: 4.9
        )
        drawGlassColor(
            center: NSPoint(x: bounds.midX - 3, y: bounds.midY + 1),
            width: 56,
            height: 66,
            color: NSColor(calibratedRed: 0.50, green: 0.22, blue: 1.0, alpha: 1),
            seed: 6.5
        )

        NSGraphicsContext.restoreGraphicsState()
    }
}

@MainActor
private final class LiveOrbView: NSView {
    init(onOpen: @escaping () -> Void, onDragStart: @escaping () -> Void, onDrag: @escaping (CGSize) -> Void, onDragEnd: @escaping () -> Void) {
        super.init(frame: NSRect(x: 0, y: 0, width: 66, height: 66))
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor

        let glassView = NSVisualEffectView(frame: bounds)
        glassView.autoresizingMask = [.width, .height]
        glassView.material = .hudWindow
        glassView.blendingMode = .behindWindow
        glassView.state = .active
        glassView.isEmphasized = true
        glassView.wantsLayer = true
        glassView.layer?.cornerRadius = 33
        glassView.layer?.masksToBounds = true
        addSubview(glassView)

        let animationView = LiveOrbAnimationView(
            onOpen: onOpen,
            onDragStart: onDragStart,
            onDrag: onDrag,
            onDragEnd: onDragEnd
        )
        animationView.frame = bounds
        animationView.autoresizingMask = [.width, .height]
        addSubview(animationView)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

private struct LiveCardView: View {
    @ObservedObject var agent: LivePickerAgent
    let onResolve: (String) -> Void
    @State private var selectedModel = ""

    var body: some View {
        let models = agent.request?.models ?? agent.availableModels
        VStack(alignment: .leading, spacing: 10) {
            Text("选择 GPT-Live 执行模型")
                .font(.system(size: 17, weight: .semibold))
            Text("Live 已准备把任务交给 Codex，请选择真正执行的模型。")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            if !models.isEmpty {
                ScrollView {
                    LazyVStack(spacing: 7) {
                        ForEach(models, id: \.self) { model in
                            HStack(spacing: 8) {
                                Text(model)
                                    .foregroundStyle(.white)
                                Spacer()
                                if selectedModel == model {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(.white)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 11)
                            .padding(.vertical, 9)
                            .contentShape(RoundedRectangle(cornerRadius: 8))
                            .onTapGesture {
                                selectedModel = model
                                onResolve(model)
                            }
                            .background(
                                RoundedRectangle(cornerRadius: 8)
                                    .fill(selectedModel == model ? Color.accentColor.opacity(0.75) : Color.white.opacity(0.09))
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 8)
                                    .stroke(selectedModel == model ? Color.white.opacity(0.9) : Color.white.opacity(0.16), lineWidth: selectedModel == model ? 1.5 : 1)
                            )
                        }
                    }
                }
                .frame(maxHeight: 210)
                if !selectedModel.isEmpty {
                    Text("当前选中模型：\(selectedModel)")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            } else {
                VStack(alignment: .leading, spacing: 5) {
                    if !agent.selectedModel.isEmpty {
                        Text("当前执行模型：\(agent.selectedModel)")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Text(agent.request == nil ? "可在 Live 开始前提前选择模型…" : "已开启，等待 Live 准备下一个任务…")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(18)
        .frame(width: 360, height: 300)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(.white.opacity(0.22)))
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .onAppear {
            selectedModel = agent.selectedModel
        }
        .onChange(of: agent.request?.id) { _ in
            selectedModel = agent.selectedModel
        }
        .onChange(of: agent.selectedModel) { model in
            selectedModel = model
        }
    }
}

@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate {
    let agent = LivePickerAgent()
    private var orbPanel: LivePickerPanel!
    private var cardPanel: LivePickerPanel!
    private var orbOrigin = CGPoint.zero
    private var dragOrigin = CGPoint.zero
    private var cardManuallyShown = false
    private var globalMouseMonitor: Any?
    private var localMouseMonitor: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        createPanels()
        installDismissMonitors()
        agent.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        agent.stop()
        if let globalMouseMonitor { NSEvent.removeMonitor(globalMouseMonitor) }
        if let localMouseMonitor { NSEvent.removeMonitor(localMouseMonitor) }
    }

    private func createPanels() {
        orbPanel = makePanel(size: NSSize(width: 66, height: 66))
        cardPanel = makePanel(size: NSSize(width: 380, height: 320))
        orbPanel.contentView = LiveOrbView(
            onOpen: { [weak self] in self?.toggleCard() },
            onDragStart: { [weak self] in self?.beginDrag() },
            onDrag: { [weak self] translation in self?.drag(translation) },
            onDragEnd: { [weak self] in self?.endDrag() }
        )
        orbPanel.contentView?.wantsLayer = true
        orbPanel.contentView?.layer?.backgroundColor = NSColor.clear.cgColor
        let cardHostingView = LiveCardHostingView(rootView: LiveCardView(
            agent: agent,
            onResolve: { [weak self] model in
                Task { await self?.agent.select(model) }
            }
        ))
        // Keep the hosting view transparent; the SwiftUI card owns the
        // rounded material background, so the panel corners stay transparent.
        cardHostingView.wantsLayer = true
        cardHostingView.layer?.backgroundColor = NSColor.clear.cgColor
        cardHostingView.layer?.isOpaque = false
        cardHostingView.layer?.cornerRadius = 18
        cardHostingView.layer?.masksToBounds = true
        cardPanel.contentView = cardHostingView
        positionOrb(initial: true)
        orbPanel.orderFrontRegardless()
        cardPanel.orderOut(nil)
        agent.onChange = { [weak self] in self?.refreshPanels() }
    }

    private func makePanel(size: NSSize) -> LivePickerPanel {
        let panel = LivePickerPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        return panel
    }

    private func refreshPanels() {
        guard agent.enabled else {
            orbPanel.orderOut(nil)
            cardPanel.orderOut(nil)
            return
        }
        orbPanel.orderFrontRegardless()
        if agent.request == nil && !cardManuallyShown {
            cardPanel.orderOut(nil)
        } else {
            positionCard()
            cardPanel.orderFrontRegardless()
        }
    }

    private func showCard() {
        guard agent.enabled else { return }
        cardManuallyShown = true
        positionCard()
        cardPanel.makeKeyAndOrderFront(nil)
    }

    private func toggleCard() {
        if cardPanel.isVisible {
            closeCard()
        } else {
            showCard()
        }
    }

    private func closeCard() {
        cardManuallyShown = false
        cardPanel.orderOut(nil)
    }

    private func installDismissMonitors() {
        let dismissIfOutside: (NSEvent) -> Void = { [weak self] event in
            guard let self, self.cardPanel.isVisible else { return }
            let point = NSEvent.mouseLocation
            if !self.cardPanel.frame.contains(point) && !self.orbPanel.frame.contains(point) {
                self.closeCard()
            }
        }
        globalMouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown]) { event in
            Task { @MainActor in dismissIfOutside(event) }
        }
        localMouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown]) { event in
            dismissIfOutside(event)
            return event
        }
    }

    private func positionOrb(initial: Bool) {
        let screen = NSScreen.main?.visibleFrame ?? NSScreen.screens[0].visibleFrame
        let origin = CGPoint(x: screen.maxX - 90, y: screen.minY + 28)
        if initial { orbOrigin = origin }
        orbPanel.setFrameOrigin(orbOrigin)
    }

    private func positionCard() {
        let screen = NSScreen.main?.visibleFrame ?? NSScreen.screens[0].visibleFrame
        let size = cardPanel.frame.size
        var x = orbPanel.frame.midX - size.width / 2
        x = min(max(screen.minX + 10, x), screen.maxX - size.width - 10)
        var y = orbPanel.frame.maxY + 12
        if y + size.height > screen.maxY { y = orbPanel.frame.minY - size.height - 12 }
        cardPanel.setFrameOrigin(CGPoint(x: x, y: y))
    }

    private func beginDrag() {
        dragOrigin = orbPanel.frame.origin
    }

    private func drag(_ translation: CGSize) {
        let center = NSPoint(x: orbPanel.frame.midX, y: orbPanel.frame.midY)
        let screen = NSScreen.screens.first(where: { $0.visibleFrame.contains(center) })?.visibleFrame
            ?? NSScreen.main?.visibleFrame
            ?? NSScreen.screens[0].visibleFrame
        let maxX = screen.maxX - orbPanel.frame.width - 8
        let maxY = screen.maxY - orbPanel.frame.height - 8
        orbOrigin = CGPoint(
            x: min(max(screen.minX + 8, dragOrigin.x + translation.width), maxX),
            y: min(max(screen.minY + 8, dragOrigin.y + translation.height), maxY)
        )
        orbPanel.setFrameOrigin(orbOrigin)
        if cardPanel.isVisible { positionCard() }
    }

    private func endDrag() {}
}

@main
@MainActor
private struct OpenCodexLivePickerMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
