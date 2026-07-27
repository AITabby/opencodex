import Foundation

enum GatewayLocator {
  private static let fallbackPort = 8765

  private static var dataDirectories: [URL] {
    let home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
    let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
      .first?.appendingPathComponent("OpenCodex", isDirectory: true)
    return [appSupport, home.appendingPathComponent(".opencodex", isDirectory: true)].compactMap { $0 }
  }

  private static var runtimePort: Int? {
    for directory in dataDirectories {
      let files = (try? FileManager.default.contentsOfDirectory(
        at: directory,
        includingPropertiesForKeys: [.contentModificationDateKey],
        options: [.skipsHiddenFiles]
      )) ?? []
      let runtimeFiles = files.filter { url in
        let name = url.lastPathComponent
        return name.hasPrefix("gateway_runtime_") && name.hasSuffix(".json")
      }.sorted { lhs, rhs in
        let left = (try? lhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
        let right = (try? rhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
        return left > right
      }
      for path in runtimeFiles {
        guard let data = try? Data(contentsOf: path),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let port = object["port"] as? Int,
              port > 0, port < 65536 else { continue }
        return port
      }
    }
    if let configured = ProcessInfo.processInfo.environment["OPENCODEX_GATEWAY_PORT"],
       let port = Int(configured), port > 0, port < 65536 {
      return port
    }
    return nil
  }

  static var httpBaseURL: URL {
    URL(string: "http://127.0.0.1:\(runtimePort ?? fallbackPort)")!
  }

  static var hasPublishedRuntime: Bool {
    runtimePort != nil
  }

  static var webSocketURL: URL {
    URL(string: "ws://127.0.0.1:\(runtimePort ?? fallbackPort)")!
  }

  static func url(path: String) -> URL {
    httpBaseURL.appendingPathComponent(path.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
  }

  static func adminToken() -> String? {
    for directory in dataDirectories {
      let path = directory.appendingPathComponent("admin_token")
      if let token = try? String(contentsOf: path, encoding: .utf8) {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
      }
    }
    return nil
  }

  static func settingsData() -> Data? {
    // ~/.opencodex is the canonical settings store used by the gateway and
    // dashboard.  Do not choose by mtime: an older compatibility file may be
    // touched later while missing newer fields such as interaction_mode.
    let home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
    let canonical = home.appendingPathComponent(".opencodex/voice_settings.json")
    if let data = try? Data(contentsOf: canonical) {
      return data
    }

    let legacy = home.appendingPathComponent("Library/Application Support/OpenCodex/voice_settings.json")
    return try? Data(contentsOf: legacy)
  }
}
