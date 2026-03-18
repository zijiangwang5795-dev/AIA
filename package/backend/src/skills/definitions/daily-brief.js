'use strict';

/**
 * 技能：智能日报
 * 读取今日任务，生成工作日报摘要。
 */
module.exports = {
  name:         '智能日报',
  emoji:        '📊',
  description:  '根据今日任务生成工作日报',
  builtin_type: 'daily-brief',
  allowed_tools: ['memory_search', 'get_tasks'],
  layer1_tools:  ['memory_search', 'get_tasks'],
};
