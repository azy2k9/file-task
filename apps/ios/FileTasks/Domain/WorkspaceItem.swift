import Foundation

enum WorkspaceItemKind: String, Codable, CaseIterable, Identifiable {
    case task
    case event

    var id: String { rawValue }

    var title: String {
        switch self {
        case .task: return "Task"
        case .event: return "Event"
        }
    }
}

struct WorkspaceItem: Codable, Identifiable, Equatable {
    let id: String
    let kind: WorkspaceItemKind
    let title: String
    let details: String
    let scheduledDate: String?
    let scheduledTime: String?
    let completed: Bool?
    let createdAt: String
    let updatedAt: String
    var files: [WorkspaceFileSummary] = []
}

struct WorkspaceFileSummary: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let sourceType: String
}

struct FileAttachment: Codable, Identifiable, Equatable {
    let itemId: String
    let itemKind: WorkspaceItemKind
    let itemTitle: String

    var id: String { itemId }
}

struct WorkspaceFile: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let sourceType: String
    let contentType: String?
    let sizeBytes: Int64?
    let externalUrl: String?
    let createdAt: String
    let attachments: [FileAttachment]
}

struct ItemPayload: Encodable {
    let kind: WorkspaceItemKind
    let title: String
    let details: String
    let scheduledDate: String?
    let scheduledTime: String?

    enum CodingKeys: String, CodingKey {
        case kind
        case title
        case details
        case scheduledDate
        case scheduledTime
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encode(title, forKey: .title)
        try container.encode(details, forKey: .details)
        // The API distinguishes an explicitly empty schedule from an omitted field.
        try container.encode(scheduledDate, forKey: .scheduledDate)
        try container.encode(scheduledTime, forKey: .scheduledTime)
    }
}

struct ItemDraft {
    var kind: WorkspaceItemKind
    var title: String
    var details: String
    var scheduledDate: String?
    var scheduledTime: String?

    func payload() -> ItemPayload {
        ItemPayload(
            kind: kind,
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            details: details,
            scheduledDate: scheduledDate,
            scheduledTime: scheduledTime
        )
    }
}

enum AgendaDate {
    private static var wallCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar
    }

    static func date(from value: String) -> Date? {
        let parts = value.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var components = DateComponents()
        components.year = parts[0]
        components.month = parts[1]
        components.day = parts[2]
        return wallCalendar.date(from: components)
    }

    static func dateString(from date: Date) -> String {
        let parts = wallCalendar.dateComponents([.year, .month, .day], from: date)
        return String(
            format: "%04d-%02d-%02d",
            parts.year ?? 0,
            parts.month ?? 0,
            parts.day ?? 0
        )
    }

    static func time(from value: String) -> Date? {
        let parts = value.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return nil }
        var components = wallCalendar.dateComponents([.year, .month, .day], from: Date())
        components.hour = parts[0]
        components.minute = parts[1]
        components.second = 0
        return wallCalendar.date(from: components)
    }

    static func timeString(from date: Date) -> String {
        let parts = wallCalendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }

    static func title(for value: String) -> String {
        guard let date = date(from: value) else { return value }
        let calendar = wallCalendar
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInTomorrow(date) { return "Tomorrow" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }

        let formatter = DateFormatter()
        formatter.locale = Locale.current
        formatter.timeZone = .current
        formatter.calendar = wallCalendar
        formatter.dateFormat = "EEEE, MMM d, yyyy"
        return formatter.string(from: date)
    }
}
