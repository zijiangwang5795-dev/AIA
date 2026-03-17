# 🤖 AI 助手 — 本地部署指南

完整的「前端 + 后端 + Android」AI 语音助手系统。

---

## 架构一览

```
📱 Android App (WebView)
   └── assets/www/index.html  ← 前端 UI
       ├── AndroidBridge       ← 原生语音识别
       └── fetch API_BASE      ← 连接后端

🖥️ 后端 (Node.js + Fastify)
   ├── 第一层大脑：意图分类 + 路由决策（确定性，~50ms）
   ├── 第二层大脑：ReAct Agent + 流式 SSE 输出（通过 OpenClaw）
   ├── 助手人格层：灵魂 + 天赋 + 运行时状态
   └── 工具：create_tasks / web_search / memory / calculator

🦞 OpenClaw 网关（服务器部署，端口 18789）
   ├── 统一承接所有 AI 推理请求（OpenAI 兼容接口）
   ├── 管理 AI Provider Keys（DeepSeek / OpenAI / Claude / Ollama）
   └── 支持流式 SSE、工具调用、会话管理

🗄️ 数据库
   ├── PostgreSQL + pgvector（任务 / 记忆 / 情节向量）
   └── Redis（短期会话记忆）
```

---

## 快速开始（方式一：Docker）

```bash
# 0. 先启动 OpenClaw（一次性，可复用）
#    参考 https://github.com/openclaw/openclaw
#    默认监听 http://localhost:18789
openclaw start

# 1. 克隆项目，进入 backend 目录
cd backend/

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env：
#   OPENCLAW_URL=http://<your-server>:18789  ← 指向 OpenClaw
#   在 OpenClaw 侧配置 DEEPSEEK_API_KEY / OPENAI_API_KEY

# 3. 启动所有服务
docker-compose up -d

# 4. 第一次运行：等待约 30s 后访问
open http://localhost:3000/health
```

---

## 快速开始（方式二：手动安装）

### 前置需求
- Node.js 18+
- PostgreSQL 14+ with pgvector 扩展
- Redis 7+

### 安装 pgvector（如果没有）
```bash
# macOS
brew install pgvector

# Ubuntu/Debian
sudo apt install postgresql-16-pgvector

# 或使用 Docker（只启动数据库）
docker run -d --name pgvec -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres \
  pgvector/pgvector:pg16
```

### 后端启动
```bash
cd backend/

# 安装依赖
npm install

# 配置环境
cp .env.example .env
vim .env   # 重点填写 OPENCLAW_URL（后端 AI 调用统一走 OpenClaw）
           # 若 OPENCLAW_URL 未填，自动降级为直连 DEEPSEEK_API_KEY

# 初始化数据库
npm run db:migrate

# 开发模式启动（热重载）
npm run dev

# 生产模式
npm start
```

后端启动后：
- API：`http://localhost:3000`
- 健康检查：`http://localhost:3000/health`

---

## 前端部署

### 方式 A：浏览器直接打开（最快）
```bash
# 打开 frontend/index.html 即可
# 默认连接 http://localhost:3000
```

### 方式 B：后端托管（推荐）
```bash
# 将前端文件放到 backend/public/ 目录
cp frontend/index.html backend/public/

# 访问 http://localhost:3000 即可看到前端
```

### 方式 C：Android 打包
```bash
# 将 frontend/index.html 放入 Android 项目
cp frontend/index.html VoiceTaskApp/app/src/main/assets/www/

# 编辑 index.html，修改 API_BASE 为你的服务器 IP
# const API_BASE = 'http://192.168.1.xxx:3000';

# 用 Android Studio 构建 APK
```

---

## OpenClaw 接入模式（按订阅自动切换）

模式由用户订阅等级自动决定，无需手动配置：

### 免费用户 → 共享 OpenClaw（注册即用）

自动接入平台统一部署的 OpenClaw 实例（`OPENCLAW_URL`），
通过 `agentId = aia_{userId}` 在实例内逻辑隔离，零配置。

### 付费用户 → 独占 OpenClaw（专属实例）

升级付费后，通过 API 注册自己的 OpenClaw 实例地址：

```bash
# 配置专属 OpenClaw 实例
curl -X PUT http://localhost:3000/api/openclaw/config \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"url": "http://my-server:18789", "token": "my-token"}'

# 查看当前接入状态
curl http://localhost:3000/api/openclaw/status \
  -H "Authorization: Bearer <token>"
```

升级时，`POST /api/subscription/upgrade` 响应中包含 `openclaw.setupRequired` 字段，
前端据此展示配置引导界面。

| 接口 | 说明 |
|------|------|
| `GET /api/openclaw/status` | 查看当前模式、是否需要配置 |
| `PUT /api/openclaw/config` | 配置专属实例地址（`{ url, token }`） |
| `DELETE /api/openclaw/config` | 解除专属配置，回退共享 |

---

## 环境变量说明

### OpenClaw 网关

| 变量 | 必填 | 说明 |
|------|------|------|
| `OPENCLAW_URL` | ✅ | 平台共享 OpenClaw 地址（免费用户使用），如 `http://192.168.1.x:18789` |
| `OPENCLAW_TOKEN` | ⚡ | 认证 token，`gateway.auth.mode` 开启时需要 |
| `OPENCLAW_DEFAULT_MODEL` | - | 默认路由模型，默认 `deepseek-chat` |
| `OPENCLAW_EMBED_MODEL` | - | 向量化模型，默认 `text-embedding-3-small` |

> 模式（shared/dedicated）由用户订阅等级自动决定，不再需要 `OPENCLAW_MODE`。

> AI Provider Keys（DeepSeek / OpenAI / Claude）在 **OpenClaw 侧**配置，后端无需持有。

### 降级直连（OPENCLAW_URL 未配置时生效）

| 变量 | 必填 | 说明 |
|------|------|------|
| `DEEPSEEK_API_KEY` | ✅* | DeepSeek API Key |
| `OPENAI_API_KEY` | ⚡ | OpenAI Key（embedding + gpt-4o-mini） |
| `ANTHROPIC_API_KEY` | ⚡ | Claude API Key |
| `TAVILY_API_KEY` | ⚡ | 搜索 API（可选） |

### 基础配置

| 变量 | 必填 | 说明 |
|------|------|------|
| `DATABASE_URL` | ✅ | PostgreSQL 连接串 |
| `REDIS_URL` | ✅ | Redis 连接串 |
| `JWT_SECRET` | ✅ | JWT 签名密钥（生产环境必须改） |
| `DEMO_MODE` | - | `true` = 自动 demo 登录，OTP 固定为 123456 |

---

## API 文档

### 认证
```
POST /auth/otp/send      { phone }              → { success, expiresIn }
POST /auth/otp/verify    { phone, code }         → { accessToken, user }
POST /auth/demo-login    {}                      → { accessToken, user }
GET  /auth/me            [需要 Bearer Token]     → UserProfile
```

### 核心功能（SSE 流式）
```
POST /api/analyze        { text }               → SSE Stream
POST /api/skills/:id/run { input? }             → SSE Stream
```

### 任务
```
GET    /api/tasks        ?status=pending|done|all
POST   /api/tasks        [{ title, priority, category, deadline }]
PATCH  /api/tasks/:id    { status?, title?, priority? }
DELETE /api/tasks/:id
```

### 记忆
```
GET    /api/memory/long
POST   /api/memory/long  { key, value }
DELETE /api/memory/long/:key
GET    /api/memory/episodic
```

### 审计
```
GET    /api/audit        ?limit=20
```

---

## SSE 事件格式

```javascript
// 分析时，前端监听这些事件：
event: step        → { step, label }           // 进度更新
event: text        → { chunk }                 // 流式文字（实时）
event: tool_start  → { name, args }            // 工具调用开始
event: tool_done   → { name, result }          // 工具完成
event: task_extract→ { tasks[], summary }      // 提取到任务
event: error       → { message }               // 错误
event: done        → { totalTokens, latencyMs, costUsd, model, gateway }
```

---

## 局域网 Android 访问

手机和电脑在同一 WiFi 下：

1. 查看电脑 IP：
   ```bash
   # macOS
   ipconfig getifaddr en0
   # Linux
   ip addr show | grep inet
   ```

2. 修改前端的 `API_BASE`：
   ```javascript
   // 在 index.html 第一行 <script> 中添加：
   window.API_BASE = 'http://192.168.1.xxx:3000';
   ```

3. 将修改后的 `index.html` 打包进 Android APK。

---

## 扩展搜索能力

默认搜索演示模式，配置任一即可启用真实搜索：

```bash
# Tavily（推荐，专为 AI Agent 设计）
# https://app.tavily.com → 免费 1000 次/月
TAVILY_API_KEY=tvly-xxxxx

# 或 Serper（Google 搜索结果）
# https://serper.dev → 免费 2500 次
SERPER_API_KEY=xxxxx
```

---

## 项目结构

```
ai-assistant/
├── frontend/
│   └── index.html          # 完整前端（HTML+CSS+JS）
│
├── backend/
│   ├── src/
│   │   ├── index.js         # Fastify 入口
│   │   ├── routes/          # API 路由
│   │   ├── personality/     # 人格层（Soul/Talent/Runtime）
│   │   ├── brain/
│   │   │   ├── layer1/      # 确定性引擎
│   │   │   ├── layer2/      # ReAct Agent（调用 OpenClaw）
│   │   │   └── openclaw/    # OpenClaw 网关客户端
│   │   ├── tools/           # 工具注册表
│   │   ├── memory/          # 记忆系统（暂用 PostgreSQL）
│   │   ├── auth/            # JWT + OTP
│   │   └── db/              # 数据库客户端 + 迁移
│   ├── .env.example
│   ├── docker-compose.yml
│   └── Dockerfile
│
└── README.md
```
