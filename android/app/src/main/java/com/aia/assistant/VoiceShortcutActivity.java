package com.aia.assistant;

import android.content.Intent;
import android.os.Bundle;
import androidx.appcompat.app.AppCompatActivity;

/**
 * 透明 Activity：桌面快捷方式「语音录入」入口
 * 直接跳转到 MainActivity 并导航到语音页面
 */
public class VoiceShortcutActivity extends AppCompatActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction("com.aia.assistant.OPEN_VOICE");
        intent.putExtra(MainActivity.EXTRA_NAV_TARGET, "voice");
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(intent);
        finish();
    }
}
