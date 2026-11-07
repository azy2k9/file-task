package com.filetasks.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableStateOf
import com.filetasks.android.ui.FileTasksApp

class MainActivity : ComponentActivity() {
    private val openItemRequest = mutableStateOf<Pair<String, Long>?>(null)
    private val resumeCount = mutableStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setOpenItemRequest(intent)
        setContent {
            FileTasksApp(applicationContext, openItemRequest.value, resumeCount.value)
        }
    }

    override fun onResume() {
        super.onResume()
        resumeCount.value += 1
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        setOpenItemRequest(intent)
    }

    private fun setOpenItemRequest(intent: android.content.Intent) {
        intent.getStringExtra(com.filetasks.android.PushMessagingService.EXTRA_ITEM_ID)?.let { itemId ->
            openItemRequest.value = itemId to System.nanoTime()
        }
    }
}
