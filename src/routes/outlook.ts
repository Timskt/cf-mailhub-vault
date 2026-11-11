import { Hono } from 'hono';
import type { Env, OutlookAccount } from '../types';
import { getAccessToken, fetchEmails } from '../graph';

const app = new Hono<{ Bindings: Env }>();

// 1. 获取 Outlook 账号列表
app.get('/accounts', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT a.*, g.name as group_name, g.color as group_color
     FROM accounts a
     LEFT JOIN groups g ON a.group_id = g.id
     ORDER BY a.id DESC`
  ).all();

  return c.json({ success: true, data: results || [] });
});

// 2. 添加 Outlook 账号
app.post('/accounts', async (c) => {
  const body = await c.req.json();
  const { email, client_id, refresh_token, password = '', group_id = 1, remark = '' } = body;

  if (!email || !client_id || !refresh_token) {
    return c.json({ success: false, message: 'email、client_id 和 refresh_token 不能为空' }, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO accounts (email, client_id, refresh_token, password, group_id, remark)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       client_id = excluded.client_id,
       refresh_token = excluded.refresh_token,
       password = excluded.password,
       group_id = excluded.group_id,
       remark = excluded.remark,
       updated_at = datetime('now')`
  )
    .bind(email.toLowerCase().trim(), client_id.trim(), refresh_token.trim(), password, group_id, remark)
    .run();

  return c.json({ success: true, message: '添加/更新成功' });
});

// 3. 删除 Outlook 账号
app.delete('/accounts/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
  return c.json({ success: true, message: '已删除' });
});

// 4. 读取 Outlook 邮件列表
app.get('/accounts/:id/emails', async (c) => {
  const id = c.req.param('id');
  const folder = c.req.query('folder') || 'inbox';
  const top = parseInt(c.req.query('top') || '20', 10);
  const keyword = c.req.query('q') || '';

  const acc = await c.env.DB.prepare('SELECT * FROM accounts WHERE id = ?')
    .bind(id)
    .first<OutlookAccount>();

  if (!acc) {
    return c.json({ success: false, message: '账号不存在' }, 404);
  }

  const { token, newRefreshToken, error } = await getAccessToken(acc.client_id, acc.refresh_token);
  if (error || !token) {
    return c.json({ success: false, message: `Token 刷新失败: ${error?.message || '未知错误'}` }, 400);
  }

  // 如果微软下发了新的 refresh_token，自动持久化存储
  if (newRefreshToken && newRefreshToken !== acc.refresh_token) {
    await c.env.DB.prepare(
      "UPDATE accounts SET refresh_token = ?, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(newRefreshToken, acc.id)
      .run();
  }

  const mails = await fetchEmails(token, { folder, top, keyword, includeBody: true });
  if (mails.error) {
    return c.json({ success: false, message: `读取邮件失败: ${mails.error.message}` }, 400);
  }

  return c.json({ success: true, data: mails.items || [] });
});

export default app;
