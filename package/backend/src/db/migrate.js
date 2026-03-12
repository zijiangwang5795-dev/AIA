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

-- ── 插入默认技能 ──────────────────────────────────────
INSERT INTO users (id, display_name, email) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Demo User', 'demo@example.com')
  ON CONFLICT DO NOTHING;

INSERT INTO skills (user_id, name, emoji, description, builtin_type, allowed_tools, is_builtin) VALUES
  ('00000000-0000-0000-0000-000000000001', 'AI新闻整理', '📰', '搜索整理当天最重要的AI行业新闻', 'ai-news', ARRAY['web_search','create_tasks'], true),
  ('00000000-0000-0000-0000-000000000001', '智能日报', '📊', '根据今日任务生成工作日报', 'daily-brief', ARRAY['memory_search'], true),
  ('00000000-0000-0000-0000-000000000001', '语音分析', '🎙️', '分析语音内容，提取任务和待办', 'analyze-voice', ARRAY['create_tasks','memory_search'], true)
  ON CONFLICT DO NOTHING;
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
  } finally {
    await db.end();
  }
}

migrate().catch(console.error);
