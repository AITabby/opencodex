import Combine
import CryptoKit
import Foundation

@MainActor
final class TaskRelayClient: ObservableObject {
    @Published private(set) var connected = false
    @Published private(set) var lastError: String?
    @Published private(set) var reconnecting = false

    private var task: URLSessionWebSocketTask?
    private var connectionTask: Task<Void, Never>?
    private var configuration: (url: URL, channel: String, token: String, key: Data)?
    private var pendingActivityTokens: [String: String] = [:]
    private var pendingRequests: [String: CheckedContinuation<Data, Error>] = [:]
    private let onEvent: (CodexTaskEvent) async -> Void

    init(onEvent: @escaping (CodexTaskEvent) async -> Void) {
        self.onEvent = onEvent
    }

    func start(url: URL, channel: String, token: String, key: Data) {
        stop()
        guard key.count == 32 else {
            lastError = "中继密钥必须是 32 字节"
            return
        }

        lastError = nil
        configuration = (url, channel, token, key)
        connectionTask = Task { [weak self] in
            await self?.runLoop()
        }
    }

    func stop() {
        connectionTask?.cancel()
        connectionTask = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        connected = false
        reconnecting = false
        failPendingRequests(with: RelayRequestError.disconnected)
    }

    /// Sends an encrypted request to the Mac gateway and returns the decrypted
    /// JSON response body. The VPS only forwards this envelope.
    func request(method: String, payload: [String: String] = [:]) async throws -> Data {
        guard connected else {
            throw RelayRequestError.disconnected
        }
        let requestID = UUID().uuidString
        let plaintext = try JSONSerialization.data(withJSONObject: [
            "method": method,
            "payload": payload
        ])

        return try await withCheckedThrowingContinuation { continuation in
            pendingRequests[requestID] = continuation
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    guard let task = self.task, self.connected, let configuration = self.configuration else {
                        throw RelayRequestError.disconnected
                    }
                    let envelope = try self.encryptedEnvelope(
                        type: "rpc_request",
                        requestID: requestID,
                        plaintext: plaintext,
                        key: configuration.key
                    )
                    try await task.send(.string(envelope))
                } catch {
                    self.finishRequest(requestID, result: .failure(error))
                }
            }
        }
    }

    func registerActivityToken(taskId: String, token: String) {
        pendingActivityTokens[taskId] = token
        guard let task, connected else { return }
        Task {
            try? await sendActivityToken(taskId: taskId, token: token, over: task)
        }
    }

    private func runLoop() async {
        var retryDelay: UInt64 = 1

        while !Task.isCancelled {
            guard let configuration else { return }
            let webSocket = URLSession.shared.webSocketTask(with: configuration.url)
            task = webSocket
            connected = false
            reconnecting = true
            webSocket.resume()

            do {
                let hello = RelayHello(type: "hello", protocolName: "opencodex-task-relay-v1", role: "phone", channel: configuration.channel, token: configuration.token)
                let helloData = try JSONEncoder().encode(hello)
                try await webSocket.send(.string(String(decoding: helloData, as: UTF8.self)))
                for (taskId, token) in pendingActivityTokens {
                    try await sendActivityToken(taskId: taskId, token: token, over: webSocket)
                }

                while !Task.isCancelled {
                    let message = try await webSocket.receive()
                    guard case let .string(text) = message else { continue }
                    if consumeReady(text) {
                        connected = true
                        reconnecting = false
                        lastError = nil
                        retryDelay = 1
                        continue
                    }
                    guard connected else { continue }
                    await consume(text, key: configuration.key)
                }
            } catch is CancellationError {
                connected = false
                reconnecting = false
                return
            } catch {
                connected = false
                failPendingRequests(with: error)
                lastError = "中继连接暂时失败，正在自动重试。"
                reconnecting = true
            }

            if task === webSocket {
                task = nil
            }
            connected = false
            guard !Task.isCancelled else { return }
            reconnecting = true
            try? await Task.sleep(nanoseconds: retryDelay * 1_000_000_000)
            retryDelay = min(retryDelay * 2, 30)
        }
    }

    private func sendActivityToken(taskId: String, token: String, over task: URLSessionWebSocketTask) async throws {
        let payload = ActivityTokenMessage(type: "activity_token", taskId: taskId, token: token)
        let data = try JSONEncoder().encode(payload)
        try await task.send(.string(String(decoding: data, as: UTF8.self)))
    }

    /// The relay accepts the WebSocket first and authenticates with an
    /// application-level hello.  Treat the connection as ready only after
    /// the relay confirms that handshake, rather than after the socket opens.
    private func consumeReady(_ text: String) -> Bool {
        guard let data = text.data(using: .utf8),
              let ready = try? JSONDecoder().decode(RelayReady.self, from: data) else {
            return false
        }
        return ready.type == "ready" && ready.protocolName == "opencodex-task-relay-v1"
    }

    private func consume(_ text: String, key: Data) async {
        guard let data = text.data(using: .utf8),
              let envelope = try? JSONDecoder().decode(RelayEnvelope.self, from: data),
              let plaintext = try? decrypt(envelope, key: key) else { return }
        do {
            if envelope.type == "rpc_response", let requestID = envelope.requestID {
                let object = try JSONSerialization.jsonObject(with: plaintext) as? [String: Any]
                if object?["ok"] as? Bool == true {
                    let value = object?["data"] ?? NSNull()
                    let valueData = try JSONSerialization.data(withJSONObject: value)
                    finishRequest(requestID, result: .success(valueData))
                } else {
                    let message = object?["error"] as? String ?? "中继请求失败"
                    finishRequest(requestID, result: .failure(RelayRequestError.server(message)))
                }
                return
            }
            guard envelope.type == "event" else { return }
            let decoder = JSONDecoder.codexTaskEventDecoder()
            let event = try decoder.decode(CodexTaskEvent.self, from: plaintext)
            await onEvent(event)
        } catch {
            if envelope.type == "rpc_response", let requestID = envelope.requestID {
                finishRequest(requestID, result: .failure(error))
            } else {
                lastError = "无法验证中继事件"
            }
        }
    }

    private func encryptedEnvelope(type: String, requestID: String?, plaintext: Data, key: Data) throws -> String {
        let sealed = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key))
        let nonce = sealed.nonce.withUnsafeBytes { Data($0) }
        return try String(decoding: JSONEncoder().encode(RelayEnvelope(
            type: type,
            version: 1,
            requestID: requestID,
            nonce: nonce.base64URLEncoded,
            ciphertext: sealed.ciphertext.base64URLEncoded,
            tag: sealed.tag.base64URLEncoded
        )), as: UTF8.self)
    }

    private func decrypt(_ envelope: RelayEnvelope, key: Data) throws -> Data {
        guard let nonce = Data(base64URLEncoded: envelope.nonce),
              let ciphertext = Data(base64URLEncoded: envelope.ciphertext),
              let tag = Data(base64URLEncoded: envelope.tag) else {
            throw RelayRequestError.invalidEnvelope
        }
        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: nonce),
            ciphertext: ciphertext,
            tag: tag
        )
        return try AES.GCM.open(box, using: SymmetricKey(data: key))
    }

    private func finishRequest(_ requestID: String, result: Result<Data, Error>) {
        guard let continuation = pendingRequests.removeValue(forKey: requestID) else { return }
        continuation.resume(with: result)
    }

    private func failPendingRequests(with error: Error) {
        let requests = pendingRequests
        pendingRequests.removeAll()
        for (requestID, continuation) in requests {
            _ = requestID
            continuation.resume(throwing: error)
        }
    }
}

private struct RelayHello: Encodable {
    let type: String
    let protocolName: String
    let role: String
    let channel: String
    let token: String

    enum CodingKeys: String, CodingKey {
        case type
        case protocolName = "protocol"
        case role
        case channel
        case token
    }
}

private struct RelayEnvelope: Codable {
    let type: String
    let version: Int
    let requestID: String?
    let nonce: String
    let ciphertext: String
    let tag: String

    enum CodingKeys: String, CodingKey {
        case type
        case version
        case requestID = "requestId"
        case nonce
        case ciphertext
        case tag
    }

    init(type: String, version: Int, requestID: String?, nonce: String, ciphertext: String, tag: String) {
        self.type = type
        self.version = version
        self.requestID = requestID
        self.nonce = nonce
        self.ciphertext = ciphertext
        self.tag = tag
    }
}

private struct RelayReady: Decodable {
    let type: String
    let protocolName: String

    enum CodingKeys: String, CodingKey {
        case type
        case protocolName = "protocol"
    }
}

private struct ActivityTokenMessage: Encodable {
    let type: String
    let taskId: String
    let token: String
}

private extension Data {
    init?(base64URLEncoded value: String) {
        var normalized = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        normalized += String(repeating: "=", count: (4 - normalized.count % 4) % 4)
        self.init(base64Encoded: normalized)
    }

    var base64URLEncoded: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

enum RelayRequestError: LocalizedError {
    case disconnected
    case invalidEnvelope
    case server(String)

    var errorDescription: String? {
        switch self {
        case .disconnected: "中继尚未连接"
        case .invalidEnvelope: "中继响应格式无效"
        case let .server(message): message
        }
    }
}
