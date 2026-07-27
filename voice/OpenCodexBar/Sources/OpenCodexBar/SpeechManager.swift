import AVFoundation

class SpeechManager {
  private let synth = AVSpeechSynthesizer()

  func speak(_ text: String) {
    let clean = text
      .replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !clean.isEmpty else { return }
    let utterance = AVSpeechUtterance(string: clean)
    utterance.voice = AVSpeechSynthesisVoice(language: "zh-CN") // Prefer Chinese
    utterance.rate = 0.5
    utterance.volume = 1.0
    synth.stopSpeaking(at: .immediate)
    synth.speak(utterance)
  }

  func stop() {
    synth.stopSpeaking(at: .immediate)
  }
}
