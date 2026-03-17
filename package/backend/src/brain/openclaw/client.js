'use strict';

/**
 * OpenClaw 网关客户端
 *
 * 支持两种部署模式（通过 OPENCLAW_MODE 切换）：
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  Mode A: dedicated（独占模式，默认）                                 │
 * │  每个用户对应一个独立的 OpenClaw 实例。                              │
 * │  用户的实例地址存储在 user_memories 表中：                          │
 * │    key = '_openclaw_url'   value = 'http://user-server:18789'       │
 * │    key = '_openclaw_token' value = '<token>'                        │
 * │  若用户未配置，则回退到全局 OPENCLAW_URL。                          │
 * │                                                                     │
 * │  适用场景：                                                         │
 * │    · 企业私有化：每个部门/用户独占算力与数据                        │
 * │    · 用户自持服务器，接入自己的 OpenClaw 实例                       │
 * │    · 隔离性要求高，不允许跨用户共享上下文                           │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │  Mode B: shared（共享模式）                                         │
 * │  多用户共享同一个 OpenClaw 实例，每用户通过 agent_id 区分。         │
 * │  agent_id 格式：aia_{userId}                                       │
 * │  · 通过 user 字段（OpenAI 标准）传递给 OpenClaw 做 session 路由     │
 * │  · 通过 X-OpenClaw-Agent 请求头传递（OpenClaw 扩展头，可选）        │
 * │                                                                     │
 * │  适用场景：                                                         │
 * │    · SaaS 多租户：运营方统一部署一个 OpenClaw，服务所有用户         │
 * │    · 资源受限：一台服务器跑一个实例服务多用户                       │
 * │    · 快速接入：无需为每个用户单独部署实例                           │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 全局 .env 配置：
 *   OPENCLAW_URL=http://<server>:18789    # 全局（或共享模式唯一）实例地址
 *   OPENCLAW_TOKEN=<token>               # 全局 token
 *   OPENCLAW_MODE=dedicated|shared       # 部署模式，默认 dedicated
 *   OPENCLAW_DEFAULT_MODEL=deepseek-chat # 默认模型
 *   OPENCLAW_EMBED_MODEL=text-embedding-3-small
 */

const { getRuntimeConfig } = require('../../config/runtime');

// ── 全局配置 ──────────────────────────────────────────
function getOpenClawConfig() {
  const rt = getRuntimeConfig();
  return {
    url:          rt.openclawUrl   || process.env.OPENCLAW_URL   || 'http://localhost:18789',
    token:        rt.openclawToken || process.env.OPENCLAW_TOKEN || 'openclaw',
    mode:         rt.openclawMode  || process.env.OPENCLAW_MODE  || 'dedicated',
    defaultModel: process.env.OPENCLAW_DEFAULT_MODEL             || 'deepseek-chat',
  };
}

// ── 检查 OpenClaw 是否已配置 ──────────────────────────
function isOpenClawConfigured() {
  return !!(process.env.OPENCLAW_URL || getRuntimeConfig().openclawUrl);
}

// ── 解析用户生效配置（综合全局配置 + 用户专属配置）──────
/**
 * dedicated 模式：优先从 user_memories 取用户专属 URL/token。
 * shared 模式：始终使用全局 URL，返回 agentId 供请求路由。
 *
 * @param {string|null} userId
 * @returns {Promise<{url, token, agentId|null}>}
 */
async function resolveUserConfig(userId) {
  const base = getOpenClawConfig();

  if (base.mode === 'shared' || !userId) {
    // 共享模式：全局 URL + agentId 区分用户
    return {
      url:     base.url,
      token:   base.token,
      agentId: userId ? `aia_${userId}` : null,
    };
  }

  // 独占模式：尝试读取用户自己的 OpenClaw 地址
  try {
    const { query } = require('../../db/client');
    const res = await query(
      `SELECT key, value FROM user_memories
       WHERE user_id=$1 AND key IN ('_openclaw_url','_openclaw_token')`,
      [userId]
    );
    const map = Object.fromEntries(res.rows.map(r => [r.key, r.value]));
    return {
      url:     map['_openclaw_url']   || base.url,
      token:   map['_openclaw_token'] || base.token,
      agentId: null,   // 独占模式不需要 agentId（整个实例属于该用户）
    };
  } catch {
    return { url: base.url, token: base.token, agentId: null };
  }
}

// ── 统一 LLM 调用（通过 OpenClaw 网关）──────────────
/**
 * @param {object}   opts
 * @param {string}   opts.model        - 模型名（传递给 OpenClaw，由其路由到具体 provider）
 * @param {string}   opts.systemPrompt - 系统提示词（人格层）
 * @param {Array}    opts.messages     - 对话历史（user/assistant/tool 格式）
 * @param {Array}    [opts.tools]      - OpenAI Function Calling 工具定义
 * @param {boolean}  [opts.stream]     - 是否流式输出
 * @param {Function} [opts.onChunk]    - 流式回调 { type, chunk }
 * @param {string}   [opts.userId]     - 当前用户 ID（用于路由解析）
 * @returns {Promise<{text, toolCalls, usage, latencyMs, finishWithTools}>}
 */
async function callOpenClaw({ model, systemPrompt, messages, tools, stream, onChunk, userId }) {
  const { OpenAI } = require('openai');
  const cfg      = getOpenClawConfig();
  const resolved = await resolveUserConfig(userId);

  const client = new OpenAI({
    apiKey:       resolved.token,
    baseURL:      `${resolved.url}/v1`,
    defaultHeaders: resolved.agentId
      ? { 'X-OpenClaw-Agent': resolved.agentId }   // 共享模式：标识当前用户 agent
      : {},
  });

  const effectiveModel = model || cfg.defaultModel;
  const startTime = Date.now();

  const params = {
    model:    effectiveModel,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    temperature: 0.7,
    max_tokens:  2000,
    // OpenAI 标准 user 字段 —— 共享模式下 OpenClaw 用此做 session 隔离
    ...(resolved.agentId ? { user: resolved.agentId } : {}),
  };

  let fullText  = '';
  let toolCalls = [];
  let usage     = { prompt_tokens: 0, completion_tokens: 0 };

  if (stream && onChunk) {
    const streamResp = await client.chat.completions.create({ ...params, stream: true });
    const pending    = {};

    for await (const chunk of streamResp) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        fullText += delta.content;
        onChunk({ type: 'text', chunk: delta.content });
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!pending[idx]) {
            pending[idx] = { id: tc.id || `tc_${idx}`, name: tc.function?.name || '', args: '' };
          }
          if (tc.function?.name)      pending[idx].name  = tc.function.name;
          if (tc.function?.arguments) pending[idx].args += tc.function.arguments;
        }
      }

      const reason = chunk.choices[0]?.finish_reason;
      if (reason === 'stop' || reason === 'tool_calls') {
        toolCalls = Object.values(pending);
        break;
      }
    }
  } else {
    const resp = await client.chat.completions.create(params);
    fullText   = resp.choices[0]?.message?.content || '';
    toolCalls  = (resp.choices[0]?.message?.tool_calls || []).map(tc => ({
      id:   tc.id,
      name: tc.function.name,
      args: tc.function.arguments,
    }));
    usage = resp.usage || usage;
  }

  return {
    text:            fullText,
    toolCalls,
    usage,
    latencyMs:       Date.now() - startTime,
    finishWithTools: toolCalls.length > 0,
  };
}

// ── Embedding 生成（通过 OpenClaw 网关）──────────────
/**
 * 生成文本向量，用于情节记忆相似度检索。
 * 同样遵循 dedicated/shared 模式，使用用户对应的实例。
 */
async function createEmbedding(text, userId) {
  const { OpenAI } = require('openai');
  const cfg = getOpenClawConfig();

  if (isOpenClawConfigured()) {
    const resolved = await resolveUserConfig(userId);
    const client = new OpenAI({
      apiKey:  resolved.token,
      baseURL: `${resolved.url}/v1`,
      defaultHeaders: resolved.agentId ? { 'X-OpenClaw-Agent': resolved.agentId } : {},
    });
    const res = await client.embeddings.create({
      model: process.env.OPENCLAW_EMBED_MODEL || 'text-embedding-3-small',
      input: text,
    });
    return res.data[0].embedding;
  }

  // 降级：直连 OpenAI
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.embeddings.create({ model: 'text-embedding-3-small', input: text });
  return res.data[0].embedding;
}

// ── 同步用户助手属性到 OpenClaw Agent 配置 ────────────
/**
 * 将后端「静态人格属性」推送到 OpenClaw，使 Agent 持久化
 * 用户的助手设定，无需每次请求重传完整 persona。
 *
 * 触发时机：用户更新 profile（名称/天赋/自定义人格/偏好模型）
 *
 * 属性映射：
 *   assistant_name  → OpenClaw agent.name
 *   assistant_emoji → OpenClaw agent.avatar
 *   talent 层 prompt→ OpenClaw agent.persona（静态部分）
 *   soul_prompt     → OpenClaw agent.persona 扩展
 *   preferred_model → OpenClaw agent.model
 *   display_name    → OpenClaw agent.persona 中的用户称谓
 *
 * 注意：动态部分（时间/任务数/记忆）仍通过每次请求的
 * system prompt 注入，不存入 OpenClaw 配置。
 *
 * @param {string} userId
 * @param {object} opts
 * @param {string} opts.staticPersona  - 已组装好的静态 persona（soul + talent）
 * @param {string} opts.assistantName  - 助手名称
 * @param {string} [opts.assistantEmoji] - 助手头像 emoji
 * @param {string} [opts.model]        - 偏好模型名
 */
async function syncAgentConfig(userId, { staticPersona, assistantName, assistantEmoji, model }) {
  if (!isOpenClawConfigured()) return;

  const resolved = await resolveUserConfig(userId);
  const agentId  = resolved.agentId || `aia_${userId}`;   // shared 模式用 agentId，dedicated 模式用 default agent

  const payload = {
    name:    assistantName || 'AI 助手',
    avatar:  assistantEmoji || '🤖',
    persona: staticPersona || '',
    ...(model ? { model } : {}),
  };

  try {
    const axios = require('axios');
    // OpenClaw Agent 配置端点（PUT 幂等更新）
    await axios.put(
      `${resolved.url}/api/agents/${agentId}`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${resolved.token}`,
          'Content-Type':  'application/json',
          ...(resolved.agentId ? { 'X-OpenClaw-Agent': resolved.agentId } : {}),
        },
        timeout: 5000,
      }
    );
  } catch {
    // 同步失败不阻断主流程（OpenClaw 可能未支持此端点）
  }
}

module.exports = { callOpenClaw, createEmbedding, isOpenClawConfigured, getOpenClawConfig, resolveUserConfig, syncAgentConfig };
