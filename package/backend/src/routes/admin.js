'use strict';
const { getRuntimeConfig, setRuntimeConfig } = require('../config/runtime');

// 辅助：掩码 API Key，仅显示首 4 位和末 4 位
function maskKey(key) {
  if (!key || key.length < 10) return key ? '****' : '';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

module.exports = async function adminRoutes(app) {

  const auth = async (req, reply) => {
    try { await req.jwtVerify(); }
    catch { reply.code(401).send({ error: 'Unauthorized' }); }
  };

  // ── GET /admin/config — 读取当前运行时配置（Key 已掩码）
  app.get('/config', { preHandler: [auth] }, async () => {
    const cfg = getRuntimeConfig();
    return {
      aiBaseUrl:   cfg.aiBaseUrl   || '',
      aiApiKey:    maskKey(cfg.aiApiKey),   // 不回传明文 key
      aiModel:     cfg.aiModel     || '',
      backendUrl:  cfg.backendUrl  || '',
      backendPort: cfg.backendPort || '',
      // 当前进程实际监听端口（供前端参考）
      serverPort: process.env.PORT || '3000',
    };
  });

  // ── PUT /admin/config — 更新运行时配置
  // aiApiKey 为空字符串时不覆盖（保留原值），传 '__clear__' 时清空
  app.put('/config', { preHandler: [auth] }, async (req, reply) => {
    const { aiBaseUrl, aiApiKey, aiModel, backendUrl, backendPort } = req.body || {};

    const updates = {};
    if (aiBaseUrl   !== undefined) updates.aiBaseUrl   = aiBaseUrl   || null;
    if (aiModel     !== undefined) updates.aiModel     = aiModel     || null;
    if (backendUrl  !== undefined) updates.backendUrl  = backendUrl  || null;
    if (backendPort !== undefined) updates.backendPort = backendPort || null;

    // API Key 特殊处理：空字符串 = 不改动，'__clear__' = 清空
    if (aiApiKey !== undefined) {
      if (aiApiKey === '__clear__') updates.aiApiKey = null;
      else if (aiApiKey.trim()) updates.aiApiKey = aiApiKey.trim();
      // 否则不更新
    }

    setRuntimeConfig(updates);

    const cfg = getRuntimeConfig();
    return {
      ok: true,
      aiBaseUrl:   cfg.aiBaseUrl  || '',
      aiApiKey:    maskKey(cfg.aiApiKey),
      aiModel:     cfg.aiModel    || '',
      backendUrl:  cfg.backendUrl || '',
      backendPort: cfg.backendPort|| '',
    };
  });

  // ── DELETE /admin/config — 清空所有运行时覆盖（恢复 .env 默认）
  app.delete('/config', { preHandler: [auth] }, async () => {
    setRuntimeConfig({ aiBaseUrl: null, aiApiKey: null, aiModel: null,
      backendUrl: null, backendPort: null });
    return { ok: true, message: '运行时配置已重置为 .env 默认值' };
  });
};
