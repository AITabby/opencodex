import Foundation

enum CodexTaskSource: String, Codable, Hashable, Sendable {
    case native
    case gateway
}

struct CodexTaskEvent: Codable, Hashable, Identifiable, Sendable {
    let version: Int
    let sequence: Int
    let occurredAt: Date
    let taskId: String
    let sessionId: String
    let state: CodexTaskPhase
    let source: CodexTaskSource
    let model: String?
    let petTheme: String?
    let contextUsedTokens: Int?
    let contextWindowTokens: Int?
    let quotaUsedPercent: Double?
    let quotaWindowMinutes: Int?
    let quotaResetsAt: Int?
    let title: String?
    let requiresAction: Bool
    let error: String?
    let elapsedMs: Int?

    var id: String { "\(taskId)-\(sequence)" }

    func withPetTheme(_ theme: String) -> CodexTaskEvent {
        CodexTaskEvent(
            version: version,
            sequence: sequence,
            occurredAt: occurredAt,
            taskId: taskId,
            sessionId: sessionId,
            state: state,
            source: source,
            model: model,
            petTheme: theme,
            contextUsedTokens: contextUsedTokens,
            contextWindowTokens: contextWindowTokens,
            quotaUsedPercent: quotaUsedPercent,
            quotaWindowMinutes: quotaWindowMinutes,
            quotaResetsAt: quotaResetsAt,
            title: title,
            requiresAction: requiresAction,
            error: error,
            elapsedMs: elapsedMs
        )
    }

    /// A lifecycle event can arrive before its first token sample. Preserve
    /// the latest known metrics for the same conversation, including when a
    /// new task id starts the next desktop turn in that session.
    func preservingMetrics(from previous: CodexTaskEvent?) -> CodexTaskEvent {
        guard let previous,
              previous.sessionId == sessionId else {
            return self
        }
        return CodexTaskEvent(
            version: version,
            sequence: sequence,
            occurredAt: occurredAt,
            taskId: taskId,
            sessionId: sessionId,
            state: state,
            source: source,
            model: model ?? previous.model,
            petTheme: petTheme ?? previous.petTheme,
            contextUsedTokens: contextUsedTokens ?? previous.contextUsedTokens,
            contextWindowTokens: contextWindowTokens ?? previous.contextWindowTokens,
            quotaUsedPercent: quotaUsedPercent ?? previous.quotaUsedPercent,
            quotaWindowMinutes: quotaWindowMinutes ?? previous.quotaWindowMinutes,
            quotaResetsAt: quotaResetsAt ?? previous.quotaResetsAt,
            title: title,
            requiresAction: requiresAction,
            error: error,
            // Context and quota belong to the conversation. Elapsed time
            // belongs to one task run and must restart with a new task id.
            elapsedMs: taskId == previous.taskId ? (elapsedMs ?? previous.elapsedMs) : elapsedMs
        )
    }
}

/// A visible conversation summary from the local gateway. Hidden reasoning and
/// tool payloads are deliberately excluded at the gateway boundary.
struct GatewaySession: Decodable, Equatable, Identifiable {
    let id: String
    let text: String
    let timestamp: Double?
    let model: String?
    let messageCount: Int?

    enum CodingKeys: String, CodingKey {
        case id
        case text
        case timestamp = "ts"
        case model
        case messageCount = "message_count"
    }
}

/// An explicit model identifier supplied by the authenticated gateway. The
/// phone sends this identifier with every turn instead of inheriting desktop's
/// transient model selection.
struct GatewayModelOption: Decodable, Equatable, Identifiable {
    let id: String
}

struct GatewayModelList: Decodable {
    let data: [GatewayModelOption]
}

struct GatewayChatMessage: Equatable, Identifiable {
    enum Role: String, Decodable {
        case user
        case assistant
    }

    let id: String
    let role: Role
    let text: String
}

extension JSONDecoder {
    static func codexTaskEventDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let standard = ISO8601DateFormatter()
            standard.formatOptions = [.withInternetDateTime]
            if let date = fractional.date(from: value) ?? standard.date(from: value) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid ISO-8601 date: \(value)"
            )
        }
        return decoder
    }
}
