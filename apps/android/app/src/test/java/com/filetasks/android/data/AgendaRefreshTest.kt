package com.filetasks.android.data

import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class AgendaRefreshTest {
    @Test fun failedRefreshKeepsTheCommittedSaveRecoverable() = runBlocking {
        val failure = IOException("network unavailable")
        val result = refreshSavedAgenda(isCurrentSession = { true }, fetch = { throw failure })
        assertTrue(result is AgendaRefreshResult.Failed)
        assertSame(failure, (result as AgendaRefreshResult.Failed).cause)
    }

    @Test fun responseFromOldSessionCannotReplaceCurrentAgenda() = runBlocking {
        var current = true
        val pending = CompletableDeferred<List<WorkspaceItem>>()
        val started = CompletableDeferred<Unit>()
        val result = async { refreshSavedAgenda(isCurrentSession = { current }, fetch = { started.complete(Unit); pending.await() }) }
        started.await()
        current = false
        pending.complete(emptyList())
        assertSame(AgendaRefreshResult.Stale, result.await())
    }

    @Test fun failedRequestFromOldSessionDoesNotReportAnErrorInNewSession() = runBlocking {
        val result = refreshSavedAgenda(isCurrentSession = { false }, fetch = { throw IOException("old session") })
        assertSame(AgendaRefreshResult.Stale, result)
    }

    @Test fun cancellationIsNotReportedAsARefreshFailure() = runBlocking {
        val cancellation = CancellationException("cancelled")
        try {
            refreshSavedAgenda(isCurrentSession = { true }, fetch = { throw cancellation })
            throw AssertionError("Expected cancellation")
        } catch (actual: CancellationException) {
            assertSame(cancellation, actual)
        }
    }
}
