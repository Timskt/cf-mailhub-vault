import { Hono } from 'hono';
import type { Env, CfInboxMail } from '../types';

const app = new Hono<{ Bindings: Env }>();

// 1. 获取自建域名收信列表
app.get('/', async (c) => {
  const recipient = c.req.query('recipient')?.trim().toLowerCase() || '';
  const search = c.req.query('q')?.trim() || '';
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  let sql = 'SELECT id, message_id, recipient, sender, sender_name, subject, raw_size, verification_code, dkim_status, spf_status, is_read, is_pinned, is_protected, created_at FROM cf_inbox_mails WHERE 1=1';
  const params: any[] = [];

  if (recipient) {
    sql += ' AND LOWER(recipient) = ?';
    params.push(recipient);
  }
  if (search) {
    sql += ' AND (subject LIKE ? OR sender LIKE ? OR text_content LIKE ? OR verification_code LIKE ?)';
    const wild = `%${search}%`;
    params.push(wild, wild, wild, wild);
  }

  sql += ' ORDER BY is_pinned DESC, created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const { results } = await c.env.DB.prepare(sql).bind(...params).all<CfInboxMail>();
  return c.json({ success: true, data: results || [] });
});

// 2. 获取所有活跃收件地址及其邮件数 (支持按地址搜索与未读统计)
app.get('/recipients', async (c) => {
  const search = c.req.query('q')?.trim().toLowerCase() || '';
  let sql = `
    SELECT recipient, 
           count(*) as mail_count, 
           count(CASE WHEN is_read = 0 THEN 1 END) as unread_count,
           max(is_protected) as is_protected, 
           max(created_at) as last_received_at
    FROM cf_inbox_mails
  `;
  const params: any[] = [];
  if (search) {
    sql += ' WHERE LOWER(recipient) LIKE ?';
    params.push(`%${search}%`);
  }
  sql += ' GROUP BY recipient ORDER BY unread_count DESC, last_received_at DESC';

  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ success: true, data: results || [] });
});

// 3. 获取单封邮件完整详情 (包括 HTML 与文本正文)
app.get('/:id', async (c) => {
  const id = c.req.param('id');
  const mail = await c.env.DB.prepare('SELECT * FROM cf_inbox_mails WHERE id = ?')
    .bind(id)
    .first<CfInboxMail>();

  if (!mail) {
    return c.json({ success: false, message: '邮件不存在' }, 404);
  }

  // 标为已读
  await c.env.DB.prepare('UPDATE cf_inbox_mails SET is_read = 1 WHERE id = ?').bind(id).run();

  return c.json({ success: true, data: mail });
});

// 4. 删除邮件
app.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM cf_inbox_mails WHERE id = ?').bind(id).run();
  return c.json({ success: true, message: '已删除' });
});

// 5. 清理非保护邮件 (一键清理无用的临时测试邮件)
app.post('/clean', async (c) => {
  const res = await c.env.DB.prepare(
    'DELETE FROM cf_inbox_mails WHERE is_protected = 0 AND is_pinned = 0'
  ).run();

  return c.json({ success: true, message: `已清理 ${res.meta.changes} 封临时测试邮件` });
});

export default app;
