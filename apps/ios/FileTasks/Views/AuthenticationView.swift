import SwiftUI

struct AuthenticationView: View {
    @EnvironmentObject private var model: AppModel
    let openServerSettings: () -> Void

    @State private var email = ""
    @State private var password = ""
    @State private var creatingAccount = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("FileTasks")
                            .font(.largeTitle.bold())
                        Text("Keep your Tasks and Events together.")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 10)
                    .listRowBackground(Color.clear)
                }

                if let error = model.errorMessage {
                    Section {
                        ErrorBanner(message: error, dismiss: model.dismissError)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    }
                }

                Section("Account") {
                    TextField("Email", text: $email)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder)

                    SecureField("Password", text: $password)
                        .textContentType(creatingAccount ? .newPassword : .password)
                        .textFieldStyle(.roundedBorder)
                }

                Section {
                    Button {
                        Task {
                            await model.authenticate(
                                email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                                password: password,
                                creatingAccount: creatingAccount
                            )
                        }
                    } label: {
                        HStack {
                            Spacer()
                            if model.isAuthenticating {
                                ProgressView()
                                    .padding(.trailing, 6)
                            }
                            Text(creatingAccount ? "Create account" : "Sign in")
                                .fontWeight(.semibold)
                            Spacer()
                        }
                    }
                    .disabled(model.isAuthenticating || email.isEmpty || password.isEmpty)

                    Button(creatingAccount ? "I already have an account" : "Create a new account") {
                        creatingAccount.toggle()
                        model.dismissError()
                    }
                    .font(.subheadline)
                    .frame(maxWidth: .infinity)
                }

                Section {
                    Button(action: openServerSettings) {
                        Label("Server settings", systemImage: "server.rack")
                    }
                } footer: {
                    Text("Your password is sent to the configured FileTasks server for sign-in and is not saved on this device.")
                }
            }
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
