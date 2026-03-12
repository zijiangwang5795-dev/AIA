package com.aia.assistant.util

import android.content.Context
import android.content.SharedPreferences
import com.aia.assistant.BuildConfig
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * PrefHelper — SharedPreferences 统一管理
 *
 * 跨进程（小组件 AppWidgetProvider、主 Activity、前台服务）共享数据。
 * 使用 MODE_MULTI_PROCESS 确保小组件进程也能读到最新值。
 */
object PrefHelper {

    private const val PREF_NAME = "aia_prefs"
    private const val KEY_TOKEN          = "access_token"
    private const val KEY_API_BASE       = "api_base"
    private const val KEY_FRONTEND_URL   = "frontend_url"
    private const val KEY_WIDGET_TASKS   = "widget_task_count"
    private const val KEY_WIDGET_STATUS  = "widget_status"
    private const val KEY_LAST_SYNC      = "last_sync_time"
    private const val KEY_FCM_TOKEN      = "fcm_token"

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)

    // ── Token ─────────────────────────────────────────
    fun saveToken(context: Context, token: String) {
        prefs(context).edit().putString(KEY_TOKEN, token).apply()
    }

    fun getToken(context: Context): String =
        prefs(context).getString(KEY_TOKEN, "") ?: ""

    // ── API Base ──────────────────────────────────────
    fun getApiBase(context: Context): String =
        prefs(context).getString(KEY_API_BASE, BuildConfig.API_BASE_URL)
            ?: BuildConfig.API_BASE_URL

    fun setApiBase(context: Context, url: String) {
        prefs(context).edit().putString(KEY_API_BASE, url).apply()
    }

    // ── 前端页面 URL ──────────────────────────────────
    fun getFrontendUrl(context: Context): String {
        val saved = prefs(context).getString(KEY_FRONTEND_URL, null)
        if (!saved.isNullOrBlank()) return saved

        // 默认：从 assets 加载 index.html
        return "file:///android_asset/index.html"
    }

    fun setFrontendUrl(context: Context, url: String) {
        prefs(context).edit().putString(KEY_FRONTEND_URL, url).apply()
    }

    // ── 小组件数据 ────────────────────────────────────
    fun saveWidgetData(context: Context, taskCount: Int, status: String) {
        val now = SimpleDateFormat("HH:mm", Locale.CHINA).format(Date())
        prefs(context).edit()
            .putInt(KEY_WIDGET_TASKS, taskCount)
            .putString(KEY_WIDGET_STATUS, status)
            .putString(KEY_LAST_SYNC, now)
            .apply()
    }

    fun getWidgetTaskCount(context: Context): Int =
        prefs(context).getInt(KEY_WIDGET_TASKS, 0)

    fun getWidgetStatus(context: Context): String =
        prefs(context).getString(KEY_WIDGET_STATUS, "就绪") ?: "就绪"

    fun getLastSyncTime(context: Context): String =
        prefs(context).getString(KEY_LAST_SYNC, "--:--") ?: "--:--"

    // ── FCM Token ─────────────────────────────────────
    fun saveFcmToken(context: Context, token: String) {
        prefs(context).edit().putString(KEY_FCM_TOKEN, token).apply()
    }

    fun getFcmToken(context: Context): String =
        prefs(context).getString(KEY_FCM_TOKEN, "") ?: ""
}
