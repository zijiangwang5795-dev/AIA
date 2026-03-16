package com.aia.assistant;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.aia.assistant.bridge.AndroidBridge;
import com.aia.assistant.databinding.ActivityMainBinding;
import com.aia.assistant.notification.NotificationHelper;
import com.aia.assistant.service.AIAssistantService;
import com.aia.assistant.util.PrefHelper;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends AppCompatActivity {

    private ActivityMainBinding binding;
    private AndroidBridge bridge;

    private static final int REQ_AUDIO = 101;
    public static final String EXTRA_NAV_TARGET = "nav_target";  // "voice" | "tasks" | "home"

    // ── 生命周期 ───────────────────────────────────────
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        binding = ActivityMainBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());

        setupWebView();
        requestPermissionsIfNeeded();
        startPersistentService();
        handleNavIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent != null) {
            handleNavIntent(intent);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        binding.webView.onResume();
    }

    @Override
    protected void onPause() {
        super.onPause();
        binding.webView.onPause();
    }

    @Override
    protected void onDestroy() {
        bridge.destroy();
        binding.webView.destroy();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        // WebView 内导航优先，否则回退到桌面（保持服务运行）
        if (binding.webView.canGoBack()) {
            binding.webView.goBack();
        } else {
            moveTaskToBack(true);
        }
    }

    // ── WebView 初始化 ────────────────────────────────
    private void setupWebView() {
        WebView wv = binding.webView;
        WebSettings settings = wv.getSettings();

        // 基础配置
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);

        // 允许后端 http 访问（开发期）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(false);
        }

        // 混合内容（http API + https 资产）
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        // UA 标识
        settings.setUserAgentString(settings.getUserAgentString() + " AIAssistant/1.0 Android");

        // JavaScript 接口
        bridge = new AndroidBridge(this, wv);
        wv.addJavascriptInterface(bridge, "AndroidBridge");

        // 允许调试（Debug 模式）
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        // Chrome DevTools 支持（进度条等）
        wv.setWebChromeClient(new WebChromeClient());

        // 加载前端页面
        String apiBase = PrefHelper.getApiBase(this);
        String frontendUrl = PrefHelper.getFrontendUrl(this);

        // 注入 API_BASE，再加载 HTML
        wv.setWebViewClient(new AIAWebViewClient(apiBase));
        wv.loadUrl(frontendUrl);
    }

    // ── 权限请求 ──────────────────────────────────────
    private void requestPermissionsIfNeeded() {
        List<String> needed = new ArrayList<>();

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.RECORD_AUDIO);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS);
        }

        if (!needed.isEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toArray(new String[0]), REQ_AUDIO);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_AUDIO) {
            boolean audioGranted = grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            bridge.notifyPermissionResult(audioGranted);
        }
    }

    // ── 前台服务（常住通知）──────────────────────────
    private void startPersistentService() {
        Intent intent = new Intent(this, AIAssistantService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }
    }

    // ── 通知跳转处理 ──────────────────────────────────
    private void handleNavIntent(Intent intent) {
        String target = intent.getStringExtra(EXTRA_NAV_TARGET);
        if (target == null) {
            String action = intent.getAction();
            if ("com.aia.assistant.OPEN_VOICE".equals(action)) {
                target = "voice";
            } else if ("com.aia.assistant.OPEN_TASKS".equals(action)) {
                target = "tasks";
            } else if ("com.aia.assistant.OPEN_HOME".equals(action)) {
                target = "home";
            }
        }

        if (target != null) {
            final String finalTarget = target;
            // 等 WebView 加载完毕后导航
            binding.webView.postDelayed(
                    () -> binding.webView.evaluateJavascript("gp('" + finalTarget + "')", null),
                    600
            );
        }
    }

    // ── 供 Bridge 调用：更新通知状态 ─────────────────
    public void updateNotificationStatus(int taskCount, String aiStatus) {
        NotificationHelper.updatePersistentNotification(this, taskCount, aiStatus);
    }
}
