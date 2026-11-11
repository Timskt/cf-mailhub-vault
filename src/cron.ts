import type { Env, OutlookAccount } from './types';
import { getAccessToken } from './graph';

export async function runTokenRefresh(env: Env): Promise<void> {
  try {
    const { results } = await env.DB.prepare(
      "SELECT * FROM accounts WHERE status = 'active'"
    ).all<OutlookAccount>();

    if (!results || results.length === 0) return;

    for (const acc of results) {
      try {
        const { token, newRefreshToken } = await getAccessToken(acc.client_id, acc.refresh_token);
        if (token && newRefreshToken && newRefreshToken !== acc.refresh_token) {
          await env.DB.prepare(
            "UPDATE accounts SET refresh_token = ?, updated_at = datetime('now') WHERE id = ?"
          )
            .bind(newRefreshToken, acc.id)
            .run();
        }
      } catch (err) {
        console.error(`Cron refresh failed for ${acc.email}:`, err);
      }
    }
  } catch (e) {
    console.error('runTokenRefresh error:', e);
  }
}

export async function runCleanup(env: Env): Promise<void> {
  try {
    // 自动清理超过 15 天且未受保护（未绑定平台、未固定）的临时邮件
    await env.DB.prepare(
      "DELETE FROM cf_inbox_mails WHERE is_protected = 0 AND is_pinned = 0 AND created_at < datetime('now', '-15 days')"
    ).run();
  } catch (e) {
    console.error('runCleanup error:', e);
  }
}
