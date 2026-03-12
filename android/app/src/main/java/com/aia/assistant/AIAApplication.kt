package com.aia.assistant

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import com.aia.assistant.notification.NotificationHelper

class AIAApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java)

        // 常住通知渠道（前台服务）
        nm.createNotificationChannel(
            NotificationChannel(
                NotificationHelper.CHANNEL_PERSISTENT,
                "AI 助手常驻",
                NotificationManager.IMPORTANCE_LOW      // LOW：不发出声音，但常驻
            ).apply {
                description = "AI 助手运行状态与快捷操作"
                setShowBadge(false)
                enableLights(false)
                enableVibration(false)
            }
        )

        // 提醒通知渠道（任务到期、好友消息等）
        nm.createNotificationChannel(
            NotificationChannel(
                NotificationHelper.CHANNEL_ALERTS,
                "助手提醒",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "任务到期提醒与好友消息通知"
                enableVibration(true)
            }
        )

        // 静默更新渠道（小组件数据刷新，用户不感知）
        nm.createNotificationChannel(
            NotificationChannel(
                NotificationHelper.CHANNEL_WIDGET,
                "数据同步",
                NotificationManager.IMPORTANCE_NONE
            ).apply {
                description = "小组件数据后台同步"
                setShowBadge(false)
            }
        )
    }
}
