'use strict';

/**
 * OpenClaw 网关客户端
 *
 * 架构：Frontend → Backend → OpenClaw → AI 模型
 *
 * OpenClaw 部署在服务器上（默认端口 18789），提供 OpenAI 兼容的
 * /v1/chat/completions 和 /v1/embeddings 接口，统一管理所有 AI 调用。
 * 后端不再直接调用 DeepSeek / OpenAI / Anthropic，所有推理请求
 * 统一经过 OpenClaw 网关路由。
 *
 * 配置方式（.env）：
 *   OPENCLAW_URL=http://<your-server>:18789   # OpenClaw 服务地址
 *   OPENCLAW_TOKEN=<token>                    # 可选，gateway.auth.mode 启用时填写
 */

const { getRuntimeConfig } = require('../../config/runtime');

// ── 获取当前生效的 OpenClaw 配置 ─────────────────────
function getOpenClawConfig() {
  const rt = getRuntimeConfig();
  return {
    url:          rt.openclawUrl   || process.env.OPENCLAW_URL   || 'http://localhost:18789',
    token:        rt.openclawToken || process.env.OPENCLAW_TOKEN || 'openclaw',
    defaultModel: process.env.OPENCLAW_DEFAULT_MODEL             || 'deepseek-chat',
  };
}

// ── 检查 OpenClaw 是否已配置 ─────────────────────────
function isOpenClawConfigured() {
  return !!(process.env.OPENCLAW_URL || getRuntimeConfig().openclawUrl);
}

// ── 统一 LLM 调用（通过 OpenClaw 网关）──────────────
/**
 * @param {object} opts
 * @param {string}   opts.model        - 模型名（传递给 OpenClaw，由其路由到具体 provider）
 * @param {string}   opts.systemPrompt - 系统提示词（人格层）
 * @param {Array}    opts.messages     - 对话历史（user / assistant / tool 格式）
 * @param {Array}    [opts.tools]      - OpenAI Function Calling 格式工具定义
 * @param {boolean}  [opts.stream]     - 是否流式输出
 * @param {Function} [opts.onChunk]    - 流式回调 { type, chunk } 或 { type, toolCalls }
 * @returns {Promise<{text, toolCalls, usage, latencyMs, finishWithTools}>}
 */
async function callOpenClaw({ model, systemPrompt, messages, tools, stream, onChunk }) {
  const { OpenAI } = require('openai');
  const cfg = getOpenClawConfig();

  const client = new OpenAI({
    apiKey:  cfg.token,
    baseURL: `${cfg.url}/v1`,
  });

  const effectiveModel = model || cfg.defaultModel;
  const startTime = Date.now();

  const params = {
    model: effectiveModel,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    temperature: 0.7,
    max_tokens:  2000,
  };

  let fullText  = '';
  let toolCalls = [];
  let usage     = { prompt_tokens: 0, completion_tokens: 0 };

  if (stream && onChunk) {
    // ── 流式模式 ─────────────────────────────────────
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
    // ── 非流式模式 ───────────────────────────────────
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
 * 如果 OpenClaw 未配置，或 OpenClaw 不支持 embeddings，
 * 则回退到直接调用 OpenAI。
 */
async function createEmbedding(text) {
  const { OpenAI } = require('openai');
  const cfg = getOpenClawConfig();

  // 优先走 OpenClaw（若已配置）
  const useOpenClaw = isOpenClawConfigured();
  const client = useOpenClaw
    ? new OpenAI({ apiKey: cfg.token, baseURL: `${cfg.url}/v1` })
    : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const res = await client.embeddings.create({
    model: useOpenClaw ? (process.env.OPENCLAW_EMBED_MODEL || 'text-embedding-3-small') : 'text-embedding-3-small',
    input: text,
  });
  return res.data[0].embedding;
}

module.exports = { callOpenClaw, createEmbedding, isOpenClawConfigured, getOpenClawConfig };
