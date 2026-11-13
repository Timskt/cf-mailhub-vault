import { Hono } from 'hono';
import type { Env, OutlookAccount } from '../types';
import { getAccessToken, fetchEmails } from '../graph';
import { extractVerificationInfo } from '../code-extractor';

const app = new Hono<{ Bindings: Env }>();

export const DEFAULT_MICROSOFT_CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ParsedOutlookItem {
  email: string;
  password?: string;
  client_id: string;
  refresh_token: string;
  remark?: string;
  valid: boolean;
  error?: string;
}

/**
 * 智能解析单行 Outlook/Hotmail 账号数据
 * 支持常见格式：
 * 1. 邮箱----密码----ClientID----RefreshToken
 * 2. 邮箱----密码----RefreshToken (自动补齐默认公用 Client ID)
 * 3. 邮箱----密码----ClientID----RefreshToken----辅助邮箱/备注
 * 4. 任意以 ----、---、::、|、制表符、逗号 分隔的格式
 * 5. JSON 对象字符串
 */
export function parseOutlookLine(line: string): ParsedOutlookItem | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
    return null;
  }

  // 1. 支持直接粘贴 JSON 对象行
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      const email = (obj.email || obj.username || obj.mail || '').trim().toLowerCase();
      const password = (obj.password || obj.pwd || '').trim();
      const clientId = (obj.client_id || obj.clientId || DEFAULT_MICROSOFT_CLIENT_ID).trim();
      const refreshToken = (obj.refresh_token || obj.refreshToken || obj.token || '').trim();
      const remark = (obj.remark || obj.note || '').trim();
      const valid = Boolean(email && email.includes('@') && refreshToken);
      return {
        email,
        password,
        client_id: clientId || DEFAULT_MICROSOFT_CLIENT_ID,
        refresh_token: refreshToken,
        remark,
        valid,
        error: !valid ? 'JSON 数据中未包含有效邮箱地址或 Refresh Token' : undefined
      };
    } catch (e) {}
  }

  // 2. 切分分隔符
  let parts: string[] = [];
  if (trimmed.includes('----')) {
    parts = trimmed.split('----').map(s => s.trim());
  } else if (trimmed.includes('---')) {
    parts = trimmed.split('---').map(s => s.trim());
  } else if (trimmed.includes('::')) {
    parts = trimmed.split('::').map(s => s.trim());
  } else if (trimmed.includes('|')) {
    parts = trimmed.split('|').map(s => s.trim());
  } else if (trimmed.includes('\t')) {
    parts = trimmed.split('\t').map(s => s.trim());
  } else if (trimmed.includes(',') && !trimmed.includes(';')) {
    parts = trimmed.split(',').map(s => s.trim());
  } else {
    parts = trimmed.split(/\s+/).map(s => s.trim());
  }

  parts = parts.filter(Boolean);
  if (parts.length === 0) return null;

  let email = '';
  let password = '';
  let clientId = '';
  let refreshToken = '';
  let remark = '';

  // 识别邮箱部分
  const emailIdx = parts.findIndex(p => EMAIL_REGEX.test(p) || p.includes('@'));
  if (emailIdx !== -1) {
    email = parts[emailIdx].toLowerCase();
    parts.splice(emailIdx, 1);
  }

  // 识别 Client ID (UUID 格式)
  const uuidIdx = parts.findIndex(p => UUID_REGEX.test(p));
  if (uuidIdx !== -1) {
    clientId = parts[uuidIdx];
    parts.splice(uuidIdx, 1);
  }

  // 识别 Refresh Token (以 M. 开头、含 MsaArtifacts、或长度 >= 50)
  const tokenIdx = parts.findIndex(p => p.length >= 50 || p.startsWith('M.') || p.includes('MsaArtifacts'));
  if (tokenIdx !== -1) {
    refreshToken = parts[tokenIdx];
    parts.splice(tokenIdx, 1);
  } else if (parts.length > 0) {
    let maxIdx = 0;
    for (let i = 1; i < parts.length; i++) {
      if (parts[i].length > parts[maxIdx].length) maxIdx = i;
    }
    if (parts[maxIdx].length > 25) {
      refreshToken = parts[maxIdx];
      parts.splice(maxIdx, 1);
    }
  }

  // 若未指定 Client ID，默认使用微软公用客户端 ID
  if (!clientId) {
    clientId = DEFAULT_MICROSOFT_CLIENT_ID;
  }

  // 剩余部分：首个为密码，后续拼接为备注
  if (parts.length > 0) {
    password = parts[0];
    parts.splice(0, 1);
  }
  if (parts.length > 0) {
    remark = parts.join(' | ');
  }

  const valid = Boolean(email && email.includes('@') && refreshToken);
  let error: string | undefined;
  if (!email || !email.includes('@')) {
    error = '未识别到有效邮箱地址';
  } else if (!refreshToken) {
    error = '未识别到有效 Refresh Token';
  }

  return {
    email,
    password,
    client_id: clientId,
    refresh_token: refreshToken,
    remark,
    valid,
    error
  };
}

// 1. 获取 Outlook 账号列表 (支持模糊搜索 q)
app.get('/accounts', async (c) => {
  const query = c.req.query('q')?.trim() || '';
  let sql = `SELECT a.*, g.name as group_name, g.color as group_color
             FROM accounts a
             LEFT JOIN groups g ON a.group_id = g.id`;
  const params: any[] = [];

  if (query) {
    sql += ` WHERE (a.email LIKE ? OR a.remark LIKE ? OR g.name LIKE ?)`;
    const wild = `%${query}%`;
    params.push(wild, wild, wild);
  }

  sql += ` ORDER BY a.id DESC`;

  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ success: true, data: results || [] });
});

// 2. 添加单个 Outlook 账号
app.post('/accounts', async (c) => {
  const body = await c.req.json();
  const { email, client_id, refresh_token, password = '', group_id = 1, remark = '' } = body;

  if (!email || !refresh_token) {
    return c.json({ success: false, message: 'email 和 refresh_token 不能为空' }, 400);
  }

  const effectiveClientId = client_id ? client_id.trim() : DEFAULT_MICROSOFT_CLIENT_ID;

  await c.env.DB.prepare(
    `INSERT INTO accounts (email, client_id, refresh_token, password, group_id, remark)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       client_id = excluded.client_id,
       refresh_token = excluded.refresh_token,
       password = CASE WHEN excluded.password != '' THEN excluded.password ELSE accounts.password END,
       group_id = excluded.group_id,
       remark = CASE WHEN excluded.remark != '' THEN excluded.remark ELSE accounts.remark END,
       updated_at = datetime('now')`
  )
    .bind(email.toLowerCase().trim(), effectiveClientId, refresh_token.trim(), password.trim(), group_id, remark.trim())
    .run();

  return c.json({ success: true, message: '添加/更新成功' });
});

// 3. 批量解析预览接口 (供前端实时解析展示表格与校验)
app.post('/parse-preview', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const rawText = (body.raw_text || '').toString();

  const lines = rawText.split('\n');
  const accounts: ParsedOutlookItem[] = [];
  const errors: { line: number; text: string; error: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const parsed = parseOutlookLine(line);
    if (parsed && parsed.valid) {
      accounts.push(parsed);
    } else {
      errors.push({
        line: i + 1,
        text: line.length > 80 ? `${line.substring(0, 80)}...` : line,
        error: parsed?.error || '无法解析该行数据'
      });
    }
  }

  return c.json({
    success: true,
    total_lines: lines.length,
    valid_count: accounts.length,
    error_count: errors.length,
    accounts,
    errors
  });
});

// 4. 批量导入 Outlook 账号接口
app.post('/batch-import', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const rawText = (body.raw_text || '').toString();
  const rawAccounts = Array.isArray(body.accounts) ? body.accounts : [];
  const groupId = parseInt(body.group_id || '1', 10) || 1;
  const syncToVault = body.sync_to_vault !== false; // 默认同时同步登记至 platform_vault

  const parsedList: ParsedOutlookItem[] = [];
  const errors: { line: number; text: string; error: string }[] = [];

  // 解析文本
  if (rawText.trim()) {
    const trimmed = rawText.trim();
    let handledJson = false;

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const jsonArr = JSON.parse(trimmed);
        if (Array.isArray(jsonArr)) {
          for (let i = 0; i < jsonArr.length; i++) {
            const item = jsonArr[i];
            const lineStr = typeof item === 'string' ? item : JSON.stringify(item);
            const parsed = parseOutlookLine(lineStr);
            if (parsed && parsed.valid) {
              parsedList.push(parsed);
            } else {
              errors.push({ line: i + 1, text: lineStr.substring(0, 80), error: parsed?.error || '无效记录' });
            }
          }
          handledJson = true;
        }
      } catch (e) {}
    }

    if (!handledJson) {
      const lines = rawText.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('#') || line.startsWith('//')) continue;
        const parsed = parseOutlookLine(line);
        if (parsed && parsed.valid) {
          parsedList.push(parsed);
        } else {
          errors.push({
            line: i + 1,
            text: line.length > 80 ? `${line.substring(0, 80)}...` : line,
            error: parsed?.error || '无法识别格式'
          });
        }
      }
    }
  }

  // 融合客户端已经解析的 accounts 列表
  for (const acc of rawAccounts) {
    if (!acc) continue;
    const email = (acc.email || '').trim().toLowerCase();
    const refreshToken = (acc.refresh_token || '').trim();
    const clientId = (acc.client_id || DEFAULT_MICROSOFT_CLIENT_ID).trim();
    const password = (acc.password || '').trim();
    const remark = (acc.remark || '').trim();
    if (email && email.includes('@') && refreshToken) {
      parsedList.push({
        email,
        password,
        client_id: clientId,
        refresh_token: refreshToken,
        remark,
        valid: true
      });
    } else {
      errors.push({ line: 0, text: email || '未命名', error: '缺少邮箱或 Refresh Token' });
    }
  }

  if (parsedList.length === 0) {
    return c.json({
      success: false,
      message: '未能成功识别出任何有效的 Outlook 账号，请检查输入格式',
      errors
    }, 400);
  }

  // 去重 (以邮箱为键，后出现的覆盖先出现的)
  const uniqueMap = new Map<string, ParsedOutlookItem>();
  for (const item of parsedList) {
    uniqueMap.set(item.email, item);
  }
  const accountsToImport = Array.from(uniqueMap.values());

  // 分批写入 D1 (每批最多 30 个账号，确保不超过 D1 单次 batch 上限)
  const CHUNK_SIZE = 30;
  let importedCount = 0;

  for (let i = 0; i < accountsToImport.length; i += CHUNK_SIZE) {
    const chunk = accountsToImport.slice(i, i + CHUNK_SIZE);
    const stmts: any[] = [];

    for (const acc of chunk) {
      // 1. 写入/更新 accounts 表
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO accounts (email, client_id, refresh_token, password, group_id, remark)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(email) DO UPDATE SET
             client_id = excluded.client_id,
             refresh_token = excluded.refresh_token,
             password = CASE WHEN excluded.password != '' THEN excluded.password ELSE accounts.password END,
             group_id = excluded.group_id,
             remark = CASE WHEN excluded.remark != '' THEN excluded.remark ELSE accounts.remark END,
             updated_at = datetime('now')`
        ).bind(
          acc.email,
          acc.client_id || DEFAULT_MICROSOFT_CLIENT_ID,
          acc.refresh_token,
          acc.password || '',
          groupId,
          acc.remark || ''
        )
      );

      // 2. 同步写入 platform_vault 台账表 (若开启)
      if (syncToVault) {
        stmts.push(
          c.env.DB.prepare(
            `INSERT INTO platform_vault (
               platform_name, platform_url, account_email, email_source,
               username, password, status, category, remark
             )
             SELECT 'Outlook', 'https://outlook.live.com', ?, 'outlook', ?, ?, 'active', '微软生态', ?
             WHERE NOT EXISTS (
               SELECT 1 FROM platform_vault WHERE account_email = ? AND platform_name = 'Outlook'
             )`
          ).bind(
            acc.email,
            acc.email.split('@')[0],
            acc.password || '',
            acc.remark ? `批量导入: ${acc.remark}` : '批量导入微软托管账号',
            acc.email
          )
        );

        stmts.push(
          c.env.DB.prepare(
            `UPDATE platform_vault
             SET password = CASE WHEN ? != '' THEN ? ELSE password END,
                 updated_at = datetime('now')
             WHERE account_email = ? AND platform_name = 'Outlook'`
          ).bind(
            acc.password || '',
            acc.password || '',
            acc.email
          )
        );
      }
    }

    if (stmts.length > 0) {
      await c.env.DB.batch(stmts);
    }
    importedCount += chunk.length;
  }

  return c.json({
    success: true,
    message: `成功批量导入 ${importedCount} 个 Outlook 账号${syncToVault ? ' 并同步至平台资产台账' : ''}`,
    count: importedCount,
    skipped: errors.length,
    errors: errors.slice(0, 10)
  });
});

// 5. 单个账号一键提取最新验证码
app.get('/accounts/:id/code', async (c) => {
  const id = c.req.param('id');
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

  if (newRefreshToken && newRefreshToken !== acc.refresh_token) {
    await c.env.DB.prepare(
      "UPDATE accounts SET refresh_token = ?, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(newRefreshToken, acc.id)
      .run();
  }

  const mails = await fetchEmails(token, { folder: 'inbox', top: 5, includeBody: true });
  if (mails.error) {
    return c.json({ success: false, message: `读取邮件失败: ${mails.error.message}` }, 400);
  }

  if (!mails.items || mails.items.length === 0) {
    return c.json({ success: true, data: { has_mail: false, message: 'Outlook 收件箱暂无邮件' } });
  }

  const latest = mails.items[0];
  const info = extractVerificationInfo(
    latest.subject || '',
    latest.bodyPreview || '',
    latest.body?.content || ''
  );

  return c.json({
    success: true,
    data: {
      has_mail: true,
      sender: latest.from?.emailAddress?.name || latest.from?.emailAddress?.address,
      subject: latest.subject,
      received_at: latest.receivedDateTime,
      code: info.code,
      link: info.link,
      message: info.code ? '成功提取最新验证码' : '未在最新邮件中匹配到验证码'
    }
  });
});

// 6. 读取 Outlook 邮件列表
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

  // 若微软下发了新 refresh_token，自动持久化存储
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

// 7. 删除 Outlook 账号
app.delete('/accounts/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
  return c.json({ success: true, message: '已删除' });
});

export default app;
