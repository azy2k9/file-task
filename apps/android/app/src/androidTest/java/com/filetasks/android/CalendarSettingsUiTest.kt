package com.filetasks.android

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.net.Uri
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.printToString
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.espresso.intent.matcher.IntentMatchers.hasData
import androidx.test.platform.app.InstrumentationRegistry
import com.filetasks.android.data.ApiClient
import com.filetasks.android.data.ItemFields
import com.filetasks.android.data.ItemKind
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.hamcrest.Matchers.allOf
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URL

@RunWith(AndroidJUnit4::class)
class CalendarSettingsUiTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun calendarSettingsUseSecureBrowserHandoffAndRestoreProviderCopies() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        val apiUrl = args.getString("apiUrl") ?: error("apiUrl is required")
        val email = args.getString("calendarEmail") ?: error("calendarEmail is required")
        val password = args.getString("password") ?: error("password is required")
        val providerFakeUrl = args.getString("providerFakeUrl") ?: error("providerFakeUrl is required")
        val appleCalendarUrl = args.getString("appleCalendarUrl") ?: error("appleCalendarUrl is required")
        val token = ApiClient(apiUrl).login(email, password).first

        waitFor("the API server configuration button") {
            compose.onAllNodes(hasText("Configure API URL")).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Configure API URL").performClick()
        compose.onNodeWithText("Base URL").performTextClearance()
        compose.onNodeWithText("Base URL").performTextInput(apiUrl)
        compose.onNodeWithText("Save").performClick()
        waitFor("the API server configuration to finish") {
            compose.onAllNodes(hasText("Server changed. Sign in to continue.")).fetchSemanticsNodes().isNotEmpty()
        }

        compose.waitUntil(timeoutMillis = 30_000) {
            compose.onAllNodes(hasText("Sign out")).fetchSemanticsNodes().isNotEmpty() ||
                compose.onAllNodes(hasText("Email")).fetchSemanticsNodes().isNotEmpty()
        }
        if (compose.onAllNodes(hasText("Sign out")).fetchSemanticsNodes().isNotEmpty()) {
            compose.onNodeWithText("Sign out").performClick()
        }
        waitFor("sign-in form after sign-out") { compose.onAllNodes(hasText("Email")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Email").performTextInput(email)
        compose.onNodeWithText("Password").performTextInput(password)
        compose.onNodeWithTag("auth.submit").performScrollTo().performClick()
        waitFor("calendar acceptance account") {
            compose.onAllNodes(hasText("Calendars") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }

        compose.onNodeWithText("Calendars").performClick()
        waitFor("connected calendar settings") { compose.onAllNodes(hasText("Connected calendars")).fetchSemanticsNodes().isNotEmpty() }
        val browserUri = Uri.parse("${apiUrl.trimEnd('/')}/")
        Intents.init()
        try {
            Intents.intending(allOf(hasAction(Intent.ACTION_VIEW), hasData(browserUri)))
                .respondWith(Instrumentation.ActivityResult(Activity.RESULT_OK, null))
            compose.onNodeWithTag("calendar.connect.google").performScrollTo().performClick()
            Intents.intended(allOf(hasAction(Intent.ACTION_VIEW), hasData(browserUri)))
        } finally {
            Intents.release()
        }
        assertFalse("The browser URL must not contain query credentials", browserUri.query?.contains("token", ignoreCase = true) == true)
        assertFalse("The browser URL must not contain a bearer token", browserUri.toString().contains("Bearer", ignoreCase = true))
        assertTrue("Returning from an incomplete browser authorization must leave Google disconnected",
            ApiClient(apiUrl).calendarStatus(token).calendars.none { it.provider == "google" })

        providerAction(providerFakeUrl, "seed", "android-ui-apple-${email.hashCode()}", "Android UI imported Apple Event")
        providerAction(providerFakeUrl, "failApple", "android-ui-apple-${email.hashCode()}", "Android UI imported Apple Event")
        compose.onNodeWithTag("calendar.apple.username").performScrollTo().performTextInput("android-calendar@example.com")
        compose.onNodeWithTag("calendar.apple.password").performScrollTo().performTextInput("fake-app-specific-password")
        compose.onNodeWithTag("calendar.apple.url").performScrollTo().performTextInput(appleCalendarUrl)
        compose.onNodeWithTag("calendar.connect.apple").performScrollTo().performClick()
        waitFor("an honest Apple provider failure message") {
            compose.onAllNodes(hasText("Could not verify the Apple CalDAV calendar URL.")).fetchSemanticsNodes().isNotEmpty()
        }
        assertTrue(ApiClient(apiUrl).calendarStatus(token).calendars.none { it.provider == "apple" })
        compose.onNodeWithTag("calendar.apple.password").performScrollTo().performTextInput("fake-app-specific-password")
        compose.onNodeWithTag("calendar.connect.apple").performScrollTo().performClick()
        waitFor("Apple Calendar connection status") {
            compose.onAllNodes(hasTestTag("calendar.connection.apple")).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNode(
            hasTestTag("calendar.connection.apple") and
                hasAnyDescendant(hasText("Apple Calendar")) and
                hasAnyDescendant(hasText("android-calendar@example.com")),
        ).assertExists()

        waitFor("Sync Calendar to become available") {
            compose.onAllNodes(hasTestTag("calendar.sync") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag("calendar.sync").performScrollTo().performClick()
        waitFor("first native Calendar sync") {
            compose.onAllNodes(hasText("Synced Apple Calendar. 1 Event refreshed.")).fetchSemanticsNodes().isNotEmpty()
        }
        waitFor("the imported Event in the server refresh") {
            runBlocking { ApiClient(apiUrl).listItems(token).count { it.title == "Android UI imported Apple Event" } == 1 }
        }

        providerAction(providerFakeUrl, "edit", "android-ui-apple-${email.hashCode()}", "Android UI imported Apple Event", "External edit")
        compose.onNodeWithTag("calendar.sync").performScrollTo().performClick()
        waitFor("native sync restoring the authoritative title") {
            providerInspect(providerFakeUrl, "android-ui-apple-${email.hashCode()}").let { copies ->
                copies.length() == 1 && copies.getJSONObject(0).getString("calendarData").contains("SUMMARY:Android UI imported Apple Event")
            }
        }

        providerAction(providerFakeUrl, "delete", "android-ui-apple-${email.hashCode()}", "Android UI imported Apple Event")
        compose.onNodeWithTag("calendar.sync").performScrollTo().performClick()
        waitFor("native sync restoring a deleted copy without duplication") {
            val copies = providerInspect(providerFakeUrl, "android-ui-apple-${email.hashCode()}")
            copies.length() == 1 && copies.getJSONObject(0).getString("calendarData").contains("SUMMARY:Android UI imported Apple Event")
        }
        val imported = ApiClient(apiUrl).listItems(token).filter { it.title == "Android UI imported Apple Event" }
        assertEquals("Provider restoration must not duplicate the imported Event", 1, imported.size)
        assertTrue(providerInspect(providerFakeUrl, "android-ui-apple-${email.hashCode()}").getJSONObject(0)
            .getString("calendarData").contains("URL:${apiUrl.trimEnd('/')}/?event=${imported.single().id}"))

        compose.onNodeWithText("Done").performClick()
        check(compose.onAllNodes(hasText("Android UI imported Apple Event")).fetchSemanticsNodes().isNotEmpty())
        compose.onNodeWithText("Files").performClick()
        compose.onNodeWithText("Add an external link").performClick()
        compose.onNodeWithText("Name").performTextInput("Imported Event notes")
        compose.onNodeWithText("Web link").performTextInput("https://example.com/imported-event-notes")
        compose.onNodeWithText("Add link").performClick()
        compose.onNodeWithText("Attach").performClick()
        compose.onNodeWithText("Event: Android UI imported Apple Event").performClick()
        waitFor("the File attachment to the imported Event") {
            compose.onAllNodes(hasText("Event: Android UI imported Apple Event")).fetchSemanticsNodes().isNotEmpty()
        }
        val fileUri = Uri.parse("https://example.com/imported-event-notes")
        Intents.init()
        try {
            Intents.intending(hasData(fileUri)).respondWith(Instrumentation.ActivityResult(Activity.RESULT_OK, null))
            compose.onNodeWithText("Open").performClick()
            Intents.intended(hasData(fileUri))
        } finally {
            Intents.release()
        }
        val refreshedFiles = ApiClient(apiUrl).listFiles(token)
        assertTrue(refreshedFiles.any { file -> file.name == "Imported Event notes" && file.attachments.any { it.itemTitle == "Android UI imported Apple Event" } })

        compose.onNodeWithText("Calendars").performClick()
        compose.onNodeWithTag("calendar.disconnect.apple").performScrollTo().performClick()
        waitFor("Apple Calendar disconnect status") {
            runBlocking { ApiClient(apiUrl).calendarStatus(token).calendars.none { it.provider == "apple" } }
        }
    }

    private fun providerAction(base: String, action: String, uid: String, title: String, changedTitle: String? = null) {
        val connection = URL("${base.trimEnd('/')}/__acceptance/apple-copy").openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            val payload = JSONObject().put("action", action).put("uid", uid).put("title", title)
            if (action == "failApple") payload.put("method", "PROPFIND").put("path", "/apple/calendar/").put("status", 503)
            changedTitle?.let { payload.put("changedTitle", it) }
            connection.outputStream.use { it.write(payload.toString().toByteArray()) }
            assertEquals(200, connection.responseCode)
        } finally { connection.disconnect() }
    }

    private fun providerInspect(base: String, uid: String): org.json.JSONArray {
        val connection = URL("${base.trimEnd('/')}/__acceptance/apple-copy?uid=$uid").openConnection() as HttpURLConnection
        return try {
            assertEquals(200, connection.responseCode)
            JSONObject(connection.inputStream.bufferedReader().use { it.readText() }).getJSONArray("copies")
        } finally { connection.disconnect() }
    }

    private fun waitFor(description: String, condition: () -> Boolean) {
        try {
            compose.waitUntil(30_000, condition)
        } catch (failure: Throwable) {
            val snapshot = runCatching {
                val roots = compose.onAllNodes(isRoot(), useUnmergedTree = true)
                val rootCount = roots.fetchSemanticsNodes().size
                (0 until rootCount).joinToString("\n") { index ->
                    "Compose root $index:\n${roots.get(index).printToString()}"
                }
            }.getOrElse { it.toString() }
            throw AssertionError("Failed while waiting for $description. UI: $snapshot", failure)
        }
    }
}
