import Foundation

final class PrivateRuntimeStorage {
  static let shared = PrivateRuntimeStorage()

  let rootURL: URL

  private init() {
    let base = FileManager.default.temporaryDirectory
    rootURL = base.appendingPathComponent(
      "OpenCodexBar-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString)",
      isDirectory: true
    )
    do {
      try FileManager.default.createDirectory(
        at: rootURL,
        withIntermediateDirectories: false,
        attributes: [.posixPermissions: 0o700]
      )
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: rootURL.path)
    } catch {
      fatalError("OpenCodexBar cannot create private runtime storage")
    }
  }

  func fixedFile(_ name: String) -> URL {
    precondition(!name.isEmpty && URL(fileURLWithPath: name).lastPathComponent == name)
    return rootURL.appendingPathComponent(name, isDirectory: false)
  }

  func uniqueFile(_ label: String, withExtension fileExtension: String = "") -> URL {
    let safeLabel = label.replacingOccurrences(
      of: "[^A-Za-z0-9._-]",
      with: "-",
      options: .regularExpression
    )
    let safeExtension = fileExtension.replacingOccurrences(
      of: "[^A-Za-z0-9]",
      with: "",
      options: .regularExpression
    )
    let suffix = safeExtension.isEmpty ? "" : ".\(safeExtension)"
    return rootURL.appendingPathComponent("\(safeLabel)-\(UUID().uuidString)\(suffix)")
  }

  func write(_ value: String, to url: URL) throws {
    try assertOwned(url)
    try value.write(to: url, atomically: true, encoding: .utf8)
    try makePrivate(url)
  }

  func write(_ value: Data, to url: URL) throws {
    try assertOwned(url)
    try value.write(to: url, options: .atomic)
    try makePrivate(url)
  }

  func appendLine(_ value: String, to url: URL) {
    do {
      try assertOwned(url)
      if !FileManager.default.fileExists(atPath: url.path) {
        try write("", to: url)
      }
      let handle = try FileHandle(forWritingTo: url)
      try handle.seekToEnd()
      if let data = (value + "\n").data(using: .utf8) {
        try handle.write(contentsOf: data)
      }
      try handle.close()
      try makePrivate(url)
    } catch {
      // Diagnostics must never force the voice companion to exit.
    }
  }

  func makePrivate(_ url: URL) throws {
    try assertOwned(url)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }

  func remove(_ url: URL) {
    guard owns(url) else { return }
    try? FileManager.default.removeItem(at: url)
  }

  func cleanup() {
    let base = FileManager.default.temporaryDirectory.standardizedFileURL
    let root = rootURL.standardizedFileURL
    guard root.deletingLastPathComponent() == base,
      root.lastPathComponent.hasPrefix("OpenCodexBar-\(ProcessInfo.processInfo.processIdentifier)-") else {
      return
    }
    try? FileManager.default.removeItem(at: root)
  }

  func owns(_ url: URL) -> Bool {
    url.standardizedFileURL.deletingLastPathComponent() == rootURL.standardizedFileURL
  }

  private func assertOwned(_ url: URL) throws {
    guard owns(url) else {
      throw NSError(domain: "OpenCodexBar.PrivateRuntimeStorage", code: 1)
    }
  }
}
