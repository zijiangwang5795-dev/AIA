'use strict';

/**
 * 技能：发消息给好友
 * 让助手代为向好友发送消息，由对方助手通知其用户。
 */
module.exports = {
  name:         '发消息给好友',
  emoji:        '💬',
  description:  '让助手代为向好友发送消息，由对方助手通知其用户',
  builtin_type: 'send-friend-message',
  allowed_tools: ['send_friend_message'],
  layer1_tools:  ['send_friend_message', 'create_tasks', 'memory_search'],
};
