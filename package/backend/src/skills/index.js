'use strict';

/**
 * 内置技能加载器
 *
 * 约定：src/skills/definitions/*.js 每个文件描述一个内置技能。
 * 服务启动时通过 seedBuiltinSkills() 将技能写入数据库（upsert，幂等）。
 * layer1 路由通过 SKILL_TOOL_MAP 获取每种技能可使用的工具列表。
 */

const fs   = require('fs');
const path = require('path');

const DEFS_DIR = path.join(__dirname, 'definitions');

// 加载所有技能定义文件（按文件名字母序，保证顺序稳定）
const SKILL_DEFS = fs
  .readdirSync(DEFS_DIR)
  .filter(f => f.endsWith('.js'))
  .sort()
  .map(f => require(path.join(DEFS_DIR, f)));

// layer1 路由工具映射：builtin_type → 工具数组
// 仅包含 SKILL_DEFS 中定义的内置技能；其他系统意图由 layer1 自行维护
const SKILL_TOOL_MAP = Object.fromEntries(
  SKILL_DEFS.map(def => [def.builtin_type, def.layer1_tools || def.allowed_tools])
);

const DEMO_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * 将内置技能同步到数据库（幂等 upsert）。
 * 依赖 skills 表上的部分唯一索引：
 *   CREATE UNIQUE INDEX idx_skills_builtin_type ON skills(builtin_type) WHERE is_builtin = true;
 *
 * @param {Function} query  数据库查询函数，签名 (sql, params) => Promise
 */
async function seedBuiltinSkills(query) {
  for (const def of SKILL_DEFS) {
    await query(
      `INSERT INTO skills (user_id, name, emoji, description, builtin_type, allowed_tools, is_builtin)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (builtin_type) WHERE is_builtin = true
       DO UPDATE SET
         name          = EXCLUDED.name,
         emoji         = EXCLUDED.emoji,
         description   = EXCLUDED.description,
         allowed_tools = EXCLUDED.allowed_tools`,
      [DEMO_USER_ID, def.name, def.emoji, def.description, def.builtin_type, def.allowed_tools]
    );
  }
}

module.exports = { SKILL_DEFS, SKILL_TOOL_MAP, seedBuiltinSkills };
