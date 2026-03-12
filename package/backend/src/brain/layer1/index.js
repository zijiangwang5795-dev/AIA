'use strict';
const { query } = require('../../db/client');

// ── 意图分类规则 ─────────────────────────────────────
const INTENT_RULES = [
  { pattern: /提取|任务|待办|安排|记一下|记录|要做|需要做|帮我做/, intent: 'analyze-voice', confidence: 0.9 },
  { pattern: /AI.*(新闻|动态|资讯|进展)|今日热点|最新.*AI/, intent: 'ai-news', confidence: 0.9 },
  { pattern: /日报|周报|总结|汇报|报告/, intent: 'daily-brief', confidence: 0.9 },
  { pattern: /深度|分析一下|帮我想想|详细推理|深入/, intent: 'deep-analysis', confidence: 0.85 },
  { pattern: /计算|算一下|多少钱|统计|数学/, intent: 'calculate', confidence: 0.9 },
  { pattern: /搜索|查一下|找一下|查找|查询/, intent: 'web-search', confidence: 0.85 },
  { pattern: /记住|记下来|下次记得|偏好|习惯/, intent: 'save-memory', confidence: 0.85 },
];

// ── 模型路由规则（责任链，按 priority 升序）─────────
const ROUTING_RULES = [
  {
    name: 'needs-web-search',
    priority: 10,
    match: (ctx) => ctx.tools?.includes('web_search') || ctx.intent === 'web-search' || ctx.intent === 'ai-news',
    model: 'gpt-4o-mini',
    reason: '需要联网搜索',
  },
  {
    name: 'deep-reasoning',
    priority: 20,
    match: (ctx) => ctx.intent === 'deep-analysis' || (ctx.agentSteps || 0) > 3,
    model: 'deepseek-reasoner',
    reason: '多步推理，使用 R1 模型',
  },
  {
    name: 'short-text-cheap',
    priority: 30,
    match: (ctx) => ctx.inputLen < 200 && ctx.intent === 'calculate',
    model: 'deepseek-chat',
    reason: '短文本计算，经济模型',
  },
  {
    name: 'user-preference',
    priority: 40,
    match: (ctx) => !!ctx.userPreferredModel,
    model: (ctx) => ctx.userPreferredModel,
    reason: '用户自定义模型偏好',
  },
  {
    name: 'fallback',
    priority: 999,
    match: () => true,
    model: 'deepseek-chat',
    reason: '默认兜底模型',
  },
];

// ── 技能 → 工具映射 ──────────────────────────────────
const SKILL_TOOL_MAP = {
  'ai-news':      ['web_search', 'create_tasks', 'save_memory'],
  'analyze-voice':['create_tasks', 'memory_search', 'save_memory'],
  'daily-brief':  ['memory_search', 'get_tasks'],
  'deep-analysis':['web_search', 'memory_search', 'calculator'],
  'default':      ['create_tasks', 'memory_search'],
};

// ── 第一层大脑主处理函数 ─────────────────────────────
async function layer1Process(text, userId, options = {}) {
  const startTime = Date.now();

  // 1. 意图分类
  let intent = 'analyze-voice';
  let intentConfidence = 0.5;
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(text)) {
      intent = rule.intent;
      intentConfidence = rule.confidence;
      break;
    }
  }

  // 2. 确定工具集
  const skillType = options.skillType || intent;
  const tools = SKILL_TOOL_MAP[skillType] || SKILL_TOOL_MAP['default'];

  // 3. 获取用户偏好模型
  let userPreferredModel = null;
  try {
    const res = await query(`SELECT preferred_model FROM users WHERE id=$1`, [userId]);
    userPreferredModel = res.rows[0]?.preferred_model || null;
  } catch { /* 数据库不可用 */ }

  // 4. 路由决策
  const routingCtx = {
    intent,
    tools,
    inputLen: text.length,
    agentSteps: options.agentSteps || 0,
    userPreferredModel,
  };

  const routingRules = [...ROUTING_RULES].sort((a, b) => a.priority - b.priority);
  let selectedModel = 'deepseek-chat';
  let selectedRule = 'fallback';

  for (const rule of routingRules) {
    if (rule.match(routingCtx)) {
      selectedModel = typeof rule.model === 'function' ? rule.model(routingCtx) : rule.model;
      selectedRule = rule.name;
      break;
    }
  }

  // 5. 检查模型可用性（如果没有对应 Key，降级到 deepseek-chat）
  if (selectedModel === 'gpt-4o-mini' && !process.env.OPENAI_API_KEY) {
    selectedModel = 'deepseek-chat';
    selectedRule = 'fallback-no-openai-key';
  }
  if (selectedModel === 'deepseek-reasoner' && !process.env.DEEPSEEK_API_KEY) {
    selectedModel = 'deepseek-chat';
    selectedRule = 'fallback-no-key';
  }

  const processingMs = Date.now() - startTime;

  return {
    intent,
    intentConfidence,
    tools,
    selectedModel,
    selectedRule,
    processingMs,
  };
}

module.exports = { layer1Process, INTENT_RULES, ROUTING_RULES };
