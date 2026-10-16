package com.filetasks.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.filetasks.android.data.ApiClient
import com.filetasks.android.data.PushDevice
import com.filetasks.android.data.TokenStore
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class PushMessagingService : FirebaseMessagingService() {
    override fun onRegistered(installationId: String) {
        val preferences = getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        if (!preferences.getBoolean(PUSH_ENABLED_KEY, false) || preferences.getBoolean(PUSH_REVOKED_KEY, false)) return
        val token = TokenStore(this).read() ?: return
        val baseUrl = preferences.getString(API_URL_KEY, DEFAULT_API_URL) ?: DEFAULT_API_URL
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            runCatching {
                val api = ApiClient(baseUrl)
                val user = api.session(token)
                val key = pushDeviceKey(user.id)
                val fidKey = pushFidKey(user.id)
                val previousId = preferences.getString(key, null)
                if (preferences.getString(fidKey, null) == installationId && previousId != null) return@runCatching
                previousId?.let { api.revokePushDevice(token, PushDevice(it, "android", "")) }
                val device = api.registerPushDevice(token, "android", installationId)
                preferences.edit().putString(key, device.id).putString(fidKey, installationId).apply()
            }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val title = message.data["title"] ?: message.notification?.title ?: "FileTasks reminder"
        val scheduledAt = message.data["scheduledAt"]
        val body = message.data["body"] ?: message.notification?.body ?: scheduledAt ?: "A reminder is due."
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Reminders", NotificationManager.IMPORTANCE_DEFAULT))
        }
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            message.data["itemId"]?.let { putExtra(EXTRA_ITEM_ID, it) }
        }
        val pendingIntent = PendingIntent.getActivity(this, message.messageId?.hashCode() ?: 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()
        manager.notify(message.messageId?.hashCode() ?: System.currentTimeMillis().toInt(), notification)
    }

    companion object {
        const val EXTRA_ITEM_ID = "filetasks_item_id"
        private const val PREFERENCES = "filetasks_private"
        private const val API_URL_KEY = "api_url"
        private const val DEFAULT_API_URL = "http://10.0.2.2:3000"
        private const val PUSH_ENABLED_KEY = "push_enabled"
        const val PUSH_REVOKED_KEY = "push_device_revoked"
        private const val CHANNEL_ID = "filetasks-reminders"
        fun pushDeviceKey(userId: String) = "push_device_id:$userId"
        fun pushFidKey(userId: String) = "push_fid:$userId"
    }
}
