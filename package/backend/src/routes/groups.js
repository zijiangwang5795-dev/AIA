'use strict';
const { query } = require('../db/client');
const { authMiddleware: requireAuth } = require('../auth/middleware');
const { sendPushToUser } = require('../services/push');

module.exports = async function groupRoutes(app) {

  // ── 创建群组 ──────────────────────────────────────────
  app.post('/groups', {
    preHandler: [requireAuth],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name:        { type: 'string', minLength: 1, maxLength: 50 },
          emoji:       { type: 'string', maxLength: 10 },
          description: { type: 'string', maxLength: 500 },
          memberIds:   { type: 'array', items: { type: 'string' }, maxItems: 100 },
        },
      },
    },
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const userId = req.userId;
    const { name, emoji = '👥', description = '', memberIds = [] } = req.body;

    // 验证非重复 memberIds（且不包含自己，自己自动加入）
    const uniqueMembers = [...new Set(memberIds.filter(id => id !== userId))];

    // 创建群组
    const grpRes = await query(
      `INSERT INTO groups (name, emoji, description, creator_id) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, emoji, description, userId]
    );
    const group = grpRes.rows[0];

    // 创建者自动加入（role=admin）
    await query(
      `INSERT INTO group_members (group_id, user_id, role) VALUES ($1,$2,'admin')`,
      [group.id, userId]
    );

    // 批量加入其他成员
    if (uniqueMembers.length) {
      const vals = uniqueMembers.map((_, i) => `($1, $${i + 2}, 'member')`).join(',');
      await query(
        `INSERT INTO group_members (group_id, user_id, role) VALUES ${vals} ON CONFLICT DO NOTHING`,
        [group.id, ...uniqueMembers]
      ).catch(() => {}); // 忽略无效 userId
    }

    return {
      id:          group.id,
      name:        group.name,
      emoji:       group.emoji,
      description: group.description,
      creatorId:   group.creator_id,
      createdAt:   group.created_at,
      memberCount: uniqueMembers.length + 1,
    };
  });

  // ── 获取我的群组列表 ───────────────────────────────────
  app.get('/groups', {
    preHandler: [requireAuth],
  }, async (req) => {
    const userId = req.userId;
    const res = await query(`
      SELECT * FROM (
        SELECT
          g.id, g.name, g.emoji, g.description, g.creator_id, g.created_at,
          gm.role,
          (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count,
          (SELECT content FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1) AS last_message,
          (SELECT created_at FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1) AS last_message_at
        FROM groups g
        JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $1
      ) sub
      ORDER BY COALESCE(last_message_at, created_at) DESC
    `, [userId]);

    return {
      groups: res.rows.map(r => ({
        id:          r.id,
        name:        r.name,
        emoji:       r.emoji,
        description: r.description,
        creatorId:   r.creator_id,
        createdAt:   r.created_at,
        role:        r.role,
        memberCount: parseInt(r.member_count, 10),
        lastMessage: r.last_message || null,
        lastMessageAt: r.last_message_at || null,
      })),
    };
  });

  // ── 获取群组详情（含成员列表）────────────────────────
  app.get('/groups/:id', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const userId = req.userId;
    const { id } = req.params;

    // 验证成员身份
    const memCheck = await query(
      `SELECT role FROM group_members WHERE group_id=$1 AND user_id=$2`,
      [id, userId]
    );
    if (!memCheck.rows.length) return reply.code(403).send({ error: '你不是该群组成员' });

    const grpRes = await query(`SELECT * FROM groups WHERE id=$1`, [id]);
    if (!grpRes.rows.length) return reply.code(404).send({ error: 'Group not found' });
    const group = grpRes.rows[0];

    const membersRes = await query(`
      SELECT gm.user_id, gm.role, gm.joined_at,
             u.display_name, u.avatar_emoji
      FROM group_members gm
      JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = $1
      ORDER BY gm.role DESC, gm.joined_at ASC
    `, [id]);

    return {
      id:          group.id,
      name:        group.name,
      emoji:       group.emoji,
      description: group.description,
      creatorId:   group.creator_id,
      createdAt:   group.created_at,
      myRole:      memCheck.rows[0].role,
      members: membersRes.rows.map(m => ({
        userId:      m.user_id,
        role:        m.role,
        joinedAt:    m.joined_at,
        displayName: m.display_name,
        avatarEmoji: m.avatar_emoji || '👤',
      })),
    };
  });

  // ── 获取群组消息（分页，最新50条）────────────────────
  app.get('/groups/:id/messages', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const userId = req.userId;
    const { id } = req.params;
    const { before, limit = 50 } = req.query;
    const pageSize = Math.min(parseInt(limit, 10) || 50, 100);

    // 验证成员身份
    const memCheck = await query(
      `SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2`,
      [id, userId]
    );
    if (!memCheck.rows.length) return reply.code(403).send({ error: '你不是该群组成员' });

    const params = [id, pageSize];
    const beforeClause = before ? `AND gm.created_at < $3` : '';
    if (before) params.push(before);

    const res = await query(`
      SELECT gm.id, gm.from_user_id, gm.content, gm.sender_name, gm.created_at,
             u.display_name, u.avatar_emoji
      FROM group_messages gm
      LEFT JOIN users u ON u.id = gm.from_user_id
      WHERE gm.group_id = $1 ${beforeClause}
      ORDER BY gm.created_at DESC
      LIMIT $2
    `, params);

    return {
      messages: res.rows.reverse().map(m => ({
        id:          m.id,
        fromUserId:  m.from_user_id,
        content:     m.content,
        senderName:  m.sender_name || m.display_name || '用户',
        avatarEmoji: m.avatar_emoji || '👤',
        createdAt:   m.created_at,
        isOwn:       m.from_user_id === userId,
      })),
    };
  });

  // ── 发送群组消息 ───────────────────────────────────────
  app.post('/groups/:id/messages', {
    preHandler: [requireAuth],
    schema: {
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 4000 },
        },
      },
    },
    config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: (req) => `gmsg:${req.userId}` } },
  }, async (req, reply) => {
    const userId = req.userId;
    const { id } = req.params;
    const { content } = req.body;

    // 验证成员身份
    const memCheck = await query(
      `SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2`,
      [id, userId]
    );
    if (!memCheck.rows.length) return reply.code(403).send({ error: '你不是该群组成员' });

    // 获取发送者信息
    const userRes = await query(`SELECT display_name FROM users WHERE id=$1`, [userId]);
    const senderName = userRes.rows[0]?.display_name || '用户';

    const msgRes = await query(
      `INSERT INTO group_messages (group_id, from_user_id, content, sender_name)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [id, userId, content, senderName]
    );
    const msg = msgRes.rows[0];

    // 异步推送给群成员（不阻塞响应）
    setImmediate(async () => {
      try {
        const membersRes = await query(
          `SELECT user_id FROM group_members WHERE group_id=$1 AND user_id<>$2`,
          [id, userId]
        );
        const grpRes = await query(`SELECT name, emoji FROM groups WHERE id=$1`, [id]);
        const grp = grpRes.rows[0];
        for (const m of membersRes.rows) {
          await sendPushToUser(m.user_id, {
            title: `${grp?.emoji || '👥'} ${grp?.name || '群消息'}`,
            body:  `${senderName}: ${content.slice(0, 80)}`,
            data:  { type: 'group_message', groupId: id },
          }).catch(() => {});
        }
      } catch { /* ignore push errors */ }
    });

    return {
      id:          msg.id,
      fromUserId:  msg.from_user_id,
      content:     msg.content,
      senderName:  msg.sender_name,
      createdAt:   msg.created_at,
      isOwn:       true,
    };
  });

  // ── 添加成员（仅管理员）───────────────────────────────
  app.post('/groups/:id/members', {
    preHandler: [requireAuth],
    schema: {
      body: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const userId = req.userId;
    const { id } = req.params;
    const { userId: targetUserId } = req.body;

    // 验证操作者是管理员
    const memCheck = await query(
      `SELECT role FROM group_members WHERE group_id=$1 AND user_id=$2`,
      [id, userId]
    );
    if (!memCheck.rows.length || memCheck.rows[0].role !== 'admin') {
      return reply.code(403).send({ error: '只有管理员才能添加成员' });
    }

    await query(
      `INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [id, targetUserId]
    );
    return { success: true };
  });

  // ── 移除成员（仅管理员，或自己退出）────────────────────
  app.delete('/groups/:id/members/:uid', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const userId = req.userId;
    const { id, uid } = req.params;

    const memCheck = await query(
      `SELECT role FROM group_members WHERE group_id=$1 AND user_id=$2`,
      [id, userId]
    );
    if (!memCheck.rows.length) return reply.code(403).send({ error: '你不是该群组成员' });

    const isSelf  = uid === userId;
    const isAdmin = memCheck.rows[0].role === 'admin';
    if (!isSelf && !isAdmin) {
      return reply.code(403).send({ error: '只有管理员才能移除成员' });
    }

    await query(`DELETE FROM group_members WHERE group_id=$1 AND user_id=$2`, [id, uid]);
    return { success: true };
  });

  // ── 解散群组（仅创建者）──────────────────────────────
  app.delete('/groups/:id', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const userId = req.userId;
    const { id } = req.params;

    const grpRes = await query(`SELECT creator_id FROM groups WHERE id=$1`, [id]);
    if (!grpRes.rows.length) return reply.code(404).send({ error: 'Group not found' });
    if (grpRes.rows[0].creator_id !== userId) {
      return reply.code(403).send({ error: '只有群主才能解散群组' });
    }

    await query(`DELETE FROM groups WHERE id=$1`, [id]);
    return { success: true };
  });
};
