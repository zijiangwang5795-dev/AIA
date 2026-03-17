'use strict';

/**
 * OpenClaw 配置路由
 *
 * GET  /api/openclaw/status   → 返回当前用户的 OpenClaw 接入状态
 * PUT  /api/openclaw/config   → 付费用户设置专属 OpenClaw 实例地址
 * DELETE /api/openclaw/config → 付费用户解除专属配置（回退共享）
 */

const { query }            = require('../db/client');
const { authMiddleware: requireAuth } = require('../auth/middleware');
const { resolveUserConfig, isOpenClawConfigured, syncAgentConfig } = require('../brain/openclaw/client');
const { buildStaticPersona } = require('../personality/assembler');
const { getUserPlan }      = require('../middleware/quota');

module.exports = async function openclawRoutes(app) {

  // ── 当前用户的 OpenClaw 接入状态 ──────────────────────
  app.get('/status', {
    preHandler: [requireAuth],
  }, async (req) => {
    const userId = req.userId;
    const [resolved, plan] = await Promise.all([
      resolveUserConfig(userId),
      getUserPlan(userId),
    ]);

    return {
      mode:               resolved.mode,              // 'shared' | 'dedicated'
      dedicatedConfigured: resolved.dedicatedConfigured,
      agentId:            resolved.agentId,           // null if dedicated
      isPaid:             plan.id !== 'free',
      planName:           plan.name,
      // 付费但未配置时提示引导
      setupRequired: plan.id !== 'free' && !resolved.dedicatedConfigured,
    };
  });

  // ── 配置专属 OpenClaw 实例（仅付费用户）──────────────
  app.put('/config', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const userId = req.userId;
    const { url, token } = req.body || {};

    if (!url) return reply.code(400).send({ error: 'url is required' });

    // 验证是否为付费用户
    const plan = await getUserPlan(userId);
    if (plan.id === 'free') {
      return reply.code(403).send({
        error: 'dedicated_openclaw_requires_paid_plan',
        message: '独占 OpenClaw 实例需要升级到付费计划',
        upgrade_url: '/subscription',
      });
    }

    // 简单格式校验
    try { new URL(url); } catch {
      return reply.code(400).send({ error: '无效的 URL 格式' });
    }

    // 存入 user_memories（特殊系统 key，以 _ 开头）
    await query(
      `INSERT INTO user_memories (user_id, key, value, updated_at)
       VALUES ($1, '_openclaw_url', $2, NOW())
       ON CONFLICT (user_id, key) DO UPDATE SET value=$2, updated_at=NOW()`,
      [userId, url]
    );

    if (token) {
      await query(
        `INSERT INTO user_memories (user_id, key, value, updated_at)
         VALUES ($1, '_openclaw_token', $2, NOW())
         ON CONFLICT (user_id, key) DO UPDATE SET value=$2, updated_at=NOW()`,
        [userId, token]
      );
    }

    // 立即将当前静态人格同步到新配置的实例
    const userRes = await query(
      `SELECT assistant_name, assistant_emoji, talent, soul_prompt, display_name, preferred_model FROM users WHERE id=$1`,
      [userId]
    );
    const u = userRes.rows[0];
    if (u) {
      const staticPersona = buildStaticPersona({
        assistantName: u.assistant_name || 'AI 助手',
        talent:        u.talent || 'default',
        soulPrompt:    u.soul_prompt,
        displayName:   u.display_name,
      });
      setImmediate(() =>
        syncAgentConfig(userId, {
          staticPersona,
          assistantName:  u.assistant_name || 'AI 助手',
          assistantEmoji: u.assistant_emoji || '🤖',
          model:          u.preferred_model,
        }).catch(() => {})
      );
    }

    return {
      success: true,
      message: '专属 OpenClaw 实例已配置，助手人格同步中…',
      mode: 'dedicated',
      url,
    };
  });

  // ── 解除专属配置（回退到共享）────────────────────────
  app.delete('/config', {
    preHandler: [requireAuth],
  }, async (req) => {
    const userId = req.userId;
    await query(
      `DELETE FROM user_memories WHERE user_id=$1 AND key IN ('_openclaw_url','_openclaw_token')`,
      [userId]
    );
    return {
      success: true,
      message: '已解除专属配置，回退到共享 OpenClaw 实例',
      mode: 'shared',
    };
  });
};
