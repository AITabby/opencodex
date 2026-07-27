import ActivityKit
import Foundation

public enum CodexTaskPhase: String, Codable, Hashable, Sendable {
    case queued
    case running
    case waiting
    case completed
    case failed
}

public enum CodexPetTheme: String, Codable, CaseIterable, Hashable, Sendable {
    case vortex
    case stella

    public var displayName: String {
        switch self {
        case .vortex: return "Vortex"
        case .stella: return "Stella"
        }
    }

    public var assetName: String {
        switch self {
        case .vortex: return "cyber-cat"
        case .stella: return "star-sprite"
        }
    }
}

public struct CodexTaskAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable, Sendable {
        public let phase: CodexTaskPhase
        /// Optional so activities created by earlier builds (before task
        /// titles were added) can still be rendered after an app update.
        public let title: String?
        public let model: String
        public let petTheme: String
        public let contextUsedTokens: Int?
        public let contextWindowTokens: Int?
        public let quotaUsedPercent: Double?
        public let quotaWindowMinutes: Int?
        public let quotaResetsAt: Int?
        public let requiresAction: Bool
        public let elapsedMs: Int?
        public let error: String?

        public init(
            phase: CodexTaskPhase,
            title: String?,
            model: String,
            petTheme: String,
            contextUsedTokens: Int?,
            contextWindowTokens: Int?,
            quotaUsedPercent: Double?,
            quotaWindowMinutes: Int?,
            quotaResetsAt: Int?,
            requiresAction: Bool,
            elapsedMs: Int?,
            error: String?
        ) {
            self.phase = phase
            self.title = title
            self.model = model
            self.petTheme = petTheme
            self.contextUsedTokens = contextUsedTokens
            self.contextWindowTokens = contextWindowTokens
            self.quotaUsedPercent = quotaUsedPercent
            self.quotaWindowMinutes = quotaWindowMinutes
            self.quotaResetsAt = quotaResetsAt
            self.requiresAction = requiresAction
            self.elapsedMs = elapsedMs
            self.error = error
        }
    }

    public let taskId: String
    public let sessionId: String
    public let deepLink: String

    public init(taskId: String, sessionId: String, deepLink: String) {
        self.taskId = taskId
        self.sessionId = sessionId
        self.deepLink = deepLink
    }
}
