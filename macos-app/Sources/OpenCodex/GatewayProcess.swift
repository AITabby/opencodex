import Foundation
import AppKit

@MainActor
final class GatewayProcess: ObservableObject {
    enum State: Equatable {
        case idle
        case starting
        case ready
        case failed(String)
        case stopped

        var label: String {
            switch self {
            case .idle: return "准备启动网关"
            case .starting: return "正在启动网关…"
            case .ready: return "网关已就绪"
            case .failed(let message): return message
            case .stopped: return "网关已停止"
            }
        }
    }

    @Published private(set) var state: State = .idle
    @Published private(set) var port: Int = 0
    @Published private(set) var logTail = ""

    private var process: Process?
    private var outputPipe: Pipe?
    private var runtimeFileURL: URL?

    init() {
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.stop() }
        }
    }

    var dashboardURL: URL? {
        guard state == .ready, port > 0 else { return nil }
        return URL(string: "http://127.0.0.1:\(port)/dashboard")
    }

    func start() async {
        guard process == nil else { return }
        state = .starting
        logTail = ""
        port = await choosePort()

        let root = ProcessInfo.processInfo.environment["OPENCODEX_DEV_ROOT"]
            .map(URL.init(fileURLWithPath:))
        let resources = Bundle.main.resourceURL
        let serverURL = root?.appendingPathComponent("dist/server.js")
            ?? resources?.appendingPathComponent("dist/server.js")

        guard let serverURL else {
            state = .failed("找不到网关入口 dist/server.js")
            return
        }

        let executableURL: URL
        let arguments: [String]
        if let bundledNode = resources?.appendingPathComponent("node"), FileManager.default.isExecutableFile(atPath: bundledNode.path) {
            executableURL = bundledNode
            arguments = [serverURL.path]
        } else {
            executableURL = URL(fileURLWithPath: "/usr/bin/env")
            arguments = ["node", serverURL.path]
        }

        let child = Process()
        child.executableURL = executableURL
        child.arguments = arguments
        child.currentDirectoryURL = root ?? resources
        var environment = ProcessInfo.processInfo.environment
        environment["OPENCODEX_PORT"] = String(port)
        environment["OPENCODEX_APP_MODE"] = "1"
        environment["OPENCODEX_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        let applicationSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("OpenCodex", isDirectory: true)
        try? FileManager.default.createDirectory(at: applicationSupport, withIntermediateDirectories: true)
        let runtimeFile = applicationSupport.appendingPathComponent("gateway_runtime_\(ProcessInfo.processInfo.processIdentifier).json")
        let runtimePayload: [String: Any] = ["port": port, "pid": ProcessInfo.processInfo.processIdentifier, "started_at": Date().timeIntervalSince1970]
        if let runtimeData = try? JSONSerialization.data(withJSONObject: runtimePayload) {
            try? runtimeData.write(to: runtimeFile, options: .atomic)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: runtimeFile.path)
            runtimeFileURL = runtimeFile
        }
        environment["OPENCODEX_DATA_DIR"] = applicationSupport.path
        let voiceRuntime = resources?.appendingPathComponent("voice-runtime")
        if let voiceRuntime, FileManager.default.fileExists(atPath: voiceRuntime.path) {
            environment["OPENCODEX_VOICE_RUNTIME_DIR"] = voiceRuntime.path
            environment["OPENCODEX_VOICE_ENERGY_VAD"] = "1"
            let bundledFFmpeg = voiceRuntime.appendingPathComponent("ffmpeg")
            if FileManager.default.isExecutableFile(atPath: bundledFFmpeg.path) {
                environment["OPENCODEX_FFMPEG_PATH"] = bundledFFmpeg.path
            }
        }
        let bundledVoiceBar = resources?.appendingPathComponent("OpenCodexBar.app/Contents/MacOS/OpenCodexBar")
        if let bundledVoiceBar, FileManager.default.isExecutableFile(atPath: bundledVoiceBar.path) {
            environment["OPENCODEX_VOICE_BAR_PATH"] = bundledVoiceBar.path
        }
        child.environment = environment

        let pipe = Pipe()
        child.standardOutput = pipe
        child.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor in self?.appendLog(text) }
        }

        child.terminationHandler = { [weak self] child in
            Task { @MainActor in
                guard let self, self.process === child else { return }
                self.process = nil
                self.outputPipe = nil
                if let runtimeFileURL = self.runtimeFileURL {
                    try? FileManager.default.removeItem(at: runtimeFileURL)
                    self.runtimeFileURL = nil
                }
                if self.state != .ready {
                    self.state = .failed("网关启动失败（退出码 \(child.terminationStatus)）")
                } else {
                    self.state = .stopped
                }
            }
        }

        do {
            try child.run()
            process = child
            outputPipe = pipe
        } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            state = .failed("无法启动网关：\(error.localizedDescription)")
            return
        }

        let ready = await waitForHealth()
        if ready {
            state = .ready
        } else if child.isRunning {
            state = .failed("网关启动超时，请查看日志")
        }
    }

    func stop() {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        guard let process else { return }
        if process.isRunning {
            process.terminate()
        }
        self.process = nil
        self.outputPipe = nil
        if let runtimeFileURL {
            try? FileManager.default.removeItem(at: runtimeFileURL)
            self.runtimeFileURL = nil
        }
        if state == .ready || state == .starting {
            state = .stopped
        }
    }

    func retry() {
        stop()
        Task { await start() }
    }

    private func appendLog(_ text: String) {
        logTail = String((logTail + text).suffix(6000))
    }

    private func choosePort() async -> Int {
        if let configured = ProcessInfo.processInfo.environment["OPENCODEX_APP_PORT"], let value = Int(configured), value > 0, value < 65536 {
            return value
        }
        return Int.random(in: 18000...28000)
    }

    private func waitForHealth() async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return false }
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            do {
                var request = URLRequest(url: url)
                request.timeoutInterval = 1.5
                let (_, response) = try await URLSession.shared.data(for: request)
                if (response as? HTTPURLResponse)?.statusCode == 200 { return true }
            } catch {}
            try? await Task.sleep(for: .milliseconds(250))
        }
        return false
    }
}
