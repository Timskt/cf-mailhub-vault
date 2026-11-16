import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  authConfigured,
  clearSessionCookie,
  createSessionToken,
  getSessionSecret,
  hashPassword,
  setSessionCookie,
  sha256,
  verifyPassword,
  verifySessionToken,
} from "../auth";
import { db, eq, remove, update } from "../storage/client";
import type { Env } from "../types";
import { object, text } from "../validation";
const app = new Hono<{ Bindings: Env }>();
app.post("/login", async (c) => {
  const password = text(object(await c.req.json()).password, "密码", 1000);
  if (!password)
    return c.json({ success: false, message: "请输入管理员密码" }, 400);
  if (!(await authConfigured(c.env)))
    return c.json(
      {
        success: false,
        message: "尚未配置管理员密码，请先配置 ADMIN_PASSWORD Secret",
      },
      503,
    );
  const identity = await sha256(c.req.header("CF-Connecting-IP") || "local");
  const now = Math.floor(Date.now() / 1000);
  const [attemptResult] = await db(c.env).mutate([
    { op: "throttle", identity, time: now },
  ]);
  const attempt = attemptResult.rows[0] as {
    attempts: number;
    reset_at: number;
  };
  if (attempt && attempt.attempts > 10)
    return c.json(
      { success: false, message: "尝试次数过多，请稍后再试" },
      429,
      { "Retry-After": String(attempt.reset_at - now) },
    );
  const row = await db(c.env).first<{ value: string }>(
    "settings",
    eq("key", "admin_password"),
  );
  const valid = row?.value
    ? await verifyPassword(password, row.value)
    : (await sha256(password)) === (await sha256(c.env.ADMIN_PASSWORD!));
  if (!valid)
    return c.json({ success: false, message: "密码错误，请重新输入" }, 401);
  if (row && !row.value.startsWith("pbkdf2:"))
    await db(c.env).mutate([
      update("settings", eq("key", "admin_password"), {
        value: await hashPassword(password),
      }),
    ]);
  await db(c.env).mutate([remove("auth_attempts", eq("identity", identity))]);
  setSessionCookie(
    c,
    await createSessionToken("admin", await getSessionSecret(c.env)),
  );
  return c.json({ success: true, message: "登录成功" });
});
app.post("/logout", (c) => {
  clearSessionCookie(c);
  return c.json({ success: true });
});
app.get("/me", async (c) => {
  const configured = await authConfigured(c.env);
  const token = getCookie(c, "mailhub_session");
  const authenticated =
    configured &&
    Boolean(
      token && (await verifySessionToken(token, await getSessionSecret(c.env))),
    );
  return c.json({ success: true, authenticated, configured });
});
export default app;
