import Foundation
import Combine
import UIKit

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var user: AuthUser?
    @Published private(set) var items: [WorkspaceItem] = []
    @Published private(set) var files: [WorkspaceFile] = []
    @Published private(set) var reminderSettings: ReminderSettings = .empty
    @Published private(set) var hasLoadedReminderSettingsForCurrentSession = false
    @Published private(set) var isLoadingReminderSettings = false
    @Published private(set) var reminderSettingsLoadError: String?
    @Published private(set) var hasRegisteredPushDevice = false
    @Published private(set) var pushDeviceRevoked = false
    @Published private(set) var calendarSyncDelivery: [CalendarSyncDeliveryStatus] = []
    @Published private(set) var calendarConnections: [CalendarConnection] = []
    @Published private(set) var calendarSyncLimitations: [CalendarSyncLimitation] = []
    @Published private(set) var calendarStatusError: String?
    @Published private(set) var calendarActionNotice: String?
    @Published private(set) var calendarSyncNotice: String?
    @Published private(set) var isRestoring = true
    @Published private(set) var isAuthenticating = false
    @Published private(set) var isLoadingItems = false
    @Published var errorMessage: String?

    private struct SessionContext {
        let generation: Int
        let token: String
        let baseURL: URL
    }

    private let settings: APISettings
    private let tokenStore: KeychainTokenStore
    private var hasRestoredSession = false
    private var sessionGeneration = 0
    private var itemRevision = 0
    private var fileRevision = 0
    private var refreshRequestID = 0
    private var reminderSettingsRequestID = 0
    private var calendarDeliveryRequestID = 0
    private var calendarNoticeVersion = 0
    private var authenticationAttemptID: UUID?
    private var googleHandoffAwaitingReturn = false

    init(settings: APISettings, tokenStore: KeychainTokenStore = KeychainTokenStore()) {
        self.settings = settings
        self.tokenStore = tokenStore
    }

    func restoreSession() async {
        guard !hasRestoredSession else { return }
        hasRestoredSession = true
        let attemptGeneration = sessionGeneration
        defer { isRestoring = false }

        do {
            guard let token = try tokenStore.read() else { return }
            let baseURL = try settings.validatedBaseURL()
            let response = try await APIClient(baseURL: baseURL).currentSession(token: token)
            guard sessionGeneration == attemptGeneration else { return }
            let context = activateSession(token: token, baseURL: baseURL, user: response.user)
            await refreshItems(using: context)
        } catch {
            guard sessionGeneration == attemptGeneration else { return }
            handle(error, forGeneration: attemptGeneration)
        }
    }

    func authenticate(email: String, password: String, creatingAccount: Bool) async {
        guard !isAuthenticating else { return }

        let baseURL: URL
        do {
            baseURL = try settings.validatedBaseURL()
        } catch {
            errorMessage = error.localizedDescription
            return
        }
        let api = APIClient(baseURL: baseURL)

        sessionGeneration += 1
        let attemptGeneration = sessionGeneration
        let attemptID = UUID()
        authenticationAttemptID = attemptID
        isAuthenticating = true
        errorMessage = nil
        defer {
            if authenticationAttemptID == attemptID {
                authenticationAttemptID = nil
                isAuthenticating = false
            }
        }

        do {
            let response: AuthResponse
            if creatingAccount {
                response = try await api.register(email: email, password: password)
            } else {
                response = try await api.login(email: email, password: password)
            }
            guard sessionGeneration == attemptGeneration else { return }
            try tokenStore.save(response.token)
            guard sessionGeneration == attemptGeneration else { return }
            let context = activateSession(token: response.token, baseURL: baseURL, user: response.user)
            await refreshItems(using: context)
        } catch {
            guard sessionGeneration == attemptGeneration else { return }
            errorMessage = error.localizedDescription
        }
    }

    func refreshItems() async {
        guard user != nil else { return }
        do {
            guard let token = try tokenStore.read() else {
                clearSession(error: APIClientError.missingToken)
                return
            }
            let baseURL = try settings.validatedBaseURL()
            await refreshItems(using: SessionContext(
                generation: sessionGeneration,
                token: token,
                baseURL: baseURL
            ))
        } catch {
            errorMessage = error.localizedDescription
            calendarStatusError = error.localizedDescription
            if !hasLoadedReminderSettingsForCurrentSession {
                reminderSettingsLoadError = error.localizedDescription
            }
        }
    }

    func applicationDidBecomeActive() async {
        guard user != nil else { return }
        await refreshItems()
        guard googleHandoffAwaitingReturn else { return }
        guard calendarStatusError == nil else { return }
        googleHandoffAwaitingReturn = false
        if !calendarConnections.contains(where: { $0.provider == "google" }) {
            calendarActionNotice = "Google Calendar was not connected to this FileTasks account. The browser flow may have been cancelled, used a different account, or failed on the server."
        } else {
            calendarActionNotice = "Google Calendar is connected to this FileTasks account."
        }
    }

    func noteGoogleCalendarHandoffOpened() {
        googleHandoffAwaitingReturn = true
        calendarActionNotice = "Continue in Safari. Sign in to the intended FileTasks account, then connect Google Calendar there."
    }

    func connectAppleCalendar(username: String, password: String, calendarURL: String?) async throws {
        let context = try currentCalendarContext()
        do {
            try await APIClient(baseURL: context.baseURL).connectAppleCalendar(
                username: username, password: password, calendarURL: calendarURL, token: context.token
            )
            guard isCurrent(context) else { throw APIClientError.sessionChanged }
            calendarActionNotice = "Apple Calendar connected."
            calendarStatusError = nil
            await refreshItems(using: context)
        } catch {
            handleCalendarActionError(error, for: context)
            throw error
        }
    }

    func disconnectCalendar(provider: String) async throws {
        let context = try currentCalendarContext()
        do {
            try await APIClient(baseURL: context.baseURL).disconnectCalendar(provider: provider, token: context.token)
            guard isCurrent(context) else { throw APIClientError.sessionChanged }
            calendarActionNotice = "\(provider == "google" ? "Google" : "Apple") Calendar disconnected."
            calendarStatusError = nil
            await refreshItems(using: context)
        } catch {
            handleCalendarActionError(error, for: context)
            throw error
        }
    }

    func syncCalendars() async throws {
        let context = try currentCalendarContext()
        do {
            let result = try await APIClient(baseURL: context.baseURL).syncCalendars(token: context.token)
            guard isCurrent(context) else { throw APIClientError.sessionChanged }
            if result.synced.isEmpty {
                calendarActionNotice = result.message ?? "No connected calendars were synchronized."
            } else {
                let providers = result.synced.map { $0 == "google" ? "Google" : "Apple" }
                let limitations = result.syncLimitations?.count ?? 0
                let limitationNote = limitations == 0 ? "" : " \(limitations) Event sync \(limitations == 1 ? "limitation" : "limitations") need attention."
                calendarActionNotice = "Synced \(providers.joined(separator: " and ")) Calendar\(providers.count == 1 ? "" : "s").\(limitationNote)"
            }
            calendarStatusError = nil
            await refreshItems(using: context)
        } catch {
            handleCalendarActionError(error, for: context)
            throw error
        }
    }

    func recordCalendarActionCancellation() {
        calendarActionNotice = "Calendar connection cancelled. Refresh status before retrying in case the server received the request."
        calendarStatusError = nil
    }

    func recordAppleSetupCancellation() {
        calendarActionNotice = "Apple Calendar setup cancelled. No connection request was sent."
        calendarStatusError = nil
    }

    func dismissCalendarActionNotice() {
        calendarActionNotice = nil
    }

    func setCalendarStatusError(_ message: String) {
        calendarStatusError = message
    }

    func save(_ draft: ItemDraft, editing item: WorkspaceItem?) async throws {
        let context = try currentContext()
        do {
            let saved: WorkspaceItem
            if let item {
                saved = try await APIClient(baseURL: context.baseURL).updateItem(
                    id: item.id,
                    payload: draft.payload(),
                    token: context.token
                )
            } else {
                saved = try await APIClient(baseURL: context.baseURL).createItem(
                    draft.payload(),
                    token: context.token
                )
            }
            guard isCurrent(context) else { throw APIClientError.sessionChanged }
            upsert(saved)
            errorMessage = nil
            if draft.kind == .event {
                await refreshCalendarSyncDelivery(using: context, outcome: .saved)
            }
        } catch {
            handle(error, for: context)
            throw error
        }
    }

    func saveReminderSettings(_ settings: ReminderSettings, applyToExisting: Bool) async throws {
        let context = try currentContext()
        let wasPushEnabled = reminderSettings.pushEnabled
        do {
            let updated = try await APIClient(baseURL: context.baseURL).updateReminderSettings(
                settings, token: context.token, applyToExisting: applyToExisting
            )
            guard isCurrent(context) else { throw APIClientError.sessionChanged }
            reminderSettingsRequestID += 1
            reminderSettings = updated
            hasLoadedReminderSettingsForCurrentSession = true
            isLoadingReminderSettings = false
            reminderSettingsLoadError = nil
            if updated.pushEnabled && !wasPushEnabled, let user {
                UserDefaults.standard.set(false, forKey: pushDeviceRevokedKey(for: user.id))
                pushDeviceRevoked = false
            }
            await refreshItems(using: context)
            if !updated.pushEnabled { try await revokeCurrentPushDevice(using: context) }
        } catch {
            handle(error, for: context)
            throw error
        }
    }

    func registerPushDevice(platform: String, pushToken: String) async throws -> PushDevice {
        let context = try currentContext()
        do {
            let device = try await APIClient(baseURL: context.baseURL).registerPushDevice(
                platform: platform, pushToken: pushToken, authToken: context.token
            )
            guard isCurrent(context) else { throw APIClientError.sessionChanged }
            if let user { UserDefaults.standard.set(device.id, forKey: pushDeviceKey(for: user.id)) }
            hasRegisteredPushDevice = true
            if let user { UserDefaults.standard.set(false, forKey: pushDeviceRevokedKey(for: user.id)) }
            pushDeviceRevoked = false
            errorMessage = nil
            return device
        } catch {
            handle(error, for: context)
            throw error
        }
    }

    func allowPushDeviceRegistration() throws {
        guard let user, reminderSettings.pushEnabled else { throw APIClientError.missingToken }
        UserDefaults.standard.set(false, forKey: pushDeviceRevokedKey(for: user.id))
        pushDeviceRevoked = false
    }

    func revokeCurrentPushDevice() async throws {
        try await revokeCurrentPushDevice(using: currentContext())
    }

    private func revokeCurrentPushDevice(using context: SessionContext) async throws {
        guard let user, let deviceId = UserDefaults.standard.string(forKey: pushDeviceKey(for: user.id)) else {
            hasRegisteredPushDevice = false
            return
        }
        do {
            try await APIClient(baseURL: context.baseURL).revokePushDevice(id: deviceId, token: context.token)
            guard isCurrent(context) else { throw APIClientError.sessionChanged }
            UserDefaults.standard.removeObject(forKey: pushDeviceKey(for: user.id))
            UserDefaults.standard.set(true, forKey: pushDeviceRevokedKey(for: user.id))
            hasRegisteredPushDevice = false
            pushDeviceRevoked = true
            errorMessage = nil
        } catch {
            handle(error, for: context)
            throw error
        }
    }

    func revokePushDevice(id: String) async throws {
        let context = try currentContext()
        do {
            try await APIClient(baseURL: context.baseURL).revokePushDevice(id: id, token: context.token)
            guard isCurrent(context) else { throw APIClientError.sessionChanged }
            if let user { UserDefaults.standard.removeObject(forKey: pushDeviceKey(for: user.id)) }
            if let user { UserDefaults.standard.set(true, forKey: pushDeviceRevokedKey(for: user.id)) }
            hasRegisteredPushDevice = false
            pushDeviceRevoked = true
            errorMessage = nil
        } catch {
            handle(error, for: context)
            throw error
        }
    }

    func setCompleted(_ item: WorkspaceItem, to completed: Bool) async {
        let context: SessionContext
        do {
            context = try currentContext()
        } catch {
            errorMessage = error.localizedDescription
            return
        }

        do {
            let updated = try await APIClient(baseURL: context.baseURL).updateCompletion(
                id: item.id,
                completed: completed,
                token: context.token
            )
            guard isCurrent(context) else { return }
            upsert(updated)
            errorMessage = nil
        } catch {
            handle(error, for: context)
        }
    }

    func delete(_ item: WorkspaceItem, scope: EditScope? = nil) async {
        let context: SessionContext
        do {
            context = try currentContext()
        } catch {
            errorMessage = error.localizedDescription
            return
        }

        do {
            try await APIClient(baseURL: context.baseURL).deleteItem(id: item.id, scope: scope, token: context.token)
            guard isCurrent(context) else { return }
            items.removeAll { $0.id == item.id }
            itemRevision += 1
            await refreshItems(using: context)
            if item.kind == .event {
                await refreshCalendarSyncDelivery(using: context, outcome: .deleted)
            }
            errorMessage = nil
        } catch {
            handle(error, for: context)
        }
    }

    func saveLinkFile(name: String, url: String) async throws {
        let context = try currentContext()
        do {
            let file = try await APIClient(baseURL: context.baseURL).createLinkFile(name: name, url: url, token: context.token)
            guard isCurrent(context) else { throw APIClientError.sessionChanged }
            files.insert(file, at: 0)
            fileRevision += 1
            errorMessage = nil
        } catch {
            handle(error, for: context)
            throw error
        }
    }

    func uploadFile(name: String, contentType: String, data: Data) async throws {
        let context = try currentContext()
        do {
            let file = try await APIClient(baseURL: context.baseURL).uploadFile(
                name: name, contentType: contentType, data: data, token: context.token
            )
            guard isCurrent(context) else { throw APIClientError.sessionChanged }
            files.insert(file, at: 0)
            fileRevision += 1
            errorMessage = nil
        } catch {
            handle(error, for: context)
            throw error
        }
    }

    func attachFile(_ file: WorkspaceFile, to item: WorkspaceItem, scope: EditScope = .occurrence) async throws {
        let context = try currentContext()
        do {
            try await APIClient(baseURL: context.baseURL).attachFile(id: file.id, to: item.id, scope: scope, token: context.token)
            guard isCurrent(context) else { throw APIClientError.sessionChanged }
            await refreshItems(using: context)
        } catch {
            handle(error, for: context)
            throw error
        }
    }

    func removeAttachment(_ attachment: FileAttachment, from file: WorkspaceFile, scope: EditScope = .occurrence) async throws {
        let context = try currentContext()
        do {
            try await APIClient(baseURL: context.baseURL).removeAttachment(
                fileId: file.id, itemId: attachment.itemId, scope: scope, token: context.token
            )
            guard isCurrent(context) else { throw APIClientError.sessionChanged }
            await refreshItems(using: context)
        } catch {
            handle(error, for: context)
            throw error
        }
    }

    func deleteFile(_ file: WorkspaceFile) async throws {
        let context = try currentContext()
        do {
            try await APIClient(baseURL: context.baseURL).deleteFile(id: file.id, token: context.token)
            guard isCurrent(context) else { throw APIClientError.sessionChanged }
            files.removeAll { $0.id == file.id }
            items = items.map { item in
                var updated = item
                updated.files.removeAll { $0.id == file.id }
                return updated
            }
            fileRevision += 1
            itemRevision += 1
            errorMessage = nil
        } catch {
            handle(error, for: context)
            throw error
        }
    }

    func openFileURL(id: String) async throws -> URL {
        let context = try currentContext()
        do {
            let target = try await APIClient(baseURL: context.baseURL).openFile(id: id, token: context.token)
            guard isCurrent(context), let url = URL(string: target.url) else { throw APIClientError.sessionChanged }
            return url
        } catch {
            handle(error, for: context)
            throw error
        }
    }

    func logout() async {
        let context: SessionContext
        do {
            context = try currentContext()
        } catch {
            errorMessage = error.localizedDescription
            return
        }

        do {
            try await revokeCurrentPushDevice(using: context)
            try await APIClient(baseURL: context.baseURL).logout(token: context.token)
            guard isCurrent(context) else { return }
            UIApplication.shared.unregisterForRemoteNotifications()
            invalidateSession()
            do {
                try tokenStore.delete()
            } catch {
                errorMessage = error.localizedDescription
            }
        } catch {
            handle(error, for: context)
        }
    }

    func resetSessionForServerChange() throws {
        try tokenStore.delete()
        invalidateSession()
        errorMessage = nil
    }

    func dismissError() {
        errorMessage = nil
    }

    private func refreshItems(using context: SessionContext) async {
        guard isCurrent(context) else { return }
        refreshRequestID += 1
        let requestID = refreshRequestID
        reminderSettingsRequestID += 1
        let settingsRequestID = reminderSettingsRequestID
        let revisionAtStart = itemRevision
        let fileRevisionAtStart = fileRevision
        isLoadingItems = true
        isLoadingReminderSettings = true
        if !hasLoadedReminderSettingsForCurrentSession {
            reminderSettingsLoadError = nil
        }
        defer {
            if isCurrent(context), refreshRequestID == requestID { isLoadingItems = false }
            if isCurrent(context), reminderSettingsRequestID == settingsRequestID {
                isLoadingReminderSettings = false
            }
        }

        let api = APIClient(baseURL: context.baseURL)
        async let itemsRequest = api.items(token: context.token)
        async let filesRequest = api.files(token: context.token)
        async let settingsRequest = api.reminderSettings(token: context.token)

        do {
            let (refreshedItems, refreshedFiles) = try await (itemsRequest, filesRequest)
            if isCurrent(context),
               refreshRequestID == requestID,
               itemRevision == revisionAtStart,
               fileRevision == fileRevisionAtStart {
                items = refreshedItems
                files = refreshedFiles
                errorMessage = nil
            }
        } catch {
            if isCurrent(context),
               refreshRequestID == requestID,
               itemRevision == revisionAtStart,
               fileRevision == fileRevisionAtStart {
                handle(error, for: context)
            }
        }

        do {
            let refreshedSettings = try await settingsRequest
            guard isCurrent(context), reminderSettingsRequestID == settingsRequestID else { return }
            reminderSettings = refreshedSettings
            hasLoadedReminderSettingsForCurrentSession = true
            reminderSettingsLoadError = nil
        } catch {
            guard isCurrent(context), reminderSettingsRequestID == settingsRequestID else { return }
            if !hasLoadedReminderSettingsForCurrentSession {
                reminderSettingsLoadError = error.localizedDescription
            }
            handle(error, for: context)
        }
        await refreshCalendarSyncDelivery(using: context)
    }

    func refreshCalendarSyncDelivery() async {
        guard user != nil else { return }
        do {
            await refreshCalendarSyncDelivery(using: try currentContext())
        } catch {
            // Calendar delivery status must never turn a committed local mutation into an error.
        }
    }

    func refreshCalendarStatus() async {
        guard user != nil else { return }
        do {
            await refreshCalendarSyncDelivery(using: try currentCalendarContext())
        } catch {
            calendarStatusError = error.localizedDescription
        }
    }

    private enum CalendarMutationOutcome: Equatable {
        case saved
        case deleted
    }

    private func refreshCalendarSyncDelivery(
        using context: SessionContext,
        outcome: CalendarMutationOutcome? = nil
    ) async {
        guard isCurrent(context) else { return }
        calendarDeliveryRequestID += 1
        let requestID = calendarDeliveryRequestID
        do {
            let status = try await APIClient(baseURL: context.baseURL).calendarStatus(token: context.token)
            guard isCurrent(context), calendarDeliveryRequestID == requestID else { return }
            calendarConnections = status.calendars
            calendarSyncLimitations = status.syncLimitations
            calendarSyncDelivery = status.syncDelivery
            calendarStatusError = nil
            let statuses = status.syncDelivery
            if statuses.isEmpty {
                guard let outcome else {
                    calendarSyncNotice = nil
                    calendarNoticeVersion += 1
                    return
                }
                let version = calendarNoticeVersion + 1
                calendarNoticeVersion = version
                calendarSyncNotice = outcome == .deleted
                    ? "Deleted from FileTasks. Calendar removal status is not available yet."
                    : "Saved to FileTasks. Calendar sync status is not available yet."
                Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: 15_000_000_000)
                    guard let self, self.calendarNoticeVersion == version else { return }
                    self.calendarSyncNotice = nil
                }
                return
            }
            let failed = statuses.contains { $0.state == "failed" }
            let disconnected = statuses.contains { $0.connected != true }
            let retryNote = disconnected
                ? failed
                    ? " Reconnect the disconnected calendar to retry."
                    : " Reconnect the disconnected calendar to resume retries."
                : failed
                    ? " The last attempt failed; another retry is scheduled."
                    : ""
            let deliveryState = disconnected && failed ? "failed" : "pending"
            switch outcome {
            case .saved:
                calendarSyncNotice = "Calendar sync \(deliveryState). Your Event is saved in FileTasks\(disconnected ? "." : " and will be retried.")" + retryNote
            case .deleted:
                calendarSyncNotice = "Calendar removal \(deliveryState). Your Event was deleted from FileTasks\(disconnected ? "." : " and will be retried.")" + retryNote
            case .none:
                calendarSyncNotice = disconnected && failed
                    ? "Calendar sync failed. Your Events are saved in FileTasks." + retryNote
                    : "Calendar changes are pending. Your Events are saved in FileTasks\(disconnected ? "." : " and will be retried.")" + retryNote
            }
            calendarNoticeVersion += 1
        } catch {
            guard isCurrent(context), calendarDeliveryRequestID == requestID else { return }
            if let apiError = error as? APIClientError, apiError.statusCode == 401 {
                handle(error, for: context)
                return
            }
            calendarStatusError = error.localizedDescription
            guard let outcome else { return }
            calendarNoticeVersion += 1
            calendarSyncNotice = outcome == .deleted
                ? "Deleted from FileTasks. Calendar removal status is not available yet."
                : "Saved to FileTasks. Calendar sync status is not available yet."
        }
    }

    private func currentContext() throws -> SessionContext {
        guard user != nil, let token = try tokenStore.read() else {
            throw APIClientError.missingToken
        }
        return SessionContext(
            generation: sessionGeneration,
            token: token,
            baseURL: try settings.validatedBaseURL()
        )
    }

    private func currentCalendarContext() throws -> SessionContext {
        do {
            return try currentContext()
        } catch {
            calendarStatusError = error.localizedDescription
            if let apiError = error as? APIClientError, apiError == .missingToken {
                clearSession(error: error)
            }
            throw error
        }
    }

    private func isCurrent(_ context: SessionContext) -> Bool {
        context.generation == sessionGeneration && user != nil
    }

    private func activateSession(token: String, baseURL: URL, user: AuthUser) -> SessionContext {
        sessionGeneration += 1
        self.user = user
        items = []
        files = []
        reminderSettings = .empty
        hasLoadedReminderSettingsForCurrentSession = false
        isLoadingReminderSettings = false
        reminderSettingsLoadError = nil
        reminderSettingsRequestID += 1
        calendarDeliveryRequestID += 1
        calendarNoticeVersion += 1
        hasRegisteredPushDevice = UserDefaults.standard.string(forKey: pushDeviceKey(for: user.id)) != nil
        pushDeviceRevoked = UserDefaults.standard.bool(forKey: pushDeviceRevokedKey(for: user.id))
        isLoadingItems = false
        errorMessage = nil
        calendarSyncDelivery = []
        calendarConnections = []
        calendarSyncLimitations = []
        calendarStatusError = nil
        calendarActionNotice = nil
        calendarSyncNotice = nil
        googleHandoffAwaitingReturn = false
        return SessionContext(generation: sessionGeneration, token: token, baseURL: baseURL)
    }

    private func handle(_ error: Error, for context: SessionContext) {
        guard isCurrent(context) else { return }
        handle(error, forGeneration: context.generation)
    }

    private func handleCalendarActionError(_ error: Error, for context: SessionContext) {
        guard isCurrent(context) else { return }
        if let apiError = error as? APIClientError, apiError == .cancelled {
            recordCalendarActionCancellation()
            return
        }
        calendarStatusError = error.localizedDescription
        handle(error, for: context)
    }

    private func handle(_ error: Error, forGeneration generation: Int) {
        guard generation == sessionGeneration else { return }
        if let apiError = error as? APIClientError, apiError.statusCode == 401 {
            clearSession(error: apiError)
        } else {
            errorMessage = error.localizedDescription
        }
    }

    private func clearSession(error: Error) {
        var tokenDeletionError: String?
        do {
            try tokenStore.delete()
        } catch {
            tokenDeletionError = error.localizedDescription
        }
        invalidateSession()
        if let tokenDeletionError {
            errorMessage = "Your sign-in expired. The saved token could not be removed: \(tokenDeletionError)"
        } else {
            errorMessage = error.localizedDescription
        }
    }

    private func invalidateSession() {
        sessionGeneration += 1
        authenticationAttemptID = nil
        isAuthenticating = false
        isLoadingItems = false
        user = nil
        items = []
        files = []
        reminderSettings = .empty
        hasLoadedReminderSettingsForCurrentSession = false
        isLoadingReminderSettings = false
        reminderSettingsLoadError = nil
        reminderSettingsRequestID += 1
        calendarDeliveryRequestID += 1
        calendarNoticeVersion += 1
        hasRegisteredPushDevice = false
        pushDeviceRevoked = false
        errorMessage = nil
        calendarSyncDelivery = []
        calendarConnections = []
        calendarSyncLimitations = []
        calendarStatusError = nil
        calendarActionNotice = nil
        calendarSyncNotice = nil
        googleHandoffAwaitingReturn = false
    }

    private func upsert(_ item: WorkspaceItem) {
        itemRevision += 1
        if let index = items.firstIndex(where: { $0.id == item.id }) {
            items[index] = item
        } else {
            items.append(item)
        }
    }

    private func pushDeviceKey(for userId: String) -> String { "filetasks.push-device.\(userId)" }
    private func pushDeviceRevokedKey(for userId: String) -> String { "filetasks.push-device-revoked.\(userId)" }
}
