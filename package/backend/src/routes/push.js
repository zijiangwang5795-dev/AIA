'use strict';
const { query } = require('../db/client');
const { requireAuth } = require('../auth/middleware');

module.exports = async function pushRoutes(app) {

  // ── 注册推送令牌 ──────────────────────────────────
  app.post('/push/register', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const userId = req.userId;
    const { token, platform = 'android', deviceTag } = req.body || {};

    if (!token) return reply.code(400).send({ error: 'token required' });

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
  }, async (req, reply) => {
    const { token } = req.body || {};
    if (!token) return reply.code(400).send({ error: 'token required' });
    await query('DELETE FROM push_tokens WHERE token=$1 AND user_id=$2', [token, req.userId]);
    return { success: true };
  });

  // ── 发送推送通知（内部接口，可供定时任务调用）────
  // 生产环境：调用 Firebase Admin SDK / APNs
  app.post('/push/send', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const { targetUserId, title, body, data } = req.body || {};
    if (!targetUserId || !title) return reply.code(400).send({ error: 'targetUserId and title required' });

    // 获取目标用户所有推送令牌
    const tokensRes = await query(
      'SELECT token, platform FROM push_tokens WHERE user_id=$1',
      [targetUserId]
    );

    if (!tokensRes.rows.length) {
      return { sent: 0, message: '目标用户无推送令牌' };
    }

    // TODO 生产环境：接入 FCM / APNs
    // await Promise.all(tokensRes.rows.map(({ token, platform }) =>
    //   platform === 'android' ? sendFCM(token, title, body, data) : sendAPNs(token, title, body, data)
    // ));

    app.log.info(`[Push] Would send to ${tokensRes.rows.length} device(s): ${title}`);
    return { sent: tokensRes.rows.length, tokens: tokensRes.rows.map(r => r.platform) };
  });
};
