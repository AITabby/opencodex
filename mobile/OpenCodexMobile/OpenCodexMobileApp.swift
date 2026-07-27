import SwiftUI

@main
struct OpenCodexMobileApp: App {
    @StateObject private var model = MobileModel()

    var body: some Scene {
        WindowGroup {
            rootView
        }
    }

    private var rootView: some View {
        ContentView()
            .environmentObject(model)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .task {
                await model.prepareNotifications()
            }
            .onOpenURL { url in
                model.handleDeepLink(url)
            }
    }
}
