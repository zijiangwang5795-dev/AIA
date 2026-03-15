'use strict';
const { query } = require('../db/client');
const { optionalAuth } = require('../auth/middleware');

module.exports = async function feedbackRoutes(app) {

  // ── 提交反馈 ──────────────────────────────────────
  app.post('/feedback', {
    preHandler: [optionalAuth],
  }, async (req, reply) => {
    const userId = req.userId || null;
    const { type = 'general', content, contactInfo, appVersion, platform = 'web' } = req.body || {};

    if (!content || content.trim().length < 5) {
      return reply.code(400).send({ error: '反馈内容不能少于 5 个字符' });
    }
    if (content.length > 2000) {
      return reply.code(400).send({ error: '反馈内容不能超过 2000 字符' });
    }
    if (!['bug', 'feature', 'general'].includes(type)) {
      return reply.code(400).send({ error: 'type must be bug/feature/general' });
    }

    const res = await query(`
      INSERT INTO feedback (user_id, type, content, contact_info, app_version, platform)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, created_at
    `, [userId, type, content.trim(), contactInfo || null, appVersion || null, platform]);

    return {
      success: true,
      id: res.rows[0].id,
      message: '感谢您的反馈！我们会认真查看每一条建议。',
    };
  });

  // ── 获取用户自己的反馈历史 ────────────────────────
  app.get('/feedback/mine', {
    preHandler: [require('../auth/middleware').authMiddleware],
  }, async (req, reply) => {
    const res = await query(`
      SELECT id, type, content, status, created_at
      FROM feedback
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 20
    `, [req.userId]);
    return { feedbacks: res.rows };
  });
};
