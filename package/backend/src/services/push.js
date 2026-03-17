'use strict';
/**
 * 推送通知服务 — Firebase Cloud Messaging (Android) + APNs (iOS)
 *
 * 环境变量：
 *   FIREBASE_CREDENTIALS  Firebase Admin SDK 服务账号 JSON 字符串（必需）
 *
 * 未配置时服务降级：记录日志，不抛出异常。
 */

const { query } = require('../db/client');

let _messaging = null;

function getMessaging() {
  if (_messaging) return _messaging;

  const creds = process.env.FIREBASE_CREDENTIALS;
  if (!creds) return null;

  try {
    const admin = require('firebase-admin');
    // 避免重复初始化（多 require 场景）
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(creds)),
      });
    }
    _messaging = admin.messaging();
    return _messaging;
  } catch (err) {
    console.warn('[Push] Firebase init error:', err.message);
    return null;
  }
}

/**
 * 向单个 FCM/APNs token 发送推送
 * @param {string} token   - 设备推送令牌
 * @param {string} platform - 'android' | 'ios'
 * @param {string} title
 * @param {string} body
 * @param {object} data    - 附加键值（均须为字符串）
 * @returns {{ success: boolean, messageId?: string, error?: string }}
 */
async function sendToToken(token, platform, title, body, data = {}) {
  const messaging = getMessaging();
  if (!messaging) {
    console.log(`[Push][SKIP] ${platform} → ${token.slice(0, 12)}… | ${title}`);
    return { success: false, skipped: true, reason: 'firebase not configured' };
  }

  // 所有 data 字段必须是字符串
  const safeData = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, String(v)])
  );

  const message = {
    token,
    notification: { title, body },
    data: safeData,
    android: {
      priority: 'high',
      notification: { sound: 'default', channelId: 'ai_assistant_default' },
    },
    apns: {
      payload: { aps: { sound: 'default', badge: 1 } },
    },
  };

  try {
    const messageId = await messaging.send(message);
    return { success: true, messageId };
  } catch (err) {
    // token 失效时从数据库删除
    if (err.code === 'messaging/registration-token-not-registered' ||
        err.code === 'messaging/invalid-registration-token') {
      await query('DELETE FROM push_tokens WHERE token=$1', [token]).catch(() => {});
    }
    return { success: false, error: err.message, code: err.code };
  }
}

/**
 * 向指定用户的所有设备发送推送通知
 * @param {string} targetUserId
 * @param {{ title: string, body: string, data?: object }} notification
 * @returns {{ sent: number, failed: number, total: number }}
 */
async function sendPushToUser(targetUserId, { title, body, data = {} }) {
  const tokensRes = await query(
    'SELECT token, platform FROM push_tokens WHERE user_id=$1',
    [targetUserId]
  ).catch(() => ({ rows: [] }));

  const tokens = tokensRes.rows;
  if (!tokens.length) return { sent: 0, failed: 0, total: 0 };

  const results = await Promise.allSettled(
    tokens.map(({ token, platform }) => sendToToken(token, platform, title, body, data))
  );

  let sent = 0, failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value?.success) sent++;
    else failed++;
  }
  return { sent, failed, total: tokens.length };
}

/**
 * 批量发送（广播），最多 500 tokens/批（FCM 限制）
 * @param {string[]} tokens
 * @param {{ title: string, body: string, data?: object }} notification
 */
async function sendMulticast(tokens, { title, body, data = {} }) {
  const messaging = getMessaging();
  if (!messaging || !tokens.length) {
    return { successCount: 0, failureCount: tokens.length };
  }

  const safeData = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, String(v)])
  );

  const message = {
    tokens,
    notification: { title, body },
    data: safeData,
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
  };

  const response = await messaging.sendEachForMulticast(message);
  return { successCount: response.successCount, failureCount: response.failureCount };
}

module.exports = { sendPushToUser, sendToToken, sendMulticast };
