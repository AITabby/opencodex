import Foundation

class WebSocketManager: NSObject {
  static let shared = WebSocketManager()

  private var task: URLSessionWebSocketTask?
  private var isConnected = false

  var onTranscriptionPartial: ((String) -> Void)?
  var onTranscriptionFinal: ((String) -> Void)?
  var onActivateSession: ((String) -> Void)?
  var onStopRecording: ((String) -> Void)?
  var onSettingsUpdated: (() -> Void)?
  var onModelChunk: ((String) -> Void)?
  var onModelDone: ((String) -> Void)?

  private let queue = DispatchQueue(label: "com.opencodex.ws")

  func connect() {
    queue.async { [weak self] in
      guard let self = self else { return }
      if self.isConnected, let t = self.task, t.state == .running {
        return
      }
      self.isConnected = false
      self.task?.cancel(with: .goingAway, reason: nil)
      
      let url = GatewayLocator.webSocketURL
      let session = URLSession(configuration: .default)
      let t = session.webSocketTask(with: url)
      self.task = t
      t.resume()
      self.isConnected = true
      AppDelegate.shared?.log("[WS] Connecting to websocket at \(url.absoluteString)...")
      self.receive()
    }
  }

  private func receive() {
    task?.receive { [weak self] result in
      guard let self = self else { return }
      switch result {
      case .success(let message):
        switch message {
        case .string(let text):
          self.handleMessage(text)
        default:
          break
        }
        self.receive()
      case .failure(let error):
        AppDelegate.shared?.log("[WS Err] Connection failure: \(error.localizedDescription)")
        self.isConnected = false
        self.task = nil
      }
    }
  }

  private func handleMessage(_ text: String) {
    guard let data = text.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = json["type"] as? String else { return }
    switch type {
    case "transcription", "transcription_partial":
      if let t = json["text"] as? String {
        onTranscriptionPartial?(t)
      }
    case "transcription_final":
      if let t = json["text"] as? String {
        onTranscriptionFinal?(t)
      }
    case "stop_recording":
      if let t = json["text"] as? String {
        onStopRecording?(t)
      }
    case "activate_session":
      if let sid = json["session_id"] as? String {
        onActivateSession?(sid)
      }
    case "settings_updated":
      onSettingsUpdated?()
    case "model_chunk":
      if let t = json["text"] as? String {
        onModelChunk?(t)
      }
    case "model_done":
      if let t = json["text"] as? String {
        onModelDone?(t)
      }
    default:
      break
    }
  }

  func sendStartSTT(manualStop: Bool = false) {
    sendJson(["type": "start_stt", "manual_stop": manualStop])
  }

  func sendStopSTT() {
    sendJson(["type": "stop_stt"])
  }

  func sendAudioChunk(_ data: Data) {
    queue.async { [weak self] in
      guard let self = self, self.isConnected else { return }
      self.task?.send(.data(data)) { _ in }
    }
  }

  func sendJson(_ dict: [String: Any]) {
    queue.async { [weak self] in
      guard let self = self, self.isConnected,
            let data = try? JSONSerialization.data(withJSONObject: dict),
            let s = String(data: data, encoding: .utf8) else { return }
      self.task?.send(.string(s)) { _ in }
    }
  }
}
