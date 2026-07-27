import AVFoundation

struct VoiceSettings: Decodable {
  var stt_engine: String?
  var stt_api_key: String?
  var stt_base_url: String?
  var stt_model: String?
  var tts_engine: String?
  var tts_api_key: String?
  var tts_appid: String?
  var tts_resource_id: String?
  var tts_base_url: String?
  var tts_model: String?
  var tts_voice: String?
  var vad_threshold: Float?
  var vad_duration: Double?
  var voice_llm_model: String?
  var enable_wake_word: Bool?
  var hud_theme: String?
  var active_session_id: String?
  var voice_system_prompt: String?
  var tts_resource: String?
  var interaction_mode: String?
  var pause_media_on_listen: Bool?
  var tts_volume: Float?

  static func load() -> VoiceSettings {
    guard let data = GatewayLocator.settingsData(),
          let settings = try? JSONDecoder().decode(VoiceSettings.self, from: data) else {
      return VoiceSettings()
    }
    return settings
  }
}

class VoiceManager: NSObject {
  private let audioEngine = AVAudioEngine()
  private var completionHandler: ((String?) -> Void)?

  private var vadThreshold: Float = -35.0
  private var vadDuration: Double = 2.0
  private var lowVolumeDuration: TimeInterval = 0.0
  private var hasSpeechStarted = false
  private var isActive = false
  private var isStopping = false
  private var noSpeechDuration: TimeInterval = 0.0
  private var automaticStopEnabled = true

  var onNoSpeechTimeout: (() -> Void)?
  var onUserInterrupted: (() -> Void)?

  private var vadTimer: Timer?
  private var meteringTimer: Timer?

  var amplitudeUpdateHandler: ((Float) -> Void)?

  var isInterruptionMonitoring = false
  private var interruptionThreshold: Float = -35.0
  private var consecutiveInterruptionFrames = 0
  private var monitoringStartTime: Date?
  private let interruptionWarmupDuration: TimeInterval = 0.45
  private let requiredInterruptionFrames = 4

  var isListening: Bool {
    return isActive
  }

  func startListening(autoStop: Bool = true, completion: @escaping (String?) -> Void) {
    AppDelegate.shared?.log("[VM] startListening (local VAD + WS)")
    WebSocketManager.shared.connect()
    
    // 显式请求麦克风权限
    if #available(macOS 14.0, *) {
      AVAudioApplication.requestRecordPermission { granted in
        DispatchQueue.main.async {
          if !granted {
            AppDelegate.shared?.log("[VM] Microphone permission denied!")
            completion(nil)
            return
          }
          self.continueListening(autoStop: autoStop, completion: completion)
        }
      }
    } else {
      self.continueListening(autoStop: autoStop, completion: completion)
    }
  }
  
  private func continueListening(autoStop: Bool, completion: @escaping (String?) -> Void) {
    completionHandler = completion
    automaticStopEnabled = autoStop

    let settings = VoiceSettings.load()
    vadThreshold = settings.vad_threshold ?? -35.0
    vadDuration = settings.vad_duration ?? 1.5
    AppDelegate.shared?.log("[VM] VAD threshold=\(vadThreshold)dB fallback duration=\(vadDuration)s")

    let inputNode = audioEngine.inputNode
    let hwFormat = inputNode.outputFormat(forBus: 0)
    AppDelegate.shared?.log("[VM] HW format: \(hwFormat.sampleRate)Hz \(hwFormat.channelCount)ch")

    let targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: false)!
    guard let converter = AVAudioConverter(from: hwFormat, to: targetFormat) else {
      AppDelegate.shared?.log("[VM Err] Cannot create converter")
      completion(nil)
      return
    }
    converter.channelMap = [0]

    lowVolumeDuration = 0.0
    hasSpeechStarted = false
    noSpeechDuration = 0.0
    isActive = true
    inputNode.removeTap(onBus: 0)
    inputNode.installTap(onBus: 0, bufferSize: 3200, format: hwFormat) { [weak self] buffer, _ in
      guard let self = self, self.isActive else { return }
      let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
        outStatus.pointee = .haveData
        return buffer
      }
      let fc = AVAudioFrameCount(Double(buffer.frameLength) * 16000.0 / hwFormat.sampleRate)
      guard let outBuf = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: fc) else { return }
      var err: NSError?
      let status = converter.convert(to: outBuf, error: &err, withInputFrom: inputBlock)
      guard status == .haveData, let ch = outBuf.int16ChannelData else { return }

      let count = Int(outBuf.frameLength)
      if count > 0 {
        let data = Data(bytes: ch[0], count: count * 2)
        WebSocketManager.shared.sendAudioChunk(data)

        var sumSq: Double = 0
        for i in 0..<count {
          let s = Double(ch[0][i]) / Double(Int16.max)
          sumSq += s * s
        }
        let rms = sqrt(sumSq / Double(count))
        var power: Float = 20.0 * log10(Float(max(rms, 0.0001)))
        if let ad = AppDelegate.shared, (ad.currentPlayProcess != nil || ad.isPlayingQueue) {
          power = -100.0
        }
        currentPower = power
      }
    }

    WebSocketManager.shared.onTranscriptionFinal = { [weak self] text in
      AppDelegate.shared?.log("[VM STT] Final: '\(text.prefix(50))'")
      DispatchQueue.main.async {
        guard let self = self else { return }
        self.stopEngine()
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        self.completionHandler?(trimmed.isEmpty ? nil : trimmed)
        self.completionHandler = nil
      }
    }

    WebSocketManager.shared.onTranscriptionPartial = { text in
      DispatchQueue.main.async {
        if let ad = AppDelegate.shared, ad.statusBar.currentStatus == .listening, let hud = ad.hudWindowController {
          hud.updateState(state: "listening", amplitude: 0.0, text: text)
        }
      }
    }

    WebSocketManager.shared.onStopRecording = { [weak self] text in
      AppDelegate.shared?.log("[VM] Server requested stop recording early for text: '\(text.prefix(50))'")
      DispatchQueue.main.async {
        guard let self = self, self.isActive else { return }
        guard self.automaticStopEnabled else {
          AppDelegate.shared?.log("[VM] Ignoring server auto-stop in push-to-talk mode")
          return
        }
        // Update HUD and status bar to show thinking/loading state instantly
        AppDelegate.shared?.statusBar.setStatus(.sending)
        AppDelegate.shared?.hudWindowController?.updateState(state: "thinking", amplitude: 0, text: text)
        // Locally stop recording engine ONLY, keep WS callbacks active to receive transcription_final
        self.stopAudioEngineOnly()
      }
    }

    WebSocketManager.shared.onActivateSession = { sid in
      AppDelegate.shared?.log("[VM] Activate session: \(sid)")
      DispatchQueue.main.async {
        AppDelegate.shared?.sessionId = sid
        AppDelegate.shared?.hudWindowController?.updateState(state: "idle", amplitude: 0, text: "已切换到会话: \(sid.prefix(8))...")
      }
    }

    var tickCount = 0
    vadTimer?.invalidate()
    vadTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
      guard let self = self, self.isActive, !self.isStopping, self.automaticStopEnabled else { return }
      tickCount += 1

      if self.currentPower > self.vadThreshold {
        self.hasSpeechStarted = true
        self.lowVolumeDuration = 0.0
        self.noSpeechDuration = 0.0
      } else {
        if self.hasSpeechStarted {
          self.lowVolumeDuration += 0.1
          if self.lowVolumeDuration >= self.vadDuration {
            AppDelegate.shared?.log("[VAD] Silence after speech (\(self.lowVolumeDuration)s >= \(self.vadDuration)s) → auto stop listening")
            self.stopListening()
            return
          }
        } else {
          self.noSpeechDuration += 0.1
          if self.noSpeechDuration >= 4.0 {
            AppDelegate.shared?.log("[VAD] No speech for 4s → timeout stop")
            self.stopListening()
            return
          }
        }
      }
    }

    meteringTimer?.invalidate()
    meteringTimer = Timer.scheduledTimer(withTimeInterval: 0.03, repeats: true) { [weak self] _ in
      guard let self = self, self.isActive else { return }
      let p = self.currentPower
      let clamped = max(-60.0, min(-10.0, p))
      let amp = (clamped + 60.0) / 50.0
      self.amplitudeUpdateHandler?(amp)
    }

    do {
      try audioEngine.start()
      WebSocketManager.shared.sendStartSTT(manualStop: !automaticStopEnabled)
      AppDelegate.shared?.log("[VM] Engine started, STT streaming, autoStop=\(automaticStopEnabled)")
    } catch {
      AppDelegate.shared?.log("[VM Err] Engine start: \(error.localizedDescription)")
      completion(nil)
    }

    DispatchQueue.global().asyncAfter(deadline: .now() + 120) { [weak self] in
      guard let self = self, self.isActive else { return }
      AppDelegate.shared?.log("[VM] 120s safety timeout → stop")
      self.stopListening()
    }
  }

  private var currentPower: Float = -100.0

  func cancelListening() {
    AppDelegate.shared?.log("[VM] cancelListening")
    guard isActive else { return }
    if let h = completionHandler {
      completionHandler = nil
      DispatchQueue.main.async { h(nil) }
    }
    stopEngine()
  }

  func stopListening() {
    AppDelegate.shared?.log("[VM] stopListening")
    guard isActive, !isStopping else { return }
    isStopping = true
    WebSocketManager.shared.sendStopSTT()
    AppDelegate.shared?.log("[VM] Sent stop_stt, awaiting transcription_final")

    DispatchQueue.global().asyncAfter(deadline: .now() + 10) { [weak self] in
      guard let self = self, self.isActive else { return }
      AppDelegate.shared?.log("[VM] STT timeout 10s → giving up")
      self.stopEngine()
      DispatchQueue.main.async {
        self.completionHandler?(nil)
        self.completionHandler = nil
      }
    }
  }

  private func stopAudioEngineOnly() {
    vadTimer?.invalidate()
    vadTimer = nil
    meteringTimer?.invalidate()
    meteringTimer = nil
    audioEngine.inputNode.removeTap(onBus: 0)
    audioEngine.stop()
  }

  private func stopEngine() {
    isActive = false
    isStopping = false
    automaticStopEnabled = true
    stopAudioEngineOnly()
    WebSocketManager.shared.onTranscriptionFinal = nil
    WebSocketManager.shared.onStopRecording = nil
  }

  func startInterruptionMonitoring() {
    guard !isActive else { return }
    AppDelegate.shared?.log("[VM] startInterruptionMonitoring")
    
    // Clear amplitude update handler to avoid leaking listening state updates during speech playback
    self.amplitudeUpdateHandler = nil
    
    let settings = VoiceSettings.load()
    let baseThreshold = settings.vad_threshold ?? -35.0
    let ttsVolume = settings.tts_volume ?? 1.5
    
    // Calculate the digital gain increase in decibels from the volume multiplier
    var volumeGainDb: Float = 0.0
    if ttsVolume > 0.0 {
      volumeGainDb = 20.0 * log10(ttsVolume)
    }
    
    // Determine the threshold sensitivity based on whether music is allowed to play during voice activation
    if settings.pause_media_on_listen == false {
      interruptionThreshold = max(-22.0, baseThreshold + 10.0 + volumeGainDb)
    } else {
      interruptionThreshold = max(-26.0, baseThreshold + 8.0 + volumeGainDb)
    }
    AppDelegate.shared?.log("[VM] Interruption threshold=\(interruptionThreshold)dB")
    
    isInterruptionMonitoring = true
    consecutiveInterruptionFrames = 0
    monitoringStartTime = Date()
    
    let inputNode = audioEngine.inputNode
    let hwFormat = inputNode.outputFormat(forBus: 0)
    let targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: false)!
    guard let converter = AVAudioConverter(from: hwFormat, to: targetFormat) else {
      AppDelegate.shared?.log("[VM Err] Cannot create converter for interruption")
      return
    }
    converter.channelMap = [0]
    
    inputNode.removeTap(onBus: 0)
    inputNode.installTap(onBus: 0, bufferSize: 1600, format: hwFormat) { [weak self] buffer, _ in
      guard let self = self, self.isInterruptionMonitoring else { return }
      
      let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
        outStatus.pointee = .haveData
        return buffer
      }
      let fc = AVAudioFrameCount(Double(buffer.frameLength) * 16000.0 / hwFormat.sampleRate)
      guard let outBuf = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: fc) else { return }
      var err: NSError?
      let status = converter.convert(to: outBuf, error: &err, withInputFrom: inputBlock)
      guard status == .haveData, let ch = outBuf.int16ChannelData else { return }
      
      let count = Int(outBuf.frameLength)
      if count > 0 {
        var sumSq: Double = 0
        for i in 0..<count {
          let s = Double(ch[0][i]) / Double(Int16.max)
          sumSq += s * s
        }
        let rms = sqrt(sumSq / Double(count))
        let power: Float = 20.0 * log10(Float(max(rms, 0.0001)))
        self.currentPower = power

        // Ignore the response chime and the first edge of TTS playback. Without
        // this guard, the app can interpret its own speaker output as barge-in.
        if let startedAt = self.monitoringStartTime,
           Date().timeIntervalSince(startedAt) < self.interruptionWarmupDuration {
          self.consecutiveInterruptionFrames = 0
          return
        }

        // Require sustained energy so clicks and brief speaker leakage do not
        // terminate playback. At the normal 48 kHz input rate this is ~130 ms.
        if power > self.interruptionThreshold {
          self.consecutiveInterruptionFrames += 1
          if self.consecutiveInterruptionFrames >= self.requiredInterruptionFrames {
            AppDelegate.shared?.log("[VM] Interruption detected (power=\(power)dB, threshold=\(self.interruptionThreshold)dB)")
            self.consecutiveInterruptionFrames = 0
            self.isInterruptionMonitoring = false
            DispatchQueue.main.async {
              self.onUserInterrupted?()
            }
          }
        } else {
          self.consecutiveInterruptionFrames = 0
        }
      }
    }
    
    meteringTimer?.invalidate()
    meteringTimer = Timer.scheduledTimer(withTimeInterval: 0.03, repeats: true) { [weak self] _ in
      guard let self = self, self.isInterruptionMonitoring else { return }
      let p = self.currentPower
      let clamped = max(-60.0, min(-10.0, p))
      let amp = (clamped + 60.0) / 50.0
      self.amplitudeUpdateHandler?(amp)
    }
    
    do {
      try audioEngine.start()
      AppDelegate.shared?.log("[VM] Interruption monitoring engine started successfully.")
    } catch {
      AppDelegate.shared?.log("[VM Err] Interruption monitoring engine start failed: \(error.localizedDescription)")
    }
  }

  func stopInterruptionMonitoring() {
    AppDelegate.shared?.log("[VM] stopInterruptionMonitoring")
    isInterruptionMonitoring = false
    consecutiveInterruptionFrames = 0
    monitoringStartTime = nil
    meteringTimer?.invalidate()
    meteringTimer = nil
    audioEngine.inputNode.removeTap(onBus: 0)
    audioEngine.stop()
  }
}
