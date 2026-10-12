import SwiftUI

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
            scheduledTime: includesDate && includesTime ? AgendaDate.timeString(from: time) : nil
        )
        do {
            try await model.save(draft, editing: item)
            dismiss()
        } catch {
            // Keep every field in place so the person can retry or revise the edit.
            errorMessage = error.localizedDescription
        }
    }
}
