'use strict';
/**
 * 配额中间件：在每次 AI 调用前检查用户是否超出月度配额
 * 超出时返回 429 并提示升级
 */
const { query } = require('../db/client');

/**
 * 获取用户当前订阅计划（无订阅则返回 free 计划）
 */
async function getUserPlan(userId) {
  if (!userId) return getFreePlan();

  const res = await query(`
    SELECT p.id, p.name, p.monthly_ai_calls, p.max_skills, p.features
    FROM user_subscriptions us
    JOIN plans p ON p.id = us.plan_id
    WHERE us.user_id = $1
      AND us.status = 'active'
      AND (us.period_end IS NULL OR us.period_end > NOW())
    LIMIT 1
  `, [userId]);

  return res.rows[0] || getFreePlan();
}

function getFreePlan() {
  return {
    id: 'free',
    name: '免费版',
    monthly_ai_calls: 100,
    max_skills: 5,
    features: { voice: true, friends: true, custom_soul: false },
  };
}

/**
 * 获取本月已用 AI 调用次数
 */
async function getMonthlyUsage(userId) {
  if (!userId) return 0;
  const ym = new Date().toISOString().slice(0, 7); // '2026-03'
  const res = await query(
    'SELECT ai_calls FROM monthly_usage WHERE user_id=$1 AND year_month=$2',
    [userId, ym]
  );
  return res.rows[0]?.ai_calls || 0;
}

/**
 * 增加月度调用计数（在 AI 调用完成后执行）
 */
async function incrementUsage(userId, inputTokens = 0, outputTokens = 0, costUsd = 0) {
  if (!userId) return;
  const ym = new Date().toISOString().slice(0, 7);
  await query(`
    INSERT INTO monthly_usage (user_id, year_month, ai_calls, input_tokens, output_tokens, cost_usd)
    VALUES ($1, $2, 1, $3, $4, $5)
    ON CONFLICT (user_id, year_month) DO UPDATE SET
      ai_calls      = monthly_usage.ai_calls + 1,
      input_tokens  = monthly_usage.input_tokens + $3,
      output_tokens = monthly_usage.output_tokens + $4,
      cost_usd      = monthly_usage.cost_usd + $5
  `, [userId, ym, inputTokens, outputTokens, costUsd]);
}

/**
 * Fastify preHandler：检查配额后放行或拒绝
 */
async function checkQuota(req, reply) {
  const userId = req.userId;
  if (!userId) return; // 未登录用户使用 demo 配额，不强制拦截

  try {
    const [plan, used] = await Promise.all([
      getUserPlan(userId),
      getMonthlyUsage(userId),
    ]);

    // -1 表示无限制（企业版）
    if (plan.monthly_ai_calls !== -1 && used >= plan.monthly_ai_calls) {
      return reply.code(429).send({
        error: 'quota_exceeded',
        message: `本月 AI 调用次数已达上限（${plan.monthly_ai_calls} 次）`,
        plan: plan.id,
        used,
        limit: plan.monthly_ai_calls,
        upgrade_url: '/subscription',
      });
    }

    // 将计划信息挂到 req 上，供后续使用
    req.userPlan = plan;
    req.monthlyUsed = used;
  } catch (err) {
    // 配额检查出错时放行（不阻塞用户），记录日志
    req.log.warn('Quota check failed:', err.message);
  }
}

module.exports = { checkQuota, getUserPlan, getMonthlyUsage, incrementUsage };
