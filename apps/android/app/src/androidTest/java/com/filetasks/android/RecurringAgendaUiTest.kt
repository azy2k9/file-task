package com.filetasks.android

import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.filetasks.android.data.ApiClient
import com.filetasks.android.data.WorkspaceItem
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
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

        compose.waitUntil(30_000) { compose.onAllNodes(hasText("Configure API URL")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Configure API URL").performClick()
        compose.onNodeWithText("Base URL").performTextClearance()
        compose.onNodeWithText("Base URL").performTextInput(apiUrl)
        compose.onNodeWithText("Save").performClick()
        compose.onNodeWithText("Email").performTextInput(email)
        compose.onNodeWithText("Password").performTextInput(password)
        compose.onNodeWithTag("auth.submit").performClick()
        compose.waitUntil(30_000) { compose.onAllNodes(hasText("Add item")).fetchSemanticsNodes().isNotEmpty() }
        compose.waitUntil(30_000) { compose.onAllNodes(hasText("Nothing here yet")).fetchSemanticsNodes().isNotEmpty() }

        createRecurring("Android UI Task", isEvent = false, date = "2026-10-14")
        val task = items(api, token).filter { it.title == "Android UI Task" }.sortedBy { it.scheduledDate }
        assertEquals("The UI-created Task must have three Occurrences", 3, task.size)
        task.forEach { assertAgendaItem(it.id, it.title) }

        createRecurring("Android UI Event", isEvent = true, date = "2026-10-18")
        val event = items(api, token).filter { it.title == "Android UI Event" }.sortedBy { it.scheduledDate }
        assertEquals("The UI-created Event must have three Occurrences", 3, event.size)
        event.forEach { assertAgendaItem(it.id, it.title) }

        edit(event[1], "Android UI Following", "This and following Occurrences")
        val afterFollowing = items(api, token)
        assertEquals(2, afterFollowing.count { it.title == "Android UI Following" })
        assertEquals(1, afterFollowing.count { it.title == "Android UI Event" })
        afterFollowing.filter { it.title.startsWith("Android UI ") }.forEach { assertAgendaItem(it.id, it.title) }

        edit(task[0], "Android UI Whole Task", "Whole series")
        val afterSeries = items(api, token)
        assertEquals(3, afterSeries.count { it.title == "Android UI Whole Task" })
        assertTrue(afterSeries.any { it.title == "Android UI Event" })
        assertEquals(2, afterSeries.count { it.title == "Android UI Following" })
        afterSeries.filter { it.title.startsWith("Android UI ") }.forEach { assertAgendaItem(it.id, it.title) }
    }

    private fun items(api: ApiClient, token: String): List<WorkspaceItem> = runBlocking { api.listItems(token) }

    private fun createRecurring(title: String, isEvent: Boolean, date: String) {
        compose.onNodeWithText("Add item").performClick()
        if (isEvent) compose.onNodeWithText("Event").performClick()
        compose.onNodeWithText("Title").performTextInput(title)
        compose.onNodeWithText("Date (YYYY-MM-DD, optional)").performTextInput(date)
        compose.onNodeWithTag("item.editor.repeat").performScrollTo().performClick()
        compose.onNodeWithText("days").performScrollTo().performClick()
        compose.onNodeWithText("On date").performScrollTo().performClick()
        compose.onNodeWithText("End date (YYYY-MM-DD)").performScrollTo().performTextInput(LocalDate.parse(date).plusDays(2).toString())
        compose.onNodeWithText("Create").performClick()
        compose.waitUntil(30_000) { compose.onAllNodes(hasText("Add to your workspace")).fetchSemanticsNodes().isEmpty() }
    }

    private fun edit(item: WorkspaceItem, title: String, scope: String) {
        compose.onNodeWithTag("agenda.list").performScrollToNode(hasTestTag("agenda.edit.${item.id}"))
        compose.onNodeWithTag("agenda.edit.${item.id}").performClick()
        compose.onNodeWithText("Title").performTextClearance()
        compose.onNodeWithText("Title").performTextInput(title)
        compose.onNodeWithText(scope).performScrollTo().performClick()
        compose.onNodeWithText("Save").performClick()
        compose.waitUntil(30_000) { compose.onAllNodes(hasText("Edit item")).fetchSemanticsNodes().isEmpty() }
    }

    private fun assertAgendaItem(id: String, title: String) {
        compose.onNodeWithTag("agenda.list").performScrollToNode(hasTestTag("agenda.item.$id"))
        compose.onNode(hasTestTag("agenda.item.$id") and hasAnyDescendant(hasText(title))).assertExists()
    }
}
