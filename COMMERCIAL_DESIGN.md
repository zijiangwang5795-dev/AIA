# AI 助手 商业化设计文档

> 版本：1.0 · 日期：2026-03-12

---

## 目录

1. [商业模式](#1-商业模式)
2. [订阅计划设计](#2-订阅计划设计)
3. [配额与计费系统](#3-配额与计费系统)
4. [支付集成](#4-支付集成)
5. [推送通知系统](#5-推送通知系统)
6. [用户反馈系统](#6-用户反馈系统)
7. [数据分析与指标](#7-数据分析与指标)
8. [用户增长策略](#8-用户增长策略)
9. [合规与隐私](#9-合规与隐私)
10. [运营与客服](#10-运营与客服)
11. [安全加固](#11-安全加固)
12. [基础设施与扩容](#12-基础设施与扩容)
13. [路线图](#13-路线图)
14. [关键 API 速查](#14-关键-api-速查)

---

## 1 商业模式

### 核心策略：免费增值（Freemium）

用免费计划获取用户，通过价值感知驱动付费转化。AI 调用次数是天然的付费门槛——免费用户体验 AI 能力后，一旦达到上限就有强烈升级动力。

```
免费用户 ──体验价值──► 触达限额 ──升级提示──► 付费用户
   │                                              │
   └──── 邀请好友 ──────────────────────────────►┘
         (奖励额度)
```

### 收入来源

| 来源 | 模式 | 占比预期 |
|------|------|---------|
| Pro 订阅 | ¥68/月 或 ¥588/年 | 70% |
| Enterprise 订阅 | ¥688/月，按需谈 | 20% |
| 技能市场抽成 | 创作者收益 30% 平台分成 | 8% |
| API 开发者计划 | 按 token 计费 | 2% |

### 单位经济（Unit Economics）目标

| 指标 | 目标值 |
|------|--------|
| 免费→付费转化率 | ≥ 5% |
| Pro 月流失率 | ≤ 3% |
| LTV（Pro 用户终身价值） | ≥ ¥1,200 |
| CAC（获客成本） | ≤ ¥60 |
| LTV/CAC | ≥ 20 |

---

## 2 订阅计划设计

### 计划对比

| 功能 | 免费版 | 专业版 ¥68/月 | 企业版 ¥688/月 |
|------|:------:|:-------------:|:--------------:|
| AI 调用次数/月 | 100 次 | 2,000 次 | 无限 |
| 自定义技能数 | 5 个 | 20 个 | 无限 |
| 记忆存储 | 50 MB | 500 MB | 5 GB |
| 语音交互 | ✓ | ✓ | ✓ |
| 好友系统 | ✓ | ✓ | ✓ |
| 自定义灵魂人格 | ✗ | ✓ | ✓ |
| 优先客服支持 | ✗ | ✗ | ✓ |
| API 开发者接口 | ✗ | ✗ | ✓ |
| 团队协作（规划中） | ✗ | ✗ | ✓ |

### 年付优惠

```
月付：¥68/月
年付：¥588/年（等效 ¥49/月，节省 28%）
```

### 试用策略

- 新用户注册后 **14 天 Pro 试用**（无需绑卡）
- 试用到期前 3 天、1 天发送提醒推送
- 试用结束自动降为免费计划

### 数据库模型

```sql
-- plans：计划定义（静态配置）
-- user_subscriptions：用户当前订阅（UNIQUE user_id 保证单条活跃记录）
-- monthly_usage：月度用量快照，O(1) 配额查询
```

---

## 3 配额与计费系统

### 配额执行流程

```
用户发起 AI 请求
      │
      ▼ checkQuota() middleware
查询 user_subscriptions + monthly_usage
      │
      ├─ 超限 → HTTP 429 { error: "quota_exceeded", upgrade_url: "/subscription" }
      │          前端弹出升级对话框
      │
      └─ 正常 → 放行请求
              │
              ▼ AI 执行完成
              incrementUsage()  -- 异步，不阻塞响应
              ─► monthly_usage UPSERT +1
```

### 配额重置

- 每自然月 1 日零时（用户注册月份起算）
- `year_month` 字段格式 `'2026-03'` 实现自动分区

### 超限体验设计

```
当 AI 调用返回 429 时：
1. toast 提示（红色）："本月 AI 调用已达上限（100/100 次）"
2. 500ms 后弹出原生 confirm 对话框
3. 确认 → 跳转「我的订阅」页，展示计划对比卡片
4. 取消 → 关闭，用量进度条变红色警示
```

### 前端配额进度展示

「我的订阅」页顶部渐变进度条：
- 0–60%：绿→蓝渐变，提示"剩余用量充足"
- 60–90%：橙色警告，显示使用百分比
- 90–100%：红色预警，提示"建议升级计划"

---

## 4 支付集成

### 支付渠道规划

| 渠道 | 适用场景 | 优先级 |
|------|---------|--------|
| 微信支付 | 国内主要渠道 | P0 |
| 支付宝 | 国内备选渠道 | P0 |
| Stripe | 海外用户 / App Store | P1 |
| Apple IAP | iOS 应用内购买（App Store 要求） | P1 |
| Google Play Billing | Android 应用内购买 | P2 |

### 支付流程（以微信支付为例）

```
前端点击「升级」
      │
      ▼ POST /api/subscription/upgrade { planId, paymentMethod: "wechat" }
后端创建预支付订单 → 微信支付 API
      │
      ▼ 返回 { payUrl, orderId }
前端唤起微信支付 SDK / 跳转收银台
      │
      ▼ 支付成功
微信推送 Webhook → POST /api/webhook/payment
后端验签 → 激活订阅 → 推送"支付成功"通知
```

### Webhook 安全

```javascript
// 生产环境必须验证签名
app.post('/webhook/payment', {
  config: { rawBody: true }  // 保留原始 body 用于签名验证
}, async (req) => {
  const sig = req.headers['wechatpay-signature'];
  verifyWechatSignature(req.rawBody, sig);  // 验证不通过则 400
  // ...
});
```

### 退款政策建议

- 年付 30 天内可申请按月退款
- 月付不退款（按周期结算）
- 试用期不扣款，到期不续费自动降级

---

## 5 推送通知系统

### 架构

```
后端定时任务 / 事件触发
      │
      ▼ POST /api/push/send { targetUserId, title, body, data }
查询 push_tokens 表（用户所有设备）
      │
      ├─ Android → Firebase Admin SDK → FCM → 设备
      └─ iOS     → APNs → 设备
```

### Android FCM 实现

**Token 生命周期：**
```
应用安装/Token刷新 → FCMService.onNewToken()
      ├── PrefHelper.saveFcmToken(token)
      └── registerTokenToBackend(token)  ← 携带 JWT 上报后端

用户登录成功 → AndroidBridge.saveToken(jwt)
      └── FCMService.registerAfterLogin()  ← 确保登录前的 token 也被注册

应用卸载/退出登录 → DELETE /api/push/token
```

**消息类型与导航：**

| 消息类型 `type` | 触发场景 | `nav_target` |
|----------------|---------|-------------|
| `task_reminder` | 任务截止提醒 | `tasks` |
| `friend_msg` | 好友发送消息 | `friends` |
| `quota_warning` | 用量达到 80% | `subscription` |
| `subscription_expiry` | 订阅即将到期（提前 3 天） | `subscription` |
| `system` | 系统公告 | `home` |

### 推送频率限制

| 类型 | 频率上限 |
|------|---------|
| 任务提醒 | 每任务最多 3 次（创建时、临期 1 天、临期 1 小时） |
| 好友消息 | App 后台时实时，前台时静默 |
| 营销推送 | ≤ 1 次/周，用户可关闭 |
| 系统公告 | ≤ 1 次/月 |

---

## 6 用户反馈系统

### 反馈类型

| 类型 | 标识 | 说明 |
|------|------|------|
| 一般反馈 | `general` | 使用体验、建议 |
| 问题报告 | `bug` | 功能异常，需复现路径 |
| 功能建议 | `feature` | 希望新增的能力 |

### 反馈处理 SLA

| 优先级 | 触发条件 | 响应时限 |
|--------|---------|---------|
| P0 | 核心功能崩溃 / 数据丢失 | 4 小时内 |
| P1 | 付费用户反馈 | 24 小时内 |
| P2 | 免费用户 bug | 72 小时内 |
| P3 | 功能建议 | 下一迭代评审 |

### 反馈状态流转

```
open → processing → resolved
          │
          └──► wont_fix / duplicate
```

### 后续规划：内嵌帮助中心

- FAQ 静态页（常见问题）
- 视频教程链接
- 在线客服接入（Intercom / 美洽）

---

## 7 数据分析与指标

### 核心业务指标（North Star）

| 指标 | 定义 | 目标 |
|------|------|------|
| **MAU** | 月活跃用户（至少 1 次 AI 调用） | 增长 >15%/月 |
| **付费转化率** | 付费用户 / 注册用户 | ≥ 5% |
| **月续订率** | 续费用户 / 上月付费用户 | ≥ 97% |
| **AI 调用次数/DAU** | 用户粘性 | ≥ 3 次/天 |

### 现有数据基础

- `ai_audit_logs`：每次 AI 调用的模型、token 数、耗时、费用
- `monthly_usage`：月度汇总，支持用量趋势分析
- `agent_runs`：技能执行历史，支持功能热图

### 待实现：事件追踪

推荐在前端发送埋点事件（可复用现有 `/api/feedback` 接口扩展，或接入第三方）：

```javascript
// 关键事件埋点示例
trackEvent('subscription_page_view')
trackEvent('upgrade_click', { from_plan: 'free', to_plan: 'pro' })
trackEvent('quota_exceeded', { used: 100, limit: 100 })
trackEvent('feature_used', { feature: 'voice', session_id })
```

### 推荐分析工具

| 工具 | 用途 | 定价 |
|------|------|------|
| PostHog（自部署） | 行为分析、漏斗、会话录制 | 免费 |
| Grafana + TimescaleDB | 业务指标仪表板 | 免费 |
| Sentry | 错误监控 + 性能追踪 | 免费起 |
| Firebase Analytics | Android 端行为分析 | 免费 |

---

## 8 用户增长策略

### 邀请裂变（规划中）

```
用户 A 生成专属邀请码
      │
      ▼ 好友 B 注册时填入邀请码
B 完成首次 AI 调用
      │
      ├── A 获得：+50 次额外 AI 调用（当月）
      └── B 获得：Pro 计划 7 天试用
```

**数据库扩展（规划）：**
```sql
ALTER TABLE users ADD COLUMN referral_code VARCHAR(10) UNIQUE;
ALTER TABLE users ADD COLUMN referred_by UUID REFERENCES users(id);
CREATE TABLE referral_rewards (
  id UUID PRIMARY KEY,
  referrer_id UUID, referred_id UUID,
  reward_calls INT, granted_at TIMESTAMPTZ
);
```

### 内容营销

- 技能市场的优质技能可被用户「分享」，带来自然流量
- 好友动态 Feed 形成社交传播节点
- AI 生成的日报/周报支持一键分享图片（规划）

### 应用商店优化（ASO）

| 要素 | 建议 |
|------|------|
| 标题 | "AI 助手 — 智能语音助理" |
| 关键词 | AI助手、语音识别、任务管理、智能日历 |
| 截图 | 语音交互、任务自动生成、好友系统、小组件 |
| 评分引导 | 首次成功执行任务后 5 天弹出评分请求 |

---

## 9 合规与隐私

### 数据分类与保护

| 数据类型 | 存储位置 | 保护措施 |
|---------|---------|---------|
| 手机号 | PostgreSQL | 仅用于 OTP，不对外展示 |
| JWT Token | SharedPreferences (Android) | MODE_PRIVATE，不备份 |
| AI 对话内容 | 不持久化（仅 episodic 摘要） | 向量化存储，不含原文 |
| 支付信息 | 第三方支付平台 | 后端不存储卡号 |
| FCM Token | PostgreSQL | 与 user_id 绑定，登出时删除 |

### 必要法律文件

| 文件 | 要点 |
|------|------|
| **隐私政策** | 收集的数据类型；第三方 SDK（Firebase）数据共享；数据删除请求流程 |
| **用户协议** | 禁止滥用 AI；内容所有权；账号终止条款 |
| **未成年人条款** | 明确 16 岁以上使用；家长监督条款 |

### GDPR / 个人信息保护法合规

- 提供数据导出接口（`GET /api/account/export`，规划）
- 提供账号注销 + 数据删除接口（`DELETE /api/account`，规划）
- 隐私政策变更需用户主动确认

### App Store / Google Play 合规

- **Apple**：需填写 App Privacy 隐私清单，声明 FCM、麦克风权限用途
- **Google**：需填写 Data Safety，声明收集手机号用于账号注册
- **国内安卓**：需申请工信部 APP 备案（ICP 备案）；隐私政策弹窗需首次启动显示

---

## 10 运营与客服

### 客服渠道优先级

```
1. 应用内反馈（feedback 表）— 异步，适合非紧急问题
2. 企业版专属微信群 — 实时，适合高价值用户
3. 邮件支持（support@domain.com）— 7×24h 响应
4. 公告推送 — 系统维护、版本更新通知
```

### 内容审核

AI 系统提示（Soul Prompt）由用户自定义，需要：
- 过滤 XSS/Injection 特殊字符（已在后端做长度限制）
- 关键词黑名单过滤（违法有害内容）
- 异常内容举报接口（规划）

### 运营后台（规划）

管理员需要的核心功能：
- 用户管理（封号、手动调整配额）
- 反馈工单处理（状态流转、回复）
- 订阅管理（手动延期、退款操作）
- 数据看板（DAU/MAU、收入、错误率）

---

## 11 安全加固

### 当前已实现

| 措施 | 实现 |
|------|------|
| JWT 短期令牌 | 2h 过期，Refresh Token 30d |
| OTP 验证 | 60s 过期，防暴力枚举 |
| 全局速率限制 | 100 req/min（@fastify/rate-limit） |
| 配额限制 | 月度 AI 调用上限，防刷量 |
| SharedPreferences 隔离 | Android JWT 不进入 WebView Cookie |

### 生产环境必须加固

| 措施 | 说明 |
|------|------|
| **HTTPS Only** | 关闭 `usesCleartextTraffic`，后端强制 HTTPS |
| **CORS 白名单** | 将 `origin: true` 改为具体域名 |
| **OTP 发送频率限制** | 同一手机号 60 秒内只能发一次（需 Redis 计数） |
| **OTP 错误次数限制** | 连续错误 5 次锁定 10 分钟 |
| **Webhook 签名验证** | 微信支付/支付宝 回调必须验证签名 |
| **SQL 注入防护** | 已全部使用参数化查询（`$1, $2`） |
| **内容长度限制** | 已限制（feedback 2000 字，message 2000 字） |
| **敏感字段加密** | 手机号建议加密存储（AES-256） |

### 安全监控建议

- 接入 Sentry 实时捕获异常和 5xx 错误
- 设置告警：OTP 错误率 > 5%/分钟（可能遭受枚举攻击）
- 设置告警：单用户 AI 调用 > 配额 2 倍（配额绕过尝试）

---

## 12 基础设施与扩容

### 当前架构（单机）

```
用户 → Nginx (TLS) → Node.js/Fastify → PostgreSQL + pgvector
                    → 静态文件 CDN（前端 HTML）
```

### 扩容路径

**阶段一（0–1 万 MAU）：当前架构 + 优化**
- 添加 Redis 缓存（OTP、配额计数、会话）
- Nginx 反向代理 + Gzip 压缩
- PostgreSQL 连接池（pg-pool，max: 20）
- 前端 HTML CDN 分发（OSS + CDN）

**阶段二（1–10 万 MAU）：读写分离**
```
写操作 → 主库 (PostgreSQL Primary)
读操作 → 从库 (PostgreSQL Replica × 2)
AI 请求 → 任务队列 (Bull + Redis) → Worker 进程池
```

**阶段三（10 万+ MAU）：微服务拆分**
```
API Gateway → auth-service
            → ai-service (AI 调用，独立扩缩容)
            → social-service (好友/消息)
            → billing-service (订阅/支付)
```

### 成本估算（阿里云，阶段一）

| 资源 | 规格 | 月费 |
|------|------|------|
| ECS（后端） | 2核4G | ¥150 |
| RDS PostgreSQL | 2核4G，100GB | ¥400 |
| Redis | 1G | ¥60 |
| CDN | 50GB 流量 | ¥20 |
| 短信 OTP | 1000条 | ¥40 |
| **合计** | | **~¥670/月** |

---

## 13 路线图

### Q2 2026（P0 — 商业化基础）

- [x] 订阅计划 + 月度配额
- [x] 支付 Webhook 接口（Mock）
- [x] FCM 推送通知
- [x] 用户反馈系统
- [ ] 接入真实支付（微信 + 支付宝）
- [ ] 年付优惠
- [ ] 14 天 Pro 试用

### Q3 2026（P1 — 增长）

- [ ] 邀请裂变系统
- [ ] 技能市场付费 + 创作者分成
- [ ] 用户数据导出（GDPR）
- [ ] 账号注销功能
- [ ] 运营后台（管理员面板）
- [ ] iOS App（Swift WebView + APNs）

### Q4 2026（P2 — 企业化）

- [ ] 团队协作（多成员共享账号）
- [ ] 企业 SSO（SAML/OIDC）
- [ ] API 开发者控制台 + SDK
- [ ] SLA 服务协议 + 专属支持

---

## 14 关键 API 速查

### 订阅相关

```
GET  /api/plans                    获取所有可用计划
GET  /api/subscription             当前用户订阅 + 本月用量
GET  /api/subscription/usage-detail 近 6 个月用量历史
POST /api/subscription/upgrade     升级计划 { planId }
POST /api/subscription/cancel      取消订阅
POST /api/webhook/payment          支付回调（第三方调用）
```

### 推送通知

```
POST   /api/push/register          注册 FCM Token { token, platform, deviceTag }
DELETE /api/push/token             注销 Token { token }
POST   /api/push/send              发送推送 { targetUserId, title, body, data }
```

### 用户反馈

```
POST /api/feedback                 提交反馈 { type, content, contactInfo }
GET  /api/feedback/mine            查看自己的反馈历史
```

### 配额中间件行为

```
正常：放行请求，req.userPlan / req.monthlyUsed 可用
超限：HTTP 429 {
  error: "quota_exceeded",
  message: "本月 AI 调用次数已达上限（100 次）",
  plan: "free", used: 100, limit: 100,
  upgrade_url: "/subscription"
}
```
