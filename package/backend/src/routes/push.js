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

  // ── 发送推送通知（内部接口，供后端服务调用）──────
  // 仅限已登录用户（避免滥用）；实际触发由 tool/registry.js 等内部逻辑驱动
  app.post('/push/send', {
    preHandler: [requireAuth],
    schema: {
      body: {
        type: 'object',
        required: ['targetUserId', 'title'],
        properties: {
          targetUserId: { type: 'string' },
          title:        { type: 'string', maxLength: 256 },
          body:         { type: 'string', maxLength: 1024 },
          data:         { type: 'object' },
        },
      },
    },
  }, async (req, reply) => {
    const { targetUserId, title, body = '', data = {} } = req.body;

    const result = await sendPushToUser(targetUserId, { title, body, data });
    app.log.info({ targetUserId, title, ...result }, '[Push] sendPushToUser result');

    return result;
  });
};
