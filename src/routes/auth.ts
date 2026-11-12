import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env } from '../types';
import { createSessionToken, verifySessionToken, setSessionCookie, clearSessionCookie, hashPassword } from '../auth';

const app = new Hono<{ Bindings: Env }>();

app.post('/login', async (c) => {
  const { password } = await c.req.json().catch(() => ({}));
  if (!password) {
    return c.json({ success: false, message: '请输入管理员密码' }, 400);
  }

  let isValid = false;

  // 1. 优先比对数据库中自定义设置的密码
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_password'").first<{ value: string }>();
  if (row && row.value) {
    const hashed = await hashPassword(password);
    isValid = (hashed === row.value || password === row.value);
  } else {
    // 2. 数据库未自定义，比对环境变量 ADMIN_PASSWORD (默认兜底: Admin8888Password)
    const envPwd = c.env.ADMIN_PASSWORD || 'Admin8888Password';
    isValid = (password === envPwd);
  }

  if (!isValid) {
    return c.json({ success: false, message: '密码错误，请重新输入（默认密码: Admin8888Password）' }, 401);
  }

  const cookieSecret = c.env.COOKIE_SECRET || c.env.ADMIN_PASSWORD || 'default-mailhub-secret';
  const token = await createSessionToken('admin', cookieSecret);
  setSessionCookie(c, token);

  return c.json({ success: true, message: '登录成功' });
});

app.post('/logout', (c) => {
  clearSessionCookie(c);
  return c.json({ success: true, message: '已退出登录' });
});

app.get('/me', async (c) => {
  const token = getCookie(c, 'mailhub_session');
  const cookieSecret = c.env.COOKIE_SECRET || c.env.ADMIN_PASSWORD || 'default-mailhub-secret';
  if (token && await verifySessionToken(token, cookieSecret)) {
    return c.json({ success: true, authenticated: true, user: 'admin' });
  }
  return c.json({ success: true, authenticated: false });
});

export default app;
