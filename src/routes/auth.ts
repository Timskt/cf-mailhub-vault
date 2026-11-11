import { Hono } from 'hono';
import type { Env } from '../types';
import { createSessionToken, setSessionCookie, clearSessionCookie, hashPassword } from '../auth';

const app = new Hono<{ Bindings: Env }>();

app.post('/login', async (c) => {
  const { password } = await c.req.json();
  if (!password) {
    return c.json({ success: false, message: '请输入管理员密码' }, 400);
  }

  const envPwd = c.env.ADMIN_PASSWORD;
  let isValid = false;

  if (envPwd) {
    isValid = password === envPwd;
  } else {
    // 检查数据库中设置的密码
    const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_password'").first<{ value: string }>();
    if (row && row.value) {
      const hashed = await hashPassword(password);
      isValid = hashed === row.value || password === row.value;
    } else {
      // 首次使用，自动初始化此密码
      const hashed = await hashPassword(password);
      await c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_password', ?)").bind(hashed).run();
      isValid = true;
    }
  }

  if (!isValid) {
    return c.json({ success: false, message: '密码错误' }, 401);
  }

  const cookieSecret = c.env.COOKIE_SECRET || envPwd || 'default-mailhub-secret';
  const token = await createSessionToken('admin', cookieSecret);
  setSessionCookie(c, token);

  return c.json({ success: true, message: '登录成功' });
});

app.post('/logout', (c) => {
  clearSessionCookie(c);
  return c.json({ success: true, message: '已退出登录' });
});

app.get('/me', async (c) => {
  return c.json({ success: true, data: { user: 'admin' } });
});

export default app;
