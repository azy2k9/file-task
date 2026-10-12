import SwiftUI

private enum ItemFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case tasks = "Tasks"
    case events = "Events"

    var id: String { rawValue }

    func includes(_ item: WorkspaceItem) -> Bool {
        switch self {
        case .all: return true
        case .tasks: return item.kind == .task
        case .events: return item.kind == .event
        }
    }
}

private struct AgendaGroup: Identifiable {
    let key: String
    let items: [WorkspaceItem]

    var id: String { key }
}

struct WorkspaceView: View {
    @EnvironmentObject private var model: AppModel
    let openServerSettings: () -> Void

    @State private var filter: ItemFilter = .all
    @State private var showingEditor = false
    @State private var editingItem: WorkspaceItem?
    @State private var newItemKind: WorkspaceItemKind = .task
    @State private var itemPendingDeletion: WorkspaceItem?
    @State private var showingLogoutConfirmation = false

    private var filteredItems: [WorkspaceItem] {
        model.items.filter { filter.includes($0) }
    }

    private var groups: [AgendaGroup] {
        let dictionary = Dictionary(grouping: filteredItems) { $0.scheduledDate ?? "undated" }
        let keys = dictionary.keys.sorted { lhs, rhs in
            if lhs == "undated" { return false }
            if rhs == "undated" { return true }
            return lhs < rhs
        }
        return keys.map { key in
            let sortedItems = (dictionary[key] ?? []).sorted { lhs, rhs in
                switch (lhs.scheduledTime, rhs.scheduledTime) {
                case let (left?, right?) where left != right: return left < right
                case (.none, .some): return true
                case (.some, .none): return false
                default: return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
                }
            }
            return AgendaGroup(key: key, items: sortedItems)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if let error = model.errorMessage {
                    Section {
                        ErrorBanner(message: error, dismiss: model.dismissError)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    }
                }

                Section {
                    Picker("Show", selection: $filter) {
                        ForEach(ItemFilter.allCases) { option in
                            Text(option.rawValue).tag(option)
                        }
                    }
                    .pickerStyle(.segmented)
                    .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
                }

                if model.isLoadingItems && model.items.isEmpty {
                    Section {
                        ProgressView("Loading your workspace…")
                            .frame(maxWidth: .infinity)
                            .listRowBackground(Color.clear)
                    }
                } else if groups.isEmpty {
                    Section {
                        VStack(spacing: 8) {
                            Image(systemName: filter == .events ? "calendar" : "checklist")
                                .font(.system(size: 32))
                                .foregroundStyle(.secondary)
                            Text(emptyTitle)
                                .font(.headline)
                            Text("Use + to add one, or pull down to refresh your workspace.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 28)
                        .listRowBackground(Color.clear)
                    }
                } else {
                    ForEach(groups) { group in
                        Section(group.key == "undated" ? "Undated" : AgendaDate.title(for: group.key)) {
                            ForEach(group.items) { item in
                                itemRow(item)
                                    .swipeActions(edge: .trailing) {
                                        Button(role: .destructive) {
                                            itemPendingDeletion = item
                                        } label: {
                                            Label("Delete", systemImage: "trash")
                                        }
                                    }
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .refreshable { await model.refreshItems() }
            .navigationTitle("Workspace")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Menu {
                        Button(action: openServerSettings) {
                            Label("Server settings", systemImage: "server.rack")
                        }
                        Button(role: .destructive) {
                            showingLogoutConfirmation = true
                        } label: {
                            Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel("Account options")
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Menu {
                        Button { beginCreating(.task) } label: {
                            Label("New Task", systemImage: "checkmark.circle")
                        }
                        Button { beginCreating(.event) } label: {
                            Label("New Event", systemImage: "calendar.badge.plus")
                        }
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("Create item")
                }
            }
            .sheet(isPresented: $showingEditor, onDismiss: { editingItem = nil }) {
                ItemEditorView(item: editingItem, initialKind: newItemKind)
            }
            .confirmationDialog(
                "Delete this \(itemPendingDeletion?.kind.title.lowercased() ?? "item")?",
                isPresented: Binding(
                    get: { itemPendingDeletion != nil },
                    set: { if !$0 { itemPendingDeletion = nil } }
                ),
                titleVisibility: .visible
            ) {
                if let item = itemPendingDeletion {
                    Button("Delete", role: .destructive) {
                        Task { await model.delete(item) }
                        itemPendingDeletion = nil
                    }
                }
                Button("Cancel", role: .cancel) { itemPendingDeletion = nil }
            }
            .confirmationDialog("Sign out of FileTasks?", isPresented: $showingLogoutConfirmation) {
                Button("Sign out", role: .destructive) {
                    Task { await model.logout() }
                }
                Button("Cancel", role: .cancel) { }
            }
        }
    }

    private var emptyTitle: String {
        switch filter {
        case .all: return "Your workspace is empty"
        case .tasks: return "No Tasks yet"
        case .events: return "No Events yet"
        }
    }

    @ViewBuilder
    private func itemRow(_ item: WorkspaceItem) -> some View {
        HStack(alignment: .top, spacing: 12) {
            if item.kind == .task {
                Button {
                    Task { await model.setCompleted(item, to: item.completed != true) }
                } label: {
                    Image(systemName: item.completed == true ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(item.completed == true ? Color.accentColor : Color.secondary)
                        .frame(width: 28, height: 30)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(item.completed == true ? "Reopen Task" : "Complete Task")
            } else {
                Image(systemName: "calendar")
                    .font(.body)
                    .foregroundStyle(.tint)
                    .frame(width: 28, height: 30)
            }

            Button {
                editingItem = item
                showingEditor = true
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 7) {
                        Text(item.title)
                            .font(.body.weight(.medium))
                            .foregroundStyle(item.kind == .task && item.completed == true ? .secondary : .primary)
                            .strikethrough(item.kind == .task && item.completed == true)
                        Text(item.kind.title)
                            .font(.caption2.weight(.medium))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(item.kind == .task ? Color.blue.opacity(0.12) : Color.purple.opacity(0.12), in: Capsule())
                    }
                    if !item.details.isEmpty {
                        Text(item.details)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                    if let time = item.scheduledTime {
                        Text(time)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if item.scheduledDate != nil {
                        Text("All day")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens item details")
        }
        .padding(.vertical, 3)
    }

    private func beginCreating(_ kind: WorkspaceItemKind) {
        editingItem = nil
        newItemKind = kind
        showingEditor = true
    }
}
