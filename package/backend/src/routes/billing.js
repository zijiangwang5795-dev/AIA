'use strict';
const { query } = require('../db/client');
const { requireAuth } = require('../auth/middleware');
const { getUserPlan, getMonthlyUsage } = require('../middleware/quota');

module.exports = async function billingRoutes(app) {

  // ── 获取所有计划列表 ──────────────────────────────
  app.get('/plans', async (req, reply) => {
    const res = await query(
      'SELECT id, name, price_cny, price_usd, monthly_ai_calls, max_skills, max_memory_mb, features FROM plans WHERE is_active=TRUE ORDER BY price_usd ASC'
    );
    return { plans: res.rows };
  });

  // ── 获取当前用户订阅状态 & 本月用量 ──────────────
  app.get('/subscription', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const userId = req.userId;

    const [plan, used] = await Promise.all([
      getUserPlan(userId),
      getMonthlyUsage(userId),
    ]);

    // 获取当前订阅记录（含到期时间）
    const subRes = await query(`
      SELECT us.plan_id, us.status, us.period_start, us.period_end, us.payment_method
      FROM user_subscriptions us
      WHERE us.user_id = $1 AND us.status = 'active'
      LIMIT 1
    `, [userId]);

    const sub = subRes.rows[0] || null;
    const limit = plan.monthly_ai_calls;
    const pct = limit === -1 ? 0 : Math.min(100, Math.round(used / limit * 100));

    return {
      plan,
      subscription: sub,
      usage: {
        used,
        limit,
        pct,
        year_month: new Date().toISOString().slice(0, 7),
      },
    };
  });

  // ── 本月详细用量统计 ──────────────────────────────
  app.get('/subscription/usage-detail', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const userId = req.userId;
    // 最近 6 个月历史
    const res = await query(`
      SELECT year_month, ai_calls, input_tokens, output_tokens, cost_usd
      FROM monthly_usage
      WHERE user_id = $1
      ORDER BY year_month DESC
      LIMIT 6
    `, [userId]);
    return { history: res.rows };
  });

  // ── 升级订阅（创建支付订单）──────────────────────
  // 生产环境：对接 Stripe / 支付宝 / 微信支付
  // 当前：mock 实现，直接激活（方便测试）
  app.post('/subscription/upgrade', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const userId = req.userId;
    const { planId, paymentMethod = 'mock' } = req.body || {};

    if (!planId) return reply.code(400).send({ error: 'planId required' });

    const planRes = await query('SELECT * FROM plans WHERE id=$1 AND is_active=TRUE', [planId]);
    if (!planRes.rows.length) return reply.code(404).send({ error: 'Plan not found' });

    const plan = planRes.rows[0];

    // TODO 生产环境：在此创建第三方支付订单，返回支付 URL
    // const payUrl = await createStripeSession(userId, plan);
    // return { payUrl };

    // Mock：直接激活订阅（演示用）
    const periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    await query(`
      INSERT INTO user_subscriptions (user_id, plan_id, status, period_start, period_end, payment_method)
      VALUES ($1, $2, 'active', NOW(), $3, $4)
      ON CONFLICT (user_id) DO UPDATE SET
        plan_id        = EXCLUDED.plan_id,
        status         = 'active',
        period_start   = NOW(),
        period_end     = EXCLUDED.period_end,
        payment_method = EXCLUDED.payment_method
    `, [userId, planId, periodEnd.toISOString(), paymentMethod]);

    return {
      success: true,
      message: `已升级至 ${plan.name}`,
      plan: { id: plan.id, name: plan.name },
      period_end: periodEnd.toISOString(),
    };
  });

  // ── 取消订阅 ──────────────────────────────────────
  app.post('/subscription/cancel', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const userId = req.userId;
    await query(
      "UPDATE user_subscriptions SET status='cancelled' WHERE user_id=$1 AND status='active'",
      [userId]
    );
    return { success: true, message: '订阅已取消，当前周期内仍可正常使用' };
  });

  // ── Webhook（支付回调）────────────────────────────
  // 生产环境需验证签名（Stripe-Signature / 支付宝 RSA）
  app.post('/webhook/payment', async (req, reply) => {
    const { event, userId, planId, externalId } = req.body || {};
    app.log.info('Payment webhook:', { event, userId, planId });

    if (event === 'payment.success') {
      const periodEnd = new Date();
      periodEnd.setMonth(periodEnd.getMonth() + 1);

      await query(`
        INSERT INTO user_subscriptions (user_id, plan_id, status, period_end, external_subscription_id)
        VALUES ($1, $2, 'active', $3, $4)
        ON CONFLICT (user_id) DO UPDATE SET
          plan_id = EXCLUDED.plan_id,
          status  = 'active',
          period_end = EXCLUDED.period_end,
          external_subscription_id = EXCLUDED.external_subscription_id
      `, [userId, planId, periodEnd.toISOString(), externalId || null]);
    }

    return { received: true };
  });
};
