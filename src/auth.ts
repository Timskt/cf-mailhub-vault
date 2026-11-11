import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from './types';

const COOKIE_NAME = 'mailhub_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

async function getKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret || 'default-mailhub-vault-secret-key-salt'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function createSessionToken(username: string, secret: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${username}:${exp}`;
  const key = await getKey(secret);
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const sigHex = Array.from(new Uint8Array(sigBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `${btoa(payload)}.${sigHex}`;
}

export async function verifySessionToken(token: string, secret: string): Promise<boolean> {
  try {
    const [b64Payload, sigHex] = token.split('.');
    if (!b64Payload || !sigHex) return false;

    const payload = atob(b64Payload);
    const [, expStr] = payload.split(':');
    const exp = parseInt(expStr, 10);
    if (isNaN(exp) || Math.floor(Date.now() / 1000) > exp) {
      return false;
    }

    const key = await getKey(secret);
    const expectedSig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    const expectedHex = Array.from(new Uint8Array(expectedSig))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    return sigHex === expectedHex;
  } catch {
    return false;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', enc.encode(password));
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function authMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    // 1. Check API Key header
    const authHeader = c.req.header('Authorization');
    const apiKeyParam = c.req.query('api_key') || c.req.header('X-API-Key');
    const envApiKey = c.env.API_KEY;

    if (envApiKey && (authHeader === `Bearer ${envApiKey}` || apiKeyParam === envApiKey)) {
      return next();
    }

    // 2. Check Session Cookie
    const token = getCookie(c, COOKIE_NAME);
    const cookieSecret = c.env.COOKIE_SECRET || c.env.ADMIN_PASSWORD || 'default-mailhub-secret';

    if (token) {
      const valid = await verifySessionToken(token, cookieSecret);
      if (valid) {
        return next();
      }
    }

    // 3. If no admin password is set yet, allow initial access for setup
    if (!c.env.ADMIN_PASSWORD) {
      const db = c.env.DB;
      const pwdSetting = await db.prepare("SELECT value FROM settings WHERE key = 'admin_password'").first<{ value: string }>();
      if (!pwdSetting) {
        return next();
      }
    }

    return c.json({ success: false, error: 'UNAUTHORIZED', message: '请先登录管理员账号' }, 401);
  };
}

export function setSessionCookie(c: Context<{ Bindings: Env }>, token: string) {
  setCookie(c, COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: SESSION_TTL_SECONDS
  });
}

export function clearSessionCookie(c: Context<{ Bindings: Env }>) {
  deleteCookie(c, COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax'
  });
}
