import Foundation
import Combine

@MainActor
final class APISettings: ObservableObject {
    @Published var baseURLString: String {
        didSet { UserDefaults.standard.set(baseURLString, forKey: Self.baseURLDefaultsKey) }
    }

    @Published var allowsLocalHTTP: Bool {
        didSet { UserDefaults.standard.set(allowsLocalHTTP, forKey: Self.allowsHTTPDefaultsKey) }
    }

    private static let baseURLDefaultsKey = "FileTasks.apiBaseURL"
    private static let allowsHTTPDefaultsKey = "FileTasks.allowsLocalHTTP"

    init() {
        baseURLString = UserDefaults.standard.string(forKey: Self.baseURLDefaultsKey) ?? "https://localhost:3000"
        allowsLocalHTTP = UserDefaults.standard.bool(forKey: Self.allowsHTTPDefaultsKey)
    }

    func update(baseURLString: String, allowsLocalHTTP: Bool) {
        self.allowsLocalHTTP = allowsLocalHTTP
        self.baseURLString = baseURLString
    }

    func validatedBaseURL(
        for proposedValue: String? = nil,
        allowsHTTP proposedHTTPSetting: Bool? = nil
    ) throws -> URL {
        let value = (proposedValue ?? baseURLString).trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(),
              let host = components.host,
              !host.isEmpty,
              components.query == nil,
              components.fragment == nil,
              components.user == nil,
              components.password == nil,
              components.path.isEmpty || components.path == "/",
              let url = components.url else {
            throw APISettingsError.invalidURL
        }

        if scheme == "https" {
            return url
        }
        if scheme == "http", proposedHTTPSetting ?? allowsLocalHTTP {
            return url
        }
        throw APISettingsError.httpRequiresOptIn
    }
}

enum APISettingsError: LocalizedError {
    case invalidURL
    case httpRequiresOptIn

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Enter a server origin such as https://api.example.com, without a path."
        case .httpRequiresOptIn:
            return "Use HTTPS, or enable the local development HTTP option before using an http:// server."
        }
    }
}
