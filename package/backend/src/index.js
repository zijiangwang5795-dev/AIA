'use strict';
require('dotenv').config();

// ── 生产环境强制校验关键配置 ─────────────────────────
if (process.env.NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev-secret-change-me') {
    console.error('FATAL: JWT_SECRET is not set or is using the default value in production!');
    process.exit(1);
  }
  if (process.env.DEMO_MODE === 'true') {
    console.warn('WARNING: DEMO_MODE=true in production environment.');
  }
}

const Fastify = require('fastify');
const path = require('path');

const isProd = process.env.NODE_ENV === 'production';

const app = Fastify({
  logger: isProd
    ? { level: 'warn' }                          // 生产：只记录 warn/error
    : { level: 'info', transport: { target: 'pino-pretty' } },  // 开发：彩色可读日志（需 pino-pretty）
  trustProxy: true,                              // 部署在 Nginx/Load Balancer 后时正确获取客户端 IP
});

// ── 安全响应头（helmet）──────────────────────────────
// 生产环境开启严格模式；开发环境适当放宽（调试 inline scripts 等）
app.register(require('@fastify/helmet'), {
  contentSecurityPolicy: isProd ? {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'"],
      styleSrc:       ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:        ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:         ["'self'", 'data:', 'https:'],
      connectSrc:     ["'self'"],
      frameSrc:       ["'none'"],
      objectSrc:      ["'none'"],
    },
  } : false,
  crossOriginEmbedderPolicy: false,   // 避免破坏字体等跨域资源
});

// ── CORS ─────────────────────────────────────────────
// 生产：从 ALLOWED_ORIGINS 读取白名单；开发：放开所有
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.register(require('@fastify/cors'), {
  origin: isProd
    ? (origin, cb) => {
        if (!origin) return cb(null, true);   // 服务端对服务端请求
        if (allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true);
        cb(new Error(`Origin ${origin} not allowed by CORS`), false);
      }
    : true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});

// ── JWT ──────────────────────────────────────────────
app.register(require('@fastify/jwt'), {
  secret: process.env.JWT_SECRET || 'dev-secret-change-me',
  sign: { expiresIn: process.env.JWT_EXPIRE || '2h' },
});

// ── 全局限流（请求总量兜底）──────────────────────────
app.register(require('@fastify/rate-limit'), {
  global: true,
  max: 200,
  timeWindow: '1 minute',
  keyGenerator: (req) => req.ip,       // 按 IP 限流（trustProxy 已开）
  errorResponseBuilder: () => ({
    error: 'Too Many Requests',
    message: '请求过于频繁，请稍后再试',
  }),
});

// ── 健康检查 ──────────────────────────────────────────
app.get('/health', {
  config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
}, async () => ({
  status: 'ok',
  time: new Date().toISOString(),
  version: process.env.npm_package_version || '1.0.0',
  env: isProd ? 'production' : 'development',
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
app.register(require('./routes/groups'),   { prefix: '/api' });
app.register(require('./routes/runs'),     { prefix: '/api' });
app.register(require('./routes/admin'),    { prefix: '/admin' });

// ── 静态前端 ──────────────────────────────────────────
app.register(require('@fastify/static'), {
  root: path.join(__dirname, '../../frontend'),
  prefix: '/',
  decorateReply: true,
  index: 'index.html',   // 根路径 / 直接返回 index.html
});

// SPA 回退：未匹配的路由返回 index.html
app.setNotFoundHandler((req, reply) => {
  if (!req.url.startsWith('/api') && !req.url.startsWith('/auth') && !req.url.startsWith('/health') && !req.url.startsWith('/admin')) {
    return reply.sendFile('index.html');
  }
  reply.code(404).send({ message: `Route ${req.method}:${req.url} not found`, statusCode: 404 });
});

// ── 全局错误处理 ─────────────────────────────────────
app.setErrorHandler((err, req, reply) => {
  // 限流错误
  if (err.statusCode === 429) {
    return reply.code(429).send({ error: 'Too Many Requests', message: '请求过于频繁，请稍后再试' });
  }
  // CORS 错误
  if (err.message?.includes('not allowed by CORS')) {
    return reply.code(403).send({ error: 'Forbidden', message: 'CORS policy violation' });
  }
  // 未预期错误
  app.log.error({ err, url: req.url, method: req.method }, 'Unhandled error');
  const statusCode = err.statusCode || 500;
  reply.code(statusCode).send({
    error: statusCode === 500 ? 'Internal Server Error' : err.message,
    statusCode,
  });
});

// ── 优雅关闭 ─────────────────────────────────────────
const shutdown = async (signal) => {
  app.log.warn(`Received ${signal}, starting graceful shutdown...`);
  try {
    await app.close();
    app.log.warn('Server closed. Bye.');
    process.exit(0);
  } catch (err) {
    app.log.error(err, 'Error during shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// 捕获未处理的 Promise 拒绝，避免进程静默退出
process.on('unhandledRejection', (reason, promise) => {
  app.log.error({ reason, promise }, 'Unhandled Promise Rejection');
});

process.on('uncaughtException', (err) => {
  app.log.error(err, 'Uncaught Exception');
  process.exit(1);
});

// ── 启动 ──────────────────────────────────────────────
const start = async () => {
  try {
    const { migrate } = require('./db/migrate');
    await migrate();

    const port = parseInt(process.env.PORT || '3000');
    const host = process.env.HOST || '0.0.0.0';
    await app.listen({ port, host });
    app.log.info(`AI Assistant Server running at http://${host}:${port} [${isProd ? 'production' : 'development'}]`);
  } catch (err) {
    app.log.error(err, 'Failed to start server');
    process.exit(1);
  }
};

start();
