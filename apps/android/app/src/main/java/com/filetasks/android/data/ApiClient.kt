package com.filetasks.android.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONObject
import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit

data class AccountUser(val id: String, val email: String)

data class WorkspaceItem(
    val id: String,
    val kind: ItemKind,
    val title: String,
    val details: String,
    val scheduledDate: String?,
    val scheduledTime: String?,
    val completed: Boolean?,
    val createdAt: String,
    val updatedAt: String,
    val files: List<WorkspaceFileSummary> = emptyList(),
    val recurrence: RecurrenceRule? = null,
    val reminders: List<ReminderRule> = emptyList(),
    val seriesId: String? = null,
    val occurrenceDate: String? = null,
    val isOccurrence: Boolean = false,
)

data class ReminderRule(val delivery: String, val amount: Int, val unit: String, val time: String)
data class RecurrenceEnd(val type: String, val date: String? = null, val count: Int? = null)
data class RecurrenceRule(val interval: Int, val unit: String, val weekdays: List<Int>?, val end: RecurrenceEnd)
data class ReminderSettings(
    val taskReminders: List<ReminderRule>, val eventReminders: List<ReminderRule>,
    val pushEnabled: Boolean, val emailEnabled: Boolean, val pushAvailable: Boolean, val emailAvailable: Boolean,
) {
    companion object {
        val Empty = ReminderSettings(emptyList(), emptyList(), false, false, false, false)
    }
}
data class PushDevice(val id: String, val platform: String, val createdAt: String)
data class WorkspaceFileSummary(val id: String, val name: String, val sourceType: String)
data class FileAttachment(val itemId: String, val itemKind: ItemKind, val itemTitle: String, val scope: String = "occurrence")
data class WorkspaceFile(
    val id: String,
    val name: String,
    val sourceType: String,
    val contentType: String?,
    val sizeBytes: Long?,
    val externalUrl: String?,
    val createdAt: String,
    val attachments: List<FileAttachment>,
)
data class OpenFileTarget(val url: String, val name: String, val contentType: String?, val sourceType: String)

enum class ItemKind(val wireValue: String) {
    Task("task"),
    Event("event"),
}

data class ItemFields(
    val kind: ItemKind,
    val title: String,
    val details: String,
    val scheduledDate: String?,
    val scheduledTime: String?,
    val recurrence: RecurrenceRule? = null,
    val reminders: List<ReminderRule> = emptyList(),
    val scope: String? = null,
)

class ApiException(
    val statusCode: Int,
    override val message: String,
) : IOException(message)

class ApiClient(rawBaseUrl: String) {
    private val baseUrl = normalizeBaseUrl(rawBaseUrl)
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    suspend fun register(email: String, password: String): Pair<String, AccountUser> =
        withContext(Dispatchers.IO) {
            val response = request(
                method = "POST",
                path = "/api/auth/register",
                body = JSONObject().put("email", email).put("password", password),
            )
            authResult(response)
        }

    suspend fun login(email: String, password: String): Pair<String, AccountUser> =
        withContext(Dispatchers.IO) {
            val response = request(
                method = "POST",
                path = "/api/auth/login",
                body = JSONObject().put("email", email).put("password", password),
            )
            authResult(response)
        }

    suspend fun session(token: String): AccountUser = withContext(Dispatchers.IO) {
        parseUser(request("GET", "/api/auth/session", token = token).getJSONObject("user"))
    }

    suspend fun logout(token: String) = withContext(Dispatchers.IO) {
        request("POST", "/api/auth/logout", token = token)
        Unit
    }

    suspend fun listItems(token: String): List<WorkspaceItem> = withContext(Dispatchers.IO) {
        val items = request("GET", "/api/items", token = token).getJSONArray("items")
        buildList(items.length()) {
            for (index in 0 until items.length()) add(parseItem(items.getJSONObject(index)))
        }
    }

    suspend fun listFiles(token: String): List<WorkspaceFile> = withContext(Dispatchers.IO) {
        val files = request("GET", "/api/files", token = token).getJSONArray("files")
        buildList(files.length()) { for (index in 0 until files.length()) add(parseFile(files.getJSONObject(index))) }
    }

    suspend fun reminderSettings(token: String): ReminderSettings = withContext(Dispatchers.IO) {
        parseReminderSettings(request("GET", "/api/settings/reminders", token = token).getJSONObject("settings"))
    }

    suspend fun updateReminderSettings(token: String, settings: ReminderSettings, applyToExisting: Boolean): ReminderSettings = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("taskReminders", reminderArray(settings.taskReminders))
            .put("eventReminders", reminderArray(settings.eventReminders))
            .put("pushEnabled", settings.pushEnabled)
            .put("emailEnabled", settings.emailEnabled)
            .put("applyToExisting", applyToExisting)
        parseReminderSettings(request("PATCH", "/api/settings/reminders", body, token).getJSONObject("settings"))
    }

    suspend fun registerPushDevice(token: String, platform: String, deviceToken: String): PushDevice = withContext(Dispatchers.IO) {
        val response = request("POST", "/api/devices/push", JSONObject().put("platform", platform).put("token", deviceToken), token)
        val device = response.getJSONObject("device")
        PushDevice(device.optString("id"), device.optString("platform"), device.optString("createdAt"))
    }

    suspend fun revokePushDevice(token: String, device: PushDevice) = withContext(Dispatchers.IO) {
        request("DELETE", "/api/devices/push/${pathSegment(device.id)}", token = token)
        Unit
    }

    suspend fun createLinkFile(token: String, name: String, url: String): WorkspaceFile = withContext(Dispatchers.IO) {
        parseFile(request("POST", "/api/files", JSONObject().put("name", name).put("url", url), token)
            .getJSONObject("file"))
    }

    suspend fun uploadFile(token: String, name: String, contentType: String, bytes: ByteArray): WorkspaceFile = withContext(Dispatchers.IO) {
        val target = request("POST", "/api/files/uploads", JSONObject()
            .put("name", name).put("contentType", contentType).put("sizeBytes", bytes.size), token)
        val uploadId = target.optString("uploadId")
        val uploadUrl = target.optString("uploadUrl")
        val uploadRequest = Request.Builder().url(uploadUrl)
            .header("Content-Type", contentType)
            .put(bytes.toRequestBody(contentType.toMediaType()))
            .build()
        try {
            httpClient.newBuilder().followRedirects(true).followSslRedirects(true).build().newCall(uploadRequest).execute().use { response ->
                if (!response.isSuccessful) throw IOException("The File could not be uploaded (HTTP ${response.code}).")
            }
        } catch (error: Exception) {
            runCatching { request("DELETE", "/api/files/${pathSegment(uploadId)}", token = token) }
            throw IOException(error.message ?: "The File could not be uploaded.", error)
        }
        parseFile(request("POST", "/api/files/${pathSegment(uploadId)}/complete", token = token).getJSONObject("file"))
    }

    suspend fun attachFile(token: String, file: WorkspaceFile, item: WorkspaceItem, scope: String = "occurrence") = withContext(Dispatchers.IO) {
        request("POST", "/api/files/${pathSegment(file.id)}/attachments", JSONObject().put("itemId", item.id).put("scope", scope), token)
        Unit
    }

    suspend fun removeAttachment(token: String, file: WorkspaceFile, attachment: FileAttachment, scope: String = "occurrence") = withContext(Dispatchers.IO) {
        request("DELETE", "/api/files/${pathSegment(file.id)}/attachments/${pathSegment(attachment.itemId)}?scope=${pathSegment(scope)}", token = token)
        Unit
    }

    suspend fun deleteFile(token: String, file: WorkspaceFile) = withContext(Dispatchers.IO) {
        request("DELETE", "/api/files/${pathSegment(file.id)}", token = token)
        Unit
    }

    suspend fun openFile(token: String, file: WorkspaceFile): OpenFileTarget = withContext(Dispatchers.IO) {
        val response = request("GET", "/api/files/${pathSegment(file.id)}/open", token = token)
        OpenFileTarget(response.optString("url"), response.optString("name"), response.nullableString("contentType"), response.optString("sourceType"))
    }

    suspend fun createItem(token: String, fields: ItemFields): WorkspaceItem =
        withContext(Dispatchers.IO) {
            val response = request("POST", "/api/items", itemBody(fields), token)
            parseItem(response.getJSONObject("item"))
        }

    suspend fun updateItem(
        token: String,
        item: WorkspaceItem,
        fields: ItemFields,
    ): WorkspaceItem = withContext(Dispatchers.IO) {
        val response = request("PATCH", "/api/items/${pathSegment(item.id)}", itemBody(fields), token)
        parseItem(response.getJSONObject("item"))
    }

    suspend fun setTaskCompleted(token: String, item: WorkspaceItem, completed: Boolean): WorkspaceItem =
        withContext(Dispatchers.IO) {
            val response = request(
                "PATCH",
                "/api/items/${pathSegment(item.id)}",
                JSONObject().put("completed", completed),
                token,
            )
            parseItem(response.getJSONObject("item"))
        }

    suspend fun deleteItem(token: String, item: WorkspaceItem, scope: String? = null) = withContext(Dispatchers.IO) {
        request("DELETE", "/api/items/${pathSegment(item.id)}${scope?.let { "?scope=${pathSegment(it)}" }.orEmpty()}", token = token)
        Unit
    }

    private fun request(
        method: String,
        path: String,
        body: JSONObject? = null,
        token: String? = null,
    ): JSONObject {
        val jsonBody = body?.toString()?.toRequestBody(JSON_MEDIA_TYPE)
        val requestBuilder = Request.Builder()
            .url("$baseUrl$path")
            .header("Accept", "application/json")
        if (token != null) requestBuilder.header("Authorization", "Bearer $token")
        val request = when (method) {
            "GET" -> requestBuilder.get().build()
            "POST" -> requestBuilder.post(jsonBody ?: ByteArray(0).toRequestBody(JSON_MEDIA_TYPE)).build()
            "PATCH" -> requestBuilder.patch(jsonBody ?: throw IllegalArgumentException("PATCH needs a JSON body.")).build()
            "DELETE" -> requestBuilder.delete().build()
            else -> throw IllegalArgumentException("Unsupported API method.")
        }
        try {
            return httpClient.newCall(request).execute().use { response ->
                val responseText = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    val message = runCatching { JSONObject(responseText).optString("error") }
                        .getOrNull()
                        ?.takeIf(String::isNotBlank)
                        ?: "Request failed (HTTP ${response.code})."
                    throw ApiException(response.code, message)
                }
                if (responseText.isBlank()) JSONObject() else JSONObject(responseText)
            }
        } catch (error: ApiException) {
            throw error
        } catch (error: Exception) {
            throw IOException(error.message ?: "Could not reach the FileTasks server.", error)
        }
    }

    private fun authResult(response: JSONObject): Pair<String, AccountUser> {
        val token = response.optString("token").takeIf(String::isNotBlank)
            ?: throw IOException("The server did not return a session token.")
        val user = response.optJSONObject("user")
            ?: throw IOException("The server did not return an account.")
        return token to parseUser(user)
    }

    private fun parseUser(json: JSONObject) = AccountUser(
        id = json.optString("id"),
        email = json.optString("email"),
    )

    private fun parseItem(json: JSONObject): WorkspaceItem {
        val kind = when (json.optString("kind")) {
            ItemKind.Task.wireValue -> ItemKind.Task
            ItemKind.Event.wireValue -> ItemKind.Event
            else -> throw IOException("The server returned an unknown item type.")
        }
        val fileArray = json.optJSONArray("files")
        val files = buildList { if (fileArray != null) for (index in 0 until fileArray.length()) {
            val file = fileArray.getJSONObject(index)
            add(WorkspaceFileSummary(file.optString("id"), file.optString("name"), file.optString("sourceType")))
        } }
        return WorkspaceItem(
            id = json.optString("id"),
            kind = kind,
            title = json.optString("title"),
            details = json.optString("details"),
            scheduledDate = json.nullableString("scheduledDate"),
            scheduledTime = json.nullableString("scheduledTime"),
            completed = if (json.isNull("completed")) null else json.optBoolean("completed"),
            createdAt = json.optString("createdAt"),
            updatedAt = json.optString("updatedAt"),
            files = files,
            recurrence = parseRecurrence(json.optJSONObject("recurrence")),
            reminders = parseReminders(json.optJSONArray("reminders")),
            seriesId = json.nullableString("seriesId"),
            occurrenceDate = json.nullableString("occurrenceDate"),
            isOccurrence = json.optBoolean("isOccurrence"),
        )
    }

    private fun parseFile(json: JSONObject): WorkspaceFile {
        val attachmentArray = json.optJSONArray("attachments")
        val attachments = buildList { if (attachmentArray != null) for (index in 0 until attachmentArray.length()) {
            val attachment = attachmentArray.getJSONObject(index)
            val kind = if (attachment.optString("itemKind") == ItemKind.Event.wireValue) ItemKind.Event else ItemKind.Task
            add(FileAttachment(attachment.optString("itemId"), kind, attachment.optString("itemTitle"), attachment.optString("scope", "occurrence")))
        } }
        return WorkspaceFile(
            id = json.optString("id"), name = json.optString("name"), sourceType = json.optString("sourceType"),
            contentType = json.nullableString("contentType"), sizeBytes = if (json.isNull("sizeBytes")) null else json.optLong("sizeBytes"),
            externalUrl = json.nullableString("externalUrl"), createdAt = json.optString("createdAt"), attachments = attachments,
        )
    }

    private fun itemBody(fields: ItemFields) = JSONObject()
        .put("kind", fields.kind.wireValue)
        .put("title", fields.title)
        .put("details", fields.details)
        .put("scheduledDate", fields.scheduledDate ?: JSONObject.NULL)
        .put("scheduledTime", fields.scheduledTime ?: JSONObject.NULL)
        .put("recurrence", fields.recurrence?.let(::recurrenceObject) ?: JSONObject.NULL)
        .put("reminders", reminderArray(fields.reminders))
        .apply { fields.scope?.let { put("scope", it) } }

    private fun parseReminderSettings(json: JSONObject) = ReminderSettings(
        taskReminders = parseReminders(json.optJSONArray("taskReminders")),
        eventReminders = parseReminders(json.optJSONArray("eventReminders")),
        pushEnabled = json.optBoolean("pushEnabled"), emailEnabled = json.optBoolean("emailEnabled"),
        pushAvailable = json.optBoolean("pushAvailable"), emailAvailable = json.optBoolean("emailAvailable"),
    )

    private fun parseReminders(array: org.json.JSONArray?): List<ReminderRule> = buildList {
        if (array != null) for (index in 0 until array.length()) {
            val reminder = array.getJSONObject(index)
            add(ReminderRule(reminder.optString("delivery"), reminder.optInt("amount"), reminder.optString("unit"), reminder.optString("time")))
        }
    }

    private fun reminderArray(reminders: List<ReminderRule>) = org.json.JSONArray().apply {
        reminders.forEach { put(JSONObject().put("delivery", it.delivery).put("amount", it.amount).put("unit", it.unit).put("time", it.time)) }
    }

    private fun parseRecurrence(json: JSONObject?): RecurrenceRule? {
        if (json == null) return null
        val endJson = json.optJSONObject("end") ?: return null
        val end = when (endJson.optString("type")) {
            "date" -> RecurrenceEnd("date", date = endJson.optString("date"))
            "count" -> RecurrenceEnd("count", count = endJson.optInt("count"))
            else -> RecurrenceEnd("never")
        }
        val weekdayArray = json.optJSONArray("weekdays")
        val weekdays = weekdayArray?.let { array -> buildList { for (index in 0 until array.length()) add(array.getInt(index)) } }
        return RecurrenceRule(json.optInt("interval", 1), json.optString("unit"), weekdays, end)
    }

    private fun recurrenceObject(rule: RecurrenceRule) = JSONObject()
        .put("interval", rule.interval)
        .put("unit", rule.unit)
        .apply {
            rule.weekdays?.let { weekdays -> put("weekdays", org.json.JSONArray().apply { weekdays.forEach { put(it) } }) }
            put("end", JSONObject().put("type", rule.end.type).apply {
                rule.end.date?.let { put("date", it) }
                rule.end.count?.let { put("count", it) }
            })
        }

    private fun pathSegment(value: String): String = java.net.URLEncoder.encode(value, "UTF-8")

    private fun JSONObject.nullableString(key: String): String? =
        if (isNull(key)) null else optString(key)

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        fun normalizeBaseUrl(raw: String): String {
            val uri = runCatching { URI(raw.trim()).normalize() }
                .getOrElse { throw IllegalArgumentException("Enter a valid API URL.") }
            val scheme = uri.scheme?.lowercase()
            val host = uri.host?.lowercase()
            if (scheme !in setOf("http", "https") || host.isNullOrBlank() ||
                uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null ||
                uri.path.orEmpty().contains("..")
            ) {
                throw IllegalArgumentException("Enter an HTTP or HTTPS API URL without credentials, query, or fragment.")
            }
            if (scheme == "http" && host !in localDevelopmentHosts) {
                throw IllegalArgumentException("Use HTTPS except for localhost development endpoints.")
            }
            val authority = uri.rawAuthority
                ?: throw IllegalArgumentException("Enter a valid API host and port.")
            val pathPrefix = uri.rawPath.orEmpty().trimEnd('/')
            return "$scheme://$authority$pathPrefix"
        }

        private val localDevelopmentHosts = setOf(
            "10.0.2.2",
            "localhost",
            "127.0.0.1",
            "::1",
            "[::1]",
            "0:0:0:0:0:0:0:1",
        )
    }
}
