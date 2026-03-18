'use strict';
const { layer1Process } = require('../brain/layer1');
const { runAgent } = require('../brain/layer2/agentExecutor');
const { buildClientToolDefs } = require('../tools/registry');
const { optionalAuth } = require('../auth/middleware');
const { buildGoal } = require('../skills');
const { checkQuota, incrementUsage } = require('../middleware/quota');

module.exports = async function analyzeRoutes(app) {

  // ── 核心分析接口（SSE 流式）──────────────────────
  app.post('/analyze', {
    preHandler: [optionalAuth, checkQuota],
  }, async (req, reply) => {
    const { text, skillType, clientSkills } = req.body || {};

    if (!text || !text.trim()) {
      return reply.code(400).send({ error: 'text is required' });
    }

    const userId = req.userId;

    // 构建客户端技能工具定义（来自客户端上报的本地能力）
    const clientToolDefs = buildClientToolDefs(clientSkills);
    const clientToolNames = new Set(clientToolDefs.map(d => d.function.name));

    // 设置 SSE Headers
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('X-Accel-Buffering', 'no');  // 禁止 Nginx 缓冲
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('Access-Control-Allow-Origin', '*');

    // SSE 发送函数
    const send = (data) => {
      try {
        const event = data.type || 'message';
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch { /* 客户端断开时忽略 */ }
    };

    // 发送心跳防止超时
    const heartbeat = setInterval(() => {
      try { reply.raw.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
    }, 15000);

    try {
      // ── 第一层大脑（确定性处理，~50ms）────────────
      send({ type: 'step', step: 1, label: '第一层：意图分析...' });
      const layer1 = await layer1Process(text.trim(), userId, { skillType });

      send({
        type: 'step', step: 2,
        label: `路由完成 → ${layer1.selectedModel}（${layer1.intent}）[${layer1.processingMs}ms]`,
      });

      // ── 第二层大脑（大模型推理）─────────────────────
      await runAgent({
        userId,
        text: text.trim(),
        toolNames: layer1.tools,
        model: layer1.selectedModel,
        routingRule: layer1.selectedRule,
        intent: layer1.intent,
        clientToolDefs,   // 来自客户端的本地技能定义
        clientToolNames,  // 用于判断哪些 tool call 应下发给客户端
        send,
      });

      // 调用完成后异步增加月度计数（不阻塞响应）
      incrementUsage(userId).catch(() => {});

    } catch (err) {
      send({ type: 'error', message: err.message || 'Internal server error' });
      app.log.error(err);
    } finally {
      clearInterval(heartbeat);
      try { reply.raw.end(); } catch { /* already ended */ }
    }

    return reply;
  });

  // ── 技能执行接口（SSE 流式）──────────────────────
  app.post('/skills/:skillId/run', {
    preHandler: [optionalAuth, checkQuota],
  }, async (req, reply) => {
    const { skillId } = req.params;
    const { input } = req.body || {};
    const userId = req.userId;
    const { query } = require('../db/client');

    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.setHeader('Access-Control-Allow-Origin', '*');

    const send = (data) => {
      try { reply.raw.write(`event: ${data.type || 'message'}\ndata: ${JSON.stringify(data)}\n\n`); }
      catch { /* ignore */ }
    };

    try {
      // 查找技能
      const skillRes = await query(
        `SELECT * FROM skills WHERE id=$1 AND (user_id=$2 OR is_builtin=true)`,
        [skillId, userId]
      ).catch(() => ({ rows: [] }));

      const skill = skillRes.rows[0];
      if (!skill) {
        send({ type: 'error', message: `Skill not found: ${skillId}` });
        reply.raw.end();
        return reply;
      }

      const layer1 = await layer1Process(
        input || skill.name,
        userId,
        { skillType: skill.builtin_type || 'default' }
      );

      const { isModelAvailable } = require('../brain/layer1');

      await runAgent({
        userId,
        text: buildSkillGoal(skill, input),
        toolNames: skill.allowed_tools || layer1.tools,
        // skill.model_pref 需通过 key 可用性检查，不可用则退回 layer1 路由结果
        model: (skill.model_pref && isModelAvailable(skill.model_pref))
          ? skill.model_pref
          : layer1.selectedModel,
        routingRule: `skill:${skill.builtin_type}`,
        intent: skill.builtin_type || layer1.intent,
        skillId: skill.id,
        skillName: skill.name,
        send,
      });

      incrementUsage(userId).catch(() => {});

    } catch (err) {
      send({ type: 'error', message: err.message });
    } finally {
      try { reply.raw.end(); } catch { /* ignore */ }
    }

    return reply;
  });
};

// buildSkillGoal 已迁移至 src/skills/index.js#buildGoal，此处保留别名兼容调用处
const buildSkillGoal = buildGoal;
