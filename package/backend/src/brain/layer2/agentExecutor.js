'use strict';
const { v4: uuid } = require('uuid');
const { query } = require('../../db/client');
const { assembleSystemPrompt } = require('../../personality/assembler');
const { executeTool, getToolDefs } = require('../../tools/registry');

// ── 模型适配器（统一调用接口）───────────────────────
async function callLLM({ model, systemPrompt, messages, tools, stream, onChunk }) {
  const isDeepSeek = model.startsWith('deepseek');
  const isAnthropic = model.startsWith('claude');

  const apiKey = isDeepSeek
    ? process.env.DEEPSEEK_API_KEY
    : isAnthropic
      ? process.env.ANTHROPIC_API_KEY
      : process.env.OPENAI_API_KEY;

  if (!apiKey) throw new Error(`No API key configured for model: ${model}`);

  const baseURL = isDeepSeek ? 'https://api.deepseek.com' : 'https://api.openai.com';

  const { OpenAI } = require('openai');
  const client = new OpenAI({ apiKey, baseURL });

  const startTime = Date.now();
  const params = {
    model,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    temperature: 0.7,
    max_tokens: 2000,
  };

  let fullText = '';
  let toolCalls = [];
  let usage = { prompt_tokens: 0, completion_tokens: 0 };

  if (stream && onChunk) {
    // 流式模式
    const streamResponse = await client.chat.completions.create({ ...params, stream: true });
    const pendingToolCalls = {};

    for await (const chunk of streamResponse) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      // 文本内容流式推送
      if (delta.content) {
        fullText += delta.content;
        onChunk({ type: 'text', chunk: delta.content });
      }

      // Tool call 累积
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!pendingToolCalls[idx]) {
            pendingToolCalls[idx] = { id: tc.id, name: tc.function?.name || '', args: '' };
          }
          if (tc.function?.name) pendingToolCalls[idx].name = tc.function.name;
          if (tc.function?.arguments) pendingToolCalls[idx].args += tc.function.arguments;
        }
      }

      if (chunk.choices[0]?.finish_reason === 'stop' || chunk.choices[0]?.finish_reason === 'tool_calls') {
        toolCalls = Object.values(pendingToolCalls);
        break;
      }
    }
  } else {
    // 非流式模式
    const response = await client.chat.completions.create(params);
    fullText = response.choices[0]?.message?.content || '';
    toolCalls = (response.choices[0]?.message?.tool_calls || []).map(tc => ({
      id: tc.id,
      name: tc.function.name,
      args: tc.function.arguments,
    }));
    usage = response.usage || usage;
  }

  return {
    text: fullText,
    toolCalls,
    usage,
    latencyMs: Date.now() - startTime,
    finishWithTools: toolCalls.length > 0,
  };
}

// ── 主 Agent 执行器 ───────────────────────────────────
async function runAgent({ userId, text, toolNames, model, routingRule, intent, send }) {
  const runId = `run_${uuid().slice(0, 8)}`;
  const MAX_STEPS = 8;
  const messages = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const startTime = Date.now();

  // 记录运行开始
  try {
    await query(
      `INSERT INTO agent_runs (run_id, user_id, goal, status) VALUES ($1,$2,$3,'running')`,
      [runId, userId, text]
    );
  } catch { /* 数据库不可用时继续 */ }

  // 组装系统提示（人格层）
  send({ type: 'step', step: 1, label: '人格层加载中...' });
  const systemPrompt = await assembleSystemPrompt(userId, text);

  // 第一层处理完成，通知前端
  send({ type: 'step', step: 2, label: `意图：${intent}，模型：${model}` });

  // 获取工具定义
  const tools = getToolDefs(toolNames || ['create_tasks', 'memory_search']);

  // 初始用户消息
  messages.push({ role: 'user', content: text });

  // ── ReAct 循环 ──────────────────────────────────────
  for (let step = 0; step < MAX_STEPS; step++) {
    send({ type: 'step', step: step + 3, label: `第 ${step + 1} 轮推理...` });

    const result = await callLLM({
      model,
      systemPrompt,
      messages,
      tools,
      stream: true,
      onChunk: (chunk) => send(chunk),
    });

    totalInputTokens += result.usage?.prompt_tokens || 0;
    totalOutputTokens += result.usage?.completion_tokens || 0;

    // 没有 Tool 调用 → 完成
    if (!result.finishWithTools || !result.toolCalls.length) {
      messages.push({ role: 'assistant', content: result.text });
      break;
    }

    // 记录 assistant 的 tool_calls
    messages.push({
      role: 'assistant',
      content: result.text || null,
      tool_calls: result.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.args },
      })),
    });

    // ── 执行每个 Tool ────────────────────────────────
    for (const tc of result.toolCalls) {
      let parsedArgs = {};
      try { parsedArgs = JSON.parse(tc.args); } catch { parsedArgs = {}; }

      send({ type: 'tool_start', name: tc.name, args: parsedArgs });

      let toolResult;
      try {
        toolResult = await executeTool(tc.name, parsedArgs, { userId, runId });
      } catch (err) {
        toolResult = { error: err.message };
      }

      send({ type: 'tool_done', name: tc.name, result: toolResult });

      // 如果是 create_tasks，发送专门的任务事件
      if (tc.name === 'create_tasks' && toolResult.tasks) {
        send({ type: 'task_extract', tasks: toolResult.tasks, summary: toolResult.summary });
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(toolResult),
      });
    }
  }

  // ── 收尾 ─────────────────────────────────────────────
  const totalLatency = Date.now() - startTime;

  // 估算费用（简化版，实际以官方计费为准）
  const COST = {
    'deepseek-chat':     { i: 0.00014, o: 0.00028 },
    'deepseek-reasoner': { i: 0.00055, o: 0.00219 },
    'gpt-4o-mini':       { i: 0.00015, o: 0.0006 },
    'claude-3-5-haiku':  { i: 0.0008,  o: 0.004 },
  };
  const c = COST[model] || { i: 0.0001, o: 0.0002 };
  const costUsd = (totalInputTokens * c.i + totalOutputTokens * c.o) / 1000;

  // 写审计日志
  try {
    await query(
      `INSERT INTO ai_audit_logs (user_id, run_id, model, routing_rule, intent, input_tokens, output_tokens, latency_ms, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [userId, runId, model, routingRule, intent, totalInputTokens, totalOutputTokens, totalLatency, costUsd]
    );
    await query(
      `UPDATE agent_runs SET status='done', total_steps=$1, completed_at=NOW() WHERE run_id=$2`,
      [messages.length, runId]
    );
  } catch { /* 数据库不可用 */ }

  // 异步摘要到情节记忆
  setImmediate(() => summarizeToEpisodic(runId, userId, messages).catch(() => {}));

  send({
    type: 'done',
    runId,
    totalTokens: totalInputTokens + totalOutputTokens,
    latencyMs: totalLatency,
    costUsd: costUsd.toFixed(6),
    model,
  });
}

// ── 异步摘要到情节记忆 ────────────────────────────────
async function summarizeToEpisodic(runId, userId, messages) {
  if (!process.env.DEEPSEEK_API_KEY && !process.env.OPENAI_API_KEY) return;

  const recent = messages.slice(-6).map(m =>
    `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 200) : '[tool]'}`
  ).join('\n');

  try {
    const { OpenAI } = require('openai');
    const isDeepSeek = !!process.env.DEEPSEEK_API_KEY;
    const client = new OpenAI({
      apiKey: isDeepSeek ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY,
      baseURL: isDeepSeek ? 'https://api.deepseek.com' : undefined,
    });

    const res = await client.chat.completions.create({
      model: isDeepSeek ? 'deepseek-chat' : 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `用1-2句话总结这次对话的目标和结果（中文）：\n${recent}`,
      }],
      max_tokens: 150,
    });

    const summary = res.choices[0]?.message?.content || '';
    if (!summary) return;

    // 如果有 OpenAI Key，生成 embedding 存向量
    if (process.env.OPENAI_API_KEY) {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const embRes = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: summary,
      });
      await query(
        `INSERT INTO episodic_memories (user_id, summary, embedding, run_id) VALUES ($1,$2,$3::vector,$4)`,
        [userId, summary, JSON.stringify(embRes.data[0].embedding), runId]
      );
    } else {
      // 无 embedding，纯文本存储
      await query(
        `INSERT INTO episodic_memories (user_id, summary, run_id) VALUES ($1,$2,$3)`,
        [userId, summary, runId]
      );
    }
  } catch { /* 摘要失败不影响主流程 */ }
}

module.exports = { runAgent };
