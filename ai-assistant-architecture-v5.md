# 🤖 AI 助手 — 完整系统架构设计

> v5.0 · 2025

| 模块 | 技术选型 |
|------|---------|
| **前端** | Android WebView + HTML/JS |
| **后端** | Node.js · Fastify |
| **数据库** | PostgreSQL + pgvector + Redis |
| **AI 模型** | DeepSeek · GPT-4o-mini · Claude |
| **语音** | Android SpeechRecognizer → Whisper |
| **架构模式** | 前端 → 后端 → 大模型 · 两层大脑 |

*包含：助手人格层 · 两层大脑架构 · 语音全链路 · 实时流式输出*

---

## 一、整体架构总览

AI 助手采用「前端 → 后端 → 大模型」三层架构，核心创新在于后端内的「两层大脑」设计：第一层为确定性规则引擎（毫秒级），第二层才交由大模型进行语言推理。助手本身被抽象为「人格层 + 知识库 + 大脑」的组合体。

### 1.1 总体分层图

```
┌──────────────────────────────────────────────────────────────────┐
│          📱 前端层  Android App (WebView + HTML/JS)              │
│    · 语音录音 (原生 SpeechRecognizer)  · 任务/技能/对话 UI       │
└────────────────────────┬─────────────────────────────────────────┘
                         │  HTTPS + JWT + SSE (流式)
┌────────────────────────▼─────────────────────────────────────────┐
│                   🖥️ 后端层  Node.js / Fastify                   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │         🧠 第一层大脑：确定性引擎 (~50ms)                │   │
│  │   · 意图分类  · 上下文组装  · 路由决策  · 记忆检索       │   │
│  └──────────────────────┬───────────────────────────────────┘   │
│                         │  组装好的完整上下文                    │
│  ┌──────────────────────▼───────────────────────────────────┐   │
│  │         🤖 第二层大脑：大模型推理 (流式 SSE)              │   │
│  │         · ReAct Agent  · Tool 调用  · 流式生成            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  助手人格层  [灵魂 Soul] + [天赋 Talent] + [技能 Skill]          │
│  知识库层   [向量库 pgvector] + [结构化 DB] + [文档 RAG]         │
└────────────────────────┬─────────────────────────────────────────┘
                         │
          ┌──────────────┼──────────────────┐
          ▼              ▼                  ▼
    DeepSeek API    OpenAI API          Claude API
```

### 1.2 架构设计原则

| 原则 | 具体做法 | 理由 |
|------|---------|------|
| 第一层不用 AI | 规则引擎 + 分类器替代小模型 | 确定性快、无 token 消耗、可调试 |
| 流式优先 | 大模型响应通过 SSE 实时推流 | 用户感知延迟降低 3-5 倍 |
| Key 不出后端 | API Key 只存服务器，前端不可见 | 安全，防止 Key 滥用泄漏 |
| 人格可配置 | 灵魂/天赋/技能 分层 Prompt 注入 | 同一后端支持多种助手实例 |
| 记忆分三层 | Short / Long / Episodic 各司其职 | 兼顾速度、准确度和个性化 |
| 工具输入校验 | Zod schema 验证所有 Tool 输入 | 防 LLM 输出错误导致崩溃 |

---

## 二、助手人格层

助手的行为由三层 Prompt 叠加组成，在每次请求到达第二层大脑之前，由后端按顺序拼接注入 System Prompt。

### 2.1 三层人格模型

| 层级 | 名称 | 职责 | 变更频率 | 示例 |
|------|------|------|---------|------|
| L1 | 灵魂 Soul | 助手的核心人格、价值观、语气基线 | 极少（产品定义期） | 中文优先、积极主动、遇歧义主动追问 |
| L2 | 天赋 Talent | 特定领域的专项能力与推理偏好 | 低（随用户身份切换） | 产品经理天赋、软件工程师天赋 |
| L3 | 技能 Skill | 具体可执行的工具调用与流程 | 高（用户自定义） | 提取任务、搜索AI新闻、生成日报 |

### 2.2 灵魂层（Soul）— 基础人格

```typescript
// src/personality/soul.ts
export const SOUL_PROMPT = `
你是"AI 助手"，一个高度个性化的语音任务管理助理。

## 核心人格
- 语言：默认中文，跟随用户语言切换
- 语气：专业但亲切，像一位可信赖的同事
- 遇到模糊指令：主动追问而不是猜测执行
- 遇到无法完成的任务：诚实说明原因，提供替代方案

## 行为约束
- 不主动发起闲聊，专注于任务和效率
- 记住用户偏好，复现时不重复询问
- 任务提取后必须确认，不自动静默创建
- 费用/隐私敏感信息不向用户展示
`;
```

### 2.3 天赋层（Talent）— 领域专项

天赋层存储在数据库中，按用户职业/偏好动态加载，拼接在灵魂层之后：

```typescript
// src/personality/talents.ts
export const TALENT_TEMPLATES: Record<string, string> = {
  "software-engineer": `
## 工程师天赋
- 理解代码相关术语，任务可关联 Git branch/PR
- 优先级判断参考代码风险和上线窗口
- 支持 Jira/Linear 风格的任务格式
`,
  "product-manager": `
## 产品经理天赋
- 理解 PRD / 用户故事 / OKR 语境
- 按用户价值与交付周期推断优先级
- 能识别"需求评审/评审会/Sprint"等关键节点
`,
  "default": `
## 通用天赋
- 以效率和准确为首要目标
- 适配多种工作场景
`,
};
```

### 2.4 运行时状态注入（动态层）

每次请求还会注入一个轻量的「运行时状态」片段，不属于持久化人格，但对交互质量影响很大：

```typescript
// src/personality/runtimeContext.ts
export function buildRuntimeContext(ctx: RuntimeCtx): string {
  const { user, tasks, hour, recentErrors } = ctx;
  return `
## 当前运行时状态
- 用户：${user.displayName}，${user.talent} 身份
- 当前时间：${new Date().toLocaleString("zh-CN")}
- 待处理任务数：${tasks.pendingCount} 项
- 用户今日会话失败次数：${recentErrors}（${recentErrors > 2 ? "请更耐心引导" : "正常"}）
- 当前模式：${hour >= 22 || hour < 7 ? "深夜模式，回应简洁" : "工作模式"}
`;
}
```

### 2.5 完整 System Prompt 组装

```typescript
// src/personality/assembler.ts
export async function assembleSystemPrompt(userId: string, ctx: RuntimeCtx) {
  const soul    = SOUL_PROMPT;                        // L1 灵魂（固定）
  const talent  = await loadUserTalent(userId);       // L2 天赋（按用户加载）
  const skills  = await loadActiveSkills(userId);     // L3 技能列表（工具定义）
  const memory  = await memoryManager.recall(userId); // 长期记忆摘要
  const runtime = buildRuntimeContext(ctx);           // 动态状态

  return [soul, talent, runtime, memory].join("\n\n---\n\n");
  // 技能作为 tools 数组独立传入，不混入 System Prompt
}
```

---

## 三、两层大脑架构

两层大脑的核心原则：第一层做「确定性快速处理」，第二层做「智能语言推理」。两层职责清晰，避免双重 AI 调用带来的延迟叠加。

### 3.1 处理流水线

```
用户输入（语音/文字）
        │
        ▼  < 20ms
┌───────────────────────────────────────────────────────────────┐
│                   第一层大脑：确定性引擎                       │
│                                                               │
│  1. STT检查     语音已在前端转文字，后端做格式清洗             │
│  2. 意图分类    规则 + 关键词 → intent: analyze|search|brief  │
│  3. 记忆检索    pgvector 相似检索 + 长期记忆 key-value 查询   │
│  4. 上下文组装  Soul + Talent + Runtime + Memory 拼接         │
│  5. 路由决策    选模型、选工具集、判断是否需要 web_search      │
│  6. 输入预处理  敏感词过滤、超长截断、注入今日任务列表         │
└──────────────────────────┬────────────────────────────────────┘
                           │  完整上下文包（Context Package）
                           ▼  流式开始
┌───────────────────────────────────────────────────────────────┐
│                第二层大脑：大模型推理 + ReAct Agent            │
│                                                               │
│  1. System Prompt = 组装好的完整人格 + 记忆                   │
│  2. 用户消息   = 清洗后的输入                                  │
│  3. ReAct 循环  Think → Act(Tool) → Observe → Think...       │
│  4. 流式输出    每个 token 通过 SSE 推送前端                   │
│  5. 完成后      异步写入 Episodic Memory + Audit Log          │
└───────────────────────────────────────────────────────────────┘
```

### 3.2 第一层大脑：确定性引擎

**意图分类器**

```typescript
// src/brain/layer1/intentClassifier.ts
const INTENT_RULES: IntentRule[] = [
  { pattern: /提取|任务|待办|安排|记一下/, intent: "analyze-voice" },
  { pattern: /AI.*(新闻|动态|资讯)|今日热点/, intent: "ai-news" },
  { pattern: /日报|周报|总结|汇报/, intent: "daily-brief" },
  { pattern: /深度|分析一下|帮我想想|推理/, intent: "deep-analysis" },
  { pattern: /计算|算一下|多少钱|统计/, intent: "calculate" },
];

export function classifyIntent(text: string, userId: string): IntentResult {
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(text)) return { intent: rule.intent, confidence: 0.9 };
  }
  // 兜底：检查用户历史习惯（Long-term Memory）
  const habit = memoryManager.getLong(userId, "最常用意图");
  return { intent: habit ?? "analyze-voice", confidence: 0.5 };
}
```

**路由决策器**

```typescript
// src/brain/layer1/router.ts
export function routeToModel(ctx: RoutingContext): RoutingDecision {
  const rules: RoutingRule[] = [
    { name: "needs-web-search", p: 10, match: c => c.tools.includes("web_search"), model: "gpt-4o-mini" },
    { name: "deep-reasoning",   p: 20, match: c => c.intent === "deep-analysis", model: "deepseek-reasoner" },
    { name: "short-text",       p: 30, match: c => c.inputLen < 300, model: "deepseek-chat" },
    { name: "user-pref",        p: 40, match: c => !!c.userModel, model: c => c.userModel },
    { name: "fallback",         p: 999, match: () => true, model: "deepseek-chat" },
  ];
  const matched = rules.sort((a, b) => a.p - b.p).find(r => r.match(ctx));
  return { model: matched.model, rule: matched.name };
}
```

### 3.3 第二层大脑：ReAct Agent

```typescript
// src/brain/layer2/agentExecutor.ts
export class AgentExecutor {
  async run(goal: string, userId: string, stream: SSEStream) {
    const sysPrompt = await assembleSystemPrompt(userId, ...); // 人格层
    const messages  = this.memory.getShortTerm(runId);         // 短期记忆
    const tools     = this.toolRegistry.getForSkill(skillId);  // 技能工具集

    for (let step = 0; step < MAX_STEPS; step++) {
      // ① 调用大模型（流式）
      const response = await this.router.callStream({
        model: routingDecision.model,
        systemPrompt: sysPrompt,
        messages, tools,
        onChunk: (chunk) => stream.send({ type: "text", chunk }), // 实时推流
      });

      if (response.finish_reason === "stop") break; // 完成

      // ② 执行 Tool 调用
      for (const call of response.tool_calls) {
        stream.send({ type: "tool_start", name: call.name });
        const result = await this.toolRegistry.execute(call);
        stream.send({ type: "tool_done", name: call.name, result });
        this.memory.appendTool(runId, call, result);
      }
    }

    // 完成后异步写记忆
    this.memory.summarizeToEpisodic(runId, userId);
  }
}
```

### 3.4 两层对比总结

| 维度 | 第一层大脑（确定性引擎） | 第二层大脑（大模型） |
|------|------------------------|-------------------|
| 本质 | 规则 + 分类器 | LLM 推理 |
| 延迟 | < 50ms | 1-10s（流式感知快） |
| Token 消耗 | 无 | 每次请求消耗 |
| 可预测性 | 完全确定 | 概率性输出 |
| 职责 | 分类 / 检索 / 组装 / 路由 | 理解 / 生成 / 工具调用 |
| 可调试性 | 高（规则明确） | 低（黑盒） |
| 扩展方式 | 新增规则 | 调整 Prompt / 换模型 |

---

## 四、知识库与记忆系统

```
                    知识库三层架构

  向量库 (pgvector)       结构化 DB (PostgreSQL)     文档库 (RAG)
  ─────────────────       ──────────────────────     ───────────
  对话摘要 (Episodic)     tasks / skills / users     PDF / 笔记
  用户偏好 (embedding)    user_memories (k-v)        按 chunk 分
  情节检索 (余弦相似)     精确 SQL 查询              存向量库
          │                       │                      │
          └───────────────────────┴──────────────────────┘
                                  │  第一层大脑统一检索并注入
                                  ▼
                      完整上下文包 → 第二层大脑
```

### 4.1 三层记忆

| 类型 | 存储位置 | 生命周期 | 检索方式 | 用途 |
|------|---------|---------|---------|------|
| Short-term | Redis（内存） | 单次 Agent 会话 | 按 runId 直接取 | 多轮对话历史，Agent 状态机 |
| Long-term | PostgreSQL user_memories | 永久（用户可删） | key 精确匹配 | 偏好/习惯/工作领域/常用模式 |
| Episodic | PostgreSQL + pgvector | 永久，按相关性衰减 | 余弦相似度 Top-K | 历史经验检索，RAG 增强 |

### 4.2 记忆写入流程

```typescript
// src/memory/episodic.ts —— Agent 完成后异步执行
export async function summarizeToEpisodic(runId: string, userId: string) {
  const turns = await shortTerm.get(runId);

  // 1. 用 deepseek-chat 生成摘要（便宜模型即可）
  const summary = await llm.complete({
    model: "deepseek-chat",
    prompt: `用1-2句话总结这次对话的 Goal 和 Result：\n${turns.slice(-6)}`,
  });

  // 2. 生成 embedding（text-embedding-3-small）
  const embedding = await openai.embeddings.create({
    model: "text-embedding-3-small", input: summary
  });

  // 3. 存入 pgvector
  await db.episodic_memories.create({
    userId, summary,
    embedding: embedding.data[0].embedding, // 1536 维向量
  });

  // 4. 清理短期记忆
  await shortTerm.delete(runId);
}

// 检索时（第一层大脑调用）：
export async function searchEpisodic(query: string, userId: string, topK = 3) {
  const qEmbed = await openai.embeddings.create({ model: "text-embedding-3-small", input: query });
  return db.$queryRaw`
    SELECT summary, 1 - (embedding <=> ${qEmbed.data[0].embedding}::vector) AS similarity
    FROM episodic_memories WHERE user_id = ${userId}
    ORDER BY similarity DESC LIMIT ${topK}
  `;
}
```

---

## 五、语音全链路

```
用户开口说话
        │
        ▼  (Android 原生)
SpeechRecognizer (系统级，zh-CN)
        │  实时 onPartialResults → onResults
        │  AndroidBridge.onSpeechResult(text) ← JS 全局回调
        ▼
前端文本框 (vtext)  ← 用户可编辑修正
        │
        ▼  点击「AI 分析」
POST /api/analyze { text, userId }  ← HTTPS + JWT
        │
        ▼  后端第一层
意图分类 → 记忆检索 → 上下文组装 → 路由决策
        │
        ▼  后端第二层
deepseek-chat（流式）→ SSE chunks → 前端实时渲染
        │
        ▼  完成
提取任务展示 → 用户确认 → POST /api/tasks（批量创建）
        │
        ▼  异步
摘要 → Episodic Memory (pgvector) + Audit Log
```

### 5.1 Android 语音识别配置

```java
// MainActivity.java —— 关键参数
intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true); // 中间结果
intent.putExtra(EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2000L);

// 连续录音模式：onResults 后自动重启（直到用户停止）
recognition.onResults = () => {
  jsCallback("onSpeechResult", text);
  if (isContinuousListening) beginListening(); // 自动重启
};

// 静音/无匹配：静默重启，不报错
case ERROR_NO_MATCH: case ERROR_SPEECH_TIMEOUT:
  if (isContinuousListening) { delay(600); beginListening(); }
  return;
```

### 5.2 后端 STT 备用方案（可选）

当 Android SpeechRecognizer 不可用（Web 端、离线场景）时，前端可录制音频上传，后端调用 Whisper API：

```typescript
// src/routes/transcribe.ts
fastify.post("/api/transcribe", async (req, reply) => {
  const audioBuffer = await req.file(); // multipart 上传
  const result = await openai.audio.transcriptions.create({
    file: audioBuffer,
    model: "whisper-1",
    language: "zh",
    response_format: "json",
  });
  return { text: result.text }; // 返回转录文字
});
```

---

## 六、流式输出（SSE）

流式输出是语音助手「响应感」的核心。用户说完话后，大模型开始生成的第一个字就应该出现在屏幕上，而不是等全部生成完。

### 6.1 SSE 事件协议

| 事件类型 | data 示例 | 前端处理 |
|---------|----------|---------|
| `text` | `{ "chunk": "今天" }` | 追加到对话气泡 |
| `tool_start` | `{ "name": "web_search", "args": "..." }` | 显示"正在搜索…"动画 |
| `tool_done` | `{ "name": "web_search", "result": [...] }` | 显示工具结果卡片 |
| `task_extract` | `{ "tasks": [...] }` | 弹出任务确认卡 |
| `step` | `{ "step": 3, "total": 6 }` | 更新进度条 |
| `done` | `{ "total_tokens": 380 }` | 停止动画，记录 audit |
| `error` | `{ "message": "..." }` | 显示错误提示 |

### 6.2 后端 SSE 实现

```typescript
// src/routes/analyze.ts
fastify.post("/api/analyze", async (req, reply) => {
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("X-Accel-Buffering", "no"); // 禁 nginx 缓冲

  const send = (event: string, data: object) => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // 第一层大脑（同步，无 streaming）
  const ctx = await layer1.process(req.body.text, req.userId);
  send("step", { step: 1, label: "意图分析完成" });

  // 第二层大脑（流式）
  await agentExecutor.run(ctx, {
    onChunk:    (c)    => send("text",         { chunk: c }),
    onToolStart:(n, a) => send("tool_start",   { name: n, args: a }),
    onToolDone: (n, r) => send("tool_done",    { name: n, result: r }),
    onTasks:    (ts)   => send("task_extract", { tasks: ts }),
    onDone:     (u)    => send("done",         { total_tokens: u }),
  });

  reply.raw.end();
});
```

### 6.3 前端 SSE 消费

```javascript
// 前端 JS —— src/voice/sseClient.js
async function analyze() {
  const resp = await fetch("/api/analyze", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: vtextValue }),
  });

  const reader  = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n\n");
    buf = lines.pop(); // 保留不完整的最后一段
    for (const block of lines) {
      const eventLine = block.match(/^event: (\w+)/)?.[1] ?? "text";
      const dataLine  = block.match(/^data: (.+)/m)?.[1];
      if (!dataLine) continue;
      handleSSEEvent(eventLine, JSON.parse(dataLine));
    }
  }
}

function handleSSEEvent(event, data) {
  if (event === "text")         appendToChat(data.chunk);
  if (event === "tool_start")   showToolCard(data.name, "running");
  if (event === "tool_done")    showToolCard(data.name, "done", data.result);
  if (event === "task_extract") showTaskConfirm(data.tasks);
  if (event === "done")         finishAnalysis(data);
}
```

---

## 七、完整 API 设计

### 7.1 认证接口

| 方法 | 路径 | 入参 | 返回 |
|------|------|------|------|
| POST | `/auth/wechat` | `{ code }` | `{ accessToken, refreshToken, user }` |
| POST | `/auth/apple` | `{ identityToken }` | `{ accessToken, refreshToken, user }` |
| POST | `/auth/google` | `{ idToken }` | `{ accessToken, refreshToken, user }` |
| POST | `/auth/otp/send` | `{ phone }` | `{ expiresIn: 60 }` |
| POST | `/auth/otp/verify` | `{ phone, code }` | `{ accessToken, refreshToken, user }` |
| POST | `/auth/refresh` | `{ refreshToken }` | `{ accessToken }` |
| POST | `/auth/bind` | `{ provider, token }` | `204` |
| GET  | `/auth/me` | — | `UserProfile` |

### 7.2 核心业务接口

| 方法 | 路径 | 说明 | SSE |
|------|------|------|:---:|
| POST | `/api/analyze` | 语音文字 → 分析 → 任务提取 | ✓ |
| POST | `/api/transcribe` | 音频文件 → Whisper → 文字 | ✗ |
| GET  | `/api/tasks` | 获取任务列表（分页 + 筛选） | ✗ |
| POST | `/api/tasks` | 批量创建任务 | ✗ |
| PATCH | `/api/tasks/:id` | 更新任务状态/内容 | ✗ |
| DELETE | `/api/tasks/:id` | 删除任务 | ✗ |
| GET  | `/api/skills` | 技能列表 | ✗ |
| POST | `/api/skills/:id/run` | 执行技能（Agent 启动） | ✓ |
| POST | `/api/agent/run` | 自定义 Goal 直接运行 Agent | ✓ |
| GET  | `/api/memory/long` | 获取长期记忆 k-v | ✗ |
| POST | `/api/memory/long` | 写入长期记忆 | ✗ |
| GET  | `/api/memory/episodic` | 情节记忆列表 | ✗ |
| GET  | `/api/audit` | AI 调用审计日志 + 费用统计 | ✗ |
| GET  | `/api/personality` | 查看当前人格层配置 | ✗ |
| PUT  | `/api/personality/talent` | 切换天赋 | ✗ |

---

## 八、数据库 Schema

```sql
-- 用户与账号
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name    VARCHAR(100),             -- 用户昵称（人类身份，用于登录/主页）
  avatar_emoji    VARCHAR(10),              -- 用户头像（人类身份）
  talent          VARCHAR(50) DEFAULT 'default', -- 当前天赋
  soul_prompt     TEXT,                     -- 自定义人格提示词
  assistant_name  VARCHAR(100) DEFAULT '我的助手', -- 助手昵称（AI 身份，用于好友系统）
  assistant_emoji VARCHAR(10)  DEFAULT '🤖',      -- 助手头像（AI 身份）
  preferred_model VARCHAR(50),              -- 用户模型偏好
  avatar_url      VARCHAR(500),
  phone           VARCHAR(20) UNIQUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE oauth_accounts (
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  provider    VARCHAR(20) NOT NULL,    -- wechat|apple|google
  provider_id VARCHAR(255) NOT NULL,
  UNIQUE(provider, provider_id)
);

-- 任务
CREATE TABLE tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id),
  title       VARCHAR(200) NOT NULL,
  priority    VARCHAR(10),   -- high|med|low
  category    VARCHAR(50),
  deadline    VARCHAR(100),
  status      VARCHAR(20) DEFAULT 'pending',
  source      VARCHAR(20),   -- voice|agent|manual
  run_id      VARCHAR(50),   -- 来源 Agent 运行 ID
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 技能
CREATE TABLE skills (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id),
  name          VARCHAR(100) NOT NULL,
  builtin_type  VARCHAR(50),
  soul_override TEXT,         -- 技能级灵魂覆盖（可选）
  allowed_tools TEXT[],
  model_pref    VARCHAR(50),
  is_builtin    BOOLEAN DEFAULT FALSE
);

-- 记忆
CREATE TABLE user_memories (
  user_id    UUID REFERENCES users(id),
  key        VARCHAR(200),
  value      TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY(user_id, key)
);

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE episodic_memories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id),
  summary    TEXT,
  embedding  vector(1536),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON episodic_memories USING ivfflat (embedding vector_cosine_ops);

-- 审计
CREATE TABLE ai_audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id),
  run_id        VARCHAR(50),
  model         VARCHAR(50),
  routing_rule  VARCHAR(100),
  intent        VARCHAR(50),
  input_tokens  INTEGER,
  output_tokens INTEGER,
  latency_ms    INTEGER,
  cost_usd      DECIMAL(10,6),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 九、后端目录结构

```
ai-assistant-server/
├── src/
│   ├── routes/
│   │   ├── auth.ts          # OAuth + OTP + JWT
│   │   ├── analyze.ts       # 语音文字 → SSE 流式分析
│   │   ├── transcribe.ts    # 音频 → Whisper STT
│   │   ├── tasks.ts         # 任务 CRUD
│   │   ├── skills.ts        # 技能 CRUD + 执行
│   │   ├── agent.ts         # 自定义 Agent
│   │   ├── memory.ts        # 记忆读写
│   │   └── audit.ts         # 审计日志 + 费用
│   │
│   ├── personality/         # 助手人格层
│   │   ├── soul.ts          # L1 灵魂（固定 Prompt）
│   │   ├── talents.ts       # L2 天赋模板库
│   │   ├── runtimeContext.ts# 动态状态注入
│   │   └── assembler.ts     # 完整 System Prompt 组装
│   │
│   ├── brain/
│   │   ├── layer1/          # 第一层：确定性引擎
│   │   │   ├── intentClassifier.ts
│   │   │   ├── contextAssembler.ts
│   │   │   └── router.ts    # 模型路由决策
│   │   └── layer2/          # 第二层：大模型推理
│   │       ├── agentExecutor.ts  # ReAct 循环
│   │       └── streamAdapter.ts  # SSE 流式适配
│   │
│   ├── tools/               # Tool 注册表
│   │   ├── registry.ts
│   │   ├── webSearch.ts
│   │   ├── createTask.ts
│   │   ├── memorySearch.ts
│   │   ├── saveMemory.ts
│   │   ├── calculator.ts
│   │   └── httpCall.ts      # 用户自定义外部接口
│   │
│   ├── memory/
│   │   ├── index.ts         # MemoryManager 统一入口
│   │   ├── shortTerm.ts     # Redis（单次会话）
│   │   ├── longTerm.ts      # PostgreSQL k-v
│   │   └── episodic.ts      # pgvector RAG
│   │
│   ├── auth/
│   │   ├── jwt.ts
│   │   ├── middleware.ts
│   │   └── providers/       # wechat / apple / google / otp
│   │
│   ├── models/              # 大模型接入
│   │   ├── registry.ts      # 模型注册表
│   │   ├── healthCheck.ts   # 可用性检测
│   │   └── adapters/        # openai / anthropic 格式抹平
│   │
│   └── db/
│       ├── schema.prisma
│       └── client.ts
│
├── .env
├── Dockerfile
└── docker-compose.yml
```

---

## 十、关键设计决策

| 模块 | 决策 | 理由 |
|------|------|------|
| 人格系统 | 三层分离（灵魂/天赋/技能） | 灵魂稳定、天赋可换、技能可配，职责清晰 |
| 动态状态 | 每次请求注入运行时上下文 | 影响语气和行为，但不应持久化进人格 |
| 第一层大脑 | 确定性规则引擎，不用小模型 | 速度快（<50ms）、无 token 消耗、可调试 |
| 第二层大脑 | 大模型 + ReAct，流式输出 | 用户感知响应快，支持多步工具调用 |
| 流式协议 | SSE（不用 WebSocket） | 单向推送足够，比 WS 轻量，Nginx 更易配置 |
| 记忆检索 | pgvector 余弦相似，无独立向量库 | PostgreSQL 统一管理，减少运维复杂度 |
| Android 语音 | 原生 SpeechRecognizer + JS Bridge | WebView 不支持 Web Speech API，必须走原生 |
| API Key | 只存后端，不传前端 | 安全，防止 Key 泄漏滥用 |
| 工具输入 | Zod 校验所有 Tool 参数 | 防 LLM 格式错误导致工具崩溃 |
| 摘要存储 | Agent 完成后异步摘要到 Episodic | 不阻塞主流程，同时积累个性化记忆 |
| Agent 步骤上限 | 最多 10 轮 ReAct 循环 | 防意外无限循环消耗 API 费用 |
| 费用展示 | 后端记录，用户可查，前端不展示原始 Key/费率 | 用户知情权 vs 商业保密平衡 |

---

## 十一、实施路线图

| 阶段 | 目标 | 关键任务 | 预期周期 |
|------|------|---------|---------|
| Phase 1 | 核心链路跑通 | SSE 流式 + DeepSeek 接入 + 语音录音 | 1-2 周 |
| Phase 2 | 人格层上线 | 灵魂/天赋/技能 Prompt 组装 + 天赋切换 | 1 周 |
| Phase 3 | 记忆系统 | pgvector + 短/长/情节三层 + 异步摘要 | 2 周 |
| Phase 4 | 工具生态 | web_search / 日报 / 计算器等 Tool 完善 | 1-2 周 |
| Phase 5 | 认证与多设备 | OAuth + OTP + refresh token 多设备 | 1 周 |
| Phase 6 | 性能与稳定性 | 路由健康检查 / 限流 / 错误重试 / 监控 | 持续 |

> 💡 建议优先实现：`POST /api/analyze`（SSE 流式）→ 前端 SSE 消费 → DeepSeek 接入。这条链路跑通后，其他模块都是在它之上叠加，而不是并行开发。

---

## 十一·五、双身份模型

系统中每个账号同时拥有两种身份，分别服务于不同场景：

| 维度 | 用户身份（Human） | 助手身份（AI Assistant） |
|------|-----------------|----------------------|
| **核心字段** | `display_name`、`avatar_emoji` | `assistant_name`、`assistant_emoji` |
| **设定入口** | 个人资料页（更多 → 个人资料） | AI 灵魂设定页（更多 → 我的 AI 灵魂） |
| **使用场景** | 登录问候、账号标识 | 好友列表、聊天头部、消息气泡、AI 人格层 |
| **可见性** | 仅自己和后台 | 对所有好友可见 |
| **默认值** | `'User'` | `'我的助手'` / `'🤖'` |

### 设计原则

- **好友系统以助手身份为核心**：好友列表展示的是对方的助手昵称与助手头像，而非用户真实昵称。用户真实昵称作为副标题（meta）辅助显示。
- **聊天以助手身份呈现**：消息气泡的头像使用发送方的助手 emoji，聊天页面标题显示对方的助手昵称。
- **搜索同时支持两种身份**：搜索用户时可匹配 `display_name` 或 `assistant_name`，搜索结果以助手身份为主要展示。
- **AI 人格层使用助手昵称**：系统 Prompt 中的自我介绍使用 `assistant_name`，让 AI 以用户定义的身份与其对话。
- **主页打招呼保留用户昵称**：主页的 "你好，[name]" 仍使用 `display_name`，体现用户本人的归属感。

```
用户登录后看到：
  主页:  "你好，小明"            ← display_name
  好友:  "星辰 · 代码专家"       ← assistant_name + talent
  聊天:  "‹ 星辰"               ← assistant_name
  气泡:  🔮 (助手 emoji)        ← assistant_emoji
```

---

## 十二、好友系统

好友系统允许用户之间相互关注、分享技能与任务成果，形成协作网络。核心设计原则是「轻社交 + 强隐私」：默认只分享用户主动公开的内容，不泄露私人任务和记忆数据。

### 12.1 好友关系模型

好友关系采用「双向关注」模型（类似 Twitter），分为三种状态：单向关注（Following）、互相关注（Friends）、屏蔽（Blocked）。互相关注后可开启更多协作权限，如共享技能、实时协作任务。

### 12.2 数据库 Schema 扩展

```sql
-- 好友关系表
CREATE TABLE friendships (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id UUID REFERENCES users(id) ON DELETE CASCADE,
  followed_id UUID REFERENCES users(id) ON DELETE CASCADE,
  status      VARCHAR(20) DEFAULT 'pending',  -- pending|accepted|blocked
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(follower_id, followed_id)
);

-- 好友动态 Feed
CREATE TABLE social_activities (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id),
  type       VARCHAR(30),   -- skill_published|task_done|skill_used|friend_added
  ref_id     UUID,          -- 关联的技能/任务 ID
  is_public  BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 12.3 好友系统 API 接口

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| POST | `/api/friends/follow` | 关注用户（发送好友请求） | 已登录用户 |
| DELETE | `/api/friends/:id` | 取消关注 / 删除好友 | 自己 |
| GET | `/api/friends` | 好友列表（followers/following/mutual） | 已登录用户 |
| GET | `/api/friends/feed` | 关注者的公开动态 Feed（分页） | 已登录用户 |
| GET | `/api/users/search` | 搜索用户（按昵称/ID） | 公开 |
| POST | `/api/friends/block` | 屏蔽用户（双向隔离） | 自己 |

### 12.4 隐私与权限控制

用户数据遵循「最小可见」原则：任务默认私有，仅用户自己可见；技能可设为公开/仅好友/私有三档；动态 Feed 只展示用户主动标记为公开的行为。后端通过行级权限（Row Level Security）在 PostgreSQL 层面强制隔离，防止越权访问。

通知系统：好友关注、技能被使用等事件通过 PostgreSQL LISTEN/NOTIFY + SSE 推送至前端，无需轮询。推送内容严格过滤，不含任何私人数据。

---

## 十三、技能分享与交易系统

技能市场（Skill Marketplace）允许用户将自己创建的 Agent 技能发布到公共市场，供他人免费使用或付费购买。核心设计原则：技能定义本身（Prompt + 工具集）可分享，但用户的执行历史和记忆数据绝对不随技能流传。

### 13.1 技能扩展 Schema

```sql
-- 原 skills 表新增市场相关字段
ALTER TABLE skills ADD COLUMN
  visibility       VARCHAR(20) DEFAULT 'private',  -- private|friends|public
  price_credits    INTEGER DEFAULT 0,              -- 0 = 免费
  tags             TEXT[],                          -- 分类标签
  install_count    INTEGER DEFAULT 0,
  rating_avg       DECIMAL(3,2) DEFAULT 0,
  cover_emoji      VARCHAR(10),
  description_long TEXT;                           -- 详细描述/README

-- 技能购买记录
CREATE TABLE skill_purchases (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id     UUID REFERENCES users(id),
  skill_id     UUID REFERENCES skills(id),
  credits_paid INTEGER NOT NULL,
  purchased_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(buyer_id, skill_id)
);

-- 技能评价
CREATE TABLE skill_reviews (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id   UUID REFERENCES skills(id),
  user_id    UUID REFERENCES users(id),
  rating     SMALLINT CHECK(rating BETWEEN 1 AND 5),
  comment    TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(skill_id, user_id)
);
```

### 13.2 市场 API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/market/skills` | 市场技能列表（分页 + 标签筛选 + 排序） |
| GET | `/api/market/skills/:id` | 技能详情（含评价列表） |
| POST | `/api/market/publish` | 发布技能到市场（设价格/标签/可见性） |
| POST | `/api/market/install/:id` | 安装（克隆技能定义到用户空间，付费先扣 credits） |
| POST | `/api/market/review/:id` | 提交评分与评价（仅已购/已安装用户） |
| GET | `/api/market/my-earnings` | 创作者收益统计（credits 收入明细） |

### 13.3 Credits 积分经济模型

平台使用虚拟积分（Credits）作为技能交易媒介，避免直接法币支付的监管复杂性。Credits 可通过充值、邀请奖励、技能被安装获得，用于购买付费技能。

| 来源 | Credits 数量 | 备注 |
|------|------------|------|
| 新用户注册 | +100 | 新手礼包 |
| 邀请好友注册 | +50 | 邀请人 + 被邀请人各得 |
| 技能被他人安装（免费） | +5 | 创作者奖励 |
| 技能被购买（付费） | 定价 × 80% | 平台抽成 20% |

### 13.4 安全与审核机制

技能发布前须通过自动安全审核（扫描 `soul_override` 是否包含越权指令、`allowed_tools` 是否包含危险工具）。评分低于 2.0 的技能自动下架。用户可举报违规技能，触发人工审核队列。

技能安装采用「克隆」而非「引用」模式：用户安装后获得的是技能定义的副本，与原作者完全解耦，原作者无法读取买家的执行历史或修改已安装技能的行为。

### 13.5 路由图更新（新增模块）

后端目录结构新增以下模块（追加到原第九章目录树）：

```
src/routes/
├── friends.ts       # 关注/好友/动态 Feed
├── market.ts        # 技能市场发布/安装/评价
├── credits.ts       # Credits 充值/明细/提现
└── notifications.ts # SSE 推送（好友/市场通知）
```

实施建议：好友系统和技能市场可在 Phase 4（工具生态）完成后作为 Phase 7 启动，依赖基础技能功能的稳定运行。Credits 经济体系应配合独立的账本服务（`credits_ledger` 表 + 事务锁）确保数据一致性。
