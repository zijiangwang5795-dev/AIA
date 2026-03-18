'use strict';
require('dotenv').config();
const { db } = require('./client');

const SQL = `
-- ── 扩展 ─────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- ── 用户 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  display_name    VARCHAR(100) NOT NULL DEFAULT 'User',
  avatar_emoji    VARCHAR(10) DEFAULT '👤',
  avatar_url      VARCHAR(500),
  phone           VARCHAR(20) UNIQUE,
  email           VARCHAR(255) UNIQUE,
  talent          VARCHAR(50) DEFAULT 'default',
  soul_prompt     TEXT,
  assistant_name  VARCHAR(100) DEFAULT '我的助手',
  assistant_emoji VARCHAR(10)  DEFAULT '🤖',
  preferred_model VARCHAR(50),
  is_searchable   BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  last_login      TIMESTAMPTZ
);

-- ── OAuth 账号绑定 ────────────────────────────────────
CREATE TABLE IF NOT EXISTS oauth_accounts (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  provider    VARCHAR(20) NOT NULL,
  provider_id VARCHAR(255) NOT NULL,
  UNIQUE(provider, provider_id)
);

-- ── Refresh Tokens（多设备）──────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) NOT NULL,
  device_tag VARCHAR(100),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── OTP 验证码 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otp_codes (
  phone      VARCHAR(20) PRIMARY KEY,
  code       VARCHAR(6) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

-- ── 任务 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  title       VARCHAR(500) NOT NULL,
  description TEXT,
  priority    VARCHAR(10) DEFAULT 'med',
  category    VARCHAR(50) DEFAULT 'general',
  deadline    VARCHAR(100),
  status      VARCHAR(20) DEFAULT 'pending',
  source      VARCHAR(20) DEFAULT 'manual',
  run_id      VARCHAR(50),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, status, created_at DESC);

-- ── 技能 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skills (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  name          VARCHAR(100) NOT NULL,
  emoji         VARCHAR(10) DEFAULT '⚡',
  description   TEXT,
  builtin_type  VARCHAR(50),
  allowed_tools TEXT[],
  model_pref    VARCHAR(50),
  is_builtin    BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Agent 运行记录 ────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_runs (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id       VARCHAR(50) UNIQUE NOT NULL,
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  skill_id     UUID REFERENCES skills(id) ON DELETE SET NULL,
  goal         TEXT,
  status       VARCHAR(20) DEFAULT 'running',
  output       TEXT,
  total_steps  INTEGER DEFAULT 0,
  started_at   TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- ── 长期记忆（KV）────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_memories (
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  key        VARCHAR(200),
  value      TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY(user_id, key)
);

-- ── 情节记忆（向量）──────────────────────────────────
CREATE TABLE IF NOT EXISTS episodic_memories (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  summary    TEXT NOT NULL,
  embedding  vector(1536),
  run_id     VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_episodic_user ON episodic_memories(user_id);
-- 向量索引在有数据后创建更有效
-- CREATE INDEX ON episodic_memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ── 好友关系 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS friendships (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  requester_id UUID REFERENCES users(id) ON DELETE CASCADE,
  recipient_id UUID REFERENCES users(id) ON DELETE CASCADE,
  status       VARCHAR(20) DEFAULT 'pending',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(requester_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_friendships_recipient ON friendships(recipient_id, status);

-- ── 聊天消息 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   UUID REFERENCES users(id) ON DELETE CASCADE,
  content      TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  read_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(from_user_id, to_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_to   ON messages(to_user_id, created_at DESC);

-- ── 好友隐私设置 ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS friend_privacy (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  show_tasks    BOOLEAN DEFAULT FALSE,
  show_skills   BOOLEAN DEFAULT TRUE,
  show_activity BOOLEAN DEFAULT TRUE,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── 订阅计划 ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  id              VARCHAR(20) PRIMARY KEY,
  name            VARCHAR(50) NOT NULL,
  price_cny       DECIMAL(10,2) DEFAULT 0,
  price_usd       DECIMAL(10,4) DEFAULT 0,
  monthly_ai_calls INT DEFAULT 100,   -- -1 = 无限制
  max_skills      INT DEFAULT 5,      -- -1 = 无限制
  max_memory_mb   INT DEFAULT 50,
  features        JSONB DEFAULT '{}',
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 用户订阅 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                 UUID REFERENCES users(id) ON DELETE CASCADE,
  plan_id                 VARCHAR(20) REFERENCES plans(id),
  status                  VARCHAR(20) DEFAULT 'active', -- active/expired/cancelled/trial
  period_start            TIMESTAMPTZ DEFAULT NOW(),
  period_end              TIMESTAMPTZ,
  payment_method          VARCHAR(30),
  external_subscription_id VARCHAR(100),
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)  -- 每用户只有一条活跃订阅
);

-- ── 月度用量汇总（快速查询配额）────────────────────────
CREATE TABLE IF NOT EXISTS monthly_usage (
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  year_month   VARCHAR(7) NOT NULL,  -- '2026-03'
  ai_calls     INT DEFAULT 0,
  input_tokens BIGINT DEFAULT 0,
  output_tokens BIGINT DEFAULT 0,
  cost_usd     DECIMAL(10,4) DEFAULT 0,
  PRIMARY KEY(user_id, year_month)
);
CREATE INDEX IF NOT EXISTS idx_monthly_usage_user ON monthly_usage(user_id, year_month DESC);

-- ── 用户反馈 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feedback (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  type         VARCHAR(20) DEFAULT 'general',  -- bug/feature/general
  content      TEXT NOT NULL,
  contact_info VARCHAR(100),
  app_version  VARCHAR(20),
  platform     VARCHAR(20) DEFAULT 'web',
  status       VARCHAR(20) DEFAULT 'open',  -- open/processing/resolved
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id, created_at DESC);

-- ── 推送令牌（FCM / APNs）───────────────────────────
CREATE TABLE IF NOT EXISTS push_tokens (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  platform   VARCHAR(10) DEFAULT 'android',  -- android/ios/web
  device_tag VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(token)
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(user_id);

-- ── AI 审计日志 ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_audit_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  run_id        VARCHAR(50),
  model         VARCHAR(50),
  routing_rule  VARCHAR(100),
  intent        VARCHAR(50),
  input_tokens  INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  latency_ms    INTEGER DEFAULT 0,
  cost_usd      DECIMAL(10,6) DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON ai_audit_logs(user_id, created_at DESC);

-- ── 插入默认订阅计划 ──────────────────────────────────
INSERT INTO plans (id, name, price_cny, price_usd, monthly_ai_calls, max_skills, max_memory_mb, features) VALUES
  ('free',       '免费版', 0,    0,     100,  5,  50,   '{"voice":true,"friends":true,"custom_soul":false,"priority_support":false}'),
  ('pro',        '专业版', 68,   9.99,  2000, 20, 500,  '{"voice":true,"friends":true,"custom_soul":true,"priority_support":false}'),
  ('enterprise', '企业版', 688,  99,   -1,   -1,  5000, '{"voice":true,"friends":true,"custom_soul":true,"priority_support":true,"api_access":true}')
ON CONFLICT (id) DO NOTHING;

-- ── Demo 用户（内置技能归属） ─────────────────────────
INSERT INTO users (id, display_name, email) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Demo User', 'demo@example.com')
  ON CONFLICT DO NOTHING;
-- 内置技能由 src/skills/index.js 的 seedBuiltinSkills() 写入，不再硬编码于此

-- ── 增量迁移：给已有表追加新列（IF NOT EXISTS 保证幂等）────
-- 消息表：记录发送者类型（user=用户直接发 / assistant=助手代发）
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_type VARCHAR(20) DEFAULT 'user';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_name VARCHAR(100);

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_emoji    VARCHAR(10)  DEFAULT '👤';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url      VARCHAR(500);
ALTER TABLE users ADD COLUMN IF NOT EXISTS talent          VARCHAR(50)  DEFAULT 'default';
ALTER TABLE users ADD COLUMN IF NOT EXISTS soul_prompt     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS assistant_name  VARCHAR(100) DEFAULT '我的助手';
ALTER TABLE users ADD COLUMN IF NOT EXISTS assistant_emoji VARCHAR(10)  DEFAULT '🤖';
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_model VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_searchable   BOOLEAN      DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login      TIMESTAMPTZ;

-- ── 商业化增量迁移 ────────────────────────────────────
-- 管理员标志（/admin/* 权限后备校验）
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
-- Stripe Customer ID（与 Stripe 账户关联，避免重复创建 Customer）
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(50);
-- Stripe Price ID（plans 表：每个计划对应 Stripe 中的 Price 对象）
ALTER TABLE plans ADD COLUMN IF NOT EXISTS stripe_price_id VARCHAR(50);

-- ── 补充性能索引 ─────────────────────────────────────
-- refresh_tokens：按 expires_at 加速过期清理；id 已是 PK 无需重复
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_exp ON refresh_tokens(user_id, expires_at);

-- skills：按 user_id 加速查询
CREATE INDEX IF NOT EXISTS idx_skills_user ON skills(user_id, is_builtin);

-- skills：内置技能按 builtin_type 唯一（用于 upsert）
CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_builtin_type ON skills(builtin_type) WHERE is_builtin = true;

-- users：is_searchable 过滤（用户搜索场景）
CREATE INDEX IF NOT EXISTS idx_users_searchable ON users(is_searchable, display_name);

-- users：stripe_customer_id 查找
CREATE INDEX IF NOT EXISTS idx_users_stripe ON users(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- user_subscriptions：external_subscription_id（Webhook 回调按此字段更新）
CREATE INDEX IF NOT EXISTS idx_subscriptions_ext ON user_subscriptions(external_subscription_id)
  WHERE external_subscription_id IS NOT NULL;

-- messages：sender_type 过滤（查询助手代发消息）
CREATE INDEX IF NOT EXISTS idx_messages_sender_type ON messages(to_user_id, sender_type, created_at DESC);

-- ── 群组功能 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  emoji       VARCHAR(10) DEFAULT '👥',
  description TEXT,
  creator_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id   UUID REFERENCES groups(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  role       VARCHAR(20) DEFAULT 'member',
  joined_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     UUID REFERENCES groups(id) ON DELETE CASCADE,
  from_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  content      TEXT NOT NULL,
  sender_name  VARCHAR(100),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── 执行记录增强 ───────────────────────────────────────
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS skill_name TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS run_steps  JSONB DEFAULT '[]'::jsonb;

-- ── 新增索引 ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_agent_runs_user    ON agent_runs(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_group_messages_grp ON group_messages(group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
`;

async function migrate() {
  console.log('🗄️  Running database migrations...');
  try {
    await db.query(SQL);
    console.log('✅ Migrations complete!');
  } catch (err) {
    console.error('❌ Migration error:', err.message);
    // pgvector 未安装时降级
    if (err.message.includes('vector')) {
      console.log('⚠️  pgvector not available, skipping vector columns...');
      const fallbackSQL = SQL.replace(/vector\(\d+\)/g, 'TEXT')
        .replace(/CREATE EXTENSION IF NOT EXISTS vector;/, '-- pgvector skipped');
      await db.query(fallbackSQL);
      console.log('✅ Migrations complete (without pgvector)');
    } else {
      throw err;
    }
  }

  // 从 src/skills/definitions/*.js 加载内置技能并 upsert 到数据库
  const { seedBuiltinSkills } = require('../skills');
  await seedBuiltinSkills(db.query.bind(db));
  console.log('✅ Builtin skills seeded');
}

// 支持直接执行：node migrate.js
if (require.main === module) {
  migrate()
    .then(() => db.end())
    .catch(e => { console.error(e); db.end(); process.exit(1); });
}

module.exports = { migrate };
