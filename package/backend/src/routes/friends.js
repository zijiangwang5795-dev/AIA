'use strict';
const { query } = require('../db/client');

module.exports = async function friendsRoutes(app) {

  // ── 通过ID查询用户（用于添加好友）────────────────────
  app.get('/users/lookup/:id', {
    preHandler: [async (req, reply) => {
      try { await req.jwtVerify(); } catch { reply.code(401).send({ error: 'Unauthorized' }); }
    }]
  }, async (req, reply) => {
    const { id } = req.params;
    // UUID 格式校验
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return reply.code(400).send({ error: 'Invalid user ID format' });
    }
    const res = await query(`SELECT id, display_name, avatar_emoji, talent, assistant_name, assistant_emoji FROM users WHERE id=$1`, [id]);
    const u = res.rows[0];
    if (!u) return reply.code(404).send({ error: 'User not found' });
    return {
      id: u.id,
      displayName: u.display_name,
      avatarEmoji: u.avatar_emoji || '👤',
      talent: u.talent,
      assistantName: u.assistant_name,
      assistantEmoji: u.assistant_emoji || '🤖',
    };
  });

  // ── 搜索用户 ──────────────────────────────────────────
  app.get('/users/search', {
    preHandler: [async (req, reply) => {
      try { await req.jwtVerify(); } catch { reply.code(401).send({ error: 'Unauthorized' }); }
    }]
  }, async (req) => {
    const { q = '' } = req.query;
    if (!q.trim()) return { users: [] };

    // 支持手机号精确搜索或昵称模糊搜索
    const res = await query(
      `SELECT id, display_name, avatar_emoji, talent, assistant_name, assistant_emoji, created_at,
              phone LIKE $2 AS phone_match
       FROM users
       WHERE is_searchable = TRUE
         AND id != $1
         AND (
           phone = $3
           OR display_name ILIKE $4
           OR assistant_name ILIKE $4
         )
       LIMIT 20`,
      [req.user.sub, `${q}%`, q, `%${q}%`]
    );

    // 查询各用户与当前用户的关系
    const uids = res.rows.map(u => u.id);
    let relations = {};
    if (uids.length) {
      const relRes = await query(
        `SELECT requester_id, recipient_id, status FROM friendships
         WHERE (requester_id=$1 AND recipient_id=ANY($2))
            OR (recipient_id=$1 AND requester_id=ANY($2))`,
        [req.user.sub, uids]
      );
      for (const r of relRes.rows) {
        const otherId = r.requester_id === req.user.sub ? r.recipient_id : r.requester_id;
        relations[otherId] = {
          status: r.status,
          isRequester: r.requester_id === req.user.sub,
        };
      }
    }

    return {
      users: res.rows.map(u => ({
        id: u.id,
        displayName: u.display_name,
        avatarEmoji: u.avatar_emoji || '👤',
        talent: u.talent,
        assistantName: u.assistant_name || u.display_name,
        assistantEmoji: u.assistant_emoji || '🤖',
        relation: relations[u.id] || null,
      }))
    };
  });

  // ── 获取好友列表 ──────────────────────────────────────
  app.get('/friends', {
    preHandler: [async (req, reply) => {
      try { await req.jwtVerify(); } catch { reply.code(401).send({ error: 'Unauthorized' }); }
    }]
  }, async (req) => {
    const { status = 'accepted' } = req.query;
    const res = await query(
      `SELECT
         f.id AS friendship_id,
         f.status,
         f.created_at,
         f.requester_id,
         f.recipient_id,
         CASE WHEN f.requester_id=$1 THEN u2.id ELSE u1.id END AS friend_id,
         CASE WHEN f.requester_id=$1 THEN u2.display_name ELSE u1.display_name END AS friend_name,
         CASE WHEN f.requester_id=$1 THEN u2.avatar_emoji ELSE u1.avatar_emoji END AS friend_avatar,
         CASE WHEN f.requester_id=$1 THEN u2.talent ELSE u1.talent END AS friend_talent,
         CASE WHEN f.requester_id=$1 THEN u2.assistant_name ELSE u1.assistant_name END AS friend_assistant_name,
         CASE WHEN f.requester_id=$1 THEN u2.assistant_emoji ELSE u1.assistant_emoji END AS friend_assistant_emoji
       FROM friendships f
       JOIN users u1 ON u1.id = f.requester_id
       JOIN users u2 ON u2.id = f.recipient_id
       WHERE (f.requester_id=$1 OR f.recipient_id=$1)
         AND f.status=$2
       ORDER BY f.updated_at DESC`,
      [req.user.sub, status]
    );

    // 未读消息数
    const unreadRes = await query(
      `SELECT from_user_id, COUNT(*) as cnt
       FROM messages
       WHERE to_user_id=$1 AND read_at IS NULL
       GROUP BY from_user_id`,
      [req.user.sub]
    );
    const unread = {};
    for (const r of unreadRes.rows) unread[r.from_user_id] = parseInt(r.cnt);

    return {
      friends: res.rows.map(r => ({
        friendshipId: r.friendship_id,
        friendId: r.friend_id,
        friendName: r.friend_name,
        friendAvatar: r.friend_avatar || '👤',
        friendTalent: r.friend_talent,
        assistantName: r.friend_assistant_name || r.friend_name,
        assistantEmoji: r.friend_assistant_emoji || r.friend_avatar || '🤖',
        status: r.status,
        isRequester: r.requester_id === req.user.sub,
        unreadCount: unread[r.friend_id] || 0,
      }))
    };
  });

  // ── 发送好友申请 ──────────────────────────────────────
  app.post('/friends/request', {
    preHandler: [async (req, reply) => {
      try { await req.jwtVerify(); } catch { reply.code(401).send({ error: 'Unauthorized' }); }
    }]
  }, async (req) => {
    const { recipientId } = req.body || {};
    if (!recipientId) return { error: 'recipientId required' };
    if (recipientId === req.user.sub) return { error: 'Cannot add yourself' };

    // 检查是否已存在
    const existing = await query(
      `SELECT * FROM friendships WHERE
         (requester_id=$1 AND recipient_id=$2) OR
         (requester_id=$2 AND recipient_id=$1)`,
      [req.user.sub, recipientId]
    );
    if (existing.rows[0]) {
      return { friendship: existing.rows[0], message: '关系已存在' };
    }

    const res = await query(
      `INSERT INTO friendships (requester_id, recipient_id, status)
       VALUES ($1, $2, 'pending') RETURNING *`,
      [req.user.sub, recipientId]
    );
    return { friendship: res.rows[0] };
  });

  // ── 处理好友申请（接受/拒绝）────────────────────────
  app.patch('/friends/:id', {
    preHandler: [async (req, reply) => {
      try { await req.jwtVerify(); } catch { reply.code(401).send({ error: 'Unauthorized' }); }
    }]
  }, async (req, reply) => {
    const { id } = req.params;
    const { action } = req.body || {}; // accept | reject | block | remove

    if (action === 'remove') {
      await query(
        `DELETE FROM friendships WHERE id=$1 AND (requester_id=$2 OR recipient_id=$2)`,
        [id, req.user.sub]
      );
      return reply.code(204).send();
    }

    const statusMap = { accept: 'accepted', reject: 'rejected', block: 'blocked' };
    const newStatus = statusMap[action];
    if (!newStatus) return reply.code(400).send({ error: 'Invalid action' });

    const res = await query(
      `UPDATE friendships SET status=$3, updated_at=NOW()
       WHERE id=$1 AND recipient_id=$2 RETURNING *`,
      [id, req.user.sub, newStatus]
    );
    if (!res.rows[0]) return reply.code(404).send({ error: 'Not found' });
    return res.rows[0];
  });

  // ── 获取好友公开资料 ──────────────────────────────────
  app.get('/friends/:friendId/profile', {
    preHandler: [async (req, reply) => {
      try { await req.jwtVerify(); } catch { reply.code(401).send({ error: 'Unauthorized' }); }
    }]
  }, async (req) => {
    const { friendId } = req.params;

    // 验证是好友关系
    const relRes = await query(
      `SELECT * FROM friendships WHERE status='accepted' AND
         ((requester_id=$1 AND recipient_id=$2) OR (requester_id=$2 AND recipient_id=$1))`,
      [req.user.sub, friendId]
    );
    const isFriend = relRes.rows.length > 0;

    const userRes = await query(`SELECT * FROM users WHERE id=$1`, [friendId]);
    const u = userRes.rows[0];
    if (!u) return { error: 'User not found' };

    // 隐私设置
    const privRes = await query(`SELECT * FROM friend_privacy WHERE user_id=$1`, [friendId]);
    const priv = privRes.rows[0] || { show_tasks: false, show_skills: true, show_activity: true };

    const profile = {
      id: u.id,
      displayName: u.display_name,
      avatarEmoji: u.avatar_emoji || '👤',
      talent: u.talent,
      assistantName: u.assistant_name || '我的助手',
      assistantEmoji: u.assistant_emoji || '🤖',
      isFriend,
    };

    if (isFriend && priv.show_skills) {
      const skRes = await query(
        `SELECT name, emoji, description FROM skills WHERE user_id=$1 AND is_builtin=false LIMIT 10`,
        [friendId]
      );
      profile.skills = skRes.rows;
    }

    if (isFriend && priv.show_tasks) {
      const tkRes = await query(
        `SELECT title, priority, status FROM tasks WHERE user_id=$1 AND status='pending' LIMIT 5`,
        [friendId]
      );
      profile.recentTasks = tkRes.rows;
    }

    return profile;
  });

  // ── 发送消息 ──────────────────────────────────────────
  app.post('/messages', {
    preHandler: [async (req, reply) => {
      try { await req.jwtVerify(); } catch { reply.code(401).send({ error: 'Unauthorized' }); }
    }]
  }, async (req) => {
    const { toUserId, content } = req.body || {};
    if (!toUserId || !content) return { error: 'toUserId and content required' };

    // 验证好友关系
    const relRes = await query(
      `SELECT * FROM friendships WHERE status='accepted' AND
         ((requester_id=$1 AND recipient_id=$2) OR (requester_id=$2 AND recipient_id=$1))`,
      [req.user.sub, toUserId]
    );
    if (!relRes.rows.length) {
      // Allow sending if it's pending - first message allowed
    }

    // 获取发送者助手信息，消息标注为来自助手
    const senderRes = await query(
      `SELECT display_name, assistant_name, assistant_emoji FROM users WHERE id=$1`,
      [req.user.sub]
    );
    const sender = senderRes.rows[0];
    const senderName = `${sender?.assistant_emoji || '🤖'} ${sender?.assistant_name || '我的助手'}`;

    const res = await query(
      `INSERT INTO messages (from_user_id, to_user_id, content, sender_type, sender_name)
       VALUES ($1, $2, $3, 'user', $4) RETURNING *`,
      [req.user.sub, toUserId, content.slice(0, 2000), senderName]
    );

    // 推送通知给对方（fire and forget）
    query(`SELECT token FROM push_tokens WHERE user_id=$1 LIMIT 5`, [toUserId])
      .then(tokRes => {
        if (tokRes.rows.length) {
          // TODO: 接入真实 FCM Admin SDK
          app.log.info(`[Push] Message from ${sender?.display_name} → user ${toUserId}`);
        }
      }).catch(() => {});

    return res.rows[0];
  });

  // ── 获取对话消息 ──────────────────────────────────────
  app.get('/messages/:friendId', {
    preHandler: [async (req, reply) => {
      try { await req.jwtVerify(); } catch { reply.code(401).send({ error: 'Unauthorized' }); }
    }]
  }, async (req) => {
    const { friendId } = req.params;
    const { limit = 50, before } = req.query;

    const beforeClause = before ? `AND m.created_at < $4` : '';
    const params = [req.user.sub, friendId, parseInt(limit)];
    if (before) params.push(new Date(before));

    const res = await query(
      `SELECT m.*, u.display_name as from_name, u.avatar_emoji as from_avatar,
              u.assistant_name as from_assistant_name,
              COALESCE(u.assistant_emoji, u.avatar_emoji, '🤖') as from_assistant_emoji
       FROM messages m
       JOIN users u ON u.id = m.from_user_id
       WHERE (
         (m.from_user_id=$1 AND m.to_user_id=$2) OR
         (m.from_user_id=$2 AND m.to_user_id=$1)
       ) ${beforeClause}
       ORDER BY m.created_at DESC
       LIMIT $3`,
      params
    );

    // 标记已读
    await query(
      `UPDATE messages SET read_at=NOW()
       WHERE to_user_id=$1 AND from_user_id=$2 AND read_at IS NULL`,
      [req.user.sub, friendId]
    );

    return { messages: res.rows.reverse() };
  });

  // ── 获取隐私设置 ──────────────────────────────────────
  app.get('/friends/privacy', {
    preHandler: [async (req, reply) => {
      try { await req.jwtVerify(); } catch { reply.code(401).send({ error: 'Unauthorized' }); }
    }]
  }, async (req) => {
    const res = await query(`SELECT * FROM friend_privacy WHERE user_id=$1`, [req.user.sub]);
    return res.rows[0] || {
      user_id: req.user.sub,
      show_tasks: false,
      show_skills: true,
      show_activity: true,
    };
  });

  // ── 更新隐私设置 ──────────────────────────────────────
  app.put('/friends/privacy', {
    preHandler: [async (req, reply) => {
      try { await req.jwtVerify(); } catch { reply.code(401).send({ error: 'Unauthorized' }); }
    }]
  }, async (req) => {
    const { showTasks, showSkills, showActivity } = req.body || {};
    const res = await query(
      `INSERT INTO friend_privacy (user_id, show_tasks, show_skills, show_activity, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         show_tasks=$2, show_skills=$3, show_activity=$4, updated_at=NOW()
       RETURNING *`,
      [req.user.sub, showTasks ?? false, showSkills ?? true, showActivity ?? true]
    );
    return res.rows[0];
  });
};
