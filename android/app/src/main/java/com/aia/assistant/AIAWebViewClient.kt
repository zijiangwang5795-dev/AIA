package com.aia.assistant

import android.graphics.Bitmap
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * 自定义 WebViewClient：
 * 1. 注入 API_BASE 全局变量，使 HTML 可以通过 window.API_BASE 获取后端地址
 * 2. 拦截加载完成事件，通知 Native 侧
 */
class AIAWebViewClient(private val apiBase: String) : WebViewClient() {

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        super.onPageStarted(view, url, favicon)
    }

    override fun onPageFinished(view: WebView, url: String) {
        super.onPageFinished(view, url)
        // 注入 API_BASE 变量（覆盖 JS 中的默认值）
        val safeBase = apiBase.replace("\"", "\\\"")
        view.evaluateJavascript(
            """
            window.API_BASE = "$safeBase";
            if (typeof AndroidBridge !== 'undefined' && AndroidBridge.isSpeechAvailable()) {
                window.onNativeSpeechReady && window.onNativeSpeechReady();
            }
            """.trimIndent(), null
        )
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url.toString()
        // 内部导航不拦截
        return url.startsWith("http") && !url.contains(apiBase.removePrefix("http://").removePrefix("https://"))
    }
}
