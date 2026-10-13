import Foundation

struct APIClient {
    let baseURL: URL
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func register(email: String, password: String) async throws -> AuthResponse {
        try decode(
            AuthResponse.self,
            from: try await perform(
                path: ["api", "auth", "register"],
                method: "POST",
                body: try encoder.encode(AuthCredentials(email: email, password: password))
            )
        )
    }

    func login(email: String, password: String) async throws -> AuthResponse {
        try decode(
            AuthResponse.self,
            from: try await perform(
                path: ["api", "auth", "login"],
                method: "POST",
                body: try encoder.encode(AuthCredentials(email: email, password: password))
            )
        )
    }

    func currentSession(token: String) async throws -> SessionResponse {
        try decode(
            SessionResponse.self,
            from: try await perform(path: ["api", "auth", "session"], method: "GET", token: token)
        )
    }

    func logout(token: String) async throws {
        _ = try await perform(path: ["api", "auth", "logout"], method: "POST", token: token)
    }

    func items(token: String) async throws -> [WorkspaceItem] {
        let response: ItemsResponse = try decode(
            ItemsResponse.self,
            from: try await perform(path: ["api", "items"], method: "GET", token: token)
        )
        return response.items
    }

    func files(token: String) async throws -> [WorkspaceFile] {
        let response: FilesResponse = try decode(
            FilesResponse.self,
            from: try await perform(path: ["api", "files"], method: "GET", token: token)
        )
        return response.files
    }

    func reminderSettings(token: String) async throws -> ReminderSettings {
        let response: ReminderSettingsResponse = try decode(
            ReminderSettingsResponse.self,
            from: try await perform(path: ["api", "settings", "reminders"], method: "GET", token: token)
        )
        return response.settings
    }

    func updateReminderSettings(_ settings: ReminderSettings, token: String, applyToExisting: Bool) async throws -> ReminderSettings {
        let payload = ReminderSettingsPayload(
            taskReminders: settings.taskReminders,
            eventReminders: settings.eventReminders,
            pushEnabled: settings.pushEnabled,
            emailEnabled: settings.emailEnabled,
            applyToExisting: applyToExisting
        )
        let response: ReminderSettingsResponse = try decode(
            ReminderSettingsResponse.self,
            from: try await perform(
                path: ["api", "settings", "reminders"], method: "PATCH", token: token,
                body: try encoder.encode(payload)
            )
        )
        return response.settings
    }

    func registerPushDevice(platform: String, pushToken: String, authToken: String) async throws -> PushDevice {
        let payload = PushDevicePayload(platform: platform, token: pushToken)
        let response: PushDeviceResponse = try decode(
            PushDeviceResponse.self,
            from: try await perform(path: ["api", "devices", "push"], method: "POST", token: authToken, body: try encoder.encode(payload))
        )
        return response.device
    }

    func revokePushDevice(id: String, token: String) async throws {
        _ = try await perform(path: ["api", "devices", "push", id], method: "DELETE", token: token)
    }

    func createLinkFile(name: String, url: String, token: String) async throws -> WorkspaceFile {
        let response: FileResponse = try decode(
            FileResponse.self,
            from: try await perform(
                path: ["api", "files"], method: "POST", token: token,
                body: try encoder.encode(LinkFilePayload(name: name, url: url))
            )
        )
        return response.file
    }

    func uploadFile(name: String, contentType: String, data: Data, token: String) async throws -> WorkspaceFile {
        let target: UploadTarget = try decode(
            UploadTarget.self,
            from: try await perform(
                path: ["api", "files", "uploads"], method: "POST", token: token,
                body: try encoder.encode(UploadPayload(name: name, contentType: contentType, sizeBytes: data.count))
            )
        )
        guard let uploadURL = URL(string: target.uploadUrl) else { throw APIClientError.invalidResponse }
        var request = URLRequest(url: uploadURL)
        request.httpMethod = "PUT"
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        do {
            let (_, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else { throw APIClientError.invalidResponse }
            guard (200..<300).contains(httpResponse.statusCode) else {
                throw APIClientError.httpStatus(httpResponse.statusCode, "The File could not be uploaded.")
            }
        } catch {
            _ = try? await perform(path: ["api", "files", target.uploadId], method: "DELETE", token: token)
            throw error
        }
        let completed: FileResponse = try decode(
            FileResponse.self,
            from: try await perform(path: ["api", "files", target.uploadId, "complete"], method: "POST", token: token)
        )
        return completed.file
    }

    func attachFile(id: String, to itemId: String, scope: EditScope = .occurrence, token: String) async throws {
        _ = try await perform(
            path: ["api", "files", id, "attachments"], method: "POST", token: token,
            body: try encoder.encode(AttachmentPayload(itemId: itemId, scope: scope.rawValue))
        )
    }

    func removeAttachment(fileId: String, itemId: String, scope: EditScope = .occurrence, token: String) async throws {
        _ = try await perform(path: ["api", "files", fileId, "attachments", itemId], method: "DELETE", token: token, queryItems: [URLQueryItem(name: "scope", value: scope.rawValue)])
    }

    func deleteFile(id: String, token: String) async throws {
        _ = try await perform(path: ["api", "files", id], method: "DELETE", token: token)
    }

    func openFile(id: String, token: String) async throws -> OpenFileTarget {
        try decode(
            OpenFileTarget.self,
            from: try await perform(path: ["api", "files", id, "open"], method: "GET", token: token)
        )
    }

    func createItem(_ payload: ItemPayload, token: String) async throws -> WorkspaceItem {
        let response: ItemResponse = try decode(
            ItemResponse.self,
            from: try await perform(
                path: ["api", "items"],
                method: "POST",
                token: token,
                body: try encoder.encode(payload)
            )
        )
        return response.item
    }

    func updateItem(id: String, payload: ItemPayload, token: String) async throws -> WorkspaceItem {
        let response: ItemResponse = try decode(
            ItemResponse.self,
            from: try await perform(
                path: ["api", "items", id],
                method: "PATCH",
                token: token,
                body: try encoder.encode(payload)
            )
        )
        return response.item
    }

    func updateCompletion(id: String, completed: Bool, token: String) async throws -> WorkspaceItem {
        let response: ItemResponse = try decode(
            ItemResponse.self,
            from: try await perform(
                path: ["api", "items", id],
                method: "PATCH",
                token: token,
                body: try encoder.encode(CompletionPayload(completed: completed))
            )
        )
        return response.item
    }

    func deleteItem(id: String, scope: EditScope? = nil, token: String) async throws {
        _ = try await perform(
            path: ["api", "items", id], method: "DELETE", token: token,
            queryItems: scope.map { [URLQueryItem(name: "scope", value: $0.rawValue)] } ?? []
        )
    }

    private func perform(
        path: [String],
        method: String,
        token: String? = nil,
        body: Data? = nil,
        queryItems: [URLQueryItem] = []
    ) async throws -> Data {
        var url = path.reduce(baseURL) { partialURL, component in
            partialURL.appendingPathComponent(component)
        }
        if !queryItems.isEmpty, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            components.queryItems = queryItems
            if let withQuery = components.url { url = withQuery }
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIClientError.transport(error.localizedDescription)
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIClientError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            let serverMessage = (try? decoder.decode(APIErrorResponse.self, from: data))?.error
            throw APIClientError.httpStatus(httpResponse.statusCode, serverMessage)
        }
        return data
    }

    private func decode<Response: Decodable>(
        _ type: Response.Type,
        from data: Data
    ) throws -> Response {
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw APIClientError.invalidPayload(error.localizedDescription)
        }
    }
}

struct AuthCredentials: Encodable {
    let email: String
    let password: String
}

struct AuthResponse: Decodable {
    let token: String
    let user: AuthUser
}

struct SessionResponse: Decodable {
    let user: AuthUser
}

struct AuthUser: Decodable, Equatable {
    let id: String
    let email: String
}

private struct ItemsResponse: Decodable {
    let items: [WorkspaceItem]
}

private struct ItemResponse: Decodable {
    let item: WorkspaceItem
}

private struct APIErrorResponse: Decodable {
    let error: String
}

private struct CompletionPayload: Encodable {
    let completed: Bool
}

private struct FilesResponse: Decodable { let files: [WorkspaceFile] }
private struct ReminderSettingsResponse: Decodable { let settings: ReminderSettings }
private struct ReminderSettingsPayload: Encodable {
    let taskReminders: [ReminderRule]
    let eventReminders: [ReminderRule]
    let pushEnabled: Bool
    let emailEnabled: Bool
    let applyToExisting: Bool
}
struct PushDevice: Decodable, Identifiable { let id: String; let platform: String; let createdAt: String }
private struct PushDeviceResponse: Decodable { let device: PushDevice }
private struct PushDevicePayload: Encodable { let platform: String; let token: String }
private struct FileResponse: Decodable { let file: WorkspaceFile }
private struct UploadTarget: Decodable { let uploadId: String; let uploadUrl: String }
struct OpenFileTarget: Decodable { let url: String; let name: String; let contentType: String?; let sourceType: String }
private struct LinkFilePayload: Encodable { let name: String; let url: String }
private struct UploadPayload: Encodable { let name: String; let contentType: String; let sizeBytes: Int }
private struct AttachmentPayload: Encodable { let itemId: String; let scope: String }

enum APIClientError: LocalizedError {
    case transport(String)
    case invalidResponse
    case invalidPayload(String)
    case httpStatus(Int, String?)
    case missingToken
    case sessionChanged

    var statusCode: Int? {
        if case let .httpStatus(code, _) = self { return code }
        return nil
    }

    var errorDescription: String? {
        switch self {
        case let .transport(message):
            return "Could not reach the FileTasks server. \(message)"
        case .invalidResponse:
            return "The server returned an invalid response."
        case let .invalidPayload(message):
            return "The server response could not be read. \(message)"
        case let .httpStatus(code, message):
            return message ?? "The server returned HTTP \(code)."
        case .missingToken:
            return "Your sign-in has expired. Sign in again to continue."
        case .sessionChanged:
            return "Your sign-in changed before this request finished. Try again."
        }
    }
}
