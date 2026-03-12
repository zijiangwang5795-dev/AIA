# AI 助手 Android 版设计文档

> 版本：1.0 · 平台：Android 8.0+（minSdk 26）· 架构：WebView + Native Bridge

---

## 目录

1. [项目概述](#1-项目概述)
2. [架构设计](#2-架构设计)
3. [常驻通知设计](#3-常驻通知设计)
4. [桌面小组件设计](#4-桌面小组件设计)
5. [语音交互设计](#5-语音交互设计)
6. [JS ↔ Native 通信桥](#6-js--native-通信桥)
7. [数据流与状态管理](#7-数据流与状态管理)
8. [安全设计](#8-安全设计)
9. [目录结构](#9-目录结构)
10. [构建与部署](#10-构建与部署)

---

## 1 项目概述

### 目标

将 AI 助手 H5 前端包装为原生 Android 应用，在不重写业务逻辑的前提下：

- 提供**常驻通知**，让用户随时唤醒语音或查看任务
- 提供**桌面小组件**，在主屏幕实时展示助手状态
- 接入**原生语音识别**，绕过浏览器权限限制，获得更流畅的识别体验
- 支持**开机自启**，确保服务始终在后台就绪

### 关键决策

| 决策点 | 选择 | 原因 |
|--------|------|------|
| UI 层 | WebView（H5 复用） | 业务逻辑/UI 已在前端实现，无需重复开发 |
| 语音识别 | Android SpeechRecognizer | 系统级别，无需申请额外 API，支持中文 zh-CN |
| 后台保活 | Foreground Service | Android 8+ 后台限制要求前台服务；START_STICKY 保证重启 |
| 数据共享 | SharedPreferences | Widget/Service/Activity 三方跨进程读写；轻量可靠 |
| 网络请求 | OkHttp 4 | 在 Service 中异步轮询，Kotlin 协程调度 |

---

## 2 架构设计

### 整体架构图

```
┌─────────────────────────────────────────────────────┐
│                    Android 应用层                     │
│                                                     │
│  ┌──────────────┐   Intent    ┌──────────────────┐  │
│  │ MainActivity │◄───────────►│ AIAssistantService│  │
│  │  (WebView)   │             │  (前台服务/保活)   │  │
│  └──────┬───────┘             └────────┬─────────┘  │
│         │ @JavascriptInterface          │ OkHttp     │
│  ┌──────▼───────┐    SharedPrefs  ┌────▼──────────┐ │
│  │ AndroidBridge│◄───────────────►│   PrefHelper   │ │
│  │  (JS桥接层)  │                 └────┬──────────┘ │
│  └──────────────┘                      │ broadcast  │
│                               ┌────────▼──────────┐ │
│                               │  AssistantWidget   │ │
│                               │  (桌面小组件)      │ │
│                               └───────────────────┘ │
└─────────────────────────────────────────────────────┘
         │ HTTP/HTTPS
┌────────▼────────────┐
│   后端 API Server    │
│  (Node.js/Fastify)  │
└─────────────────────┘
```

### 组件职责

| 组件 | 类型 | 职责 |
|------|------|------|
| `MainActivity` | Activity | 宿主 WebView；处理权限；接收 Intent 导航 |
| `AIAWebViewClient` | WebViewClient | 注入 `window.API_BASE`；触发 `onNativeSpeechReady` |
| `AndroidBridge` | @JavascriptInterface | H5 调用原生能力的统一入口 |
| `AIAssistantService` | Foreground Service | 保活；轮询任务数；更新通知和小组件 |
| `AssistantWidget` | AppWidgetProvider | 渲染桌面小组件；响应刷新广播 |
| `BootReceiver` | BroadcastReceiver | 开机/更新后重启服务 |
| `VoiceShortcutActivity` | Activity (transparent) | 通知语音按钮 → 透明中转 → 开启语音 |
| `NotificationHelper` | 工具类 | 构建/更新通知 |
| `PrefHelper` | 工具类 | SharedPreferences 统一封装 |

---

## 3 常驻通知设计

### 视觉设计

```
┌─────────────────────────────────────────────────────┐
│  🤖  AI 助手                              [展开 ▼]  │
│      准备就绪 · 3 项待处理任务                        │
│  ─────────────────────────────────────────────────  │
│  [🎙️ 语音]                          [✅ 任务]        │
└─────────────────────────────────────────────────────┘
```

### 技术实现

**通知渠道**

| 渠道 ID | 重要性 | 声音 | 震动 | 用途 |
|---------|--------|------|------|------|
| `aia_persistent` | LOW | ✗ | ✗ | 常驻通知（不打扰用户） |
| `aia_alerts` | DEFAULT | ✓ | ✓ | 任务到期提醒 |
| `aia_widget` | NONE | ✗ | ✗ | 小组件静默同步 |

**关键属性**

```kotlin
NotificationCompat.Builder(ctx, CHANNEL_PERSISTENT)
    .setSmallIcon(R.drawable.ic_notification)   // 单色机器人图标
    .setPriority(NotificationCompat.PRIORITY_LOW)
    .setOngoing(true)                           // 用户无法手动滑掉
    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
    .setStyle(BigTextStyle())                   // 展开后显示更多状态
    .addAction(R.drawable.ic_mic, "🎙️ 语音", voicePendingIntent)
    .addAction(R.drawable.ic_tasks, "✅ 任务", tasksPendingIntent)
```

**Intent 路由**

- 通知主体点击 → `MainActivity` with `EXTRA_NAV_TARGET = "home"`
- 语音按钮 → `VoiceShortcutActivity`（透明）→ JS 调用 `startVoice()`
- 任务按钮 → `MainActivity` with `EXTRA_NAV_TARGET = "tasks"`

### 服务生命周期

```
开机 / 应用安装
      │
      ▼ BootReceiver.onReceive()
AIAssistantService.startForeground()
      │
      ▼ 每 5 分钟轮询
GET /api/tasks?status=pending
      │
      ├── 更新通知文字（任务数）
      └── 广播 WIDGET_REFRESH → AssistantWidget.onReceive()
```

若系统因内存不足杀死服务，`START_STICKY` 确保系统在条件允许时重启服务。

---

## 4 桌面小组件设计

### 视觉设计（4×2 格）

```
┌─────────────────────────────────────────┐
│  🤖 AI 助手           ● 就绪            │
│ ─────────────────────────────────────── │
│  📋 3 项待处理任务        14:32 同步     │
│ ─────────────────────────────────────── │
│  [🎙️ 语音]  [📋 任务]          [⟳]     │
└─────────────────────────────────────────┘
```

**状态颜色**

| 状态 | 状态点颜色 | 含义 |
|------|-----------|------|
| 就绪 | `#3DFF9E`（绿） | 服务运行中，可接受命令 |
| 处理中 | `#FF9800`（橙） | 正在执行任务 |
| 离线 | `#F44336`（红） | 服务未运行 |

### 技术实现

**RemoteViews 更新流程**

```
PrefHelper.read()          读取 widget_status / widget_task_count
      │
      ▼
RemoteViews.setTextViewText()    设置文字
RemoteViews.setTextColor()       根据状态设置颜色
RemoteViews.setOnClickPendingIntent()  绑定三个按钮 Intent
      │
      ▼
AppWidgetManager.updateAppWidget()    推送至桌面
```

**更新触发时机**

| 触发源 | 频率 |
|--------|------|
| `updatePeriodMillis`（系统调度） | 30 分钟（最小间隔） |
| 服务轮询广播 `WIDGET_REFRESH` | 每 5 分钟 |
| 用户点击小组件 ⟳ 按钮 | 立即 |
| `AndroidBridge.updateStatus()` H5 调用 | 实时（用户操作时） |

**小组件配置**

```xml
<!-- res/xml/widget_info.xml -->
<appwidget-provider
    android:minWidth="250dp"
    android:minHeight="110dp"
    android:targetCellWidth="4"
    android:targetCellHeight="2"
    android:updatePeriodMillis="1800000"
    android:previewImage="@drawable/widget_preview"
    android:widgetCategory="home_screen" />
```

---

## 5 语音交互设计

### 交互流程

```
用户触发语音（通知按钮 / H5 按钮 / 小组件）
      │
      ▼
AndroidBridge.startSpeech()
      │
      ▼
SpeechRecognizer.startListening(intent)
  ├── LANGUAGE_MODEL_FREE_FORM
  ├── EXTRA_LANGUAGE = "zh-CN"
  ├── EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS = 2000
  └── EXTRA_PARTIAL_RESULTS = true
      │
      ├── onPartialResults → JS callback: onSpeechPartial(text)  [实时显示]
      ├── onRmsChanged    → JS callback: onSpeechVolume(rms)     [波形动画]
      ├── onResults       → JS callback: onSpeechResult(text)    [最终结果]
      └── onError         → JS callback: onSpeechError(code)     [错误处理]
```

### JS 回调 API

H5 前端监听以下全局函数（由 AndroidBridge 通过 `evaluateJavascript` 注入调用）：

```javascript
window.onNativeSpeechReady()        // 原生语音就绪，H5 可隐藏浏览器录音方案
window.onSpeechStart()              // 开始录音
window.onSpeechPartial(text)        // 中间结果（实时更新输入框）
window.onSpeechResult(text)         // 最终识别结果
window.onSpeechEnd()                // 录音结束
window.onSpeechVolume(rmsDb)        // 音量值（-2 ~ 10），用于驱动波形动画
window.onSpeechError(errorCode)     // 错误码（Android SpeechRecognizer 标准码）
```

### H5 调用原生 API

```javascript
// 检查是否有原生语音能力
if (window.AndroidBridge && window.AndroidBridge.isSpeechAvailable()) {
    window.AndroidBridge.startSpeech();
} else {
    // 降级：使用 Web Speech API
    startWebSpeech();
}

// 停止录音
window.AndroidBridge?.stopSpeech();

// 同步状态到通知和小组件
window.AndroidBridge?.updateStatus(taskCount, statusText);

// 页面导航
window.AndroidBridge?.openPage('tasks');

// Token 持久化
window.AndroidBridge?.saveToken(jwt);
const token = window.AndroidBridge?.getToken();
```

---

## 6 JS ↔ Native 通信桥

### AndroidBridge 接口全览

| 方法签名 | 方向 | 说明 |
|---------|------|------|
| `isSpeechAvailable(): Boolean` | JS→Native | 检查系统 STT 支持 |
| `startSpeech()` | JS→Native | 启动语音识别 |
| `stopSpeech()` | JS→Native | 停止识别 |
| `updateStatus(count: Int, status: String)` | JS→Native | 同步状态到通知/小组件 |
| `saveToken(token: String)` | JS→Native | 持久化 JWT |
| `getToken(): String` | JS→Native | 读取 JWT |
| `vibrate()` | JS→Native | 30ms 触感反馈 |
| `openPage(page: String)` | JS→Native | 原生跳转（预留扩展） |
| `onNativeSpeechReady()` | Native→JS | 通知 H5 原生就绪 |
| `onSpeechStart/End()` | Native→JS | 录音状态事件 |
| `onSpeechPartial(text)` | Native→JS | 中间识别结果 |
| `onSpeechResult(text)` | Native→JS | 最终识别结果 |
| `onSpeechVolume(rms)` | Native→JS | 音量回调 |
| `onSpeechError(code)` | Native→JS | 错误通知 |

### WebView 安全配置

```kotlin
settings.apply {
    javaScriptEnabled = true
    domStorageEnabled = true          // H5 localStorage
    allowFileAccess = false           // 禁止访问文件系统（file:// 除 assets 外）
    mixedContentMode = MIXED_CONTENT_ALWAYS_ALLOW  // 允许 HTTP API（开发环境）
    userAgentString = "AIAssistantApp/1.0 Android"
}
// 仅允许已知域名的内容（生产环境建议启用 SafeBrowsing）
webView.addJavascriptInterface(bridge, "AndroidBridge")
```

> **注意**：`@JavascriptInterface` 注解的方法在子线程执行，需通过 `runOnUiThread` 调回主线程后才能操作 UI 或 WebView。

---

## 7 数据流与状态管理

### SharedPreferences 键值表

| Key | 类型 | 默认值 | 写入方 | 读取方 |
|-----|------|--------|--------|--------|
| `auth_token` | String | "" | AndroidBridge | Service, Widget |
| `api_base` | String | BuildConfig | PrefHelper init | 所有组件 |
| `frontend_url` | String | `file:///android_asset/index.html` | PrefHelper init | MainActivity |
| `widget_task_count` | Int | 0 | AndroidBridge, Service | Widget |
| `widget_status` | String | "就绪" | AndroidBridge, Service | Widget |
| `last_sync_time` | String | "" | Service | Widget |

### 状态同步时序图

```
H5 用户完成操作（如创建任务）
      │
      ▼ JS: AndroidBridge.updateStatus(3, "就绪")
AndroidBridge.updateStatus()
      ├── PrefHelper.setWidgetTaskCount(3)
      ├── PrefHelper.setWidgetStatus("就绪")
      ├── NotificationHelper.updatePersistentNotification()    // 通知立即更新
      └── AssistantWidget.forceRefresh()                       // 小组件立即更新

──── 5 分钟后 ────

AIAssistantService.startPolling()
      ├── GET /api/tasks?status=pending → count=4
      ├── PrefHelper.setWidgetTaskCount(4)
      ├── PrefHelper.setLastSyncTime("14:37")
      ├── NotificationHelper.updatePersistentNotification()
      └── sendBroadcast(WIDGET_REFRESH) → AssistantWidget.onReceive()
```

---

## 8 安全设计

### Token 存储

- JWT 存储于 `SharedPreferences` (MODE_PRIVATE)，仅限当前应用访问
- 不存储在 WebView 的 Cookie 或 localStorage（跨组件共享需要原生层持有）
- H5 层通过 `AndroidBridge.getToken()` 在需要时读取，避免在 WebView 中长期持有敏感数据

### 网络安全

- 生产环境后端必须使用 HTTPS（`mixedContentMode` 应改为 `MIXED_CONTENT_NEVER_ALLOW`）
- `res/xml/network_security_config.xml` 中仅允许已知域名明文（开发调试用）

### 权限最小化

| 权限 | 必需原因 |
|------|---------|
| `INTERNET` | 访问后端 API |
| `RECORD_AUDIO` | 语音识别（运行时申请） |
| `FOREGROUND_SERVICE` | 常驻通知服务 |
| `FOREGROUND_SERVICE_SPECIAL_USE` | Android 14+ 前台服务类型声明 |
| `POST_NOTIFICATIONS` | Android 13+ 通知权限（运行时申请） |
| `RECEIVE_BOOT_COMPLETED` | 开机自启服务 |
| `VIBRATE` | 触感反馈 |

### WebView 安全

- 禁用 `allowFileAccess`（防止 file:// 路径遍历）
- 禁用 `allowContentAccess`
- 禁用 `geolocation`
- JS Bridge 方法设计为输入验证：`content.length <= 2000`，避免注入

---

## 9 目录结构

```
android/
├── build.gradle                        # 根构建文件（AGP + Kotlin 版本）
├── settings.gradle                     # 项目名称 + 模块声明
├── gradle/wrapper/
│   └── gradle-wrapper.properties       # Gradle 8.4
├── ANDROID_DESIGN.md                   # 本设计文档
└── app/
    ├── build.gradle                    # 应用模块构建配置
    └── src/main/
        ├── AndroidManifest.xml         # 权限 + 组件声明
        ├── assets/
        │   └── index.html              # H5 前端（需从 package/frontend 复制）
        ├── kotlin/com/aiassistant/
        │   ├── AIAApplication.kt       # Application：创建通知渠道
        │   ├── MainActivity.kt         # 主 Activity：WebView 宿主
        │   ├── AIAWebViewClient.kt     # WebView 拦截：注入 API_BASE
        │   ├── VoiceShortcutActivity.kt # 透明中转：通知语音按钮
        │   ├── bridge/
        │   │   └── AndroidBridge.kt    # JS↔Native 通信桥
        │   ├── notification/
        │   │   └── NotificationHelper.kt # 通知构建/更新
        │   ├── service/
        │   │   ├── AIAssistantService.kt # 前台服务 + 轮询
        │   │   └── BootReceiver.kt     # 开机自启
        │   ├── widget/
        │   │   └── AssistantWidget.kt  # 桌面小组件
        │   └── util/
        │       └── PrefHelper.kt       # SharedPreferences 封装
        └── res/
            ├── drawable/
            │   ├── ic_launcher_background.xml   # 图标背景（渐变）
            │   ├── ic_launcher_foreground.xml   # 图标前景（机器人）
            │   ├── ic_notification.xml          # 通知栏单色图标
            │   ├── ic_mic.xml                   # 麦克风图标
            │   ├── ic_tasks.xml                 # 任务图标
            │   ├── widget_bg.xml                # 小组件背景
            │   ├── widget_btn_bg.xml            # 小组件按钮背景
            │   ├── widget_status_bg.xml         # 状态胶囊背景
            │   └── widget_preview.xml           # 小组件选择器预览
            ├── layout/
            │   ├── activity_main.xml            # 全屏 WebView 布局
            │   └── widget_assistant.xml         # 小组件 4×2 布局
            ├── mipmap-anydpi-v26/
            │   ├── ic_launcher.xml              # 自适应图标
            │   └── ic_launcher_round.xml        # 圆形图标
            ├── values/
            │   ├── strings.xml                  # 字符串资源
            │   ├── colors.xml                   # 颜色定义
            │   └── themes.xml                   # 主题（深色 + 透明）
            └── xml/
                ├── widget_info.xml              # 小组件元数据
                ├── backup_rules.xml             # 备份排除规则
                └── data_extraction_rules.xml    # 数据提取规则
```

---

## 10 构建与部署

### 环境要求

| 工具 | 版本 |
|------|------|
| Android Studio | Hedgehog (2023.1.1)+ |
| JDK | 17 |
| Gradle | 8.4 |
| AGP (Android Gradle Plugin) | 8.2.0 |
| Kotlin | 1.9.22 |
| minSdk | 26 (Android 8.0) |
| targetSdk | 34 (Android 14) |

### 配置后端地址

在 `app/build.gradle` 中修改 `API_BASE_URL`：

```groovy
buildConfigField "String", "API_BASE_URL", "\"https://your-api.example.com\""
```

或通过 `local.properties` 注入（推荐生产环境）：

```properties
# local.properties（不提交到 Git）
api.base.url=https://your-api.example.com
```

### 部署 H5 前端

将编译好的前端复制到 Android assets：

```bash
# 从项目根目录执行
cp package/frontend/index.html android/app/src/main/assets/index.html
```

如需加载远程 H5（CDN 部署），修改 `PrefHelper.kt` 中的 `DEFAULT_FRONTEND_URL`：

```kotlin
private const val DEFAULT_FRONTEND_URL = "https://your-frontend.example.com"
```

### 构建命令

```bash
cd android

# 调试版本
./gradlew assembleDebug

# 发布版本（需配置签名）
./gradlew assembleRelease

# 安装到连接的设备
./gradlew installDebug
```

### 签名配置（生产）

在 `app/build.gradle` 中添加：

```groovy
android {
    signingConfigs {
        release {
            storeFile file(KEYSTORE_PATH)
            storePassword KEYSTORE_PASSWORD
            keyAlias KEY_ALIAS
            keyPassword KEY_PASSWORD
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled true
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt')
        }
    }
}
```

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0 | 2026-03-12 | 初始版本：常驻通知 + 桌面小组件 + 语音桥接 |
