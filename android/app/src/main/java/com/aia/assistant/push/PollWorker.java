package com.aia.assistant.push;

import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import com.aia.assistant.MainActivity;
import com.aia.assistant.R;
import com.aia.assistant.notification.NotificationHelper;
import com.aia.assistant.util.PrefHelper;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.TimeUnit;

/**
 * PollWorker — 后台轮询通知（替代 Firebase FCM）
 *
 * 通过 WorkManager 每 15 分钟向后端拉取一次待推送通知：
 *   GET /api/notifications/poll?since=<ms>
 *
 * 前台时由 MainActivity.onResume() 主动触发一次即时轮询。
 */
public class PollWorker extends Worker {

    private static final String TAG = "PollWorker";
    private static final String WORK_NAME = "aia_notification_poll";

    public PollWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        String authToken = PrefHelper.getToken(ctx);
        if (authToken == null || authToken.isEmpty()) return Result.success();

        try {
            long since = PrefHelper.getLastPollTime(ctx);
            String url = PrefHelper.getApiBase(ctx) + "/api/notifications/poll?since=" + since;

            OkHttpClient client = new OkHttpClient.Builder()
                    .connectTimeout(10, TimeUnit.SECONDS)
                    .readTimeout(10, TimeUnit.SECONDS)
                    .build();

            Request request = new Request.Builder()
                    .url(url)
                    .addHeader("Authorization", "Bearer " + authToken)
                    .build();

            try (Response response = client.newCall(request).execute()) {
                if (!response.isSuccessful() || response.body() == null) return Result.success();

                String body = response.body().string();
                JSONObject json = new JSONObject(body);
                JSONArray notifs = json.optJSONArray("notifications");

                if (notifs != null) {
                    for (int i = 0; i < notifs.length(); i++) {
                        JSONObject n = notifs.getJSONObject(i);
                        showNotification(
                                ctx,
                                n.optString("title", "AI 助手"),
                                n.optString("body", ""),
                                n.optString("type", "general"),
                                n.optString("nav_target", "home")
                        );
                    }
                }

                PrefHelper.saveLastPollTime(ctx, System.currentTimeMillis());
            }
        } catch (Exception e) {
            Log.w(TAG, "Poll failed: " + e.getMessage());
            // 静默失败，不影响正常使用，下次再试
        }

        return Result.success();
    }

    private void showNotification(Context ctx, String title, String body, String type, String navTarget) {
        int notifId = (int) System.currentTimeMillis();

        Intent intent = new Intent(ctx, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra(MainActivity.EXTRA_NAV_TARGET, navTarget);

        PendingIntent pi = PendingIntent.getActivity(ctx, notifId, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        int icon = "task_reminder".equals(type) ? R.drawable.ic_tasks : R.drawable.ic_notification;

        NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, NotificationHelper.CHANNEL_ALERTS)
                .setSmallIcon(icon)
                .setContentTitle(title)
                .setContentText(body)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body));

        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(notifId, builder.build());
    }

    /**
     * 注册后台轮询任务（登录后调用）
     * 间隔 15 分钟（WorkManager 强制最小值）
     * KEEP 策略：已存在则不重复注册
     */
    public static void schedule(Context context) {
        PeriodicWorkRequest work = new PeriodicWorkRequest.Builder(
                PollWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(new Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build())
                .build();

        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                work
        );
        Log.d(TAG, "Poll scheduled (15min interval)");
    }

    /**
     * 取消轮询（登出时调用）
     */
    public static void cancel(Context context) {
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME);
        Log.d(TAG, "Poll cancelled");
    }
}
