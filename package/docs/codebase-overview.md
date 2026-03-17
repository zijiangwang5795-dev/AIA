# AI 助手 — 代码库全量说明文档

> 本文档基于当前代码库（branch: `claude/kotlin-to-java-conversion-RYKWQ`）自动梳理生成，覆盖所有模块、接口、数据流与设计决策。

---

## 目录

1. [系统总览](#1-系统总览)
2. [文件结构](#2-文件结构)
3. [后端模块详解](#3-后端模块详解)
   - 3.1 入口与基础设施
   - 3.2 认证系统（auth）
   - 3.3 两层大脑架构
   - 3.4 人格组装器
   - 3.5 工具注册表
   - 3.6 OpenClaw 网关客户端
   - 3.7 业务路由层
   - 3.8 中间件
   - 3.9 数据库
4. [前端模块详解](#4-前端模块详解)
5. [完整 API 接口表](#5-完整-api-接口表)
6. [数据库 Schema](#6-数据库-schema)
7. [核心数据流](#7-核心数据流)
8. [环境变量参照](#8-环境变量参照)
9. [安全与生产注意事项](#9-安全与生产注意事项)

---

## 1. 系统总览

```
用户（手机/浏览器）
    │
    ▼
前端 SPA（index.html）── 单文件 HTML/CSS/JS，支持 Android WebView
    │  REST + SSE
    ▼
后端（Node.js / Fastify）
    ├── 第一层大脑：意图分类 + 模型路由（~50ms，纯规则）
    ├── 第二层大脑：ReAct Agent 循环（LLM + 工具执行）
    ├── 人格组装：灵魂 + 天赋 + 运行时状态 + 记忆
    └── 业务层：任务、技能、记忆、好友、订阅...
             │
             ▼
    OpenClaw 网关（自托管，:18789）
    ├── 免费用户：共享实例，按 agentId 隔离
    └── 付费用户：专属实例（可自行部署）
             │
             ▼
    AI 模型（DeepSeek / GPT-4o / Claude）

数据存储
    ├── PostgreSQL + pgvector（主数据 + 向量记忆）
    └── Redis（短期会话缓存）
```

**技术选型概览：**

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | Vanilla HTML/CSS/JS | 无框架，兼容 Android WebView |
| 后端 | Node.js + Fastify | 轻量，流式友好 |
| AI 网关 | OpenClaw | 自托管，OpenAI 兼容 API |
| 数据库 | PostgreSQL + pgvector | 关系数据 + 向量嵌入 |
| 缓存 | Redis | 短期状态 |
| Android | Java + WebView | 语音识别桥接、客户端技能 |

---

## 2. 文件结构

```
AIA/
├── COMMERCIAL_DESIGN.md              # 商业模式、定价、变现策略
├── ai-assistant-architecture-v5.md   # 系统架构文档（双层大脑）
│
├── android/                          # Android 原生 App（WebView 壳 + 语音桥接）
│   └── app/src/main/java/com/aia/assistant/
│       ├── MainActivity.java          # WebView 初始化、语音识别
│       ├── bridge/AndroidBridge.java  # JS ↔ Java 双向桥接
│       ├── push/FCMService.java       # Firebase 推送
│       ├── service/AIAssistantService.java
│       ├── widget/AssistantWidget.java # 桌面小组件
│       └── VoiceShortcutActivity.java  # 快捷方式入口
│
└── package/
    ├── README.md                      # 部署说明
    ├── docs/
    │   ├── openclaw-setup-guide.md    # OpenClaw 配置指南
    │   └── codebase-overview.md      # 本文档
    │
    ├── frontend/
    │   └── index.html                 # 单文件 SPA（~8000行，含所有页面）
    │
    └── backend/
        ├── package.json
        ├── .env.example
        ├── Dockerfile
        ├── docker-compose.yml
        └── src/
            ├── index.js               # Fastify 入口，路由挂载
            │
            ├── routes/                # HTTP 路由层
            │   ├── auth.js            # 认证：OTP、微信 OAuth、JWT
            │   ├── analyze.js         # 核心分析（SSE 流式）
            │   ├── _crud.js           # tasks/skills/memory/audit 通用 CRUD
            │   ├── tasks.js           # 任务路由（代理 _crud）
            │   ├── skills.js          # 技能路由（代理 _crud）
            │   ├── memory.js          # 记忆路由（代理 _crud）
            │   ├── audit.js           # 审计日志
            │   ├── friends.js         # 好友社交
            │   ├── billing.js         # 订阅计费
            │   ├── feedback.js        # 用户反馈
            │   ├── push.js            # 推送通知
            │   ├── openclaw.js        # OpenClaw 配置管理
            │   └── admin.js           # 管理员接口
            │
            ├── brain/                 # AI 推理核心
            │   ├── layer1/index.js    # 第一层：意图分类 + 模型路由
            │   ├── layer2/agentExecutor.js # 第二层：ReAct 循环
            │   └── openclaw/client.js # OpenClaw 网关客户端
            │
            ├── personality/
            │   └── assembler.js       # 系统提示词组装
            │
            ├── tools/
            │   └── registry.js        # 工具定义 + 执行器
            │
            ├── middleware/
            │   └── quota.js           # 用量配额检查
            │
            ├── auth/
            │   └── middleware.js      # JWT 验证中间件
            │
            ├── config/
            │   └── runtime.js         # 运行时配置热更新
            │
            └── db/
                ├── client.js          # PostgreSQL 连接池
                └── migrate.js         # 数据库 Schema 初始化
```

---

## 3. 后端模块详解

### 3.1 入口与基础设施

#### `src/index.js`（76 行）

服务器入口，负责：

- 注册 Fastify 插件（CORS、JWT、限速、静态文件）
- 挂载所有路由（前缀映射）
- 启动时自动执行数据库迁移
- SPA 回退：未匹配路由返回 `index.html`

**路由挂载表：**

| 前缀 | 模块 |
|---|---|
| `/auth` | `routes/auth.js` |
| `/api` | `routes/analyze.js`, `tasks.js`, `skills.js`, `memory.js`, `audit.js`, `friends.js`, `billing.js`, `feedback.js`, `push.js` |
| `/api/openclaw` | `routes/openclaw.js` |
| `/admin` | `routes/admin.js` |

**全局配置：**
- 限速：100 次/分钟
- CORS：开发期 `origin: true`（生产需收窄）
- JWT：默认 2h 过期

---

### 3.2 认证系统

#### `src/routes/auth.js`（373 行）

**手机 OTP 登录流程：**

```
POST /auth/otp/send  →  生成6位随机码，存入 otp_codes（60秒过期）
                         生产：接入阿里云/腾讯云短信
                         演示：打印到日志（DEMO_MODE=true）
POST /auth/otp/verify →  校验 code，查找/创建用户
                          签发 accessToken（2h）+ refreshToken（30天）
                          首次登录自动创建用户记录
```

**微信 OAuth 流程：**

```
GET /auth/wechat/url
  → 生成随机 state（UUID，存内存 Map，10分钟 TTL）
  → 返回微信授权 URL（snsapi_userinfo）
  → 支持 ?bind=1 参数（已登录用户绑定微信，需要 JWT）

GET /auth/wechat/callback?code=xxx&state=yyy
  → 校验 state（防 CSRF）
  → 用 code 换 access_token + openid（微信 API）
  → 拉取用户信息（昵称、头像）
  → 登录模式：查找 oauth_accounts 中同 openid 的用户，
               不存在则新建用户 + oauth_accounts 记录
  → 绑定模式：将 openid 插入已有用户的 oauth_accounts
  → 签发 JWT，重定向到前端：/?wechat_token=xxx&wechat_refresh=xxx
```

**Token 管理：**

| Token | 存储 | 有效期 | 用途 |
|---|---|---|---|
| accessToken | JWT（无服务端状态） | 2h | 所有 API 请求 |
| refreshToken | `refresh_tokens` 表（哈希存储） | 30天 | 换取新 accessToken |

**Profile 更新同步：**

`PUT /auth/profile` 修改 `assistantName/talent/soulPrompt/preferredModel/assistantEmoji` 时，异步触发 `syncAgentConfig()`，将静态人格推送到 OpenClaw。

---

### 3.3 两层大脑架构

#### 第一层：`src/brain/layer1/index.js`（146 行）

**职责：** 纯规则推理，~50ms 内完成意图分类 + 模型路由，不调用任何 AI。

**意图分类规则（正则匹配，按优先级）：**

| 正则 | 意图 | 置信度 |
|---|---|---|
| `帮我(告诉\|通知\|发消息给)` | `send-friend-message` | 0.95 |
| `闹钟\|定时提醒\|提醒我.*点` | `client-alarm` | 0.95 |
| `打电话\|拨打\|给.*打电话` | `client-call` | 0.95 |
| `日历\|日程\|会议` | `client-calendar` | 0.92 |
| `提取\|任务\|待办\|记一下` | `analyze-voice` | 0.90 |
| `AI.*(新闻\|动态\|资讯)` | `ai-news` | 0.90 |
| `日报\|周报\|总结` | `daily-brief` | 0.90 |
| `深度\|分析一下\|详细推理` | `deep-analysis` | 0.85 |
| `搜索\|查一下\|查询` | `web-search` | 0.85 |
| `记住\|记下来\|偏好` | `save-memory` | 0.85 |

**模型路由规则（责任链，按 priority 升序）：**

| Priority | 规则名 | 触发条件 | 选用模型 |
|---|---|---|---|
| 10 | needs-web-search | 工具含 web_search 或意图为 web-search/ai-news | gpt-4o-mini |
| 20 | deep-reasoning | 意图为 deep-analysis 或 agentSteps > 3 | deepseek-reasoner |
| 30 | short-text-cheap | 输入 < 200 字符 + 意图为 calculate | deepseek-chat |
| 40 | user-preference | 用户设置了 preferred_model | 用户设定值 |
| 999 | fallback | 任意 | deepseek-chat |

**降级保护：** 若选定模型对应的 API Key 不存在，自动回退到 `deepseek-chat`。

**技能 → 工具映射：**

| 技能 | 可用工具 |
|---|---|
| `ai-news` | web_search, create_tasks, save_memory |
| `analyze-voice` | create_tasks, memory_search, save_memory |
| `daily-brief` | memory_search, get_tasks |
| `deep-analysis` | web_search, memory_search, calculator |
| `client-alarm/calendar` | create_tasks（同步写入任务记录） |
| `send-friend-message` | send_friend_message |
| `default` | create_tasks, memory_search |

**输出：** `{ intent, intentConfidence, tools[], selectedModel, selectedRule, processingMs }`

---

#### 第二层：`src/brain/layer2/agentExecutor.js`（232 行）

**职责：** 基于 ReAct（推理-行动）范式执行多步 Agent 循环。

**核心函数：** `runAgent({ userId, text, toolNames, model, routingRule, intent, send, clientToolDefs, clientToolNames })`

**ReAct 循环（最多 8 步）：**

```
while (step < MAX_STEPS) {
  1. THINK:  调用 OpenClaw（callOpenClaw），传入 systemPrompt + 对话历史 + 工具定义
  2. DECIDE: LLM 返回文本（finish）或 tool_calls（继续循环）
  3. ACT:    执行工具
     ├── 客户端工具（client-*）：发送 SSE `client_action` 事件，由前端/Android 执行
     └── 服务端工具（其余）：直接调用 executeTool()
  4. OBSERVE: 将工具结果追加为 {role: "tool"} 消息
  5. 发送 SSE `tool_done` 事件
}
```

**SSE 事件类型：**

| 事件 | 数据 | 含义 |
|---|---|---|
| `step` | `{step, label}` | 进度提示（第一层路由结果、第二层开始等）|
| `text` | `{chunk}` | LLM 流式文本片段 |
| `tool_start` | `{name, args}` | 工具即将执行 |
| `client_action` | `{name, args}` | 需客户端执行的操作（设闹钟、打电话等）|
| `tool_done` | `{name, result}` | 工具执行完毕 |
| `task_extract` | `{tasks[], summary}` | 任务提取完成（前端展示确认卡片）|
| `error` | `{message}` | 异常 |
| `done` | `{runId, totalTokens, latencyMs, costUsd, model, gateway}` | 全部完成 |

**费用估算（客户端展示用）：**

| 模型 | 输入（per 1k token） | 输出（per 1k token）|
|---|---|---|
| deepseek-chat | $0.00014 | $0.00028 |
| gpt-4o-mini | $0.00015 | $0.00060 |
| gpt-4o | $0.005 | $0.015 |

**异步情节记忆：**
Agent 结束后，使用 `setImmediate` 异步调用 `summarizeToEpisodic()`，将对话摘要向量化后存入 `episodic_memories`，不阻塞响应。

---

### 3.4 人格组装器

#### `src/personality/assembler.js`（167 行）

**职责：** 每次请求前动态拼装系统提示词，融合用户个性化设定与实时上下文。

**五层提示词结构：**

| 层 | 名称 | 来源 | 示例 |
|---|---|---|---|
| L1 | 灵魂（Soul） | 代码内置 + 用户助手名 | 你是"小智"，你的核心使命是... |
| L2 | 天赋（Talent） | 用户 DB 字段 `talent` | 【软件工程师天赋】理解代码、PR、架构... |
| L3 | 自定义灵魂 | 用户 DB 字段 `soul_prompt` | 用户附加的个性化 prompt |
| L4 | 运行时上下文 | 实时计算 | 现在是下午3点 · 有5项待处理任务 |
| L5 | 记忆上下文 | DB 查询 | 长期记忆10条 + 情节记忆向量检索3条 |

**天赋类型：**

| 天赋 | 关键词 |
|---|---|
| `software-engineer` | 代码、PR、架构、CI/CD、Debug |
| `product-manager` | 需求、PRD、路线图、用户调研 |
| `student` | 课程、论文、考试、笔记、学习计划 |
| `default` | 通用任务管理、时间安排 |

**运行时状态（影响语气）：**

| 时段 | 模式 | 行为 |
|---|---|---|
| 22:00–7:00 | 深夜模式 | 关心用户休息，简短回复 |
| 7:00–12:00 | 晨间模式 | 积极、高效 |
| 12:00–18:00 | 午后模式 | 常规 |
| 18:00–22:00 | 晚间模式 | 轻松 |

**导出函数：**

| 函数 | 同步/异步 | 用途 |
|---|---|---|
| `assembleSystemPrompt(userId, userInput)` | async | 每次请求完整组装（含动态记忆）|
| `buildStaticPersona(user)` | sync | 同步到 OpenClaw Agent 配置（不含动态内容）|
| `buildSoul(assistantName)` | sync | 仅核心灵魂层 |
| `TALENTS` | 常量 | 四种天赋 prompt 文本 |

---

### 3.5 工具注册表

#### `src/tools/registry.js`（305 行）

所有工具均使用 OpenAI Function Calling 格式定义。

**服务端工具（后端直接执行）：**

| 工具 | 描述 | 关键参数 | 副作用 |
|---|---|---|---|
| `web_search` | 联网搜索 | `query: string` | 调用 Tavily/Serper API；无 Key 时返回模拟数据 |
| `create_tasks` | 批量创建任务 | `tasks[]: {title, priority, category, deadline}` | 写入 `tasks` 表 |
| `get_tasks` | 获取任务列表 | `status, limit` | 读取 `tasks` 表 |
| `memory_search` | 搜索长期记忆 | `query: string` | 读取 `user_memories`（ILIKE 模糊匹配）|
| `save_memory` | 保存长期记忆 | `key, value` | upsert `user_memories` |
| `calculator` | 数学计算 | `expression: string` | 安全求值（过滤非数学字符）|
| `send_friend_message` | 助手代发消息 | `friendName, message` | 写入 `messages` + 触发 FCM 推送 |

**客户端工具（由前端/Android 执行，通过 SSE `client_action` 事件分发）：**

| 工具 | 执行端 | Android API |
|---|---|---|
| `set_alarm` | Android | `AlarmManager` |
| `add_calendar_event` | Android | `CalendarProvider` |
| `make_phone_call` | Android | `Intent.ACTION_CALL` |
| `send_sms` | Android | `SmsManager` |

> 客户端工具定义由前端在请求时上报（`clientSkills` 字段），不硬编码在服务端。

**安全计算器实现：**

```javascript
const expr = args.expression.replace(/[^0-9+\-*/().%\s]/g, '');
const result = Function(`'use strict'; return (${expr})`)();
```

通过正则过滤掉所有非数学字符，防止代码注入。

---

### 3.6 OpenClaw 网关客户端

#### `src/brain/openclaw/client.js`（298 行）

**核心职责：** 统一 AI 调用入口，按用户订阅等级自动路由到共享或专属 OpenClaw 实例。

**用户路由逻辑：**

```
resolveUserConfig(userId):
  ├── userId 为空 → 使用平台共享实例，无 agentId
  ├── 免费用户（isPaidUser = false）
  │     → 共享实例（OPENCLAW_URL）
  │     → agentId = "aia_{userId}"（用于会话隔离）
  └── 付费用户
        ├── user_memories._openclaw_url 存在
        │     → 专属实例（dedicated mode）
        └── 否则 → 共享实例 + agentId（待配置提示）
```

**共享模式会话隔离：**
- 请求头：`X-OpenClaw-Agent: aia_{userId}`
- 请求体：`user: "aia_{userId}"`（OpenAI 标准字段）

**主要导出函数：**

```javascript
// 发起 LLM 调用（支持流式）
callOpenClaw({ model, systemPrompt, messages, tools, stream, onChunk, userId })
// 返回：{ text, toolCalls[], usage, latencyMs, finishWithTools }

// 生成向量嵌入（用于情节记忆）
createEmbedding(text, userId)
// 返回：1536维向量数组

// 同步静态人格到 OpenClaw Agent 配置
syncAgentConfig(userId, { staticPersona, assistantName, assistantEmoji, model })
// 调用：PUT /api/agents/{agentId}（5秒超时，失败静默）

// 检查 OpenClaw 是否已配置
isOpenClawConfigured()   // 返回 boolean
getOpenClawConfig()       // 返回 { url, token, defaultModel, embedModel }
```

**降级链：**
1. OpenClaw 网关（首选）
2. 直接调用 DeepSeek/OpenAI/Anthropic（`OPENCLAW_URL` 未配置时）

---

### 3.7 业务路由层

#### `src/routes/analyze.js`（158 行）— 核心分析

提供两个 SSE 流式端点：

- `POST /api/analyze` — 分析语音/文字输入，提取任务，执行 Agent
- `POST /api/skills/:skillId/run` — 执行指定技能

**请求体格式：**
```json
{
  "text": "明天早上8点提醒我开会",
  "skillType": "analyze-voice",
  "clientSkills": [
    { "name": "set_alarm", "description": "设置手机闹钟", "parameters": {...} }
  ]
}
```

**心跳机制：** 每 15 秒发送 `: ping\n\n` 注释，防止 Nginx/LB 切断 SSE 连接。

**配额处理：** 调用完成后异步执行 `incrementUsage()`，不阻塞响应。

---

#### `src/routes/_crud.js`（155 行）— 通用 CRUD

统一实现了四类资源的操作，由 `tasks.js`、`skills.js`、`memory.js`、`audit.js` 代理：

**任务（tasks）：**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/tasks` | 列表，支持 `status=pending/done/all`，按优先级排序 |
| POST | `/tasks` | 单个或批量创建（接受数组或对象）|
| PATCH | `/tasks/:id` | 更新 status/title/priority |
| DELETE | `/tasks/:id` | 软删除（直接 DELETE）|

**技能（skills）：**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/skills` | 返回用户自定义 + 内置技能 |
| POST | `/skills` | 创建自定义技能 |
| DELETE | `/skills/:id` | 仅允许删除非内置技能 |

**记忆（memory）：**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/memory/long` | 长期记忆 k-v 列表（按更新时间降序）|
| POST | `/memory/long` | 保存/更新 k-v（upsert）|
| DELETE | `/memory/long/:key` | 删除指定 key |
| GET | `/memory/episodic` | 情节记忆摘要（最新20条）|

**审计日志（audit）：**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/audit` | 返回日志列表 + 汇总统计（总调用数、总 Token、总费用、平均延迟）|

---

#### `src/routes/friends.js`（社交）

**好友关系模型：** 请求者（requester）→ 接受者（recipient），方向性关系。

**状态流转：** `pending` → `accepted` / `rejected` / `blocked`

| 接口 | 说明 |
|---|---|
| `GET /users/search?q=` | 按手机精确 / 昵称模糊搜索（is_searchable=true，排除自己，含关系状态）|
| `GET /users/lookup/:id` | 按 UUID 查询用户信息 |
| `GET /friends?status=accepted` | 好友列表（含未读消息数）|
| `POST /friends/request` | 发送好友请求 |
| `PATCH /friends/:id` | 接受/拒绝/屏蔽/删除（action 字段）|
| `GET /friends/:friendId/profile` | 好友主页（隐私控制：tasks/skills/activity 按设置显示）|
| `POST /messages` | 发送消息（支持 sender_type=assistant，即助手代发）|
| `GET /messages/:friendId` | 聊天记录（分页，自动标记已读）|
| `GET /friends/privacy` | 获取隐私设置 |
| `PUT /friends/privacy` | 更新隐私设置（show_tasks/show_skills/show_activity）|

---

#### `src/routes/billing.js`（订阅计费）

**订阅等级：**

| 等级 | 价格 | AI 调用/月 | 最大技能数 |
|---|---|---|---|
| `free` | 免费 | 100 | 5 |
| `pro` | ¥68/月 | 2000 | 20 |
| `enterprise` | ¥688/月 | 无限 | 无限 |

| 接口 | 说明 |
|---|---|
| `GET /plans` | 所有可用套餐（按价格升序）|
| `GET /subscription` | 当前订阅状态 + 本月用量（含百分比）|
| `GET /subscription/usage-detail` | 近6个月用量历史 |
| `POST /subscription/upgrade` | 升级套餐（Mock 支付，直接激活；返回 OpenClaw 配置引导）|
| `POST /subscription/cancel` | 取消订阅（当期继续有效）|
| `POST /webhook/payment` | 支付回调（生产需接入 Stripe/微信支付）|

---

#### `src/routes/openclaw.js`（OpenClaw 管理）

| 接口 | 鉴权 | 说明 |
|---|---|---|
| `GET /status` | JWT | 返回当前 OpenClaw 模式、是否需要配置 |
| `PUT /config` | JWT + 付费计划 | 注册专属 OpenClaw 实例（存入 user_memories，触发人格同步）|
| `DELETE /config` | JWT | 删除专属配置，回退共享模式 |

> 免费用户调用 `PUT /config` 返回 403 `dedicated_openclaw_requires_paid_plan`。

---

#### `src/routes/admin.js`（管理员）

运行时配置热更新，无需重启服务：

| 接口 | 说明 |
|---|---|
| `GET /admin/config` | 查看当前运行时配置（API Key 已掩码）|
| `PUT /admin/config` | 更新 aiBaseUrl/aiApiKey/aiModel/backendUrl/backendPort |
| `DELETE /admin/config` | 重置为 `.env` 默认值 |

> API Key 特殊处理：空字符串 = 不改动；`__clear__` = 清空。

---

#### `src/routes/feedback.js`（用户反馈）

| 接口 | 说明 |
|---|---|
| `POST /feedback` | 提交反馈（type: bug/feature/general，内容5-2000字）|
| `GET /feedback/mine` | 获取自己的反馈历史 |

---

#### `src/routes/push.js`（推送通知）

| 接口 | 说明 |
|---|---|
| `POST /push/register` | 注册设备推送 Token（FCM）|
| `DELETE /push/token` | 注销 Token（登出时调用）|
| `POST /push/send` | 发送推送（内部接口；TODO: 接入 Firebase Admin SDK）|

---

### 3.8 中间件

#### `src/auth/middleware.js`

```javascript
authMiddleware(req, reply)  // 严格：无/无效 token → 401
optionalAuth(req, reply)    // 宽松：失败则使用 Demo 用户 ID（00000000-...-0001）
```

#### `src/middleware/quota.js`

```javascript
checkQuota(req, reply)         // Fastify preHandler，超配额返回 429
incrementUsage(userId, in, out, cost)  // 异步写入 monthly_usage
getUserPlan(userId)            // 查询当前订阅套餐
getMonthlyUsage(userId)        // 查询本月用量快照
```

**配额校验逻辑：**
- `plan.monthly_ai_calls === -1` → 无限制（企业版）
- 当月 `ai_calls >= limit` → 返回 HTTP 429，携带当前用量和套餐信息
- 数据库不可用时：记录警告日志，不阻断请求（降级放行）

#### `src/config/runtime.js`

内存运行时配置覆盖系统（重启后失效）：

```javascript
getRuntimeConfig()           // 返回当前配置副本
setRuntimeConfig(updates)    // 仅允许白名单字段更新
resolveApiKey(model)         // 按模型名返回对应 API Key（运行时覆盖 > .env）
resolveBaseUrl(model)        // 按模型名返回 API Base URL
```

**白名单字段：** `openclawUrl`, `openclawToken`, `openclawMode`, `aiBaseUrl`, `aiApiKey`, `aiModel`, `backendUrl`, `backendPort`

---

### 3.9 数据库

#### `src/db/client.js`（15 行）

```javascript
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,                   // 最大连接数
  idleTimeoutMillis: 30000,  // 30秒空闲回收
});
const query = (text, params) => db.query(text, params);
```

#### `src/db/migrate.js`（299 行）

启动时自动执行，所有 DDL 语句幂等（`IF NOT EXISTS`、`ON CONFLICT DO NOTHING`）。

- 正常情况：执行完整 SQL
- pgvector 未安装：降级，`vector(1536)` 列替换为 `TEXT`

---

## 4. 前端模块详解

#### `package/frontend/index.html`（~3500+ 行）

单文件 SPA，含全部 HTML 结构、CSS（约 500 行变量+样式）、JS（约 2800 行逻辑）。

---

### 页面结构

```
#authScreen          登录页（手机 OTP + 微信/Apple/Google OAuth）
#app
  ├── #topbar        顶部栏（Logo、在线状态、用户头像）
  ├── #scr           可滚动内容区
  │   ├── #page-home        首页（语音 Hero、快捷方式、推荐技能）
  │   ├── #page-voice       语音录制与分析
  │   ├── #page-tasks       任务清单
  │   ├── #page-skills      技能中心
  │   ├── #page-friends     好友社交
  │   ├── #page-market      技能市场
  │   ├── #page-more        更多设置
  │   ├── #page-router      AI 路由可视化（调试）
  │   ├── #page-agent       Agent 执行日志
  │   ├── #page-memory      三层记忆查看
  │   ├── #page-audit       用量审计
  │   ├── #page-models      模型注册表
  │   ├── #page-auth        账号绑定
  │   ├── #page-soul        灵魂与天赋设置
  │   ├── #page-chat        与好友聊天
  │   ├── #page-friend-profile  好友主页
  │   ├── #page-privacy     隐私设置
  │   ├── #page-subscription    订阅管理
  │   ├── #page-feedback    反馈表单
  │   ├── #page-mdetail     技能市场详情
  │   └── #page-publish     发布自定义技能
  └── #botnav        底部导航（6 个 Tab）
```

---

### 全局状态

```javascript
// 核心状态对象
const S = {
  user: null,            // 当前用户
  assistantEmoji: '🤖',
  assistantName: '我的助手',
  tasks: [],             // 任务列表
  ltm: {},               // 长期记忆（KV）
  epi: [],               // 情节记忆
  audit: [],             // 审计日志
  bound: [],             // 已绑定账号
  pend: [],              // 待确认的提取任务
  rec: false,            // 录音状态
};

// 认证对象（localStorage 持久化）
const Auth = {
  token: localStorage.getItem('ai_token'),
  userId: localStorage.getItem('ai_uid'),
  user: JSON.parse(localStorage.getItem('ai_user') || 'null'),
  save(accessToken, user) { ... },
  clear() { ... },
  headers() { return { Authorization: `Bearer ${this.token}` } },
};
```

**localStorage 键名：**

| 键 | 内容 |
|---|---|
| `ai_token` | JWT accessToken |
| `ai_uid` | 用户 UUID |
| `ai_user` | 用户信息 JSON |
| `ai_refresh` | refreshToken |

---

### 启动流程（`initApp()`）

```
1. 检查 URL 参数中是否有 wechat_token（微信 OAuth 回调）
   ├── 有 → 调用 /auth/me 验证，doLogin()，清理 URL
   └── 有 wechat_error → toast 提示错误
2. 检查后端连接（GET /health）
   └── 失败 → 离线模式，使用本地缓存 user
3. Auth.token 存在 → 调用 /auth/me 验证
   └── 失败 → 尝试 refreshToken 换新 token
4. 无有效 token → 尝试 demo-login（DEMO_MODE=true）
5. demo-login 失败 → 显示 #authScreen
```

---

### 语音识别双引擎

```javascript
// 优先级1: Android 原生（精度更高）
if (typeof AndroidBridge !== 'undefined' && AndroidBridge.isSpeechAvailable()) {
  useNativeBridge = true;
  AndroidBridge.startSpeech();  // 调用 Java SpeechRecognizer
  // 回调: onSpeechResult(text), onSpeechPartial(text), onSpeechVolume(rms)
}

// 优先级2: Web Speech API（浏览器降级）
const recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
recognition.lang = 'zh-CN';
recognition.continuous = true;
recognition.interimResults = true;
```

---

### SSE 流式解析

```javascript
const reader = resp.body.getReader();
const decoder = new TextDecoder();
let buf = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buf += decoder.decode(value, { stream: true });
  const blocks = buf.split('\n\n');
  buf = blocks.pop(); // 保留不完整的最后块

  for (const block of blocks) {
    if (!block.trim() || block.startsWith(':')) continue; // 跳过心跳
    const eventType = block.match(/^event: (\w+)/m)?.[1] || 'message';
    const dataStr   = block.match(/^data: (.+)$/ms)?.[1];
    if (dataStr) handleSSEEvent(eventType, JSON.parse(dataStr));
  }
}
```

---

### CSS 设计系统

```css
:root {
  /* 背景层 */
  --bg: #06060f;   --s1: #0d0d1c;   --s2: #131326;   --s3: #1a1a32;
  /* 边框 */
  --bd: #20203a;   --bd2: #2a2a48;
  /* 主色调 */
  --ac: #7c6fff;   --ac2: rgba(124,111,255,.15);  /* 主紫 */
  --pk: #ff6b9d;   /* 粉 */
  --cy: #3dffd4;   /* 青 */
  --gold: #f5c842; /* 金 */
  /* 文字 */
  --tx: #eeeef8;   --t2: #8888aa;   --t3: #44445a;
  /* 状态 */
  --ok: #3dffa0;   --wn: #ffd060;   --er: #ff4d70;
}
```

---

## 5. 完整 API 接口表

### 认证接口

| 方法 | 路径 | 鉴权 | 请求体 | 返回 |
|---|---|---|---|---|
| POST | `/auth/otp/send` | - | `{phone}` | `{success, expiresIn, demo}` |
| POST | `/auth/otp/verify` | - | `{phone, code}` | `{accessToken, refreshToken, user}` |
| POST | `/auth/demo-login` | - | - | `{accessToken, user}` |
| POST | `/auth/refresh` | - | `{refreshToken}` | `{accessToken}` |
| GET | `/auth/me` | JWT | - | UserProfile |
| PUT | `/auth/profile` | JWT | 部分字段 | UserProfile |
| GET | `/auth/wechat/url` | -/JWT | `?bind=1` | `{url}` |
| GET | `/auth/wechat/callback` | - | query: code, state | 302 → /?wechat_token=... |
| POST | `/auth/logout` | JWT | - | 204 |

### 分析接口（SSE 流）

| 方法 | 路径 | 鉴权 | 请求体 | SSE 事件 |
|---|---|---|---|---|
| POST | `/api/analyze` | JWT（可选）| `{text, clientSkills?}` | step, text, tool_start, client_action, tool_done, task_extract, error, done |
| POST | `/api/skills/:skillId/run` | JWT（可选）| `{input?}` | 同上 |

### 任务接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/tasks` | JWT（可选）| `?status=pending/done/all&limit=50` |
| POST | `/api/tasks` | JWT（可选）| 单个或数组批量创建 |
| PATCH | `/api/tasks/:id` | JWT（可选）| 更新 status/title/priority |
| DELETE | `/api/tasks/:id` | JWT（可选）| 204 |

### 技能接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/skills` | JWT（可选）| 返回用户技能 + 内置技能 |
| POST | `/api/skills` | JWT（可选）| 创建自定义技能 |
| DELETE | `/api/skills/:id` | JWT（可选）| 仅限非内置技能 |

### 记忆接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/memory/long` | JWT（可选）| 长期记忆列表 |
| POST | `/api/memory/long` | JWT（可选）| 保存/更新 KV |
| DELETE | `/api/memory/long/:key` | JWT（可选）| 删除指定 key |
| GET | `/api/memory/episodic` | JWT（可选）| 情节记忆（最新20条）|

### 好友接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/users/search` | JWT | `?q=关键词` |
| GET | `/api/users/lookup/:id` | JWT | 按 UUID 查用户 |
| GET | `/api/friends` | JWT | `?status=accepted/pending` |
| POST | `/api/friends/request` | JWT | 发送好友申请 |
| PATCH | `/api/friends/:id` | JWT | `action: accept/reject/block/remove` |
| GET | `/api/friends/:friendId/profile` | JWT | 好友主页（含隐私控制）|
| POST | `/api/messages` | JWT | 发送消息（支持助手代发）|
| GET | `/api/messages/:friendId` | JWT | 聊天记录（分页）|
| GET | `/api/friends/privacy` | JWT | 获取隐私设置 |
| PUT | `/api/friends/privacy` | JWT | 更新隐私设置 |

### 订阅接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/plans` | - | 所有套餐列表 |
| GET | `/api/subscription` | JWT | 当前订阅 + 用量 |
| GET | `/api/subscription/usage-detail` | JWT | 近6月用量历史 |
| POST | `/api/subscription/upgrade` | JWT | 升级套餐（Mock 支付）|
| POST | `/api/subscription/cancel` | JWT | 取消订阅 |
| POST | `/webhook/payment` | - | 支付回调（生产需验签）|

### OpenClaw 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/openclaw/status` | JWT | 当前模式和配置状态 |
| PUT | `/api/openclaw/config` | JWT + 付费 | 配置专属实例 |
| DELETE | `/api/openclaw/config` | JWT | 删除专属配置 |

### 其他接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/audit` | 审计日志 + 统计 |
| POST | `/api/feedback` | 提交反馈 |
| GET | `/api/feedback/mine` | 我的反馈历史 |
| POST | `/api/push/register` | 注册推送 Token |
| DELETE | `/api/push/token` | 注销推送 Token |
| GET | `/admin/config` | 管理员：查看运行时配置 |
| PUT | `/admin/config` | 管理员：热更新配置 |
| DELETE | `/admin/config` | 管理员：重置配置 |
| GET | `/health` | 健康检查 |

---

## 6. 数据库 Schema

### 核心用户表

```sql
users (
  id              UUID PK,
  display_name    VARCHAR(100),       -- 用户昵称（对人类）
  avatar_emoji    VARCHAR(10),
  avatar_url      VARCHAR(500),
  phone           VARCHAR(20) UNIQUE,
  email           VARCHAR(255) UNIQUE,
  talent          VARCHAR(50),        -- software-engineer / product-manager / student / default
  soul_prompt     TEXT,               -- 用户自定义人格 prompt
  assistant_name  VARCHAR(100),       -- AI 助手名称（对 AI）
  assistant_emoji VARCHAR(10),
  preferred_model VARCHAR(50),        -- 偏好 AI 模型
  is_searchable   BOOLEAN,            -- 是否可被搜索
  last_login      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ
)

oauth_accounts (
  user_id     UUID → users.id,
  provider    VARCHAR(20),            -- wechat / apple / google
  provider_id VARCHAR(255),
  UNIQUE(provider, provider_id)
)

refresh_tokens (
  user_id    UUID → users.id,
  token_hash VARCHAR(255),            -- bcrypt hash，不存明文
  device_tag VARCHAR(100),
  expires_at TIMESTAMPTZ
)

otp_codes (
  phone      VARCHAR(20) PK,          -- 同一手机号只有一条（upsert）
  code       VARCHAR(6),
  expires_at TIMESTAMPTZ              -- 60秒过期
)
```

### 任务与技能

```sql
tasks (
  id          UUID PK,
  user_id     UUID → users.id,
  title       VARCHAR(500),
  description TEXT,
  priority    VARCHAR(10),            -- high / med / low
  category    VARCHAR(50),
  deadline    VARCHAR(100),
  status      VARCHAR(20),            -- pending / done
  source      VARCHAR(20),            -- manual / agent / voice
  run_id      VARCHAR(50),            -- 可追溯到哪次 Agent 运行
  created_at  TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ
)

skills (
  id           UUID PK,
  user_id      UUID → users.id,
  name         VARCHAR(100),
  emoji        VARCHAR(10),
  description  TEXT,
  builtin_type VARCHAR(50),           -- ai-news / daily-brief / analyze-voice ...
  allowed_tools TEXT[],
  model_pref   VARCHAR(50),
  is_builtin   BOOLEAN
)

agent_runs (
  run_id       VARCHAR(50) UNIQUE,
  user_id      UUID → users.id,
  skill_id     UUID → skills.id,
  goal         TEXT,
  status       VARCHAR(20),           -- running / done / failed
  total_steps  INTEGER,
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
)
```

### 记忆系统

```sql
user_memories (
  user_id    UUID → users.id,
  key        VARCHAR(200),
  value      TEXT,
  updated_at TIMESTAMPTZ,
  PRIMARY KEY(user_id, key)           -- 一用户一 key 唯一
  -- 保留键（以 _ 开头）：_openclaw_url, _openclaw_token
)

episodic_memories (
  id         UUID PK,
  user_id    UUID → users.id,
  summary    TEXT,
  embedding  vector(1536),            -- pgvector 向量，OpenAI text-embedding-3-small
  run_id     VARCHAR(50),
  created_at TIMESTAMPTZ
)
-- 向量检索：<=> 余弦距离，相似度 > 0.75 时召回
```

### 社交系统

```sql
friendships (
  requester_id UUID → users.id,
  recipient_id UUID → users.id,
  status       VARCHAR(20),           -- pending / accepted / rejected / blocked
  UNIQUE(requester_id, recipient_id)
)

messages (
  from_user_id UUID → users.id,
  to_user_id   UUID → users.id,
  content      TEXT,
  sender_type  VARCHAR(20),           -- user / assistant（助手代发）
  sender_name  VARCHAR(100),          -- 助手代发时显示 "🤖 小智"
  created_at   TIMESTAMPTZ,
  read_at      TIMESTAMPTZ
)

friend_privacy (
  user_id      UUID PK → users.id,
  show_tasks   BOOLEAN DEFAULT FALSE,
  show_skills  BOOLEAN DEFAULT TRUE,
  show_activity BOOLEAN DEFAULT TRUE
)
```

### 订阅与计费

```sql
plans (
  id              VARCHAR(20) PK,    -- free / pro / enterprise
  name            VARCHAR(50),
  price_cny       DECIMAL(10,2),
  price_usd       DECIMAL(10,4),
  monthly_ai_calls INT,              -- -1 = 无限制
  max_skills      INT,
  max_memory_mb   INT,
  features        JSONB
)

user_subscriptions (
  user_id      UUID PK → users.id,  -- 每用户只有一行（UNIQUE）
  plan_id      VARCHAR(20) → plans.id,
  status       VARCHAR(20),          -- active / expired / cancelled / trial
  period_start TIMESTAMPTZ,
  period_end   TIMESTAMPTZ,
  payment_method VARCHAR(30)
)

monthly_usage (
  user_id     UUID → users.id,
  year_month  VARCHAR(7),            -- '2026-03'
  ai_calls    INT,
  input_tokens BIGINT,
  output_tokens BIGINT,
  cost_usd    DECIMAL(10,4),
  PRIMARY KEY(user_id, year_month)   -- O(1) 配额查询
)
```

### 其他

```sql
ai_audit_logs   -- 每次 AI 调用记录（model, tokens, latency, cost）
feedback        -- 用户反馈（bug/feature/general）
push_tokens     -- FCM/APNs 设备 Token
```

---

## 7. 核心数据流

### 流程一：语音指令全链路（"明天早上8点提醒我开会"）

```
[Android] SpeechRecognizer
    ↓ 识别结果（zh-CN）
[JS] onSpeechResult("明天早上8点提醒我开会")
    ↓ 用户点击分析
[Frontend] POST /api/analyze {
  text: "明天早上8点提醒我开会",
  clientSkills: [{name: "set_alarm", ...}]
}
    ↓ SSE 流建立
[Backend Layer1] 正则匹配 → intent: "client-alarm"（0.95）
    → tools: ["create_tasks"]
    → model: "deepseek-chat"
    → SSE: step "意图: client-alarm · 模型: deepseek-chat"
    ↓
[Backend Assembler] 组装系统提示词
    = Soul("小智") + Talent(default) + 现在是早上10点 + 待处理3项
    ↓
[OpenClaw] POST /v1/chat/completions (streaming)
    ← LLM 决定调用 set_alarm + create_tasks
    ↓
[Backend] tool_calls 分发
    → set_alarm → SSE: client_action {name: "set_alarm", args: {...}}
    → create_tasks → INSERT INTO tasks → SSE: task_extract {tasks: [...]}
    ↓
[Frontend] 收到 client_action → AndroidBridge.executeClientSkill("set_alarm", args)
[Android] AlarmManager.set(...)
    ↓
[Frontend] 收到 task_extract → 显示确认卡片
    ↓
[Backend] SSE: done {totalTokens: 380, latencyMs: 1850, costUsd: $0.000063}
    ↓ 异步（setImmediate）
[Backend] summarizeToEpisodic → embedding → INSERT episodic_memories
```

### 流程二：情节记忆三层运转

```
第一次交互："我喜欢喝咖啡"
  → Agent 调用 save_memory(key="饮食偏好", value="喜欢咖啡")
  → INSERT INTO user_memories
  → 对话结束后 summarizeToEpisodic() → embedding → INSERT episodic_memories

第二次交互："早上给我推荐点什么"
  → assembleSystemPrompt() 执行：
    1. 查 user_memories → "饮食偏好: 喜欢咖啡"（长期记忆，精确匹配）
    2. searchEpisodicMemory("早上推荐")
       → createEmbedding("早上推荐")
       → SELECT FROM episodic_memories ORDER BY embedding <=> $1 LIMIT 3
       → 找到"用户喜欢咖啡"记录（相似度 0.82）
  → systemPrompt 包含：长期记忆 + 相关情节摘要
  → LLM 有上下文：回复"你喜欢咖啡，推荐来杯黑咖啡"
```

### 流程三：微信登录

```
[Frontend] loginWith('wechat')
    ↓ GET /auth/wechat/url
[Backend] 生成 state（UUID），存入 WECHAT_STATES（10min TTL）
    ← { url: "https://open.weixin.qq.com/connect/oauth2/authorize?..." }
    ↓ window.location.href = url
[微信服务器] 用户授权
    ↓ 重定向到 /auth/wechat/callback?code=xxx&state=yyy
[Backend] 验证 state → 调微信 API 换 openid + 用户信息
    → 查/创建 users + oauth_accounts
    → 签发 JWT → 重定向到 /?wechat_token=JWT&wechat_refresh=REFRESH
[Frontend] initApp() 检测 URL 参数
    → 调 /auth/me 验证 token → doLogin() → 清理 URL
```

### 流程四：订阅升级 + OpenClaw 配置

```
[Frontend] POST /api/subscription/upgrade { planId: "pro" }
    ↓
[Backend] INSERT user_subscriptions → setImmediate(syncAgentConfig)
    ← {
        success: true,
        openclaw: { setupRequired: true, setupUrl: "/api/openclaw/config" }
      }
    ↓
[Frontend] 提示用户配置专属 OpenClaw
    ↓ PUT /api/openclaw/config { url: "http://my-server:18789" }
[Backend] 保存到 user_memories._openclaw_url
    → 触发 syncAgentConfig（静态人格推送到 OpenClaw）
    ↓
[后续 AI 请求] resolveUserConfig → 读取 _openclaw_url → 路由到专属实例
```

---

## 8. 环境变量参照

```bash
# ── 服务 ────────────────────────────────────
PORT=3000
HOST=0.0.0.0
NODE_ENV=development
JWT_SECRET=<长随机字符串>
JWT_EXPIRE=2h
REFRESH_EXPIRE=30d

# ── 数据库 ──────────────────────────────────
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_assistant
REDIS_URL=redis://localhost:6379

# ── OpenClaw 网关（主要 AI 路由）────────────
OPENCLAW_URL=http://localhost:18789
OPENCLAW_TOKEN=                         # 可选
OPENCLAW_DEFAULT_MODEL=deepseek-chat
OPENCLAW_EMBED_MODEL=text-embedding-3-small

# ── AI 直连降级（OPENCLAW_URL 未配置时）────
DEEPSEEK_API_KEY=sk-...
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# ── 搜索工具（可选）────────────────────────
TAVILY_API_KEY=                         # 推荐，专为 AI 设计
SERPER_API_KEY=                         # 备选，Google 结果

# ── OAuth 登录 ──────────────────────────────
WECHAT_APP_ID=wx...
WECHAT_SECRET=...
BACKEND_URL=https://your-domain.com     # 微信回调基础 URL
FRONTEND_URL=https://your-domain.com    # 登录完成后跳转地址
APPLE_TEAM_ID=
APPLE_KEY_ID=
GOOGLE_CLIENT_ID=

# ── 演示模式 ────────────────────────────────
DEMO_MODE=true                          # true 时跳过真实 SMS，允许任意 OTP
DEMO_OTP=123456
```

---

## 9. 安全与生产注意事项

### 已实现

- ✅ JWT 短期有效（2h）+ 长期 refreshToken（哈希存储，不存明文）
- ✅ OTP 60 秒过期，同手机号 upsert（无历史堆积）
- ✅ 全局限速：100 次/分钟
- ✅ SQL 参数化查询（防注入）
- ✅ Zod 工具参数校验
- ✅ 计算器表达式安全过滤（`replace(/[^0-9+\-*/().%\s]/g, '')`）
- ✅ 微信 OAuth state 校验（防 CSRF）
- ✅ API Key 管理端掩码显示
- ✅ Android JWT 存入 `SharedPreferences`（`MODE_PRIVATE`，不可备份）

### 生产部署前必须完成

| 项 | 当前状态 | 要求 |
|---|---|---|
| CORS | `origin: true` | 收窄为具体域名 |
| OTP 频率限制 | 无 | 同手机号 60 秒内最多 1 次发送 |
| OTP 错误次数 | 无 | 失败 5 次后锁定 |
| HTTPS | 未强制 | 生产必须全站 HTTPS |
| 支付 Webhook 验签 | Mock 无验签 | 接入 Stripe/微信支付时必须验证签名 |
| 微信 OAuth 域名 | 需在公众号后台配置 | 配置网页授权回调域名 |
| 敏感字段加密 | 手机号明文 | 生产建议加密存储 |
| GDPR | 无 | 需提供数据导出和删除接口 |
| 内容审核 | 无 | soul_prompt 需过滤违规内容 |
| 管理员鉴权 | 仅 JWT | 需要更严格的管理员角色控制 |

### 待实现功能（TODO）

| 功能 | 现状 | 计划 |
|---|---|---|
| 联网搜索 | 演示模式返回假数据 | 接入 Tavily / Serper |
| 真实支付 | Mock 直接激活 | Stripe / 微信支付 / 支付宝 |
| 推送通知 | Token 已注册，不真正发送 | Firebase Admin SDK |
| Apple/Google OAuth | 前端占位，无后端实现 | 完整 OAuth 流程 |
| 邮箱登录/OTP | 未实现 | 作为手机的备选 |
| 管理后台 | 仅 `/admin/config` | 用户管理、数据分析 |
| 离线同步 | 无 | 本地队列 → 联网后同步 |
