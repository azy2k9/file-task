import SwiftUI

@main
struct FileTasksApp: App {
    @StateObject private var settings: APISettings
    @StateObject private var model: AppModel

    init() {
        let settings = APISettings()
        _settings = StateObject(wrappedValue: settings)
        _model = StateObject(wrappedValue: AppModel(settings: settings))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(settings)
                .environmentObject(model)
        }
    }
}
