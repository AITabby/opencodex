import Foundation
import SwiftUI
import Combine
import UIKit

@MainActor
final class MobileModel: ObservableObject {
    @Published var gatewayURL: String
    @Published var adminToken: String
    @Published var relayURL: String
    @Published var relayChannel: String
    @Published var relayToken: String
    @Published var relayKey: String
    @Published var selectedPetTheme: String
    @Published private(set) var selectedSessionID: String?
    @Published private(set) var activeTask: CodexTaskEvent?
    @Published private(set) var activeTasks: [CodexTaskEvent] = []
    @Published private(set) var sessions: [GatewaySession] = []
    @Published private(set) var availableModels: [GatewayModelOption] = []
    @Published private(set) var selectedModelID: String
    @Published private(set) var isLoadingModels = false
    @Published private(set) var chatMessages: [GatewayChatMessage] = []
    @Published private(set) var sessionSyncError: String?
    @Published private(set) var isSessionSyncing = false
    @Published private(set) var hasCompletedInitialSessionSync = false
    @Published private(set) var isSelectedSessionLoading = false
    @Published private(set) var sessionRevision = 0
    @Published private(set) var isSendingMessage = false
    @Published private(set) var sendMessageError: String?
    /// A launch begins in a blank composer. Existing gateway sessions are only
    /// opened after the user picks one (or follows a Live Activity deep link).
    @Published private(set) var isComposingNewConversation = true

    let coordinator = TaskActivityCoordinator()
    private let notifications = NotificationManager()
    private var client: TaskEventClient?
    private var relayClient: TaskRelayClient?
    private var backgroundGraceTask: UIBackgroundTaskIdentifier = .invalid
    private var initialSessionLoadTask: Task<Void, Never>?
    private var sessionSyncKey: String?
    private var selectedSessionLoadTask: Task<Void, Never>?
    /// Messages accepted by the app-server but not yet visible in its rollout
    /// projection.  Keep these separate from server messages so a fast first
    /// detail refresh cannot make an accepted phone message appear to vanish.
    private var pendingMobileMessages: [GatewayChatMessage] = []

    init() {
        gatewayURL = KeychainStore.string(for: "gateway-url") ?? "http://127.0.0.1:8765/"
        adminToken = KeychainStore.string(for: "gateway-admin-token") ?? ""
        relayURL = KeychainStore.string(for: "relay-url") ?? "wss://relay.example.com/v1/relay"
        relayChannel = KeychainStore.string(for: "relay-channel") ?? ""
        relayToken = KeychainStore.string(for: "relay-token") ?? ""
        relayKey = KeychainStore.string(for: "relay-key") ?? ""
        selectedPetTheme = CodexPetTheme(rawValue: KeychainStore.string(for: "pet-theme") ?? "")?.rawValue ?? CodexPetTheme.vortex.rawValue
        selectedModelID = KeychainStore.string(for: "mobile-selected-model") ?? ""
        selectedSessionID = nil
        activeTask = nil
        coordinator.notificationHandler = { [weak notifications] event in
            await notifications?.handle(event)
        }
        if !relayURL.isEmpty,
           !relayChannel.isEmpty,
           !relayToken.isEmpty,
           !relayKey.isEmpty {
            Task { @MainActor [weak self] in
                self?.connectRelay()
            }
        } else if !adminToken.isEmpty {
            // A saved same-Wi-Fi gateway is a user choice, not a transient
            // screen action. Restore it after launch so the companion does
            // not require a manual reconnect every time it opens.
            Task { @MainActor [weak self] in
                self?.connect()
            }
        }
    }

    func prepareNotifications() async {
        await notifications.requestAuthorization()
    }

    @Published private(set) var connected = false
    @Published private(set) var connectionError: String?
    @Published private(set) var usingRelay = false
    @Published private(set) var isConnecting = false
    private var clientObservation: AnyCancellable?
    private var relayObservation: AnyCancellable?

    func connect() {
        let normalizedGatewayURL = gatewayURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedAdminToken = adminToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let baseURL = URL(string: normalizedGatewayURL) else {
            isConnecting = false
            connectionError = "网关地址格式不正确"
            return
        }
        guard !normalizedAdminToken.isEmpty else {
            isConnecting = false
            connectionError = "请先填写管理令牌"
            return
        }
        gatewayURL = normalizedGatewayURL
        adminToken = normalizedAdminToken
        usingRelay = false
        persistConnectionSecrets()
        relayClient?.stop()
        relayClient = nil
        relayObservation?.cancel()
        relayObservation = nil
        coordinator.pushTokenHandler = nil
        client?.stop()
        connected = false
        connectionError = nil
        isConnecting = true
        let newClient = TaskEventClient(
            onEvent: { [weak self] event in
                await self?.applyTaskEvent(event)
            },
            onNoActiveTasks: { [weak self] in
                guard let self else { return }
                self.endBackgroundGracePeriod()
                self.activeTasks = []
                // An empty snapshot is not a terminal event. It can occur
                // while the gateway is restarting and rebuilding its native
                // rollout observer, so never turn an in-flight task into
                // "completed" without an explicit terminal lifecycle event.
            }
        )
        client = newClient
        clientObservation = Publishers.CombineLatest3(newClient.$connected, newClient.$lastError, newClient.$reconnecting)
            .receive(on: RunLoop.main)
            .sink { [weak self] connected, error, reconnecting in
                guard let self else { return }
                self.connected = connected
                self.connectionError = error
                // A failed initial request may keep retrying in the transport
                // layer, but Settings must leave "connecting" so the person
                // can read the error, edit the address, and retry immediately.
                self.isConnecting = !connected && error == nil && reconnecting
                if connected {
                    self.startSessionSynchronization(baseURL: baseURL, adminToken: normalizedAdminToken)
                } else {
                    // Keep the last successful chat snapshot visible while
                    // the event client automatically reconnects.
                    self.stopSessionSynchronization(preservingVisibleState: reconnecting)
                }
            }
        newClient.start(baseURL: baseURL, adminToken: normalizedAdminToken)
        objectWillChange.send()
    }

    func connectRelay() {
        let normalizedRelayURL = relayURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedChannel = relayChannel.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedToken = relayToken.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedKey = relayKey.trimmingCharacters(in: .whitespacesAndNewlines)

        guard let url = URL(string: normalizedRelayURL), url.scheme?.lowercased() == "wss" else {
            isConnecting = false
            connectionError = "中继地址必须使用 wss://"
            return
        }
        guard !normalizedChannel.isEmpty, !normalizedToken.isEmpty else {
            isConnecting = false
            connectionError = "请填写配对通道和配对令牌"
            return
        }
        guard let key = Data(base64URLEncoded: normalizedKey), key.count == 32 else {
            isConnecting = false
            connectionError = "事件密钥必须是 32 字节 Base64URL"
            return
        }

        relayClient?.stop()
        relayObservation?.cancel()
        relayURL = normalizedRelayURL
        relayChannel = normalizedChannel
        relayToken = normalizedToken
        relayKey = normalizedKey
        usingRelay = true
        client?.stop()
        client = nil
        clientObservation?.cancel()
        clientObservation = nil
        stopSessionSynchronization()
        connected = false
        connectionError = nil
        isConnecting = true
        persistConnectionSecrets()
        let newClient = TaskRelayClient { [weak self] event in
            await self?.applyTaskEvent(event)
        }
        coordinator.pushTokenHandler = { [weak newClient] taskId, token in
            newClient?.registerActivityToken(taskId: taskId, token: token)
        }
        relayClient = newClient
        relayObservation = Publishers.CombineLatest3(newClient.$connected, newClient.$lastError, newClient.$reconnecting)
            .receive(on: RunLoop.main)
            .sink { [weak self] connected, error, reconnecting in
                guard let self else { return }
                self.connected = connected
                self.connectionError = error
                self.isConnecting = !connected && error == nil && reconnecting
                if connected {
                    self.startRelaySessionSynchronization()
                } else {
                    self.stopSessionSynchronization(preservingVisibleState: reconnecting)
                }
            }
        newClient.start(url: url, channel: relayChannel, token: relayToken, key: key)
        objectWillChange.send()
    }

    /// Stops an in-flight reconnect loop without discarding the address or
    /// credentials currently being edited in Settings.  This is important for
    /// a physical-device LAN test: a typo must be recoverable immediately,
    /// rather than leaving the form permanently in a disabled "connecting"
    /// state while the stream client backs off.
    func cancelConnectionAttempt() {
        client?.stop()
        client = nil
        clientObservation?.cancel()
        clientObservation = nil
        relayClient?.stop()
        relayClient = nil
        relayObservation?.cancel()
        relayObservation = nil
        coordinator.pushTokenHandler = nil
        connected = false
        isConnecting = false
        connectionError = nil
        stopSessionSynchronization(preservingVisibleState: true)
        objectWillChange.send()
    }

    func clearPairing() {
        relayClient?.stop()
        relayClient = nil
        relayObservation?.cancel()
        relayObservation = nil
        coordinator.pushTokenHandler = nil
        connected = false
        connectionError = nil
        usingRelay = false
        isConnecting = false
        stopSessionSynchronization()
        relayChannel = ""
        relayToken = ""
        relayKey = ""
        KeychainStore.remove("relay-channel")
        KeychainStore.remove("relay-token")
        KeychainStore.remove("relay-key")
        objectWillChange.send()
    }

    func selectPetTheme(_ theme: CodexPetTheme) {
        selectedPetTheme = theme.rawValue
        KeychainStore.set(selectedPetTheme, for: "pet-theme")
        activeTasks = activeTasks.map { $0.withPetTheme(theme.rawValue) }
        activeTask = activeTask?.withPetTheme(theme.rawValue)
        Task { @MainActor [weak self] in
            guard let self else { return }
            // Existing Live Activities do not receive a new gateway event
            // merely because the user chose another companion. Update their
            // content state directly so both expanded and compact islands use
            // the selected pet immediately.
            await self.coordinator.updatePetTheme(theme.rawValue)
        }
    }

    func selectModel(_ modelID: String) {
        guard availableModels.contains(where: { $0.id == modelID }) else { return }
        selectedModelID = modelID
        KeychainStore.set(modelID, for: "mobile-selected-model")
    }

    var selectedModelLabel: String {
        if !selectedModelID.isEmpty { return selectedModelID }
        return isLoadingModels ? "正在读取模型…" : "选择模型"
    }

    func handleDeepLink(_ url: URL) {
        guard url.scheme == "opencodex", url.host == "session" else { return }
        let session = url.pathComponents.drop { $0 == "/" }.first
        guard let session, !session.isEmpty else { return }
        selectSession(session)
        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.coordinator.dismissCompletedActivity(for: session)
        }
    }

    var selectedSession: GatewaySession? {
        guard let selectedSessionID else { return nil }
        return sessions.first { $0.id == selectedSessionID }
    }

    /// The most recently updated running task is the direct card target.
    var primaryTask: CodexTaskEvent? {
        activeTasks.first ?? activeTask
    }

    /// A conversation renders only its own task. The homepage may use
    /// `primaryTask` as a global desktop activity summary, but never leak a
    /// different conversation's state into an open chat window.
    func task(forSessionID sessionID: String?) -> CodexTaskEvent? {
        guard let sessionID, !sessionID.isEmpty else { return nil }
        return activeTasks.first(where: { $0.sessionId == sessionID }) ??
            (activeTask?.sessionId == sessionID ? activeTask : nil)
    }

    func openTaskSession(_ task: CodexTaskEvent) {
        selectSession(task.sessionId)
    }

    func selectSession(_ id: String) {
        guard !id.isEmpty else { return }
        guard selectedSessionID != id || isComposingNewConversation else { return }
        isComposingNewConversation = false
        selectedSessionID = id
        // Do not leave the previous conversation visible while the new detail
        // request is in flight. The response below is also bound to this ID.
        chatMessages = []
        pendingMobileMessages = []
        sessionSyncError = nil
        isSelectedSessionLoading = true
        sessionRevision &+= 1
        selectedSessionLoadTask?.cancel()
        selectedSessionLoadTask = Task { @MainActor [weak self] in
            await self?.refreshSelectedSession()
        }
    }

    func beginNewConversation() {
        isComposingNewConversation = true
        selectedSessionID = nil
        chatMessages = []
        pendingMobileMessages = []
        sessionSyncError = nil
        sendMessageError = nil
        isSelectedSessionLoading = false
        sessionRevision &+= 1
        selectedSessionLoadTask?.cancel()
        selectedSessionLoadTask = nil
    }

    /// Sends through the local gateway's official Codex app-server bridge.
    /// The message is not inserted locally: the normal session synchronizer
    /// renders it only after Codex persists the real conversation event.
    func sendMessage(_ text: String) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isSendingMessage else { return false }
        let modelID = selectedModelID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !modelID.isEmpty else {
            sendMessageError = "请先在输入框上方选择一个模型。"
            return false
        }
        guard connected else {
            sendMessageError = "网关未连接，暂时无法发送消息。"
            return false
        }
        let configuration = sessionConfiguration
        guard usingRelay || configuration != nil else {
            sendMessageError = "网关未连接，暂时无法发送消息。"
            return false
        }

        isSendingMessage = true
        sendMessageError = nil
        defer { isSendingMessage = false }

        do {
            let result: GatewayMobileMessageResponse
            if usingRelay {
                result = try await postRelayMessage(
                    text: trimmed,
                    sessionID: selectedSessionID,
                    modelID: modelID
                )
            } else if let configuration {
                result = try await postMobileMessage(
                    text: trimmed,
                    sessionID: selectedSessionID,
                    modelID: modelID,
                    baseURL: configuration.baseURL,
                    adminToken: configuration.adminToken
                )
            } else {
                throw RelayRequestError.disconnected
            }
            guard !Task.isCancelled else { return false }
            isComposingNewConversation = false
            selectedSessionID = result.sessionId
            let pendingMessage = GatewayChatMessage(
                id: "pending-mobile-\(UUID().uuidString)",
                role: .user,
                text: trimmed
            )
            pendingMobileMessages.append(pendingMessage)
            if !chatMessages.contains(where: { $0.id == pendingMessage.id }) {
                chatMessages.append(pendingMessage)
            }
            isSelectedSessionLoading = true
            sessionRevision &+= 1
            // Delivery is complete as soon as the app-server accepts the
            // turn.  Do the rollout/list reconciliation in the background so
            // the composer stops spinning immediately instead of waiting for
            // Codex's eventual session-file projection.
            Task { @MainActor [weak self] in
                guard let self else { return }
                if self.usingRelay {
                    await self.refreshRelaySessionIndex()
                    await self.refreshSentConversationOverRelay()
                } else if let configuration {
                    await self.refreshSessionIndex(baseURL: configuration.baseURL, adminToken: configuration.adminToken)
                    await self.refreshSentConversation(baseURL: configuration.baseURL, adminToken: configuration.adminToken)
                }
            }
            return true
        } catch is CancellationError {
            return false
        } catch {
            sendMessageError = gatewayErrorDescription(error, operation: "消息发送")
            return false
        }
    }

    func refreshSessionsNow() {
        // This is an explicit list refresh (initial connection or a view
        // reload), never a background polling loop.
        if usingRelay {
            Task { @MainActor [weak self] in
                await self?.refreshRelaySessionIndex()
            }
            return
        }
        guard let configuration = sessionConfiguration else { return }
        Task { @MainActor [weak self] in
            await self?.refreshSessionIndex(
                baseURL: configuration.baseURL,
                adminToken: configuration.adminToken
            )
        }
    }

    private func persistConnectionSecrets() {
        KeychainStore.set(gatewayURL, for: "gateway-url")
        KeychainStore.set(adminToken, for: "gateway-admin-token")
        KeychainStore.set(relayURL, for: "relay-url")
        KeychainStore.set(relayChannel, for: "relay-channel")
        KeychainStore.set(relayToken, for: "relay-token")
        KeychainStore.set(relayKey, for: "relay-key")
    }

    private func applyTaskEvent(_ event: CodexTaskEvent) async {
        if event.source == .native,
           event.model?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
               .replacingOccurrences(of: "_", with: "-") == "codex-auto-review" {
            activeTasks.removeAll { $0.taskId == event.taskId }
            if activeTask?.taskId == event.taskId {
                activeTask = activeTasks.first
            }
            await coordinator.dismissActivity(for: event.sessionId)
            return
        }
        let previous = activeTasks.first(where: { $0.taskId == event.taskId }) ??
            activeTasks.first(where: { $0.sessionId == event.sessionId }) ??
            (activeTask?.sessionId == event.sessionId ? activeTask : nil)
        let themedEvent = event
            .withPetTheme(selectedPetTheme)
            .preservingMetrics(from: previous)
        updateActiveTasks(with: themedEvent)
        if selectedSessionID == nil, !isComposingNewConversation {
            selectedSessionID = themedEvent.sessionId
        }
        switch themedEvent.state {
        case .queued, .running, .waiting:
            beginBackgroundGracePeriod()
        case .completed, .failed:
            endBackgroundGracePeriod()
        }
        // Foreground relay events create a local Live Activity. A token-based
        // Activity request requires the APNs entitlement and a configured
        // provider; this development build intentionally has neither yet.
        // Passing `.token` here makes ActivityKit reject the activity before
        // it can appear on the Dynamic Island.
        await coordinator.apply(themedEvent, pushType: nil)

        // A task event from another desktop conversation should only change
        // the global card. Refresh chat content solely when the user is
        // already looking at that exact session.
        guard selectedSessionID == themedEvent.sessionId else { return }
        selectedSessionLoadTask?.cancel()
        selectedSessionLoadTask = Task { @MainActor [weak self] in
            // Coalesce bursty token/task updates into one latest snapshot.
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            await self?.refreshSelectedSession()
        }
    }

    private func updateActiveTasks(with event: CodexTaskEvent) {
        var nextTasks = activeTasks.filter { $0.taskId != event.taskId }
        switch event.state {
        case .queued, .running, .waiting:
            nextTasks.append(event)
            nextTasks.sort {
                if $0.occurredAt == $1.occurredAt { return $0.sequence > $1.sequence }
                return $0.occurredAt > $1.occurredAt
            }
            activeTasks = nextTasks
            activeTask = nextTasks.first
        case .completed, .failed:
            activeTasks = nextTasks
            // Keep a terminal task visible only when it is the last task;
            // otherwise the card should continue to point at live work.
            activeTask = nextTasks.first ?? event
        }
    }

    private var sessionConfiguration: (baseURL: URL, adminToken: String)? {
        guard !usingRelay,
              connected,
              let baseURL = URL(string: gatewayURL),
              !adminToken.isEmpty else {
            return nil
        }
        return (baseURL, adminToken)
    }

    private func startSessionSynchronization(baseURL: URL, adminToken: String) {
        let key = "\(baseURL.absoluteString)|\(adminToken)"
        // Connection-state publishers can emit several `connected` values.
        // One successful initial index load is enough for a given gateway;
        // subsequent work is scoped to the selected session.
        guard sessionSyncKey != key || !hasCompletedInitialSessionSync else { return }
        initialSessionLoadTask?.cancel()
        sessionSyncKey = key
        isSessionSyncing = true
        initialSessionLoadTask = Task { @MainActor [weak self] in
            await self?.refreshAvailableModels(baseURL: baseURL, adminToken: adminToken)
            guard !Task.isCancelled else { return }
            await self?.refreshSessionIndex(baseURL: baseURL, adminToken: adminToken)
            guard !Task.isCancelled else { return }
            self?.initialSessionLoadTask = nil
        }
    }

    private func startRelaySessionSynchronization() {
        let key = "relay|\(relayURL)|\(relayChannel)"
        guard sessionSyncKey != key || !hasCompletedInitialSessionSync else { return }
        initialSessionLoadTask?.cancel()
        sessionSyncKey = key
        isSessionSyncing = true
        initialSessionLoadTask = Task { @MainActor [weak self] in
            await self?.refreshAvailableModelsOverRelay()
            guard !Task.isCancelled else { return }
            await self?.refreshRelaySessionIndex()
            guard !Task.isCancelled else { return }
            self?.initialSessionLoadTask = nil
        }
    }

    private func stopSessionSynchronization(preservingVisibleState: Bool = false) {
        initialSessionLoadTask?.cancel()
        initialSessionLoadTask = nil
        sessionSyncKey = nil
        selectedSessionLoadTask?.cancel()
        selectedSessionLoadTask = nil
        sessionSyncError = nil
        isSessionSyncing = false
        if !preservingVisibleState {
            hasCompletedInitialSessionSync = false
            isSelectedSessionLoading = false
        }
    }

    private func refreshSessionIndex(baseURL: URL, adminToken: String) async {
        isSessionSyncing = true
        do {
            let fetchedSessions = try await fetchSessions(baseURL: baseURL, adminToken: adminToken)
            guard !Task.isCancelled else { return }
            sessions = fetchedSessions
            hasCompletedInitialSessionSync = true

            if selectedSessionID == nil, !isComposingNewConversation {
                selectedSessionID = activeTask.map(\.sessionId) ?? fetchedSessions.first?.id
                isSelectedSessionLoading = selectedSessionID != nil
            }
            sessionSyncError = nil
            isSessionSyncing = false
        } catch is CancellationError {
            return
        } catch {
            // The first list request races the just-established SSE transport
            // on some launches. It is a normal loading phase, not a failure
            // visible to the person opening the app. Surface errors only
            // after at least one authoritative session index was available.
            sessionSyncError = hasCompletedInitialSessionSync
                ? gatewayErrorDescription(error, operation: "会话同步")
                : nil
            isSessionSyncing = false
        }
    }

    private func refreshAvailableModels(baseURL: URL, adminToken: String) async {
        isLoadingModels = true
        defer { isLoadingModels = false }
        do {
            let fetchedModels = try await fetchAvailableModels(baseURL: baseURL, adminToken: adminToken)
            guard !Task.isCancelled else { return }
            availableModels = fetchedModels
            if !fetchedModels.contains(where: { $0.id == selectedModelID }) {
                selectedModelID = fetchedModels.first?.id ?? ""
                if !selectedModelID.isEmpty {
                    KeychainStore.set(selectedModelID, for: "mobile-selected-model")
                }
            }
        } catch is CancellationError {
            return
        } catch {
            // A list failure must not prevent session synchronization. The
            // composer remains explicit about its missing model instead of
            // silently falling back to whatever desktop last selected.
            availableModels = []
        }
    }

    private func refreshAvailableModelsOverRelay() async {
        isLoadingModels = true
        defer { isLoadingModels = false }
        do {
            guard let relayClient else { throw RelayRequestError.disconnected }
            let data = try await relayClient.request(method: "models.list")
            let fetchedModels = try JSONDecoder().decode(GatewayModelList.self, from: data).data
                .filter { !$0.id.isEmpty && $0.id != "opencodex/cu" }
            guard !Task.isCancelled else { return }
            availableModels = fetchedModels
            if !fetchedModels.contains(where: { $0.id == selectedModelID }) {
                selectedModelID = fetchedModels.first?.id ?? ""
                if !selectedModelID.isEmpty {
                    KeychainStore.set(selectedModelID, for: "mobile-selected-model")
                }
            }
        } catch is CancellationError {
            return
        } catch {
            availableModels = []
        }
    }

    private func refreshRelaySessionIndex() async {
        isSessionSyncing = true
        do {
            guard let relayClient else { throw RelayRequestError.disconnected }
            let data = try await relayClient.request(method: "sessions.list")
            let fetchedSessions = try JSONDecoder().decode([GatewaySession].self, from: data)
            guard !Task.isCancelled else { return }
            sessions = fetchedSessions
            hasCompletedInitialSessionSync = true
            if selectedSessionID == nil, !isComposingNewConversation {
                selectedSessionID = activeTask.map(\.sessionId) ?? fetchedSessions.first?.id
                isSelectedSessionLoading = selectedSessionID != nil
            }
            sessionSyncError = nil
            isSessionSyncing = false
        } catch is CancellationError {
            return
        } catch {
            sessionSyncError = hasCompletedInitialSessionSync
                ? gatewayErrorDescription(error, operation: "会话同步")
                : "中继已连接，但会话列表读取失败，请稍后重试。"
            isSessionSyncing = false
        }
    }

    private func refreshSelectedSession() async {
        if usingRelay {
            await refreshSelectedSessionOverRelay()
            return
        }
        guard let configuration = sessionConfiguration else { return }
        await refreshSelectedSession(baseURL: configuration.baseURL, adminToken: configuration.adminToken)
    }

    private func refreshSelectedSessionOverRelay() async {
        guard let requestedSessionID = selectedSessionID else {
            isSelectedSessionLoading = false
            if !chatMessages.isEmpty {
                chatMessages = []
                sessionRevision &+= 1
            }
            return
        }
        do {
            guard let relayClient else { throw RelayRequestError.disconnected }
            let data = try await relayClient.request(method: "sessions.detail", payload: ["id": requestedSessionID])
            let detail = try JSONDecoder().decode(GatewaySessionDetail.self, from: data)
            guard !Task.isCancelled, selectedSessionID == requestedSessionID else { return }
            let visibleMessages = mergeServerMessages(detail.messages.enumerated().map { index, message in
                GatewayChatMessage(
                    id: "\(index)-\(message.role.rawValue)-\(message.text)",
                    role: message.role,
                    text: message.text
                )
            })
            if chatMessages != visibleMessages {
                chatMessages = visibleMessages
                sessionRevision &+= 1
            }
            isSelectedSessionLoading = false
        } catch is CancellationError {
            return
        } catch {
            sessionSyncError = gatewayErrorDescription(error, operation: "会话内容读取")
            isSelectedSessionLoading = false
        }
    }

    private func refreshSelectedSession(baseURL: URL, adminToken: String) async {
        guard let requestedSessionID = selectedSessionID else {
            isSelectedSessionLoading = false
            if !chatMessages.isEmpty {
                chatMessages = []
                sessionRevision &+= 1
            }
            return
        }
        do {
            let messages = try await fetchSessionMessages(
                sessionID: requestedSessionID,
                baseURL: baseURL,
                adminToken: adminToken
            )
            // A previous polling request may complete after the user chose a
            // different row. Never let that stale payload overwrite the new
            // conversation.
            guard !Task.isCancelled, selectedSessionID == requestedSessionID else { return }
            let visibleMessages = mergeServerMessages(messages)
            if chatMessages != visibleMessages {
                chatMessages = visibleMessages
                sessionRevision &+= 1
            }
            isSelectedSessionLoading = false
        } catch is CancellationError {
            return
        } catch {
            sessionSyncError = gatewayErrorDescription(error, operation: "会话内容读取")
            isSelectedSessionLoading = false
        }
    }

    /// The app-server returns once it has accepted `turn/start`; its rollout
    /// file can appear a moment later.  Retry a small, bounded number of times
    /// while preserving the local pending bubble rather than polling forever.
    private func refreshSentConversation(baseURL: URL, adminToken: String) async {
        for delay in [UInt64.zero, 450_000_000, 1_200_000_000] {
            if delay > 0 {
                try? await Task.sleep(nanoseconds: delay)
            }
            guard !Task.isCancelled else { return }
            await refreshSelectedSession(baseURL: baseURL, adminToken: adminToken)
            if pendingMobileMessages.isEmpty { return }
        }
    }

    private func refreshSentConversationOverRelay() async {
        for delay in [UInt64.zero, 450_000_000, 1_200_000_000] {
            if delay > 0 {
                try? await Task.sleep(nanoseconds: delay)
            }
            guard !Task.isCancelled else { return }
            await refreshSelectedSessionOverRelay()
            if pendingMobileMessages.isEmpty { return }
        }
    }

    private func mergeServerMessages(_ serverMessages: [GatewayChatMessage]) -> [GatewayChatMessage] {
        pendingMobileMessages.removeAll { pending in
            serverMessages.contains { message in
                message.role == pending.role && message.text == pending.text
            }
        }
        return serverMessages + pendingMobileMessages
    }

    nonisolated private func fetchSessions(baseURL: URL, adminToken: String) async throws -> [GatewaySession] {
        var requestURL = baseURL
        requestURL.appendPathComponent("api/sessions")
        var request = URLRequest(url: requestURL)
        request.setValue("Bearer \(adminToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard statusCode == 200 else { throw GatewaySessionError.http(statusCode) }
        return try JSONDecoder().decode([GatewaySession].self, from: data)
    }

    nonisolated private func fetchAvailableModels(baseURL: URL, adminToken: String) async throws -> [GatewayModelOption] {
        var requestURL = baseURL
        requestURL.appendPathComponent("v1/models")
        var request = URLRequest(url: requestURL)
        request.setValue("Bearer \(adminToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard statusCode == 200 else { throw GatewaySessionError.http(statusCode) }
        return try JSONDecoder().decode(GatewayModelList.self, from: data).data
            .filter { !$0.id.isEmpty && $0.id != "opencodex/cu" }
    }

    nonisolated private func fetchSessionMessages(sessionID: String, baseURL: URL, adminToken: String) async throws -> [GatewayChatMessage] {
        var requestURL = baseURL
        requestURL.appendPathComponent("api/sessions/detail")
        var request = URLRequest(url: requestURL)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: ["id": sessionID])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(adminToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard statusCode == 200 else { throw GatewaySessionError.http(statusCode) }
        let payload = try JSONDecoder().decode(GatewaySessionDetail.self, from: data)
        return payload.messages.enumerated().map { index, message in
            GatewayChatMessage(
                id: "\(index)-\(message.role.rawValue)-\(message.text)",
                role: message.role,
                text: message.text
            )
        }
    }

    nonisolated private func postMobileMessage(
        text: String,
        sessionID: String?,
        modelID: String,
        baseURL: URL,
        adminToken: String
    ) async throws -> GatewayMobileMessageResponse {
        var requestURL = baseURL
        requestURL.appendPathComponent("api/mobile/messages")
        var body: [String: Any] = ["text": text, "model": modelID]
        if let sessionID, !sessionID.isEmpty {
            body["sessionId"] = sessionID
        }
        var request = URLRequest(url: requestURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 70
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(adminToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard statusCode == 202 else {
            if let failure = try? JSONDecoder().decode(GatewayMobileMessageFailure.self, from: data),
               !failure.error.isEmpty {
                throw GatewayMobileMessageError.server(failure.error)
            }
            throw GatewaySessionError.http(statusCode)
        }
        return try JSONDecoder().decode(GatewayMobileMessageResponse.self, from: data)
    }

    private func postRelayMessage(
        text: String,
        sessionID: String?,
        modelID: String
    ) async throws -> GatewayMobileMessageResponse {
        guard let relayClient else { throw RelayRequestError.disconnected }
        var payload = ["text": text, "model": modelID]
        if let sessionID, !sessionID.isEmpty {
            payload["sessionId"] = sessionID
        }
        let data = try await relayClient.request(method: "messages.send", payload: payload)
        if let failure = try? JSONDecoder().decode(GatewayMobileMessageFailure.self, from: data),
           !failure.error.isEmpty {
            throw GatewayMobileMessageError.server(failure.error)
        }
        return try JSONDecoder().decode(GatewayMobileMessageResponse.self, from: data)
    }

    // iOS may suspend a normal SSE connection as soon as the app is
    // backgrounded. A bounded background task gives local testing a chance
    // to receive a short task's terminal event without requiring APNs.
    // This is intentionally only a grace period; APNs remains necessary for
    // reliable background updates and push-to-start activities.
    private func beginBackgroundGracePeriod() {
        guard backgroundGraceTask == .invalid else { return }
        backgroundGraceTask = UIApplication.shared.beginBackgroundTask(
            withName: "OpenCodexTaskEventGrace"
        ) { [weak self] in
            Task { @MainActor [weak self] in
                self?.endBackgroundGracePeriod()
            }
        }
    }

    private func endBackgroundGracePeriod() {
        let task = backgroundGraceTask
        guard task != .invalid else { return }
        backgroundGraceTask = .invalid
        UIApplication.shared.endBackgroundTask(task)
    }
}

private struct GatewaySessionDetail: Decodable {
    struct Message: Decodable {
        let role: GatewayChatMessage.Role
        let text: String
    }

    let messages: [Message]
}

private struct GatewayMobileMessageResponse: Decodable {
    let sessionId: String
    let turnId: String
    let delivery: String
}

private struct GatewayMobileMessageFailure: Decodable {
    let error: String
}

private enum GatewayMobileMessageError: LocalizedError {
    case server(String)

    var errorDescription: String? {
        switch self {
        case let .server(message): message
        }
    }
}

private enum GatewaySessionError: LocalizedError {
    case http(Int)

    var errorDescription: String? {
        switch self {
        case let .http(statusCode): "网关返回 HTTP \(statusCode)"
        }
    }
}

private extension Data {
    init?(base64URLEncoded value: String) {
        var normalized = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        normalized += String(repeating: "=", count: (4 - normalized.count % 4) % 4)
        self.init(base64Encoded: normalized)
    }
}
