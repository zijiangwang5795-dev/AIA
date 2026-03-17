'use strict';

/**
 * OpenClaw 网关客户端
 *
 * ── 产品形态 ──────────────────────────────────────────────────────────────
 *
 *  免费用户（free plan）→ 共享模式（shared）
 *    · 使用平台统一部署的 OpenClaw 实例（OPENCLAW_URL）
 *    · 通过 agentId = aia_{userId} 在实例内隔离会话
 *    · 注册即可用，无需额外配置
 *
 *  付费用户（paid plan）→ 独占模式（dedicated）
 *    · 使用用户自己的 OpenClaw 实例（或平台分配的专属实例）
 *    · 实例地址存储在 user_memories：key = '_openclaw_url'
 *    · 未配置专属地址时，暂时回退到共享实例（待配置提醒）
 *
 * ── 模式判断来源 ────────────────────────────────────────────────────────
 *   优先级：用户订阅等级 > 全局 OPENCLAW_MODE 兜底
 *   · free plan  → shared
 *   · paid plan  → dedicated（按 _openclaw_url 路由）
 *
 * ── .env 配置 ────────────────────────────────────────────────────────────
 *   OPENCLAW_URL=http://<server>:18789    # 平台共享 OpenClaw 地址（免费用户）
 *   OPENCLAW_TOKEN=<token>               # 全局 token
 *   OPENCLAW_DEFAULT_MODEL=deepseek-chat
 *   OPENCLAW_EMBED_MODEL=text-embedding-3-small
 */

const { getRuntimeConfig } = require('../../config/runtime');

// ── 全局配置 ──────────────────────────────────────────
function getOpenClawConfig() {
  const rt = getRuntimeConfig();
  return {
    url:          rt.openclawUrl   || process.env.OPENCLAW_URL   || 'http://localhost:18789',
    token:        rt.openclawToken || process.env.OPENCLAW_TOKEN || 'openclaw',
    defaultModel: process.env.OPENCLAW_DEFAULT_MODEL             || 'deepseek-chat',
  };
}

// ── 检查 OpenClaw 是否已配置 ──────────────────────────
function isOpenClawConfigured() {
  return !!(process.env.OPENCLAW_URL || getRuntimeConfig().openclawUrl);
}

// ── 判断用户是否为付费用户 ────────────────────────────
async function isPaidUser(userId) {
  if (!userId) return false;
  try {
    const { getUserPlan } = require('../../middleware/quota');
    const plan = await getUserPlan(userId);
    return plan && plan.id !== 'free';
  } catch {
    return false;
  }
}

// ── 解析用户生效配置（按订阅等级动态路由）──────────────
/**
 * 免费用户 → shared（全局 URL + agentId）
 * 付费用户 → dedicated（user_memories._openclaw_url；未配置时暂回退 shared）
 *
 * @param {string|null} userId
 * @returns {Promise<{url, token, agentId|null, mode: 'shared'|'dedicated', dedicatedConfigured: boolean}>}
 */
async function resolveUserConfig(userId) {
  const base = getOpenClawConfig();

  if (!userId) {
    return { url: base.url, token: base.token, agentId: null, mode: 'shared', dedicatedConfigured: false };
  }

  const paid = await isPaidUser(userId);

  if (!paid) {
    // 免费用户：共享实例，agentId 隔离
    return {
      url:                base.url,
      token:              base.token,
      agentId:            `aia_${userId}`,
      mode:               'shared',
      dedicatedConfigured: false,
    };
  }

  // 付费用户：尝试读取专属 OpenClaw 地址
  try {
    const { query } = require('../../db/client');
    const res = await query(
      `SELECT key, value FROM user_memories
       WHERE user_id=$1 AND key IN ('_openclaw_url','_openclaw_token')`,
      [userId]
    );
    const map = Object.fromEntries(res.rows.map(r => [r.key, r.value]));

    if (map['_openclaw_url']) {
      return {
        url:                map['_openclaw_url'],
        token:              map['_openclaw_token'] || base.token,
        agentId:            null,    // 整个实例归该用户，无需 agentId
        mode:               'dedicated',
        dedicatedConfigured: true,
      };
    }
  } catch { /* ignore */ }

  // 付费但尚未配置专属地址：暂用共享，标记未配置
  return {
    url:                base.url,
    token:              base.token,
    agentId:            `aia_${userId}`,
    mode:               'shared',
    dedicatedConfigured: false,
  };
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
