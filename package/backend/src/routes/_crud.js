'use strict';
const { query } = require('../db/client');
const { optionalAuth } = require('../auth/middleware');

// ── 任务路由 ──────────────────────────────────────────
// 允许的任务状态白名单（防止枚举注入）
const VALID_TASK_STATUSES = new Set(['pending', 'done', 'all']);
const VALID_PRIORITIES    = new Set(['high', 'med', 'low']);
const MAX_LIMIT = 200;

async function tasksRoutes(app) {
  app.get('/tasks', { preHandler: [optionalAuth] }, async (req) => {
    const rawStatus = req.query.status || 'pending';
    const status = VALID_TASK_STATUSES.has(rawStatus) ? rawStatus : 'pending';
    const limit  = Math.min(Math.max(1, parseInt(req.query.limit) || 50), MAX_LIMIT);
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    // 使用参数化查询消除 SQL 注入风险
    let res;
    if (status === 'all') {
      res = await query(
        `SELECT * FROM tasks WHERE user_id=$1 AND status IN ('pending','done')
         ORDER BY
           CASE priority WHEN 'high' THEN 1 WHEN 'med' THEN 2 ELSE 3 END,
           created_at DESC
         LIMIT $2 OFFSET $3`,
        [req.userId, limit, offset]
      );
    } else {
      res = await query(
        `SELECT * FROM tasks WHERE user_id=$1 AND status=$4
         ORDER BY
           CASE priority WHEN 'high' THEN 1 WHEN 'med' THEN 2 ELSE 3 END,
           created_at DESC
         LIMIT $2 OFFSET $3`,
        [req.userId, limit, offset, status]
      );
    }
    return { tasks: res.rows, total: res.rows.length };
  });

  app.post('/tasks', { preHandler: [optionalAuth] }, async (req) => {
    const tasks = Array.isArray(req.body) ? req.body : [req.body];
    const created = [];
    for (const t of tasks) {
      const res = await query(
        `INSERT INTO tasks (user_id, title, description, priority, category, deadline, source)
         VALUES ($1,$2,$3,$4,$5,$6,'manual') RETURNING *`,
        [req.userId, t.title, t.description, t.priority || 'med', t.category || 'general', t.deadline]
      );
      created.push(res.rows[0]);
    }
    return { created, count: created.length };
  });

  app.patch('/tasks/:id', { preHandler: [optionalAuth] }, async (req) => {
    const { id } = req.params;
    const { status, title, priority } = req.body || {};
    const res = await query(
      `UPDATE tasks SET
         status=COALESCE($3, status),
         title=COALESCE($4, title),
         priority=COALESCE($5, priority),
         updated_at=NOW()
       WHERE id=$1 AND user_id=$2 RETURNING *`,
      [id, req.userId, status, title, priority]
    );
    if (!res.rows[0]) throw { statusCode: 404, message: 'Task not found' };
    return res.rows[0];
  });

  app.delete('/tasks/:id', { preHandler: [optionalAuth] }, async (req, reply) => {
    await query(`DELETE FROM tasks WHERE id=$1 AND user_id=$2`, [req.params.id, req.userId]);
    return reply.code(204).send();
  });
}

// ── 技能路由 ──────────────────────────────────────────
async function skillsRoutes(app) {
  app.get('/skills', { preHandler: [optionalAuth] }, async (req) => {
    const res = await query(
      `SELECT * FROM skills WHERE user_id=$1 OR is_builtin=true ORDER BY is_builtin DESC, created_at`,
      [req.userId]
    );
    return { skills: res.rows };
  });

  app.post('/skills', { preHandler: [optionalAuth] }, async (req) => {
    const { name, emoji, description, allowedTools, modelPref } = req.body || {};
    const res = await query(
      `INSERT INTO skills (user_id, name, emoji, description, allowed_tools, model_pref)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.userId, name, emoji || '⚡', description, allowedTools || ['create_tasks'], modelPref]
    );
    return res.rows[0];
  });

  app.delete('/skills/:id', { preHandler: [optionalAuth] }, async (req, reply) => {
    await query(`DELETE FROM skills WHERE id=$1 AND user_id=$2 AND is_builtin=false`, [req.params.id, req.userId]);
    return reply.code(204).send();
  });
}

// ── 记忆路由 ──────────────────────────────────────────
async function memoryRoutes(app) {
  app.get('/memory/long', { preHandler: [optionalAuth] }, async (req) => {
    const res = await query(
      `SELECT key, value, updated_at FROM user_memories WHERE user_id=$1 ORDER BY updated_at DESC`,
      [req.userId]
    );
    return { memories: res.rows };
  });

  app.post('/memory/long', { preHandler: [optionalAuth] }, async (req) => {
    const { key, value } = req.body || {};
    await query(
      `INSERT INTO user_memories (user_id, key, value, updated_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (user_id, key) DO UPDATE SET value=$3, updated_at=NOW()`,
      [req.userId, key, value]
    );
    return { saved: true, key, value };
  });

  app.delete('/memory/long/:key', { preHandler: [optionalAuth] }, async (req, reply) => {
    await query(`DELETE FROM user_memories WHERE user_id=$1 AND key=$2`, [req.userId, req.params.key]);
    return reply.code(204).send();
  });

  app.get('/memory/episodic', { preHandler: [optionalAuth] }, async (req) => {
    const res = await query(
      `SELECT id, summary, created_at FROM episodic_memories
       WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [req.userId]
    );
    return { episodes: res.rows };
  });
}

// ── 审计日志路由 ──────────────────────────────────────
async function auditRoutes(app) {
  app.get('/audit', { preHandler: [optionalAuth] }, async (req) => {
    const { limit = 20 } = req.query;
    const res = await query(
      `SELECT * FROM ai_audit_logs WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
      [req.userId, limit]
    );

    const statsRes = await query(
      `SELECT
         COUNT(*) as total_calls,
         SUM(input_tokens + output_tokens) as total_tokens,
         SUM(cost_usd) as total_cost_usd,
         AVG(latency_ms) as avg_latency_ms
       FROM ai_audit_logs WHERE user_id=$1`,
      [req.userId]
    );

    return {
      logs: res.rows,
      stats: statsRes.rows[0],
    };
  });
}

// ── 导出所有路由 ──────────────────────────────────────
module.exports = async function allRoutes(app, opts) {};

// 分别注册
module.exports.tasksRoutes = tasksRoutes;
module.exports.skillsRoutes = skillsRoutes;
module.exports.memoryRoutes = memoryRoutes;
module.exports.auditRoutes = auditRoutes;
