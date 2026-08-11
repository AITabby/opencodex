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
                    Text("Choose GPT-Live Model")
                        .font(.system(size: 20, weight: .semibold, design: .rounded))
                    Text("The Live conversation has been handed off to Codex. Choose the model that will execute this task.")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "waveform.and.mic")
                    .font(.system(size: 22, weight: .medium))
                    .foregroundStyle(.cyan)
            }

            if let request {
                Picker("Execution model", selection: $selectedModel) {
                    Text("Choose a model…").tag("")
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
                    Button("Cancel and use the current Desktop model") {
                        cancel(request)
                    }
                    .buttonStyle(.bordered)

                    Spacer()

                    Button("Use this model") {
                        submit(request)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(selectedModel.isEmpty || isSubmitting)
                }
            } else {
                Text("Waiting for a Live task request…")
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
                selectedModel = request?.selectedModel ?? request?.models.first ?? ""
            }
        }
        .onChange(of: request?.id) { _ in
            selectedModel = request?.selectedModel ?? request?.models.first ?? ""
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
            guard let window = NSApplication.shared.windows.first(where: { $0.title == "Choose GPT-Live Model" }) else { return }
            window.level = .floating
            window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
            window.center()
            NSApplication.shared.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
        }
    }
}
