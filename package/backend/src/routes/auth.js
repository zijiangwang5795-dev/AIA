'use strict';
const { query } = require('../db/client');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const axios = require('axios');
const { syncAgentConfig } = require('../brain/openclaw/client');
const { buildStaticPersona } = require('../personality/assembler');
const { sendSMS } = require('../services/sms');

// 手机号格式校验（支持 +86 前缀或纯 11 位数字）
const PHONE_RE = /^(\+?86)?1[3-9]\d{9}$|^\+[1-9]\d{6,14}$/;

// 微信 OAuth state 临时存储（10 分钟 TTL）
const WECHAT_STATES = new Map();

module.exports = async function authRoutes(app) {

  // ── 发送 OTP ──────────────────────────────────────
  // 每个 IP 每 10 分钟最多发 5 次，防止短信轰炸
  app.post('/otp/send', {
    config: { rateLimit: { max: 5, timeWindow: '10 minutes', keyGenerator: (req) => `otp:${req.ip}` } },
    schema: {
      body: {
        type: 'object',
        required: ['phone'],
        properties: { phone: { type: 'string', minLength: 8, maxLength: 20 } },
      },
    },
  }, async (req, reply) => {
    const { phone } = req.body;

    // 手机号格式校验
    if (!PHONE_RE.test(phone.replace(/\s/g, ''))) {
      return reply.code(400).send({ error: '手机号格式不正确' });
    }

    const isDemo = process.env.DEMO_MODE === 'true';
    const code = isDemo
      ? (process.env.DEMO_OTP || '123456')
      : Math.floor(100000 + Math.random() * 900000).toString();

    const expiresAt = new Date(Date.now() + 60000); // 60 秒
    await query(
      `INSERT INTO otp_codes (phone, code, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO UPDATE SET code=$2, expires_at=$3`,
      [phone, code, expiresAt]
    );

    // 发送短信（Demo 模式跳过，生产模式调用真实 SMS 服务）
    if (!isDemo) {
      await sendSMS(phone, code);
    } else {
      // Demo 模式：仅通过结构化日志记录，不在响应中暴露 code
      app.log.info({ phone: phone.slice(0, 4) + '****' + phone.slice(-2) }, '[Auth] Demo OTP generated');
    }

    return {
      success: true,
      expiresIn: 60,
      // Demo 模式在响应中明示 code，方便测试；生产绝不返回
      ...(isDemo ? { demo: true, code } : {}),
    };
  });

  // ── 验证 OTP ──────────────────────────────────────
  // 每个 IP 每 10 分钟最多尝试 10 次，防止暴力枚举
  app.post('/otp/verify', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes', keyGenerator: (req) => `verify:${req.ip}` } },
    schema: {
      body: {
        type: 'object',
        required: ['phone', 'code'],
        properties: {
          phone: { type: 'string', minLength: 8, maxLength: 20 },
          code:  { type: 'string', minLength: 6, maxLength: 6, pattern: '^[0-9]{6}$' },
        },
      },
    },
  }, async (req, reply) => {
    const { phone, code } = req.body;
    if (!phone || !code) return reply.code(400).send({ error: 'phone and code required' });

    const result = await query(
      `SELECT * FROM otp_codes WHERE phone=$1 AND expires_at > NOW()`,
      [phone]
    );

    const otpRow = result.rows[0];
    const isDemo = process.env.DEMO_MODE === 'true';
    const validCode = isDemo ? (process.env.DEMO_OTP || '123456') : otpRow?.code;

    if (!isDemo && !otpRow) return reply.code(400).send({ error: 'OTP expired or not found' });
    if (code !== validCode) return reply.code(400).send({ error: 'Invalid OTP code' });

    // 查找或创建用户
    let userRes = await query(`SELECT * FROM users WHERE phone=$1`, [phone]);
    let user = userRes.rows[0];

    if (!user) {
      const newRes = await query(
        `INSERT INTO users (display_name, phone) VALUES ($1, $2) RETURNING *`,
        [`用户${phone.slice(-4)}`, phone]
      );
      user = newRes.rows[0];
    }

    // 更新最后登录
    await query(`UPDATE users SET last_login=NOW() WHERE id=$1`, [user.id]);

    // 签发 Token
    const accessToken = app.jwt.sign({ sub: user.id, phone }, { expiresIn: '2h' });
    const refreshToken = uuid();
    const refreshHash = await bcrypt.hash(refreshToken, 8);

    await query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [user.id, refreshHash]
    );

    // 清理 OTP
    await query(`DELETE FROM otp_codes WHERE phone=$1`, [phone]);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        displayName: user.display_name,
        phone: user.phone,
        talent: user.talent,
      }
    };
  });

  // ── Demo 快速登录（开发用）────────────────────────
  app.post('/demo-login', async (req, reply) => {
    if (process.env.DEMO_MODE !== 'true') {
      return reply.code(403).send({ error: 'Demo mode is disabled' });
    }
    const user = {
      id: '00000000-0000-0000-0000-000000000001',
      display_name: 'Demo User',
    };
    const accessToken = app.jwt.sign({ sub: user.id }, { expiresIn: '24h' });
    return {
      accessToken,
      user: { id: user.id, displayName: user.display_name, talent: 'default' }
    };
  });

  // ── 刷新 Token ────────────────────────────────────
  app.post('/refresh', async (req, reply) => {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return reply.code(400).send({ error: 'refreshToken required' });

    const tokens = await query(
      `SELECT * FROM refresh_tokens WHERE expires_at > NOW()`,
      []
    );

    // 遍历验证（生产环境应换成更高效的方式）
    let matched = null;
    for (const row of tokens.rows) {
      if (await bcrypt.compare(refreshToken, row.token_hash)) {
        matched = row;
        break;
      }
    }

    if (!matched) return reply.code(401).send({ error: 'Invalid or expired refresh token' });

    const accessToken = app.jwt.sign({ sub: matched.user_id }, { expiresIn: '2h' });
    return { accessToken };
  });

  // ── 获取当前用户 ──────────────────────────────────
  app.get('/me', {
    preHandler: [async (req, reply) => {
      try { await req.jwtVerify(); }
      catch { reply.code(401).send({ error: 'Unauthorized' }); }
    }]
  }, async (req) => {
    const res = await query(`SELECT * FROM users WHERE id=$1`, [req.user.sub]);
    const u = res.rows[0];
    if (!u) throw new Error('User not found');
    return {
      id: u.id,
      displayName: u.display_name,
      avatarEmoji: u.avatar_emoji || '👤',
      phone: u.phone,
      email: u.email,
      talent: u.talent,
      soulPrompt: u.soul_prompt,
      assistantName: u.assistant_name || '我的助手',
      assistantEmoji: u.assistant_emoji || '🤖',
      preferredModel: u.preferred_model,
      isSearchable: u.is_searchable,
    };
  });

  // ── 更新个人资料（昵称、头像、灵魂、天赋、搜索可见性）──
  app.put('/profile', {
    preHandler: [async (req, reply) => {
      try { await req.jwtVerify(); }
      catch { reply.code(401).send({ error: 'Unauthorized' }); }
    }]
  }, async (req) => {
    const { displayName, avatarEmoji, talent, soulPrompt, assistantName, assistantEmoji, preferredModel, isSearchable } = req.body || {};
    const res = await query(
      `UPDATE users SET
         display_name    = COALESCE($2, display_name),
         avatar_emoji    = COALESCE($3, avatar_emoji),
         talent          = COALESCE($4, talent),
         soul_prompt     = COALESCE($5, soul_prompt),
         assistant_name  = COALESCE($6, assistant_name),
         assistant_emoji = COALESCE($7, assistant_emoji),
         preferred_model = COALESCE($8, preferred_model),
         is_searchable   = COALESCE($9, is_searchable)
       WHERE id=$1 RETURNING *`,
      [req.user.sub, displayName, avatarEmoji, talent, soulPrompt, assistantName, assistantEmoji, preferredModel, isSearchable]
    );
    const u = res.rows[0];

    // 静态人格属性有变更时，异步同步到 OpenClaw Agent 配置
    // 仅在 assistantName / talent / soulPrompt / preferredModel / assistantEmoji 任一字段更新时触发
    if (assistantName !== undefined || talent !== undefined || soulPrompt !== undefined ||
        preferredModel !== undefined || assistantEmoji !== undefined) {
      const staticPersona = buildStaticPersona({
        assistantName: u.assistant_name || 'AI 助手',
        talent:        u.talent || 'default',
        soulPrompt:    u.soul_prompt,
        displayName:   u.display_name,
      });
      setImmediate(() =>
        syncAgentConfig(u.id, {
          staticPersona,
          assistantName:  u.assistant_name || 'AI 助手',
          assistantEmoji: u.assistant_emoji || '🤖',
          model:          u.preferred_model,
        }).catch(() => {})
      );
    }

    return {
      id: u.id,
      displayName: u.display_name,
      avatarEmoji: u.avatar_emoji || '👤',
      talent: u.talent,
      soulPrompt: u.soul_prompt,
      assistantName: u.assistant_name || '我的助手',
      assistantEmoji: u.assistant_emoji || '🤖',
      preferredModel: u.preferred_model,
      isSearchable: u.is_searchable,
    };
  });

  // ── 微信 OAuth：获取授权 URL ──────────────────────
  // GET /auth/wechat/url          → 登录（无需认证）
  // GET /auth/wechat/url?bind=1   → 绑定到已登录账号（需要 JWT）
  app.get('/wechat/url', async (req, reply) => {
    const appId  = process.env.WECHAT_APP_ID;
    const secret = process.env.WECHAT_SECRET;
    if (!appId || !secret) {
      return reply.code(503).send({ error: 'WeChat OAuth 未配置，请检查 WECHAT_APP_ID 和 WECHAT_SECRET' });
    }

    // 绑定模式需要验证已登录用户
    let bindUserId = null;
    if (req.query.bind === '1') {
      try {
        await req.jwtVerify();
        bindUserId = req.user.sub;
      } catch {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
    }

    // 清理过期 state
    const now = Date.now();
    for (const [k, v] of WECHAT_STATES.entries()) {
      if (now - v.ts > 600000) WECHAT_STATES.delete(k);
    }

    const state = uuid();
    WECHAT_STATES.set(state, { ts: now, userId: bindUserId });

    const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`;
    const redirectUri = encodeURIComponent(`${backendUrl}/auth/wechat/callback`);
    const url = `https://open.weixin.qq.com/connect/oauth2/authorize` +
      `?appid=${appId}` +
      `&redirect_uri=${redirectUri}` +
      `&response_type=code` +
      `&scope=snsapi_userinfo` +
      `&state=${state}` +
      `#wechat_redirect`;

    return { url };
  });

  // ── 微信 OAuth：回调处理 ───────────────────────────
  app.get('/wechat/callback', async (req, reply) => {
    const { code, state } = req.query;
    const frontendUrl = process.env.FRONTEND_URL ||
      process.env.BACKEND_URL ||
      `http://localhost:${process.env.PORT || 3000}`;

    // 校验 state
    const stateData = code && state ? WECHAT_STATES.get(state) : null;
    if (!stateData) {
      return reply.redirect(`${frontendUrl}/?wechat_error=${encodeURIComponent('无效的登录状态，请重试')}`);
    }
    WECHAT_STATES.delete(state);

    try {
      // 1. code → access_token + openid
      const tokenRes = await axios.get('https://api.weixin.qq.com/sns/oauth2/access_token', {
        params: {
          appid:      process.env.WECHAT_APP_ID,
          secret:     process.env.WECHAT_SECRET,
          code,
          grant_type: 'authorization_code',
        },
        timeout: 10000,
      });
      const { access_token, openid, errcode, errmsg } = tokenRes.data;
      if (errcode) throw new Error(`微信接口错误 ${errcode}: ${errmsg}`);

      // 2. 获取用户信息（昵称、头像）
      const infoRes = await axios.get('https://api.weixin.qq.com/sns/userinfo', {
        params: { access_token, openid, lang: 'zh_CN' },
        timeout: 10000,
      });
      const wxUser = infoRes.data;
      if (wxUser.errcode) throw new Error(`获取微信用户信息失败: ${wxUser.errmsg}`);

      let userId;

      if (stateData.userId) {
        // ── 绑定模式：将 openid 关联到已有账号 ──────
        userId = stateData.userId;
        await query(
          `INSERT INTO oauth_accounts (user_id, provider, provider_id)
           VALUES ($1, 'wechat', $2)
           ON CONFLICT (provider, provider_id) DO NOTHING`,
          [userId, openid]
        );
        // 若用户尚无头像 URL，补充微信头像
        if (wxUser.headimgurl) {
          await query(
            `UPDATE users SET avatar_url=COALESCE(NULLIF(avatar_url,''), $2) WHERE id=$1`,
            [userId, wxUser.headimgurl]
          );
        }
      } else {
        // ── 登录模式：查找已有账号或新建 ────────────
        const oauthRow = await query(
          `SELECT user_id FROM oauth_accounts WHERE provider='wechat' AND provider_id=$1`,
          [openid]
        );
        if (oauthRow.rows[0]) {
          userId = oauthRow.rows[0].user_id;
        } else {
          const newUserRes = await query(
            `INSERT INTO users (display_name, avatar_url)
             VALUES ($1, $2) RETURNING id`,
            [wxUser.nickname || `微信用户`, wxUser.headimgurl || null]
          );
          userId = newUserRes.rows[0].id;
          await query(
            `INSERT INTO oauth_accounts (user_id, provider, provider_id)
             VALUES ($1, 'wechat', $2)`,
            [userId, openid]
          );
        }
      }

      // 更新最后登录时间
      await query(`UPDATE users SET last_login=NOW() WHERE id=$1`, [userId]);

      // 签发 Token
      const accessToken  = app.jwt.sign({ sub: userId }, { expiresIn: '2h' });
      const refreshToken = uuid();
      const refreshHash  = await bcrypt.hash(refreshToken, 8);
      await query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
        [userId, refreshHash]
      );

      const params = new URLSearchParams({ wechat_token: accessToken, wechat_refresh: refreshToken });
      if (stateData.userId) params.set('wechat_bound', '1');
      return reply.redirect(`${frontendUrl}/?${params.toString()}`);

    } catch (e) {
      app.log.error('WeChat OAuth error:', e.message);
      return reply.redirect(`${frontendUrl}/?wechat_error=${encodeURIComponent(e.message)}`);
    }
  });

  // ── 退出登录 ──────────────────────────────────────
  app.post('/logout', {
    preHandler: [async (req, reply) => {
      try { await req.jwtVerify(); }
      catch { return reply.code(401).send({ error: 'Unauthorized' }); }
    }]
  }, async (req, reply) => {
    await query(`DELETE FROM refresh_tokens WHERE user_id=$1`, [req.user.sub]);
    return reply.code(204).send();
  });
};
