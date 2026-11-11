import { Hono } from 'hono';
import type { Env, CfInboxMail } from '../types';
import { extractVerificationInfo } from '../code-extractor';

const app = new Hono<{ Bindings: Env }>();

// 1. 获取当前可用域名列表 (GET /api/domains)
app.get('/domains', (c) => {
  const rawDomains = c.env.CF_DOMAINS || 'example.com';
  const domains = rawDomains.split(',').map(d => d.trim()).filter(Boolean);
  return c.json({ domains });
});

// 2. 创建随机临时邮箱 (POST /api/mailbox/generate)
app.post('/mailbox/generate', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const rawDomains = c.env.CF_DOMAINS || 'example.com';
  const domains = rawDomains.split(',').map(d => d.trim()).filter(Boolean);
  const targetDomain = body.domain && domains.includes(body.domain) ? body.domain : domains[0];

  const prefix = c.env.DEFAULT_PREFIX ? `${c.env.DEFAULT_PREFIX}_` : '';
  const randomStr = Math.random().toString(36).substring(2, 10);
  const address = `${prefix}${randomStr}@${targetDomain}`.toLowerCase();

  // 记录到临时邮箱表
  const res = await c.env.DB.prepare(
    "INSERT INTO temp_emails (email, source, remark) VALUES (?, 'generate', ?)"
  )
    .bind(address, body.expiration || '24h')
    .run();

  return c.json({
    id: res.meta.last_row_id,
    address,
    expiration: body.expiration || '24h',
    created_at: new Date().toISOString()
  });
});

// 3. 创建自定义前缀临时邮箱 (POST /api/mailbox/custom)
app.post('/mailbox/custom', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { prefix, domain, expiration = '24h' } = body;
  if (!prefix) {
    return c.json({ error: 'Missing prefix' }, 400);
  }

  const rawDomains = c.env.CF_DOMAINS || 'example.com';
  const domains = rawDomains.split(',').map(d => d.trim()).filter(Boolean);
  const targetDomain = domain && domains.includes(domain) ? domain : domains[0];
  const sanitized = prefix.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const address = `${sanitized}@${targetDomain}`;

  const res = await c.env.DB.prepare(
    "INSERT OR REPLACE INTO temp_emails (email, source, remark) VALUES (?, 'custom', ?)"
  )
    .bind(address, expiration)
    .run();

  return c.json({
    id: res.meta.last_row_id,
    address,
    expiration,
    created_at: new Date().toISOString()
  });
});

// 4. 获取指定邮箱的邮件列表 (GET /api/emails/list?address=xxx) - 完全对齐 tempmail.jdyun.fun
app.get('/emails/list', async (c) => {
  const address = (c.req.query('address') || c.req.query('mailbox') || '').trim().toLowerCase();
  const q = c.req.query('q')?.trim() || '';

  if (!address) {
    return c.json({ error: 'Missing address parameter' }, 400);
  }

  let sql = 'SELECT id, sender, recipient, subject, created_at, is_read, dkim_status, verification_code FROM cf_inbox_mails WHERE LOWER(recipient) = ?';
  const params: any[] = [address];

  if (q) {
    sql += ' AND (subject LIKE ? OR sender LIKE ? OR verification_code LIKE ?)';
    const wild = `%${q}%`;
    params.push(wild, wild, wild);
  }

  sql += ' ORDER BY created_at DESC LIMIT 50';

  const { results } = await c.env.DB.prepare(sql).bind(...params).all<CfInboxMail>();

  const emails = (results || []).map(m => ({
    id: m.id,
    from: m.sender,
    to: m.recipient,
    subject: m.subject || '(无主题)',
    received_at: m.created_at,
    read: Boolean(m.is_read),
    dkim_verified: m.dkim_status === 'pass' ? '通过' : m.dkim_status === 'fail' ? '失败' : '未签名',
    verify_code: m.verification_code || ''
  }));

  return c.json({ emails });
});

// 5. 获取单封邮件详情 (GET /api/emails/view/:id) - 完全对齐 tempmail.jdyun.fun
app.get('/emails/view/:id', async (c) => {
  const id = c.req.param('id');
  const mail = await c.env.DB.prepare('SELECT * FROM cf_inbox_mails WHERE id = ?')
    .bind(id)
    .first<CfInboxMail>();

  if (!mail) {
    return c.json({ error: 'Email not found' }, 404);
  }

  await c.env.DB.prepare('UPDATE cf_inbox_mails SET is_read = 1 WHERE id = ?').bind(id).run();

  let code = mail.verification_code;
  if (!code) {
    const extracted = extractVerificationInfo(mail.subject, mail.text_content, mail.html_content);
    code = extracted.code;
  }

  return c.json({
    id: mail.id,
    from: mail.sender,
    to: mail.recipient,
    subject: mail.subject,
    body: mail.text_content,
    html_body: mail.html_content,
    received_at: mail.created_at,
    verify_code: code || '',
    dkim_verified: mail.dkim_status === 'pass' ? '通过' : mail.dkim_status === 'fail' ? '失败' : '未签名'
  });
});

export default app;
