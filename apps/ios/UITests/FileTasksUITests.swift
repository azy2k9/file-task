import XCTest

final class FileTasksReminderDefaultsUITests: XCTestCase {
    private let app = XCUIApplication()
    private let sharedEmail = "ios-ui-shared@example.com"
    private let registrationEmail = "ios-ui-registration@example.com"
    private let password = "correct-horse-battery"

    override func setUpWithError() throws {
        continueAfterFailure = false
        app.launch()
    }

    func testRegistrationSignInCrossTypeReminderPreservation() {
        configureLocalServerInApp()
        registerSecondAccountInApp()
        signOutInApp()
        signInInApp(email: sharedEmail)

        createTaskAndExerciseItsLifecycle()

        createEventBySwitchingFromTask(title: "UI Runner Event Default")
        assertReminder(amount: 3, unit: "weeks")
        saveCurrentItem()
        assertCalendarDeliveryNotice()

        openItem("UI Runner Event Default")
        assertReminder(amount: 3, unit: "weeks")
        cancelEditor()

        createEventBySwitchingFromTask(title: "UI Runner Customized Event", customizedAmount: 4)
        assertReminder(amount: 4, unit: "days")
        saveCurrentItem()

        openItem("UI Runner Customized Event")
        assertReminder(amount: 4, unit: "days")
        cancelEditor()

        createTaskBySwitchingFromEvent(title: "UI Runner Event To Task")
        assertReminder(amount: 2, unit: "days")
        saveCurrentItem()

        openItem("UI Runner Event To Task")
        assertReminder(amount: 2, unit: "days")
        cancelEditor()

        createEventAfterRemovingAllReminders(title: "UI Runner No Reminders")
        assertNoReminders()
        saveCurrentItem()

        openItem("UI Runner No Reminders")
        assertNoReminders()
        cancelEditor()

        createEventAndExerciseItsLifecycle()
    }

    private func configureLocalServerInApp() {
        let settingsButton = app.buttons["Server settings"]
        XCTAssertTrue(settingsButton.waitForExistence(timeout: 10), "The sign-in screen should expose real Server settings.")
        settingsButton.tap()

        let originField = app.textFields["https://api.example.com"]
        XCTAssertTrue(originField.waitForExistence(timeout: 5))
        replaceText(in: originField, with: "http://localhost:3107")
        XCTAssertEqual(originField.value as? String, "http://localhost:3107", "Server origin must be entered exactly before saving.")
        dismissKeyboardIfShown()

        let allowHTTP = app.switches["Allow local development HTTP"]
        XCTAssertTrue(allowHTTP.waitForExistence(timeout: 5))
        if (allowHTTP.value as? String) != "1" {
            // SwiftUI exposes both the labelled row and the nested switch.
            // Tap the control itself rather than the centre of the whole row.
            let switchControl = allowHTTP.switches.firstMatch
            if switchControl.exists {
                switchControl.tap()
            } else {
                allowHTTP.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
            }
        }
        let httpEnabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "1"), object: allowHTTP)
        XCTAssertEqual(XCTWaiter.wait(for: [httpEnabled], timeout: 5), .completed,
                       "Local development HTTP must be enabled before saving. Accessibility hierarchy: \(app.debugDescription)")

        let settingsNavigation = app.navigationBars["Server settings"]
        app.buttons["Save"].tap()
        let sheetDismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: settingsNavigation)
        XCTAssertEqual(XCTWaiter.wait(for: [sheetDismissed], timeout: 10), .completed,
                       "Server settings did not close after saving. Accessibility hierarchy: \(app.debugDescription)")
        XCTAssertTrue(app.textFields["Email"].waitForExistence(timeout: 5))
    }

    private func registerSecondAccountInApp() {
        let createNewAccount = app.buttons["Create a new account"]
        scrollToHittable(createNewAccount, toward: .down)
        createNewAccount.tap()
        signInFields(email: registrationEmail)

        let createAccount = app.buttons["Create account"]
        XCTAssertTrue(createAccount.waitForExistence(timeout: 5))
        scrollToHittable(createAccount, toward: .down)
        createAccount.tap()
        allowLocalNetworkIfPrompted()
        XCTAssertTrue(app.buttons["Account options"].waitForExistence(timeout: 15),
                      "Registration must complete through the installed app. Accessibility hierarchy: \(app.debugDescription)")
        XCTAssertTrue(app.staticTexts["Your workspace is empty"].waitForExistence(timeout: 30),
                      "The newly registered workspace should finish loading before opening its menu. Accessibility hierarchy: \(app.debugDescription)")
    }

    private func signOutInApp() {
        openToolbarMenu("Account options", select: "Sign out")

        // The compact popover sheet can omit the dialog title from its
        // accessibility identifier, but it contains the destructive action.
        let confirmation = app.sheets.containing(.button, identifier: "Sign out").firstMatch
        XCTAssertTrue(confirmation.waitForExistence(timeout: 10),
                      "The app should ask before signing out. Accessibility hierarchy: \(app.debugDescription)")
        let confirmSignOut = confirmation.buttons["Sign out"]
        let confirmationReady = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND hittable == true"), object: confirmSignOut)
        XCTAssertEqual(XCTWaiter.wait(for: [confirmationReady], timeout: 10), .completed,
                       "The sign-out confirmation should be available to tap. Accessibility hierarchy: \(app.debugDescription)")
        confirmSignOut.tap()
        XCTAssertTrue(app.textFields["Email"].waitForExistence(timeout: 10))
    }

    private func openToolbarMenu(_ name: String, select itemName: String) {
        let menu = app.buttons[name]
        XCTAssertTrue(menu.waitForExistence(timeout: 10))
        let menuItem = app.buttons[itemName]
        let visibleFrame = NSPredicate { _, _ in
            guard menuItem.exists else { return false }
            let frame = menuItem.frame
            return frame.origin.x.isFinite && frame.origin.y.isFinite && frame.width > 0 && frame.height > 0
                && self.app.frame.intersects(frame)
        }
        var menuOpened = false
        for _ in 0..<3 {
            // SwiftUI exposes a labelled wrapper that can lack a hit point.
            menu.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            let menuReady = XCTNSPredicateExpectation(predicate: visibleFrame, object: menuItem)
            if XCTWaiter.wait(for: [menuReady], timeout: 5) == .completed {
                menuOpened = true
                break
            }
        }
        XCTAssertTrue(menuOpened, "The \(itemName) menu item should have a visible frame. Accessibility hierarchy: \(app.debugDescription)")
        menuItem.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }

    private func signInInApp(email: String) {
        signInFields(email: email)
        let signIn = app.buttons["Sign in"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 5))
        scrollToHittable(signIn, toward: .down)
        signIn.tap()
        allowLocalNetworkIfPrompted()
        XCTAssertTrue(app.buttons["Create item"].waitForExistence(timeout: 15),
                      "Sign-in must use the app's account flow. Accessibility hierarchy: \(app.debugDescription)")
    }

    private func signInFields(email: String) {
        let emailField = app.textFields["Email"]
        XCTAssertTrue(emailField.waitForExistence(timeout: 5))
        replaceText(in: emailField, with: email)

        let passwordField = app.secureTextFields["Password"]
        XCTAssertTrue(passwordField.waitForExistence(timeout: 5))
        enterPassword(in: passwordField)
    }

    private func enterPassword(in field: XCUIElement) {
        scrollToHittable(field, toward: .down, message: "The password field should be visible.")
        field.tap()
        dismissStrongPasswordSuggestionIfShown()

        // iOS may present its strong-password sheet after the first keystroke.
        // Handle it before typing the remaining characters.
        field.typeText(String(password.prefix(1)))
        dismissStrongPasswordSuggestionIfShown()
        let firstCharacterWasEntered = (field.value as? String)?.count == 1
        let remainingPassword = firstCharacterWasEntered ? String(password.dropFirst()) : password
        for character in remainingPassword {
            field.typeText(String(character))
        }
        XCTAssertEqual((field.value as? String)?.count, password.count,
                       "The full password should be entered before submitting the form. Accessibility hierarchy: \(app.debugDescription)")
    }

    private func dismissStrongPasswordSuggestionIfShown() {
        let suggestion = app.staticTexts["Use Strong Password?"]
        if suggestion.waitForExistence(timeout: 2) {
            let close = app.buttons["Close"]
            XCTAssertTrue(close.waitForExistence(timeout: 5), "The strong-password suggestion should offer a close button.")
            close.tap()
        }
    }

    private func createEventBySwitchingFromTask(title: String, customizedAmount: Int? = nil) {
        startNewItem(kind: "Task")

        let reminderAmount = element(identifier: "itemEditor.reminder.amount.0")
        scrollToHittable(reminderAmount, toward: .down, message: "The app should load the shared account's Task Reminder defaults before saving.")
        assertReminder(amount: 2, unit: "days")
        if let customizedAmount {
            setReminderAmount(reminderAmount, to: customizedAmount)
        }

        selectType("Event")
        setTitle(title)
    }

    private func createTaskBySwitchingFromEvent(title: String) {
        startNewItem(kind: "Event")
        let reminderAmount = element(identifier: "itemEditor.reminder.amount.0")
        scrollToHittable(reminderAmount, toward: .down, message: "The app should load the shared account's Event Reminder defaults before saving.")
        assertReminder(amount: 3, unit: "weeks")
        selectType("Task")
        setTitle(title)
    }

    private func createEventAfterRemovingAllReminders(title: String) {
        startNewItem(kind: "Task")
        let firstReminder = element(identifier: "itemEditor.reminder.amount.0")
        scrollToHittable(firstReminder, toward: .down, message: "The Task's default Reminder should be visible before removing it.")
        assertReminder(amount: 2, unit: "days")
        let removeReminder = element(identifier: "itemEditor.reminder.remove.0")
        scrollToHittable(removeReminder, toward: .down, message: "The Task's default Reminder should be available to remove.")
        removeReminder.tap()
        let removalComplete = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: firstReminder)
        XCTAssertEqual(XCTWaiter.wait(for: [removalComplete], timeout: 10), .completed,
                       "Removing the only Reminder should remove its controls before switching type. Accessibility hierarchy: \(app.debugDescription)")

        selectType("Event")
        setTitle(title)
        assertNoReminders()
    }

    private func startNewItem(kind: String) {
        openToolbarMenu("Create item", select: "New \(kind)")
    }

    private func createTaskAndExerciseItsLifecycle() {
        let originalTitle = "UI Runner personal Task"
        let editedTitle = "UI Runner edited Task"
        startNewItem(kind: "Task")
        setTitle(originalTitle)
        saveCurrentItem()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", originalTitle)).firstMatch.waitForExistence(timeout: 10))

        openItem(originalTitle)
        setTitle(editedTitle)
        saveCurrentItem()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", editedTitle)).firstMatch.waitForExistence(timeout: 10))

        let complete = app.buttons["Complete Task: \(editedTitle)"]
        scrollToHittable(complete, toward: .down, message: "The Task should expose its completion control.")
        complete.tap()
        let reopen = app.buttons["Reopen Task: \(editedTitle)"]
        XCTAssertTrue(reopen.waitForExistence(timeout: 10), "The completed Task should offer a reopen action. Accessibility hierarchy: \(app.debugDescription)")
        reopen.tap()
        XCTAssertTrue(complete.waitForExistence(timeout: 10), "Reopening the Task should restore its incomplete state.")

        deleteItemFromAgenda(title: editedTitle)
        XCTAssertFalse(app.buttons["agenda.open.\(editedTitle)"].exists,
                       "The deleted Task should leave the agenda.")
    }

    private func createEventAndExerciseItsLifecycle() {
        let originalTitle = "UI Runner personal Event"
        let editedTitle = "UI Runner edited Event"
        startNewItem(kind: "Event")
        setTitle(originalTitle)
        saveCurrentItem()
        let originalRow = app.buttons["agenda.open.\(originalTitle)"]
        XCTAssertTrue(originalRow.waitForExistence(timeout: 10))
        XCTAssertEqual(element(identifier: "agenda.kind.\(originalTitle)").label, "Event",
                       "The agenda should expose the Event type separately from its title.")
        XCTAssertFalse(app.buttons["Complete Task: \(originalTitle)"].exists,
                       "Events should not expose Task completion controls.")

        openItem(originalTitle)
        setTitle(editedTitle)
        saveCurrentItem()
        XCTAssertTrue(app.buttons["agenda.open.\(editedTitle)"].waitForExistence(timeout: 10))

        deleteItemFromAgenda(title: editedTitle)
        XCTAssertFalse(app.buttons["agenda.open.\(editedTitle)"].exists,
                       "The deleted Event should leave the agenda.")
    }

    private func deleteItemFromAgenda(title: String) {
        let row = app.buttons["agenda.open.\(title)"]
        scrollToHittable(row, toward: .down, message: "The item should be visible before deletion.")
        row.swipeLeft()
        let delete = app.buttons["agenda.delete.\(title)"]
        XCTAssertTrue(delete.waitForExistence(timeout: 5), "The agenda row should expose Delete after a swipe.")
        delete.tap()
        let confirm = app.buttons["agenda.delete.confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "Deleting an item should require confirmation.")
        confirm.tap()
        let removed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: row)
        XCTAssertEqual(XCTWaiter.wait(for: [removed], timeout: 10), .completed,
                       "The item should leave the agenda after its deletion is saved.")
    }

    private func selectType(_ kind: String) {
        let typePicker = element(identifier: "itemEditor.type")
        scrollToHittable(typePicker, toward: .up, message: "The new-item Type picker should be present.")
        typePicker.tap()
        let option = app.buttons[kind]
        XCTAssertTrue(option.waitForExistence(timeout: 5), "The app should offer \(kind) as a new-item type.")
        option.tap()
        XCTAssertTrue(app.navigationBars["Create \(kind)"].waitForExistence(timeout: 5))
    }

    private func setTitle(_ title: String) {
        let titleField = app.textFields["Title"]
        scrollToHittable(titleField, toward: .up, message: "The item title field should be available after changing type.")
        replaceText(in: titleField, with: title)
    }

    private func setReminderAmount(_ amountControl: XCUIElement, to expected: Int) {
        scrollToHittable(amountControl, toward: .down, message: "The Reminder amount should be visible before editing it.")
        let increment = amountControl.buttons.matching(
            NSPredicate(format: "label CONTAINS[c] %@", "Increment")
        ).firstMatch
        scrollToHittable(increment, toward: .down, message: "The Reminder amount Stepper should expose a hittable increment control.")

        let initial = Int((amountControl.value as? String) ?? amountControl.label) ?? 0
        XCTAssertLessThanOrEqual(initial, expected)
        for _ in 0..<max(0, expected - initial) {
            increment.tap()
        }
        XCTAssertEqual(Int((amountControl.value as? String) ?? amountControl.label) ?? -1, expected)
    }

    private func assertReminder(amount: Int, unit: String, file: StaticString = #filePath, line: UInt = #line) {
        let amountControl = element(identifier: "itemEditor.reminder.amount.0")
        scrollToHittable(amountControl, toward: .down, message: "The first Reminder should be visible.", file: file, line: line)
        XCTAssertEqual(Int((amountControl.value as? String) ?? amountControl.label) ?? -1, amount, file: file, line: line)

        let unitControl = element(identifier: "itemEditor.reminder.unit.0")
        XCTAssertTrue(unitControl.exists, file: file, line: line)
        let unitValue = ((unitControl.value as? String) ?? unitControl.label).lowercased()
        XCTAssertTrue(unitValue.contains(unit), "Expected Reminder unit \(unit), got \(unitValue). Control: \(unitControl.debugDescription)", file: file, line: line)

        let deliveryControl = element(identifier: "itemEditor.reminder.delivery.0")
        XCTAssertTrue(deliveryControl.exists, file: file, line: line)
        let deliveryValue = ((deliveryControl.value as? String) ?? deliveryControl.label).lowercased()
        XCTAssertTrue(deliveryValue.contains("notification"), "Expected in-app Notification delivery, got \(deliveryValue). Control: \(deliveryControl.debugDescription)", file: file, line: line)
        let timeControl = element(identifier: "itemEditor.reminder.time.0")
        scrollToHittable(timeControl, toward: .down, message: "The Reminder clock-time control should remain visible.", file: file, line: line)
    }

    private func assertNoReminders(file: StaticString = #filePath, line: UInt = #line) {
        let addReminder = element(identifier: "itemEditor.reminder.add")
        scrollToHittable(addReminder, toward: .down, message: "The editor should still offer Add Reminder when no defaults remain.", file: file, line: line)
        XCTAssertTrue(addReminder.exists, file: file, line: line)
        let reminder = element(identifier: "itemEditor.reminder.amount.0")
        let absent = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: reminder)
        XCTAssertEqual(XCTWaiter.wait(for: [absent], timeout: 10), .completed,
                       "No Reminder should be present. Accessibility hierarchy: \(app.debugDescription)", file: file, line: line)
    }

    private func saveCurrentItem() {
        app.buttons["Save"].tap()
    }

    private func assertCalendarDeliveryNotice() {
        let notice = element(identifier: "calendar.sync.delivery.status")
        XCTAssertTrue(notice.waitForExistence(timeout: 15),
                      "A failed Calendar delivery must be reported separately from the saved Event. Accessibility hierarchy: \(app.debugDescription)")
        XCTAssertTrue(notice.label.localizedCaseInsensitiveContains("Calendar sync"), notice.label)
        XCTAssertTrue(notice.label.localizedCaseInsensitiveContains("saved"), notice.label)
        XCTAssertTrue(notice.label.localizedCaseInsensitiveContains("FileTasks"), notice.label)
    }

    private func openItem(_ title: String) {
        let row = app.buttons["agenda.open.\(title)"]
        scrollToHittable(row, toward: .down, maxSwipes: 10, message: "The saved item should appear in the signed-in workspace.")
        row.tap()
    }

    private func cancelEditor() {
        app.buttons["Cancel"].tap()
    }

    private func element(identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    private func replaceText(in field: XCUIElement, with value: String) {
        scrollToHittable(field, toward: .up, message: "The text field should be visible before editing it.")
        let displayedValue = field.value as? String ?? ""
        let currentValue = displayedValue == field.placeholderValue ? "" : displayedValue
        // Tap the center of an empty field; tap at the end when replacing text.
        if currentValue.isEmpty {
            field.tap()
        } else {
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        }
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5),
                      "The text field should open the keyboard before text entry. Accessibility hierarchy: \(app.debugDescription)")
        if !currentValue.isEmpty {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: currentValue.count))
        }
        field.typeText(value)
    }

    private enum ScrollDirection: Equatable {
        case up
        case down
    }

    private func scrollToHittable(
        _ target: XCUIElement,
        toward direction: ScrollDirection,
        maxSwipes: Int = 8,
        message: String = "The requested control should become visible.",
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        for _ in 0...maxSwipes {
            if target.isHittable { return }
            dismissKeyboardIfShown()
            if direction == .down {
                app.swipeUp()
            } else {
                app.swipeDown()
            }
        }
        XCTAssertTrue(target.isHittable, message, file: file, line: line)
    }

    private func dismissKeyboardIfShown() {
        let keyboard = app.keyboards.firstMatch
        guard keyboard.exists else { return }

        let returnButton = keyboard.buttons.matching(
            NSPredicate(format: "label IN %@", ["Done", "Go", "Next", "Return"])
        ).firstMatch
        if returnButton.exists {
            returnButton.tap()
            if !keyboard.exists { return }
        }

        let navigationBar = app.navigationBars.firstMatch
        if navigationBar.exists {
            navigationBar.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
    }

    private func allowLocalNetworkIfPrompted() {
        let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = system.alerts.buttons["Allow"]
        if allow.waitForExistence(timeout: 3) {
            allow.tap()
        }
    }
}
