import { Hono } from 'hono';
import type { Env } from '../types';
import { hashPassword } from '../auth';

const app = new Hono<{ Bindings: Env }>();

app.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const map: Record<string, string> = {};
  for (const r of results || []) {
    if (r.key !== 'admin_password') {
      map[r.key] = r.value;
    }
  }

  // 附带环境变量中的配置提示
  map['env_cf_domains'] = c.env.CF_DOMAINS || '';
  map['has_admin_password_env'] = Boolean(c.env.ADMIN_PASSWORD) ? 'true' : 'false';
  map['has_api_key'] = Boolean(c.env.API_KEY) ? 'true' : 'false';

  return c.json({ success: true, data: map });
});

app.post('/password', async (c) => {
  const { new_password } = await c.req.json();
  if (!new_password || new_password.length < 6) {
    return c.json({ success: false, message: '新密码长度至少需要 6 位' }, 400);
  }

  const hashed = await hashPassword(new_password);
  await c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_password', ?)").bind(hashed).run();

  return c.json({ success: true, message: '管理员密码修改成功' });
});

export default app;
