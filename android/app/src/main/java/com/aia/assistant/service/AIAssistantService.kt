package com.aia.assistant.service

import android.app.Service
import android.content.Intent
import android.os.IBinder
import com.aia.assistant.notification.NotificationHelper
import com.aia.assistant.util.PrefHelper
import kotlinx.coroutines.*

/**
 * AIAssistantService — 前台服务
 *
 * 职责：
 * 1. 维持常驻通知（Foreground Service，防止系统杀死进程）
 * 2. 定期轮询后端 /api/tasks，更新通知栏任务数量
 * 3. 小组件数据刷新触发
 *
 * 生命周期：
 * - 由 MainActivity 在启动时创建
 * - 随系统启动自动恢复（BootReceiver）
 */
class AIAssistantService : Service() {

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var pollingJob: Job? = null

    companion object {
        const val ACTION_UPDATE_STATUS = "com.aia.assistant.UPDATE_STATUS"
        const val EXTRA_TASK_COUNT     = "task_count"
        const val EXTRA_AI_STATUS      = "ai_status"
        private const val POLL_INTERVAL_MS = 5 * 60 * 1000L   // 5 分钟轮询一次
    }

    // ── 服务启动 ──────────────────────────────────────
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_UPDATE_STATUS -> {
                // JS 通过 AndroidBridge.updateStatus() 触发的更新
                val count  = intent.getIntExtra(EXTRA_TASK_COUNT, -1)
                val status = intent.getStringExtra(EXTRA_AI_STATUS) ?: ""
                if (count >= 0) {
                    PrefHelper.saveWidgetData(this, count, status)
                    NotificationHelper.updatePersistentNotification(this, count, status)
                }
            }
            else -> {
                // 首次启动或系统恢复
                startForegroundWithNotification()
                startPolling()
            }
        }
        // START_STICKY：服务被杀后自动重启
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        serviceScope.cancel()
        super.onDestroy()
    }

    // ── 前台通知 ──────────────────────────────────────
    private fun startForegroundWithNotification() {
        val savedCount  = PrefHelper.getWidgetTaskCount(this)
        val savedStatus = PrefHelper.getWidgetStatus(this)
        val notification = NotificationHelper.buildPersistentNotification(
            this, savedCount, savedStatus
        )
        startForeground(NotificationHelper.NOTIF_ID_PERSISTENT, notification)
    }

    // ── 后台轮询（任务数量更新）──────────────────────
    private fun startPolling() {
        pollingJob?.cancel()
        pollingJob = serviceScope.launch {
            while (isActive) {
                try {
                    fetchAndUpdateTaskCount()
                } catch (e: Exception) {
                    // 网络失败不影响服务运行
                }
                delay(POLL_INTERVAL_MS)
            }
        }
    }

    private suspend fun fetchAndUpdateTaskCount() {
        val token   = PrefHelper.getToken(this)
        val apiBase = PrefHelper.getApiBase(this)
        if (token.isEmpty() || apiBase.isEmpty()) return

        val client = okhttp3.OkHttpClient()
        val request = okhttp3.Request.Builder()
            .url("$apiBase/api/tasks?status=pending&limit=1")
            .addHeader("Authorization", "Bearer $token")
            .build()

        val response = client.newCall(request).execute()
        if (!response.isSuccessful) return

        val body = response.body?.string() ?: return
        val json = org.json.JSONObject(body)
        val total = json.optInt("total", 0)

        PrefHelper.saveWidgetData(this, total, "就绪")
        NotificationHelper.updatePersistentNotification(this, total, "就绪")

        // 刷新小组件
        val widgetIntent = Intent("com.aia.assistant.WIDGET_REFRESH").apply {
            setPackage(packageName)
        }
        sendBroadcast(widgetIntent)
    }
}
