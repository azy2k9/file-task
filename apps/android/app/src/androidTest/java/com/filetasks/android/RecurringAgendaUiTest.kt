package com.filetasks.android

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.swipeUp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.filetasks.android.data.ApiClient
import com.filetasks.android.data.ItemKind
import com.filetasks.android.data.WorkspaceItem
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.time.LocalDate

@RunWith(AndroidJUnit4::class)
class RecurringAgendaUiTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun savesRefreshEveryAffectedOccurrence() {
        val args = InstrumentationRegistry.getArguments()
        val apiUrl = args.getString("apiUrl") ?: error("apiUrl is required")
        val email = args.getString("email") ?: error("email is required")
        val password = args.getString("password") ?: error("password is required")
        val api = ApiClient(apiUrl)
        val token = runBlocking { api.login(email, password).first }

        waitFor("the server configuration button") { compose.onAllNodes(hasText("Configure API URL")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Configure API URL").performClick()
        compose.onNodeWithText("Base URL").performTextClearance()
        compose.onNodeWithText("Base URL").performTextInput(apiUrl)
        compose.onNodeWithText("Save").performClick()
        waitFor("server settings to finish saving") {
            compose.onAllNodes(hasText("Server changed. Sign in to continue.")).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Email").performTextInput(email)
        compose.onNodeWithText("Password").performTextInput(password)
        compose.onNodeWithTag("auth.submit").performScrollTo().performClick()
        waitFor("the signed-in workspace") { compose.onAllNodes(hasTestTag("agenda.add")).fetchSemanticsNodes().isNotEmpty() }
        val undatedEvent = items(api, token).single { it.title == "Android UI date clearing Event" }
        val eventToDelete = items(api, token).single { it.title == "Android UI delete Event" }
        assertEquals(ItemKind.Event, undatedEvent.kind)
        assertEquals(ItemKind.Event, eventToDelete.kind)
        assertAgendaItem(undatedEvent.id, undatedEvent.title)
        assertAgendaItem(eventToDelete.id, eventToDelete.title)

        clearEventDate(undatedEvent, api, token)
        deleteEvent(eventToDelete, api, token)

        createSimpleItem("Android UI personal Task", isEvent = false, details = "Initial Task details", api = api, token = token)
        var personalTask = items(api, token).single { it.title == "Android UI personal Task" }
        assertEquals(ItemKind.Task, personalTask.kind)
        assertEquals(false, personalTask.completed)
        assertAgendaItem(personalTask.id, personalTask.title)

        compose.onNodeWithTag("agenda.complete.${personalTask.id}").performClick()
        waitFor("the Task to be marked complete") {
            val saved = items(api, token).single { it.id == personalTask.id }.completed == true
            val checkboxReady = runCatching {
                compose.onNodeWithTag("agenda.complete.${personalTask.id}")
                    .assertIsOn()
                    .assertIsEnabled()
            }.isSuccess
            saved && checkboxReady
        }
        compose.onNodeWithTag("agenda.complete.${personalTask.id}").performClick()
        waitFor("the Task to be reopened") {
            val saved = items(api, token).single { it.id == personalTask.id }.completed == false
            val checkboxReady = runCatching {
                compose.onNodeWithTag("agenda.complete.${personalTask.id}")
                    .assertIsOff()
                    .assertIsEnabled()
            }.isSuccess
            saved && checkboxReady
        }

        editSimpleItem(personalTask, "Android UI edited Task", "Updated Task details")
        personalTask = items(api, token).single { it.id == personalTask.id }
        assertEquals("Updated Task details", personalTask.details)
        assertAgendaItem(personalTask.id, personalTask.title)

        createRecurring("Android UI Task", isEvent = false, date = "2026-10-14", api = api, token = token)
        val initialTaskRows = items(api, token).filter { it.title == "Android UI Task" }.sortedBy { it.occurrenceDate }
        val task = initialTaskRows.sortedBy { it.scheduledDate }
        assertEquals("The UI-created Task must have three Occurrences", 3, task.size)
        task.forEach { assertAgendaItem(it.id, it.title) }

        val firstTaskOccurrence = initialTaskRows.first()
        val laterTaskOccurrences = initialTaskRows.drop(1)
        editFirstOccurrence(firstTaskOccurrence)
        var observedRows = emptyList<WorkspaceItem>()
        try {
            waitFor("the first Occurrence edit to be saved without changing the series") {
                observedRows = items(api, token).filter { it.id in initialTaskRows.map(WorkspaceItem::id) || it.title == "Android UI First Task Only" }
                val savedFirst = observedRows.singleOrNull { it.id == firstTaskOccurrence.id }
                val savedRows = observedRows
                val savedLater = laterTaskOccurrences.mapNotNull { original -> savedRows.singleOrNull { it.id == original.id } }
                savedFirst?.title == "Android UI First Task Only"
                    && savedFirst.scheduledDate == LocalDate.parse(requireNotNull(firstTaskOccurrence.scheduledDate)).plusDays(10).toString()
                    && savedFirst.scheduledTime == "14:30"
                    && savedFirst.recurrence == null
                    && savedFirst.reminders.firstOrNull()?.let { it.amount == 2 && it.unit == "hours" && it.time == "11:00" } == true
                    && savedLater.size == laterTaskOccurrences.size
                    && savedLater.zip(laterTaskOccurrences).all { (saved, original) ->
                        saved.title == original.title
                            && saved.scheduledDate == original.scheduledDate
                            && saved.scheduledTime == original.scheduledTime
                            && saved.recurrence == original.recurrence
                            && saved.reminders == original.reminders
                    }
            }
        } catch (failure: AssertionError) {
            val values = observedRows.joinToString { "${it.id}:series=${it.seriesId},occurrence=${it.occurrenceDate},title=${it.title},date=${it.scheduledDate},time=${it.scheduledTime},rule=${it.recurrence},reminders=${it.reminders}" }
            val expectedLater = laterTaskOccurrences.joinToString { "${it.id}:occurrence=${it.occurrenceDate},title=${it.title},date=${it.scheduledDate},time=${it.scheduledTime},rule=${it.recurrence},reminders=${it.reminders}" }
            throw AssertionError("First Occurrence API rows after edit; expected id ${firstTaskOccurrence.id}; expected later=$expectedLater; actual=$values", failure)
        }
        val savedFirstTaskOccurrence = items(api, token).single { it.id == firstTaskOccurrence.id }
        assertEquals(firstTaskOccurrence.occurrenceDate, savedFirstTaskOccurrence.occurrenceDate)
        assertAgendaItem(savedFirstTaskOccurrence.id, "Android UI First Task Only")
        laterTaskOccurrences.forEach { assertAgendaItem(it.id, it.title) }

        createRecurring("Android UI Event", isEvent = true, date = "2026-10-18", api = api, token = token)
        waitFor("the saved Event's Calendar failure status") {
            compose.onAllNodes(hasText("Calendar sync pending. Your Event is saved in FileTasks and will be retried. The last attempt failed; another retry is scheduled.")).fetchSemanticsNodes().isNotEmpty()
        }
        val event = items(api, token).filter { it.title == "Android UI Event" }.sortedBy { it.scheduledDate }
        assertEquals("The UI-created Event must have three Occurrences", 3, event.size)
        event.forEach { assertAgendaItem(it.id, it.title) }

        createSimpleItem("Android UI personal Event", isEvent = true, details = "An undated Event", api = api, token = token)
        var personalEvent = items(api, token).single { it.title == "Android UI personal Event" }
        assertEquals(ItemKind.Event, personalEvent.kind)
        assertEquals(null, personalEvent.scheduledDate)
        assertEquals(null, personalEvent.completed)

        compose.onNode(hasText("Events ·", substring = true)).performClick()
        assertAgendaItem(personalEvent.id, "Android UI personal Event")
        compose.onNode(hasText("Tasks ·", substring = true)).performClick()
        assertAgendaItem(personalTask.id, "Android UI edited Task")
        compose.onNode(hasText("Events ·", substring = true)).performClick()
        personalEvent = items(api, token).single { it.id == personalEvent.id }
        editSimpleItem(personalEvent, "Android UI edited Event", "Edited without a schedule")
        personalEvent = items(api, token).single { it.id == personalEvent.id }
        assertEquals("Edited without a schedule", personalEvent.details)
        assertEquals(null, personalEvent.scheduledDate)

        compose.onNode(hasText("All ·", substring = true)).performClick()
        deleteItem(personalTask)
        deleteItem(personalEvent)
        waitFor("the simple Task and Event to be deleted") {
            items(api, token).none { it.id == personalTask.id || it.id == personalEvent.id }
        }

        edit(event[1], "Android UI Following", "This and following Occurrences", api, token)
        val afterFollowing = items(api, token)
        assertEquals(2, afterFollowing.count { it.title == "Android UI Following" })
        assertEquals(1, afterFollowing.count { it.title == "Android UI Event" })
        afterFollowing.filter { it.title.startsWith("Android UI ") }.forEach { assertAgendaItem(it.id, it.title) }

        edit(laterTaskOccurrences.first(), "Android UI Whole Task", "Whole series", api, token)
        val afterSeries = items(api, token)
        val afterTaskSeriesEdit = afterSeries.filter { it.id in initialTaskRows.map(WorkspaceItem::id) }
        assertEquals(3, afterTaskSeriesEdit.count { it.title == "Android UI Whole Task" })
        assertEquals(2, afterSeries.count { it.title == "Android UI Following" })
        afterSeries.filter { it.title.startsWith("Android UI ") }.forEach { assertAgendaItem(it.id, it.title) }

    }

    private fun items(api: ApiClient, token: String): List<WorkspaceItem> = runBlocking { api.listItems(token) }

    private fun createSimpleItem(title: String, isEvent: Boolean, details: String, api: ApiClient, token: String) {
        compose.onNodeWithTag("agenda.add").performClick()
        if (isEvent) compose.onNodeWithTag("item.editor.kind.event").performClick()
        compose.onNodeWithText("Title").performTextInput(title)
        compose.onNodeWithText("Details").performTextInput(details)
        compose.onNodeWithText("Create").performClick()
        waitFor("the simple item editor to close") {
            items(api, token).any { it.title == title }
                && !hasOpenDialog()
        }
    }

    private fun editSimpleItem(item: WorkspaceItem, title: String, details: String) {
        waitFor("any previous editor to close before editing a simple item") { !hasOpenDialog() }
        scrollActionClearOfFab("agenda.edit.${item.id}")
        val editButton = compose.onNodeWithTag("agenda.edit.${item.id}")
        waitFor("the simple item edit action to be displayed and enabled") {
            runCatching { editButton.assertIsDisplayed(); editButton.assertIsEnabled() }.isSuccess
        }
        editButton.performClick()
        waitFor("the simple item edit dialog to open") { hasDialogTitle("Edit item") }
        compose.onNodeWithText("Title").performTextClearance()
        compose.onNodeWithText("Title").performTextInput(title)
        compose.onNodeWithText("Details").performTextClearance()
        compose.onNodeWithText("Details").performTextInput(details)
        compose.onNodeWithText("Save").performClick()
        waitFor("the simple item editor to close after editing") {
            !hasDialogTitle("Edit item") && !hasOpenDialog()
        }
    }

    private fun deleteItem(item: WorkspaceItem) {
        val itemTag = "agenda.item.${item.id}"
        val deleteTag = "agenda.delete.${item.id}"
        scrollActionClearOfFab(deleteTag)
        val deleteButton = compose.onNodeWithTag(deleteTag)
        waitFor("the delete action to finish enabling") {
            runCatching {
                deleteButton.assertIsDisplayed()
                deleteButton.assertIsEnabled()
            }.isSuccess
        }
        deleteButton.performClick()
        waitFor("the delete confirmation dialog to appear") {
            compose.onAllNodes(hasTestTag("item.delete.title")).fetchSemanticsNodes().isNotEmpty()
        }
        clickDeleteConfirmation()
        waitFor("the deleted item and confirmation dialog to leave the agenda") {
            compose.onAllNodes(hasTestTag(itemTag)).fetchSemanticsNodes().isEmpty()
                && !hasOpenDialog()
        }
    }

    private fun createRecurring(title: String, isEvent: Boolean, date: String, api: ApiClient, token: String) {
        compose.onNodeWithTag("agenda.add").performClick()
        if (isEvent) compose.onNodeWithTag("item.editor.kind.event").performClick()
        compose.onNodeWithText("Title").performTextInput(title)
        compose.onNodeWithText("Date (YYYY-MM-DD, optional)").performTextInput(date)
        compose.onNodeWithTag("item.editor.repeat").performScrollTo().performClick()
        compose.onNodeWithText("days").performScrollTo().performClick()
        compose.onNodeWithText("On date").performScrollTo().performClick()
        compose.onNodeWithText("End date (YYYY-MM-DD)").performScrollTo().performTextInput(LocalDate.parse(date).plusDays(2).toString())
        compose.onNodeWithText("Create").performClick()
        waitFor("the create editor to close") {
            items(api, token).any { it.title == title }
                && !hasOpenDialog()
        }
    }

    private fun edit(item: WorkspaceItem, title: String, scope: String, api: ApiClient, token: String) {
        waitFor("any previous editor to close") { !hasOpenDialog() }
        compose.onNodeWithText("Refresh").performScrollTo().performClick()
        scrollActionClearOfFab("agenda.edit.${item.id}")
        val editButton = compose.onNodeWithTag("agenda.edit.${item.id}")
        waitFor("the requested item's edit action to be enabled") { runCatching { editButton.assertIsEnabled() }.isSuccess }
        editButton.performClick()
        waitFor("the requested item editor to open") { hasDialogTitle("Edit item") }
        compose.onNodeWithText("Title").performTextClearance()
        compose.onNodeWithText("Title").performTextInput(title)
        try {
            compose.onNodeWithText(scope).performScrollTo().performClick()
        } catch (failure: AssertionError) {
            val serverItem = items(api, token).singleOrNull { it.id == item.id }
            val roots = compose.onAllNodes(isRoot(), useUnmergedTree = true)
            val ui = (0 until roots.fetchSemanticsNodes().size).joinToString("\n") { roots.get(it).printToString() }
            throw AssertionError("Could not select edit scope '$scope' for item ${item.id}; passed seriesId=${item.seriesId}; server=$serverItem; cause=${failure.message}; UI=$ui", failure)
        }
        compose.onNodeWithText("Save").performClick()
        waitFor("the edit editor to close") { !hasDialogTitle("Edit item") }
    }

    private fun editFirstOccurrence(item: WorkspaceItem) {
        scrollActionClearOfFab("agenda.edit.${item.id}")
        compose.onNodeWithTag("agenda.edit.${item.id}").performClick()
        compose.onNodeWithText("Title").performTextClearance()
        compose.onNodeWithText("Title").performTextInput("Android UI First Task Only")
        compose.onNodeWithText("Date (YYYY-MM-DD, optional)").performTextClearance()
        compose.onNodeWithText("Date (YYYY-MM-DD, optional)")
            .performTextInput(LocalDate.parse(requireNotNull(item.scheduledDate)).plusDays(10).toString())
        compose.onNodeWithText("Time (HH:mm, optional)").performTextInput("14:30")

        compose.onNodeWithTag("item.editor.repeat").performScrollTo().performClick()

        // Replace any inherited default reminder with a specific local Reminder,
        // exercising the actual editor even when the test account has no defaults.
        while (compose.onAllNodes(hasText("Remove Reminder")).fetchSemanticsNodes().isNotEmpty()) {
            compose.onNodeWithText("Remove Reminder").performScrollTo().performClick()
        }
        compose.onNodeWithText("Add Reminder").performScrollTo().performClick()
        compose.onNodeWithText("Offset").performScrollTo().performTextReplacement("2")
        compose.onNodeWithText("Clock time").performTextClearance()
        compose.onNodeWithText("Clock time").performTextInput("11:00")
        compose.onNodeWithText("ho").performScrollTo().performClick()

        compose.onNodeWithText("This Occurrence").performScrollTo().performClick()
        compose.onNodeWithText("Save").performClick()
        waitFor("the first Occurrence editor to close") {
            !hasDialogTitle("Edit item")
        }
    }

    private fun clearEventDate(item: WorkspaceItem, api: ApiClient, token: String) {
        waitFor("any previous editor to close before clearing the Event date") {
            !hasOpenDialog()
        }
        compose.onNodeWithText("Refresh").performScrollTo().performClick()
        scrollActionClearOfFab("agenda.edit.${item.id}")
        val editButton = compose.onNodeWithTag("agenda.edit.${item.id}")
        waitFor("the Event edit action to be enabled") { runCatching { editButton.assertIsEnabled() }.isSuccess }
        editButton.performClick()
        waitFor("the Event edit dialog to open") { hasDialogTitle("Edit item") }
        compose.onNodeWithText("Date (YYYY-MM-DD, optional)").performScrollTo().performTextClearance()
        val saveButton = compose.onNodeWithText("Save")
        waitFor("the Event Save button to be enabled") { runCatching { saveButton.assertIsEnabled() }.isSuccess }
        saveButton.performClick()
        waitFor("the date-clearing editor to close") {
            !hasDialogTitle("Edit item")
        }
        waitFor("the Event to remain undated with its File") {
            val saved = items(api, token).singleOrNull { it.id == item.id }
            saved != null && saved.scheduledDate == null && saved.scheduledTime == null
                && saved.files.any { file -> file.name == "Android Event notes" }
        }
        assertAgendaItem(item.id, item.title)
    }

    private fun deleteEvent(item: WorkspaceItem, api: ApiClient, token: String) {
        val itemTag = "agenda.item.${item.id}"
        val deleteTag = "agenda.delete.${item.id}"
        scrollActionClearOfFab(deleteTag)
        val deleteButton = compose.onNodeWithTag(deleteTag)
        waitFor("the Event delete action to become available") {
            runCatching {
                deleteButton.assertIsDisplayed()
                deleteButton.assertIsEnabled()
            }.isSuccess
        }
        deleteButton.performClick()
        waitFor("the Event delete confirmation") {
            compose.onAllNodes(hasTestTag("item.delete.title")).fetchSemanticsNodes().isNotEmpty()
        }
        clickDeleteConfirmation()
        waitFor("the deleted Event and confirmation to leave the workspace") {
            items(api, token).none { it.id == item.id }
                && compose.onAllNodes(hasTestTag(itemTag)).fetchSemanticsNodes().isEmpty()
                && !hasOpenDialog()
        }
    }

    private fun assertAgendaItem(id: String, title: String) {
        compose.onNodeWithTag("agenda.list").performScrollToNode(hasTestTag("agenda.item.$id"))
        compose.onNode(hasTestTag("agenda.item.$id") and hasAnyDescendant(hasText(title))).assertExists()
    }

    private fun clickDeleteConfirmation() {
        val confirmDelete = compose.onNodeWithTag("item.delete.confirm")
        waitFor("the delete confirmation button to become enabled") {
            runCatching { confirmDelete.assertIsEnabled() }.isSuccess
        }
        confirmDelete.performClick()
    }

    private fun scrollActionClearOfFab(actionTag: String) {
        val agenda = compose.onNodeWithTag("agenda.list")
        val actionButton = compose.onNodeWithTag(actionTag)
        agenda.performScrollToNode(hasTestTag(actionTag))
        var overlapsFab: Boolean
        var scrollCount = 0
        while (true) {
            val actionBounds = actionButton.fetchSemanticsNode().boundsInRoot
            val fabBounds = compose.onNodeWithTag("agenda.add").fetchSemanticsNode().boundsInRoot
            overlapsFab = actionBounds.left < fabBounds.right && fabBounds.left < actionBounds.right
                && actionBounds.top < fabBounds.bottom && fabBounds.top < actionBounds.bottom
            if (!overlapsFab || scrollCount == 4) break
            agenda.performTouchInput {
                swipeUp(startY = bottom * 0.85f, endY = bottom * 0.70f)
            }
            scrollCount += 1
        }
        assertFalse("Agenda action $actionTag overlaps the Add item button after scrolling", overlapsFab)
    }

    private fun waitFor(description: String, condition: () -> Boolean) {
        try {
            compose.waitUntil(30_000, condition)
        } catch (failure: Throwable) {
            val password = InstrumentationRegistry.getArguments().getString("password")
            val snapshot = runCatching {
                val roots = compose.onAllNodes(isRoot(), useUnmergedTree = true)
                (0 until roots.fetchSemanticsNodes().size).joinToString("\n") { index -> roots.get(index).printToString() }
            }.getOrElse { it.toString() }
            val ui = if (password.isNullOrEmpty()) snapshot else snapshot.replace(password, "<redacted>")
            throw AssertionError("Failed while waiting for $description. UI: $ui", failure)
        }
    }

    private fun dialogTrees(): List<String> {
        val roots = compose.onAllNodes(isRoot(), useUnmergedTree = true)
        val rootCount = roots.fetchSemanticsNodes().size
        return (0 until rootCount)
            .mapNotNull { index -> runCatching { roots.get(index).printToString() }.getOrNull() }
            .filter { it.contains("[IsDialog]") }
    }

    private fun hasOpenDialog(): Boolean = dialogTrees().isNotEmpty()

    private fun hasDialogTitle(title: String): Boolean = dialogTrees().any { it.contains("[$title]") }
}
