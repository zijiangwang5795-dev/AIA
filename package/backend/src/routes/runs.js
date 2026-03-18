'use strict';
const { query } = require('../db/client');
const { authMiddleware: requireAuth } = require('../auth/middleware');

module.exports = async function runsRoutes(app) {

  // ── 执行记录列表（时间线）────────────────────────────
  app.get('/runs', {
    preHandler: [requireAuth],
  }, async (req) => {
    const userId = req.userId;
    const { limit = 30, before } = req.query;
    const pageSize = Math.min(parseInt(limit, 10) || 30, 100);

    const params = [userId, pageSize];
    const beforeClause = before ? `AND started_at < $3` : '';
    if (before) params.push(before);

    const res = await query(`
      SELECT run_id, goal, status, skill_name, total_steps, started_at, completed_at
      FROM agent_runs
      WHERE user_id = $1 ${beforeClause}
      ORDER BY started_at DESC
      LIMIT $2
    `, params);

    return {
      runs: res.rows.map(r => ({
        runId:       r.run_id,
        goal:        r.goal,
        status:      r.status,          // running / done / failed
        skillName:   r.skill_name || null,
        totalSteps:  r.total_steps || 0,
        startedAt:   r.started_at,
        completedAt: r.completed_at || null,
        durationMs:  r.completed_at
          ? new Date(r.completed_at) - new Date(r.started_at)
          : null,
      })),
    };
  });

  // ── 执行记录详情（含步骤日志）────────────────────────
  app.get('/runs/:runId', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const userId = req.userId;
    const { runId } = req.params;

    const res = await query(`
      SELECT ar.run_id, ar.goal, ar.status, ar.skill_name, ar.total_steps,
             ar.started_at, ar.completed_at, ar.run_steps,
             aal.model, aal.routing_rule, aal.intent,
             aal.input_tokens, aal.output_tokens, aal.latency_ms, aal.cost_usd
      FROM agent_runs ar
      LEFT JOIN ai_audit_logs aal ON aal.run_id = ar.run_id
      WHERE ar.run_id = $1 AND ar.user_id = $2
      LIMIT 1
    `, [runId, userId]);

    if (!res.rows.length) return reply.code(404).send({ error: 'Run not found' });
    const r = res.rows[0];

    return {
      runId:       r.run_id,
      goal:        r.goal,
      status:      r.status,
      skillName:   r.skill_name || null,
      totalSteps:  r.total_steps || 0,
      startedAt:   r.started_at,
      completedAt: r.completed_at || null,
      durationMs:  r.completed_at
        ? new Date(r.completed_at) - new Date(r.started_at)
        : null,
      model:       r.model || null,
      routingRule: r.routing_rule || null,
      intent:      r.intent || null,
      tokens: {
        input:  r.input_tokens  || 0,
        output: r.output_tokens || 0,
        total:  (r.input_tokens || 0) + (r.output_tokens || 0),
      },
      costUsd:  r.cost_usd  ? parseFloat(r.cost_usd)  : null,
      latencyMs: r.latency_ms || null,
      steps:    r.run_steps || [],
    };
  });
};
