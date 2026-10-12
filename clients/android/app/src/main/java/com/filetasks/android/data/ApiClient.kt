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
)

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

    suspend fun deleteItem(token: String, item: WorkspaceItem) = withContext(Dispatchers.IO) {
        request("DELETE", "/api/items/${pathSegment(item.id)}", token = token)
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
        )
    }

    private fun itemBody(fields: ItemFields) = JSONObject()
        .put("kind", fields.kind.wireValue)
        .put("title", fields.title)
        .put("details", fields.details)
        .put("scheduledDate", fields.scheduledDate ?: JSONObject.NULL)
        .put("scheduledTime", fields.scheduledTime ?: JSONObject.NULL)

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
