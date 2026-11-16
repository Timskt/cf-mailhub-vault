import { Hono } from "hono";
import {
  createSessionToken,
  getSessionSecret,
  hashPassword,
  setSessionCookie,
} from "../auth";
import { getDomains } from "../domains";
import { db, insert, now, oneOf } from "../storage/client";
import type { Env } from "../types";
import { integer, object, text } from "../validation";
const app = new Hono<{ Bindings: Env }>();
app.get("/", async (c) => {
  const results = await db(c.env).select<{ key: string; value: string }>(
    "settings",
    {
      where: oneOf("key", [
        "default_prefix",
        "mail_retention_days",
        "token_refresh_batch",
        "token_refresh_last_run",
      ]),
    },
  );
  const domains = await getDomains(c.env);
  return c.json({
    success: true,
    data: {
      default_prefix: c.env.DEFAULT_PREFIX || "tmp",
      mail_retention_days: "15",
      token_refresh_batch: "5",
      ...Object.fromEntries(results.map((r) => [r.key, r.value])),
      domains,
      env_cf_domains: domains
        .filter((d) => d.enabled)
        .map((d) => d.domain)
        .join(", "),
      has_api_key: Boolean(c.env.API_KEY),
      oauth_configured: Boolean(
        c.env.MICROSOFT_CLIENT_ID && c.env.MICROSOFT_CLIENT_SECRET,
      ),
      oauth_redirect_uri: `${new URL(c.req.url).origin}/api/outlook/oauth/callback`,
    },
  });
});
app.get("/api-key", (c) =>
  c.json({ success: true, data: { api_key: c.env.API_KEY || "" } }),
);
app.put("/", async (c) => {
  const body = object(await c.req.json());
  const prefix = text(body.default_prefix, "前缀", 30).trim();
  const retention = integer(
    body.mail_retention_days,
    "邮件保留天数",
    1,
    365,
    15,
  );
  const batch = integer(
    body.token_refresh_batch,
    "每轮 Token 刷新数量",
    1,
    8,
    5,
  );
  await db(c.env).mutate(
    Object.entries({
      default_prefix: prefix,
      mail_retention_days: String(retention),
      token_refresh_batch: String(batch),
    }).map(([key, value]) =>
      insert(
        "settings",
        { key, value, updated_at: now() },
        { conflict: "update" },
      ),
    ),
  );
  return c.json({ success: true, message: "偏好设置已保存" });
});
app.post("/password", async (c) => {
  const password = text(
    object(await c.req.json()).new_password,
    "新密码",
    1000,
  );
  if (password.length < 10)
    return c.json({ success: false, message: "新密码至少需要 10 位" }, 400);
  await db(c.env).mutate([
    insert(
      "settings",
      { key: "admin_password", value: await hashPassword(password) },
      { conflict: "update" },
    ),
    insert(
      "settings",
      { key: "session_epoch", value: crypto.randomUUID() },
      { conflict: "update" },
    ),
  ]);
  setSessionCookie(
    c,
    await createSessionToken("admin", await getSessionSecret(c.env)),
  );
  return c.json({ success: true, message: "密码已修改，其他登录会话已失效" });
});
export default app;
