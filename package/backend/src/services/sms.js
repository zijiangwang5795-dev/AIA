'use strict';
/**
 * 短信服务 — 阿里云 SMS（国内）/ Twilio（国际）
 *
 * 环境变量（至少配置一种）：
 *   阿里云：ALIYUN_SMS_KEY, ALIYUN_SMS_SECRET, ALIYUN_SMS_SIGN, ALIYUN_SMS_TEMPLATE
 *   Twilio： TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM
 *
 * DEMO_MODE=true 时跳过实际发送，验证码会包含在 API 响应中（方便测试）。
 */

/**
 * 发送 OTP 短信
 * @param {string} phone  - E.164 格式，如 +8613800138000，或纯数字 13800138000
 * @param {string} code   - 6 位验证码
 * @returns {{ sent: boolean, provider: string, demo?: boolean }}
 */
async function sendSMS(phone, code) {
  if (process.env.DEMO_MODE === 'true') {
    return { sent: true, provider: 'demo', demo: true };
  }

  // ── 阿里云短信（优先，适合国内） ─────────────────
  if (process.env.ALIYUN_SMS_KEY && process.env.ALIYUN_SMS_SECRET) {
    return sendAliyun(phone, code);
  }

  // ── Twilio（国际备用）────────────────────────────
  if (process.env.TWILIO_SID && process.env.TWILIO_TOKEN) {
    return sendTwilio(phone, code);
  }

  throw new Error(
    '未配置短信服务。请在 .env 中设置 ALIYUN_SMS_KEY 或 TWILIO_SID。' +
    '开发阶段可设置 DEMO_MODE=true 跳过短信发送。'
  );
}

// ── 阿里云 SMS ────────────────────────────────────
async function sendAliyun(phone, code) {
  const Core = require('@alicloud/pop-core');

  const client = new Core({
    accessKeyId:     process.env.ALIYUN_SMS_KEY,
    accessKeySecret: process.env.ALIYUN_SMS_SECRET,
    endpoint:        'https://dysmsapi.aliyuncs.com',
    apiVersion:      '2017-05-25',
  });

  const result = await client.request('SendSms', {
    RegionId:       'cn-hangzhou',
    PhoneNumbers:   phone,
    SignName:       process.env.ALIYUN_SMS_SIGN     || 'AI助手',
    TemplateCode:   process.env.ALIYUN_SMS_TEMPLATE || 'SMS_000000',
    TemplateParam:  JSON.stringify({ code }),
  }, { method: 'POST' });

  if (result.Code !== 'OK') {
    throw new Error(`阿里云短信发送失败: ${result.Message} (${result.Code})`);
  }

  return { sent: true, provider: 'aliyun', requestId: result.RequestId };
}

// ── Twilio ────────────────────────────────────────
async function sendTwilio(phone, code) {
  const twilio = require('twilio');
  const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

  // 确保手机号包含国际区号
  const to = phone.startsWith('+') ? phone : `+86${phone}`;

  const msg = await client.messages.create({
    to,
    from: process.env.TWILIO_FROM,
    body: `【AI助手】您的验证码是 ${code}，60秒内有效，请勿泄露。`,
  });

  return { sent: true, provider: 'twilio', sid: msg.sid };
}

module.exports = { sendSMS };
