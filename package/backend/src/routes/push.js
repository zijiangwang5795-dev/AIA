'use strict';
const { query } = require('../db/client');
const { authMiddleware: requireAuth } = require('../auth/middleware');

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

  // ── 轮询通知（替代 FCM，Android 客户端定期拉取）──
  app.get('/notifications/poll', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const userId = req.userId;
    const since = parseInt(req.query.since || '0', 10);
    const sinceTs = since > 0 ? new Date(since).toISOString() : new Date(Date.now() - 3600_000).toISOString();

    const notifications = [];

    // 1. 未读消息
    const msgs = await query(`
      SELECT m.content, u.display_name, u.assistant_name
      FROM messages m
      JOIN users u ON u.id = m.from_user_id
      WHERE m.to_user_id = $1
        AND m.read_at IS NULL
        AND m.created_at > $2
      ORDER BY m.created_at ASC
      LIMIT 10
    `, [userId, sinceTs]);

    for (const row of msgs.rows) {
      const sender = row.assistant_name || row.display_name || '好友';
      notifications.push({
        type: 'friend_msg',
        title: sender + ' 发来消息',
        body: row.content.slice(0, 80),
        nav_target: 'friends',
      });
    }

    // 2. 即将到期任务提醒（未来2小时内 deadline，状态 pending）
    const tasks = await query(`
      SELECT title FROM tasks
      WHERE user_id = $1
        AND status = 'pending'
        AND deadline IS NOT NULL
        AND created_at > $2
      ORDER BY created_at ASC
      LIMIT 5
    `, [userId, sinceTs]);

    for (const row of tasks.rows) {
      notifications.push({
        type: 'task_reminder',
        title: '新任务',
        body: row.title,
        nav_target: 'tasks',
      });
    }

    return { notifications };
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
