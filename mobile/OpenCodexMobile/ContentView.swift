import SwiftUI
import UIKit

/// The app shell is intentionally quiet: conversation is the product, while
/// the pixel pet is a live expression of the same task stream.
struct ContentView: View {
    @EnvironmentObject private var model: MobileModel
    @State private var selectedTab: AppTab = .chat
    @State private var sidebarPresented = false
    @State private var chatPageRevision = 0

    var body: some View {
        ZStack(alignment: .leading) {
            AppBackdrop()
                .ignoresSafeArea()

            ZStack {
                currentPage
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .animation(AppMotion.page, value: pageIdentity)

            if sidebarPresented {
                AppSidebar(selection: $selectedTab, isPresented: $sidebarPresented)
                    .transition(.move(edge: .leading).combined(with: .opacity))
                    .zIndex(1)
            }
        }
        .preferredColorScheme(.dark)
        .tint(.white)
        .onChange(of: model.selectedSessionID) { _ in
            // A session selection is a page navigation too—even if the chat
            // tab is already visible. Replacing the chat page identity gives
            // every recent-conversation tap the same gentle transition as a
            // top-level sidebar page.
            withAnimation(AppMotion.page) {
                selectedTab = .chat
                chatPageRevision &+= 1
            }
        }
    }

    @ViewBuilder
    private var currentPage: some View {
        switch selectedTab {
        case .chat:
            ChatPage(showSidebar: $sidebarPresented)
                .id("chat-\(chatPageRevision)")
                .transition(AppMotion.pageTransition)
        case .pet:
            PetPage(showSidebar: $sidebarPresented)
                .id(AppTab.pet.rawValue)
                .transition(AppMotion.pageTransition)
        case .settings:
            SettingsPage(showSidebar: $sidebarPresented)
                .id(AppTab.settings.rawValue)
                .transition(AppMotion.pageTransition)
        }
    }

    private var pageIdentity: String {
        selectedTab == .chat ? "chat-\(chatPageRevision)" : selectedTab.rawValue
    }
}

private enum AppTab: String, CaseIterable, Identifiable {
    case chat
    case pet
    case settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .chat: "聊天"
        case .pet: "宠物"
        case .settings: "设置"
        }
    }

    var symbol: String {
        switch self {
        case .chat: "message"
        case .pet: "sparkles"
        case .settings: "gearshape"
        }
    }
}

private enum AppColors {
    static let canvas = Color(white: 0.055)
    static let surface = Color(white: 0.105)
    static let elevatedSurface = Color(white: 0.145)
    static let border = Color.white.opacity(0.16)
    static let secondaryText = Color.white.opacity(0.58)
    static let tertiaryText = Color.white.opacity(0.38)
}

private enum AppMotion {
    /// A restrained, iOS 16-compatible drawer motion used consistently by
    /// every sidebar entry and dismissal path.
    static let sidebar = Animation.spring(response: 0.34, dampingFraction: 0.88, blendDuration: 0.12)
    /// One restrained motion system for main-page navigation. A page fades
    /// while travelling only a few points, so switching a chat never feels
    /// like an abrupt redraw or a full-screen swipe.
    static let page = Animation.easeInOut(duration: 0.24)
    static var pageTransition: AnyTransition {
        .asymmetric(
            insertion: .opacity.combined(with: .offset(x: 14, y: 0)),
            removal: .opacity.combined(with: .offset(x: -10, y: 0))
        )
    }
}

private struct AppBackdrop: View {
    var body: some View {
        LinearGradient(
            colors: [
                Color(red: 0.105, green: 0.105, blue: 0.115),
                Color(red: 0.048, green: 0.048, blue: 0.055),
                Color(red: 0.026, green: 0.026, blue: 0.030)
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }
}

// MARK: - Chat

private struct ChatPage: View {
    @EnvironmentObject private var model: MobileModel
    @Binding var showSidebar: Bool
    @State private var draft = ""
    @State private var showSendError = false
    @FocusState private var composerFocused: Bool

    private var taskForVisibleContext: CodexTaskEvent? {
        if model.isComposingNewConversation {
            return model.primaryTask
        }
        return model.task(forSessionID: model.selectedSessionID)
    }

    private var activeTaskMessage: String? {
        guard let task = taskForVisibleContext else { return nil }
        return taskSummary(task)
    }

    var body: some View {
        VStack(spacing: 0) {
            ChatHeader(showSidebar: $showSidebar)

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 20) {
                        if model.chatMessages.isEmpty {
                            ConversationWelcome()
                        }

                        ForEach(model.chatMessages) { message in
                            ChatBubble(message: message)
                                .id(message.id)
                        }

                        if let activeTaskMessage, let task = taskForVisibleContext {
                            LiveTaskBubble(
                                text: activeTaskMessage,
                                task: task
                            ) {
                                model.openTaskSession(task)
                            }
                            .id("live-task-\(task.id)")
                        }

                        Color.clear.frame(height: 12).id("chat-bottom")
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 20)
                    .padding(.bottom, 20)
                }
                .scrollIndicators(.hidden)
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: model.sessionRevision) { _ in
                    // The list's final message is inserted in the same update
                    // cycle as `sessionRevision`; defer one layout pass so the
                    // marker exists before asking the reader to target it.
                    DispatchQueue.main.async {
                        proxy.scrollTo("chat-bottom", anchor: .bottom)
                    }
                }
                .onAppear {
                    DispatchQueue.main.async {
                        proxy.scrollTo("chat-bottom", anchor: .bottom)
                    }
                }
            }

        }
        // Keep the composer outside the scroll content and above the keyboard.
        // This also gives its TextField an unambiguous hit-test region after
        // the chat list has grown or is being refreshed.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ChatComposer(
                draft: $draft,
                focused: $composerFocused,
                isSending: model.isSendingMessage,
                send: sendDraft
            )
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 10)
            .background(AppColors.canvas.opacity(0.94))
        }
        .alert("发送失败", isPresented: $showSendError) {
            Button("知道了", role: .cancel) { }
        } message: {
            Text(model.sendMessageError ?? "消息未能发送到 Codex。")
        }
    }

    private func sendDraft() {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        // Submission is accepted asynchronously. Clear the composer at the
        // tap boundary so a successful send never leaves stale text behind;
        // restore it only if the gateway rejects the request.
        draft = ""
        composerFocused = false
        Task {
            let didSend = await model.sendMessage(trimmed)
            if !didSend {
                if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    draft = trimmed
                }
                showSendError = true
            }
        }
    }

    private func taskSummary(_ task: CodexTaskEvent) -> String {
        let phase = phaseTitle(task.state)
        let title = task.title?.isEmpty == false ? task.title! : nil
        return title == nil || title == phase ? phase : "\(phase) · \(title!)"
    }
}

private struct ChatHeader: View {
    @EnvironmentObject private var model: MobileModel
    @Binding var showSidebar: Bool

    var body: some View {
        HStack(spacing: 13) {
            Button {
                withAnimation(AppMotion.sidebar) {
                    showSidebar = true
                }
            } label: {
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 42, height: 42)
                    .background(AppColors.surface, in: Circle())
            }
            .accessibilityLabel("打开会话列表")

            VStack(alignment: .leading, spacing: 2) {
                Text("OpenCodex")
                    .font(.system(size: 18, weight: .semibold, design: .rounded))
                Text(model.selectedSession?.text ?? "新建对话")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(AppColors.secondaryText)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Spacer(minLength: 0)

            Button {
                model.beginNewConversation()
            } label: {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 42, height: 42)
                    .background(AppColors.surface, in: Circle())
            }
            .accessibilityLabel("新建对话")
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
        .background(AppColors.canvas.opacity(0.92))
    }
}

private struct ConversationWelcome: View {
    @EnvironmentObject private var model: MobileModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(headline)
                .font(.system(size: 28, weight: .semibold))
                .tracking(-0.5)

            HStack(spacing: 8) {
                Circle()
                    .fill(status.color)
                    .frame(width: 7, height: 7)
                Text(status.text)
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle(hasError ? .red : AppColors.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 8)
    }

    private var headline: String {
        if model.isSelectedSessionLoading { return "正在打开会话…" }
        if model.isComposingNewConversation { return "有什么可以帮你？" }
        return "此会话暂无可显示消息"
    }

    private var status: (text: String, color: Color) {
        if model.isConnecting {
            return (model.usingRelay ? "正在恢复任务中继…" : "正在恢复网关连接…", .blue)
        }
        if model.usingRelay {
            if let error = model.connectionError {
                return (error, .red)
            }
            return model.connected
                ? ("中继已连接 · 正在接收任务事件", .green)
                : ("中继未连接", AppColors.tertiaryText)
        }
        guard model.connected else {
            if let error = model.connectionError {
                return (error, .red)
            }
            return ("网关未连接 · 配置后可同步会话", AppColors.tertiaryText)
        }
        if model.isSessionSyncing || !model.hasCompletedInitialSessionSync {
            return ("网关已连接 · 正在同步会话…", .blue)
        }
        if model.isSelectedSessionLoading {
            return ("网关已连接 · 正在加载当前会话…", .blue)
        }
        if let error = model.sessionSyncError {
            return (error, .red)
        }
        if model.isComposingNewConversation {
            return ("网关已连接 · 实时同步已就绪 · 已同步 \(model.sessions.count) 个会话", .green)
        }
        return ("网关已连接 · 会话已同步", .green)
    }

    private var hasError: Bool {
        model.connectionError != nil || (model.hasCompletedInitialSessionSync && model.sessionSyncError != nil)
    }
}

private struct ChatComposer: View {
    @EnvironmentObject private var model: MobileModel
    @Binding var draft: String
    var focused: FocusState<Bool>.Binding
    let isSending: Bool
    let send: () -> Void

    var body: some View {
        let hasDraft = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let canSend = hasDraft && !isSending && !model.selectedModelID.isEmpty

        VStack(alignment: .leading, spacing: 3) {
            Menu {
                if model.availableModels.isEmpty {
                    Text(model.isLoadingModels ? "正在读取可用模型…" : "暂无可用模型")
                } else {
                    ForEach(model.availableModels) { option in
                        Button {
                            model.selectModel(option.id)
                        } label: {
                            if option.id == model.selectedModelID {
                                Label(option.id, systemImage: "checkmark")
                            } else {
                                Text(option.id)
                            }
                        }
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "cpu")
                        .font(.system(size: 11, weight: .semibold))
                    Text("模型 · \(model.selectedModelLabel)")
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .lineLimit(1)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 9, weight: .bold))
                }
                .foregroundStyle(model.selectedModelID.isEmpty ? AppColors.secondaryText : .white)
                .padding(.horizontal, 10)
                .frame(height: 28)
                .background(Color.white.opacity(0.08), in: Capsule())
            }
            .disabled(model.availableModels.isEmpty)
            .padding(.leading, 9)

            HStack(alignment: .center, spacing: 10) {
                Image(systemName: "plus")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(AppColors.secondaryText)
                    .frame(width: 34, height: 34)

                TextField("给 OpenCodex 发送消息", text: $draft, axis: .vertical)
                    .focused(focused)
                    .lineLimit(1...5)
                    .font(.system(size: 16, weight: .regular))
                    .foregroundStyle(.white)
                    .submitLabel(.send)
                    .onSubmit(send)
                    .simultaneousGesture(TapGesture().onEnded {
                        focused.wrappedValue = true
                    })
                    .accessibilityIdentifier("chat-composer-input")
                    .frame(minHeight: 38, alignment: .center)

                Button(action: send) {
                    Group {
                        if isSending {
                            ProgressView()
                                .tint(.black)
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 16, weight: .bold))
                        }
                    }
                    .frame(width: 36, height: 36)
                    .foregroundStyle(canSend ? .black : AppColors.secondaryText)
                    .background(canSend ? Color.white : AppColors.elevatedSurface, in: Circle())
                }
                .disabled(!canSend)
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 8)
        .padding(.vertical, 7)
        .frame(minHeight: 82)
        .background(AppColors.elevatedSurface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(AppColors.border, lineWidth: 1))
        .shadow(color: .black.opacity(0.22), radius: 10, y: 3)
    }
}

private struct ChatBubble: View {
    let message: GatewayChatMessage

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 56) }

            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 7) {
                Text(message.text)
                    .font(.system(size: 16, weight: .regular))
                    .foregroundStyle(.white)
                    .lineSpacing(4)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 13)
            .background(message.role == .user ? Color.white.opacity(0.16) : AppColors.surface.opacity(0.94), in: RoundedRectangle(cornerRadius: 20, style: .continuous))

            if message.role != .user { Spacer(minLength: 36) }
        }
    }
}

private struct LiveTaskBubble: View {
    let text: String
    let task: CodexTaskEvent?
    let openTask: () -> Void

    var body: some View {
        Button(action: openTask) {
            HStack(spacing: 11) {
                PixelPetGlyph(theme: task?.petTheme.flatMap(CodexPetTheme.init(rawValue:)) ?? .vortex, size: 30)
                VStack(alignment: .leading, spacing: 4) {
                    Text(text)
                        .font(.system(size: 14, weight: .semibold))
                    if let task {
                        Text(taskDetail(task))
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(AppColors.secondaryText)
                    }
                }
                Spacer()
                TaskStatusMark(phase: task?.state)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(AppColors.secondaryText)
            }
        }
        .buttonStyle(.plain)
        .padding(14)
        .background(AppColors.elevatedSurface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(AppColors.border, lineWidth: 1))
        .accessibilityHint("打开当前任务会话")
    }
}

private struct TaskStatusMark: View {
    let phase: CodexTaskPhase?
    @State private var completionPresented = false

    var body: some View {
        Group {
            switch phase {
            case .completed:
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(.green)
                    .scaleEffect(completionPresented ? 1 : 0.55)
                    .opacity(completionPresented ? 1 : 0)
                    .onAppear { revealCompletion() }
                    .onChange(of: phase) { _ in revealCompletion() }
            case .failed:
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.system(size: 23, weight: .semibold))
                    .foregroundStyle(.red)
            case .waiting:
                Image(systemName: "hand.raised.fill")
                    .font(.system(size: 21, weight: .semibold))
                    .foregroundStyle(.orange)
            case .queued, .running, .none:
                ActivityDots()
            }
        }
        .frame(width: 30, height: 30)
        .accessibilityLabel(statusLabel)
    }

    private var statusLabel: String {
        switch phase {
        case .completed: "任务已完成"
        case .failed: "任务失败"
        case .waiting: "等待处理"
        case .queued: "任务排队中"
        case .running: "任务执行中"
        case .none: "等待任务"
        }
    }

    private func revealCompletion() {
        guard phase == .completed else { return }
        completionPresented = false
        DispatchQueue.main.async {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.62)) {
                completionPresented = true
            }
        }
    }
}

private struct ActivityDots: View {
    @State private var animating = false

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(.white)
                    .frame(width: 5, height: 5)
                    .opacity(animating ? 0.42 + Double(index) * 0.22 : 0.28)
                    .scaleEffect(animating ? 0.82 + CGFloat(index) * 0.12 : 0.72)
                    .animation(
                        .easeInOut(duration: 0.55)
                            .repeatForever(autoreverses: true)
                            .delay(Double(index) * 0.12),
                        value: animating
                    )
            }
        }
        .onAppear { animating = true }
    }
}

// MARK: - Pixel pet

private struct PetPage: View {
    @EnvironmentObject private var model: MobileModel
    @Binding var showSidebar: Bool
    @State private var isExpanded = false

    private var selectedTheme: CodexPetTheme {
        CodexPetTheme(rawValue: model.selectedPetTheme) ?? .vortex
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                HStack(spacing: 14) {
                    Button {
                        withAnimation(AppMotion.sidebar) {
                            showSidebar = true
                        }
                    } label: {
                        Image(systemName: "line.3.horizontal")
                            .font(.system(size: 17, weight: .semibold))
                            .frame(width: 42, height: 42)
                            .background(AppColors.surface, in: Circle())
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("宠物")
                            .font(.system(size: 31, weight: .bold, design: .rounded))
                        Text("PIXEL COMPANION")
                            .font(.system(size: 11, weight: .bold))
                            .tracking(1.5)
                            .foregroundStyle(AppColors.secondaryText)
                    }
                    Spacer()
                    TaskPhasePill(phase: model.activeTask?.state)
                }

                VStack(spacing: 20) {
                    PixelPetScene(theme: selectedTheme, phase: model.activeTask?.state)
                        .frame(height: 290)

                    VStack(spacing: 8) {
                        Text(selectedTheme.displayName)
                            .font(.system(size: 23, weight: .bold))
                        Text(petStatusText)
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(AppColors.secondaryText)
                    }

                    HStack(spacing: 10) {
                        ForEach(CodexPetTheme.allCases, id: \.self) { theme in
                            Button {
                                withAnimation(.spring(response: 0.35, dampingFraction: 0.75)) {
                                    model.selectPetTheme(theme)
                                }
                            } label: {
                                PixelPetGlyph(theme: theme, size: 38)
                                    .frame(width: 52, height: 52)
                                    .background(selectedTheme == theme ? Color.white.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                                    .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(selectedTheme == theme ? Color.white.opacity(0.45) : AppColors.border, lineWidth: 1))
                            }
                            .accessibilityLabel("选择 \(theme.displayName)")
                        }
                    }
                }
                .padding(18)
                .background(AppColors.surface, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).stroke(AppColors.border, lineWidth: 1))

                Button {
                    isExpanded.toggle()
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "circle.grid.cross")
                        VStack(alignment: .leading, spacing: 3) {
                            Text("灵动岛预览")
                                .font(.system(size: 16, weight: .semibold))
                            Text(isExpanded ? "展开信息：任务、上下文与额度" : "收起时显示像素宠物和任务状态")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(AppColors.secondaryText)
                        }
                        Spacer()
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .foregroundStyle(AppColors.secondaryText)
                    }
                    .padding(16)
                    .background(AppColors.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                }

                if isExpanded {
                    TaskDetailPanel(task: model.activeTask)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 18)
            .padding(.bottom, 104)
        }
        .scrollIndicators(.hidden)
    }

    private var petStatusText: String {
        guard let task = model.activeTask else { return "空闲中，等待下一次任务" }
        return "\(phaseTitle(task.state)) · \(task.title ?? "任务同步中")"
    }
}

private struct PixelPetScene: View {
    let theme: CodexPetTheme
    let phase: CodexTaskPhase?
    @State private var breathes = false

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(Color.black.opacity(0.36))

            ForEach(0..<10, id: \.self) { index in
                Circle()
                    .fill(Color.white.opacity(index.isMultiple(of: 3) ? 0.12 : 0.05))
                    .frame(width: CGFloat(44 + index * 13), height: CGFloat(44 + index * 13))
                    .scaleEffect(breathes ? 1.02 + Double(index) * 0.004 : 0.94)
            }

            PixelPetGlyph(theme: theme, size: 188)
                .scaleEffect(breathes ? 1.04 : 0.94)
                .rotationEffect(.degrees(phase == .running && breathes ? 3 : -3))
                .shadow(color: .white.opacity(0.22), radius: 24)

            VStack {
                HStack {
                    Text(phase == .running ? "LIVE" : "IDLE")
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .tracking(1.2)
                    Spacer()
                    Text("01")
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                }
                Spacer()
                HStack(spacing: 4) {
                    ForEach(0..<16, id: \.self) { index in
                        Rectangle()
                            .fill(Color.white.opacity(index < 7 ? 0.9 : 0.16))
                            .frame(width: 7, height: 3)
                    }
                    Spacer()
                }
            }
            .foregroundStyle(AppColors.secondaryText)
            .padding(15)
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1.55).repeatForever(autoreverses: true)) {
                breathes = true
            }
        }
    }
}

private struct PixelPetGlyph: View {
    let theme: CodexPetTheme
    let size: CGFloat

    var body: some View {
        Group {
            Image(theme.assetName)
                .resizable()
                .interpolation(.none)
                .scaledToFit()
        }
        .frame(width: size, height: size)
    }
}

private struct TaskPhasePill: View {
    let phase: CodexTaskPhase?

    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(phase == .running ? Color.white : Color.white.opacity(0.36)).frame(width: 7, height: 7)
            Text(phase.map(phaseTitle) ?? "空闲")
                .font(.system(size: 13, weight: .semibold))
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 8)
        .background(AppColors.surface, in: Capsule())
        .overlay(Capsule().stroke(AppColors.border, lineWidth: 1))
    }
}

private struct TaskDetailPanel: View {
    let task: CodexTaskEvent?

    var body: some View {
        HStack(spacing: 0) {
            DetailMetric(title: "状态", value: task.map { phaseTitle($0.state) } ?? "空闲")
            DetailMetric(title: "上下文", value: contextLabel(task))
            DetailMetric(title: "额度", value: quotaLabel(task))
        }
        .padding(.vertical, 15)
        .background(AppColors.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(AppColors.border, lineWidth: 1))
    }
}

private struct DetailMetric: View {
    let title: String
    let value: String

    var body: some View {
        VStack(spacing: 7) {
            Text(title).font(.system(size: 11, weight: .medium)).foregroundStyle(AppColors.secondaryText)
            Text(value).font(.system(size: 13, weight: .bold, design: .monospaced)).lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Settings

private struct SettingsPage: View {
    @EnvironmentObject private var model: MobileModel
    @Binding var showSidebar: Bool
    @AppStorage("pet-sound-enabled") private var petSoundEnabled = true
    @AppStorage("pet-notification-enabled") private var petNotificationEnabled = true

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 12) {
                        Image(systemName: model.connected ? "checkmark.circle.fill" : (model.isConnecting ? "arrow.triangle.2.circlepath" : "circle.dotted"))
                            .font(.system(size: 27))
                            .foregroundStyle(model.connected ? .white : AppColors.secondaryText)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(model.isConnecting ? (model.usingRelay ? "正在连接任务中继" : "正在连接开发网关") : (model.connected ? (model.usingRelay ? "任务中继已连接" : "开发网关已连接") : "尚未连接"))
                                .font(.system(size: 16, weight: .semibold))
                            Text(model.isConnecting ? "正在验证地址与管理令牌…" : (model.connected ? "任务状态将实时同步到聊天和宠物" : "真机使用加密中继；模拟器可直连本机网关"))
                                .font(.system(size: 12))
                                .foregroundStyle(AppColors.secondaryText)
                            if let error = model.connectionError {
                                Text(error)
                                    .font(.system(size: 12))
                                    .foregroundStyle(.red)
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }

                Section("任务中继配对") {
                    TextField("中继地址（wss://）", text: $model.relayURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    TextField("配对通道", text: $model.relayChannel)
                        .textInputAutocapitalization(.never)
                    SecureField("配对令牌", text: $model.relayToken)
                    SecureField("事件密钥（32 字节 Base64URL）", text: $model.relayKey)
                        .textInputAutocapitalization(.never)
                    Button(model.isConnecting ? "连接中…" : (model.connected ? "重新连接" : "连接中继")) {
                        model.connectRelay()
                    }
                    .disabled(model.isConnecting || model.relayURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.relayChannel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.relayToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.relayKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("清除本机配对", role: .destructive) {
                        model.clearPairing()
                    }
                }

                Section("同一 Wi-Fi 测试") {
                    Text("模拟器使用 http://127.0.0.1:8765/。真机请填写 Mac 的局域网地址（例如 http://192.168.x.x:8765/）；仅允许已验证的会话、任务与发送消息接口。")
                        .font(.footnote)
                        .foregroundStyle(AppColors.secondaryText)
                    Text("局域网测试不会在启动时自动重连；请确认地址与令牌后手动连接。")
                        .font(.footnote)
                        .foregroundStyle(AppColors.tertiaryText)
                    TextField("Mac 网关地址", text: $model.gatewayURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    SecureField("测试访问令牌", text: $model.adminToken)
                    if model.isConnecting {
                        Button("取消当前连接", role: .cancel) {
                            model.cancelConnectionAttempt()
                        }
                    }
                    Button(model.isConnecting ? "用当前地址重新连接" : "连接 Mac 网关") {
                        model.connect()
                    }
                    .disabled(model.gatewayURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.adminToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                Section("宠物与提醒") {
                    Toggle("任务完成音效", isOn: $petSoundEnabled)
                    Toggle("灵动岛与通知提醒", isOn: $petNotificationEnabled)
                    NavigationLink {
                        PetPreferencesView()
                    } label: {
                        Label("宠物外观", systemImage: "sparkles")
                    }
                }

                Section("数据") {
                    SettingsRow(icon: "bubble.left.and.bubble.right", title: "会话同步", value: "网关")
                    SettingsRow(icon: "lock", title: "凭据存储", value: "此设备钥匙串")
                }

            }
            .scrollContentBackground(.hidden)
            .background(AppColors.canvas)
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        withAnimation(AppMotion.sidebar) {
                            showSidebar = true
                        }
                    } label: {
                        Image(systemName: "line.3.horizontal")
                    }
                    .accessibilityLabel("打开侧边栏")
                }
            }
        }
        .tint(.white)
    }
}

private struct SettingsRow: View {
    let icon: String
    let title: String
    let value: String

    var body: some View {
        HStack {
            Label(title, systemImage: icon)
            Spacer()
            Text(value).foregroundStyle(AppColors.secondaryText)
        }
    }
}

private struct PetPreferencesView: View {
    @EnvironmentObject private var model: MobileModel

    var body: some View {
        List {
            ForEach(CodexPetTheme.allCases, id: \.self) { theme in
                Button {
                    model.selectPetTheme(theme)
                } label: {
                    HStack(spacing: 13) {
                        PixelPetGlyph(theme: theme, size: 30)
                        Text(theme.displayName).foregroundStyle(.white)
                        Spacer()
                        if model.selectedPetTheme == theme.rawValue {
                            Image(systemName: "checkmark").foregroundStyle(.white)
                        }
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(AppColors.canvas)
        .navigationTitle("宠物外观")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Sidebar navigation

private struct AppSidebar: View {
    @EnvironmentObject private var model: MobileModel
    @Binding var selection: AppTab
    @Binding var isPresented: Bool
    @GestureState private var closingDragOffset: CGFloat = 0

    var body: some View {
        GeometryReader { proxy in
            let sideInset: CGFloat = 18
            // Keep every interactive row on the same outer grid, while the
            // text-only sections line up with the navigation labels/icons.
            let navigationContentInset = sideInset + 14
            let panelWidth = min(proxy.size.width * 0.84, 314)
            let closingProgress = min(1, max(0, -closingDragOffset / panelWidth))

            ZStack(alignment: .leading) {
                Color.black.opacity(0.52 * (1 - closingProgress))
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { dismiss() }

                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 12) {
                        Text("OpenCodex")
                            .font(.system(size: 22, weight: .bold, design: .rounded))
                        Spacer()
                        Button { dismiss() } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 14, weight: .bold))
                                .frame(width: 34, height: 34)
                                .background(AppColors.elevatedSurface, in: Circle())
                        }
                    }
                    .frame(height: 44)
                    .padding(.top, 14)
                    .padding(.horizontal, sideInset)
                    .padding(.bottom, 16)

                    Button {
                        model.beginNewConversation()
                        selection = .chat
                        dismiss()
                    } label: {
                        SidebarNavigationLabel(
                            title: "新建对话",
                            symbol: "square.and.pencil",
                            foreground: .black
                        )
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16)
                            .frame(height: 54)
                            .background(Color.white, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                    }
                    .padding(.horizontal, sideInset)

                    VStack(spacing: 2) {
                        ForEach(AppTab.allCases) { tab in
                            Button {
                                selection = tab
                                dismiss()
                            } label: {
                                SidebarNavigationLabel(
                                    title: tab.title,
                                    symbol: tab.symbol,
                                    foreground: selection == tab ? .white : AppColors.secondaryText
                                )
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 14)
                                    .frame(height: 48)
                                    .background(selection == tab ? Color.white.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                            }
                        }
                    }
                    .padding(.horizontal, sideInset)
                    .padding(.top, 16)

                    Divider().overlay(AppColors.border).padding(.vertical, 18).padding(.horizontal, sideInset)

                    Text("最近会话")
                        .font(.system(size: 12, weight: .bold))
                        .tracking(0.7)
                        .foregroundStyle(AppColors.secondaryText)
                        .padding(.horizontal, navigationContentInset)
                        .padding(.bottom, 6)

                    ScrollView {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(model.sessions) { session in
                                Button {
                                    model.selectSession(session.id)
                                    selection = .chat
                                    dismiss()
                                } label: {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(session.text)
                                            .font(.system(size: 14, weight: .medium))
                                            .foregroundStyle(.white)
                                            .lineLimit(1)
                                        Text(sessionSubtitle(session))
                                            .font(.system(size: 11, weight: .medium))
                                            .foregroundStyle(AppColors.tertiaryText)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, navigationContentInset)
                                    .frame(minHeight: 58, alignment: .center)
                                }
                            }
                            if model.connected && model.sessions.isEmpty {
                                Text(model.isSessionSyncing
                                     ? (model.usingRelay ? "正在通过中继读取会话…" : "正在读取会话…")
                                     : (model.sessionSyncError ?? "暂无会话"))
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundStyle(AppColors.secondaryText)
                                    .padding(.horizontal, navigationContentInset)
                                    .padding(.vertical, 12)
                            }
                        }
                    }
                    .scrollIndicators(.hidden)

                    Spacer(minLength: 8)
                    HStack(spacing: 8) {
                        Circle().fill(.white.opacity(0.78)).frame(width: 7, height: 7)
                        Text(model.usingRelay ? "任务中继" : "本机网关")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(AppColors.secondaryText)
                    }
                    .frame(height: 60)
                    .padding(.horizontal, navigationContentInset)
                }
                .frame(width: panelWidth, height: proxy.size.height, alignment: .top)
                .background(AppColors.canvas)
                .overlay(alignment: .trailing) {
                    Rectangle().fill(AppColors.border).frame(width: 1)
                }
                .offset(x: closingDragOffset)
                .simultaneousGesture(
                    DragGesture(minimumDistance: 10)
                        .updating($closingDragOffset) { value, state, _ in
                            state = min(0, value.translation.width)
                        }
                        .onEnded { value in
                            let shouldDismiss = value.translation.width < -panelWidth * 0.25 ||
                                value.predictedEndTranslation.width < -panelWidth * 0.45
                            if shouldDismiss { dismiss() }
                        }
                )
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func dismiss() {
        withAnimation(AppMotion.sidebar) {
            isPresented = false
        }
    }

    private func sessionSubtitle(_ session: GatewaySession) -> String {
        let count = session.messageCount.map { "\($0) 条消息" } ?? ""
        let model = session.model ?? "Codex"
        return [model, count].filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

private struct SidebarNavigationLabel: View {
    let title: String
    let symbol: String
    let foreground: Color

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .medium))
                .frame(width: 22, height: 22)
            Text(title)
                .font(.system(size: 15, weight: .semibold))
                .lineLimit(1)
        }
        .foregroundStyle(foreground)
    }
}

// MARK: - Formatting

private func phaseTitle(_ phase: CodexTaskPhase) -> String {
    switch phase {
    case .queued: "排队中"
    case .running: "执行中"
    case .waiting: "等待输入"
    case .completed: "已完成"
    case .failed: "失败"
    }
}

private func compactNumber(_ value: Int) -> String {
    if value >= 1_000_000 { return "\(value / 1_000_000)M" }
    if value >= 1_000 { return "\(value / 1_000)K" }
    return "\(value)"
}

private func contextLabel(_ task: CodexTaskEvent?) -> String {
    guard let used = task?.contextUsedTokens, let window = task?.contextWindowTokens, window > 0 else { return "--" }
    return "\(compactNumber(used))/\(compactNumber(window))"
}

private func quotaLabel(_ task: CodexTaskEvent?) -> String {
    guard let percent = task?.quotaUsedPercent else { return "--" }
    return "\(Int(max(0, 100 - percent).rounded()))%"
}

private func taskDetail(_ task: CodexTaskEvent) -> String {
    "上下文 \(contextLabel(task)) · 剩余额度 \(quotaLabel(task))"
}
