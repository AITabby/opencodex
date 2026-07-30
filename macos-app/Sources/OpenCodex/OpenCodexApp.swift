import SwiftUI
import AppKit

final class OpenCodexAppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Closing the red window button hides the UI but keeps the gateway and
        // embedded voice companion alive. Users can quit explicitly from the
        // app menu or Dock when they want to stop background services.
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // A SwiftUI Window scene remains owned by the app after the red close
        // button hides it. Explicitly restore it when the user clicks the
        // Dock/app icon again; without this, the app stays running with no
        // visible window and appears to require a force quit.
        if let window = sender.windows.first(where: { window in
            window.canBecomeKey && (window.title == "OpenCodex" || window.identifier?.rawValue == "main")
        }) ?? sender.windows.first(where: { $0.canBecomeKey }) {
            window.makeKeyAndOrderFront(nil)
        }
        sender.activate(ignoringOtherApps: true)
        return true
    }
}

@main
struct OpenCodexApp: App {
    @NSApplicationDelegateAdaptor(OpenCodexAppDelegate.self) private var appDelegate
    @StateObject private var gateway = GatewayProcess()

    var body: some Scene {
        Window("OpenCodex", id: "main") {
            RootView(gateway: gateway)
                .frame(minWidth: 980, minHeight: 680)
                .task {
                    await gateway.start()
                }
        }
        .commands {
            CommandGroup(replacing: .appInfo) {
                Button("关于 OpenCodex") {
                    NSApplication.shared.orderFrontStandardAboutPanel(nil)
                }
            }
        }
    }
}

struct RootView: View {
    @ObservedObject var gateway: GatewayProcess

    var body: some View {
        ZStack {
            Color(red: 0.035, green: 0.035, blue: 0.045)
                .ignoresSafeArea()

            if let url = gateway.dashboardURL {
                DashboardView(url: url)
                    .ignoresSafeArea()
            } else {
                startupView
            }
        }
        .preferredColorScheme(.dark)
    }

    private var startupView: some View {
        VStack(spacing: 18) {
            if let logoURL = Bundle.module.url(forResource: "OpenCodex-icon-source", withExtension: "png"),
               let logo = NSImage(contentsOf: logoURL) {
                Image(nsImage: logo)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 112, height: 112)
            }
            Text("OpenCodex")
                .font(.system(size: 32, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)

            if case .failed = gateway.state {
                Text(gateway.state.label)
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                Button("重试") { gateway.retry() }.buttonStyle(.borderedProminent)
                if !gateway.logTail.isEmpty {
                    ScrollView {
                        Text(gateway.logTail)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: 700, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    .frame(maxHeight: 220)
                    .padding(12)
                    .background(.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
                }
            }
        }
        .padding(40)
    }
}
