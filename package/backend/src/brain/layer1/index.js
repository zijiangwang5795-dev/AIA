'use strict';
const { query } = require('../../db/client');

// ── 模型 → 所需 ENV Key 映射 ──────────────────────────
const MODEL_KEY_MAP = {
  'gpt-4o-mini':       'OPENAI_API_KEY',
  'gpt-4o':            'OPENAI_API_KEY',
  'deepseek-chat':     'DEEPSEEK_API_KEY',
  'deepseek-reasoner': 'DEEPSEEK_API_KEY',
  'claude-3-5-haiku':  'ANTHROPIC_API_KEY',
  'claude-sonnet-4-6': 'ANTHROPIC_API_KEY',
};

// Key 格式校验（基础合法性判断，非真实鉴权）
const KEY_VALIDATORS = {
  OPENAI_API_KEY:    (k) => /^sk-(proj-)?[A-Za-z0-9_-]{20,}$/.test(k),
  DEEPSEEK_API_KEY:  (k) => /^sk-[A-Za-z0-9_-]{20,}$/.test(k),
  ANTHROPIC_API_KEY: (k) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k),
  OPENCLAW_API_KEY:  (k) => typeof k === 'string' && k.trim().length >= 8,
};

// 检查某个模型是否可用（Key 存在且格式合法）
function isModelAvailable(model) {
  if (!model) return false;

  const { getRuntimeConfig } = require('../../config/runtime');
  const rt = getRuntimeConfig();

  // 运行时 aiApiKey 覆盖 → 所有模型均可用（直连任意 endpoint）
  if (rt.aiApiKey) return true;

  const { isOpenClawConfigured } = require('../openclaw/client');
  if (isOpenClawConfigured()) {
    // OpenClaw 网关模式：网关负责模型路由，本地无需持有 key
    // 但仅限已知模型列表，未知模型名可能导致网关报错
    return model in MODEL_KEY_MAP || model === (process.env.OPENCLAW_DEFAULT_MODEL || 'deepseek-chat');
  }

  // 直连模式：必须有对应厂商的 API Key 且格式合法
  const envKey = MODEL_KEY_MAP[model];
  if (!envKey) return false;  // 未知模型，直连时无法处理

  const keyValue = process.env[envKey];
  if (!keyValue) return false;

  const validate = KEY_VALIDATORS[envKey];
  return validate ? validate(keyValue) : keyValue.length > 0;
}

// 按候选顺序返回第一个可用模型
function pickAvailableModel(...candidates) {
  for (const m of candidates) {
    if (m && isModelAvailable(m)) return m;
  }
  return null;
}

// ── 意图分类规则 ─────────────────────────────────────
const INTENT_RULES = [
  // 社交：助手代发消息（最高优先级，关键词明确）
  { pattern: /帮我(告诉|通知|发消息给|发个消息给|转告|跟).+说|发消息给.+说|告诉.+说/, intent: 'send-friend-message', confidence: 0.95 },
  // 客户端本地技能（优先识别，因为关键词更具体）
  { pattern: /闹钟|定时提醒|提醒我.*(点|时)|(.*(点|时).*提醒|叫我)/, intent: 'client-alarm', confidence: 0.95 },
  { pattern: /日历|日程|会议|约.*(时间|见面)|添加.*日程|创建.*日程/, intent: 'client-calendar', confidence: 0.92 },
  { pattern: /打电话|拨打|给.*打电话|拨号/, intent: 'client-call', confidence: 0.95 },
  { pattern: /发短信|短信给|发条消息给/, intent: 'client-sms', confidence: 0.92 },
  // 后端技能
  { pattern: /提取|任务|待办|安排|记一下|记录|要做|需要做|帮我做/, intent: 'analyze-voice', confidence: 0.9 },
  { pattern: /AI.*(新闻|动态|资讯|进展)|今日热点|最新.*AI/, intent: 'ai-news', confidence: 0.9 },
  { pattern: /日报|周报|总结|汇报|报告/, intent: 'daily-brief', confidence: 0.9 },
  { pattern: /深度|分析一下|帮我想想|详细推理|深入/, intent: 'deep-analysis', confidence: 0.85 },
  { pattern: /计算|算一下|多少钱|统计|数学/, intent: 'calculate', confidence: 0.9 },
  { pattern: /搜索|查一下|找一下|查找|查询/, intent: 'web-search', confidence: 0.85 },
  { pattern: /记住|记下来|下次记得|偏好|习惯/, intent: 'save-memory', confidence: 0.85 },
];

// ── 模型路由规则（责任链，按 priority 升序）─────────
// 每条规则可带 fallbackModel，当 model 不可用时自动尝试
const ROUTING_RULES = [
  {
    name: 'needs-web-search',
    priority: 10,
    match: (ctx) => ctx.tools?.includes('web_search') || ctx.intent === 'web-search' || ctx.intent === 'ai-news',
    model: 'gpt-4o-mini',
    fallbackModel: 'deepseek-chat',
    reason: '需要联网搜索',
  },
  {
    name: 'deep-reasoning',
    priority: 20,
    match: (ctx) => ctx.intent === 'deep-analysis' || (ctx.agentSteps || 0) > 3,
    model: 'deepseek-reasoner',
    fallbackModel: 'deepseek-chat',
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
    // 用户偏好模型已在 step-3 过滤不可用情况，无需 fallback
    reason: '用户自定义模型偏好',
  },
  {
    name: 'fallback',
    priority: 999,
    match: () => true,
    model: 'deepseek-chat',
    fallbackModel: 'gpt-4o-mini',
    reason: '默认兜底模型',
  },
];

// ── 技能 → 工具映射 ──────────────────────────────────
const SKILL_TOOL_MAP = {
  'ai-news':        ['web_search', 'create_tasks', 'save_memory'],
  // analyze-voice 携带全量工具：AI 按能力自行决定直接执行还是存待办
  'analyze-voice':  ['create_tasks', 'send_friend_message', 'web_search', 'memory_search', 'save_memory'],
  'daily-brief':    ['memory_search', 'get_tasks'],
  'deep-analysis':  ['web_search', 'memory_search', 'calculator'],
  'client-alarm':   ['create_tasks'],
  'client-calendar':['create_tasks'],
  'client-call':    [],
  'client-sms':     [],
  'send-friend-message': ['send_friend_message', 'create_tasks', 'memory_search'],
  'default':        ['create_tasks', 'memory_search'],
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

  // 3. 获取用户偏好模型，并验证可用性
  let userPreferredModel = null;
  try {
    const res = await query(`SELECT preferred_model FROM users WHERE id=$1`, [userId]);
    const pref = res.rows[0]?.preferred_model || null;
    // 偏好模型需通过 key 可用性检查，否则忽略
    if (pref && isModelAvailable(pref)) {
      userPreferredModel = pref;
    }
  } catch { /* 数据库不可用 */ }

  // 4. 路由决策：按规则优先级遍历，找到第一个有可用模型的规则
  const routingCtx = {
    intent,
    tools,
    inputLen: text.length,
    agentSteps: options.agentSteps || 0,
    userPreferredModel,
  };

  const sortedRules = [...ROUTING_RULES].sort((a, b) => a.priority - b.priority);
  let selectedModel = null;
  let selectedRule = 'no-available-model';

  for (const rule of sortedRules) {
    if (!rule.match(routingCtx)) continue;

    const preferredModel = typeof rule.model === 'function'
      ? rule.model(routingCtx)
      : rule.model;

    const resolved = pickAvailableModel(preferredModel, rule.fallbackModel);
    if (resolved) {
      selectedModel = resolved;
      selectedRule = resolved === preferredModel ? rule.name : `${rule.name}→fallback`;
      break;
    }
    // 该规则匹配但模型均不可用，继续下一条规则
  }

  // 5. 最终兜底：从已知模型中取任意可用的
  if (!selectedModel) {
    selectedModel = Object.keys(MODEL_KEY_MAP).find(m => isModelAvailable(m))
      || 'deepseek-chat'; // OpenClaw 场景下 isModelAvailable 恒返回 true，会命中上面
    selectedRule = 'emergency-fallback';
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

module.exports = { layer1Process, INTENT_RULES, ROUTING_RULES, isModelAvailable, MODEL_KEY_MAP };
