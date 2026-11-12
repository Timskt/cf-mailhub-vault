import { Hono } from 'hono';
import type { Env } from './types';
import { authMiddleware } from './auth';
import { handleIncomingEmail } from './email-handler';
import { runTokenRefresh, runCleanup } from './cron';
import { API_DOC_MD, API_DOC_JSON } from './docs';

import authRoutes from './routes/auth';
import vaultRoutes from './routes/vault';
import cfMailRoutes from './routes/cf-mails';
import outlookRoutes from './routes/outlook';
import externalRoutes from './routes/external';
import settingsRoutes from './routes/settings';
import compatRoutes from './routes/compat';
import mailboxRoutes from './routes/mailboxes';

const app = new Hono<{ Bindings: Env }>();

// 全局错误捕获
app.onError((err, c) => {
  console.error('App error:', err);
  const msg = err instanceof Error ? err.message : String(err);
  if (/no such table/i.test(msg)) {
    return c.json({
      success: false,
      error: 'DB_NOT_READY',
      message: '数据库未初始化，请先执行迁移: pnpm exec wrangler d1 execute mailhub-vault-db --file=./migrations/0001_init.sql --remote'
    }, 500);
  }
  return c.json({ success: false, error: 'SERVER_ERROR', message: msg }, 500);
});

// 1. 公开端点 (健康检查与 API 文档，完全参考 tempmail.jdyun.fun /api-doc 设计)
app.get('/healthz', (c) => c.text('ok'));
app.get('/api-doc.md', (c) => c.text(API_DOC_MD, 200, { 'Content-Type': 'text/markdown; charset=utf-8' }));
app.get('/api-doc.json', (c) => c.json(API_DOC_JSON));

// 2. 外部与开放临时邮箱兼容接口 (无鉴权或自带鉴权)
app.route('/api/auth', authRoutes);
app.route('/api/external', externalRoutes);
app.route('/api', compatRoutes); // 支持 /api/domains, /api/mailbox/*, /api/emails/*

// 3. 需管理员鉴权的核心接口 (台账、自建收信管理、Outlook 矩阵、设置)
app.use('/api/vault/*', authMiddleware());
app.use('/api/mailboxes/*', authMiddleware());
app.use('/api/cf-mails/*', authMiddleware());
app.use('/api/outlook/*', authMiddleware());
app.use('/api/settings/*', authMiddleware());

app.route('/api/vault', vaultRoutes);
app.route('/api/mailboxes', mailboxRoutes);
app.route('/api/cf-mails', cfMailRoutes);
app.route('/api/outlook', outlookRoutes);
app.route('/api/settings', settingsRoutes);

// 4. 静态前端资源分发 (SPA 模式)
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
