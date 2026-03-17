'use strict';
const { query } = require('../db/client');
const { authMiddleware: requireAuth } = require('../auth/middleware');
const { getUserPlan, getMonthlyUsage } = require('../middleware/quota');
const { resolveUserConfig } = require('../brain/openclaw/client');

// ── Stripe 初始化（仅在配置了 key 时启用）────────────
let stripe = null;
function getStripe() {
  if (stripe) return stripe;
  if (!process.env.STRIPE_SECRET_KEY) return null;
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  return stripe;
}

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
    const res = await query(`
      SELECT year_month, ai_calls, input_tokens, output_tokens, cost_usd
      FROM monthly_usage
      WHERE user_id = $1
      ORDER BY year_month DESC
      LIMIT 6
    `, [userId]);
    return { history: res.rows };
  });

  // ── 创建支付订单 ──────────────────────────────────
  // Stripe Checkout Session → 返回支付 URL，前端跳转
  // 未配置 Stripe 时降级为 Mock（方便开发/演示）
  app.post('/subscription/upgrade', {
    preHandler: [requireAuth],
    schema: {
      body: {
        type: 'object',
        required: ['planId'],
        properties: {
          planId:        { type: 'string' },
          paymentMethod: { type: 'string' },
          successUrl:    { type: 'string' },
          cancelUrl:     { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const userId = req.userId;
    const {
      planId,
      paymentMethod = 'stripe',
      successUrl = `${process.env.APP_URL || 'http://localhost:3000'}/?payment=success`,
      cancelUrl  = `${process.env.APP_URL || 'http://localhost:3000'}/?payment=cancel`,
    } = req.body;

    const planRes = await query('SELECT * FROM plans WHERE id=$1 AND is_active=TRUE', [planId]);
    if (!planRes.rows.length) return reply.code(404).send({ error: 'Plan not found' });
    const plan = planRes.rows[0];

    // ── Stripe Checkout ──────────────────────────
    const stripeClient = getStripe();
    if (stripeClient && plan.price_usd > 0) {
      // 获取或创建 Stripe customer
      const userRes = await query('SELECT email, stripe_customer_id FROM users WHERE id=$1', [userId]);
      const user = userRes.rows[0] || {};

      let customerId = user.stripe_customer_id;
      if (!customerId) {
        const customer = await stripeClient.customers.create({
          metadata: { userId: String(userId) },
          ...(user.email ? { email: user.email } : {}),
        });
        customerId = customer.id;
        await query('UPDATE users SET stripe_customer_id=$1 WHERE id=$2', [customerId, userId]);
      }

      // 查找或创建 Stripe Price（按 plan.stripe_price_id 字段）
      const priceId = plan.stripe_price_id;
      if (!priceId) {
        return reply.code(500).send({ error: '该计划未配置 Stripe Price ID，请联系管理员' });
      }

      const session = await stripeClient.checkout.sessions.create({
        customer:   customerId,
        mode:       'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl + '&session_id={CHECKOUT_SESSION_ID}',
        cancel_url:  cancelUrl,
        metadata:   { userId: String(userId), planId: String(planId) },
        subscription_data: {
          metadata: { userId: String(userId), planId: String(planId) },
        },
      });

      return { checkoutUrl: session.url, sessionId: session.id };
    }

    // ── Mock（开发演示 / 免费计划升级）──────────────
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

    const openclawStatus = await resolveUserConfig(userId).catch(() => null);

    return {
      success: true,
      message: `已升级至 ${plan.name}（演示模式，无需支付）`,
      plan: { id: plan.id, name: plan.name },
      period_end: periodEnd.toISOString(),
      openclaw: {
        mode:                openclawStatus?.mode               || 'shared',
        dedicatedConfigured: openclawStatus?.dedicatedConfigured || false,
        setupRequired:       !openclawStatus?.dedicatedConfigured,
        setupUrl:            '/api/openclaw/config',
      },
    };
  });

  // ── 取消订阅 ──────────────────────────────────────
  app.post('/subscription/cancel', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const userId = req.userId;

    // 如有 Stripe 订阅，在 Stripe 侧取消（当期结束后生效）
    const subRes = await query(
      "SELECT external_subscription_id FROM user_subscriptions WHERE user_id=$1 AND status='active' LIMIT 1",
      [userId]
    );
    const extId = subRes.rows[0]?.external_subscription_id;

    const stripeClient = getStripe();
    if (stripeClient && extId) {
      await stripeClient.subscriptions.update(extId, { cancel_at_period_end: true }).catch(() => {});
    }

    await query(
      "UPDATE user_subscriptions SET status='cancelled' WHERE user_id=$1 AND status='active'",
      [userId]
    );
    return { success: true, message: '订阅已取消，当前周期内仍可正常使用' };
  });

  // ── Stripe Webhook（支付回调）────────────────────
  // 重要：此路由需要原始 request body（rawBody），在 Fastify 中需特殊配置
  // 使用 addContentTypeParser 接收 raw buffer 以验证签名
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: 65536 },
    (req, body, done) => {
      // 仅在 webhook 路由保留原始 buffer；其他路由继续正常解析
      if (req.routerPath === '/api/webhook/payment') {
        req.rawBody = body;
        try { done(null, JSON.parse(body.toString())); } catch (e) { done(e); }
      } else {
        try { done(null, JSON.parse(body.toString())); } catch (e) { done(e); }
      }
    }
  );

  app.post('/webhook/payment', async (req, reply) => {
    const stripeClient = getStripe();
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    // ── 有 Stripe 配置时验证签名 ─────────────────
    if (stripeClient && webhookSecret) {
      const sig = req.headers['stripe-signature'];
      if (!sig) {
        app.log.warn('[Webhook] Missing stripe-signature header');
        return reply.code(400).send({ error: 'Missing signature' });
      }
      try {
        // 使用原始 buffer 验证，防止 JSON 序列化改变签名
        const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
        const event = stripeClient.webhooks.constructEvent(rawBody, sig, webhookSecret);
        req.body = event;   // 替换为已验证的 event 对象
      } catch (err) {
        app.log.warn({ err: err.message }, '[Webhook] Stripe signature verification failed');
        return reply.code(400).send({ error: `Webhook signature verification failed: ${err.message}` });
      }
    }

    const event = req.body;
    app.log.info({ type: event.type }, '[Webhook] Received payment event');

    // ── 处理 Stripe 事件 ─────────────────────────
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data?.object;
        const userId  = session?.metadata?.userId;
        const planId  = session?.metadata?.planId;
        const extSubId = session?.subscription;

        if (userId && planId) {
          const periodEnd = new Date();
          periodEnd.setMonth(periodEnd.getMonth() + 1);
          await query(`
            INSERT INTO user_subscriptions (user_id, plan_id, status, period_start, period_end, payment_method, external_subscription_id)
            VALUES ($1, $2, 'active', NOW(), $3, 'stripe', $4)
            ON CONFLICT (user_id) DO UPDATE SET
              plan_id = EXCLUDED.plan_id,
              status  = 'active',
              period_start = NOW(),
              period_end   = EXCLUDED.period_end,
              payment_method = 'stripe',
              external_subscription_id = EXCLUDED.external_subscription_id
          `, [userId, planId, periodEnd.toISOString(), extSubId || null]);
          app.log.info({ userId, planId }, '[Webhook] Subscription activated via checkout.session.completed');
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data?.object;
        const subId   = invoice?.subscription;
        if (subId) {
          const periodEnd = invoice.lines?.data?.[0]?.period?.end
            ? new Date(invoice.lines.data[0].period.end * 1000)
            : (() => { const d = new Date(); d.setMonth(d.getMonth() + 1); return d; })();
          await query(`
            UPDATE user_subscriptions SET
              status = 'active',
              period_end = $1
            WHERE external_subscription_id = $2
          `, [periodEnd.toISOString(), subId]);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data?.object;
        if (sub?.id) {
          await query(
            "UPDATE user_subscriptions SET status='expired' WHERE external_subscription_id=$1",
            [sub.id]
          );
        }
        break;
      }

      // 通用回调（非 Stripe，如微信支付宝等）
      case undefined: {
        const { event: evtType, userId, planId, externalId } = req.body || {};
        if (evtType === 'payment.success' && userId && planId) {
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
        break;
      }

      default:
        app.log.info({ type: event.type }, '[Webhook] Unhandled event type');
    }

    return { received: true };
  });
};
