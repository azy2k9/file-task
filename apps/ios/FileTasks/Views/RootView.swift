import SwiftUI

struct RootView: View {
    @EnvironmentObject private var settings: APISettings
    @EnvironmentObject private var model: AppModel
    @State private var showingServerSettings = false

    var body: some View {
        Group {
            if model.isRestoring {
                ProgressView("Connecting to FileTasks…")
            } else if model.user == nil {
                AuthenticationView {
                    showingServerSettings = true
                }
            } else {
                WorkspaceView {
                    showingServerSettings = true
                }
            }
        }
        .sheet(isPresented: $showingServerSettings) {
            ServerSettingsView { baseURL, allowsHTTP in
                let changedServer = baseURL != settings.baseURLString
                if changedServer {
                    try model.resetSessionForServerChange()
                }
                settings.update(baseURLString: baseURL, allowsLocalHTTP: allowsHTTP)
            }
        }
        .task {
            await model.restoreSession()
        }
    }
}

struct ErrorBanner: View {
    let message: String
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text(message)
                .font(.footnote)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.semibold))
            }
            .accessibilityLabel("Dismiss error")
        }
        .padding(12)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
    }
}
