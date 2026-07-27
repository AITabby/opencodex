import ActivityKit
import SwiftUI
import WidgetKit

struct CodexTaskWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: CodexTaskAttributes.self) { context in
            Link(destination: URL(string: context.attributes.deepLink) ?? URL(string: "opencodex://")!) {
                HStack(spacing: 12) {
                    LockScreenPet(theme: context.state.petTheme, size: 52)
                        .frame(width: 52, height: 52)
                        .padding(.leading, 2)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(pet(for: context.state.petTheme).displayName)
                            .font(.headline)
                        HStack(spacing: 6) {
                            Text(context.state.model)
                            Text("·")
                            Text(label(for: context.state.phase))
                        }
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .foregroundStyle(.secondary)
                }
                .padding()
            }
            .activityBackgroundTint(.black)
            .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    IslandPetHero(
                        theme: context.state.petTheme,
                        phase: context.state.phase,
                        size: 78
                    )
                    // The pixel pet has more visual weight below its geometric
                    // center (feet and the companion orb), so compensate in
                    // the expanded island rather than shifting the whole row.
                    .offset(y: -10)
                    .frame(width: 88, height: 122)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    IslandDataColumn(state: context.state)
                        .frame(width: 104, alignment: .leading)
                }
                DynamicIslandExpandedRegion(.center) {
                    IslandCenteredStatus(state: context.state)
                        .frame(width: 84, height: 122)
                }
            } compactLeading: {
                IslandPetStatusMark(
                    theme: context.state.petTheme,
                    size: 26
                )
            } compactTrailing: {
                if !context.state.requiresAction && context.state.phase == .completed {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .black))
                        .foregroundStyle(.black)
                        .frame(width: 20, height: 20)
                        .background(Color.green, in: Circle())
                } else {
                    Text(compactStatus(for: context.state))
                        .font(compactStatusFont(for: context.state))
                        .foregroundStyle(compactStatusColor(for: context.state))
                }
            } minimal: {
                IslandPetStatusMark(
                    theme: context.state.petTheme,
                    size: 22
                )
            }
            .widgetURL(URL(string: context.attributes.deepLink))
            .keylineTint(color(for: context.state.phase))
        }
    }

    private func label(for phase: CodexTaskPhase) -> String {
        switch phase {
        case .queued: return "排队中"
        case .running: return "执行中"
        case .waiting: return "等待确认"
        case .completed: return "已完成"
        case .failed: return "失败"
        }
    }

    private func shortLabel(for phase: CodexTaskPhase) -> String {
        switch phase {
        case .queued: return "排队"
        case .running: return "运行"
        case .waiting: return "等待"
        case .completed: return "完成"
        case .failed: return "失败"
        }
    }

    private func icon(for phase: CodexTaskPhase) -> String {
        switch phase {
        case .queued: return "clock"
        case .running: return "bolt.horizontal.circle.fill"
        case .waiting: return "hand.raised.fill"
        case .completed: return "checkmark.circle.fill"
        case .failed: return "xmark.octagon.fill"
        }
    }

    private func color(for phase: CodexTaskPhase) -> Color {
        switch phase {
        case .queued: return .orange
        case .running: return .blue
        case .waiting: return .yellow
        case .completed: return .green
        case .failed: return .red
        }
    }

    private func pet(for theme: String) -> CodexPetTheme {
        CodexPetTheme(rawValue: theme) ?? .vortex
    }

    private func contextMetric(for state: CodexTaskAttributes.ContentState) -> String? {
        guard let used = state.contextUsedTokens,
              let window = state.contextWindowTokens,
              window > 0 else { return nil }
        return "\(compactTokens(used))/\(compactTokens(window))"
    }

    private func headline(for state: CodexTaskAttributes.ContentState) -> String {
        if state.requiresAction { return "需要你的确认" }
        let title = state.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return title.isEmpty ? label(for: state.phase) : title
    }

    private func quotaMetric(for state: CodexTaskAttributes.ContentState) -> String? {
        guard let used = state.quotaUsedPercent else { return nil }
        return "剩余 \(max(0, min(100, Int((100 - used).rounded()))))%"
    }

    private func compactStatus(for state: CodexTaskAttributes.ContentState) -> String {
        if state.requiresAction { return "!" }
        switch state.phase {
        case .queued, .running: return "···"
        case .waiting: return "!"
        case .completed: return "✓"
        case .failed: return "×"
        }
    }

    private func compactStatusColor(for state: CodexTaskAttributes.ContentState) -> Color {
        if state.requiresAction { return .yellow }
        return color(for: state.phase)
    }

    private func compactStatusFont(for state: CodexTaskAttributes.ContentState) -> Font {
        if !state.requiresAction && state.phase == .running {
            return .system(size: 19, weight: .black, design: .rounded)
        }
        return .caption2.monospacedDigit().weight(.bold)
    }

    private func compactTokens(_ value: Int) -> String {
        if value >= 1_000_000 { return "\(value / 1_000_000)M" }
        if value >= 1_000 { return "\(value / 1_000)K" }
        return "\(value)"
    }
}

private struct IslandPetHero: View {
    let theme: String
    let phase: CodexTaskPhase
    let size: CGFloat

    var body: some View {
        VStack(spacing: 2) {
            WidgetPixelPet(theme: theme, size: size)
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { _ in
                    Circle()
                        .fill(.cyan)
                        .frame(width: 4, height: 4)
                }
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(Color.white.opacity(0.10), in: Capsule())
        }
        .accessibilityLabel((CodexPetTheme(rawValue: theme) ?? .vortex).displayName)
    }
}

private struct IslandCenteredStatus: View {
    let state: CodexTaskAttributes.ContentState

    var body: some View {
        HStack(spacing: 6) {
            Text(title)
                .font(.system(size: 18, weight: .bold, design: .rounded))
                .lineLimit(1)
                .minimumScaleFactor(0.72)
            if isCompleted {
                Image(systemName: "checkmark")
                    .font(.system(size: 10, weight: .black))
                    .foregroundStyle(.black)
                    .frame(width: 22, height: 22)
                .background(Color.green, in: Circle())
            }
        }
        .offset(y: isCompleted ? -10 : -7)
        .multilineTextAlignment(.center)
    }

    private var title: String {
        if state.requiresAction { return "等待确认" }
        switch state.phase {
        case .queued: return "排队中"
        case .running: return "执行中"
        case .waiting: return "等待处理"
        case .completed: return "已完成"
        case .failed: return "任务失败"
        }
    }

    private var isCompleted: Bool {
        !state.requiresAction && state.phase == .completed
    }
}

private struct IslandDataColumn: View {
    let state: CodexTaskAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            metric(label: "上下文", value: contextValue)
            Divider().overlay(Color.white.opacity(0.14))
            metric(label: "模型", value: state.model)
            Divider().overlay(Color.white.opacity(0.14))
            metric(label: "额度", value: quotaValue)
        }
        .padding(.leading, 12)
        .overlay(alignment: .leading) {
            Rectangle().fill(Color.white.opacity(0.20)).frame(width: 1)
        }
    }

    private func metric(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.system(size: 10, weight: .medium, design: .rounded))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 13, weight: .bold, design: .rounded))
                .lineLimit(1)
                .minimumScaleFactor(0.62)
        }
    }

    private var contextValue: String {
        guard let used = state.contextUsedTokens,
              let window = state.contextWindowTokens,
              window > 0 else { return "--" }
        return "\(compactTokens(used))/\(compactTokens(window))"
    }

    private var quotaValue: String {
        guard let used = state.quotaUsedPercent else { return "--" }
        return "剩余 \(max(0, min(100, Int((100 - used).rounded()))))%"
    }

    private func compactTokens(_ value: Int) -> String {
        if value >= 1_000_000 { return "\(value / 1_000_000)M" }
        if value >= 1_000 { return "\(value / 1_000)K" }
        return "\(value)"
    }
}

private struct IslandMetric: View {
    let icon: String
    let label: String
    let value: String

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.caption)
            VStack(alignment: .leading, spacing: 1) {
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(value)
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(Color.white.opacity(0.10), in: Capsule())
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct IslandPhaseBadge: View {
    let phase: CodexTaskPhase
    let isActionRequired: Bool

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(.black)
            .frame(width: 24, height: 24)
            .background(tint, in: Circle())
    }

    private var symbol: String {
        if isActionRequired { return "hand.raised.fill" }
        switch phase {
        case .queued: return "clock.fill"
        case .running: return "ellipsis"
        case .waiting: return "hand.raised.fill"
        case .completed: return "checkmark"
        case .failed: return "exclamationmark"
        }
    }

    private var tint: Color {
        if isActionRequired { return .yellow }
        switch phase {
        case .queued: return .orange
        case .running: return .cyan
        case .waiting: return .yellow
        case .completed: return .green
        case .failed: return .red
        }
    }
}

private struct IslandPetStatusMark: View {
    let theme: String
    let size: CGFloat

    var body: some View {
        // Completion and progress are communicated by the trailing status.
        // Keep the compact leading area purely as the pet, directly on black.
        WidgetPixelPet(theme: theme, size: size + 2)
            .frame(width: size + 4, height: size + 4)
            .offset(x: -8, y: -5)
            .accessibilityLabel((CodexPetTheme(rawValue: theme) ?? .vortex).displayName)
    }
}

private struct LockScreenPet: View {
    let theme: String
    let size: CGFloat

    var body: some View {
        let pet = CodexPetTheme(rawValue: theme) ?? .vortex
        // Lock-screen Live Activities must show the selected pet as artwork,
        // rather than as a status badge. Keeping it directly on the black
        // surface avoids the unwanted blue circular ring and gives the sprite
        // the same visual baseline as the text block.
        WidgetPixelPet(theme: theme, size: size)
            .offset(y: 1)
            .accessibilityLabel(pet.displayName)
    }
}

/// Live Activities on this iOS 27 runtime can retain a stale bitmap placeholder
/// across extension updates. Keeping the two starter pets as native SwiftUI
/// pixels makes their rendering independent from asset-bundle lookup and cache.
private struct WidgetPixelPet: View {
    let theme: String
    let size: CGFloat

    var body: some View {
        GeometryReader { proxy in
            let unit = min(proxy.size.width, proxy.size.height) / 18
            ZStack(alignment: .topLeading) {
                ForEach(pixels) { pixel in
                    Rectangle()
                        .fill(pixel.color)
                        .frame(width: pixel.width * unit, height: pixel.height * unit)
                        .offset(x: pixel.x * unit, y: pixel.y * unit)
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var pixels: [Pixel] {
        switch CodexPetTheme(rawValue: theme) ?? .vortex {
        case .vortex:
            return cyberCat
        case .stella:
            return starSprite
        }
    }

    // Dark cyber cat: ears, white mask, cyan eyes/chest and a right-side orb.
    private var cyberCat: [Pixel] {
        let ink = Color(red: 0.055, green: 0.06, blue: 0.14)
        let navy = Color(red: 0.12, green: 0.14, blue: 0.28)
        let edge = Color(red: 0.27, green: 0.28, blue: 0.50)
        let cyan = Color(red: 0.18, green: 0.92, blue: 1)
        let glow = Color(red: 0.58, green: 0.98, blue: 1)
        let white = Color(red: 0.95, green: 0.97, blue: 1)
        return [
            p(4, 1, 2, 1, edge), p(11, 1, 2, 1, edge),
            p(3, 2, 3, 3, ink), p(11, 2, 3, 3, ink),
            p(4, 2, 1, 2, cyan), p(12, 2, 1, 2, cyan),
            p(5, 4, 7, 1, navy), p(3, 5, 11, 5, ink),
            p(4, 6, 9, 4, white), p(5, 7, 2, 2, cyan), p(10, 7, 2, 2, cyan),
            p(7, 8, 1, 1, ink), p(9, 8, 1, 1, ink), p(8, 9, 1, 1, navy),
            p(4, 10, 9, 4, navy), p(5, 12, 2, 1, cyan), p(9, 12, 2, 1, cyan),
            p(7, 11, 1, 1, cyan), p(8, 12, 1, 1, cyan),
            p(2, 12, 3, 2, ink), p(1, 13, 2, 2, edge), p(2, 14, 2, 1, cyan),
            p(5, 14, 2, 2, ink), p(10, 14, 2, 2, ink),
            p(14, 6, 2, 2, glow), p(15, 5, 1, 1, cyan), p(16, 8, 1, 1, cyan), p(15, 9, 1, 1, glow)
        ]
    }

    // White, star-crowned robot: deliberately a very different silhouette.
    private var starSprite: [Pixel] {
        let white = Color(red: 0.97, green: 0.95, blue: 1)
        let shade = Color(red: 0.76, green: 0.70, blue: 0.88)
        let navy = Color(red: 0.08, green: 0.10, blue: 0.25)
        let pink = Color(red: 1, green: 0.40, blue: 0.72)
        let gold = Color(red: 1, green: 0.72, blue: 0.25)
        return [
            p(8, 0, 1, 1, gold), p(7, 1, 3, 1, gold), p(8, 2, 1, 2, pink),
            p(4, 3, 9, 1, white), p(3, 4, 11, 8, white), p(2, 6, 1, 3, shade), p(14, 6, 1, 3, shade),
            p(4, 5, 1, 2, pink), p(12, 5, 1, 2, pink),
            p(5, 6, 7, 4, navy), p(6, 7, 2, 2, pink), p(10, 7, 2, 2, pink), p(8, 9, 1, 1, pink),
            p(5, 12, 7, 2, white), p(7, 12, 3, 1, gold),
            p(4, 14, 2, 1, shade), p(11, 14, 2, 1, shade),
            p(15, 2, 1, 1, pink), p(16, 3, 1, 1, gold), p(15, 4, 1, 1, pink)
        ]
    }

    private func p(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat = 1, _ height: CGFloat = 1, _ color: Color) -> Pixel {
        Pixel(id: "\(x)-\(y)-\(width)-\(height)", x: x, y: y, width: width, height: height, color: color)
    }

    private struct Pixel: Identifiable {
        let id: String
        let x: CGFloat
        let y: CGFloat
        let width: CGFloat
        let height: CGFloat
        let color: Color
    }
}

@main
struct CodexTaskWidgetBundle: WidgetBundle {
    var body: some Widget {
        CodexTaskWidget()
    }
}
