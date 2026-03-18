'use strict';

/**
 * 技能：AI新闻整理
 * 搜索整理当天最重要的 AI 行业新闻，不创建任务。
 */
module.exports = {
  name:         'AI新闻整理',
  emoji:        '📰',
  description:  '搜索整理当天最重要的AI行业新闻',
  builtin_type: 'ai-news',
  // 执行 goal：支持函数 (input, today) => string 或固定字符串
  goal: (input, today) => `搜索整理今天（${today}）最重要的前10条AI行业新闻，按影响力排序，以结构化方式呈现摘要`,
  // 技能允许调用的工具（DB 记录）
  allowed_tools: ['web_search'],
  // layer1 路由时注入的工具集合（可包含辅助工具）
  layer1_tools:  ['web_search', 'save_memory'],
};
