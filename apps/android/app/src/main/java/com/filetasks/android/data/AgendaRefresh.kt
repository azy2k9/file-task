package com.filetasks.android.data

import kotlinx.coroutines.CancellationException

internal sealed interface AgendaRefreshResult {
    data class Refreshed(val items: List<WorkspaceItem>) : AgendaRefreshResult
    data class Failed(val cause: Exception) : AgendaRefreshResult
    data object Stale : AgendaRefreshResult
}

/** Fetches the agenda after a committed save without applying results to a replacement session. */
internal suspend fun refreshSavedAgenda(
    isCurrentSession: () -> Boolean,
    fetch: suspend () -> List<WorkspaceItem>,
): AgendaRefreshResult = try {
    val items = fetch()
    if (isCurrentSession()) AgendaRefreshResult.Refreshed(items) else AgendaRefreshResult.Stale
} catch (failure: CancellationException) {
    throw failure
} catch (failure: Exception) {
    if (isCurrentSession()) AgendaRefreshResult.Failed(failure) else AgendaRefreshResult.Stale
}
