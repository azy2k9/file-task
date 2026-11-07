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
        let addDate = app.switches["Add date"]
        scrollToHittable(addDate, toward: .down, message: "The Event used for Calendar delivery failure coverage must be dated.")
        if addDate.value as? String != "1" {
            addDate.tap()
        }
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

        createRecurringItem(kind: "Task", title: "UI Runner Recurring Task")
        editOccurrence(
            title: "UI Runner Recurring Task",
            index: 1,
            newTitle: "UI Runner Following Task",
            scope: "This and following Occurrences"
        )
        assertOccurrenceRows(title: "UI Runner Recurring Task", atLeast: 1)
        assertOccurrenceRows(title: "UI Runner Following Task", atLeast: 2)
        editOccurrence(
            title: "UI Runner Following Task",
            index: 0,
            newTitle: "UI Runner Whole Series Task",
            scope: "Whole series"
        )
        assertOccurrenceRows(title: "UI Runner Recurring Task", atLeast: 1)
        assertOccurrenceRows(title: "UI Runner Whole Series Task", atLeast: 2)

        createRecurringItem(kind: "Event", title: "UI Runner Recurring Event")
        createEventAndExerciseItsLifecycle()
    }

    private func configureLocalServerInApp() {
        let settingsButton = app.buttons["Server settings"]
        XCTAssertTrue(settingsButton.waitForExistence(timeout: 10), "The sign-in screen should expose real Server settings.")
        settingsButton.tap()

        let settingsNavigation = app.navigationBars["Server settings"]
        if !settingsNavigation.waitForExistence(timeout: 3) {
            settingsButton.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
        XCTAssertTrue(settingsNavigation.waitForExistence(timeout: 10),
                      "Server settings should open from the sign-in screen. Accessibility hierarchy: \(app.debugDescription)")

        let originField = app.textFields["https://api.example.com"]
        XCTAssertTrue(originField.waitForExistence(timeout: 10),
                      "Server settings should show the server origin field. Accessibility hierarchy: \(app.debugDescription)")
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
        XCTAssertTrue(app.buttons["Account options"].waitForExistence(timeout: 60),
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
        let embeddedMenuButton = menu.buttons.firstMatch
        if embeddedMenuButton.exists && embeddedMenuButton.isHittable {
            embeddedMenuButton.tap()
        } else {
            menu.tap()
        }

        let menuItem = app.menuItems[itemName]
        let menuButton = app.buttons[itemName]
        let menuActionReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            (menuItem.exists && menuItem.isHittable) || (menuButton.exists && menuButton.isHittable)
        }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [menuActionReady], timeout: 10), .completed,
                       "The \(itemName) menu item should be hittable. Accessibility hierarchy: \(app.debugDescription)")
        if menuItem.exists && menuItem.isHittable {
            menuItem.tap()
        } else {
            menuButton.tap()
        }
    }

    private func signInInApp(email: String) {
        signInFields(email: email)
        let signIn = app.buttons["Sign in"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 5))
        scrollToHittable(signIn, toward: .down)
        signIn.tap()
        allowLocalNetworkIfPrompted()
        XCTAssertTrue(app.buttons["Create item"].waitForExistence(timeout: 60),
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
        ensureKeyboardFocus(field)

        // iOS may present its strong-password sheet after the first keystroke.
        // Handle it before typing the remaining characters.
        field.typeText(String(password.prefix(1)))
        dismissStrongPasswordSuggestionIfShown()
        let firstCharacterWasEntered = (field.value as? String)?.count == 1
        ensureKeyboardFocus(field)
        let remainingPassword = firstCharacterWasEntered ? String(password.dropFirst()) : password
        for character in remainingPassword {
            field.typeText(String(character))
        }
        XCTAssertEqual((field.value as? String)?.count, password.count,
                       "The full password should be entered before submitting the form. Accessibility hierarchy: \(app.debugDescription)")
    }

    private func ensureKeyboardFocus(_ field: XCUIElement) {
        let focused = NSPredicate(format: "hasKeyboardFocus == true")
        if !focused.evaluate(with: field) {
            field.tap()
        }
        let focusReady = XCTNSPredicateExpectation(predicate: focused, object: field)
        XCTAssertEqual(XCTWaiter.wait(for: [focusReady], timeout: 15), .completed,
                       "The password field should have keyboard focus before typing. Accessibility hierarchy: \(app.debugDescription)")
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
        let editedRow = app.buttons.matching(identifier: "agenda.open.\(editedTitle)").firstMatch
        XCTAssertTrue(editedRow.waitForExistence(timeout: 10),
                      "Saving the Task edit should update its agenda row. Accessibility hierarchy: \(app.debugDescription)")

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
        let confirm = app.buttons["agenda.delete.confirm"].firstMatch
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

    private func createRecurringItem(kind: String, title: String) {
        startNewItem(kind: kind)
        setTitle(title)

        dismissKeyboardIfShown()
        let keyboardDismissed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: app.keyboards.firstMatch
        )
        XCTAssertEqual(XCTWaiter.wait(for: [keyboardDismissed], timeout: 5), .completed,
                       "The title keyboard should be dismissed before scheduling the item. Accessibility hierarchy: \(app.debugDescription)")

        let addDate = element(identifier: "itemEditor.schedule.includesDate")
        scrollToHittable(addDate, toward: .down, message: "A recurring item needs a schedule date.")
        if (addDate.value as? String) != "1" { addDate.tap() }

        let dateEnabled = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", "1"),
            object: addDate
        )
        XCTAssertEqual(XCTWaiter.wait(for: [dateEnabled], timeout: 10), .completed,
                       "The schedule date should be enabled before Repeat is used. Accessibility hierarchy: \(app.debugDescription)")

        let repeatToggle = element(identifier: "itemEditor.recurrence.enabled")
        let repeatEnabledForScheduling = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"),
            object: repeatToggle
        )
        XCTAssertEqual(XCTWaiter.wait(for: [repeatEnabledForScheduling], timeout: 10), .completed,
                       "Repeat should become available after enabling the schedule date. Accessibility hierarchy: \(app.debugDescription)")
        scrollToHittable(repeatToggle, toward: .down, message: "The editor should offer a Recurrence rule after adding a date.")
        if (repeatToggle.value as? String) != "1" { repeatToggle.tap() }

        let recurrenceEnabled = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", "1"),
            object: repeatToggle
        )
        XCTAssertEqual(XCTWaiter.wait(for: [recurrenceEnabled], timeout: 10), .completed,
                       "The Repeat control should turn on before its recurrence controls are used. Accessibility hierarchy: \(app.debugDescription)")

        let intervalPicker = element(identifier: "itemEditor.recurrence.interval")
        let intervalPickerExists = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == true"),
            object: intervalPicker
        )
        XCTAssertEqual(XCTWaiter.wait(for: [intervalPickerExists], timeout: 10), .completed,
                       "Turning on Repeat should create the interval picker. Accessibility hierarchy: \(app.debugDescription)")
        scrollToHittable(intervalPicker, toward: .down)
        let intervalPickerIsHittable = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == true AND hittable == true"),
            object: intervalPicker
        )
        XCTAssertEqual(XCTWaiter.wait(for: [intervalPickerIsHittable], timeout: 10), .completed,
                       "The recurrence interval picker should be hittable before selecting it. Accessibility hierarchy: \(app.debugDescription)")
        intervalPicker.tap()
        let daysOption = app.buttons["Days"]
        XCTAssertTrue(daysOption.waitForExistence(timeout: 5), "The shared recurrence editor should offer a daily interval.")
        daysOption.tap()

        let endPicker = element(identifier: "itemEditor.recurrence.endType")
        scrollToHittable(endPicker, toward: .down)
        endPicker.tap()
        let countOption = app.buttons["After occurrences"]
        XCTAssertTrue(countOption.waitForExistence(timeout: 5), "The shared recurrence editor should offer an occurrence count.")
        countOption.tap()

        let countStepper = element(identifier: "itemEditor.recurrence.count")
        scrollToHittable(countStepper, toward: .down)
        let decrement = countStepper.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Decrement")).firstMatch
        XCTAssertTrue(decrement.exists, "The recurrence count should be editable in the real item editor.")
        let displayedCount = countStepper.value as? String ?? countStepper.label
        let count = displayedCount.components(separatedBy: CharacterSet.decimalDigits.inverted)
            .compactMap(Int.init).last ?? 0
        for _ in 0..<max(0, count - 3) { decrement.tap() }
        let savedCount = (countStepper.value as? String ?? countStepper.label)
            .components(separatedBy: CharacterSet.decimalDigits.inverted).compactMap(Int.init).last
        XCTAssertEqual(savedCount, 3, "The recurring series should contain three upcoming Occurrences.")

        saveCurrentItem()
        let editor = app.navigationBars["Create \(kind)"]
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: editor)
        XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 30), .completed,
                       "A successful recurring save should close the editor after refreshing the agenda. Accessibility hierarchy: \(app.debugDescription)")
        assertOccurrenceRows(title: title, atLeast: 2)
    }

    private func editOccurrence(title: String, index: Int, newTitle: String, scope: String) {
        let matchingRows = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title))
        let selectedRow = matchingRows.element(boundBy: index)
        scrollToHittable(selectedRow, toward: .down, maxSwipes: 12,
                         message: "The requested saved Occurrence should be available for a scoped edit.")
        selectedRow.tap()
        XCTAssertTrue(app.navigationBars["Edit Task"].waitForExistence(timeout: 5),
                      "Tapping a recurring Task Occurrence should open the real editor.")
        setTitle(newTitle)

        let scopePicker = element(identifier: "itemEditor.scope")
        scrollToHittable(scopePicker, toward: .down)
        scopePicker.tap()
        let scopeOption = app.buttons[scope]
        XCTAssertTrue(scopeOption.waitForExistence(timeout: 5), "The editor should offer the requested recurring edit scope.")
        scopeOption.tap()
        saveCurrentItem()

        let editor = app.navigationBars["Edit Task"]
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: editor)
        XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 30), .completed,
                       "A successful scoped save should close the editor after refreshing every affected Occurrence.")
    }

    private func assertOccurrenceRows(title: String, atLeast count: Int) {
        let rows = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title))
        let secondRow = rows.element(boundBy: 1)
        if count > 1 {
            scrollToHittable(secondRow, toward: .down, maxSwipes: 12,
                             message: "The refreshed agenda should show more than one saved Occurrence titled \(title).")
        }
        XCTAssertGreaterThanOrEqual(rows.count, count,
                                    "The real iOS agenda should show at least \(count) server-generated Occurrences titled \(title). Accessibility hierarchy: \(app.debugDescription)")
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
        let editor = app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH %@", "Edit ")).firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 30),
                      "The saved item should open in the editor. Accessibility hierarchy: \(app.debugDescription)")
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
            NSPredicate(format: "label IN[c] %@", ["Done", "Go", "Next", "Return"])
        ).firstMatch
        if returnButton.exists {
            returnButton.tap()
            if !keyboard.exists { return }
        }

        let editorBar = app.navigationBars.matching(
            NSPredicate(format: "label BEGINSWITH 'Create ' OR label BEGINSWITH 'Edit '")
        ).firstMatch
        let settingsBar = app.navigationBars["Server settings"]
        let navigationBar = editorBar.exists ? editorBar : settingsBar
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
