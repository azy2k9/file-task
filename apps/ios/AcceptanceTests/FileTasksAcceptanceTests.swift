import Foundation
import XCTest
@testable import FileTasksNativeAcceptanceClient

final class FileTasksAcceptanceTests: XCTestCase {
    func testNativeClientRunsSharedReminderRecurrenceAttachmentAndPushWorkflow() async throws {
        guard let rawURL = ProcessInfo.processInfo.environment["FILETASKS_TEST_API_URL"],
              let baseURL = URL(string: rawURL) else {
            XCTFail("Set FILETASKS_TEST_API_URL to the shared acceptance API.")
            return
        }

        let client = APIClient(baseURL: baseURL)
        let password = ProcessInfo.processInfo.environment["FILETASKS_TEST_PASSWORD"] ?? "correct-horse-battery"
        let email = ProcessInfo.processInfo.environment["FILETASKS_TEST_EMAIL"] ?? "ios-acceptance-\(UUID().uuidString)@example.com"
        let namespace = ProcessInfo.processInfo.environment["FILETASKS_TEST_NAMESPACE"] ?? UUID().uuidString
        let auth = ProcessInfo.processInfo.environment["FILETASKS_TEST_EMAIL"] == nil
            ? try await client.register(email: email, password: password)
            : try await client.login(email: email, password: password)
        let token = auth.token
        let available = try await client.reminderSettings(token: token)
        XCTAssertTrue(available.pushAvailable, "The shared test API must use the shared fake push adapter.")

        let reminder = ReminderRule(delivery: .notification, amount: 1, unit: .days, time: "09:00")
        let settings = ReminderSettings(
            taskReminders: [reminder], eventReminders: [reminder], pushEnabled: true, emailEnabled: false,
            pushAvailable: available.pushAvailable, emailAvailable: available.emailAvailable
        )
        let savedSettings = try await client.updateReminderSettings(settings, token: token, applyToExisting: false)
        XCTAssertTrue(savedSettings.pushEnabled)
        XCTAssertEqual(savedSettings.taskReminders, [reminder])
        XCTAssertEqual(savedSettings.eventReminders, [reminder])

        let device = try await client.registerPushDevice(platform: "ios", pushToken: "ios-acceptance-\(UUID().uuidString)", authToken: token)
        XCTAssertEqual(device.platform, "ios")

        let recurrence = RecurrenceRule(interval: 1, unit: .weeks, weekdays: [1], end: .count(4))
        let root = try await client.createItem(ItemPayload(
            kind: .event, title: "Cross-platform Event \(namespace)", details: "Shared API workflow",
            scheduledDate: "2026-11-02", scheduledTime: "10:00", recurrence: recurrence,
            reminders: [reminder], scope: nil
        ), token: token)
        let occurrences = try await client.items(token: token).filter { $0.seriesId == root.id }
        XCTAssertEqual(occurrences.count, 4)
        guard let selected = occurrences.first(where: { $0.id != root.id }) else {
            XCTFail("The shared API did not materialize the recurring Occurrences.")
            return
        }

        let occurrenceEdit = try await client.updateItem(
            id: selected.id,
            payload: ItemPayload(
                kind: .event, title: "Edited on iOS", details: selected.details,
                scheduledDate: selected.scheduledDate, scheduledTime: selected.scheduledTime,
                recurrence: recurrence, reminders: selected.reminders, scope: .occurrence
            ),
            token: token
        )
        XCTAssertEqual(occurrenceEdit.title, "Edited on iOS")
        let otherClientItems = try await APIClient(baseURL: baseURL).items(token: token)
        XCTAssertEqual(otherClientItems.first(where: { $0.id == selected.id })?.title, "Edited on iOS")
        XCTAssertEqual(otherClientItems.first(where: { $0.id == root.id })?.title, root.title)

        let bytes = Data("FileTasks iOS upload \(namespace)".utf8)
        let file = try await client.uploadFile(name: "iOS upload \(namespace).txt", contentType: "text/plain", data: bytes, token: token)
        try await client.attachFile(id: file.id, to: root.id, scope: .series, token: token)
        var sharedItems = try await client.items(token: token)
        XCTAssertTrue(sharedItems.filter { $0.seriesId == root.id }.allSatisfy { $0.files.contains(where: { $0.id == file.id }) })
        try await client.removeAttachment(fileId: file.id, itemId: selected.id, scope: .occurrence, token: token)
        sharedItems = try await APIClient(baseURL: baseURL).items(token: token)
        XCTAssertFalse(sharedItems.first(where: { $0.id == selected.id })?.files.contains(where: { $0.id == file.id }) ?? true)
        XCTAssertTrue(sharedItems.first(where: { $0.id == occurrences.last?.id })?.files.contains(where: { $0.id == file.id }) ?? false)
        let openTarget = try await client.openFile(id: file.id, token: token)
        let (downloadedBytes, downloadResponse) = try await URLSession.shared.data(from: try XCTUnwrap(URL(string: openTarget.url)))
        XCTAssertEqual((downloadResponse as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(downloadedBytes, bytes)

        let dueTask = try await client.createItem(ItemPayload(
            kind: .task, title: "Native due push \(namespace)", details: "Delivery boundary check",
            scheduledDate: "2026-10-12", scheduledTime: nil, recurrence: nil,
            reminders: [ReminderRule(delivery: .notification, amount: 0, unit: .days, time: "08:00")], scope: nil
        ), token: token)
        XCTAssertEqual(dueTask.kind, .task)
        var workerRequest = URLRequest(url: baseURL.appendingPathComponent("api/internal/reminders/deliver"))
        workerRequest.httpMethod = "POST"
        workerRequest.setValue("Bearer \(ProcessInfo.processInfo.environment["FILETASKS_TEST_WORKER_SECRET"] ?? "test-worker-secret")", forHTTPHeaderField: "Authorization")
        let (workerData, workerResponse) = try await URLSession.shared.data(for: workerRequest)
        XCTAssertEqual((workerResponse as? HTTPURLResponse)?.statusCode, 200)
        let workerResult = try XCTUnwrap(JSONSerialization.jsonObject(with: workerData) as? [String: Int])
        XCTAssertGreaterThanOrEqual(workerResult["sent"] ?? 0, 1)

        try await client.revokePushDevice(id: device.id, token: token)
        try await client.logout(token: token)
    }
}
