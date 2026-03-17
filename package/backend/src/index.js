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
app.register(require('./routes/auth'),     { prefix: '/auth' });
app.register(require('./routes/analyze'),  { prefix: '/api' });
app.register(require('./routes/tasks'),    { prefix: '/api' });
app.register(require('./routes/skills'),   { prefix: '/api' });
app.register(require('./routes/memory'),   { prefix: '/api' });
app.register(require('./routes/audit'),    { prefix: '/api' });
app.register(require('./routes/friends'),  { prefix: '/api' });
app.register(require('./routes/billing'),  { prefix: '/api' });
app.register(require('./routes/feedback'), { prefix: '/api' });
app.register(require('./routes/push'),     { prefix: '/api' });
app.register(require('./routes/openclaw'), { prefix: '/api/openclaw' });
app.register(require('./routes/admin'),    { prefix: '/admin' });

// ── 静态前端 ──────────────────────────────────────────
app.register(require('@fastify/static'), {
  root: path.join(__dirname, '../../frontend'),
  prefix: '/',
});

// SPA 回退：未匹配的路由返回 index.html
app.setNotFoundHandler((req, reply) => {
  if (!req.url.startsWith('/api') && !req.url.startsWith('/auth') && !req.url.startsWith('/health')) {
    return reply.sendFile('index.html');
  }
  reply.code(404).send({ message: `Route ${req.method}:${req.url} not found`, statusCode: 404 });
});

// ── 启动 ──────────────────────────────────────────────
const start = async () => {
  try {
    const { migrate } = require('./db/migrate');
    await migrate();

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
