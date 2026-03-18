'use strict';

// ── 运行时配置（内存级，重启后重置）───────────────────
// 可通过 Admin API 在不重启服务的情况下覆盖 .env 默认值
// 优先级：runtimeConfig > process.env

const _cfg = {
  // OpenClaw 网关（优先级最高，所有 AI 调用经此路由）
  openclawUrl:   null,   // OpenClaw 服务地址，如 http://192.168.1.100:18789
  openclawToken: null,   // OpenClaw 认证 token（gateway.auth.mode 启用时需要）
  openclawMode:  null,   // 'dedicated'（每用户独占实例）或 'shared'（多用户共享实例+agentId）

  // AI API（直连模式降级用，OpenClaw 已配置时不生效）
  aiBaseUrl:    null,   // 覆盖 DeepSeek/OpenAI base URL
  aiApiKey:     null,   // 覆盖 API Key（优先于 env 中各 provider key）
  aiModel:      null,   // 覆盖默认模型名称

  // 后端自身（供前端读取当前监听端口，不影响后端实际监听）
  backendUrl:   null,   // 记录前端配置的后端地址（回写用）
  backendPort:  null,
};

function getRuntimeConfig() {
  return { ..._cfg };
}

function setRuntimeConfig(updates = {}) {
  const allowed = ['openclawUrl', 'openclawToken', 'openclawMode', 'aiBaseUrl', 'aiApiKey', 'aiModel', 'backendUrl', 'backendPort'];
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(updates, k)) {
      _cfg[k] = updates[k] || null;
    }
  }
}

// 辅助：获取当前有效的 AI API Key（runtimeConfig 优先）
function resolveApiKey(model) {
  if (_cfg.aiApiKey) return _cfg.aiApiKey;
  if (!model) return null;
  if (model.startsWith('deepseek')) return process.env.DEEPSEEK_API_KEY || null;
  if (model.startsWith('claude'))   return process.env.ANTHROPIC_API_KEY || null;
  return process.env.OPENAI_API_KEY || null;
}

// 辅助：获取当前有效的 AI Base URL（runtimeConfig 优先）
function resolveBaseUrl(model) {
  if (_cfg.aiBaseUrl) return _cfg.aiBaseUrl;
  if (!model) return undefined;  // 让 OpenAI SDK 使用默认值
  if (model.startsWith('deepseek')) return 'https://api.deepseek.com';
  if (model.startsWith('claude'))   return undefined;  // Anthropic SDK，不用 baseURL
  return undefined;  // OpenAI 原生 SDK 默认 api.openai.com
}

module.exports = { getRuntimeConfig, setRuntimeConfig, resolveApiKey, resolveBaseUrl };
