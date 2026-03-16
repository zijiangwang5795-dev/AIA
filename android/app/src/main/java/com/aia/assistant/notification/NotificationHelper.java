package com.aia.assistant.notification;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import androidx.core.app.NotificationCompat;
import com.aia.assistant.MainActivity;
import com.aia.assistant.R;

public class NotificationHelper {

    public static final String CHANNEL_PERSISTENT = "aia_persistent";
    public static final String CHANNEL_ALERTS = "aia_alerts";
    public static final String CHANNEL_WIDGET = "aia_widget";

    public static final int NOTIF_ID_PERSISTENT = 1001;
    public static final int NOTIF_ID_ALERT = 1002;

    // ── 构建常住通知 ──────────────────────────────────
    public static Notification buildPersistentNotification(Context context, int taskCount, String aiStatus) {
        String contentText = taskCount > 0
                ? "待处理任务 " + taskCount + " 项 · " + aiStatus
                : "AI 助手运行中 · " + aiStatus;

        // 主界面 PendingIntent
        Intent mainIntentData = new Intent(context, MainActivity.class);
        mainIntentData.setAction("com.aia.assistant.OPEN_HOME");
        mainIntentData.putExtra(MainActivity.EXTRA_NAV_TARGET, "home");
        mainIntentData.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent mainIntent = PendingIntent.getActivity(
                context, 0, mainIntentData,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        // 「语音录入」快捷操作
        Intent voiceIntentData = new Intent(context, MainActivity.class);
        voiceIntentData.setAction("com.aia.assistant.OPEN_VOICE");
        voiceIntentData.putExtra(MainActivity.EXTRA_NAV_TARGET, "voice");
        voiceIntentData.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent voiceIntent = PendingIntent.getActivity(
                context, 1, voiceIntentData,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        // 「任务清单」快捷操作
        Intent tasksIntentData = new Intent(context, MainActivity.class);
        tasksIntentData.setAction("com.aia.assistant.OPEN_TASKS");
        tasksIntentData.putExtra(MainActivity.EXTRA_NAV_TARGET, "tasks");
        tasksIntentData.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tasksIntent = PendingIntent.getActivity(
                context, 2, tasksIntentData,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        String tasksLabel = "✅ 任务" + (taskCount > 0 ? "(" + taskCount + ")" : "");

        return new NotificationCompat.Builder(context, CHANNEL_PERSISTENT)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("🤖 AI 助手")
                .setContentText(contentText)
                .setContentIntent(mainIntent)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)                      // 不可被用户滑动关闭
                .setShowWhen(false)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                // 快捷操作按钮
                .addAction(R.drawable.ic_mic, "🎙️ 语音", voiceIntent)
                .addAction(R.drawable.ic_tasks, tasksLabel, tasksIntent)
                // BigText 展开样式
                .setStyle(new NotificationCompat.BigTextStyle()
                        .bigText(contentText)
                        .setSummaryText("点击打开 AI 助手"))
                .build();
    }

    public static Notification buildPersistentNotification(Context context) {
        return buildPersistentNotification(context, 0, "就绪");
    }

    // ── 更新常住通知内容 ──────────────────────────────
    public static void updatePersistentNotification(Context context, int taskCount, String aiStatus) {
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        nm.notify(NOTIF_ID_PERSISTENT, buildPersistentNotification(context, taskCount, aiStatus));
    }

    // ── 发送提醒通知（任务到期 / 好友消息）────────────
    public static void sendAlertNotification(Context context, String title, String body, String navTarget) {
        Intent intentData = new Intent(context, MainActivity.class);
        intentData.putExtra(MainActivity.EXTRA_NAV_TARGET, navTarget != null ? navTarget : "home");
        intentData.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent intent = PendingIntent.getActivity(
                context, 10, intentData,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification notification = new NotificationCompat.Builder(context, CHANNEL_ALERTS)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(body)
                .setContentIntent(intent)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .build();

        NotificationManager nm = context.getSystemService(NotificationManager.class);
        nm.notify(NOTIF_ID_ALERT, notification);
    }
}
