import Foundation
import UserNotifications

@MainActor
final class NotificationManager: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    private let defaults = UserDefaults.standard
    private let notifiedTerminalTaskIDsKey = "notified-terminal-task-ids"
    private var pendingTerminalTaskIDs = Set<String>()

    override init() {
        super.init()
        // Without a delegate, iOS suppresses an immediate local notification
        // while this app is in the foreground. That made a completed task
        // appear silent during normal simulator/phone testing.
        center.delegate = self
    }

    func requestAuthorization() async {
        do {
            _ = try await center.requestAuthorization(options: [.alert, .sound, .badge])
        } catch {
            // Live Activities remain available when notification permission is denied.
        }
    }

    func handle(_ event: CodexTaskEvent) async {
        // A task may publish several fast status updates (and occasionally
        // repeat its terminal snapshot). Only its *first* terminal state is
        // allowed to create a notification or play a sound. Running, waiting,
        // metric refreshes and duplicate completed/failed events stay silent.
        guard event.state == .completed || event.state == .failed else { return }
        guard !hasNotifiedTerminalState(for: event.taskId),
              !pendingTerminalTaskIDs.contains(event.taskId) else { return }
        pendingTerminalTaskIDs.insert(event.taskId)

        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
            pendingTerminalTaskIDs.remove(event.taskId)
            return
        }

        let content = UNMutableNotificationContent()
        switch event.state {
        case .completed:
            content.title = "Codex 任务完成"
            content.body = "\(event.model ?? "Codex") 已完成当前任务。"
        case .failed:
            content.title = "Codex 任务失败"
            content.body = event.error.map { "\(event.model ?? "Codex")：\($0)" } ?? "\(event.model ?? "Codex") 未能完成当前任务。"
        default:
            return
        }
        content.sound = .default
        content.userInfo = [
            "taskId": event.taskId,
            "sessionId": event.sessionId,
            "state": event.state.rawValue
        ]

        do {
            let request = UNNotificationRequest(
                identifier: "codex-task-\(event.taskId)",
                content: content,
                trigger: nil
            )
            try await center.add(request)
            recordTerminalNotification(for: event.taskId)
        } catch {
            // A temporary notification service failure must not affect task tracking.
        }
        pendingTerminalTaskIDs.remove(event.taskId)
    }

    private func hasNotifiedTerminalState(for taskID: String) -> Bool {
        Set(defaults.stringArray(forKey: notifiedTerminalTaskIDsKey) ?? []).contains(taskID)
    }

    private func recordTerminalNotification(for taskID: String) {
        var taskIDs = defaults.stringArray(forKey: notifiedTerminalTaskIDsKey) ?? []
        taskIDs.append(taskID)
        // Keep a small durable history so old task IDs cannot make this store
        // grow forever, while app restarts still cannot replay a completion.
        defaults.set(Array(taskIDs.suffix(200)), forKey: notifiedTerminalTaskIDsKey)
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // `handle(_:)` only creates a notification for a task's first
        // completed/failed transition, so presenting it here is still exactly
        // one audible completion cue—not a sound for intermediate updates.
        completionHandler([.banner, .sound])
    }
}
