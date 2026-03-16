package com.aia.assistant.util;

import android.content.Context;
import android.content.SharedPreferences;
import com.aia.assistant.BuildConfig;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * PrefHelper — SharedPreferences 统一管理
 *
 * 跨进程（小组件 AppWidgetProvider、主 Activity、前台服务）共享数据。
 */
public class PrefHelper {

    private static final String PREF_NAME = "aia_prefs";
    private static final String KEY_TOKEN = "access_token";
    private static final String KEY_API_BASE = "api_base";
    private static final String KEY_FRONTEND_URL = "frontend_url";
    private static final String KEY_WIDGET_TASKS = "widget_task_count";
    private static final String KEY_WIDGET_STATUS = "widget_status";
    private static final String KEY_LAST_SYNC = "last_sync_time";
    private static final String KEY_FCM_TOKEN = "fcm_token";

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
    }

    // ── Token ─────────────────────────────────────────
    public static void saveToken(Context context, String token) {
        prefs(context).edit().putString(KEY_TOKEN, token).apply();
    }

    public static String getToken(Context context) {
        String token = prefs(context).getString(KEY_TOKEN, "");
        return token != null ? token : "";
    }

    // ── API Base ──────────────────────────────────────
    public static String getApiBase(Context context) {
        String base = prefs(context).getString(KEY_API_BASE, BuildConfig.API_BASE_URL);
        return base != null ? base : BuildConfig.API_BASE_URL;
    }

    public static void setApiBase(Context context, String url) {
        prefs(context).edit().putString(KEY_API_BASE, url).apply();
    }

    // ── 前端页面 URL ──────────────────────────────────
    public static String getFrontendUrl(Context context) {
        String saved = prefs(context).getString(KEY_FRONTEND_URL, null);
        if (saved != null && !saved.trim().isEmpty()) return saved;
        // 默认：从 assets 加载 index.html
        return "file:///android_asset/index.html";
    }

    public static void setFrontendUrl(Context context, String url) {
        prefs(context).edit().putString(KEY_FRONTEND_URL, url).apply();
    }

    // ── 小组件数据 ────────────────────────────────────
    public static void saveWidgetData(Context context, int taskCount, String status) {
        String now = new SimpleDateFormat("HH:mm", Locale.CHINA).format(new Date());
        prefs(context).edit()
                .putInt(KEY_WIDGET_TASKS, taskCount)
                .putString(KEY_WIDGET_STATUS, status)
                .putString(KEY_LAST_SYNC, now)
                .apply();
    }

    public static int getWidgetTaskCount(Context context) {
        return prefs(context).getInt(KEY_WIDGET_TASKS, 0);
    }

    public static String getWidgetStatus(Context context) {
        String status = prefs(context).getString(KEY_WIDGET_STATUS, "就绪");
        return status != null ? status : "就绪";
    }

    public static String getLastSyncTime(Context context) {
        String time = prefs(context).getString(KEY_LAST_SYNC, "--:--");
        return time != null ? time : "--:--";
    }

    // ── FCM Token ─────────────────────────────────────
    public static void saveFcmToken(Context context, String token) {
        prefs(context).edit().putString(KEY_FCM_TOKEN, token).apply();
    }

    public static String getFcmToken(Context context) {
        String token = prefs(context).getString(KEY_FCM_TOKEN, "");
        return token != null ? token : "";
    }
}
