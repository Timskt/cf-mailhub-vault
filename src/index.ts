import { Hono } from 'hono';
import type { Env } from './types';
import { authMiddleware } from './auth';
import { handleIncomingEmail } from './email-handler';
import { runTokenRefresh, runCleanup } from './cron';

import authRoutes from './routes/auth';
import vaultRoutes from './routes/vault';
import cfMailRoutes from './routes/cf-mails';
import outlookRoutes from './routes/outlook';
import externalRoutes from './routes/external';
import settingsRoutes from './routes/settings';

const app = new Hono<{ Bindings: Env }>();

// 全局错误捕获
app.onError((err, c) => {
  console.error('App error:', err);
  const msg = err instanceof Error ? err.message : String(err);
  if (/no such table/i.test(msg)) {
    return c.json({
      success: false,
      error: 'DB_NOT_READY',
      message: '数据库未初始化，请先执行迁移: wrangler d1 migrations apply mailhub-vault-db --remote'
    }, 500);
  }
  return c.json({ success: false, error: 'SERVER_ERROR', message: msg }, 500);
});

// 1. 公开接口
app.route('/api/auth', authRoutes);
app.route('/api/external', externalRoutes);

// 2. 需鉴权接口
app.use('/api/*', authMiddleware());
app.route('/api/vault', vaultRoutes);
app.route('/api/cf-mails', cfMailRoutes);
app.route('/api/outlook', outlookRoutes);
app.route('/api/settings', settingsRoutes);

// 3. 静态前端资源分发 (如果 ASSETS 绑定可用)
app.get('*', async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.text('Cloudflare MailHub & Vault Backend is running.');
});

export default {
  // HTTP 请求入口
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),

  // Cloudflare Email Routing Catch-all 邮件接收入口 (自建域名核心能力)
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleIncomingEmail(message, env, ctx);
  },

  // 定时任务 Cron 触发入口 (自动续期 Token + 定期清理过期临时邮件)
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runTokenRefresh(env));
    ctx.waitUntil(runCleanup(env));
  }
};
