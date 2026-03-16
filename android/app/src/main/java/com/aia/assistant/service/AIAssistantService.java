package com.aia.assistant.service;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import com.aia.assistant.notification.NotificationHelper;
import com.aia.assistant.util.PrefHelper;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

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
public class AIAssistantService extends Service {

    public static final String ACTION_UPDATE_STATUS = "com.aia.assistant.UPDATE_STATUS";
    public static final String EXTRA_TASK_COUNT = "task_count";
    public static final String EXTRA_AI_STATUS = "ai_status";

    private static final long POLL_INTERVAL_MS = 5 * 60 * 1000L;  // 5 分钟轮询一次

    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
    private ScheduledFuture<?> pollingFuture;

    // ── 服务启动 ──────────────────────────────────────
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_UPDATE_STATUS.equals(intent.getAction())) {
            // JS 通过 AndroidBridge.updateStatus() 触发的更新
            int count = intent.getIntExtra(EXTRA_TASK_COUNT, -1);
            String status = intent.getStringExtra(EXTRA_AI_STATUS);
            if (status == null) status = "";
            if (count >= 0) {
                PrefHelper.saveWidgetData(this, count, status);
                NotificationHelper.updatePersistentNotification(this, count, status);
            }
        } else {
            // 首次启动或系统恢复
            startForegroundWithNotification();
            startPolling();
        }
        // START_STICKY：服务被杀后自动重启
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        if (pollingFuture != null) pollingFuture.cancel(true);
        scheduler.shutdownNow();
        super.onDestroy();
    }

    // ── 前台通知 ──────────────────────────────────────
    private void startForegroundWithNotification() {
        int savedCount = PrefHelper.getWidgetTaskCount(this);
        String savedStatus = PrefHelper.getWidgetStatus(this);
        startForeground(
                NotificationHelper.NOTIF_ID_PERSISTENT,
                NotificationHelper.buildPersistentNotification(this, savedCount, savedStatus)
        );
    }

    // ── 后台轮询（任务数量更新）──────────────────────
    private void startPolling() {
        if (pollingFuture != null) pollingFuture.cancel(true);
        pollingFuture = scheduler.scheduleWithFixedDelay(
                this::fetchAndUpdateTaskCount,
                0,
                POLL_INTERVAL_MS,
                TimeUnit.MILLISECONDS
        );
    }

    private void fetchAndUpdateTaskCount() {
        try {
            String token = PrefHelper.getToken(this);
            String apiBase = PrefHelper.getApiBase(this);
            if (token.isEmpty() || apiBase.isEmpty()) return;

            okhttp3.OkHttpClient client = new okhttp3.OkHttpClient();
            okhttp3.Request request = new okhttp3.Request.Builder()
                    .url(apiBase + "/api/tasks?status=pending&limit=1")
                    .addHeader("Authorization", "Bearer " + token)
                    .build();

            try (okhttp3.Response response = client.newCall(request).execute()) {
                if (!response.isSuccessful()) return;
                String body = response.body() != null ? response.body().string() : null;
                if (body == null) return;

                org.json.JSONObject json = new org.json.JSONObject(body);
                int total = json.optInt("total", 0);

                PrefHelper.saveWidgetData(this, total, "就绪");
                NotificationHelper.updatePersistentNotification(this, total, "就绪");

                // 刷新小组件
                Intent widgetIntent = new Intent("com.aia.assistant.WIDGET_REFRESH");
                widgetIntent.setPackage(getPackageName());
                sendBroadcast(widgetIntent);
            }
        } catch (Exception e) {
            // 网络失败不影响服务运行
        }
    }
}
