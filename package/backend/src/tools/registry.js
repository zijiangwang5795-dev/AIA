'use strict';
const { query } = require('../db/client');
const { v4: uuid } = require('uuid');
const { sendPushToUser } = require('../services/push');

// ── 工具定义（OpenAI Function Calling 格式）────────────
const TOOL_DEFINITIONS = {
  web_search: {
    type: 'function',
    function: {
      name: 'web_search',
      description: '搜索互联网获取最新信息。当需要查询当天新闻、实时数据、或知识截止日期之后的信息时使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，中文或英文' },
        },
        required: ['query'],
      },
    },
  },

  create_tasks: {
    type: 'function',
    function: {
      name: 'create_tasks',
      description: '将提取出的任务批量保存到用户的任务清单中。',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title:    { type: 'string', description: '任务标题，简洁清晰' },
                priority: { type: 'string', enum: ['high', 'med', 'low'], description: '优先级' },
                category: { type: 'string', description: '分类，如：工作、学习、生活' },
                deadline: { type: 'string', description: '截止时间，如：今天、明天、下周五' },
                note:     { type: 'string', description: '补充说明（可选）' },
              },
              required: ['title', 'priority'],
            },
          },
          summary: { type: 'string', description: '对本次提取的简短总结' },
        },
        required: ['tasks'],
      },
    },
  },

  get_tasks: {
    type: 'function',
    function: {
      name: 'get_tasks',
      description: '获取用户的任务列表，用于生成日报或查询任务。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'done', 'all'], description: '任务状态筛选' },
          limit:  { type: 'number', description: '返回数量，默认20' },
        },
      },
    },
  },

  memory_search: {
    type: 'function',
    function: {
      name: 'memory_search',
      description: '搜索用户的历史记忆和偏好信息。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
        },
        required: ['query'],
      },
    },
  },

  save_memory: {
    type: 'function',
    function: {
      name: 'save_memory',
      description: '将重要的用户信息或偏好持久化到长期记忆中。',
      parameters: {
        type: 'object',
        properties: {
          key:   { type: 'string', description: '记忆标识，如：工作领域、偏好语言' },
          value: { type: 'string', description: '记忆内容' },
        },
        required: ['key', 'value'],
      },
    },
  },

  calculator: {
    type: 'function',
    function: {
      name: 'calculator',
      description: '执行数学计算。',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: '数学表达式，如：100 * 0.85 + 20' },
        },
        required: ['expression'],
      },
    },
  },

  send_friend_message: {
    type: 'function',
    function: {
      name: 'send_friend_message',
      description: '由助手代替用户向好友发送消息。消息会显示为"来自 [助手名]"，并通过推送通知提醒对方。适用于"帮我告诉张三…""发消息给李四说…"等场景。',
      parameters: {
        type: 'object',
        properties: {
          friendName: { type: 'string', description: '好友的昵称或姓名（用于搜索匹配）' },
          message:    { type: 'string', description: '要发送的消息内容' },
        },
        required: ['friendName', 'message'],
      },
    },
  },
};

// ── 工具执行函数 ──────────────────────────────────────
async function executeTool(name, args, context = {}) {
  const { userId, runId } = context;

  switch (name) {
    case 'web_search': {
      // 生产环境接入真实搜索 API（Serper / Bing / Tavily）
      // 演示模式返回模拟数据
      if (!process.env.SERPER_API_KEY && !process.env.TAVILY_API_KEY) {
        return {
          results: [
            { title: `[演示] 搜索: ${args.query}`, snippet: '演示模式下未配置搜索 API，这是模拟结果。请在 .env 中配置 SERPER_API_KEY 或 TAVILY_API_KEY。', url: 'https://example.com' },
          ],
          note: '演示模式，配置 SERPER_API_KEY 启用真实搜索',
        };
      }

      // Tavily 搜索（推荐，专为 AI Agent 设计）
      if (process.env.TAVILY_API_KEY) {
        const axios = require('axios');
        const res = await axios.post('https://api.tavily.com/search', {
          api_key: process.env.TAVILY_API_KEY,
          query: args.query,
          max_results: 5,
          search_depth: 'basic',
        });
        return { results: res.data.results };
      }

      // Serper 搜索（Google 结果）
      const axios = require('axios');
      const res = await axios.post('https://google.serper.dev/search', {
        q: args.query, gl: 'cn', hl: 'zh-cn', num: 5,
      }, { headers: { 'X-API-KEY': process.env.SERPER_API_KEY } });
      return { results: (res.data.organic || []).map(r => ({ title: r.title, snippet: r.snippet, url: r.link })) };
    }

    case 'create_tasks': {
      const tasks = args.tasks || [];
      const created = [];
      for (const t of tasks) {
        const res = await query(
          `INSERT INTO tasks (user_id, title, priority, category, deadline, source, run_id)
           VALUES ($1,$2,$3,$4,$5,'agent',$6) RETURNING *`,
          [userId, t.title, t.priority || 'med', t.category || 'general', t.deadline || null, runId || null]
        );
        created.push(res.rows[0]);
      }
      return { created: created.length, tasks: created.map(t => ({ id: t.id, title: t.title, priority: t.priority })), summary: args.summary };
    }

    case 'get_tasks': {
      const status = args.status || 'pending';
      const limit = args.limit || 20;
      const statusFilter = status === 'all' ? `status IN ('pending','done')` : `status='${status}'`;
      const res = await query(
        `SELECT * FROM tasks WHERE user_id=$1 AND ${statusFilter}
         ORDER BY created_at DESC LIMIT $2`,
        [userId, limit]
      );
      return { tasks: res.rows, count: res.rows.length };
    }

    case 'memory_search': {
      const res = await query(
        `SELECT key, value FROM user_memories WHERE user_id=$1 AND (key ILIKE $2 OR value ILIKE $2)
         ORDER BY updated_at DESC LIMIT 5`,
        [userId, `%${args.query}%`]
      );
      return { memories: res.rows };
    }

    case 'save_memory': {
      await query(
        `INSERT INTO user_memories (user_id, key, value, updated_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (user_id, key) DO UPDATE SET value=$3, updated_at=NOW()`,
        [userId, args.key, args.value]
      );
      return { saved: true, key: args.key };
    }

    case 'calculator': {
      try {
        // 安全的数学表达式求值（只允许数字和运算符）
        const expr = args.expression.replace(/[^0-9+\-*/().%\s]/g, '');
        // eslint-disable-next-line no-new-func
        const result = Function(`'use strict'; return (${expr})`)();
        return { expression: args.expression, result, formatted: result.toLocaleString('zh-CN') };
      } catch {
        return { error: 'Invalid expression', expression: args.expression };
      }
    }

    case 'send_friend_message': {
      const { friendName, message } = args;
      if (!userId) return { error: 'userId required' };

      // 查找当前用户信息（助手名）
      const senderRes = await query(
        `SELECT display_name, assistant_name, assistant_emoji FROM users WHERE id=$1`,
        [userId]
      );
      const sender = senderRes.rows[0];
      const assistantName = sender?.assistant_name || '我的助手';
      const assistantEmoji = sender?.assistant_emoji || '🤖';

      // 按昵称模糊匹配好友
      const friendRes = await query(
        `SELECT u.id, u.display_name, u.assistant_name
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.requester_id=$1 THEN f.recipient_id ELSE f.requester_id END
         WHERE (f.requester_id=$1 OR f.recipient_id=$1)
           AND f.status='accepted'
           AND u.display_name ILIKE $2
         LIMIT 1`,
        [userId, `%${friendName}%`]
      );

      if (!friendRes.rows.length) {
        return { error: `未找到好友"${friendName}"，请确认昵称或先添加好友` };
      }
      const friend = friendRes.rows[0];

      // 存消息，标记为助手代发
      await query(
        `INSERT INTO messages (from_user_id, to_user_id, content, sender_type, sender_name)
         VALUES ($1, $2, $3, 'assistant', $4)`,
        [userId, friend.id, message, `${assistantEmoji} ${assistantName}`]
      );

      // 推送通知给好友（fire and forget，不阻塞响应）
      sendPushToUser(friend.id, {
        title: `${assistantEmoji} ${assistantName} 发来消息`,
        body:  message.slice(0, 100),
        data:  { type: 'friend_message', fromUserId: userId },
      }).catch(() => {});

      return {
        sent: true,
        to: friend.display_name,
        friendAssistant: friend.assistant_name || friend.display_name,
        message,
        note: `消息已由 ${assistantEmoji}${assistantName} 代发给 ${friend.display_name}`,
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// 获取指定工具集的定义
function getToolDefs(toolNames) {
  return toolNames.map(n => TOOL_DEFINITIONS[n]).filter(Boolean);
}

// ── 客户端技能转换（客户端上报的能力 → OpenAI function 格式）─
function buildClientToolDefs(clientSkills) {
  if (!Array.isArray(clientSkills)) return [];
  return clientSkills
    .filter(s => s && s.name && s.description)
    .map(s => ({
      type: 'function',
      function: {
        name: s.name,
        description: s.description,
        parameters: s.parameters || { type: 'object', properties: {} },
      },
    }));
}

module.exports = { TOOL_DEFINITIONS, executeTool, getToolDefs, buildClientToolDefs };
