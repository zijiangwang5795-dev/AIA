'use strict';
const { query } = require('../db/client');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');

module.exports = async function authRoutes(app) {

  // ── 发送 OTP ──────────────────────────────────────
  app.post('/otp/send', async (req, reply) => {
    const { phone } = req.body || {};
    if (!phone) return reply.code(400).send({ error: 'phone required' });

    const code = process.env.DEMO_MODE === 'true'
      ? (process.env.DEMO_OTP || '123456')
      : Math.floor(100000 + Math.random() * 900000).toString();

    const expiresAt = new Date(Date.now() + 60000); // 60秒
    await query(
      `INSERT INTO otp_codes (phone, code, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO UPDATE SET code=$2, expires_at=$3`,
      [phone, code, expiresAt]
    );

    // 生产环境：在这里接入短信服务（阿里云/腾讯云）
    if (process.env.DEMO_MODE === 'true') {
      console.log(`📱 OTP for ${phone}: ${code}`);
    }

    return { success: true, expiresIn: 60, demo: process.env.DEMO_MODE === 'true' };
  });

  // ── 验证 OTP ──────────────────────────────────────
  app.post('/otp/verify', async (req, reply) => {
    const { phone, code } = req.body || {};
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
      phone: u.phone,
      email: u.email,
      talent: u.talent,
      preferredModel: u.preferred_model,
    };
  });
};
