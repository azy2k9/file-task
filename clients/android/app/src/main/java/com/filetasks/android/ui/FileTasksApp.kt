package com.filetasks.android.ui

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import com.filetasks.android.data.TokenStore
import com.filetasks.android.data.WorkspaceItem
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.Locale

private const val DEFAULT_API_URL = "http://10.0.2.2:3000"
private const val PREFERENCES = "filetasks_private"
private const val API_URL_KEY = "api_url"

private data class EditorTarget(val item: WorkspaceItem?)

private enum class ItemFilter { All, Tasks, Events }

@Composable
fun FileTasksApp(context: Context) {
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
        var initialLoading by remember { mutableStateOf(true) }
        var working by remember { mutableStateOf(false) }
        var recoveryAvailable by remember { mutableStateOf(false) }
        var errorMessage by remember { mutableStateOf<String?>(null) }
        var authError by remember { mutableStateOf<String?>(null) }
        var authMode by rememberSaveable { mutableStateOf("login") }
        var email by rememberSaveable { mutableStateOf("") }
        var password by rememberSaveable { mutableStateOf("") }
        var itemFilter by rememberSaveable { mutableStateOf(ItemFilter.All.name) }
        var showSettings by remember { mutableStateOf(false) }
        var editorTarget by remember { mutableStateOf<EditorTarget?>(null) }
        var confirmDelete by remember { mutableStateOf<WorkspaceItem?>(null) }

        LaunchedEffect(Unit) {
            val savedToken = withContext(Dispatchers.IO) { tokenStore.read() }
            token = savedToken
            if (savedToken != null) {
                try {
                    val api = ApiClient(apiBaseUrl)
                    user = api.session(savedToken)
                    workspaceItems = api.listItems(savedToken)
                } catch (failure: Exception) {
                    if (failure is ApiException && failure.statusCode == 401) {
                        withContext(Dispatchers.IO) { tokenStore.clear() }
                        token = null
                        user = null
                        workspaceItems = emptyList()
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

        fun refreshItems() {
            val currentToken = token ?: return
            runAction {
                workspaceItems = ApiClient(apiBaseUrl).listItems(currentToken)
            }
        }

        fun signOut() {
            val currentToken = token
            runAction {
                if (currentToken != null) {
                    runCatching { ApiClient(apiBaseUrl).logout(currentToken) }
                }
                withContext(Dispatchers.IO) { tokenStore.clear() }
                token = null
                user = null
                workspaceItems = emptyList()
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
                    } catch (failure: Exception) {
                        if (failure is ApiException && failure.statusCode == 401) {
                            withContext(Dispatchers.IO) { tokenStore.clear() }
                            token = null
                            user = null
                            workspaceItems = emptyList()
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
                    recoveryAvailable = false
                } catch (failure: ApiException) {
                    if (failure.statusCode == 401) {
                        withContext(Dispatchers.IO) { tokenStore.clear() }
                        token = null
                        user = null
                        workspaceItems = emptyList()
                        recoveryAvailable = false
                    }
                    throw failure
                }
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
                filter = itemFilter,
                isBusy = working,
                error = errorMessage,
                onFilterChange = { itemFilter = it.name },
                onRefresh = ::refreshItems,
                onSignOut = ::signOut,
                onSettings = { showSettings = true },
                onCreate = { editorTarget = EditorTarget(null) },
                onEdit = { editorTarget = EditorTarget(it) },
                onDelete = { confirmDelete = it },
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
                text = { Text("“${item.title}” will be removed from your workspace.") },
                confirmButton = {
                    Button(
                        enabled = !working,
                        onClick = {
                            val currentToken = token
                            if (currentToken != null) {
                                runAction {
                                    ApiClient(apiBaseUrl).deleteItem(currentToken, item)
                                    workspaceItems = workspaceItems.filterNot { it.id == item.id }
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
    filter: String,
    isBusy: Boolean,
    error: String?,
    onFilterChange: (ItemFilter) -> Unit,
    onRefresh: () -> Unit,
    onSignOut: () -> Unit,
    onSettings: () -> Unit,
    onCreate: () -> Unit,
    onEdit: (WorkspaceItem) -> Unit,
    onDelete: (WorkspaceItem) -> Unit,
    onToggleTask: (WorkspaceItem) -> Unit,
) {
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
            ExtendedFloatingActionButton(
                text = { Text("Add item") },
                icon = { Text("+", style = MaterialTheme.typography.titleLarge) },
                onClick = { if (!isBusy) onCreate() },
                containerColor = if (isBusy) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.primary,
                contentColor = if (isBusy) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onPrimary,
            )
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
                    TextButton(onClick = onSignOut, enabled = !isBusy) { Text("Sign out") }
                }
                Spacer(Modifier.height(12.dp))
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
                if (isBusy) {
                    Spacer(Modifier.height(8.dp))
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                }
                error?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            }

            if (visibleItems.isEmpty()) {
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
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.align(Alignment.End)) {
                    TextButton(onClick = onEdit, enabled = enabled) { Text("Edit") }
                    TextButton(onClick = onDelete, enabled = enabled) { Text("Delete", color = MaterialTheme.colorScheme.error) }
                }
            }
        }
    }
}

@Composable
private fun ItemEditorDialog(
    item: WorkspaceItem?,
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
                        onClick = { kindValue = ItemKind.Task.wireValue },
                        enabled = item == null && !saving && !isBusy,
                        label = { Text("Task") },
                    )
                    FilterChip(
                        selected = kind == ItemKind.Event,
                        onClick = { kindValue = ItemKind.Event.wireValue },
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
                        val validFields = (fields as FieldValidation.Valid).fields
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
