import Foundation
import Combine

@MainActor
final class TaskEventClient: ObservableObject {
    @Published private(set) var connected = false
    @Published private(set) var lastError: String?
    @Published private(set) var reconnecting = false

    private var streamTask: Task<Void, Never>?
    private var reconciliationTask: Task<Void, Never>?
    private var lastSequence = 0
    private var activeTaskIDs = Set<String>()
    private var gatewayURL: URL?
    private var mobileToken = ""
    private let streamSession: URLSession
    private let onEvent: (CodexTaskEvent) async -> Void
    private let onNoActiveTasks: () async -> Void

    init(
        onEvent: @escaping (CodexTaskEvent) async -> Void,
        onNoActiveTasks: @escaping () async -> Void
    ) {
        let configuration = URLSessionConfiguration.ephemeral
        // Task events are a deliberately long-lived SSE connection. The
        // shared session's ordinary request timeout is for finite requests
        // and can expire while the user is simply reading the app.
        configuration.timeoutIntervalForRequest = 24 * 60 * 60
        configuration.timeoutIntervalForResource = 24 * 60 * 60
        streamSession = URLSession(configuration: configuration)
        self.onEvent = onEvent
        self.onNoActiveTasks = onNoActiveTasks
    }

    func start(baseURL: URL, mobileToken: String) {
        stop()
        gatewayURL = baseURL
        self.mobileToken = mobileToken
        streamTask = Task { [weak self] in
            guard let self else { return }
            await self.run(baseURL: baseURL, mobileToken: mobileToken)
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
        reconciliationTask?.cancel()
        reconciliationTask = nil
        connected = false
        reconnecting = false
    }

    private func run(baseURL: URL, mobileToken: String) async {
        var retryDelay: UInt64 = 1

        while !Task.isCancelled {
            var requestURL = baseURL
            requestURL.appendPathComponent("api/task-events")
            var components = URLComponents(url: requestURL, resolvingAgainstBaseURL: false)
            components?.queryItems = [
                URLQueryItem(name: "activeOnly", value: "1"),
                URLQueryItem(name: "since", value: String(lastSequence))
            ]
            requestURL = components?.url ?? requestURL
            var request = URLRequest(url: requestURL, timeoutInterval: 24 * 60 * 60)
            request.setValue("Bearer \(mobileToken)", forHTTPHeaderField: "Authorization")
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")

            do {
                let (bytes, response) = try await streamSession.bytes(for: request)
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard statusCode == 200 else {
                    throw TaskEventClientError.http(statusCode)
                }
                connected = true
                reconnecting = false
                lastError = nil
                retryDelay = 1
                // Reconnects use the gateway's authoritative active snapshot;
                // never replay historical running events into the island.
                activeTaskIDs.removeAll()
                let activeCount = Int((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "X-Active-Tasks") ?? "")
                if activeCount == 0 {
                    await onNoActiveTasks()
                }

                for try await line in bytes.lines {
                    try Task.checkCancellation()
                    let normalizedLine = line.trimmingCharacters(in: .whitespacesAndNewlines)
                    if normalizedLine.hasPrefix("data:") {
                        let payload = String(normalizedLine.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                        await consume(payload)
                    }
                }
            } catch is CancellationError {
                connected = false
                reconnecting = false
                return
            } catch {
                connected = false
                lastError = gatewayErrorDescription(error, operation: "连接网关")
                reconnecting = true
            }

            connected = false
            guard !Task.isCancelled else { return }
            reconnecting = true
            try? await Task.sleep(nanoseconds: retryDelay * 1_000_000_000)
            retryDelay = min(retryDelay * 2, 30)
        }
    }

    private func consume(_ payload: String) async {
        guard !payload.isEmpty, let data = payload.data(using: .utf8) else { return }
        do {
            let decoder = JSONDecoder.codexTaskEventDecoder()
            let event = try decoder.decode(CodexTaskEvent.self, from: data)
            await apply(event)
        } catch {
            lastError = "任务状态数据无法识别，正在等待网关重新同步。"
        }
    }

    private func startActiveReconciliation() {
        guard reconciliationTask == nil, let gatewayURL, !mobileToken.isEmpty else { return }
        reconciliationTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard let self, !self.activeTaskIDs.isEmpty else { break }

                do {
                    let activeEvents = try await self.fetchActiveSnapshot(
                        baseURL: gatewayURL,
                        mobileToken: self.mobileToken
                    )
                    // SSE gives us lifecycle transitions quickly, while this
                    // authoritative snapshot often carries the later token
                    // and quota samples. Feed both through the same handler
                    // so the island never waits for a separate SSE event.
                    for event in activeEvents {
                        await self.apply(event)
                    }
                    let currentIDs = Set(activeEvents.compactMap { event in
                        switch event.state {
                        case .queued, .running, .waiting: return event.taskId
                        case .completed, .failed: return nil
                        }
                    })
                    let missingIDs = self.activeTaskIDs.subtracting(currentIDs)
                    self.activeTaskIDs.subtract(missingIDs)
                    if self.activeTaskIDs.isEmpty {
                        await self.onNoActiveTasks()
                    }
                } catch {
                    // The SSE stream remains the primary channel. A temporary
                    // snapshot failure should not tear it down.
                }
            }
            self?.reconciliationTask = nil
        }
    }

    private func fetchActiveSnapshot(baseURL: URL, mobileToken: String) async throws -> [CodexTaskEvent] {
        var requestURL = baseURL
        requestURL.appendPathComponent("api/task-events")
        var components = URLComponents(url: requestURL, resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "activeOnly", value: "1"),
            URLQueryItem(name: "snapshot", value: "1"),
            URLQueryItem(name: "since", value: String(lastSequence))
        ]
        requestURL = components?.url ?? requestURL
        var request = URLRequest(url: requestURL, timeoutInterval: 20)
        request.setValue("Bearer \(mobileToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await streamSession.data(for: request)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard statusCode == 200 else { throw TaskEventClientError.http(statusCode) }
        return try JSONDecoder.codexTaskEventDecoder().decode([CodexTaskEvent].self, from: data)
    }

    private func apply(_ event: CodexTaskEvent) async {
        lastSequence = max(lastSequence, event.sequence)
        switch event.state {
        case .queued, .running, .waiting:
            activeTaskIDs.insert(event.taskId)
            startActiveReconciliation()
        case .completed, .failed:
            activeTaskIDs.remove(event.taskId)
        }
        await onEvent(event)
        if activeTaskIDs.isEmpty {
            await onNoActiveTasks()
        }
    }
}

private enum TaskEventClientError: LocalizedError {
    case http(Int)

    var errorDescription: String? {
        switch self {
        case .http(let statusCode): return "网关返回 HTTP \(statusCode)"
        }
    }
}

/// Converts transport-layer failures into actionable Chinese copy. URLSession's
/// `localizedDescription` is often English even when the app is Chinese.
func gatewayErrorDescription(_ error: Error, operation: String) -> String {
    if let error = error as? TaskEventClientError,
       let description = error.errorDescription {
        return description
    }

    guard let urlError = error as? URLError else {
        return "\(operation)暂时失败，请稍后重试。"
    }

    switch urlError.code {
    case .timedOut:
        return "\(operation)超时，请确认 Mac 上的 OpenCodex 正在运行。"
    case .cannotConnectToHost, .cannotFindHost:
        return "无法连接到网关，请检查地址以及手机和 Mac 是否在同一网络。"
    case .notConnectedToInternet:
        return "手机当前未连接网络。"
    case .networkConnectionLost:
        return "网络连接已中断，正在自动重试。"
    case .userAuthenticationRequired, .userCancelledAuthentication:
        return "网关认证失败，请检查管理令牌。"
    case .secureConnectionFailed, .serverCertificateUntrusted:
        return "网关安全连接失败，请检查网关地址。"
    default:
        return "\(operation)暂时失败，请稍后重试。"
    }
}
