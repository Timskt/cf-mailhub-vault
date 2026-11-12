import { Hono } from 'hono';
import type { Env, PlatformAccount } from '../types';
import { extractVerificationInfo } from '../code-extractor';
import { getAccessToken, fetchEmails } from '../graph';

const app = new Hono<{ Bindings: Env }>();

// 1. 获取平台注册台账列表 (支持搜索和筛选)
app.get('/', async (c) => {
  const search = c.req.query('q')?.trim() || '';
  const category = c.req.query('category')?.trim() || '';
  const status = c.req.query('status')?.trim() || '';
  const platform = c.req.query('platform')?.trim() || '';
  const hasCode = c.req.query('has_code') === 'true';

  let sql = 'SELECT * FROM platform_vault WHERE 1=1';
  const params: any[] = [];

  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (platform) {
    sql += ' AND LOWER(platform_name) = ?';
    params.push(platform.toLowerCase());
  }
  if (hasCode) {
    sql += " AND last_code != ''";
  }
  if (search) {
    sql += ' AND (platform_name LIKE ? OR account_email LIKE ? OR username LIKE ? OR remark LIKE ? OR last_code LIKE ?)';
    const wild = `%${search}%`;
    params.push(wild, wild, wild, wild, wild);
  }

  sql += ' ORDER BY is_pinned DESC, updated_at DESC, id DESC';

  const { results } = await c.env.DB.prepare(sql).bind(...params).all<PlatformAccount>();
  return c.json({ success: true, data: results || [] });
});

// 1.1 获取所有平台聚合信息及数量 (用于顶部快速切换胶囊)
app.get('/platforms', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT platform_name, count(*) as count
     FROM platform_vault
     GROUP BY LOWER(platform_name)
     ORDER BY count DESC LIMIT 20`
  ).all();

  return c.json({ success: true, data: results || [] });
});

// 1.2 切换置顶状态
app.post('/:id/pin', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare(
    'UPDATE platform_vault SET is_pinned = CASE WHEN is_pinned = 1 THEN 0 ELSE 1 END WHERE id = ?'
  ).bind(id).run();
  return c.json({ success: true, message: '置顶状态已更新' });
});

// 2. 获取统计数据 (用于仪表盘顶部看板)
app.get('/stats', async (c) => {
  const db = c.env.DB;
  const [totalRes, activeRes, cfMailsCount, outlookCount] = await Promise.all([
    db.prepare('SELECT count(*) as count FROM platform_vault').first<{ count: number }>(),
    db.prepare("SELECT count(*) as count FROM platform_vault WHERE status = 'active'").first<{ count: number }>(),
    db.prepare('SELECT count(*) as count FROM cf_inbox_mails').first<{ count: number }>(),
    db.prepare('SELECT count(*) as count FROM accounts').first<{ count: number }>()
  ]);

  const catRows = await db.prepare('SELECT category, count(*) as count FROM platform_vault GROUP BY category').all<{ category: string; count: number }>();

  return c.json({
    success: true,
    data: {
      total_vault_accounts: totalRes?.count || 0,
      active_vault_accounts: activeRes?.count || 0,
      total_cf_mails: cfMailsCount?.count || 0,
      total_outlook_accounts: outlookCount?.count || 0,
      categories: catRows.results || []
    }
  });
});

// 3. 一键创建/登记平台账号 (支持一键分配新自建域名邮箱)
app.post('/', async (c) => {
  const body = await c.req.json();
  let {
    platform_name,
    platform_url = '',
    account_email,
    email_source = 'cf_domain',
    username = '',
    password = '',
    totp_secret = '',
    status = 'active',
    category = 'AI工具',
    proxy_node = '',
    remark = '',
    generate_email = false
  } = body;

  if (!platform_name) {
    return c.json({ success: false, message: '平台名称不能为空' }, 400);
  }

  // 如果请求自动分配自建临时邮箱
  if (generate_email || !account_email) {
    const rawDomains = c.env.CF_DOMAINS || 'example.com';
    const domains = rawDomains.split(',').map(d => d.trim()).filter(Boolean);
    const domain = domains[0] || 'mail.local';
    const prefix = c.env.DEFAULT_PREFIX ? `${c.env.DEFAULT_PREFIX}_` : '';
    const randomStr = Math.random().toString(36).substring(2, 8);
    const sanitizedPlat = platform_name.toLowerCase().replace(/[^a-z0-9]/g, '');
    account_email = `${prefix}${sanitizedPlat}_${randomStr}@${domain}`;
    email_source = 'cf_domain';
  }

  const res = await c.env.DB.prepare(
    `INSERT INTO platform_vault (
      platform_name, platform_url, account_email, email_source,
      username, password, totp_secret, status, category,
      proxy_node, remark
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      platform_name,
      platform_url,
      account_email.toLowerCase().trim(),
      email_source,
      username,
      password,
      totp_secret,
      status,
      category,
      proxy_node,
      remark
    )
    .run();

  // 如果关联的是自建域名收信，将已有历史邮件打上 is_protected 标记，并自动将该邮箱纳为永久保护
  if (email_source === 'cf_domain') {
    const cleanEmail = account_email.toLowerCase().trim();
    const vaultId = res.meta.last_row_id;
    await c.env.DB.prepare(
      'UPDATE cf_inbox_mails SET is_protected = 1 WHERE LOWER(recipient) = ?'
    )
      .bind(cleanEmail)
      .run();

    // 更新或补录到临时邮箱生命周期表，锁定为永久保留
    const existingMb = await c.env.DB.prepare('SELECT id FROM temp_mailboxes WHERE LOWER(address) = ?').bind(cleanEmail).first();
    if (existingMb) {
      await c.env.DB.prepare(
        "UPDATE temp_mailboxes SET is_permanent = 1, associated_platform = ?, associated_vault_id = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(platform_name, vaultId, existingMb.id).run();
    } else {
      const parts = cleanEmail.split('@');
      await c.env.DB.prepare(
        `INSERT OR IGNORE INTO temp_mailboxes (
          address, prefix, domain, is_permanent, associated_platform, associated_vault_id, remark
        ) VALUES (?, ?, ?, 1, ?, ?, ?)`
      ).bind(cleanEmail, parts[0] || '', parts[1] || '', platform_name, vaultId, '关联自平台台账自动转为永久').run();
    }
  }

  return c.json({
    success: true,
    data: { id: res.meta.last_row_id, account_email }
  });
});

// 4. 更新平台台账记录
app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const {
    platform_name,
    platform_url,
    account_email,
    email_source,
    username,
    password,
    totp_secret,
    status,
    category,
    proxy_node,
    remark
  } = body;

  await c.env.DB.prepare(
    `UPDATE platform_vault SET
      platform_name = COALESCE(?, platform_name),
      platform_url = COALESCE(?, platform_url),
      account_email = COALESCE(?, account_email),
      email_source = COALESCE(?, email_source),
      username = COALESCE(?, username),
      password = COALESCE(?, password),
      totp_secret = COALESCE(?, totp_secret),
      status = COALESCE(?, status),
      category = COALESCE(?, category),
      proxy_node = COALESCE(?, proxy_node),
      remark = COALESCE(?, remark),
      updated_at = datetime('now')
    WHERE id = ?`
  )
    .bind(
      platform_name,
      platform_url,
      account_email ? account_email.toLowerCase().trim() : null,
      email_source,
      username,
      password,
      totp_secret,
      status,
      category,
      proxy_node,
      remark,
      id
    )
    .run();

  return c.json({ success: true, message: '更新成功' });
});

// 5. 删除平台台账记录
app.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM platform_vault WHERE id = ?').bind(id).run();
  return c.json({ success: true, message: '删除成功' });
});

// 6. ⚡ 核心杀手级功能：一键查收该平台最新验证码 (Get Latest Verification Code)
app.get('/:id/code', async (c) => {
  const id = c.req.param('id');
  const account = await c.env.DB.prepare('SELECT * FROM platform_vault WHERE id = ?')
    .bind(id)
    .first<PlatformAccount>();

  if (!account) {
    return c.json({ success: false, message: '台账记录不存在' }, 404);
  }

  const targetEmail = account.account_email.toLowerCase().trim();

  // 分支 A: 如果是自建 Cloudflare 域名邮箱
  if (account.email_source === 'cf_domain') {
    const latestMail = await c.env.DB.prepare(
      'SELECT * FROM cf_inbox_mails WHERE LOWER(recipient) = ? ORDER BY created_at DESC LIMIT 1'
    )
      .bind(targetEmail)
      .first<{
        id: number;
        subject: string;
        sender: string;
        verification_code: string;
        verification_link: string;
        text_content: string;
        html_content: string;
        created_at: string;
      }>();

    if (!latestMail) {
      return c.json({
        success: true,
        data: {
          has_mail: false,
          code: account.last_code || '',
          last_code_at: account.last_code_at || '',
          message: '收件箱暂未收到新邮件'
        }
      });
    }

    let code = latestMail.verification_code;
    let link = latestMail.verification_link;

    if (!code) {
      const extracted = extractVerificationInfo(
        latestMail.subject,
        latestMail.text_content,
        latestMail.html_content
      );
      code = extracted.code;
      link = extracted.link;
    }

    return c.json({
      success: true,
      data: {
        has_mail: true,
        code,
        link,
        subject: latestMail.subject,
        sender: latestMail.sender,
        received_at: latestMail.created_at,
        mail_id: latestMail.id
      }
    });
  }

  // 分支 B: 如果是微软 Outlook 邮箱
  if (account.email_source === 'outlook') {
    const outlookAcc = await c.env.DB.prepare(
      'SELECT * FROM accounts WHERE LOWER(email) = ? LIMIT 1'
    )
      .bind(targetEmail)
      .first<{ client_id: string; refresh_token: string }>();

    if (!outlookAcc) {
      return c.json({
        success: false,
        message: `在 Outlook 账号池中未找到绑定的账号: ${targetEmail}`
      });
    }

    const { token, error } = await getAccessToken(outlookAcc.client_id, outlookAcc.refresh_token);
    if (error || !token) {
      return c.json({ success: false, message: `获取 Outlook Token 失败: ${error?.message}` });
    }

    const mailsRes = await fetchEmails(token, { folder: 'inbox', top: 3, includeBody: true });
    if (mailsRes.error || !mailsRes.items || mailsRes.items.length === 0) {
      return c.json({ success: true, data: { has_mail: false, message: 'Outlook 收件箱暂无邮件' } });
    }

    const latest = mailsRes.items[0];
    const { code, link } = extractVerificationInfo(
      latest.subject || '',
      latest.bodyPreview || '',
      latest.body?.content || ''
    );

    return c.json({
      success: true,
      data: {
        has_mail: true,
        code,
        link,
        subject: latest.subject,
        sender: latest.from?.emailAddress?.address,
        received_at: latest.receivedDateTime
      }
    });
  }

  return c.json({
    success: false,
    message: '暂不支持该邮箱来源的自动查信'
  });
});

export default app;
