package com.aia.assistant.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import com.aia.assistant.MainActivity
import com.aia.assistant.R
import com.aia.assistant.util.PrefHelper
import java.text.SimpleDateFormat
import java.util.*

/**
 * AssistantWidget — 桌面小组件
 *
 * 尺寸：4×2（约 250dp × 110dp）
 *
 * 展示内容：
 * ┌─────────────────────────────────┐
 * │ 🤖 AI 助手          [状态标签] │
 * │ ───────────────────────────── │
 * │  📋 待处理任务  ●  5 项       │
 * │  🕐 上次同步    14:32         │
 * │ ─────────────────────────── │
 * │  [🎙️ 语音]    [✅ 任务]  [⟳] │
 * └─────────────────────────────────┘
 *
 * 交互：
 * - 点击主区域 → 打开 AI 助手主页
 * - 点击"语音" → 直接跳语音页面
 * - 点击"任务" → 直接跳任务清单
 * - 点击"⟳"   → 立即刷新数据
 */
class AssistantWidget : AppWidgetProvider() {

    companion object {
        const val ACTION_REFRESH = "com.aia.assistant.WIDGET_REFRESH"

        /** 强制刷新所有 Widget 实例 */
        fun forceRefresh(context: Context) {
            val intent = Intent(context, AssistantWidget::class.java).apply {
                action = AppWidgetManager.ACTION_APPWIDGET_UPDATE
                val ids = AppWidgetManager.getInstance(context)
                    .getAppWidgetIds(ComponentName(context, AssistantWidget::class.java))
                putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
            }
            context.sendBroadcast(intent)
        }
    }

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        for (id in appWidgetIds) {
            updateWidget(context, appWidgetManager, id)
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_REFRESH ||
            intent.action == AppWidgetManager.ACTION_APPWIDGET_UPDATE
        ) {
            val mgr = AppWidgetManager.getInstance(context)
            val ids = mgr.getAppWidgetIds(ComponentName(context, AssistantWidget::class.java))
            for (id in ids) {
                updateWidget(context, mgr, id)
            }
        }
    }

    // ── 核心更新逻辑 ──────────────────────────────────
    private fun updateWidget(
        context: Context,
        appWidgetManager: AppWidgetManager,
        widgetId: Int
    ) {
        val taskCount = PrefHelper.getWidgetTaskCount(context)
        val aiStatus  = PrefHelper.getWidgetStatus(context)
        val syncTime  = PrefHelper.getLastSyncTime(context)

        val views = RemoteViews(context.packageName, R.layout.widget_assistant)

        // ── 文字内容 ──
        views.setTextViewText(
            R.id.widget_task_count,
            if (taskCount > 0) "$taskCount 项" else "全部完成 🎉"
        )
        views.setTextViewText(R.id.widget_status_label, aiStatus)
        views.setTextViewText(R.id.widget_sync_time, "上次同步 $syncTime")

        // 任务数量颜色（有任务时高亮）
        val countColor = if (taskCount > 0)
            context.getColor(R.color.accent_purple)
        else
            context.getColor(R.color.text_secondary)
        views.setTextColor(R.id.widget_task_count, countColor)

        // ── PendingIntents ──
        views.setOnClickPendingIntent(R.id.widget_root, makePendingIntent(context, "home", 0))
        views.setOnClickPendingIntent(R.id.widget_btn_voice, makePendingIntent(context, "voice", 1))
        views.setOnClickPendingIntent(R.id.widget_btn_tasks, makePendingIntent(context, "tasks", 2))
        views.setOnClickPendingIntent(R.id.widget_btn_refresh, makeRefreshIntent(context))

        appWidgetManager.updateAppWidget(widgetId, views)
    }

    private fun makePendingIntent(context: Context, target: String, reqCode: Int): PendingIntent =
        PendingIntent.getActivity(
            context, reqCode,
            Intent(context, MainActivity::class.java).apply {
                putExtra(MainActivity.EXTRA_NAV_TARGET, target)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

    private fun makeRefreshIntent(context: Context): PendingIntent =
        PendingIntent.getBroadcast(
            context, 99,
            Intent(context, AssistantWidget::class.java).apply {
                action = ACTION_REFRESH
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
}
