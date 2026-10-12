import Foundation
import Combine

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var user: AuthUser?
    @Published private(set) var items: [WorkspaceItem] = []
    @Published private(set) var files: [WorkspaceFile] = []
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
    private var authenticationAttemptID: UUID?

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
        }
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

    func delete(_ item: WorkspaceItem) async {
        let context: SessionContext
        do {
            context = try currentContext()
        } catch {
            errorMessage = error.localizedDescription
            return
        }

        do {
            try await APIClient(baseURL: context.baseURL).deleteItem(id: item.id, token: context.token)
            guard isCurrent(context) else { return }
            items.removeAll { $0.id == item.id }
            itemRevision += 1
            await refreshItems(using: context)
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

    func attachFile(_ file: WorkspaceFile, to item: WorkspaceItem) async throws {
        let context = try currentContext()
        do {
            try await APIClient(baseURL: context.baseURL).attachFile(id: file.id, to: item.id, token: context.token)
            guard isCurrent(context) else { throw APIClientError.sessionChanged }
            await refreshItems(using: context)
        } catch {
            handle(error, for: context)
            throw error
        }
    }

    func removeAttachment(_ attachment: FileAttachment, from file: WorkspaceFile) async throws {
        let context = try currentContext()
        do {
            try await APIClient(baseURL: context.baseURL).removeAttachment(
                fileId: file.id, itemId: attachment.itemId, token: context.token
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
            try await APIClient(baseURL: context.baseURL).logout(token: context.token)
            guard isCurrent(context) else { return }
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
        let revisionAtStart = itemRevision
        let fileRevisionAtStart = fileRevision
        isLoadingItems = true
        defer {
            if isCurrent(context), refreshRequestID == requestID { isLoadingItems = false }
        }

        do {
            let api = APIClient(baseURL: context.baseURL)
            async let itemsRequest = api.items(token: context.token)
            async let filesRequest = api.files(token: context.token)
            let (refreshedItems, refreshedFiles) = try await (itemsRequest, filesRequest)
            guard isCurrent(context),
                  refreshRequestID == requestID,
                  itemRevision == revisionAtStart,
                  fileRevision == fileRevisionAtStart else { return }
            items = refreshedItems
            files = refreshedFiles
            errorMessage = nil
        } catch {
            guard isCurrent(context),
                  refreshRequestID == requestID,
                  itemRevision == revisionAtStart,
                  fileRevision == fileRevisionAtStart else { return }
            handle(error, for: context)
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

    private func isCurrent(_ context: SessionContext) -> Bool {
        context.generation == sessionGeneration && user != nil
    }

    private func activateSession(token: String, baseURL: URL, user: AuthUser) -> SessionContext {
        sessionGeneration += 1
        self.user = user
        items = []
        files = []
        isLoadingItems = false
        errorMessage = nil
        return SessionContext(generation: sessionGeneration, token: token, baseURL: baseURL)
    }

    private func handle(_ error: Error, for context: SessionContext) {
        guard isCurrent(context) else { return }
        handle(error, forGeneration: context.generation)
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
        errorMessage = nil
    }

    private func upsert(_ item: WorkspaceItem) {
        itemRevision += 1
        if let index = items.firstIndex(where: { $0.id == item.id }) {
            items[index] = item
        } else {
            items.append(item)
        }
    }
}
