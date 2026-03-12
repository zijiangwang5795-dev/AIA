package com.aia.assistant

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity

/**
 * 透明 Activity：桌面快捷方式「语音录入」入口
 * 直接跳转到 MainActivity 并导航到语音页面
 */
class VoiceShortcutActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val intent = Intent(this, MainActivity::class.java).apply {
            action = "com.aia.assistant.OPEN_VOICE"
            putExtra(MainActivity.EXTRA_NAV_TARGET, "voice")
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        startActivity(intent)
        finish()
    }
}
