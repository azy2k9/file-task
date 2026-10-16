package com.filetasks.android.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.filetasks.android.data.AccountUser
import com.filetasks.android.data.ApiClient
import com.filetasks.android.data.ApiException
import com.filetasks.android.data.ItemFields
import com.filetasks.android.data.ItemKind
import com.filetasks.android.data.FileAttachment
import com.filetasks.android.data.PushDevice
import com.filetasks.android.data.RecurrenceEnd
import com.filetasks.android.data.RecurrenceRule
import com.filetasks.android.data.ReminderRule
import com.filetasks.android.data.ReminderSettings
import com.filetasks.android.data.TokenStore
import com.filetasks.android.data.WorkspaceFile
import com.filetasks.android.data.WorkspaceFileSummary
import com.filetasks.android.data.WorkspaceItem
import com.filetasks.android.PushMessagingService
import com.google.firebase.installations.FirebaseInstallations
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import kotlinx.coroutines.tasks.await
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.Locale

private const val DEFAULT_API_URL = "http://10.0.2.2:3000"
private const val PREFERENCES = "filetasks_private"
private const val API_URL_KEY = "api_url"

private data class EditorTarget(val item: WorkspaceItem?)

private fun attachmentSourceFor(item: WorkspaceItem, file: WorkspaceFile, items: List<WorkspaceItem>): FileAttachment? {
    file.attachments.firstOrNull { it.itemId == item.id }?.let { return it }
    val seriesId = item.seriesId ?: return null
    file.attachments.firstOrNull { it.scope == "series" && it.itemId == seriesId }?.let { return it }
    val occurrenceDate = item.occurrenceDate ?: return null
    return file.attachments.firstOrNull { attachment ->
        if (attachment.scope != "following") return@firstOrNull false
        val anchor = items.firstOrNull { it.id == attachment.itemId } ?: return@firstOrNull false
        anchor.seriesId == seriesId && anchor.occurrenceDate?.let { it <= occurrenceDate } == true
    }
}

private enum class ItemFilter { All, Tasks, Events }
private enum class WorkspaceSection { Agenda, Files }

@Composable
fun FileTasksApp(context: Context, openItemRequest: Pair<String, Long>? = null) {
    MaterialTheme(colorScheme = lightColorScheme(primary = Color(0xFF315F57))) {
        val preferences = remember(context) {
            context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        }
        val tokenStore = remember(context) { TokenStore(context) }
        val scope = rememberCoroutineScope()
        val operationMutex = remember { Mutex() }

        var apiBaseUrl by remember {
            mutableStateOf(preferences.getString(API_URL_KEY, DEFAULT_API_URL) ?: DEFAULT_API_URL)
        }
        var token by remember { mutableStateOf<String?>(null) }
        var user by remember { mutableStateOf<AccountUser?>(null) }
        var workspaceItems by remember { mutableStateOf(emptyList<WorkspaceItem>()) }
        var workspaceFiles by remember { mutableStateOf(emptyList<WorkspaceFile>()) }
        var reminderSettings by remember { mutableStateOf(ReminderSettings.Empty) }
        var pushDeviceId by remember { mutableStateOf<String?>(null) }
        var initialLoading by remember { mutableStateOf(true) }
        var working by remember { mutableStateOf(false) }
        var recoveryAvailable by remember { mutableStateOf(false) }
        var errorMessage by remember { mutableStateOf<String?>(null) }
        var authError by remember { mutableStateOf<String?>(null) }
        var authMode by rememberSaveable { mutableStateOf("login") }
        var email by rememberSaveable { mutableStateOf("") }
        var password by rememberSaveable { mutableStateOf("") }
        var itemFilter by rememberSaveable { mutableStateOf(ItemFilter.All.name) }
        var workspaceSection by rememberSaveable { mutableStateOf(WorkspaceSection.Agenda.name) }
        var showSettings by remember { mutableStateOf(false) }
        var showReminderSettings by remember { mutableStateOf(false) }
        var editorTarget by remember { mutableStateOf<EditorTarget?>(null) }
        var confirmDelete by remember { mutableStateOf<WorkspaceItem?>(null) }
        var recurringDeleteScope by rememberSaveable { mutableStateOf("occurrence") }
        var confirmDeleteFile by remember { mutableStateOf<WorkspaceFile?>(null) }
        var confirmRemoveAttachment by remember { mutableStateOf<Pair<WorkspaceFile, FileAttachment>?>(null) }
        var attachmentRemovalScope by rememberSaveable { mutableStateOf("occurrence") }
        var fileToAttach by remember { mutableStateOf<WorkspaceFile?>(null) }
        var showLinkDialog by remember { mutableStateOf(false) }
        var linkName by rememberSaveable { mutableStateOf("") }
        var linkUrl by rememberSaveable { mutableStateOf("") }

        LaunchedEffect(user?.id) {
            pushDeviceId = user?.id?.let { preferences.getString(PushMessagingService.pushDeviceKey(it), null) }
        }
        var handledOpenItemRequest by remember { mutableStateOf<Long?>(null) }
        LaunchedEffect(openItemRequest, workspaceItems) {
            val (itemId, requestId) = openItemRequest ?: return@LaunchedEffect
            if (handledOpenItemRequest == requestId) return@LaunchedEffect
            val item = workspaceItems.firstOrNull { it.id == itemId } ?: return@LaunchedEffect
            handledOpenItemRequest = requestId
            workspaceSection = WorkspaceSection.Agenda.name
            editorTarget = EditorTarget(item)
        }

        LaunchedEffect(Unit) {
            val savedToken = withContext(Dispatchers.IO) { tokenStore.read() }
            token = savedToken
            if (savedToken != null) {
                try {
                    val api = ApiClient(apiBaseUrl)
                    user = api.session(savedToken)
                    workspaceItems = api.listItems(savedToken)
                    workspaceFiles = api.listFiles(savedToken)
                    reminderSettings = api.reminderSettings(savedToken)
                } catch (failure: Exception) {
                    if (failure is ApiException && failure.statusCode == 401) {
                        withContext(Dispatchers.IO) { tokenStore.clear() }
                        token = null
                        user = null
                        workspaceItems = emptyList()
                        workspaceFiles = emptyList()
                        reminderSettings = ReminderSettings.Empty
                    } else {
                        recoveryAvailable = true
                        errorMessage = readableError(failure)
                    }
                }
            }
            initialLoading = false
        }

        fun runAction(action: suspend () -> Unit) {
            if (!operationMutex.tryLock()) return
            working = true
            scope.launch {
                errorMessage = null
                try {
                    action()
                } catch (failure: Exception) {
                    if (failure is ApiException && failure.statusCode == 401) {
                        withContext(Dispatchers.IO) { tokenStore.clear() }
                        token = null
                        user = null
                        workspaceItems = emptyList()
                        workspaceFiles = emptyList()
                        reminderSettings = ReminderSettings.Empty
                        recoveryAvailable = false
                        editorTarget = null
                        confirmDelete = null
                    }
                    errorMessage = readableError(failure)
                } finally {
                    working = false
                    operationMutex.unlock()
                }
            }
        }

        val uploadLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            val currentToken = token
            if (uri != null && currentToken != null) {
                runAction {
                    val metadata = queryFileMetadata(context, uri)
                    if (metadata.sizeBytes > 50_000_000) throw IllegalArgumentException("Files must be smaller than 50 MB.")
                    val bytes = withContext(Dispatchers.IO) {
                        context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                            ?: throw IllegalArgumentException("The selected File could not be read.")
                    }
                    if (bytes.isEmpty()) throw IllegalArgumentException("Choose a File that contains at least one byte.")
                    if (bytes.size > 50_000_000) throw IllegalArgumentException("Files must be smaller than 50 MB.")
                    val api = ApiClient(apiBaseUrl)
                    api.uploadFile(currentToken, metadata.name, metadata.contentType, bytes)
                    workspaceFiles = api.listFiles(currentToken)
                    workspaceItems = api.listItems(currentToken)
                }
            }
        }

        fun refreshItems() {
            val currentToken = token ?: return
            runAction {
                val api = ApiClient(apiBaseUrl)
                workspaceItems = api.listItems(currentToken)
                workspaceFiles = api.listFiles(currentToken)
                reminderSettings = api.reminderSettings(currentToken)
            }
        }

        fun signOut() {
            val currentToken = token
            val currentUserId = user?.id
            runAction {
                if (currentToken != null) {
                    val api = ApiClient(apiBaseUrl)
                    if (currentUserId != null) {
                        val key = PushMessagingService.pushDeviceKey(currentUserId)
                        pushDeviceId?.let { deviceId -> api.revokePushDevice(currentToken, PushDevice(deviceId, "android", "")) }
                        preferences.edit().remove(key).remove(PushMessagingService.pushFidKey(currentUserId)).putBoolean("push_enabled", false).putBoolean("push_device_revoked", true).apply()
                    }
                    runCatching { FirebaseMessaging.getInstance().unregister().await() }
                    runCatching { api.logout(currentToken) }
                }
                withContext(Dispatchers.IO) { tokenStore.clear() }
                token = null
                user = null
                workspaceItems = emptyList()
                workspaceFiles = emptyList()
                reminderSettings = ReminderSettings.Empty
                pushDeviceId = null
                recoveryAvailable = false
            }
        }

        fun authenticate() {
            if (!operationMutex.tryLock()) return
            val submittedEmail = email.trim()
            val submittedPassword = password
            val submittedApiUrl = apiBaseUrl
            authError = null
            if (submittedEmail.isBlank() || submittedPassword.isBlank()) {
                authError = "Enter your email and password."
                operationMutex.unlock()
                return
            }
            working = true
            scope.launch {
                try {
                    val api = ApiClient(submittedApiUrl)
                    val (newToken, account) = if (authMode == "register") {
                        api.register(submittedEmail, submittedPassword)
                    } else {
                        api.login(submittedEmail, submittedPassword)
                    }
                    withContext(Dispatchers.IO) { tokenStore.write(newToken) }
                    token = newToken
                    user = account
                    recoveryAvailable = false
                    authError = null
                    errorMessage = null
                    password = ""
                    try {
                        workspaceItems = api.listItems(newToken)
                        workspaceFiles = api.listFiles(newToken)
                        reminderSettings = api.reminderSettings(newToken)
                    } catch (failure: Exception) {
                        if (failure is ApiException && failure.statusCode == 401) {
                            withContext(Dispatchers.IO) { tokenStore.clear() }
                            token = null
                            user = null
                            workspaceItems = emptyList()
                            workspaceFiles = emptyList()
                            reminderSettings = ReminderSettings.Empty
                            authError = readableError(failure)
                        } else {
                            errorMessage = readableError(failure)
                        }
                    }
                } catch (failure: Exception) {
                    authError = readableError(failure)
                } finally {
                    working = false
                    operationMutex.unlock()
                }
            }
        }

        fun retrySavedSession() {
            val currentToken = token ?: return
            runAction {
                try {
                    val api = ApiClient(apiBaseUrl)
                    user = api.session(currentToken)
                    workspaceItems = api.listItems(currentToken)
                    workspaceFiles = api.listFiles(currentToken)
                    reminderSettings = api.reminderSettings(currentToken)
                    recoveryAvailable = false
                } catch (failure: ApiException) {
                    if (failure.statusCode == 401) {
                        withContext(Dispatchers.IO) { tokenStore.clear() }
                        token = null
                        user = null
                        workspaceItems = emptyList()
                        workspaceFiles = emptyList()
                        reminderSettings = ReminderSettings.Empty
                        recoveryAvailable = false
                    }
                    throw failure
                }
            }
        }

        fun saveExternalLink() {
            val currentToken = token ?: return
            val name = linkName.trim()
            val url = linkUrl.trim()
            if (name.isEmpty() || url.isEmpty()) {
                errorMessage = "Enter a name and web link."
                return
            }
            runAction {
                val api = ApiClient(apiBaseUrl)
                api.createLinkFile(currentToken, name, url)
                workspaceFiles = api.listFiles(currentToken)
                showLinkDialog = false
                linkName = ""
                linkUrl = ""
            }
        }

        fun addAttachment(file: WorkspaceFile, item: WorkspaceItem, attachmentScope: String = "occurrence") {
            val currentToken = token ?: return
            runAction {
                val api = ApiClient(apiBaseUrl)
                api.attachFile(currentToken, file, item, attachmentScope)
                workspaceFiles = api.listFiles(currentToken)
                workspaceItems = api.listItems(currentToken)
                fileToAttach = null
            }
        }

        fun removeAttachment(file: WorkspaceFile, attachment: FileAttachment, attachmentScope: String = "occurrence") {
            val currentToken = token ?: return
            runAction {
                val api = ApiClient(apiBaseUrl)
                api.removeAttachment(currentToken, file, attachment, attachmentScope)
                workspaceFiles = api.listFiles(currentToken)
                workspaceItems = api.listItems(currentToken)
                confirmRemoveAttachment = null
            }
        }

        fun removeFile(file: WorkspaceFile) {
            val currentToken = token ?: return
            runAction {
                val api = ApiClient(apiBaseUrl)
                api.deleteFile(currentToken, file)
                workspaceFiles = api.listFiles(currentToken)
                workspaceItems = api.listItems(currentToken)
                confirmDeleteFile = null
                confirmRemoveAttachment = null
            }
        }

        fun openFile(file: WorkspaceFile) {
            val currentToken = token ?: return
            runAction {
                val target = ApiClient(apiBaseUrl).openFile(currentToken, file)
                val uri = Uri.parse(target.url)
                val intent = Intent(Intent.ACTION_VIEW).apply {
                    if (target.contentType == null) data = uri else setDataAndType(uri, target.contentType)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
            }
        }

        if (initialLoading) {
            Surface(Modifier.fillMaxSize()) {
                Column(
                    modifier = Modifier.fillMaxSize().padding(24.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    CircularProgressIndicator()
                    Spacer(Modifier.height(16.dp))
                    Text("Connecting to FileTasks…")
                }
            }
        } else if (user == null) {
            SignInScreen(
                mode = authMode,
                email = email,
                password = password,
                isBusy = working,
                error = authError ?: errorMessage,
                recoveryAvailable = recoveryAvailable,
                onEmailChange = { email = it },
                onPasswordChange = { password = it },
                onModeChange = {
                    authMode = it
                    authError = null
                },
                onSubmit = ::authenticate,
                onRetrySession = ::retrySavedSession,
                onSettings = { showSettings = true },
            )
        } else {
            WorkspaceScreen(
                user = user!!,
                items = workspaceItems,
                files = workspaceFiles,
                reminderSettings = reminderSettings,
                filter = itemFilter,
                section = workspaceSection,
                isBusy = working,
                error = errorMessage,
                onFilterChange = { itemFilter = it.name },
                onSectionChange = { workspaceSection = it.name },
                onRefresh = ::refreshItems,
                onSignOut = ::signOut,
                onSettings = { showSettings = true },
                onReminderSettings = { showReminderSettings = true },
                onCreate = { editorTarget = EditorTarget(null) },
                onEdit = { editorTarget = EditorTarget(it) },
                onDelete = { confirmDelete = it },
                onUpload = { uploadLauncher.launch(arrayOf("*/*")) },
                onAddLink = { showLinkDialog = true },
                onAttach = { fileToAttach = it },
                onDeleteFile = { confirmDeleteFile = it },
                onRemoveAttachment = { file, attachment -> confirmRemoveAttachment = file to attachment },
                onOpenFile = ::openFile,
                onOpenItem = { item ->
                    workspaceSection = WorkspaceSection.Agenda.name
                    itemFilter = if (item.kind == ItemKind.Task) ItemFilter.Tasks.name else ItemFilter.Events.name
                    editorTarget = EditorTarget(item)
                },
                onToggleTask = { item ->
                    val currentToken = token
                    if (currentToken != null && !working) {
                        runAction {
                            val updated = ApiClient(apiBaseUrl).setTaskCompleted(
                                token = currentToken,
                                item = item,
                                completed = item.completed != true,
                            )
                            workspaceItems = workspaceItems.replaceItem(updated)
                        }
                    }
                },
            )
        }

        editorTarget?.let { target ->
            ItemEditorDialog(
                item = target.item,
                reminderSettings = reminderSettings,
                isBusy = working,
                onDismiss = { editorTarget = null },
                onSave = { fields ->
                    if (!operationMutex.tryLock()) {
                        throw IllegalStateException("Please wait for the current request to finish.")
                    }
                    working = true
                    try {
                        val currentToken = token ?: throw IllegalStateException("Sign in to save items.")
                        val api = ApiClient(apiBaseUrl)
                        val saved = if (target.item == null) {
                            api.createItem(currentToken, fields)
                        } else {
                            api.updateItem(currentToken, target.item, fields)
                        }
                        workspaceItems = if (target.item == null) {
                            workspaceItems + saved
                        } else {
                            workspaceItems.replaceItem(saved)
                        }
                    } catch (failure: Exception) {
                        if (failure is ApiException && failure.statusCode == 401) {
                            withContext(Dispatchers.IO) { tokenStore.clear() }
                            token = null
                            user = null
                            workspaceItems = emptyList()
                            recoveryAvailable = false
                            editorTarget = null
                            confirmDelete = null
                        }
                        throw failure
                    } finally {
                        working = false
                        operationMutex.unlock()
                    }
                },
            )
        }

        confirmDelete?.let { item ->
            AlertDialog(
                onDismissRequest = { if (!working) confirmDelete = null },
                title = { Text("Delete ${item.kind.displayName.lowercase()}?") },
                text = {
                    Column {
                        Text("“${item.title}” will be removed from your workspace.")
                        if (item.seriesId != null) {
                            listOf("occurrence" to "This Occurrence", "following" to "This and following Occurrences", "series" to "Whole series").forEach { (scope, label) ->
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    RadioButton(selected = recurringDeleteScope == scope, onClick = { recurringDeleteScope = scope }, enabled = !working)
                                    Text(label, modifier = Modifier.clickable(enabled = !working) { recurringDeleteScope = scope })
                                }
                            }
                        }
                    }
                },
                confirmButton = {
                    Button(
                        enabled = !working,
                        onClick = {
                            val currentToken = token
                            if (currentToken != null) {
                                runAction {
                                    val api = ApiClient(apiBaseUrl)
                                    api.deleteItem(currentToken, item, if (item.seriesId == null) null else recurringDeleteScope)
                                    workspaceItems = api.listItems(currentToken)
                                    workspaceFiles = api.listFiles(currentToken)
                                    reminderSettings = api.reminderSettings(currentToken)
                                    confirmDelete = null
                                }
                            }
                        },
                    ) { Text("Delete") }
                },
                dismissButton = {
                    TextButton(enabled = !working, onClick = { confirmDelete = null }) {
                        Text("Cancel")
                    }
                },
            )
        }

        if (showLinkDialog) {
            AlertDialog(
                onDismissRequest = { if (!working) showLinkDialog = false },
                title = { Text("Add an external link") },
                text = {
                    Column {
                        OutlinedTextField(value = linkName, onValueChange = { linkName = it }, label = { Text("Name") }, singleLine = true)
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(value = linkUrl, onValueChange = { linkUrl = it }, label = { Text("Web link") }, singleLine = true)
                    }
                },
                confirmButton = { TextButton(enabled = !working, onClick = ::saveExternalLink) { Text("Add link") } },
                dismissButton = { TextButton(enabled = !working, onClick = { showLinkDialog = false }) { Text("Cancel") } },
            )
        }

        fileToAttach?.let { file ->
            val availableItems = workspaceItems.filter { item -> file.attachments.none { it.itemId == item.id } }
            AlertDialog(
                onDismissRequest = { if (!working) fileToAttach = null },
                title = { Text("Attach ${file.name}") },
                text = {
                    Column(Modifier.fillMaxWidth().heightIn(max = 400.dp).verticalScroll(rememberScrollState())) {
                        if (availableItems.isEmpty()) Text("Every Task and Event already has this File attached.")
                        availableItems.forEach { item ->
                            if (item.seriesId != null) {
                                Text("${item.kind.displayName}: ${item.title}", style = MaterialTheme.typography.labelLarge)
                                TextButton(enabled = !working, onClick = { addAttachment(file, item, "occurrence") }) { Text("This Occurrence") }
                                TextButton(enabled = !working, onClick = { addAttachment(file, item, "following") }) { Text("This and following Occurrences") }
                                TextButton(enabled = !working, onClick = { addAttachment(file, item, "series") }) { Text("Whole series") }
                            } else {
                                TextButton(enabled = !working, onClick = { addAttachment(file, item) }) {
                                    Text("${item.kind.displayName}: ${item.title}")
                                }
                            }
                        }
                    }
                },
                confirmButton = { TextButton(onClick = { fileToAttach = null }) { Text("Close") } },
            )
        }

        confirmRemoveAttachment?.let { (file, attachment) ->
            AlertDialog(
                onDismissRequest = { if (!working) confirmRemoveAttachment = null },
                title = { Text("Remove this Attachment?") },
                text = {
                    Column {
                        Text("Remove ${file.name} from ${attachment.itemKind.displayName} “${attachment.itemTitle}” only, or delete the File from your Files section.")
                        if (attachment.scope == "series" || attachment.scope == "following") {
                            listOf("occurrence" to "This Occurrence", "following" to "This and following Occurrences").forEach { (scope, label) ->
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    RadioButton(selected = attachmentRemovalScope == scope, onClick = { attachmentRemovalScope = scope }, enabled = !working)
                                    Text(label, modifier = Modifier.clickable(enabled = !working) { attachmentRemovalScope = scope })
                                }
                            }
                            if (attachment.scope == "series") {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    RadioButton(selected = attachmentRemovalScope == "series", onClick = { attachmentRemovalScope = "series" }, enabled = !working)
                                    Text("Whole series", modifier = Modifier.clickable(enabled = !working) { attachmentRemovalScope = "series" })
                                }
                            }
                        }
                        if (file.attachments.size > 1) Text("Deleting this File removes it from ${file.attachments.size} Tasks or Events.", color = MaterialTheme.colorScheme.error)
                    }
                },
                confirmButton = { TextButton(enabled = !working, onClick = { removeAttachment(file, attachment, if (attachment.scope == "series" || attachment.scope == "following") attachmentRemovalScope else "occurrence") }) { Text("Remove Attachment") } },
                dismissButton = {
                    Row {
                        TextButton(enabled = !working, onClick = { removeFile(file) }) { Text("Delete File", color = MaterialTheme.colorScheme.error) }
                        TextButton(enabled = !working, onClick = { confirmRemoveAttachment = null }) { Text("Cancel") }
                    }
                },
            )
        }

        confirmDeleteFile?.let { file ->
            AlertDialog(
                onDismissRequest = { if (!working) confirmDeleteFile = null },
                title = { Text("Delete this File?") },
                text = {
                    Text(if (file.attachments.size > 1) "This File is attached to ${file.attachments.size} Tasks or Events. Deleting it removes all of those Attachments."
                    else if (file.attachments.size == 1) "Deleting this File also removes its Attachment from “${file.attachments[0].itemTitle}”."
                    else "${file.name} will be deleted from your Files section.")
                },
                confirmButton = { Button(enabled = !working, onClick = { removeFile(file) }) { Text("Delete File") } },
                dismissButton = { TextButton(enabled = !working, onClick = { confirmDeleteFile = null }) { Text("Cancel") } },
            )
        }

        if (showSettings) {
            SettingsDialog(
                initialUrl = apiBaseUrl,
                isBusy = working,
                onDismiss = { showSettings = false },
                onSave = { normalizedUrl ->
                    showSettings = false
                    if (normalizedUrl != apiBaseUrl) {
                        if (!operationMutex.tryLock()) return@SettingsDialog
                        working = true
                        val oldToken = token
                        val oldApiUrl = apiBaseUrl
                        scope.launch {
                            try {
                                if (oldToken != null) {
                                    runCatching { ApiClient(oldApiUrl).logout(oldToken) }
                                }
                                withContext(Dispatchers.IO) { tokenStore.clear() }
                                preferences.edit().putString(API_URL_KEY, normalizedUrl).apply()
                                apiBaseUrl = normalizedUrl
                                token = null
                                user = null
                                workspaceItems = emptyList()
                                workspaceFiles = emptyList()
                                reminderSettings = ReminderSettings.Empty
                                recoveryAvailable = false
                                errorMessage = "Server changed. Sign in to continue."
                            } finally {
                                working = false
                                operationMutex.unlock()
                            }
                        }
                    }
                },
            )
        }

        if (showReminderSettings) {
            ReminderSettingsDialog(
                initial = reminderSettings,
                isBusy = working,
                deviceRegistered = pushDeviceId != null,
                onDismiss = { showReminderSettings = false },
                onRevokeDevice = {
                    if (!operationMutex.tryLock()) throw IllegalStateException("Please wait for the current request to finish.")
                    working = true
                    try {
                        val currentToken = token ?: throw IllegalStateException("Sign in to manage push devices.")
                        val currentUser = user ?: throw IllegalStateException("Sign in to manage push devices.")
                        pushDeviceId?.let { deviceId ->
                            ApiClient(apiBaseUrl).revokePushDevice(currentToken, PushDevice(deviceId, "android", ""))
                            preferences.edit().remove(PushMessagingService.pushDeviceKey(currentUser.id))
                                .remove(PushMessagingService.pushFidKey(currentUser.id)).putBoolean("push_device_revoked", true).apply()
                            pushDeviceId = null
                            FirebaseMessaging.getInstance().unregister().await()
                        }
                    } finally {
                        working = false
                        operationMutex.unlock()
                    }
                },
                onSave = { updated, applyToExisting ->
                    if (!operationMutex.tryLock()) throw IllegalStateException("Please wait for the current request to finish.")
                    working = true
                    try {
                        val currentToken = token ?: throw IllegalStateException("Sign in to update Reminder settings.")
                        val currentUser = user ?: throw IllegalStateException("Sign in to update Reminder settings.")
                        val api = ApiClient(apiBaseUrl)
                        val wasPushEnabled = reminderSettings.pushEnabled
                        val savedSettings = api.updateReminderSettings(currentToken, updated, applyToExisting)
                        val deviceKey = PushMessagingService.pushDeviceKey(currentUser.id)
                        if (savedSettings.pushEnabled) {
                            val deviceWasExplicitlyRevoked = preferences.getBoolean(PushMessagingService.PUSH_REVOKED_KEY, false) && wasPushEnabled
                            preferences.edit().putBoolean("push_enabled", true)
                                .putBoolean(PushMessagingService.PUSH_REVOKED_KEY, deviceWasExplicitlyRevoked).apply()
                            if (pushDeviceId == null && !deviceWasExplicitlyRevoked) {
                                FirebaseMessaging.getInstance().register().await()
                                val installationId = FirebaseInstallations.getInstance().id.await()
                                val device = api.registerPushDevice(currentToken, "android", installationId)
                                preferences.edit().putString(deviceKey, device.id)
                                    .putString(PushMessagingService.pushFidKey(currentUser.id), installationId).apply()
                                pushDeviceId = device.id
                            }
                        } else {
                            preferences.edit().putBoolean("push_enabled", false).putBoolean("push_device_revoked", true).apply()
                            pushDeviceId?.let { deviceId ->
                                api.revokePushDevice(currentToken, PushDevice(deviceId, "android", ""))
                                preferences.edit().remove(deviceKey).remove(PushMessagingService.pushFidKey(currentUser.id)).apply()
                                pushDeviceId = null
                                FirebaseMessaging.getInstance().unregister().await()
                            }
                        }
                        reminderSettings = savedSettings
                        workspaceItems = api.listItems(currentToken)
                        showReminderSettings = false
                    } finally {
                        working = false
                        operationMutex.unlock()
                    }
                },
            )
        }
    }
}

@Composable
private fun SignInScreen(
    mode: String,
    email: String,
    password: String,
    isBusy: Boolean,
    error: String?,
    recoveryAvailable: Boolean,
    onEmailChange: (String) -> Unit,
    onPasswordChange: (String) -> Unit,
    onModeChange: (String) -> Unit,
    onSubmit: () -> Unit,
    onRetrySession: () -> Unit,
    onSettings: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 36.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("FileTasks", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(6.dp))
        Text("Keep Tasks and Events together.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(28.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = mode == "login", onClick = { onModeChange("login") }, label = { Text("Sign in") })
            FilterChip(selected = mode == "register", onClick = { onModeChange("register") }, label = { Text("Create account") })
        }
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = email,
            onValueChange = onEmailChange,
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Email") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = password,
            onValueChange = onPasswordChange,
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Password") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
            enabled = !isBusy,
        )
        error?.let {
            Spacer(Modifier.height(10.dp))
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }
        Spacer(Modifier.height(18.dp))
        Button(onClick = onSubmit, modifier = Modifier.fillMaxWidth(), enabled = !isBusy) {
            if (isBusy) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(10.dp))
            }
            Text(if (mode == "register") "Create account" else "Sign in")
        }
        if (recoveryAvailable) {
            TextButton(onClick = onRetrySession, enabled = !isBusy, modifier = Modifier.fillMaxWidth()) {
                Text("Retry saved session")
            }
        }
        Spacer(Modifier.height(16.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Server", color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(8.dp))
            TextButton(onClick = onSettings) { Text("Configure API URL") }
        }
    }
}

@Composable
private fun WorkspaceScreen(
    user: AccountUser,
    items: List<WorkspaceItem>,
    files: List<WorkspaceFile>,
    reminderSettings: ReminderSettings,
    filter: String,
    section: String,
    isBusy: Boolean,
    error: String?,
    onFilterChange: (ItemFilter) -> Unit,
    onSectionChange: (WorkspaceSection) -> Unit,
    onRefresh: () -> Unit,
    onSignOut: () -> Unit,
    onSettings: () -> Unit,
    onReminderSettings: () -> Unit,
    onCreate: () -> Unit,
    onEdit: (WorkspaceItem) -> Unit,
    onDelete: (WorkspaceItem) -> Unit,
    onUpload: () -> Unit,
    onAddLink: () -> Unit,
    onAttach: (WorkspaceFile) -> Unit,
    onDeleteFile: (WorkspaceFile) -> Unit,
    onRemoveAttachment: (WorkspaceFile, FileAttachment) -> Unit,
    onOpenFile: (WorkspaceFile) -> Unit,
    onOpenItem: (WorkspaceItem) -> Unit,
    onToggleTask: (WorkspaceItem) -> Unit,
) {
    val selectedSection = WorkspaceSection.valueOf(section)
    val showingFiles = selectedSection == WorkspaceSection.Files
    val selectedFilter = ItemFilter.valueOf(filter)
    val visibleItems = when (selectedFilter) {
        ItemFilter.All -> items
        ItemFilter.Tasks -> items.filter { it.kind == ItemKind.Task }
        ItemFilter.Events -> items.filter { it.kind == ItemKind.Event }
    }
    val datedGroups = visibleItems.filter { it.scheduledDate != null }
        .groupBy { it.scheduledDate!! }
        .toSortedMap()

    Scaffold(
        floatingActionButton = {
            if (showingFiles) {
                ExtendedFloatingActionButton(
                    text = { Text("Upload File") }, icon = { Text("+", style = MaterialTheme.typography.titleLarge) },
                    onClick = { if (!isBusy) onUpload() },
                    containerColor = if (isBusy) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.primary,
                    contentColor = if (isBusy) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onPrimary,
                )
            } else {
                ExtendedFloatingActionButton(
                    text = { Text("Add item") }, icon = { Text("+", style = MaterialTheme.typography.titleLarge) },
                    onClick = { if (!isBusy) onCreate() },
                    containerColor = if (isBusy) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.primary,
                    contentColor = if (isBusy) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onPrimary,
                )
            }
        },
    ) { insets ->
        Column(Modifier.fillMaxSize().padding(insets)) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Your workspace", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                        Text(user.email, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    TextButton(onClick = onRefresh, enabled = !isBusy) { Text("Refresh") }
                    TextButton(onClick = onSettings, enabled = !isBusy) { Text("Server") }
                    TextButton(onClick = onReminderSettings, enabled = !isBusy) { Text("Reminders") }
                    TextButton(onClick = onSignOut, enabled = !isBusy) { Text("Sign out") }
                }
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = !showingFiles, onClick = { onSectionChange(WorkspaceSection.Agenda) }, label = { Text("Agenda · ${items.size}") })
                    FilterChip(selected = showingFiles, onClick = { onSectionChange(WorkspaceSection.Files) }, label = { Text("Files · ${files.size}") })
                }
                if (!showingFiles) {
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ItemFilter.entries.forEach { option ->
                        FilterChip(
                            selected = selectedFilter == option,
                            onClick = { onFilterChange(option) },
                            label = {
                                val count = when (option) {
                                    ItemFilter.All -> items.size
                                    ItemFilter.Tasks -> items.count { it.kind == ItemKind.Task }
                                    ItemFilter.Events -> items.count { it.kind == ItemKind.Event }
                                }
                                Text("${option.label} · $count")
                            },
                        )
                    }
                    }
                }
                if (isBusy) {
                    Spacer(Modifier.height(8.dp))
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                }
                error?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            }

            if (showingFiles) {
                if (files.isEmpty()) {
                    Column(
                        modifier = Modifier.fillMaxSize().padding(32.dp),
                        verticalArrangement = Arrangement.Center,
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(if (isBusy) "Loading Files…" else "Your Files have a home here.", fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(6.dp))
                        Text("Upload a document or add a link, then attach it to a Task or Event.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        TextButton(onClick = onAddLink, enabled = !isBusy) { Text("Add an external link") }
                    }
                } else {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 104.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        items(files, key = { it.id }) { file ->
                            WorkspaceFileCard(
                                file = file,
                                items = items,
                                enabled = !isBusy,
                                onOpen = { onOpenFile(file) },
                                onAttach = { onAttach(file) },
                                onDelete = { onDeleteFile(file) },
                                onRemoveAttachment = { attachment -> onRemoveAttachment(file, attachment) },
                                onOpenItem = { attachment -> items.firstOrNull { it.id == attachment.itemId }?.let(onOpenItem) },
                            )
                        }
                        item { TextButton(onClick = onAddLink, enabled = !isBusy, modifier = Modifier.fillMaxWidth()) { Text("Add an external link") } }
                    }
                }
            } else if (visibleItems.isEmpty()) {
                Column(
                    modifier = Modifier.fillMaxSize().padding(32.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(if (isBusy) "Loading items…" else "Nothing here yet", fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(6.dp))
                    Text(
                        if (isBusy) "Your account data is syncing." else "Add a Task or Event to start your agenda.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(
                        start = 16.dp,
                        end = 16.dp,
                        top = 4.dp,
                        bottom = 104.dp,
                    ),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    datedGroups.forEach { (date, dayItems) ->
                        item(key = "date-$date") {
                            Text(
                                formatDateHeading(date),
                                modifier = Modifier.padding(top = 14.dp, bottom = 2.dp),
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                        items(dayItems.sortedWith(compareBy<WorkspaceItem> { it.scheduledTime ?: "99:99" }.thenBy { it.title.lowercase() }), key = { it.id }) { item ->
                            WorkspaceItemCard(
                                item = item,
                                enabled = !isBusy,
                                onToggleTask = { onToggleTask(item) },
                                onEdit = { onEdit(item) },
                                onDelete = { onDelete(item) },
                                onOpenFile = { summary -> files.firstOrNull { it.id == summary.id }?.let(onOpenFile) },
                                onRemoveAttachment = { summary ->
                                    val file = files.firstOrNull { it.id == summary.id }
                                    val source = file?.let { attachmentSourceFor(item, it, items) }
                                    if (file != null && source != null) {
                                        onRemoveAttachment(file, source.copy(itemId = item.id, itemKind = item.kind, itemTitle = item.title))
                                    }
                                },
                            )
                        }
                    }
                    val undated = visibleItems.filter { it.scheduledDate == null }
                    if (undated.isNotEmpty()) {
                        item(key = "undated-heading") {
                            Text(
                                "Undated",
                                modifier = Modifier.padding(top = 14.dp, bottom = 2.dp),
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                        items(undated.sortedBy { it.title.lowercase() }, key = { it.id }) { item ->
                            WorkspaceItemCard(
                                item = item,
                                enabled = !isBusy,
                                onToggleTask = { onToggleTask(item) },
                                onEdit = { onEdit(item) },
                                onDelete = { onDelete(item) },
                                onOpenFile = { summary -> files.firstOrNull { it.id == summary.id }?.let(onOpenFile) },
                                onRemoveAttachment = { summary ->
                                    val file = files.firstOrNull { it.id == summary.id }
                                    val source = file?.let { attachmentSourceFor(item, it, items) }
                                    if (file != null && source != null) {
                                        onRemoveAttachment(file, source.copy(itemId = item.id, itemKind = item.kind, itemTitle = item.title))
                                    }
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun WorkspaceItemCard(
    item: WorkspaceItem,
    enabled: Boolean,
    onToggleTask: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    onOpenFile: (WorkspaceFileSummary) -> Unit,
    onRemoveAttachment: (WorkspaceFileSummary) -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, top = 12.dp, end = 8.dp, bottom = 8.dp)) {
            if (item.kind == ItemKind.Task) {
                Checkbox(
                    checked = item.completed == true,
                    onCheckedChange = { onToggleTask() },
                    enabled = enabled,
                    modifier = Modifier.padding(top = 0.dp),
                )
                Spacer(Modifier.width(4.dp))
            }
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Surface(
                        color = if (item.kind == ItemKind.Task) Color(0xFFE7F1ED) else Color(0xFFFFF0DB),
                        shape = MaterialTheme.shapes.small,
                    ) {
                        Text(
                            item.kind.displayName,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                    item.scheduledTime?.let {
                        Spacer(Modifier.width(8.dp))
                        Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium)
                    }
                    if (item.kind == ItemKind.Task && item.completed == true) {
                        Spacer(Modifier.width(8.dp))
                        Text("Complete", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall)
                    }
                }
                Spacer(Modifier.height(5.dp))
                Text(
                    text = item.title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    textDecoration = if (item.kind == ItemKind.Task && item.completed == true) TextDecoration.LineThrough else TextDecoration.None,
                )
                if (item.details.isNotBlank()) {
                    Spacer(Modifier.height(3.dp))
                    Text(item.details, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                }
                item.files.forEach { file ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        TextButton(onClick = { onOpenFile(file) }, enabled = enabled, modifier = Modifier.weight(1f)) {
                            Text("▤ ${file.name}")
                        }
                        TextButton(onClick = { onRemoveAttachment(file) }, enabled = enabled) {
                            Text("Remove", color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.align(Alignment.End)) {
                    TextButton(onClick = onEdit, enabled = enabled) { Text("Edit") }
                    TextButton(onClick = onDelete, enabled = enabled) { Text("Delete", color = MaterialTheme.colorScheme.error) }
                }
            }
        }
    }
}

@Composable
private fun WorkspaceFileCard(
    file: WorkspaceFile,
    items: List<WorkspaceItem>,
    enabled: Boolean,
    onOpen: () -> Unit,
    onAttach: () -> Unit,
    onDelete: () -> Unit,
    onRemoveAttachment: (FileAttachment) -> Unit,
    onOpenItem: (FileAttachment) -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(file.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(
                        if (file.sizeBytes == null) "External link" else "${file.sizeBytes / 1000} KB · ${file.contentType.orEmpty()}",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                TextButton(enabled = enabled, onClick = onOpen) { Text("Open") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                TextButton(enabled = enabled && items.size > file.attachments.size, onClick = onAttach) { Text("Attach") }
                TextButton(enabled = enabled, onClick = onDelete) { Text("Delete File", color = MaterialTheme.colorScheme.error) }
            }
            Text("Attached to", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (file.attachments.isEmpty()) {
                Text("No Tasks or Events yet", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            file.attachments.forEach { attachment ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    TextButton(enabled = enabled, onClick = { onOpenItem(attachment) }, modifier = Modifier.weight(1f)) {
                        Text("${attachment.itemKind.displayName}: ${attachment.itemTitle}")
                    }
                    TextButton(enabled = enabled, onClick = { onRemoveAttachment(attachment) }) { Text("Remove") }
                }
            }
        }
    }
}

private data class SelectedFileMetadata(val name: String, val sizeBytes: Long, val contentType: String)

private fun queryFileMetadata(context: Context, uri: Uri): SelectedFileMetadata {
    var name = uri.lastPathSegment?.substringAfterLast('/')?.takeIf(String::isNotBlank) ?: "Uploaded File"
    var size = 0L
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
            val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            val sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE)
            if (nameColumn >= 0) name = cursor.getString(nameColumn) ?: name
            if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) size = cursor.getLong(sizeColumn)
        }
    }
    return SelectedFileMetadata(name, size, context.contentResolver.getType(uri) ?: "application/octet-stream")
}

@Composable
private fun ItemEditorDialog(
    item: WorkspaceItem?,
    reminderSettings: ReminderSettings,
    isBusy: Boolean,
    onDismiss: () -> Unit,
    onSave: suspend (ItemFields) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var kindValue by rememberSaveable(item?.id) { mutableStateOf(item?.kind?.wireValue ?: ItemKind.Task.wireValue) }
    var title by rememberSaveable(item?.id) { mutableStateOf(item?.title.orEmpty()) }
    var details by rememberSaveable(item?.id) { mutableStateOf(item?.details.orEmpty()) }
    var date by rememberSaveable(item?.id) { mutableStateOf(item?.scheduledDate.orEmpty()) }
    var time by rememberSaveable(item?.id) { mutableStateOf(item?.scheduledTime.orEmpty()) }
    var recurrence by remember(item?.id) { mutableStateOf(item?.recurrence) }
    var recurrenceEndType by rememberSaveable(item?.id) { mutableStateOf(item?.recurrence?.end?.type ?: "never") }
    var recurrenceEndDate by rememberSaveable(item?.id) { mutableStateOf((item?.recurrence?.end?.date).orEmpty()) }
    var recurrenceCount by rememberSaveable(item?.id) { mutableStateOf((item?.recurrence?.end?.count ?: 10).toString()) }
    var weekdays by remember(item?.id) { mutableStateOf((item?.recurrence?.weekdays ?: emptyList()).toSet()) }
    var reminders by remember(item?.id) {
        mutableStateOf(item?.reminders ?: reminderSettings.taskReminders)
    }
    var reminderRowsTouched by remember(item?.id) { mutableStateOf(item != null) }
    var editScope by rememberSaveable(item?.id) { mutableStateOf("occurrence") }
    var validationError by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }

    val kind = if (kindValue == ItemKind.Event.wireValue) ItemKind.Event else ItemKind.Task
    AlertDialog(
        onDismissRequest = { if (!saving) onDismiss() },
        title = { Text(if (item == null) "Add to your workspace" else "Edit item") },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(
                        selected = kind == ItemKind.Task,
                        onClick = {
                            kindValue = ItemKind.Task.wireValue
                            if (item == null && !reminderRowsTouched) reminders = reminderSettings.taskReminders
                        },
                        enabled = item == null && !saving && !isBusy,
                        label = { Text("Task") },
                    )
                    FilterChip(
                        selected = kind == ItemKind.Event,
                        onClick = {
                            kindValue = ItemKind.Event.wireValue
                            if (item == null && !reminderRowsTouched) reminders = reminderSettings.eventReminders
                        },
                        enabled = item == null && !saving && !isBusy,
                        label = { Text("Event") },
                    )
                }
                if (item != null) {
                    Text("${item.kind.displayName} · ${item.id}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Title") },
                    singleLine = true,
                    enabled = !saving && !isBusy,
                )
                OutlinedTextField(
                    value = details,
                    onValueChange = { details = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Details") },
                    minLines = 2,
                    maxLines = 4,
                    enabled = !saving && !isBusy,
                )
                OutlinedTextField(
                    value = date,
                    onValueChange = { date = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Date (YYYY-MM-DD, optional)") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Next),
                    enabled = !saving && !isBusy,
                )
                OutlinedTextField(
                    value = time,
                    onValueChange = { time = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Time (HH:mm, optional)") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done),
                    enabled = !saving && !isBusy,
                )
                Text("A time needs a date. Leave both fields empty for an undated item.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = recurrence != null, onCheckedChange = { enabled ->
                        if (enabled && date.isNotBlank()) {
                            val weekday = runCatching { LocalDate.parse(date).dayOfWeek.value % 7 }.getOrDefault(0)
                            weekdays = setOf(weekday)
                            recurrence = RecurrenceRule(1, "weeks", listOf(weekday), RecurrenceEnd("never"))
                        } else recurrence = null
                    }, enabled = !saving && !isBusy && date.isNotBlank())
                    Text("Repeat")
                }
                recurrence?.let { rule ->
                    OutlinedTextField(
                        value = rule.interval.toString(),
                        onValueChange = { value -> recurrence = recurrence?.copy(interval = value.toIntOrNull()?.coerceIn(1, 100) ?: 1) },
                        modifier = Modifier.fillMaxWidth(), label = { Text("Repeat interval") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), enabled = !saving && !isBusy,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        listOf("days", "weeks", "months", "years").forEach { unit ->
                            FilterChip(selected = rule.unit == unit, onClick = {
                                recurrence = recurrence?.copy(unit = unit, weekdays = if (unit == "weeks") (weekdays.ifEmpty { setOf(0) }).sorted() else null)
                            }, enabled = !saving && !isBusy, label = { Text(unit) })
                        }
                    }
                    if (rule.unit == "weeks") {
                        Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                            listOf("S", "M", "T", "W", "T", "F", "S").forEachIndexed { day, label ->
                                FilterChip(selected = day in weekdays, onClick = {
                                    weekdays = if (day in weekdays) (weekdays - day).ifEmpty { setOf(day) } else weekdays + day
                                    recurrence = recurrence?.copy(weekdays = weekdays.sorted())
                                }, enabled = !saving && !isBusy, label = { Text(label) })
                            }
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        listOf("never", "date", "count").forEach { end ->
                            FilterChip(selected = recurrenceEndType == end, onClick = {
                                recurrenceEndType = end
                                recurrence = recurrence?.copy(end = when (end) {
                                    "date" -> RecurrenceEnd("date", date = recurrenceEndDate.ifBlank { date })
                                    "count" -> RecurrenceEnd("count", count = recurrenceCount.toIntOrNull() ?: 10)
                                    else -> RecurrenceEnd("never")
                                })
                            }, enabled = !saving && !isBusy, label = { Text(when (end) { "date" -> "On date"; "count" -> "After count"; else -> "Never" }) })
                        }
                    }
                    if (recurrenceEndType == "date") {
                        OutlinedTextField(value = recurrenceEndDate, onValueChange = {
                            recurrenceEndDate = it
                            recurrence = recurrence?.copy(end = RecurrenceEnd("date", date = it))
                        }, modifier = Modifier.fillMaxWidth(), label = { Text("End date (YYYY-MM-DD)") }, enabled = !saving && !isBusy)
                    } else if (recurrenceEndType == "count") {
                        OutlinedTextField(value = recurrenceCount, onValueChange = {
                            recurrenceCount = it
                            recurrence = recurrence?.copy(end = RecurrenceEnd("count", count = it.toIntOrNull() ?: 1))
                        }, modifier = Modifier.fillMaxWidth(), label = { Text("Occurrence count") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), enabled = !saving && !isBusy)
                    }
                }
                if (item?.seriesId != null) {
                    Text("Apply changes to", style = MaterialTheme.typography.labelLarge)
                    listOf("occurrence" to "This Occurrence", "following" to "This and following Occurrences", "series" to "Whole series").forEach { (scopeValue, label) ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = editScope == scopeValue, onClick = { editScope = scopeValue }, enabled = !saving && !isBusy)
                            Text(label, modifier = Modifier.clickable(enabled = !saving && !isBusy) { editScope = scopeValue })
                        }
                    }
                }
                Text("Reminders", style = MaterialTheme.typography.labelLarge)
                ReminderRuleEditor(reminders, reminderSettings.emailAvailable && reminderSettings.emailEnabled, !saving && !isBusy) {
                    reminders = it
                    reminderRowsTouched = true
                }
                validationError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            Button(
                enabled = !saving && !isBusy,
                onClick = {
                    val fields = validateFields(kind, title, details, date, time)
                    if (fields is FieldValidation.Invalid) {
                        validationError = fields.reason
                    } else {
                        validationError = null
                        val validFields = (fields as FieldValidation.Valid).fields.copy(
                            recurrence = if (date.isBlank()) null else recurrence?.let { rule ->
                                rule.copy(
                                    weekdays = if (rule.unit == "weeks") weekdays.sorted() else null,
                                    end = when (recurrenceEndType) {
                                        "date" -> RecurrenceEnd("date", date = recurrenceEndDate.ifBlank { date })
                                        "count" -> RecurrenceEnd("count", count = recurrenceCount.toIntOrNull() ?: 1)
                                        else -> RecurrenceEnd("never")
                                    },
                                )
                            },
                            reminders = reminders,
                            scope = if (item?.seriesId != null) editScope else null,
                        )
                        scope.launch {
                            saving = true
                            try {
                                onSave(validFields)
                                onDismiss()
                            } catch (failure: Exception) {
                                validationError = readableError(failure)
                            } finally {
                                saving = false
                            }
                        }
                    }
                },
            ) {
                if (saving) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                else Text(if (item == null) "Create" else "Save")
            }
        },
        dismissButton = {
            TextButton(enabled = !saving && !isBusy, onClick = onDismiss) { Text("Cancel") }
        },
    )
}

@Composable
private fun ReminderRuleEditor(
    reminders: List<ReminderRule>,
    emailAvailable: Boolean,
    enabled: Boolean,
    onChange: (List<ReminderRule>) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        reminders.forEachIndexed { index, reminder ->
            Text("Reminder ${index + 1}", style = MaterialTheme.typography.labelMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                FilterChip(selected = reminder.delivery == "notification", onClick = {
                    onChange(reminders.mapIndexed { row, value -> if (row == index) value.copy(delivery = "notification") else value })
                }, enabled = enabled, label = { Text("Notification") })
                FilterChip(selected = reminder.delivery == "email", onClick = {
                    onChange(reminders.mapIndexed { row, value -> if (row == index) value.copy(delivery = "email") else value })
                }, enabled = enabled && emailAvailable, label = { Text("Email") })
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = reminder.amount.toString(), onValueChange = { value ->
                        val amount = value.toIntOrNull()?.coerceIn(0, 100_000) ?: 0
                        onChange(reminders.mapIndexed { row, current -> if (row == index) current.copy(amount = amount) else current })
                    }, modifier = Modifier.weight(1f), label = { Text("Offset") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), enabled = enabled,
                )
                OutlinedTextField(
                    value = reminder.time, onValueChange = { value ->
                        onChange(reminders.mapIndexed { row, current -> if (row == index) current.copy(time = value) else current })
                    }, modifier = Modifier.weight(1f), label = { Text("Clock time") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii), enabled = enabled,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                listOf("minutes", "hours", "days", "weeks", "months").forEach { unit ->
                    FilterChip(selected = reminder.unit == unit, onClick = {
                        onChange(reminders.mapIndexed { row, current -> if (row == index) current.copy(unit = unit) else current })
                    }, enabled = enabled, label = { Text(unit.take(2)) })
                }
            }
            TextButton(enabled = enabled, onClick = { onChange(reminders.filterIndexed { row, _ -> row != index }) }) { Text("Remove Reminder") }
        }
        TextButton(enabled = enabled && reminders.size < 20, onClick = {
            onChange(reminders + ReminderRule("notification", 1, "days", "09:00"))
        }) { Text("Add Reminder") }
    }
}

@Composable
private fun SettingsDialog(
    initialUrl: String,
    isBusy: Boolean,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit,
) {
    var url by rememberSaveable { mutableStateOf(initialUrl) }
    var validationError by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("API server") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = url,
                    onValueChange = { url = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Base URL") },
                    placeholder = { Text("https://example.com") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
                    enabled = !isBusy,
                )
                Text("The URL can include a path prefix. Changing servers signs you out.", style = MaterialTheme.typography.bodySmall)
                validationError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            Button(enabled = !isBusy, onClick = {
                try {
                    onSave(ApiClient.normalizeBaseUrl(url))
                } catch (failure: IllegalArgumentException) {
                    validationError = failure.message
                }
            }) { Text("Save") }
        },
        dismissButton = { TextButton(enabled = !isBusy, onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun ReminderSettingsDialog(
    initial: ReminderSettings,
    isBusy: Boolean,
    deviceRegistered: Boolean,
    onDismiss: () -> Unit,
    onRevokeDevice: suspend () -> Unit,
    onSave: suspend (ReminderSettings, Boolean) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var settings by remember(initial) { mutableStateOf(initial) }
    var applyToExisting by rememberSaveable { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var permissionWaiter by remember { mutableStateOf<CompletableDeferred<Boolean>?>(null) }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permissionWaiter?.complete(granted)
        permissionWaiter = null
    }
    suspend fun requestNotificationPermission(): Boolean {
        if (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return true
        val response = CompletableDeferred<Boolean>()
        permissionWaiter = response
        permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        return response.await()
    }
    AlertDialog(
        onDismissRequest = { if (!saving && !isBusy) onDismiss() },
        title = { Text("Reminder settings") },
        text = {
            Column(Modifier.fillMaxWidth().heightIn(max = 560.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = settings.pushEnabled, onCheckedChange = { settings = settings.copy(pushEnabled = it) }, enabled = !saving && !isBusy && settings.pushAvailable)
                    Text("Push delivery${if (settings.pushAvailable) "" else " (not configured)"}")
                }
                if (deviceRegistered) {
                    TextButton(enabled = !saving && !isBusy, onClick = {
                        scope.launch {
                            saving = true
                            error = null
                            try { onRevokeDevice() }
                            catch (failure: Exception) { error = readableError(failure) }
                            finally { saving = false }
                        }
                    }) { Text("Revoke this device's push registration") }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = settings.emailEnabled, onCheckedChange = { settings = settings.copy(emailEnabled = it) }, enabled = !saving && !isBusy && settings.emailAvailable)
                    Text("Email delivery${if (settings.emailAvailable) "" else " (not configured)"}")
                }
                Text("Task defaults", style = MaterialTheme.typography.titleSmall)
                ReminderRuleEditor(settings.taskReminders, settings.emailAvailable && settings.emailEnabled, !saving && !isBusy) {
                    settings = settings.copy(taskReminders = it)
                }
                Text("Event defaults", style = MaterialTheme.typography.titleSmall)
                ReminderRuleEditor(settings.eventReminders, settings.emailAvailable && settings.emailEnabled, !saving && !isBusy) {
                    settings = settings.copy(eventReminders = it)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = applyToExisting, onCheckedChange = { applyToExisting = it }, enabled = !saving && !isBusy)
                    Text("Apply to items still using old defaults")
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            Button(enabled = !saving && !isBusy, onClick = {
                scope.launch {
                    saving = true
                    error = null
                    try {
                        if (settings.pushEnabled && !requestNotificationPermission()) throw IllegalStateException("Allow notifications to register this device for push delivery.")
                        onSave(settings, applyToExisting)
                    }
                    catch (failure: Exception) { error = readableError(failure) }
                    finally { saving = false }
                }
            }) { Text(if (saving) "Saving…" else "Save") }
        },
        dismissButton = { TextButton(enabled = !saving && !isBusy, onClick = onDismiss) { Text("Cancel") } },
    )
}

private sealed interface FieldValidation {
    data class Valid(val fields: ItemFields) : FieldValidation
    data class Invalid(val reason: String) : FieldValidation
}

private fun validateFields(
    kind: ItemKind,
    title: String,
    details: String,
    date: String,
    time: String,
): FieldValidation {
    val cleanTitle = title.trim()
    if (cleanTitle.isBlank()) return FieldValidation.Invalid("Enter a title.")
    val cleanDate = date.trim().ifBlank { null }
    val cleanTime = time.trim().ifBlank { null }
    if (cleanDate != null) {
        if (!Regex("\\d{4}-\\d{2}-\\d{2}").matches(cleanDate) ||
            runCatching { LocalDate.parse(cleanDate) }.isFailure
        ) {
            return FieldValidation.Invalid("Use a real date in YYYY-MM-DD format.")
        }
    }
    if (cleanTime != null) {
        if (cleanDate == null) return FieldValidation.Invalid("Add a date before setting a time.")
        if (!Regex("(?:[01]\\d|2[0-3]):[0-5]\\d").matches(cleanTime) ||
            runCatching { LocalTime.parse(cleanTime) }.isFailure
        ) {
            return FieldValidation.Invalid("Use a time in 24-hour HH:mm format.")
        }
    }
    return FieldValidation.Valid(
        ItemFields(kind, cleanTitle, details, cleanDate, cleanTime),
    )
}

private fun List<WorkspaceItem>.replaceItem(updated: WorkspaceItem) = map { if (it.id == updated.id) updated else it }

private val ItemKind.displayName: String
    get() = if (this == ItemKind.Task) "Task" else "Event"

private val ItemFilter.label: String
    get() = when (this) {
        ItemFilter.All -> "All"
        ItemFilter.Tasks -> "Tasks"
        ItemFilter.Events -> "Events"
    }

private fun readableError(failure: Exception): String = when (failure) {
    is ApiException -> failure.message
    else -> failure.message?.takeIf(String::isNotBlank) ?: "Something went wrong. Please try again."
}

private fun formatDateHeading(value: String): String = runCatching {
    LocalDate.parse(value).format(DateTimeFormatter.ofPattern("EEEE, d MMMM yyyy", Locale.getDefault()))
}.getOrElse { value }
