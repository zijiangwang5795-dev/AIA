package com.aia.assistant.push;

import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import com.google.firebase.messaging.FirebaseMessaging;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import com.aia.assistant.MainActivity;
import com.aia.assistant.R;
import com.aia.assistant.notification.NotificationHelper;
import com.aia.assistant.util.PrefHelper;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;

/**
 * Firebase Cloud Messaging 服务
 *
 * 职责：
 * 1. 接收服务端推送的通知消息（任务提醒、好友消息等）
 * 2. Token 刷新时自动上报给后端
 */
public class FCMService extends FirebaseMessagingService {

    private static final String TAG = "FCMService";

    /**
     * FCM Token 刷新回调
     * - 首次安装或 Token 失效时触发
     * - 将新 Token 注册到后端 /api/push/register
     */
    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        PrefHelper.saveFcmToken(this, token);
        registerTokenToBackend(this, token);
    }

    /**
     * 接收推送消息
     * - 数据消息（data payload）：在前台/后台均通过此方法处理
     * - 通知消息（notification payload）：前台时通过此方法，后台时系统自动显示
     */
    @Override
    public void onMessageReceived(RemoteMessage message) {
        super.onMessageReceived(message);

        String title = message.getNotification() != null ? message.getNotification().getTitle() : null;
        if (title == null) title = message.getData().get("title");
        if (title == null) title = "AI 助手";

        String body = message.getNotification() != null ? message.getNotification().getBody() : null;
        if (body == null) body = message.getData().get("body");
        if (body == null) body = "";

        String type = message.getData().get("type");
        if (type == null) type = "general";

        String navTarget = message.getData().get("nav_target");

        showPushNotification(title, body, type, navTarget);
    }

    // ── 显示推送通知 ───────────────────────────────────────
    private void showPushNotification(String title, String body, String type, String navTarget) {
        int notifId = (int) System.currentTimeMillis();

        Intent intentData = new Intent(this, MainActivity.class);
        intentData.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intentData.putExtra(MainActivity.EXTRA_NAV_TARGET, navTarget != null ? navTarget : "home");

        PendingIntent pi = PendingIntent.getActivity(
                this, notifId, intentData,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        int icon = "task_reminder".equals(type) ? R.drawable.ic_tasks : R.drawable.ic_notification;

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, NotificationHelper.CHANNEL_ALERTS)
                .setSmallIcon(icon)
                .setContentTitle(title)
                .setContentText(body)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body));

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(notifId, builder.build());
    }

    /**
     * 上报 FCM Token 到后端（可在用户登录后调用）
     */
    public static void registerTokenToBackend(final Context context, final String fcmToken) {
        ExecutorService executor = Executors.newSingleThreadExecutor();
        executor.execute(() -> {
            try {
                String authToken = PrefHelper.getToken(context);
                if (authToken == null || authToken.trim().isEmpty()) return;  // 未登录，等登录后再注册

                JSONObject json = new JSONObject();
                json.put("token", fcmToken);
                json.put("platform", "android");
                json.put("deviceTag", android.os.Build.MODEL);

                OkHttpClient client = new OkHttpClient();
                RequestBody requestBody = RequestBody.create(
                        json.toString(),
                        MediaType.get("application/json")
                );
                Request request = new Request.Builder()
                        .url(PrefHelper.getApiBase(context) + "/api/push/register")
                        .post(requestBody)
                        .addHeader("Authorization", "Bearer " + authToken)
                        .build();

                try (Response response = client.newCall(request).execute()) {
                    if (!response.isSuccessful()) {
                        Log.w(TAG, "Token register failed: " + response.code());
                    } else {
                        Log.d(TAG, "FCM token registered OK");
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "Register token error: " + e.getMessage());
            }
        });
        executor.shutdown();
    }

    /**
     * 登录成功后调用——将当前设备 FCM Token 注册到后端
     */
    public static void registerAfterLogin(final Context context) {
        FirebaseMessaging.getInstance().getToken()
                .addOnSuccessListener(token -> {
                    if (token != null) {
                        registerTokenToBackend(context, token);
                    }
                });
    }
}
