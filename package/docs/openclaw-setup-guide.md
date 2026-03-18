# OpenClaw 配置指南

本文档说明如何为「AI 助手」系统配置 OpenClaw 网关，涵盖两种接入场景：

- **平台运营者**：部署供免费用户共享的 OpenClaw 实例
- **付费用户**：自行部署独占 OpenClaw 实例并接入后端

---

## 目录

1. [OpenClaw 简介](#1-openclaw-简介)
2. [平台共享实例（运营者部署）](#2-平台共享实例运营者部署)
   - 2.1 安装 OpenClaw
   - 2.2 **云服务器生产部署**（开机自启 + 公网访问 + 防火墙）
   - 2.3 配置 AI Provider Keys
   - 2.4 配置后端环境变量
   - 2.5 多用户隔离说明
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

**系统要求：** Node.js ≥ 22（推荐 Node 24）

```bash
# 方式 A：npm 全局安装（推荐）
npm install -g openclaw@latest

# 初始化向导（引导配置网关、Provider Keys、认证）
openclaw onboard

# 安装为系统后台服务（systemd / launchd），开机自启
openclaw onboard --install-daemon

# 手动启动网关（指定端口）
openclaw gateway --port 18789
```

```bash
# 方式 B：Docker
docker run -d \
  --name openclaw \
  -p 18789:18789 \
  -e OPENCLAW_AUTH_MODE=token \
  -e OPENCLAW_GLOBAL_TOKEN=your-platform-token \
  openclaw/openclaw:latest
```

> 默认监听 `http://0.0.0.0:18789`，确保防火墙允许后端服务器访问该端口。
>
> 安装后运行 `openclaw dashboard` 或打开 `http://127.0.0.1:18789/` 可验证网关正常启动。

### 2.2 云服务器生产部署

本节说明如何在云服务器（Ubuntu/Debian VPS）上让 OpenClaw **开机自启、保持运行，并通过 Nginx + HTTPS 安全暴露到公网**。

> **安全原则：永远不要直接对公网开放 18789 端口。** 安全研究发现超过 13.5 万个 OpenClaw 实例以默认配置暴露在公网，其中 1.5 万个存在 RCE 漏洞。正确做法是将 Nginx 作为唯一的公网入口。

---

#### 2.2.1 开机自启：systemd 服务

**方式 A：使用内置命令（推荐）**

```bash
# OpenClaw 自动生成并安装 systemd 用户服务
openclaw gateway install

# 启动服务
systemctl --user start openclaw-gateway.service

# 开机自启（用户登录后）
systemctl --user enable openclaw-gateway.service

# 让服务在用户未登录时也能运行（云服务器无人值守必需）
sudo loginctl enable-linger $USER

# 查看服务状态
systemctl --user status openclaw-gateway.service
```

服务单元文件位置：`~/.config/systemd/user/openclaw-gateway.service`

**方式 B：手动创建 system 级服务（root 部署）**

适合用独立 `openclaw` 系统账户运行，权限隔离更彻底：

```bash
# 创建专用系统账户（无登录 shell）
sudo useradd -r -m -s /bin/false openclaw

# 创建 systemd 服务文件
sudo tee /etc/systemd/system/openclaw.service > /dev/null <<'EOF'
[Unit]
Description=OpenClaw AI Gateway
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=simple
User=openclaw
WorkingDirectory=/home/openclaw
ExecStart=/usr/bin/openclaw gateway --port 18789
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
# 安全加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/home/openclaw/.openclaw

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable openclaw
sudo systemctl start openclaw

# 查看日志
sudo journalctl -u openclaw -f
```

> `~/.openclaw` 是 OpenClaw 的工作目录，存储 Agent 记忆、Skills、配置。**丢失此目录等于 Agent 失忆**，建议纳入备份策略。

---

#### 2.2.2 防火墙配置（UFW）

**核心原则：18789 端口只对内网开放，公网流量只走 443（HTTPS）。**

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing

# 允许 SSH、HTTP、HTTPS
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# 18789 仅允许本机（Nginx 反代）和后端服务器访问
# 若后端与 OpenClaw 在同一台服务器：
#   18789 绑定到 127.0.0.1，无需开放
# 若后端在其他服务器（内网 IP 192.168.x.x）：
sudo ufw allow from 192.168.x.x to any port 18789

# 绝对不要这样做：
# sudo ufw allow 18789   ← 直接暴露到公网

sudo ufw enable
sudo ufw status
```

---

#### 2.2.3 Nginx 反向代理 + HTTPS（Let's Encrypt）

**为什么要用 Nginx：**
- 统一 TLS 终止，证书集中管理
- 隐藏内部端口，仅 443 对外
- 支持 WebSocket（OpenClaw SSE / 实时通信必需）
- 可添加访问控制、速率限制

**安装依赖：**

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

**Nginx 配置文件** `/etc/nginx/sites-available/openclaw`：

```nginx
# 先用 HTTP 配置，certbot 会自动升级为 HTTPS
server {
    listen 80;
    server_name ai.your-domain.com;   # ← 替换为你的域名

    # Let's Encrypt 验证目录（certbot 使用）
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # 其他流量重定向到 HTTPS
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name ai.your-domain.com;   # ← 替换为你的域名

    # SSL 证书（certbot 自动填写）
    ssl_certificate     /etc/letsencrypt/live/ai.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ai.your-domain.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # 反代到本地 OpenClaw
    location / {
        proxy_pass         http://127.0.0.1:18789;
        proxy_http_version 1.1;

        # WebSocket 支持（SSE / 实时推送必需）
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";

        # 传递真实客户端 IP（对应 OpenClaw trustedProxies 配置）
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # SSE 流式输出：关闭缓冲
        proxy_buffering    off;
        proxy_cache        off;
        proxy_read_timeout 600s;
    }
}
```

**启用配置并申请证书：**

```bash
# 检查配置语法
sudo nginx -t

# 启用站点
sudo ln -s /etc/nginx/sites-available/openclaw /etc/nginx/sites-enabled/

# 申请 Let's Encrypt 证书（certbot 自动修改 Nginx 配置）
sudo certbot --nginx -d ai.your-domain.com

# 重启 Nginx
sudo systemctl reload nginx

# 证书自动续期（certbot 已安装定时任务，验证一下）
sudo certbot renew --dry-run
```

**配置 OpenClaw 信任代理 IP：**

OpenClaw 需要知道 Nginx 是可信代理，否则会把来自 127.0.0.1 的请求按"本机请求"处理，导致认证绕过风险：

```yaml
# openclaw.config.yaml
gateway:
  trustedProxies:
    - 127.0.0.1       # 同机 Nginx
    - 192.168.x.x     # 内网反代（如有）
```

**访问地址（配置完成后）：**

| 场景 | 地址 |
|------|------|
| 公网访问（用户/后端） | `https://ai.your-domain.com` |
| 内网直连（同机后端） | `http://127.0.0.1:18789` |
| 本机调试 Dashboard | `http://127.0.0.1:18789/` |

---

#### 2.2.4 OpenClaw 绑定地址说明

当 OpenClaw 在 Nginx 背后运行时，**将其绑定到 loopback 而非 0.0.0.0**：

```bash
# 仅监听本机，Nginx 负责对外
openclaw gateway --port 18789 --host 127.0.0.1

# 或在配置文件中
# openclaw.config.yaml
gateway:
  host: 127.0.0.1
  port: 18789
```

若后端与 OpenClaw 不在同一台服务器，则需要绑定内网 IP（而不是公网 IP），再通过内网路由访问。

---

### 2.3 配置 AI Provider Keys

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

### 2.4 配置后端环境变量

编辑 `backend/.env`：

```bash
# 指向平台共享 OpenClaw 实例
OPENCLAW_URL=http://<your-server-ip>:18789
OPENCLAW_TOKEN=your-platform-token       # 与 OpenClaw auth.tokens 中一致
OPENCLAW_DEFAULT_MODEL=deepseek-chat
OPENCLAW_EMBED_MODEL=text-embedding-3-small
```

### 2.5 多用户隔离说明

免费用户共享同一 OpenClaw 实例。OpenClaw 提供两层隔离机制：

#### 层一：Agent ID 隔离（默认，共享实例适用）

后端在每次请求中携带用户标识，OpenClaw 以此为每个用户维护独立的会话上下文和人格配置：

```http
# 请求头方式（首选）
X-OpenClaw-Agent: aia_{userId}

# 请求体方式（OpenAI 标准字段，兼容性更好）
{ "user": "aia_{userId}" }
```

若 OpenClaw 实例内预先通过 `PUT /api/agents/aia_{userId}` 注册了 Agent，则会应用对应的人格配置；否则使用默认人格。

**用户数据的隔离边界：**

| 隔离内容 | 是否隔离 | 说明 |
|---------|---------|------|
| 会话上下文 | ✅ | 每个 agentId 独立维护 |
| 人格配置 | ✅ | 每个 agentId 独立配置 |
| Provider Keys | ❌ | 全实例共享（由运营者管理） |
| 速率限制 | 需手动配置 | 可在 OpenClaw 或 Nginx 层限制 |

> Agent ID 隔离**不是安全隔离**——共享同一实例的用户本质上共享相同的工具调用权限。对于需要强安全隔离的场景，应使用独占实例（§3）。

#### 层二：独占实例隔离（付费用户）

付费用户拥有独立的 OpenClaw 实例，从网络层彻底隔离：
- 独立的 Provider Keys（用户自持）
- 独立的端口或域名
- 实例内只有一个用户

详见 §3。

#### Nginx 层速率限制（防滥用）

在共享实例场景下，建议在 Nginx 层对每个用户限速：

```nginx
# /etc/nginx/nginx.conf - http 块内添加
limit_req_zone $http_x_openclaw_agent zone=per_agent:10m rate=10r/s;

# /etc/nginx/sites-available/openclaw - server 块内
location /v1/ {
    limit_req zone=per_agent burst=20 nodelay;
    proxy_pass http://127.0.0.1:18789;
    # ... 其他 proxy 配置
}
```

---

## 3. 付费用户独占实例

### 3.1 用户自行部署 OpenClaw

付费用户需在自己的服务器上部署 OpenClaw（安装步骤同 §2.1），并在其中配置**自己的** AI Provider Keys。

**推荐最低配置：**
- 1 核 CPU / 512 MB 内存（仅做网关转发，无状态）
- Node.js ≥ 22
- 开放 443 端口（通过 Nginx 反代，参考 §2.2.3）

**快速部署命令：**

```bash
# 安装 OpenClaw
npm install -g openclaw@latest

# 向导式配置（含 Provider Keys、认证 token、端口）
openclaw onboard

# 安装为 systemd 后台服务
openclaw onboard --install-daemon
# 或：openclaw gateway install && systemctl --user enable openclaw-gateway.service

# 若需公网访问，按 §2.2.3 配置 Nginx + HTTPS
# 向后端注册时填写 https://your-domain.com（而非 http://ip:18789）
```

**后端访问独占实例的地址格式：**

| 部署方式 | 填入后端的 `url` 字段 |
|---------|---------------------|
| 有域名 + Nginx | `https://ai.your-domain.com` |
| 无域名，后端同内网 | `http://192.168.x.x:18789` |
| 本机测试 | `http://127.0.0.1:18789` |

> 若填写公网 IP 直连（`http://公网IP:18789`），请确保 OpenClaw 已配置 token 认证，否则任何人均可调用你的 AI Provider Keys，产生费用。

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
# 查看网关状态（CLI）
openclaw gateway status

# 诊断配置问题（检查 Provider Keys、认证、端口冲突等）
openclaw doctor

# 打开 Web 控制台（浏览器）
openclaw dashboard
# 或直接访问 http://127.0.0.1:18789/

# HTTP 健康检查
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

**Q: 服务器重启后 OpenClaw 没有自动启动**
A: 检查服务是否正确启用：
```bash
# 用户级服务
systemctl --user is-enabled openclaw-gateway.service
# 若输出 disabled，执行：
systemctl --user enable openclaw-gateway.service
sudo loginctl enable-linger $USER   # 无人登录时也能运行

# system 级服务
sudo systemctl is-enabled openclaw
```

**Q: 公网访问报 502 Bad Gateway**
A: Nginx 无法连接到 OpenClaw，排查步骤：
```bash
# 1. 确认 OpenClaw 正在运行
systemctl --user status openclaw-gateway.service

# 2. 确认端口正在监听
ss -tlnp | grep 18789

# 3. 本机直连测试
curl http://127.0.0.1:18789/health

# 4. 查看 Nginx 错误日志
sudo tail -f /var/log/nginx/error.log
```

**Q: HTTPS 证书申请失败**
A: 确认域名 DNS 已解析到服务器 IP，且 80 端口可访问（certbot HTTP-01 验证需要）：
```bash
# 检查 80 端口是否被占用或防火墙拦截
sudo ufw status
curl http://ai.your-domain.com/.well-known/acme-challenge/test
```

**Q: SSE 流式输出中断或 Nginx 返回超时**
A: 在 Nginx 配置中确认以下设置：
```nginx
proxy_buffering    off;
proxy_cache        off;
proxy_read_timeout 600s;  # 默认 60s 对长对话不够
```
