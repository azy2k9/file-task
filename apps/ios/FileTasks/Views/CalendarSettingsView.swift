import SwiftUI
import UIKit

struct CalendarSettingsView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: APISettings
    @Environment(\.dismiss) private var dismiss

    @State private var appleUsername = ""
    @State private var applePassword = ""
    @State private var appleCalendarURL = ""
    @State private var busyAction: String?
    @State private var requestTask: Task<Void, Never>?

    private var hasGoogle: Bool { model.calendarConnections.contains { $0.provider == "google" } }
    private var hasApple: Bool { model.calendarConnections.contains { $0.provider == "apple" } }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("FileTasks account", value: model.user?.email ?? "Signed out")
                    Text("Calendar connections belong to this account. Google authorization opens the FileTasks website in Safari so you can confirm the browser account before connecting.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section {
                    Button {
                        Task { await syncCalendars() }
                    } label: {
                        if busyAction == "sync" { ProgressView() }
                        else { Label("Sync Calendar", systemImage: "arrow.triangle.2.circlepath") }
                    }
                    .accessibilityIdentifier("calendar.sync")
                    .disabled(busyAction != nil)
                }

                Section("Connected calendars") {
                    if model.calendarConnections.isEmpty {
                        Text("No calendars connected to this FileTasks account.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(model.calendarConnections) { connection in
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(connection.provider == "google" ? "Google Calendar" : "Apple Calendar")
                                    .font(.body.weight(.medium))
                                Text(connection.accountLabel).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Disconnect", role: .destructive) {
                                Task { await disconnect(connection.provider) }
                            }
                            .disabled(busyAction != nil)
                            .accessibilityIdentifier("calendar.disconnect.\(connection.provider)")
                        }
                    }
                }

                if !hasGoogle {
                    Section("Google Calendar") {
                        Text("Continue in Safari and sign in to the intended FileTasks account before you connect Google Calendar.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Button {
                            openGoogleHandoff()
                        } label: {
                            Label("Connect Google Calendar", systemImage: "safari")
                        }
                        .disabled(busyAction != nil)
                        .accessibilityIdentifier("calendar.connect.google")
                    }
                }

                if !hasApple {
                    Section("Apple Calendar") {
                        TextField("Apple ID", text: $appleUsername)
                            .textContentType(.username)
                            .textInputAutocapitalization(.never)
                            .keyboardType(.emailAddress)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("calendar.apple.username")
                        SecureField("App-specific password", text: $applePassword)
                            .textContentType(.password)
                            .accessibilityIdentifier("calendar.apple.password")
                        TextField("CalDAV calendar URL (optional)", text: $appleCalendarURL)
                            .textInputAutocapitalization(.never)
                            .keyboardType(.URL)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("calendar.apple.url")
                        Text("Use an Apple ID app-specific password. Leave the URL blank to let FileTasks discover your iCloud calendar. FileTasks sends the credentials to Apple Calendar and encrypts them before server storage.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Button {
                            requestTask = Task { await connectApple() }
                        } label: {
                            if busyAction == "apple" { ProgressView() }
                            else { Text("Connect Apple Calendar") }
                        }
                        .disabled(busyAction != nil || appleUsername.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || applePassword.isEmpty)
                        .accessibilityIdentifier("calendar.connect.apple")
                        Button("Cancel Apple setup", role: .cancel) {
                            cancelAppleConnection()
                        }
                        .accessibilityIdentifier("calendar.cancel.apple")
                    }
                }

                if !model.calendarSyncDelivery.isEmpty {
                    Section("Calendar delivery") {
                        ForEach(model.calendarSyncDelivery) { delivery in
                            VStack(alignment: .leading, spacing: 4) {
                                Text("\(delivery.provider.capitalized) Calendar · \(delivery.state.capitalized)")
                                    .font(.subheadline.weight(.medium))
                                if let message = delivery.lastError, !message.isEmpty {
                                    Text(message).font(.footnote).foregroundStyle(.secondary)
                                }
                                if delivery.connected == false {
                                    Text("Reconnect this calendar to resume retries.")
                                        .font(.footnote).foregroundStyle(.orange)
                                }
                            }
                        }
                    }
                }

                if !model.calendarSyncLimitations.isEmpty {
                    Section("Event sync limitations") {
                        ForEach(model.calendarSyncLimitations) { limitation in
                            VStack(alignment: .leading, spacing: 4) {
                                Text("\(limitation.title) · \(limitation.provider.capitalized) Calendar")
                                    .font(.subheadline.weight(.medium))
                                Text(limitation.message).font(.footnote).foregroundStyle(.secondary)
                            }
                            .accessibilityIdentifier("calendar.limitation.\(limitation.id)")
                        }
                    }
                }

                if let notice = model.calendarActionNotice {
                    Section {
                        Text(notice)
                            .font(.footnote)
                            .accessibilityIdentifier("calendar.action.notice")
                        Button("Dismiss notice") { model.dismissCalendarActionNotice() }
                            .font(.footnote)
                    }
                }

                if let error = model.calendarStatusError {
                    Section {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("calendar.action.error")
                        Button("Retry status") { Task { await model.refreshCalendarStatus() } }
                            .font(.footnote)
                            .disabled(busyAction != nil)
                    }
                }
            }
            .navigationTitle("Connected calendars")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await model.refreshCalendarStatus() }
        }
    }

    private func openGoogleHandoff() {
        do {
            let root = try settings.validatedBaseURL()
            UIApplication.shared.open(root, options: [:]) { opened in
                Task { @MainActor in
                    if opened {
                        model.noteGoogleCalendarHandoffOpened()
                    } else {
                        model.setCalendarStatusError("Safari could not open the FileTasks website. Check the server URL and try again.")
                    }
                }
            }
        } catch {
            model.setCalendarStatusError(error.localizedDescription)
        }
    }

    private func connectApple() async {
        busyAction = "apple"
        let password = applePassword
        do {
            try await model.connectAppleCalendar(
                username: appleUsername.trimmingCharacters(in: .whitespacesAndNewlines),
                password: password,
                calendarURL: appleCalendarURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? nil : appleCalendarURL.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            applePassword = ""
        } catch {
            // AppModel exposes the provider or session error in this screen.
        }
        busyAction = nil
        requestTask = nil
    }

    private func disconnect(_ provider: String) async {
        busyAction = "disconnect"
        do {
            try await model.disconnectCalendar(provider: provider)
        } catch {
            // AppModel exposes the provider or session error in this screen.
        }
        busyAction = nil
    }

    private func syncCalendars() async {
        busyAction = "sync"
        do {
            try await model.syncCalendars()
        } catch {
            // AppModel exposes the provider or session error in this screen.
        }
        busyAction = nil
    }

    private func cancelAppleConnection() {
        if busyAction == "apple" {
            requestTask?.cancel()
        } else {
            model.recordAppleSetupCancellation()
        }
        applePassword = ""
        appleUsername = ""
        appleCalendarURL = ""
    }
}
