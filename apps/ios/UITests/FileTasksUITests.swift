import Foundation
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

    @MainActor
    func testRegistrationSignInCrossTypeReminderPreservation() async throws {
        configureLocalServerInApp()
        registerSecondAccountInApp()
        exerciseCalendarSettingsForSecondAccount()
        signOutInApp()
        signInInApp(email: sharedEmail)

        openToolbarMenu("Account options", select: "Connected calendars")
        let connectedCalendar = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "Google Calendar")
        ).firstMatch
        XCTAssertTrue(connectedCalendar.waitForExistence(timeout: 10),
                      "Calendar settings should show the account-scoped Google connection. Accessibility hierarchy: \(app.debugDescription)")
        XCTAssertTrue(app.buttons["calendar.disconnect.google"].exists,
                      "The connected Google calendar should offer a native disconnect action.")
        let syncCalendar = app.buttons["calendar.sync"]
        XCTAssertTrue(syncCalendar.waitForExistence(timeout: 5))
        syncCalendar.tap()
        let syncNotice = element(identifier: "calendar.action.notice")
        XCTAssertTrue(syncNotice.waitForExistence(timeout: 30),
                      "Native Sync Calendar should report its result. Accessibility hierarchy: \(app.debugDescription)")
        XCTAssertTrue(syncNotice.label.localizedCaseInsensitiveContains("Synced Google Calendar"), syncNotice.label)
        try await assertGoogleProviderCopiesRestored()
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Native calendar sync authority")).firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Native imported Google Event")).firstMatch.waitForExistence(timeout: 10),
                      "Provider-imported Events should use the existing native Agenda workflow.")

        let filesSection = app.segmentedControls.buttons["Files"]
        if filesSection.exists { filesSection.tap() }
        XCTAssertTrue(app.staticTexts["Native calendar sync notes"].waitForExistence(timeout: 10),
                      "Calendar Events and their Files should remain visible through the existing Files section.")
        let linkedEvent = app.buttons["Event: Native imported Google Event"]
        XCTAssertTrue(linkedEvent.waitForExistence(timeout: 10))
        linkedEvent.tap()
        XCTAssertTrue(app.navigationBars["Edit Event"].waitForExistence(timeout: 5))
        cancelEditor()
        let agendaSection = app.segmentedControls.buttons["Agenda"]
        if agendaSection.exists { agendaSection.tap() }
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
        openItem("iOS UI date clearing Event")
        let addDate = app.switches["Add date"]
        scrollToHittable(addDate, toward: .down, message: "The seeded Event's date toggle should be visible.")
        XCTAssertEqual(addDate.value as? String, "1", "The seeded Event should start with a date.")
        // SwiftUI exposes the labelled Toggle row and a nested switch in
        // accessibility. Tapping the row can leave the switch unchanged.
        let addDateSwitch = addDate.switches.firstMatch
        if addDateSwitch.exists {
            addDateSwitch.tap()
        } else {
            addDate.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        }
        XCTAssertEqual(addDate.value as? String, "0", "The Event date should be cleared in the native editor.")
        saveCurrentItem()
        let retainedUndatedEvent = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "iOS UI date clearing Event")).firstMatch
        XCTAssertTrue(retainedUndatedEvent.waitForExistence(timeout: 15),
                      "The Event should remain in the workspace after clearing its date. Accessibility hierarchy: \(app.debugDescription)")

        deleteEventThroughWorkspace("iOS UI delete Event")
        createEventAndExerciseItsLifecycle()
        changeServerClearsSession()
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

    private func exerciseCalendarSettingsForSecondAccount() {
        openToolbarMenu("Account options", select: "Connected calendars")
        let connectGoogle = app.buttons["calendar.connect.google"]
        XCTAssertTrue(connectGoogle.waitForExistence(timeout: 5),
                      "An account without a Google connection should be offered the secure browser handoff.")
        scrollToHittable(connectGoogle, toward: .down)
        connectGoogle.tap()
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        let browserEmail = safari.textFields["Email"]
        if browserEmail.waitForExistence(timeout: 15) {
            browserEmail.tap()
            browserEmail.typeText(registrationEmail)
            let browserPassword = safari.secureTextFields["Password"]
            XCTAssertTrue(browserPassword.waitForExistence(timeout: 5),
                          "Safari should expose the FileTasks sign-in form. Accessibility hierarchy: \(safari.debugDescription)")
            browserPassword.tap()
            browserPassword.typeText(password)
            let signInButtons = safari.buttons.matching(NSPredicate(format: "label == %@", "Sign in")).allElementsBoundByIndex
            guard let submitSignIn = signInButtons.last else {
                XCTFail("Safari should expose the FileTasks sign-in action. Accessibility hierarchy: \(safari.debugDescription)")
                return
            }
            submitSignIn.tap()
        }
        XCTAssertTrue(safari.staticTexts[registrationEmail].waitForExistence(timeout: 20),
                      "Google authorization must use the same FileTasks account as the native app. Accessibility hierarchy: \(safari.debugDescription)")

        authorizeGoogleFromSafari(safari, link: "Cancel authorization")
        app.activate()
        let handoffNotice = element(identifier: "calendar.action.notice")
        let cancellationNotice = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label CONTAINS[cd] %@", "Google Calendar was not connected"),
            object: handoffNotice
        )
        XCTAssertEqual(XCTWaiter.wait(for: [cancellationNotice], timeout: 15), .completed,
                       "Returning from a cancelled Safari authorization should refresh native calendar status.")
        XCTAssertTrue(handoffNotice.label.localizedCaseInsensitiveContains("not connected"), handoffNotice.label)
        XCTAssertTrue(connectGoogle.exists,
                      "Cancelling Google authorization must leave the native account disconnected.")
        XCTAssertTrue(app.buttons["calendar.connect.apple"].exists,
                      "An account without an Apple connection should be offered the native Apple form.")

        safari.activate()
        authorizeGoogleFromSafari(safari, link: "Allow Google Calendar")
        app.activate()
        let connectedGoogle = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Google Calendar")).firstMatch
        XCTAssertTrue(connectedGoogle.waitForExistence(timeout: 20),
                      "Completing browser authorization should connect Google to the same native account. Accessibility hierarchy: \(app.debugDescription)")
        XCTAssertTrue(app.buttons["calendar.disconnect.google"].waitForExistence(timeout: 5),
                      "The native app should offer account-scoped Google disconnect after the browser callback completes.")
        let disconnectGoogle = app.buttons["calendar.disconnect.google"]
        scrollToHittable(disconnectGoogle, toward: .up)
        disconnectGoogle.tap()
        XCTAssertTrue(connectGoogle.waitForExistence(timeout: 15),
                      "The native account should return to a disconnected state after Google is disconnected.")

        let username = app.textFields["calendar.apple.username"]
        let passwordField = app.secureTextFields["calendar.apple.password"]
        let calendarURL = app.textFields["calendar.apple.url"]
        let fakeURL = ProcessInfo.processInfo.environment["FILETASKS_IOS_UI_APPLE_URL"] ?? ""
        XCTAssertFalse(fakeURL.isEmpty, "The shared provider fake URL must be passed to the real iOS app.")
        replaceText(in: username, with: "person@example.com")
        replaceText(in: passwordField, with: "app-specific-password")
        replaceText(in: calendarURL, with: fakeURL)

        let connectApple = app.buttons["calendar.connect.apple"]
        scrollToHittable(connectApple, toward: .down)
        connectApple.tap()
        let providerError = element(identifier: "calendar.action.error")
        XCTAssertTrue(providerError.waitForExistence(timeout: 20),
                      "The native screen should surface the provider's failed connection check.")
        XCTAssertTrue(providerError.label.localizedCaseInsensitiveContains("verify"), providerError.label)

        scrollToHittable(connectApple, toward: .down)
        connectApple.tap()
        let disconnectApple = app.buttons["calendar.disconnect.apple"]
        XCTAssertTrue(disconnectApple.waitForExistence(timeout: 30),
                      "The native screen should show the Apple connection after the fake provider recovers.")
        scrollToHittable(disconnectApple, toward: .up)
        disconnectApple.tap()
        scrollToHittable(connectApple, toward: .down)
        XCTAssertTrue(connectApple.waitForExistence(timeout: 15),
                      "Disconnecting Apple Calendar should refresh status for the current account.")

        let cancelApple = app.buttons["calendar.cancel.apple"]
        scrollToHittable(cancelApple, toward: .down)
        cancelApple.tap()
        let cancellation = element(identifier: "calendar.action.notice")
        XCTAssertTrue(cancellation.waitForExistence(timeout: 5))
        XCTAssertTrue(cancellation.label.localizedCaseInsensitiveContains("cancelled"), cancellation.label)
        app.buttons["Done"].tap()
    }

    private func authorizeGoogleFromSafari(_ safari: XCUIApplication, link: String) {
        let settings = safari.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 15),
                      "The signed-in FileTasks website should be available in Safari. Accessibility hierarchy: \(safari.debugDescription)")
        settings.tap()

        let connectGoogle = safari.buttons["Connect Google Calendar"]
        scrollBrowserToHittable(connectGoogle, safari: safari)
        connectGoogle.tap()

        let authorizationChoice = safari.links[link]
        XCTAssertTrue(authorizationChoice.waitForExistence(timeout: 15),
                      "The fake Google authorization page should offer the requested choice. Accessibility hierarchy: \(safari.debugDescription)")
        authorizationChoice.tap()
        XCTAssertTrue(safari.buttons["Settings"].waitForExistence(timeout: 15),
                      "The Google callback should return Safari to FileTasks.")
    }

    private func scrollBrowserToHittable(_ target: XCUIElement, safari: XCUIApplication) {
        for _ in 0...8 {
            if target.isHittable { return }
            safari.swipeUp()
        }
        XCTAssertTrue(target.isHittable,
                      "The browser calendar action should become visible. Accessibility hierarchy: \(safari.debugDescription)")
    }

    private func assertGoogleProviderCopiesRestored() async throws {
        let stateURL = ProcessInfo.processInfo.environment["FILETASKS_IOS_UI_PROVIDER_STATE_URL"] ?? ""
        guard let url = URL(string: stateURL), url.scheme != nil, url.host != nil else {
            XCTFail("The shared Google provider state URL must be passed to the iOS UI test.")
            return
        }

        let (data, response) = try await URLSession.shared.data(from: url)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200,
                       "The shared provider fake should return its calendar Events.")
        guard let events = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            XCTFail("The shared provider fake should return a JSON Event list.")
            return
        }

        for title in ["Native calendar sync authority", "Native calendar missing copy"] {
            let copies = events.filter { $0["summary"] as? String == title }
            XCTAssertEqual(copies.count, 1,
                           "Native Sync Calendar should restore exactly one Google copy titled \(title).")
            guard let copy = copies.first else { continue }
            let description = copy["description"] as? String ?? ""
            XCTAssertTrue(description.contains("?event="),
                          "The restored Google copy titled \(title) should retain its FileTasks Event backlink.")
        }
    }

    private func changeServerClearsSession() {
        openToolbarMenu("Account options", select: "Server settings")
        let origin = app.textFields["https://api.example.com"]
        XCTAssertTrue(origin.waitForExistence(timeout: 5))
        replaceText(in: origin, with: "http://localhost:3108")
        dismissKeyboardIfShown()
        app.buttons["Save"].tap()
        XCTAssertTrue(app.textFields["Email"].waitForExistence(timeout: 10),
                      "Changing servers should sign out rather than send the saved bearer token to the new server.")
        XCTAssertFalse(app.buttons["Account options"].exists)
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

    private func deleteEventThroughWorkspace(_ title: String) {
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        scrollToHittable(row, toward: .down, maxSwipes: 10, message: "The dated Event should appear before deletion.")
        row.swipeLeft()

        let deleteAction = app.buttons["Delete"].firstMatch
        XCTAssertTrue(deleteAction.waitForExistence(timeout: 5),
                      "The native Event row should expose its Delete action. Accessibility hierarchy: \(app.debugDescription)")
        let deleteActionReady = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == true AND hittable == true"), object: deleteAction
        )
        XCTAssertEqual(XCTWaiter.wait(for: [deleteActionReady], timeout: 5), .completed,
                       "The native Event Delete action should be hittable. Accessibility hierarchy: \(app.debugDescription)")
        deleteAction.tap()

        let confirmation = app.sheets.containing(.button, identifier: "Delete").firstMatch
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5),
                      "The Event deletion should require confirmation. Accessibility hierarchy: \(app.debugDescription)")
        let confirmDelete = confirmation.buttons["Delete"]
        XCTAssertTrue(confirmDelete.waitForExistence(timeout: 5))
        confirmDelete.tap()

        let rowRemoved = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: row)
        XCTAssertEqual(XCTWaiter.wait(for: [rowRemoved], timeout: 15), .completed,
                       "The deleted Event should leave the workspace. Accessibility hierarchy: \(app.debugDescription)")
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
