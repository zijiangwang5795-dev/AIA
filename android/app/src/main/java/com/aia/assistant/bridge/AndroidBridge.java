package com.aia.assistant.bridge;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import com.aia.assistant.MainActivity;
import com.aia.assistant.push.FCMService;
import com.aia.assistant.util.PrefHelper;
import java.util.List;

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
public class AndroidBridge {

    private final Context context;
    private final WebView webView;
    private SpeechRecognizer speechRecognizer;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    public AndroidBridge(Context context, WebView webView) {
        this.context = context;
        this.webView = webView;
    }

    // ── 语音识别 ───────────────────────────────────────

    @JavascriptInterface
    public boolean isSpeechAvailable() {
        return SpeechRecognizer.isRecognitionAvailable(context);
    }

    @JavascriptInterface
    public void startSpeech() {
        mainHandler.post(() -> {
            initRecognizer();
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2000L);
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2000L);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            if (speechRecognizer != null) {
                speechRecognizer.startListening(intent);
            }
        });
    }

    @JavascriptInterface
    public void stopSpeech() {
        mainHandler.post(() -> {
            if (speechRecognizer != null) {
                speechRecognizer.stopListening();
            }
        });
    }

    // ── 状态同步（JS → Native）────────────────────────

    /** 更新通知栏状态（任务数量 + AI 状态文字）*/
    @JavascriptInterface
    public void updateStatus(int taskCount, String status) {
        if (context instanceof MainActivity) {
            ((MainActivity) context).updateNotificationStatus(taskCount, status);
        }
        // 同时更新小组件
        PrefHelper.saveWidgetData(context, taskCount, status);
        updateWidget();
    }

    /** 保存 Access Token 到 SharedPreferences（跨进程共享给小组件）
     *  同时触发 FCM Token 注册（首次登录后确保推送令牌已上报）
     */
    @JavascriptInterface
    public void saveToken(String token) {
        PrefHelper.saveToken(context, token);
        // 登录成功后注册推送令牌
        if (token != null && !token.trim().isEmpty()) {
            FCMService.registerAfterLogin(context);
        }
    }

    @JavascriptInterface
    public String getToken() {
        return PrefHelper.getToken(context);
    }

    /** 触发震动反馈 */
    @JavascriptInterface
    public void vibrate() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            VibratorManager vm = context.getSystemService(VibratorManager.class);
            if (vm != null) {
                Vibrator vibrator = vm.getDefaultVibrator();
                vibrator.vibrate(VibrationEffect.createOneShot(30, VibrationEffect.DEFAULT_AMPLITUDE));
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Vibrator vibrator = context.getSystemService(Vibrator.class);
            if (vibrator != null) {
                vibrator.vibrate(VibrationEffect.createOneShot(30, VibrationEffect.DEFAULT_AMPLITUDE));
            }
        } else {
            Vibrator vibrator = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator != null) {
                vibrator.vibrate(30);
            }
        }
    }

    /** 原生导航（用于小组件点击等场景）*/
    @JavascriptInterface
    public void openPage(String page) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.putExtra(MainActivity.EXTRA_NAV_TARGET, page);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        context.startActivity(intent);
    }

    // ── 通知 JS 侧权限结果 ────────────────────────────
    public void notifyPermissionResult(boolean granted) {
        evalJs("window.onPermissionResult && window.onPermissionResult(" + granted + ")");
    }

    // ── 私有方法 ──────────────────────────────────────
    private void initRecognizer() {
        if (speechRecognizer != null) {
            speechRecognizer.destroy();
        }
        speechRecognizer = SpeechRecognizer.createSpeechRecognizer(context);
        speechRecognizer.setRecognitionListener(new RecognitionListener() {
            @Override
            public void onReadyForSpeech(Bundle params) {
                evalJs("window.onSpeechReady && window.onSpeechReady()");
            }

            @Override
            public void onBeginningOfSpeech() {
                evalJs("window.onSpeechStart && window.onSpeechStart()");
            }

            @Override
            public void onRmsChanged(float rmsdB) {
                evalJs("window.onSpeechVolume && window.onSpeechVolume(" + rmsdB + ")");
            }

            @Override
            public void onBufferReceived(byte[] buffer) {}

            @Override
            public void onEndOfSpeech() {
                evalJs("window.onSpeechEnd && window.onSpeechEnd()");
            }

            @Override
            public void onError(int error) {
                String code;
                switch (error) {
                    case SpeechRecognizer.ERROR_AUDIO:                  code = "audio_error"; break;
                    case SpeechRecognizer.ERROR_NETWORK:                code = "network_error"; break;
                    case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:        code = "network_timeout"; break;
                    case SpeechRecognizer.ERROR_NO_MATCH:               code = "no_match"; break;
                    case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: code = "permission_denied"; break;
                    case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:        code = "recognizer_busy"; break;
                    default:                                             code = "unknown_error"; break;
                }
                evalJs("window.onSpeechError && window.onSpeechError('" + code + "')");
            }

            @Override
            public void onResults(Bundle results) {
                List<String> matches = results != null
                        ? results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        : null;
                String text = (matches != null && !matches.isEmpty()) ? matches.get(0) : "";
                String safe = text.replace("'", "\\'").replace("\n", "\\n");
                evalJs("window.onSpeechResult && window.onSpeechResult('" + safe + "')");
            }

            @Override
            public void onPartialResults(Bundle partialResults) {
                List<String> matches = partialResults != null
                        ? partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        : null;
                String text = (matches != null && !matches.isEmpty()) ? matches.get(0) : "";
                String safe = text.replace("'", "\\'").replace("\n", "\\n");
                evalJs("window.onSpeechPartial && window.onSpeechPartial('" + safe + "')");
            }

            @Override
            public void onEvent(int eventType, Bundle params) {}
        });
    }

    private void evalJs(final String script) {
        mainHandler.post(() -> webView.evaluateJavascript(script, null));
    }

    private void updateWidget() {
        Intent intent = new Intent("com.aia.assistant.WIDGET_REFRESH");
        intent.setPackage(context.getPackageName());
        context.sendBroadcast(intent);
    }

    public void destroy() {
        if (speechRecognizer != null) {
            speechRecognizer.destroy();
            speechRecognizer = null;
        }
    }
}
