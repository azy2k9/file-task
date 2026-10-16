package com.filetasks.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.filetasks.android.data.ApiClient
import com.filetasks.android.data.FileAttachment
import com.filetasks.android.data.ItemFields
import com.filetasks.android.data.ItemKind
import com.filetasks.android.data.RecurrenceEnd
import com.filetasks.android.data.RecurrenceRule
import com.filetasks.android.data.ReminderRule
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class ApiClientAcceptanceTest {
    @Test
    fun nativeClientRunsSharedReminderRecurrenceAttachmentAndPushWorkflow() = runBlocking {
        val arguments = InstrumentationRegistry.getArguments()
        val apiUrl = arguments.getString("apiUrl")
            ?: throw AssertionError("Pass apiUrl for the shared acceptance API to the instrumentation runner.")
        val api = ApiClient(apiUrl)
        val password = arguments.getString("password") ?: "correct-horse-battery"
        val email = arguments.getString("email") ?: "android-acceptance-${UUID.randomUUID()}@example.com"
        val namespace = arguments.getString("namespace") ?: UUID.randomUUID().toString()
        val token = if (arguments.getString("email") == null) api.register(email, password).first else api.login(email, password).first
        val available = api.reminderSettings(token)
        assertTrue("The shared API must use the shared fake push adapter.", available.pushAvailable)

        val reminder = ReminderRule("notification", 1, "days", "09:00")
        val savedSettings = api.updateReminderSettings(
            token,
            available.copy(
                taskReminders = listOf(reminder), eventReminders = listOf(reminder),
                pushEnabled = true, emailEnabled = false,
            ),
            applyToExisting = false,
        )
        assertTrue(savedSettings.pushEnabled)
        assertEquals(listOf(reminder), savedSettings.taskReminders)
        assertEquals(listOf(reminder), savedSettings.eventReminders)

        val device = api.registerPushDevice(token, "android", "android-acceptance-${UUID.randomUUID()}")
        assertEquals("android", device.platform)

        val iosRoot = api.listItems(token).firstOrNull { it.title == "Cross-platform Event $namespace" }
            ?: throw AssertionError("The iOS Event was not visible to Android through the shared account.")
        val iosOccurrence = api.listItems(token).firstOrNull { it.seriesId == iosRoot.id && it.files.isNotEmpty() }
            ?: throw AssertionError("The iOS uploaded File was not attached to its Event Occurrences.")
        val iosFile = api.listFiles(token).firstOrNull { it.id == iosOccurrence.files.first().id }
            ?: throw AssertionError("The iOS uploaded File was not available in Android's Files list.")
        val iosBytes = URL(api.openFile(token, iosFile).url).openStream().use { it.readBytes() }
        assertEquals("FileTasks iOS upload $namespace", iosBytes.toString(Charsets.UTF_8))

        val recurrence = RecurrenceRule(1, "weeks", listOf(1), RecurrenceEnd("count", count = 4))
        val root = api.createItem(token, ItemFields(
            kind = ItemKind.Event,
            title = "Android acceptance Event $namespace",
            details = "Shared API workflow",
            scheduledDate = "2026-11-02",
            scheduledTime = "10:00",
            recurrence = recurrence,
            reminders = listOf(reminder),
        ))
        val occurrences = api.listItems(token).filter { it.seriesId == root.id }
        assertEquals(4, occurrences.size)
        val selected = occurrences.firstOrNull { it.id != root.id }
            ?: throw AssertionError("The shared API did not materialize recurring Occurrences.")

        val edited = api.updateItem(token, selected, ItemFields(
            kind = ItemKind.Event,
            title = "Edited on Android $namespace",
            details = selected.details,
            scheduledDate = selected.scheduledDate,
            scheduledTime = selected.scheduledTime,
            recurrence = recurrence,
            reminders = selected.reminders,
            scope = "occurrence",
        ))
        assertEquals("Edited on Android $namespace", edited.title)
        val sharedItems = ApiClient(apiUrl).listItems(token)
        assertEquals("Edited on Android $namespace", sharedItems.first { it.id == selected.id }.title)
        assertEquals(root.title, sharedItems.first { it.id == root.id }.title)

        val file = api.createLinkFile(token, "Android acceptance link $namespace", "https://example.com/native-file")
        api.attachFile(token, file, root, "series")
        var attachedItems = api.listItems(token)
        assertTrue(attachedItems.filter { it.seriesId == root.id }.all { item -> item.files.any { it.id == file.id } })
        api.removeAttachment(token, file, FileAttachment(selected.id, ItemKind.Event, selected.title, "series"), "occurrence")
        attachedItems = ApiClient(apiUrl).listItems(token)
        assertFalse(attachedItems.first { it.id == selected.id }.files.any { it.id == file.id })
        assertTrue(attachedItems.first { it.id == occurrences.last().id }.files.any { it.id == file.id })
        assertEquals("https://example.com/native-file", api.openFile(token, file).url)

        val androidBytes = "FileTasks Android upload $namespace".toByteArray(Charsets.UTF_8)
        val androidFile = api.uploadFile(token, "Android upload $namespace.txt", "text/plain", androidBytes)
        val androidDownload = URL(api.openFile(token, androidFile).url).openStream().use { it.readBytes() }
        assertTrue(androidBytes.contentEquals(androidDownload))

        api.createItem(token, ItemFields(
            kind = ItemKind.Task,
            title = "Native due push $namespace",
            details = "Delivery boundary check",
            scheduledDate = "2026-10-12",
            scheduledTime = null,
            reminders = listOf(ReminderRule("notification", 0, "days", "08:00")),
        ))
        val worker = URL("$apiUrl/api/internal/reminders/deliver").openConnection() as HttpURLConnection
        worker.requestMethod = "POST"
        worker.setRequestProperty("Authorization", "Bearer ${arguments.getString("workerSecret") ?: "test-worker-secret"}")
        assertEquals(200, worker.responseCode)
        val workerBody = worker.inputStream.bufferedReader().use { it.readText() }
        assertTrue("The Android workflow should deliver a due Reminder: $workerBody", workerBody.contains("\"sent\":1") || workerBody.contains("\"sent\":2"))
        worker.disconnect()

        api.revokePushDevice(token, device)
        api.logout(token)
    }
}
