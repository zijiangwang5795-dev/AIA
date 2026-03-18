'use strict';

/**
 * Layer 2 Agent Executor
 *
 * 所有 LLM 推理请求统一经由 OpenClaw 网关处理，不再直接调用
 * DeepSeek / OpenAI / Anthropic API。
 *
 * 数据流：
 *   Backend (runAgent) → OpenClaw Gateway → AI 模型
 *                ↑ 工具执行结果
 *   executeTool (DB / 搜索 / 计算) ← Backend
 *   client_action SSE ← 客户端本地技能
 */

const { v4: uuid } = require('uuid');
const { query }   = require('../../db/client');
const { assembleSystemPrompt } = require('../../personality/assembler');
const { executeTool, getToolDefs } = require('../../tools/registry');
const { callOpenClaw, createEmbedding, isOpenClawConfigured } = require('../openclaw/client');
const { getRuntimeConfig } = require('../../config/runtime');

// ── 主 Agent 执行器 ───────────────────────────────────
async function runAgent({
  userId, text, toolNames, model, routingRule, intent, send,
  clientToolDefs = [], clientToolNames = new Set(),
  skillId = null, skillName = null,
}) {
  const runId    = `run_${uuid().slice(0, 8)}`;
  const MAX_STEPS = 8;
  const messages  = [];
  let totalInputTokens  = 0;
  let totalOutputTokens = 0;
  const startTime = Date.now();
  // 收集步骤事件（tool_start/tool_done/step/error 类型）
  const runSteps = [];
  const sendAndRecord = (data) => {
    send(data);
    if (['step', 'tool_start', 'tool_done', 'client_action', 'error', 'done'].includes(data.type)) {
      runSteps.push({ ...data, _t: Date.now() - startTime });
    }
  };

  // 记录运行开始
  try {
    await query(
      `INSERT INTO agent_runs (run_id, user_id, goal, status, skill_name) VALUES ($1,$2,$3,'running',$4)`,
      [runId, userId, text, skillName || null]
    );
  } catch { /* 数据库不可用时继续 */ }

  // 组装系统提示（人格层，含长期记忆 + 情节记忆）
  sendAndRecord({ type: 'step', step: 1, label: '人格层加载中...' });
  const systemPrompt = await assembleSystemPrompt(userId, text);

  // 第一层处理完成，通知前端
  const gateway = isOpenClawConfigured() ? 'OpenClaw 网关' : '直连大模型';
  sendAndRecord({ type: 'step', step: 2, label: `意图：${intent}，模型：${model}，路由：${gateway}` });

  // 获取工具定义（服务端工具 + 客户端上报的本地技能）
  const tools = [
    ...getToolDefs(toolNames || ['create_tasks', 'memory_search']),
    ...clientToolDefs,
  ];

  // 初始用户消息
  messages.push({ role: 'user', content: text });

  // ── ReAct 循环（通过 OpenClaw 网关调用 AI）──────────
  for (let step = 0; step < MAX_STEPS; step++) {
    sendAndRecord({ type: 'step', step: step + 3, label: `第 ${step + 1} 轮推理（OpenClaw）...` });

    // 使用运行时配置覆盖模型（调试用）
    const rt = getRuntimeConfig();
    const effectiveModel = rt.aiModel || model;

    const result = await callOpenClaw({
      model:        effectiveModel,
      systemPrompt,
      messages,
      tools,
      stream:       true,
      onChunk:      (chunk) => send(chunk),
      userId,       // 用于 dedicated/shared 模式路由
    });

    totalInputTokens  += result.usage?.prompt_tokens    || 0;
    totalOutputTokens += result.usage?.completion_tokens || 0;

    // 没有 Tool 调用 → 完成
    if (!result.finishWithTools || !result.toolCalls.length) {
      messages.push({ role: 'assistant', content: result.text });
      break;
    }

    // 记录 assistant 的 tool_calls
    messages.push({
      role:       'assistant',
      content:    result.text || null,
      tool_calls: result.toolCalls.map(tc => ({
        id:       tc.id,
        type:     'function',
        function: { name: tc.name, arguments: tc.args },
      })),
    });

    // ── 执行每个工具 ─────────────────────────────────
    for (const tc of result.toolCalls) {
      let parsedArgs = {};
      try { parsedArgs = JSON.parse(tc.args); } catch { parsedArgs = {}; }

      sendAndRecord({ type: 'tool_start', name: tc.name, args: parsedArgs });

      let toolResult;
      if (clientToolNames.has(tc.name)) {
        // 客户端技能：下发给前端执行（闹钟、日历、电话等）
        sendAndRecord({ type: 'client_action', name: tc.name, args: parsedArgs });
        toolResult = { dispatched: true, message: `指令已下发至客户端执行：${tc.name}` };
      } else {
        try {
          toolResult = await executeTool(tc.name, parsedArgs, { userId, runId });
        } catch (err) {
          toolResult = { error: err.message };
        }
      }

      sendAndRecord({ type: 'tool_done', name: tc.name, result: toolResult });

      // 任务提取事件
      if (tc.name === 'create_tasks' && toolResult.tasks) {
        send({ type: 'task_extract', tasks: toolResult.tasks, summary: toolResult.summary });
      }

      messages.push({
        role:         'tool',
        tool_call_id: tc.id,
        content:      JSON.stringify(toolResult),
      });
    }
  }

  // ── 收尾 ─────────────────────────────────────────────
  const totalLatency = Date.now() - startTime;

  // 估算费用（通过 OpenClaw 路由后，实际费用由 OpenClaw 侧计算）
  const COST = {
    'deepseek-chat':     { i: 0.00014, o: 0.00028 },
    'deepseek-reasoner': { i: 0.00055, o: 0.00219 },
    'gpt-4o-mini':       { i: 0.00015, o: 0.0006  },
    'claude-3-5-haiku':  { i: 0.0008,  o: 0.004   },
    'claude-sonnet-4-6': { i: 0.003,   o: 0.015   },
  };
  const c = COST[model] || { i: 0.0001, o: 0.0002 };
  const costUsd = (totalInputTokens * c.i + totalOutputTokens * c.o) / 1000;

  // 写审计日志 + 保存步骤快照
  try {
    await query(
      `INSERT INTO ai_audit_logs
         (user_id, run_id, model, routing_rule, intent, input_tokens, output_tokens, latency_ms, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [userId, runId, model, routingRule, intent, totalInputTokens, totalOutputTokens, totalLatency, costUsd]
    );
    await query(
      `UPDATE agent_runs SET status='done', total_steps=$1, completed_at=NOW(), run_steps=$2::jsonb WHERE run_id=$3`,
      [messages.length, JSON.stringify(runSteps), runId]
    );
  } catch { /* 数据库不可用 */ }

  // 异步摘要到情节记忆（也经 OpenClaw）
  setImmediate(() => summarizeToEpisodic(runId, userId, messages).catch(() => {}));

  sendAndRecord({
    type:        'done',
    runId,
    totalTokens: totalInputTokens + totalOutputTokens,
    latencyMs:   totalLatency,
    costUsd:     costUsd.toFixed(6),
    model,
    gateway:     'openclaw',
  });
}

// ── 异步摘要到情节记忆（通过 OpenClaw）───────────────
async function summarizeToEpisodic(runId, userId, messages) {
  // OpenClaw 未配置且无任何 LLM key 时跳过
  if (!isOpenClawConfigured() && !process.env.DEEPSEEK_API_KEY && !process.env.OPENAI_API_KEY) return;

  const recent = messages.slice(-6).map(m =>
    `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 200) : '[tool]'}`
  ).join('\n');

  try {
    let summary = '';

    if (isOpenClawConfigured()) {
      // 优先通过 OpenClaw 生成摘要
      const result = await callOpenClaw({
        model:        process.env.OPENCLAW_DEFAULT_MODEL || 'deepseek-chat',
        systemPrompt: '你是一个对话摘要助手，用简洁中文总结对话。',
        messages:     [{ role: 'user', content: `用1-2句话总结这次对话的目标和结果（中文）：\n${recent}` }],
        stream:       false,
        userId,
      });
      summary = result.text || '';
    } else {
      // 降级：直接调用 LLM（无 OpenClaw 时兼容旧逻辑）
      const { OpenAI } = require('openai');
      const isDeepSeek = !!process.env.DEEPSEEK_API_KEY;
      const client = new OpenAI({
        apiKey:  isDeepSeek ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY,
        baseURL: isDeepSeek ? 'https://api.deepseek.com' : undefined,
      });
      const res = await client.chat.completions.create({
        model:      isDeepSeek ? 'deepseek-chat' : 'gpt-4o-mini',
        messages:   [{ role: 'user', content: `用1-2句话总结这次对话的目标和结果（中文）：\n${recent}` }],
        max_tokens: 150,
      });
      summary = res.choices[0]?.message?.content || '';
    }

    if (!summary) return;

    // 生成 embedding（经 OpenClaw 网关或直接 OpenAI）
    try {
      const embedding = await createEmbedding(summary, userId);
      await query(
        `INSERT INTO episodic_memories (user_id, summary, embedding, run_id) VALUES ($1,$2,$3::vector,$4)`,
        [userId, summary, JSON.stringify(embedding), runId]
      );
    } catch {
      // embedding 不可用时，纯文本存储
      await query(
        `INSERT INTO episodic_memories (user_id, summary, run_id) VALUES ($1,$2,$3)`,
        [userId, summary, runId]
      );
    }
  } catch { /* 摘要失败不影响主流程 */ }
}

module.exports = { runAgent };
