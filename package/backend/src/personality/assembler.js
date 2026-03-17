'use strict';
const { query } = require('../db/client');

// ── L1 灵魂层（固定）────────────────────────────────
// assistantName 由 assembleSystemPrompt 动态注入
function buildSoul(assistantName) {
  return `你是"${assistantName}"，一个高度个性化的语音任务管理助理。

## 核心人格
- 语言：默认中文，跟随用户语言自动切换
- 语气：专业但亲切，像一位可信赖的高效同事
- 遇到模糊指令时：主动追问而不是猜测执行
- 遇到无法完成的任务时：诚实说明原因，提供替代方案

## 行为规则
- 专注于任务和效率，不主动发起无关闲聊
- 记住用户的偏好和习惯，下次不重复询问
- 提取到任务时，必须告知用户已创建哪些任务
- 回答简洁有力，避免无意义的客套话
- 今日日期：${new Date().toLocaleDateString('zh-CN')}`;
}

// ── L2 天赋层（按用户职业加载）──────────────────────
const TALENTS = {
  'software-engineer': `
## 工程师天赋
- 理解代码相关术语（PR、branch、bug、sprint、CI/CD 等）
- 任务优先级参考代码风险和上线窗口
- 能识别"代码审查/评审/联调/测试/上线"等关键节点
- 支持 Jira/Linear 风格的任务描述格式`,

  'product-manager': `
## 产品经理天赋
- 理解 PRD / 用户故事 / OKR / KPI 语境
- 按用户价值与交付周期推断优先级
- 能识别"需求评审/排期/迭代/MVP/上线"等关键节点
- 擅长将模糊想法结构化为可执行任务`,

  'student': `
## 学生天赋
- 理解学业相关词汇（作业、考试、论文、答辩、选课等）
- 任务优先级参考截止日期和考试安排
- 能拆解大型学习目标为可执行的小任务`,

  'default': `
## 通用助理天赋
- 以效率和准确为首要目标
- 适配各种工作和生活场景
- 善于将模糊的想法转化为清晰的任务`,
};

// ── 运行时动态状态（每次请求注入）──────────────────
function buildRuntimeContext({ user, pendingTaskCount, hour, errorCount }) {
  const timeLabel = hour >= 22 || hour < 7 ? '深夜模式（回应简洁）' :
    hour < 12 ? '上午工作模式' : hour < 18 ? '下午工作模式' : '晚间模式';

  return `
## 当前运行时状态
- 用户：${user.displayName || '用户'}${user.talent !== 'default' ? `（${user.talent}）` : ''}
- 当前时间：${new Date().toLocaleString('zh-CN')}（${timeLabel}）
- 待处理任务数：${pendingTaskCount} 项
${errorCount > 2 ? '- 注意：用户本轮交互遇到了一些问题，请更耐心地引导' : ''}`;
}

// ── 记忆摘要注入 ─────────────────────────────────────
async function buildMemoryContext(userId) {
  try {
    const memRes = await query(
      `SELECT key, value FROM user_memories WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 10`,
      [userId]
    );
    if (!memRes.rows.length) return '';

    const lines = memRes.rows.map(r => `- ${r.key}：${r.value}`).join('\n');
    return `\n## 关于用户的长期记忆\n${lines}`;
  } catch {
    return '';
  }
}

// ── 情节记忆检索（相似查询，通过 OpenClaw 获取 embedding）─
async function searchEpisodicMemory(userId, query_text) {
  const { isOpenClawConfigured, createEmbedding } = require('../brain/openclaw/client');
  // OpenClaw 未配置且无 OpenAI key 时跳过向量检索
  if (!isOpenClawConfigured() && !process.env.OPENAI_API_KEY) return [];
  try {
    const embedding = await createEmbedding(query_text);
    const res = await query(
      `SELECT summary, 1 - (embedding <=> $1::vector) AS similarity
       FROM episodic_memories WHERE user_id=$2
       ORDER BY similarity DESC LIMIT 3`,
      [JSON.stringify(embedding), userId]
    );
    return res.rows.filter(r => r.similarity > 0.75).map(r => r.summary);
  } catch {
    return [];
  }
}

// ── 完整 System Prompt 组装 ──────────────────────────
async function assembleSystemPrompt(userId, userInput = '') {
  let user = { displayName: '用户', talent: 'default' };
  let pendingTaskCount = 0;

  try {
    const userRes = await query(`SELECT * FROM users WHERE id=$1`, [userId]);
    if (userRes.rows[0]) {
      user = {
        displayName: userRes.rows[0].display_name,
        talent: userRes.rows[0].talent || 'default',
        preferredModel: userRes.rows[0].preferred_model,
        soulPrompt: userRes.rows[0].soul_prompt,
        assistantName: userRes.rows[0].assistant_name || 'AI 助手',
      };
    }
    const taskRes = await query(
      `SELECT COUNT(*) FROM tasks WHERE user_id=$1 AND status='pending'`,
      [userId]
    );
    pendingTaskCount = parseInt(taskRes.rows[0]?.count || '0');
  } catch { /* 数据库不可用时优雅降级 */ }

  const hour = new Date().getHours();
  const baseSoul = buildSoul(user.assistantName || 'AI 助手');
  // 如果用户自定义了灵魂提示词，使用用户自定义的；否则使用默认
  const soul = user.soulPrompt ? `${baseSoul}\n\n## 用户自定义人格补充\n${user.soulPrompt}` : baseSoul;
  const talent = TALENTS[user.talent] || TALENTS['default'];
  const runtime = buildRuntimeContext({ user, pendingTaskCount, hour, errorCount: 0 });
  const memory = await buildMemoryContext(userId);

  // 情节记忆（如果有输入文本）
  let episodic = '';
  if (userInput) {
    const episodes = await searchEpisodicMemory(userId, userInput);
    if (episodes.length) {
      episodic = `\n## 相关历史经验\n${episodes.map(e => `- ${e}`).join('\n')}`;
    }
  }

  return [soul, talent, runtime, memory, episodic]
    .filter(Boolean)
    .join('\n\n---\n\n');
}

// ── 静态人格组装（同步到 OpenClaw Agent 配置用）────────
/**
 * 只包含「不随请求变化」的部分：soul + talent + soul_prompt。
 * 用于 profile 更新时推送到 OpenClaw，避免每次请求重传完整 persona。
 *
 * 不包含：运行时状态（时间/任务数）、记忆（长期/情节）。
 *
 * @param {object} user  来自 DB 的 users 记录
 * @param {string} user.assistantName
 * @param {string} user.talent
 * @param {string} [user.soulPrompt]
 * @param {string} [user.displayName]
 */
function buildStaticPersona(user) {
  const name    = user.assistantName || 'AI 助手';
  const soul    = buildSoul(name);
  const talent  = TALENTS[user.talent] || TALENTS['default'];
  const custom  = user.soulPrompt ? `\n\n## 用户自定义人格补充\n${user.soulPrompt}` : '';
  return [soul, talent, custom].filter(Boolean).join('\n\n---\n\n');
}

module.exports = { assembleSystemPrompt, buildStaticPersona, buildSoul, TALENTS };
