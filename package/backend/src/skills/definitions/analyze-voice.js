'use strict';

/**
 * 技能：语音分析
 * 分析语音内容，提取任务和待办事项。
 */
module.exports = {
  name:         '语音分析',
  emoji:        '🎙️',
  description:  '分析语音内容，提取任务和待办',
  builtin_type: 'analyze-voice',
  goal:         (input) => `分析以下内容，提取所有任务和待办事项，调用 create_tasks 写入清单：\n${input || ''}`,
  allowed_tools: ['create_tasks', 'memory_search'],
  // layer1 携带全量工具：AI 按内容自行决定执行方式
  layer1_tools:  ['create_tasks', 'send_friend_message', 'web_search', 'memory_search', 'save_memory'],
};
