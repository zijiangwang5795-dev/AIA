package com.aia.assistant

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.aia.assistant.bridge.AndroidBridge
import com.aia.assistant.databinding.ActivityMainBinding
import com.aia.assistant.notification.NotificationHelper
import com.aia.assistant.service.AIAssistantService
import com.aia.assistant.util.PrefHelper

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var bridge: AndroidBridge

    companion object {
        private const val REQ_AUDIO      = 101
        private const val REQ_NOTIFY     = 102
        const val EXTRA_NAV_TARGET       = "nav_target"  // "voice" | "tasks" | "home"
    }

    // ── 生命周期 ───────────────────────────────────────
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setupWebView()
        requestPermissionsIfNeeded()
        startPersistentService()
        handleNavIntent(intent)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        intent?.let { handleNavIntent(it) }
    }

    override fun onResume() {
        super.onResume()
        binding.webView.onResume()
    }

    override fun onPause() {
        super.onPause()
        binding.webView.onPause()
    }

    override fun onDestroy() {
        bridge.destroy()
        binding.webView.destroy()
        super.onDestroy()
    }

    override fun onBackPressed() {
        // WebView 内导航优先，否则回退到桌面（保持服务运行）
        if (binding.webView.canGoBack()) {
            binding.webView.goBack()
        } else {
            moveTaskToBack(true)
        }
    }

    // ── WebView 初始化 ────────────────────────────────
    private fun setupWebView() {
        val wv = binding.webView
        val settings: WebSettings = wv.settings

        // 基础配置
        settings.javaScriptEnabled    = true
        settings.domStorageEnabled    = true
        settings.allowFileAccess      = true
        settings.mediaPlaybackRequiresUserGesture = false

        // 允许后端 http 访问（开发期）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.safeBrowsingEnabled = false
        }

        // 混合内容（http API + https 资产）
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW

        // UA 标识
        settings.userAgentString = "${settings.userAgentString} AIAssistant/1.0 Android"

        // JavaScript 接口
        bridge = AndroidBridge(this, wv)
        wv.addJavascriptInterface(bridge, "AndroidBridge")

        // 允许调试（Debug 模式）
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        // Chrome DevTools 支持（进度条等）
        wv.webChromeClient = WebChromeClient()

        // 加载前端页面
        val apiBase = PrefHelper.getApiBase(this)
        val frontendUrl = PrefHelper.getFrontendUrl(this)

        // 注入 API_BASE，再加载 HTML
        wv.webViewClient = AIAWebViewClient(apiBase)
        wv.loadUrl(frontendUrl)
    }

    // ── 权限请求 ──────────────────────────────────────
    private fun requestPermissionsIfNeeded() {
        val needed = mutableListOf<String>()

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            needed.add(Manifest.permission.RECORD_AUDIO)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        if (needed.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), REQ_AUDIO)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_AUDIO) {
            val audioGranted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
            // 通知 WebView JS 侧
            if (audioGranted) {
                bridge.notifyPermissionResult(granted = true)
            } else {
                bridge.notifyPermissionResult(granted = false)
            }
        }
    }

    // ── 前台服务（常住通知）──────────────────────────
    private fun startPersistentService() {
        val intent = Intent(this, AIAssistantService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    // ── 通知跳转处理 ──────────────────────────────────
    private fun handleNavIntent(intent: Intent) {
        val target = intent.getStringExtra(EXTRA_NAV_TARGET)
            ?: when (intent.action) {
                "com.aia.assistant.OPEN_VOICE"  -> "voice"
                "com.aia.assistant.OPEN_TASKS"  -> "tasks"
                "com.aia.assistant.OPEN_HOME"   -> "home"
                else -> null
            }

        if (target != null) {
            // 等 WebView 加载完毕后导航
            binding.webView.postDelayed({
                binding.webView.evaluateJavascript("gp('$target')", null)
            }, 600)
        }
    }

    // ── 供 Bridge 调用：更新通知状态 ─────────────────
    fun updateNotificationStatus(taskCount: Int, aiStatus: String) {
        NotificationHelper.updatePersistentNotification(this, taskCount, aiStatus)
    }
}
