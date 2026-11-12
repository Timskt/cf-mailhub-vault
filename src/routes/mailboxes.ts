import { Hono } from 'hono';
import type { Env, TempMailbox } from '../types';

const app = new Hono<{ Bindings: Env }>();

// 1. 获取所有临时邮箱列表 (附带邮件总数与过期状态)
app.get('/', async (c) => {
  const q = c.req.query('q')?.trim().toLowerCase() || '';
  const status = c.req.query('status') || 'all'; // all, active, permanent, expired

  let sql = `
    SELECT m.*, 
           COUNT(c.id) AS mail_count
    FROM temp_mailboxes m
    LEFT JOIN cf_inbox_mails c ON LOWER(c.recipient) = LOWER(m.address)
    WHERE 1=1
  `;
  const params: any[] = [];

  if (q) {
    sql += ' AND (LOWER(m.address) LIKE ? OR LOWER(m.remark) LIKE ? OR LOWER(m.associated_platform) LIKE ?)';
    const wild = `%${q}%`;
    params.push(wild, wild, wild);
  }

  sql += ' GROUP BY m.id ORDER BY m.is_pinned DESC, m.created_at DESC LIMIT 100';

  const { results } = await c.env.DB.prepare(sql).bind(...params).all<any>();
  const nowIso = new Date().toISOString();

  let list = (results || []).map(r => {
    const isExpired = Boolean(!r.is_permanent && r.expires_at && r.expires_at < nowIso);
    let remainingSeconds = 0;
    if (!r.is_permanent && r.expires_at) {
      const diff = Math.floor((new Date(r.expires_at).getTime() - Date.now()) / 1000);
      remainingSeconds = Math.max(0, diff);
    }
    return {
      ...r,
      is_expired: isExpired,
      remaining_seconds: remainingSeconds
    };
  });

  if (status === 'active') {
    list = list.filter(item => !item.is_expired && !item.is_permanent);
  } else if (status === 'permanent') {
    list = list.filter(item => Boolean(item.is_permanent));
  } else if (status === 'expired') {
    list = list.filter(item => item.is_expired);
  }

  return c.json({ success: true, data: list });
});

// 2. 自动生成新临时邮箱 (默认有效期 1 小时 / 60 分钟)
app.post('/generate', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const rawDomains = c.env.CF_DOMAINS || '439949.xyz';
  const domains = rawDomains.split(',').map(d => d.trim()).filter(Boolean);
  const targetDomain = body.domain && domains.includes(body.domain) ? body.domain : domains[0];

  let prefix = body.prefix ? body.prefix.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') : '';
  if (!prefix) {
    const basePrefix = c.env.DEFAULT_PREFIX ? `${c.env.DEFAULT_PREFIX}_` : 'tmp_';
    const rand = Math.random().toString(36).substring(2, 8);
    prefix = `${basePrefix}${rand}`;
  }

  const address = `${prefix}@${targetDomain}`.toLowerCase();
  const durationMinutes = typeof body.duration_minutes === 'number' ? body.duration_minutes : 60; // 默认 60 分钟 (1小时)
  const isPermanent = Boolean(body.is_permanent || durationMinutes <= 0);

  let expiresAt = '';
  if (!isPermanent) {
    expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();
  }

  const remark = body.remark || '';
  const associatedPlatform = body.associated_platform || '';

  const res = await c.env.DB.prepare(
    `INSERT INTO temp_mailboxes (
      address, prefix, domain, expires_at, is_permanent, 
      associated_platform, remark, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  )
    .bind(address, prefix, targetDomain, expiresAt, isPermanent ? 1 : 0, associatedPlatform, remark)
    .run();

  const id = res.meta.last_row_id;
  const newMailbox = await c.env.DB.prepare('SELECT * FROM temp_mailboxes WHERE id = ?').bind(id).first<TempMailbox>();

  return c.json({
    success: true,
    data: {
      ...newMailbox,
      remaining_seconds: isPermanent ? 0 : durationMinutes * 60,
      is_expired: false
    },
    message: isPermanent ? '已生成永久邮箱' : `已生成临时邮箱，默认有效期 ${durationMinutes} 分钟`
  });
});

// 3. 延长邮箱有效期 (默认延长 +60 分钟)
app.post('/:id/extend', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const minutes = typeof body.minutes === 'number' ? body.minutes : 60;

  const row = await c.env.DB.prepare('SELECT * FROM temp_mailboxes WHERE id = ?').bind(id).first<TempMailbox>();
  if (!row) {
    return c.json({ success: false, message: '临时邮箱不存在' }, 404);
  }

  let baseTime = Date.now();
  if (row.expires_at) {
    const existing = new Date(row.expires_at).getTime();
    if (existing > baseTime) baseTime = existing;
  }

  const newExpiresAt = new Date(baseTime + minutes * 60 * 1000).toISOString();

  await c.env.DB.prepare(
    "UPDATE temp_mailboxes SET expires_at = ?, is_permanent = 0, updated_at = datetime('now') WHERE id = ?"
  )
    .bind(newExpiresAt, id)
    .run();

  return c.json({
    success: true,
    message: `已为该邮箱延长 ${minutes} 分钟`,
    expires_at: newExpiresAt
  });
});

// 4. 切换永久状态 (设为永久 / 取消永久)
app.post('/:id/toggle-permanent', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM temp_mailboxes WHERE id = ?').bind(id).first<TempMailbox>();
  if (!row) {
    return c.json({ success: false, message: '临时邮箱不存在' }, 404);
  }

  const nextPermanent = row.is_permanent ? 0 : 1;
  let newExpiresAt = row.expires_at;

  if (nextPermanent === 1) {
    newExpiresAt = '';
  } else if (!newExpiresAt || new Date(newExpiresAt).getTime() < Date.now()) {
    newExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  }

  await c.env.DB.prepare(
    "UPDATE temp_mailboxes SET is_permanent = ?, expires_at = ?, updated_at = datetime('now') WHERE id = ?"
  )
    .bind(nextPermanent, newExpiresAt, id)
    .run();

  return c.json({
    success: true,
    is_permanent: Boolean(nextPermanent),
    expires_at: newExpiresAt,
    message: nextPermanent ? '已设置为永久邮箱' : '已取消永久，设置为 1 小时有效期'
  });
});

// 5. 绑定到平台台账并转为永久
app.post('/:id/link-vault', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { vault_id, platform_name } = body;

  await c.env.DB.prepare(
    "UPDATE temp_mailboxes SET associated_vault_id = ?, associated_platform = ?, is_permanent = 1, updated_at = datetime('now') WHERE id = ?"
  )
    .bind(vault_id || null, platform_name || '', id)
    .run();

  return c.json({ success: true, message: '已关联平台账号并转为永久保留' });
});

// 6. 销毁删除临时邮箱
app.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM temp_mailboxes WHERE id = ?').bind(id).run();
  return c.json({ success: true, message: '临时邮箱已销毁' });
});

export default app;
