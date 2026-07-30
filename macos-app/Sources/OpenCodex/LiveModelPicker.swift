import SwiftUI
import AppKit

struct LiveModelPickerView: View {
    @ObservedObject var gateway: GatewayProcess
    @Environment(\.dismiss) private var dismiss
    @State private var selectedModel = ""
    @State private var isSubmitting = false
    @State private var errorMessage = ""

    private var request: LiveModelPickerRequest? { gateway.liveModelPickerRequest }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("选择 GPT-Live 执行模型")
                        .font(.system(size: 20, weight: .semibold, design: .rounded))
                    Text("Live 对话已交接给 Codex。请选择本次任务真正干活的模型。")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "waveform.and.mic")
                    .font(.system(size: 22, weight: .medium))
                    .foregroundStyle(.cyan)
            }

            if let request {
                Picker("执行模型", selection: $selectedModel) {
                    Text("请选择模型…").tag("")
                    ForEach(request.models, id: \.self) { model in
                        Text(model).tag(model)
                    }
                }
                .pickerStyle(.menu)
                .frame(maxWidth: .infinity, alignment: .leading)

                if !errorMessage.isEmpty {
                    Text(errorMessage)
                        .font(.system(size: 12))
                        .foregroundStyle(.red)
                }

                HStack {
                    Button("取消，使用桌面当前模型") {
                        cancel(request)
                    }
                    .buttonStyle(.bordered)

                    Spacer()

                    Button("使用此模型") {
                        submit(request)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(selectedModel.isEmpty || isSubmitting)
                }
            } else {
                Text("正在等待 Live 任务请求…")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(24)
        .frame(width: 430, height: 245)
        .background(.ultraThinMaterial)
        .onAppear {
            configureWindow()
            if selectedModel.isEmpty {
                selectedModel = request?.models.first ?? ""
            }
        }
        .onChange(of: request?.id) { _ in
            selectedModel = request?.models.first ?? ""
            errorMessage = ""
        }
    }

    private func submit(_ request: LiveModelPickerRequest) {
        isSubmitting = true
        errorMessage = ""
        Task { @MainActor in
            do {
                try await gateway.resolveLiveModel(request: request, model: selectedModel)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
                isSubmitting = false
            }
        }
    }

    private func cancel(_ request: LiveModelPickerRequest) {
        Task { @MainActor in
            try? await gateway.cancelLiveModel(request: request)
            dismiss()
        }
    }

    private func configureWindow() {
        DispatchQueue.main.async {
            guard let window = NSApplication.shared.windows.first(where: { $0.title == "GPT-Live 选择执行模型" }) else { return }
            window.level = .floating
            window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
            window.center()
            NSApplication.shared.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
        }
    }
}
