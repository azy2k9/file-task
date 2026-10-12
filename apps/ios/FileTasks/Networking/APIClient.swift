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

    func deleteItem(id: String, token: String) async throws {
        _ = try await perform(path: ["api", "items", id], method: "DELETE", token: token)
    }

    private func perform(
        path: [String],
        method: String,
        token: String? = nil,
        body: Data? = nil
    ) async throws -> Data {
        let url = path.reduce(baseURL) { partialURL, component in
            partialURL.appendingPathComponent(component)
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
