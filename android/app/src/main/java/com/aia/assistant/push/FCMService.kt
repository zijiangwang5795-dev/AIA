package com.aia.assistant.push

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.aia.assistant.MainActivity
import com.aia.assistant.R
import com.aia.assistant.notification.NotificationHelper
import com.aia.assistant.util.PrefHelper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * Firebase Cloud Messaging 服务
 *
 * 职责：
 * 1. 接收服务端推送的通知消息（任务提醒、好友消息等）
 * 2. Token 刷新时自动上报给后端
 */
class FCMService : FirebaseMessagingService() {

    /**
     * FCM Token 刷新回调
     * - 首次安装或 Token 失效时触发
     * - 将新 Token 注册到后端 /api/push/register
     */
    override fun onNewToken(token: String) {
        super.onNewToken(token)
        PrefHelper.saveFcmToken(this, token)
        registerTokenToBackend(this, token)
    }

    /**
     * 接收推送消息
     * - 数据消息（data payload）：在前台/后台均通过此方法处理
     * - 通知消息（notification payload）：前台时通过此方法，后台时系统自动显示
     */
    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)

        val title = message.notification?.title ?: message.data["title"] ?: "AI 助手"
        val body  = message.notification?.body  ?: message.data["body"]  ?: ""
        val type  = message.data["type"]       ?: "general"  // task_reminder / friend_msg / system
        val navTarget = message.data["nav_target"]            // 点击后跳转的页面

        showPushNotification(title, body, type, navTarget)
    }

    // ── 显示推送通知 ───────────────────────────────────────
    private fun showPushNotification(title: String, body: String, type: String, navTarget: String?) {
        val notifId = System.currentTimeMillis().toInt()

        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(MainActivity.EXTRA_NAV_TARGET, navTarget ?: "home")
        }
        val pi = PendingIntent.getActivity(
            this, notifId, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val icon = when (type) {
            "task_reminder" -> R.drawable.ic_tasks
            else            -> R.drawable.ic_notification
        }

        val builder = NotificationCompat.Builder(this, NotificationHelper.CHANNEL_ALERTS)
            .setSmallIcon(icon)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))

        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(notifId, builder.build())
    }

    companion object {
        private const val TAG = "FCMService"

        /**
         * 上报 FCM Token 到后端（可在用户登录后调用）
         */
        fun registerTokenToBackend(context: Context, fcmToken: String) {
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    val authToken = PrefHelper.getToken(context)
                    if (authToken.isBlank()) return@launch  // 未登录，等登录后再注册

                    val json = JSONObject().apply {
                        put("token", fcmToken)
                        put("platform", "android")
                        put("deviceTag", android.os.Build.MODEL)
                    }
                    val client = OkHttpClient()
                    val request = Request.Builder()
                        .url("${PrefHelper.getApiBase(context)}/api/push/register")
                        .post(json.toString().toRequestBody("application/json".toMediaType()))
                        .addHeader("Authorization", "Bearer $authToken")
                        .build()

                    client.newCall(request).execute().use { resp ->
                        if (!resp.isSuccessful) Log.w(TAG, "Token register failed: ${resp.code}")
                        else Log.d(TAG, "FCM token registered OK")
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Register token error: ${e.message}")
                }
            }
        }

        /**
         * 登录成功后调用——将当前设备 FCM Token 注册到后端
         */
        fun registerAfterLogin(context: Context) {
            com.google.firebase.messaging.FirebaseMessaging.getInstance().token
                .addOnSuccessListener { token ->
                    token?.let { registerTokenToBackend(context, it) }
                }
        }
    }
}
