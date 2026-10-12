import SwiftUI

struct ServerSettingsView: View {
    @EnvironmentObject private var settings: APISettings
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    let onSave: (_ baseURL: String, _ allowsHTTP: Bool) throws -> Void

    @State private var baseURL = ""
    @State private var allowsHTTP = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("FileTasks server") {
                    TextField("https://api.example.com", text: $baseURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Toggle("Allow local development HTTP", isOn: $allowsHTTP)
                    Text("HTTP sends your sign-in token without transport encryption. Enable this only when connecting to a development server you control.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if let errorMessage {
                    Section {
                        ErrorBanner(message: errorMessage) {
                            self.errorMessage = nil
                        }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                    }
                }

                if let user = model.user {
                    Section("Current account") {
                        LabeledContent("Signed in as", value: user.email)
                        Text("Changing the server signs you out so your token is not sent to a different server.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Server settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                }
            }
            .onAppear {
                baseURL = settings.baseURLString
                allowsHTTP = settings.allowsLocalHTTP
            }
        }
    }

    private func save() {
        let trimmedURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            _ = try settings.validatedBaseURL(for: trimmedURL, allowsHTTP: allowsHTTP)
            try onSave(trimmedURL, allowsHTTP)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
