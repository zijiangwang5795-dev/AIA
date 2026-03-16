package com.aia.assistant;

import android.graphics.Bitmap;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * 自定义 WebViewClient：
 * 1. 注入 API_BASE 全局变量，使 HTML 可以通过 window.API_BASE 获取后端地址
 * 2. 拦截加载完成事件，通知 Native 侧
 */
public class AIAWebViewClient extends WebViewClient {

    private final String apiBase;

    public AIAWebViewClient(String apiBase) {
        this.apiBase = apiBase;
    }

    @Override
    public void onPageStarted(WebView view, String url, Bitmap favicon) {
        super.onPageStarted(view, url, favicon);
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);
        // 注入 API_BASE 变量（覆盖 JS 中的默认值）
        String safeBase = apiBase.replace("\"", "\\\"");
        // 1. 注入 API_BASE
        // 2. 通知前端 API_BASE 已就绪，触发 initApp（onAndroidBridgeReady）
        // 3. 如果语音也可用，同时触发语音初始化
        String script =
                "window.API_BASE = \"" + safeBase + "\";\n" +
                "window.onAndroidBridgeReady && window.onAndroidBridgeReady();\n" +
                "if (typeof AndroidBridge !== 'undefined' && AndroidBridge.isSpeechAvailable()) {\n" +
                "    window.onNativeSpeechReady && window.onNativeSpeechReady();\n" +
                "}";
        view.evaluateJavascript(script, null);
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        String url = request.getUrl().toString();
        String host = apiBase.replace("http://", "").replace("https://", "");
        // 内部导航不拦截
        return url.startsWith("http") && !url.contains(host);
    }
}
