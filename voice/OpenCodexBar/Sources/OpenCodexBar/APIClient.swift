import Foundation

func addOpenCodexAdminToken(to request: inout URLRequest) {
  guard let token = GatewayLocator.adminToken(),
    !token.isEmpty else {
    return
  }
  request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
}

class APIClient: NSObject {
  private var statusCallback: ((AppStatus) -> Void)?

  func fetchStatus() {
    let url = GatewayLocator.url(path: "health")
    URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
      DispatchQueue.main.async {
        if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
          NotificationCenter.default.post(name: .init("OpenCodexStatusChanged"), object: AppStatus.idle)
        } else {
          NotificationCenter.default.post(name: .init("OpenCodexStatusChanged"), object: AppStatus.offline)
        }
      }
    }.resume()
  }

  func sendVoice(_ text: String, completion: @escaping (Bool) -> Void) {
    var req = URLRequest(url: GatewayLocator.url(path: "api/voice"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    addOpenCodexAdminToken(to: &req)
    req.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text])

    URLSession.shared.dataTask(with: req) { _, response, _ in
      DispatchQueue.main.async {
        completion((response as? HTTPURLResponse)?.statusCode == 200)
      }
    }.resume()
  }

  func restartCodex() {
    var req = URLRequest(url: GatewayLocator.url(path: "api/restart-codex"))
    req.httpMethod = "POST"
    addOpenCodexAdminToken(to: &req)
    URLSession.shared.dataTask(with: req).resume()
  }
}
