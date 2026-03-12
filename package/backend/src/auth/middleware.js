'use strict';

// JWT 认证中间件
async function authMiddleware(request, reply) {
  try {
    await request.jwtVerify();
    request.userId = request.user.sub;
  } catch (err) {
    reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });
  }
}

// 可选认证（Demo 模式下允许匿名）
async function optionalAuth(request, reply) {
  try {
    await request.jwtVerify();
    request.userId = request.user.sub;
  } catch {
    // Demo 模式：使用固定演示用户
    request.userId = '00000000-0000-0000-0000-000000000001';
  }
}

module.exports = { authMiddleware, optionalAuth };
