import SwiftUI
import UniformTypeIdentifiers
import UIKit

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

private enum WorkspaceSection: String, CaseIterable, Identifiable {
    case agenda = "Agenda"
    case files = "Files"
    var id: String { rawValue }
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
    @State private var section: WorkspaceSection = .agenda
    @State private var showingLinkForm = false
    @State private var linkName = ""
    @State private var linkURL = ""
    @State private var showingFileImporter = false
    @State private var fileToAttach: WorkspaceFile?
    @State private var fileToDelete: WorkspaceFile?
    @State private var attachmentToRemove: (file: WorkspaceFile, attachment: FileAttachment)?

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
                Section {
                    Picker("Section", selection: $section) {
                        ForEach(WorkspaceSection.allCases) { option in Text(option.rawValue).tag(option) }
                    }
                    .pickerStyle(.segmented)
                    .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
                }

                if section == .files {
                    filesContent
                } else {
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
            }
            .listStyle(.insetGrouped)
            .refreshable { await model.refreshItems() }
            .navigationTitle(section == .files ? "Files" : "Workspace")
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
                        if section == .agenda {
                            Button { beginCreating(.task) } label: { Label("New Task", systemImage: "checkmark.circle") }
                            Button { beginCreating(.event) } label: { Label("New Event", systemImage: "calendar.badge.plus") }
                        } else {
                            Button { showingFileImporter = true } label: { Label("Upload File", systemImage: "square.and.arrow.up") }
                            Button { showingLinkForm = true } label: { Label("Add external link", systemImage: "link") }
                        }
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel(section == .files ? "Add File" : "Create item")
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
            .fileImporter(isPresented: $showingFileImporter, allowedContentTypes: [.data], allowsMultipleSelection: false) { result in
                switch result {
                case let .success(urls):
                    guard let url = urls.first else { return }
                    upload(url)
                case let .failure(error):
                    model.errorMessage = error.localizedDescription
                }
            }
            .alert("Add an external link", isPresented: $showingLinkForm) {
                TextField("Name", text: $linkName)
                TextField("https://…", text: $linkURL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                Button("Add link") { saveLink() }
                Button("Cancel", role: .cancel) { }
            } message: {
                Text("Save a web link in your Files section.")
            }
            .confirmationDialog("Attach \(fileToAttach?.name ?? "File")", isPresented: Binding(
                get: { fileToAttach != nil }, set: { if !$0 { fileToAttach = nil } }
            )) {
                if let file = fileToAttach {
                    ForEach(model.items.filter { item in !file.attachments.contains(where: { $0.itemId == item.id }) }) { item in
                        Button("\(item.kind.title): \(item.title)") { Task { await attach(file, to: item) } }
                    }
                }
                Button("Cancel", role: .cancel) { fileToAttach = nil }
            } message: {
                Text("Choose a Task or Event for this Attachment.")
            }
            .confirmationDialog("Delete this File?", isPresented: Binding(
                get: { fileToDelete != nil }, set: { if !$0 { fileToDelete = nil } }
            ), titleVisibility: .visible) {
                if let file = fileToDelete {
                    Button("Delete File", role: .destructive) { Task { await deleteFile(file) } }
                }
                Button("Cancel", role: .cancel) { fileToDelete = nil }
            } message: {
                if let file = fileToDelete, file.attachments.count > 1 {
                    Text("This File is attached to \(file.attachments.count) Tasks or Events. Deleting it removes all of those Attachments.")
                } else if let file = fileToDelete, let attachment = file.attachments.first {
                    Text("Deleting this File also removes its Attachment from “\(attachment.itemTitle)”.")
                } else { Text("The File will be removed from your Files section.") }
            }
            .confirmationDialog("Remove this Attachment?", isPresented: Binding(
                get: { attachmentToRemove != nil }, set: { if !$0 { attachmentToRemove = nil } }
            ), titleVisibility: .visible) {
                if let target = attachmentToRemove {
                    Button("Remove Attachment") { Task { await removeAttachment(target.attachment, from: target.file) } }
                    Button("Delete File from Files section", role: .destructive) { Task { await deleteFile(target.file) } }
                }
                Button("Cancel", role: .cancel) { attachmentToRemove = nil }
            } message: {
                if let target = attachmentToRemove, target.file.attachments.count > 1 {
                    Text("Remove this Attachment from “\(target.attachment.itemTitle)” only, or delete the File and its Attachments from \(target.file.attachments.count) items.")
                } else if let target = attachmentToRemove {
                    Text("Remove this Attachment from “\(target.attachment.itemTitle)” only, or delete the File.")
                }
            }
        }
    }

    @ViewBuilder
    private var filesContent: some View {
        if let error = model.errorMessage {
            Section {
                ErrorBanner(message: error, dismiss: model.dismissError)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
        }
        if model.files.isEmpty {
            Section {
                VStack(spacing: 9) {
                    Image(systemName: "doc.on.doc")
                        .font(.system(size: 30))
                        .foregroundStyle(.secondary)
                    Text("Your Files have a home here.").font(.headline)
                    Text("Upload a document or add a link, then attach it to a Task or Event.")
                        .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Add an external link") { showingLinkForm = true }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
                .listRowBackground(Color.clear)
            }
        } else {
            ForEach(model.files) { file in
                Section {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(file.name).font(.body.weight(.medium))
                            Text(file.sizeBytes.map { "\($0 / 1000) KB · \(file.contentType ?? "")" } ?? "External link")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Open") { openFile(file.id) }
                    }
                    HStack {
                        Button("Attach") { fileToAttach = file }
                            .disabled(model.items.count == file.attachments.count)
                        Spacer()
                        Button("Delete File", role: .destructive) { fileToDelete = file }
                    }
                    if file.attachments.isEmpty {
                        Text("No Tasks or Events yet").font(.caption).foregroundStyle(.secondary)
                    } else {
                        ForEach(file.attachments) { attachment in
                            HStack {
                                Button("\(attachment.itemKind.title): \(attachment.itemTitle)") {
                                    guard let item = model.items.first(where: { $0.id == attachment.itemId }) else { return }
                                    section = .agenda
                                    filter = item.kind == .task ? .tasks : .events
                                    editingItem = item
                                    showingEditor = true
                                }
                                .buttonStyle(.plain)
                                Spacer()
                                Button("Remove") { attachmentToRemove = (file, attachment) }
                                    .font(.caption)
                            }
                        }
                    }
                } header: {
                    Label(file.name, systemImage: file.sourceType == "link" ? "link" : "doc")
                        .textCase(nil)
                }
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
        VStack(alignment: .leading, spacing: 5) {
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
          ForEach(item.files) { file in
              Button("▤  \(file.name)") { openFile(file.id) }
                  .font(.caption)
                  .buttonStyle(.borderless)
                  .padding(.leading, 40)
          }
        }
        .padding(.vertical, 3)
    }

    private func upload(_ url: URL) {
        Task {
            do {
                let (name, contentType, data) = try await Task.detached(priority: .userInitiated) { () throws -> (String, String, Data) in
                    let hasAccess = url.startAccessingSecurityScopedResource()
                    defer { if hasAccess { url.stopAccessingSecurityScopedResource() } }
                    if let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
                       let size = attributes[.size] as? NSNumber, size.int64Value > 50_000_000 {
                        throw CocoaError(.fileReadTooLarge, userInfo: [NSLocalizedDescriptionKey: "Files must be smaller than 50 MB."])
                    }
                    let data = try Data(contentsOf: url)
                    guard !data.isEmpty, data.count <= 50_000_000 else {
                        throw CocoaError(.fileReadTooLarge, userInfo: [NSLocalizedDescriptionKey: "Files must contain data and be smaller than 50 MB."])
                    }
                    let contentType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                    return (url.lastPathComponent, contentType, data)
                }.value
                try await model.uploadFile(name: name, contentType: contentType, data: data)
            } catch {
                model.errorMessage = error.localizedDescription
            }
        }
    }

    private func saveLink() {
        Task {
            do {
                try await model.saveLinkFile(name: linkName, url: linkURL)
                linkName = ""
                linkURL = ""
                showingLinkForm = false
            } catch { model.errorMessage = error.localizedDescription }
        }
    }

    private func attach(_ file: WorkspaceFile, to item: WorkspaceItem) async {
        do { try await model.attachFile(file, to: item); fileToAttach = nil }
        catch { model.errorMessage = error.localizedDescription }
    }

    private func removeAttachment(_ attachment: FileAttachment, from file: WorkspaceFile) async {
        do { try await model.removeAttachment(attachment, from: file); attachmentToRemove = nil }
        catch { model.errorMessage = error.localizedDescription }
    }

    private func deleteFile(_ file: WorkspaceFile) async {
        do { try await model.deleteFile(file); fileToDelete = nil; attachmentToRemove = nil }
        catch { model.errorMessage = error.localizedDescription }
    }

    private func openFile(_ id: String) {
        Task {
            do {
                let url = try await model.openFileURL(id: id)
                await UIApplication.shared.open(url)
            } catch { model.errorMessage = error.localizedDescription }
        }
    }

    private func beginCreating(_ kind: WorkspaceItemKind) {
        editingItem = nil
        newItemKind = kind
        showingEditor = true
    }
}
