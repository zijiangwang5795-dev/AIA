'use strict';
const { query } = require('../db/client');
const { authMiddleware: requireAuth } = require('../auth/middleware');
const { sendPushToUser } = require('../services/push');

module.exports = async function pushRoutes(app) {

  // ── 注册推送令牌 ──────────────────────────────────
  app.post('/push/register', {
    preHandler: [requireAuth],
    schema: {
      body: {
        type: 'object',
        required: ['token'],
        properties: {
          token:     { type: 'string', minLength: 1, maxLength: 512 },
          platform:  { type: 'string', enum: ['android', 'ios', 'web'], default: 'android' },
          deviceTag: { type: 'string', maxLength: 128 },
        },
      },
    },
  }, async (req, reply) => {
    const userId = req.userId;
    const { token, platform = 'android', deviceTag } = req.body;

    await query(`
      INSERT INTO push_tokens (user_id, token, platform, device_tag)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (token) DO UPDATE SET
        user_id    = EXCLUDED.user_id,
        platform   = EXCLUDED.platform,
        device_tag = EXCLUDED.device_tag,
        created_at = NOW()
    `, [userId, token, platform, deviceTag || null]);

    return { success: true };
  });

  // ── 注销推送令牌（登出时调用）────────────────────
  app.delete('/push/token', {
    preHandler: [requireAuth],
    schema: {
      body: {
        type: 'object',
        required: ['token'],
        properties: { token: { type: 'string', minLength: 1 } },
      },
    },
  }, async (req, reply) => {
    const { token } = req.body;
    await query('DELETE FROM push_tokens WHERE token=$1 AND user_id=$2', [token, req.userId]);
    return { success: true };
  });

  // ── 发送推送通知（内部服务密钥保护，不对外暴露）──────
  // 仅供同主机后端服务调用，需在请求头携带 INTERNAL_API_SECRET
  // 推送逻辑主要通过 services/push.js 直接调用，此 HTTP 端点供集成测试 & 后台任务使用
  app.post('/push/send', {
    schema: {
      body: {
        type: 'object',
        required: ['targetUserId', 'title'],
        properties: {
          targetUserId: { type: 'string', minLength: 1, maxLength: 64 },
          title:        { type: 'string', minLength: 1, maxLength: 256 },
          body:         { type: 'string', maxLength: 1024 },
          data:         { type: 'object' },
        },
      },
    },
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    // 内部服务密钥校验（INTERNAL_API_SECRET 未配置时拒绝所有请求）
    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret) return reply.code(503).send({ error: 'Push send not available: INTERNAL_API_SECRET not configured' });
    if (req.headers['x-internal-secret'] !== secret) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const { targetUserId, title, body = '', data = {} } = req.body;
    const result = await sendPushToUser(targetUserId, { title, body, data });
    app.log.info({ targetUserId, title, sent: result.sent, failed: result.failed }, '[Push] sendPushToUser result');
    return result;
  });
};
