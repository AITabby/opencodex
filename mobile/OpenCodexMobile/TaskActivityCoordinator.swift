@preconcurrency import ActivityKit
import Combine
import Foundation
import os

@MainActor
final class TaskActivityCoordinator: ObservableObject {
    private static let widgetLayoutVersion = 9
    private let logger = Logger(subsystem: "com.aitabby.opencodex.mobile", category: "LiveActivity")
    @Published private(set) var activeTask: CodexTaskEvent?
    @Published private(set) var lastError: String?
    var pushTokenHandler: ((String, String) async -> Void)?
    var notificationHandler: (@Sendable (CodexTaskEvent) async -> Void)?

    func dismissCompletedActivity(for sessionId: String) async {
        let matchingActivities = Activity<CodexTaskAttributes>.activities.filter {
            $0.attributes.sessionId == sessionId &&
            ($0.content.state.phase == .completed || $0.content.state.phase == .failed)
        }
        for activity in matchingActivities {
            await activity.end(activity.content, dismissalPolicy: .immediate)
        }
    }

    func dismissActivity(for sessionId: String) async {
        for activity in Activity<CodexTaskAttributes>.activities where activity.attributes.sessionId == sessionId {
            await activity.end(activity.content, dismissalPolicy: .immediate)
        }
    }

    func updatePetTheme(_ theme: String) async {
        for activity in Activity<CodexTaskAttributes>.activities {
            let state = activity.content.state
            let content = ActivityContent(
                state: CodexTaskAttributes.ContentState(
                    phase: state.phase,
                    title: state.title,
                    model: state.model,
                    petTheme: theme,
                    contextUsedTokens: state.contextUsedTokens,
                    contextWindowTokens: state.contextWindowTokens,
                    quotaUsedPercent: state.quotaUsedPercent,
                    quotaWindowMinutes: state.quotaWindowMinutes,
                    quotaResetsAt: state.quotaResetsAt,
                    requiresAction: state.requiresAction,
                    elapsedMs: state.elapsedMs,
                    error: state.error
                ),
                staleDate: activity.content.staleDate
            )
            await activity.update(content)
        }
    }

    func apply(_ event: CodexTaskEvent, pushType: PushType? = nil) async {
        activeTask = event
        lastError = nil
        await notificationHandler?(event)
        let contentState = CodexTaskAttributes.ContentState(
            phase: event.state,
            title: taskTitle(for: event),
            model: event.model ?? "同步中",
            petTheme: event.petTheme ?? "vortex",
            contextUsedTokens: event.contextUsedTokens,
            contextWindowTokens: event.contextWindowTokens,
            quotaUsedPercent: event.quotaUsedPercent,
            quotaWindowMinutes: event.quotaWindowMinutes,
            quotaResetsAt: event.quotaResetsAt,
            requiresAction: event.requiresAction,
            elapsedMs: event.elapsedMs,
            error: event.error
        )
        let isTerminal = event.state == .completed || event.state == .failed
        let content = ActivityContent(
            state: contentState,
            // A terminal task stays visible until the user dismisses it or a
            // new task for the same session replaces it. Running states still
            // get a stale-date safety net if the gateway disappears.
            staleDate: isTerminal ? nil : Date().addingTimeInterval(300)
        )

        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            lastError = "系统未允许 Live Activities"
            logger.error("Live Activity disabled: authorization is not enabled")
            return
        }

        // Widget extension views used by an already-running Live Activity are
        // cached by iOS. After a structural layout migration, end each old
        // activity once; the very next gateway event recreates it with the
        // current extension and the selected pet artwork.
        if event.state != .completed && event.state != .failed,
           UserDefaults.standard.integer(forKey: "widget-layout-version") < Self.widgetLayoutVersion {
            for activity in Activity<CodexTaskAttributes>.activities {
                await activity.end(activity.content, dismissalPolicy: .immediate)
            }
            UserDefaults.standard.set(Self.widgetLayoutVersion, forKey: "widget-layout-version")
        }

        let sessionActivities = Activity<CodexTaskAttributes>.activities.filter {
            $0.attributes.sessionId == event.sessionId
        }

        if event.state == .completed || event.state == .failed {
            // A terminal event must not present the expanded Dynamic Island.
            // The local notification above is the completion alert; this only
            // updates an already-visible activity, which stays compact until
            // the person explicitly long-presses it. If there is no activity
            // to update, do not create one solely for a completed task.
            for activity in sessionActivities {
                await activity.update(content)
            }
            return
        }

        if let activity = sessionActivities.first(where: {
            $0.attributes.taskId == event.taskId
        }) {
            await activity.update(content)
            return
        }

        for activity in sessionActivities {
            await activity.end(content, dismissalPolicy: .immediate)
        }

        await createActivity(for: event, content: content, pushType: pushType)
    }

    private func createActivity(
        for event: CodexTaskEvent,
        content: ActivityContent<CodexTaskAttributes.ContentState>,
        pushType: PushType?
    ) async {
        let attributes = CodexTaskAttributes(
            taskId: event.taskId,
            sessionId: event.sessionId,
            deepLink: "opencodex://session/\(event.sessionId)"
        )
        do {
            let activity = try Activity.request(attributes: attributes, content: content, pushType: pushType)
            observePushToken(for: activity)
        } catch {
            lastError = "创建 Live Activity 失败：\(error.localizedDescription)"
            logger.error("Live Activity request failed: \(String(reflecting: error), privacy: .public)")
        }
    }

    private func taskTitle(for event: CodexTaskEvent) -> String {
        let trimmed = event.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty, trimmed != "已完成" {
            return trimmed
        }
        switch event.state {
        case .queued: return "等待开始"
        case .running: return "正在处理任务"
        case .waiting: return "等待你的确认"
        case .completed: return "任务已完成"
        case .failed: return "任务未完成"
        }
    }

    private func observePushToken(for activity: Activity<CodexTaskAttributes>) {
        Task { [weak self] in
            for await tokenData in activity.pushTokenUpdates {
                let token = tokenData.map { String(format: "%02x", $0) }.joined()
                await self?.pushTokenHandler?(activity.attributes.taskId, token)
            }
        }
    }
}
