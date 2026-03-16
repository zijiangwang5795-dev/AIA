package com.aia.assistant.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import com.aia.assistant.MainActivity;
import com.aia.assistant.R;
import com.aia.assistant.util.PrefHelper;

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
public class AssistantWidget extends AppWidgetProvider {

    public static final String ACTION_REFRESH = "com.aia.assistant.WIDGET_REFRESH";

    /** 强制刷新所有 Widget 实例 */
    public static void forceRefresh(Context context) {
        Intent intent = new Intent(context, AssistantWidget.class);
        intent.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
        int[] ids = AppWidgetManager.getInstance(context)
                .getAppWidgetIds(new ComponentName(context, AssistantWidget.class));
        intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
        context.sendBroadcast(intent);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int id : appWidgetIds) {
            updateWidget(context, appWidgetManager, id);
        }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        String action = intent.getAction();
        if (ACTION_REFRESH.equals(action) ||
                AppWidgetManager.ACTION_APPWIDGET_UPDATE.equals(action)) {
            AppWidgetManager mgr = AppWidgetManager.getInstance(context);
            int[] ids = mgr.getAppWidgetIds(new ComponentName(context, AssistantWidget.class));
            for (int id : ids) {
                updateWidget(context, mgr, id);
            }
        }
    }

    // ── 核心更新逻辑 ──────────────────────────────────
    private void updateWidget(Context context, AppWidgetManager appWidgetManager, int widgetId) {
        int taskCount = PrefHelper.getWidgetTaskCount(context);
        String aiStatus = PrefHelper.getWidgetStatus(context);
        String syncTime = PrefHelper.getLastSyncTime(context);

        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_assistant);

        // ── 文字内容 ──
        views.setTextViewText(
                R.id.widget_task_count,
                taskCount > 0 ? taskCount + " 项" : "全部完成 🎉"
        );
        views.setTextViewText(R.id.widget_status_label, aiStatus);
        views.setTextViewText(R.id.widget_sync_time, "上次同步 " + syncTime);

        // 任务数量颜色（有任务时高亮）
        int countColor = taskCount > 0
                ? context.getColor(R.color.accent_purple)
                : context.getColor(R.color.text_secondary);
        views.setTextColor(R.id.widget_task_count, countColor);

        // ── PendingIntents ──
        views.setOnClickPendingIntent(R.id.widget_root, makePendingIntent(context, "home", 0));
        views.setOnClickPendingIntent(R.id.widget_btn_voice, makePendingIntent(context, "voice", 1));
        views.setOnClickPendingIntent(R.id.widget_btn_tasks, makePendingIntent(context, "tasks", 2));
        views.setOnClickPendingIntent(R.id.widget_btn_refresh, makeRefreshIntent(context));

        appWidgetManager.updateAppWidget(widgetId, views);
    }

    private PendingIntent makePendingIntent(Context context, String target, int reqCode) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.putExtra(MainActivity.EXTRA_NAV_TARGET, target);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(
                context, reqCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private PendingIntent makeRefreshIntent(Context context) {
        Intent intent = new Intent(context, AssistantWidget.class);
        intent.setAction(ACTION_REFRESH);
        return PendingIntent.getBroadcast(
                context, 99, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }
}
