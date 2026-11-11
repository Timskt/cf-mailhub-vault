import { Hono } from 'hono';
import type { Env, PlatformAccount, CfInboxMail } from '../types';
import { extractVerificationInfo } from '../code-extractor';

const app = new Hono<{ Bindings: Env }>();

// API Key 鉴权中间件
app.use('*', async (c, next) => {
  const reqKey = c.req.header('X-API-Key') || c.req.query('api_key') || (c.req.header('Authorization')?.replace('Bearer ', ''));
  const serverKey = c.env.API_KEY;

  if (!serverKey || reqKey !== serverKey) {
    return c.json({ success: false, error: 'INVALID_API_KEY', message: 'API Key 无效或未在服务端配置' }, 401);
  }
  return next();
});

// 1. 自动化专用：获取指定邮箱或平台的最新验证码 (直接返回纯净字符串)
app.get('/code', async (c) => {
  const email = c.req.query('email')?.trim().toLowerCase();
  const platform = c.req.query('platform')?.trim();

  let targetEmail = email;

  if (!targetEmail && platform) {
    const acc = await c.env.DB.prepare('SELECT account_email FROM platform_vault WHERE platform_name LIKE ? ORDER BY id DESC LIMIT 1')
      .bind(`%${platform}%`)
      .first<{ account_email: string }>();
    if (acc) targetEmail = acc.account_email;
  }

  if (!targetEmail) {
    return c.json({ success: false, message: '请提供 email 或 platform 查询参数' }, 400);
  }

  const mail = await c.env.DB.prepare(
    'SELECT * FROM cf_inbox_mails WHERE LOWER(recipient) = ? ORDER BY created_at DESC LIMIT 1'
  )
    .bind(targetEmail)
    .first<CfInboxMail>();

  if (!mail) {
    return c.json({ success: false, message: '未收到邮件', code: '' });
  }

  let code = mail.verification_code;
  if (!code) {
    const extracted = extractVerificationInfo(mail.subject, mail.text_content, mail.html_content);
    code = extracted.code;
  }

  return c.json({
    success: true,
    code,
    link: mail.verification_link,
    subject: mail.subject,
    sender: mail.sender,
    received_at: mail.created_at
  });
});

// 2. 自动化专用：一键分配邮箱并写入台账
app.post('/register', async (c) => {
  const body = await c.req.json();
  const { platform_name, password = '', username = '', category = 'AI工具', remark = '' } = body;

  if (!platform_name) {
    return c.json({ success: false, message: 'platform_name 必填' }, 400);
  }

  const rawDomains = c.env.CF_DOMAINS || 'example.com';
  const domains = rawDomains.split(',').map(d => d.trim()).filter(Boolean);
  const domain = domains[0] || 'mail.local';
  const randomStr = Math.random().toString(36).substring(2, 8);
  const sanitized = platform_name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const allocatedEmail = `${sanitized}_${randomStr}@${domain}`;

  const res = await c.env.DB.prepare(
    `INSERT INTO platform_vault (
      platform_name, account_email, email_source, username, password, status, category, remark
    ) VALUES (?, ?, 'cf_domain', ?, ?, 'active', ?, ?)`
  )
    .bind(platform_name, allocatedEmail, username, password, category, remark)
    .run();

  return c.json({
    success: true,
    data: {
      id: res.meta.last_row_id,
      email: allocatedEmail,
      platform_name
    }
  });
});

export default app;
