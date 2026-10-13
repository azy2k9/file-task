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

enum ReminderDelivery: String, Codable, CaseIterable, Identifiable {
    case notification
    case email
    var id: String { rawValue }
}

enum ReminderUnit: String, Codable, CaseIterable, Identifiable {
    case minutes
    case hours
    case days
    case weeks
    case months
    var id: String { rawValue }
}

struct ReminderRule: Codable, Equatable, Identifiable {
    var delivery: ReminderDelivery
    var amount: Int
    var unit: ReminderUnit
    var time: String
    var id: String { "\(delivery.rawValue)-\(amount)-\(unit.rawValue)-\(time)" }
}

enum RecurrenceUnit: String, Codable, CaseIterable, Identifiable {
    case days
    case weeks
    case months
    case years
    var id: String { rawValue }
}

enum RecurrenceEnd: Equatable, Codable {
    case never
    case date(String)
    case count(Int)

    private enum CodingKeys: String, CodingKey { case type, date, count }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(String.self, forKey: .type) {
        case "never": self = .never
        case "date": self = .date(try values.decode(String.self, forKey: .date))
        case "count": self = .count(try values.decode(Int.self, forKey: .count))
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: values, debugDescription: "Unknown Recurrence ending.")
        }
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .never: try values.encode("never", forKey: .type)
        case let .date(date):
            try values.encode("date", forKey: .type)
            try values.encode(date, forKey: .date)
        case let .count(count):
            try values.encode("count", forKey: .type)
            try values.encode(count, forKey: .count)
        }
    }
}

struct RecurrenceRule: Codable, Equatable {
    var interval: Int
    var unit: RecurrenceUnit
    var weekdays: [Int]?
    var end: RecurrenceEnd
}

enum EditScope: String, Codable, CaseIterable, Identifiable {
    case occurrence
    case following
    case series
    var id: String { rawValue }

    var title: String {
        switch self {
        case .occurrence: return "This Occurrence"
        case .following: return "This and following Occurrences"
        case .series: return "Whole series"
        }
    }
}

struct ReminderSettings: Codable, Equatable {
    var taskReminders: [ReminderRule]
    var eventReminders: [ReminderRule]
    var pushEnabled: Bool
    var emailEnabled: Bool
    var pushAvailable: Bool
    var emailAvailable: Bool

    static let empty = ReminderSettings(taskReminders: [], eventReminders: [], pushEnabled: false, emailEnabled: false, pushAvailable: false, emailAvailable: false)
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
    var recurrence: RecurrenceRule? = nil
    var reminders: [ReminderRule] = []
    var seriesId: String? = nil
    var occurrenceDate: String? = nil
    var isOccurrence: Bool = false
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
    var scope: String = "occurrence"

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
    let recurrence: RecurrenceRule?
    let reminders: [ReminderRule]
    let scope: EditScope?

    enum CodingKeys: String, CodingKey {
        case kind
        case title
        case details
        case scheduledDate
        case scheduledTime
        case recurrence
        case reminders
        case scope
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encode(title, forKey: .title)
        try container.encode(details, forKey: .details)
        // The API distinguishes an explicitly empty schedule from an omitted field.
        try container.encode(scheduledDate, forKey: .scheduledDate)
        try container.encode(scheduledTime, forKey: .scheduledTime)
        try container.encodeIfPresent(recurrence, forKey: .recurrence)
        try container.encode(reminders, forKey: .reminders)
        try container.encodeIfPresent(scope, forKey: .scope)
    }
}

struct ItemDraft {
    var kind: WorkspaceItemKind
    var title: String
    var details: String
    var scheduledDate: String?
    var scheduledTime: String?
    var recurrence: RecurrenceRule?
    var reminders: [ReminderRule]
    var scope: EditScope?

    func payload() -> ItemPayload {
        ItemPayload(
            kind: kind,
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            details: details,
            scheduledDate: scheduledDate,
            scheduledTime: scheduledTime,
            recurrence: recurrence,
            reminders: reminders,
            scope: scope
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
