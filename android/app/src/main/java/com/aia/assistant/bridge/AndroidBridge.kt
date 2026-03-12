package com.aia.assistant.bridge

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.aia.assistant.MainActivity
import com.aia.assistant.util.PrefHelper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * AndroidBridge — JavaScript ↔ Native 双向通信桥
 *
 * JS 侧调用：
 *   AndroidBridge.startSpeech()
 *   AndroidBridge.stopSpeech()
 *   AndroidBridge.isSpeechAvailable()
 *   AndroidBridge.updateStatus(taskCount, status)
 *   AndroidBridge.saveToken(token)
 *   AndroidBridge.getToken()
 *   AndroidBridge.vibrate()
 *   AndroidBridge.openPage(page)
 *
 * Native 侧回调 JS：
 *   window.onNativeSpeechReady()
 *   window.onSpeechReady()
 *   window.onSpeechStart()
 *   window.onSpeechPartial(text)
 *   window.onSpeechResult(text)
 *   window.onSpeechEnd()
 *   window.onSpeechVolume(rms)
 *   window.onSpeechError(code)
 *   window.onPermissionResult(granted)
 */
class AndroidBridge(
    private val context: Context,
    private val webView: WebView
) {
    private var speechRecognizer: SpeechRecognizer? = null
    private val mainScope = CoroutineScope(Dispatchers.Main)
    private val ioScope   = CoroutineScope(Dispatchers.IO)

    // ── 语音识别 ───────────────────────────────────────

    @JavascriptInterface
    fun isSpeechAvailable(): Boolean =
        SpeechRecognizer.isRecognitionAvailable(context)

    @JavascriptInterface
    fun startSpeech() {
        mainScope.launch {
            initRecognizer()
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2000L)
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2000L)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            }
            speechRecognizer?.startListening(intent)
        }
    }

    @JavascriptInterface
    fun stopSpeech() {
        mainScope.launch {
            speechRecognizer?.stopListening()
        }
    }

    // ── 状态同步（JS → Native）────────────────────────

    /** 更新通知栏状态（任务数量 + AI 状态文字）*/
    @JavascriptInterface
    fun updateStatus(taskCount: Int, status: String) {
        (context as? MainActivity)?.updateNotificationStatus(taskCount, status)
        // 同时更新小组件
        PrefHelper.saveWidgetData(context, taskCount, status)
        updateWidget()
    }

    /** 保存 Access Token 到 SharedPreferences（跨进程共享给小组件）*/
    @JavascriptInterface
    fun saveToken(token: String) {
        PrefHelper.saveToken(context, token)
    }

    @JavascriptInterface
    fun getToken(): String = PrefHelper.getToken(context)

    /** 触发震动反馈 */
    @JavascriptInterface
    fun vibrate() {
        val vibrator = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
            val vm = context.getSystemService(android.os.VibratorManager::class.java)
            vm?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(android.os.Vibrator::class.java)
        }
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            vibrator?.vibrate(android.os.VibrationEffect.createOneShot(30, android.os.VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
            @Suppress("DEPRECATION")
            vibrator?.vibrate(30)
        }
    }

    /** 原生导航（用于小组件点击等场景）*/
    @JavascriptInterface
    fun openPage(page: String) {
        val intent = Intent(context, MainActivity::class.java).apply {
            putExtra(MainActivity.EXTRA_NAV_TARGET, page)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        context.startActivity(intent)
    }

    // ── 通知 JS 侧权限结果 ────────────────────────────
    fun notifyPermissionResult(granted: Boolean) {
        evalJs("window.onPermissionResult && window.onPermissionResult($granted)")
    }

    // ── 私有方法 ──────────────────────────────────────
    private fun initRecognizer() {
        speechRecognizer?.destroy()
        speechRecognizer = SpeechRecognizer.createSpeechRecognizer(context).apply {
            setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {
                    evalJs("window.onSpeechReady && window.onSpeechReady()")
                }
                override fun onBeginningOfSpeech() {
                    evalJs("window.onSpeechStart && window.onSpeechStart()")
                }
                override fun onRmsChanged(rmsdB: Float) {
                    evalJs("window.onSpeechVolume && window.onSpeechVolume(${rmsdB})")
                }
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() {
                    evalJs("window.onSpeechEnd && window.onSpeechEnd()")
                }
                override fun onError(error: Int) {
                    val code = when (error) {
                        SpeechRecognizer.ERROR_AUDIO              -> "audio_error"
                        SpeechRecognizer.ERROR_NETWORK            -> "network_error"
                        SpeechRecognizer.ERROR_NETWORK_TIMEOUT    -> "network_timeout"
                        SpeechRecognizer.ERROR_NO_MATCH           -> "no_match"
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "permission_denied"
                        SpeechRecognizer.ERROR_RECOGNIZER_BUSY    -> "recognizer_busy"
                        else -> "unknown_error"
                    }
                    evalJs("window.onSpeechError && window.onSpeechError('$code')")
                }
                override fun onResults(results: Bundle?) {
                    val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    val text = matches?.firstOrNull() ?: ""
                    val safe = text.replace("'", "\\'").replace("\n", "\\n")
                    evalJs("window.onSpeechResult && window.onSpeechResult('$safe')")
                }
                override fun onPartialResults(partialResults: Bundle?) {
                    val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    val text = matches?.firstOrNull() ?: ""
                    val safe = text.replace("'", "\\'").replace("\n", "\\n")
                    evalJs("window.onSpeechPartial && window.onSpeechPartial('$safe')")
                }
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
        }
    }

    private fun evalJs(script: String) {
        mainScope.launch {
            webView.evaluateJavascript(script, null)
        }
    }

    private fun updateWidget() {
        val intent = Intent("com.aia.assistant.WIDGET_REFRESH").apply {
            setPackage(context.packageName)
        }
        context.sendBroadcast(intent)
    }

    fun destroy() {
        speechRecognizer?.destroy()
        speechRecognizer = null
    }
}
