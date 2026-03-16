package com.aia.assistant;

import android.app.Application;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import com.aia.assistant.notification.NotificationHelper;

public class AIAApplication extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannels();
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);

        // 常住通知渠道（前台服务）
        NotificationChannel persistent = new NotificationChannel(
                NotificationHelper.CHANNEL_PERSISTENT,
                "AI 助手常驻",
                NotificationManager.IMPORTANCE_LOW
        );
        persistent.setDescription("AI 助手运行状态与快捷操作");
        persistent.setShowBadge(false);
        persistent.enableLights(false);
        persistent.enableVibration(false);
        nm.createNotificationChannel(persistent);

        // 提醒通知渠道（任务到期、好友消息等）
        NotificationChannel alerts = new NotificationChannel(
                NotificationHelper.CHANNEL_ALERTS,
                "助手提醒",
                NotificationManager.IMPORTANCE_DEFAULT
        );
        alerts.setDescription("任务到期提醒与好友消息通知");
        alerts.enableVibration(true);
        nm.createNotificationChannel(alerts);

        // 静默更新渠道（小组件数据刷新，用户不感知）
        NotificationChannel widget = new NotificationChannel(
                NotificationHelper.CHANNEL_WIDGET,
                "数据同步",
                NotificationManager.IMPORTANCE_NONE
        );
        widget.setDescription("小组件数据后台同步");
        widget.setShowBadge(false);
        nm.createNotificationChannel(widget);
    }
}
