# OpenClaw 配置指南

本文档说明如何为「AI 助手」系统配置 OpenClaw 网关，涵盖两种接入场景：

- **平台运营者**：部署供免费用户共享的 OpenClaw 实例
- **付费用户**：自行部署独占 OpenClaw 实例并接入后端

---

## 目录

1. [OpenClaw 简介](#1-openclaw-简介)
2. [平台共享实例（运营者部署）](#2-平台共享实例运营者部署)
3. [付费用户独占实例](#3-付费用户独占实例)
4. [OpenClaw Agent 配置说明](#4-openclaw-agent-配置说明)
5. [环境变量参照表](#5-环境变量参照表)
6. [验证与排查](#6-验证与排查)

---

## 1. OpenClaw 简介

[OpenClaw](https://github.com/openclaw/openclaw) 是一个自托管的 AI 网关，提供：

- OpenAI 兼容的 `/v1/chat/completions` 和 `/v1/embeddings` 接口
- 多 Provider 路由（DeepSeek / OpenAI / Claude / Ollama 等）
- Agent 持久化配置（角色人格、模型偏好）
- 流式 SSE 输出 & 工具调用支持
- 多用户会话隔离（通过 `X-OpenClaw-Agent` 头 / `user` 字段）

**系统集成架构：**

```
用户 → 前端 → 后端（Node.js/Fastify）
                  ↓
            OpenClaw 网关（:18789）
                  ↓
         AI Provider（DeepSeek / OpenAI / Claude）
```

**两种接入模式（按订阅等级自动切换）：**

| 用户等级 | 模式 | OpenClaw 实例 | 隔离方式 |
|---------|------|--------------|---------|
| 免费用户 | 共享（shared） | 平台统一部署 | `agentId = aia_{userId}` |
| 付费用户 | 独占（dedicated） | 用户自部署 | 整个实例归属该用户 |

---

## 2. 平台共享实例（运营者部署）

### 2.1 安装 OpenClaw

```bash
# 方式 A：npm 全局安装
npm install -g openclaw
openclaw start --port 18789

# 方式 B：Docker
docker run -d \
  --name openclaw \
  -p 18789:18789 \
  -e OPENCLAW_AUTH_MODE=token \
  -e OPENCLAW_GLOBAL_TOKEN=your-platform-token \
  openclaw/openclaw:latest
```

> 默认监听 `http://0.0.0.0:18789`，确保防火墙允许后端服务器访问该端口。

### 2.2 配置 AI Provider Keys

在 OpenClaw 管理界面（或配置文件）中添加：

```yaml
# openclaw.config.yaml
providers:
  - name: deepseek
    type: openai_compatible
    base_url: https://api.deepseek.com/v1
    api_key: sk-your-deepseek-key
    models:
      - deepseek-chat
      - deepseek-coder

  - name: openai
    type: openai
    api_key: sk-your-openai-key
    models:
      - gpt-4o
      - gpt-4o-mini
      - text-embedding-3-small   # ← embedding 模型，情节记忆必需

  - name: anthropic
    type: anthropic
    api_key: sk-ant-your-key
    models:
      - claude-3-5-sonnet-20241022

routing:
  default_model: deepseek-chat  # 对应后端 OPENCLAW_DEFAULT_MODEL

auth:
  mode: token                   # 开启 token 认证
  tokens:
    - your-platform-token       # 对应后端 OPENCLAW_TOKEN
```

### 2.3 配置后端环境变量

编辑 `backend/.env`：

```bash
# 指向平台共享 OpenClaw 实例
OPENCLAW_URL=http://<your-server-ip>:18789
OPENCLAW_TOKEN=your-platform-token       # 与 OpenClaw auth.tokens 中一致
OPENCLAW_DEFAULT_MODEL=deepseek-chat
OPENCLAW_EMBED_MODEL=text-embedding-3-small
```

### 2.4 多用户隔离说明

免费用户共享同一 OpenClaw 实例，后端通过以下机制隔离：

```
请求头：X-OpenClaw-Agent: aia_{userId}
请求体：{ "user": "aia_{userId}" }   ← OpenAI 标准字段
```

OpenClaw 根据此字段为每个用户维护独立的会话上下文。若 OpenClaw 实例内预先通过 `PUT /api/agents/aia_{userId}` 注册了 Agent，则会应用对应的人格配置；否则使用默认人格。

---

## 3. 付费用户独占实例

### 3.1 用户自行部署 OpenClaw

付费用户需在自己的服务器上部署 OpenClaw（步骤同 §2.1），并在其中配置自己的 AI Provider Keys。

推荐最低配置：
- 1 核 CPU / 512 MB 内存（仅做网关，无状态）
- 开放 18789 端口（或自定义端口）

### 3.2 通过 API 注册到后端

部署完成后，调用后端接口注册专属实例地址：

```bash
# 1. 先登录获取 token
TOKEN=$(curl -s -X POST http://your-backend:3000/auth/otp/verify \
  -H "Content-Type: application/json" \
  -d '{"phone": "your-phone", "code": "123456"}' | jq -r .accessToken)

# 2. 注册专属 OpenClaw 实例
curl -X PUT http://your-backend:3000/api/openclaw/config \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "http://my-server:18789",
    "token": "my-openclaw-token"
  }'
```

**成功响应：**
```json
{
  "success": true,
  "message": "专属 OpenClaw 实例已配置，助手人格同步中…",
  "mode": "dedicated",
  "url": "http://my-server:18789"
}
```

> 配置成功后，后端会立即将当前助手的静态人格（名称、天赋、灵魂设定、偏好模型）同步到该 OpenClaw 实例。

### 3.3 查看接入状态

```bash
curl http://your-backend:3000/api/openclaw/status \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "mode": "dedicated",
  "dedicatedConfigured": true,
  "agentId": null,
  "isPaid": true,
  "planName": "Pro",
  "setupRequired": false
}
```

### 3.4 解除专属配置（回退共享）

```bash
curl -X DELETE http://your-backend:3000/api/openclaw/config \
  -H "Authorization: Bearer $TOKEN"
```

---

## 4. OpenClaw Agent 配置说明

### 4.1 自动同步机制

后端在以下时机自动将助手属性推送到 OpenClaw：

| 触发事件 | API | 同步内容 |
|---------|-----|---------|
| 用户更新 Profile | `PUT /auth/profile` | 名称 / 天赋 / 灵魂设定 / 偏好模型 |
| 付费用户配置专属实例 | `PUT /api/openclaw/config` | 全量同步当前配置 |

### 4.2 属性映射关系

| 后端字段 | OpenClaw Agent 字段 | 说明 |
|---------|-------------------|------|
| `assistant_name` | `agent.name` | 助手名称，如「小智」 |
| `assistant_emoji` | `agent.avatar` | 助手头像 Emoji，如「🤖」 |
| `soul_prompt` + `talent` | `agent.persona` | 静态人格（OpenClaw 持久保存） |
| `preferred_model` | `agent.model` | 偏好模型，如 `deepseek-chat` |
| `display_name` | `agent.persona`（内嵌） | 用户称谓，用于个性化回复 |

**静态 vs 动态人格：**

```
静态（存入 OpenClaw）:  灵魂设定 + 天赋 + 用户称谓 + 偏好模型
动态（每次请求注入）:  当前时间 + 未完成任务数 + 近期记忆片段
```

### 4.3 手动同步（如需）

若 Agent 配置与后端不一致，可通过更新 Profile 触发重新同步：

```bash
curl -X PUT http://your-backend:3000/auth/profile \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"assistantName": "小智"}'
```

### 4.4 OpenClaw Agent API 参考

后端向 OpenClaw 发送的同步请求格式（`PUT /api/agents/{agentId}`）：

```json
{
  "name": "小智",
  "avatar": "🤖",
  "persona": "你是小智，一个聪明、温暖的 AI 助手...\n【天赋】编程助手...",
  "model": "deepseek-chat"
}
```

> 若 OpenClaw 不支持 `/api/agents` 端点，同步会静默失败，不影响主流程。
> 每次请求时后端仍会通过 `system` 字段传入完整人格，功能不受影响。

---

## 5. 环境变量参照表

### 后端（`backend/.env`）

| 变量 | 必填 | 示例 | 说明 |
|------|------|------|------|
| `OPENCLAW_URL` | ✅ | `http://192.168.1.x:18789` | OpenClaw 实例地址（共享实例，免费用户使用） |
| `OPENCLAW_TOKEN` | ⚡ | `your-platform-token` | 认证 token（OpenClaw `auth.mode=token` 时必填） |
| `OPENCLAW_DEFAULT_MODEL` | - | `deepseek-chat` | 默认路由模型 |
| `OPENCLAW_EMBED_MODEL` | - | `text-embedding-3-small` | 情节记忆向量化模型 |

> **注意**：`OPENCLAW_MODE` 已废弃，接入模式由订阅等级自动决定，无需手动配置。

### OpenClaw 侧关键配置

| 配置项 | 说明 |
|--------|------|
| `providers[].api_key` | AI Provider Keys（DeepSeek / OpenAI 等）在 OpenClaw 侧管理，后端无需持有 |
| `routing.default_model` | 对应后端 `OPENCLAW_DEFAULT_MODEL`，需保持一致 |
| `auth.mode` | `none`（无认证）或 `token`（token 认证） |
| `auth.tokens[]` | 对应后端 `OPENCLAW_TOKEN` |

### 降级直连（`OPENCLAW_URL` 未配置时生效）

| 变量 | 说明 |
|------|------|
| `DEEPSEEK_API_KEY` | DeepSeek API Key（主要 LLM） |
| `OPENAI_API_KEY` | OpenAI Key（embedding + GPT） |
| `ANTHROPIC_API_KEY` | Claude API Key |

---

## 6. 验证与排查

### 6.1 验证 OpenClaw 正常运行

```bash
# 健康检查
curl http://<openclaw-host>:18789/health

# 测试 LLM 调用
curl http://<openclaw-host>:18789/v1/chat/completions \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

### 6.2 验证后端与 OpenClaw 连通

```bash
# 后端健康检查
curl http://localhost:3000/health

# 测试 AI 调用（需登录）
curl -X POST http://localhost:3000/api/analyze \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "帮我明天上午9点提醒开会"}' \
  --no-buffer
```

正常输出为 SSE 流，包含 `event: step`、`event: text` 等事件。

### 6.3 常见问题

**Q: 后端日志出现 `ECONNREFUSED` 连接 18789**
A: OpenClaw 未启动，或 `OPENCLAW_URL` 指向了错误地址。确认 `curl http://<openclaw-host>:18789/health` 可达。

**Q: 免费用户请求正常，付费用户报错**
A: 检查付费用户的 `_openclaw_url` 是否可从后端服务器访问；或通过 `DELETE /api/openclaw/config` 清除配置回退共享模式排查。

**Q: 助手人格没有应用（回复通用）**
A: OpenClaw 可能不支持 `/api/agents` 端点，属于预期降级行为。人格通过每次请求的 `system` 字段注入，功能正常。如需持久化，请确认所用 OpenClaw 版本支持 Agent 配置接口。

**Q: embedding 调用失败（情节记忆不工作）**
A: 确认 `OPENCLAW_EMBED_MODEL`（默认 `text-embedding-3-small`）对应的 provider 在 OpenClaw 中已配置 API Key（通常需要 OpenAI Key）。

**Q: 付费用户升级后 `setupRequired: true`**
A: 这是预期行为，提示用户尚未配置专属实例。通过 `PUT /api/openclaw/config` 注册后，`setupRequired` 变为 `false`。
