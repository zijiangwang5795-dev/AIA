'use strict';
require('dotenv').config();
const Fastify = require('fastify');
const path = require('path');

const app = Fastify({ logger: { level: 'info' } });

// ── 插件注册 ──────────────────────────────────────────
app.register(require('@fastify/cors'), {
  origin: true,  // 开发期放开，生产环境改为具体域名
  credentials: true,
});

app.register(require('@fastify/jwt'), {
  secret: process.env.JWT_SECRET || 'dev-secret-change-me',
  sign: { expiresIn: process.env.JWT_EXPIRE || '2h' },
});

app.register(require('@fastify/rate-limit'), {
  max: 100,
  timeWindow: '1 minute',
});

// ── 健康检查 ──────────────────────────────────────────
app.get('/health', async () => ({
  status: 'ok',
  time: new Date().toISOString(),
  version: '1.0.0',
}));

// ── 路由注册 ──────────────────────────────────────────
app.register(require('./routes/auth'),    { prefix: '/auth' });
app.register(require('./routes/analyze'), { prefix: '/api' });
app.register(require('./routes/tasks'),   { prefix: '/api' });
app.register(require('./routes/skills'),  { prefix: '/api' });
app.register(require('./routes/memory'),  { prefix: '/api' });
app.register(require('./routes/audit'),   { prefix: '/api' });

// ── 静态前端（可选）──────────────────────────────────
// 如果把前端 HTML 放在 public/ 目录下，可以直接托管
try {
  app.register(require('@fastify/static'), {
    root: path.join(__dirname, '../public'),
    prefix: '/',
  });
} catch (e) {
  // @fastify/static 未安装时忽略
}

// ── 启动 ──────────────────────────────────────────────
const start = async () => {
  try {
    const { db } = require('./db/client');
    await db.connect().catch(e => {
      app.log.warn('DB connect error (tables may not exist yet): ' + e.message);
    });

    const port = parseInt(process.env.PORT || '3000');
    const host = process.env.HOST || '0.0.0.0';
    await app.listen({ port, host });
    console.log(`\n🤖 AI Assistant Server running at http://${host}:${port}\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
