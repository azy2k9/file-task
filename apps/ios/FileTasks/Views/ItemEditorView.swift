import SwiftUI
import UIKit
import UserNotifications

struct ItemEditorView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    let item: WorkspaceItem?

    @State private var kind: WorkspaceItemKind
    @State private var title: String
    @State private var details: String
    @State private var includesDate: Bool
    @State private var date: Date
    @State private var includesTime: Bool
    @State private var time: Date
    @State private var recurrence: RecurrenceRule?
    @State private var recurrenceEndType: String
    @State private var recurrenceEndDate: Date
    @State private var recurrenceCount: Int
    @State private var weekdays: Set<Int>
    @State private var reminders: [ReminderRule]
    @State private var scope: EditScope
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(item: WorkspaceItem?, initialKind: WorkspaceItemKind) {
        self.item = item
        _kind = State(initialValue: item?.kind ?? initialKind)
        _title = State(initialValue: item?.title ?? "")
        _details = State(initialValue: item?.details ?? "")
        _includesDate = State(initialValue: item?.scheduledDate != nil)
        _date = State(initialValue: item?.scheduledDate.flatMap { AgendaDate.date(from: $0) } ?? Date())
        _includesTime = State(initialValue: item?.scheduledTime != nil)
        _time = State(initialValue: item?.scheduledTime.flatMap { AgendaDate.time(from: $0) } ?? Date())
        _recurrence = State(initialValue: item?.recurrence)
        switch item?.recurrence?.end {
        case let .date(value):
            _recurrenceEndType = State(initialValue: "date")
            _recurrenceEndDate = State(initialValue: AgendaDate.date(from: value) ?? Date())
            _recurrenceCount = State(initialValue: 10)
        case let .count(value):
            _recurrenceEndType = State(initialValue: "count")
            _recurrenceEndDate = State(initialValue: Date())
            _recurrenceCount = State(initialValue: value)
        default:
            _recurrenceEndType = State(initialValue: "never")
            _recurrenceEndDate = State(initialValue: Date())
            _recurrenceCount = State(initialValue: 10)
        }
        _weekdays = State(initialValue: Set(item?.recurrence?.weekdays ?? []))
        _reminders = State(initialValue: item?.reminders ?? [])
        _scope = State(initialValue: .occurrence)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section {
                        ErrorBanner(message: errorMessage) {
                            self.errorMessage = nil
                        }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                    }
                }

                Section(item == nil ? "New item" : "Item") {
                    if item == nil {
                        Picker("Type", selection: $kind) {
                            ForEach(WorkspaceItemKind.allCases) { option in
                                Text(option.title).tag(option)
                            }
                        }
                    } else {
                        LabeledContent("Type", value: kind.title)
                    }

                    TextField("Title", text: $title)
                        .textInputAutocapitalization(.sentences)
                        .submitLabel(.next)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Details")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        TextEditor(text: $details)
                            .frame(minHeight: 120)
                            .accessibilityLabel("Details")
                    }
                }

                Section {
                    Toggle("Add date", isOn: $includesDate)
                        .onChange(of: includesDate) { isEnabled in
                            if !isEnabled { includesTime = false }
                        }
                    if includesDate {
                        DatePicker("Date", selection: $date, displayedComponents: .date)
                    }

                    Toggle("Add time", isOn: $includesTime)
                        .disabled(!includesDate)
                    if includesTime {
                        DatePicker("Time", selection: $time, displayedComponents: .hourAndMinute)
                    }
                } header: {
                    Text("Schedule")
                } footer: {
                    Text("Dates and times use your device’s local time. Leave both off for an undated item; a date without a time is all day.")
                }

                Section("Recurrence rule") {
                    Toggle("Repeat", isOn: Binding(
                        get: { recurrence != nil },
                        set: { enabled in
                            if enabled {
                                let weekday = Calendar.current.component(.weekday, from: date) - 1
                                recurrence = RecurrenceRule(interval: 1, unit: .weeks, weekdays: [weekday], end: .never)
                                weekdays = [weekday]
                            } else { recurrence = nil }
                        }
                    ))
                    .disabled(!includesDate)
                if let rule = recurrence {
                        Stepper("Every \(rule.interval)", value: Binding(
                            get: { recurrence?.interval ?? 1 },
                            set: { recurrence?.interval = min(100, max(1, $0)) }
                        ), in: 1...100)
                        Picker("Interval", selection: Binding(
                            get: { recurrence?.unit ?? .weeks },
                            set: { unit in
                                recurrence?.unit = unit
                                if unit == .weeks && weekdays.isEmpty { weekdays = [Calendar.current.component(.weekday, from: date) - 1] }
                            }
                        )) {
                            ForEach(RecurrenceUnit.allCases) { unit in Text(unit.rawValue.capitalized).tag(unit) }
                        }
                        if rule.unit == .weeks {
                            HStack {
                                ForEach(0..<7, id: \.self) { weekday in
                                    Button(["S", "M", "T", "W", "T", "F", "S"][weekday]) {
                                        if weekdays.contains(weekday) {
                                            if weekdays.count > 1 { weekdays.remove(weekday) }
                                        } else { weekdays.insert(weekday) }
                                    }
                                    .buttonStyle(.borderedProminent)
                                    .tint(weekdays.contains(weekday) ? .accentColor : .gray.opacity(0.35))
                                    .accessibilityLabel(Calendar.current.weekdaySymbols[weekday])
                                }
                            }
                        }
                        Picker("Ends", selection: $recurrenceEndType) {
                            Text("Never").tag("never")
                            Text("On date").tag("date")
                            Text("After occurrences").tag("count")
                        }
                        if recurrenceEndType == "date" {
                            DatePicker("End date", selection: $recurrenceEndDate, displayedComponents: .date)
                        } else if recurrenceEndType == "count" {
                            Stepper("Occurrences: \(recurrenceCount)", value: $recurrenceCount, in: 1...10_000)
                        }
                    }
                }

                if item?.seriesId != nil {
                    Section("Apply changes to") {
                        Picker("Edit scope", selection: $scope) {
                            ForEach(EditScope.allCases) { option in Text(option.title).tag(option) }
                        }
                    }
                }

                Section("Reminders") {
                    ReminderListEditor(
                        reminders: $reminders,
                        emailAvailable: model.reminderSettings.emailAvailable && model.reminderSettings.emailEnabled
                    )
                }
            }
            .navigationTitle(item == nil ? "Create \(kind.title)" : "Edit \(kind.title)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await save() }
                    } label: {
                        if isSaving {
                            ProgressView()
                        } else {
                            Text("Save")
                        }
                    }
                    .disabled(isSaving)
                }
            }
        }
        .interactiveDismissDisabled(isSaving)
        .onAppear {
            if item == nil && reminders.isEmpty {
                reminders = kind == .task ? model.reminderSettings.taskReminders : model.reminderSettings.eventReminders
            }
        }
    }

    @MainActor
    private func save() async {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else {
            errorMessage = "Enter a title before saving."
            return
        }

        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        let draft = ItemDraft(
            kind: kind,
            title: trimmedTitle,
            details: details,
            scheduledDate: includesDate ? AgendaDate.dateString(from: date) : nil,
            scheduledTime: includesDate && includesTime ? AgendaDate.timeString(from: time) : nil,
            recurrence: makeRecurrence(),
            reminders: reminders,
            scope: item?.seriesId == nil ? nil : scope
        )
        do {
            try await model.save(draft, editing: item)
            dismiss()
        } catch {
            // Keep every field in place so the person can retry or revise the edit.
            errorMessage = error.localizedDescription
        }
    }

    private func makeRecurrence() -> RecurrenceRule? {
        guard includesDate, var rule = recurrence else { return nil }
        if rule.unit == .weeks { rule.weekdays = weekdays.sorted() } else { rule.weekdays = nil }
        switch recurrenceEndType {
        case "date": rule.end = .date(AgendaDate.dateString(from: recurrenceEndDate))
        case "count": rule.end = .count(recurrenceCount)
        default: rule.end = .never
        }
        return rule
    }
}

private struct ReminderListEditor: View {
    @Binding var reminders: [ReminderRule]
    let emailAvailable: Bool

    var body: some View {
        ForEach(Array(reminders.enumerated()), id: \.offset) { index, _ in
            VStack(alignment: .leading, spacing: 8) {
                Picker("Delivery", selection: $reminders[index].delivery) {
                    Text("Notification").tag(ReminderDelivery.notification)
                    if emailAvailable || reminders[index].delivery == .email { Text("Email").tag(ReminderDelivery.email) }
                }
                HStack {
                    Stepper("\(reminders[index].amount)", value: $reminders[index].amount, in: 0...100_000)
                    Picker("Unit", selection: $reminders[index].unit) {
                        ForEach(ReminderUnit.allCases) { unit in Text(unit.rawValue).tag(unit) }
                    }
                }
                DatePicker("Clock time", selection: Binding(
                    get: { AgendaDate.time(from: reminders[index].time) ?? Date() },
                    set: { reminders[index].time = AgendaDate.timeString(from: $0) }
                ), displayedComponents: .hourAndMinute)
                Button("Remove Reminder", role: .destructive) { reminders.remove(at: index) }
            }
        }
        Button("Add Reminder") {
            reminders.append(ReminderRule(delivery: .notification, amount: 1, unit: .days, time: "09:00"))
        }
        .disabled(reminders.count >= 20)
    }
}

struct ReminderSettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var settings = ReminderSettings.empty
    @State private var applyToExisting = false
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
                Section("Delivery") {
                    Toggle("Push delivery", isOn: $settings.pushEnabled)
                        .disabled(isSaving || !settings.pushAvailable)
                    if !settings.pushAvailable { Text("Push delivery is not configured on this server.").font(.footnote).foregroundStyle(.secondary) }
                    Toggle("Email delivery", isOn: $settings.emailEnabled)
                        .disabled(isSaving || !settings.emailAvailable)
                    if !settings.emailAvailable { Text("Email delivery is not configured on this server.").font(.footnote).foregroundStyle(.secondary) }
                    if model.hasRegisteredPushDevice {
                        Button("Revoke this device's push registration", role: .destructive) {
                            Task {
                                do {
                                    try await model.revokeCurrentPushDevice()
                                    UIApplication.shared.unregisterForRemoteNotifications()
                                } catch { errorMessage = error.localizedDescription }
                            }
                        }.disabled(isSaving)
                    } else if model.pushDeviceRevoked && settings.pushEnabled {
                        Button("Register this device for push delivery") {
                            Task {
                                do {
                                    let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
                                    guard granted else { throw NSError(domain: "FileTasksPush", code: 1, userInfo: [NSLocalizedDescriptionKey: "Allow notifications to register this device for push delivery."]) }
                                    try model.allowPushDeviceRegistration()
                                    UIApplication.shared.registerForRemoteNotifications()
                                } catch { errorMessage = error.localizedDescription }
                            }
                        }.disabled(isSaving)
                    }
                }
                Section("Task defaults") {
                    ReminderListEditor(reminders: $settings.taskReminders, emailAvailable: settings.emailAvailable && settings.emailEnabled)
                }
                Section("Event defaults") {
                    ReminderListEditor(reminders: $settings.eventReminders, emailAvailable: settings.emailAvailable && settings.emailEnabled)
                }
                Section("Existing items") {
                    Toggle("Apply defaults to items still using the old defaults", isOn: $applyToExisting)
                }
            }
            .navigationTitle("Reminder settings")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(isSaving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }.disabled(isSaving)
                }
            }
        }
        .onAppear { settings = model.reminderSettings }
    }

    @MainActor private func save() async {
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            let shouldRegisterDevice = settings.pushEnabled && !model.hasRegisteredPushDevice
                && (!model.pushDeviceRevoked || !model.reminderSettings.pushEnabled)
            if shouldRegisterDevice {
                let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
                guard granted else { throw NSError(domain: "FileTasksPush", code: 1, userInfo: [NSLocalizedDescriptionKey: "Allow notifications to register this device for push delivery."]) }
            }
            try await model.saveReminderSettings(settings, applyToExisting: applyToExisting)
            if shouldRegisterDevice { UIApplication.shared.registerForRemoteNotifications() }
            dismiss()
        } catch { errorMessage = error.localizedDescription }
    }
}
