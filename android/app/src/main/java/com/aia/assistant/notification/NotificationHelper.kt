package com.aia.assistant.notification

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import androidx.core.app.NotificationCompat
import com.aia.assistant.MainActivity
import com.aia.assistant.R

object NotificationHelper {

    const val CHANNEL_PERSISTENT = "aia_persistent"
    const val CHANNEL_ALERTS     = "aia_alerts"
    const val CHANNEL_WIDGET     = "aia_widget"

    const val NOTIF_ID_PERSISTENT = 1001
    const val NOTIF_ID_ALERT      = 1002

    // ── 构建常住通知 ──────────────────────────────────
    fun buildPersistentNotification(
        context: Context,
        taskCount: Int = 0,
        aiStatus: String = "就绪"
    ): Notification {
        val contentText = when {
            taskCount > 0 -> "待处理任务 $taskCount 项 · $aiStatus"
            else          -> "AI 助手运行中 · $aiStatus"
        }

        // 主界面 PendingIntent
        val mainIntent = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java).apply {
                action = "com.aia.assistant.OPEN_HOME"
                putExtra(MainActivity.EXTRA_NAV_TARGET, "home")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // 「语音录入」快捷操作
        val voiceIntent = PendingIntent.getActivity(
            context, 1,
            Intent(context, MainActivity::class.java).apply {
                action = "com.aia.assistant.OPEN_VOICE"
                putExtra(MainActivity.EXTRA_NAV_TARGET, "voice")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // 「任务清单」快捷操作
        val tasksIntent = PendingIntent.getActivity(
            context, 2,
            Intent(context, MainActivity::class.java).apply {
                action = "com.aia.assistant.OPEN_TASKS"
                putExtra(MainActivity.EXTRA_NAV_TARGET, "tasks")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(context, CHANNEL_PERSISTENT)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("🤖 AI 助手")
            .setContentText(contentText)
            .setContentIntent(mainIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)                      // 不可被用户滑动关闭
            .setShowWhen(false)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            // 快捷操作按钮
            .addAction(
                R.drawable.ic_mic,
                "🎙️ 语音",
                voiceIntent
            )
            .addAction(
                R.drawable.ic_tasks,
                "✅ 任务${if (taskCount > 0) "($taskCount)" else ""}",
                tasksIntent
            )
            // BigText 展开样式
            .setStyle(
                NotificationCompat.BigTextStyle()
                    .bigText(contentText)
                    .setSummaryText("点击打开 AI 助手")
            )
            .build()
    }

    // ── 更新常住通知内容 ──────────────────────────────
    fun updatePersistentNotification(context: Context, taskCount: Int, aiStatus: String) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.notify(NOTIF_ID_PERSISTENT, buildPersistentNotification(context, taskCount, aiStatus))
    }

    // ── 发送提醒通知（任务到期 / 好友消息）────────────
    fun sendAlertNotification(
        context: Context,
        title: String,
        body: String,
        navTarget: String = "home"
    ) {
        val intent = PendingIntent.getActivity(
            context, 10,
            Intent(context, MainActivity::class.java).apply {
                putExtra(MainActivity.EXTRA_NAV_TARGET, navTarget)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(intent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()

        val nm = context.getSystemService(NotificationManager::class.java)
        nm.notify(NOTIF_ID_ALERT, notification)
    }
}
