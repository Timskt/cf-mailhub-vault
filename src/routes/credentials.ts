import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { getSessionSecret, verifySessionToken } from "../auth";
import { and, rawDb, ne, type Filter } from "../storage/client";
import { credentialFields, rekeyCredentials } from "../storage/secure";
import type { Env } from "../types";
import { choice, integer, object, text } from "../validation";

const app = new Hono<{Bindings: Env}>();
app.use("*", async (c, next) => {
  if (!await verifySessionToken(getCookie(c, "mailhub_session") || "", await getSessionSecret(c.env)))
    return c.json({success: false, error: "ADMIN_SESSION_REQUIRED", message: "请使用管理员会话管理凭据保护"}, 401);
  return next();
});
app.get("/", async c => {
  const current = c.env.CREDENTIAL_ENCRYPTION_KEY || c.env.STORAGE_ENCRYPTION_KEY;
  const tables = await Promise.all(Object.entries(credentialFields).map(async ([table, fields]) => {
    const filters: Filter[] = fields.map(field => and(ne(field, ""), {not: {field, op: "contains", value: "enc:v1:"}}));
    return {table, plaintext_records: await rawDb(c.env).count(table as keyof typeof credentialFields, {or: filters})};
  }));
  return c.json({success: true, data: {enabled: Boolean(current && current.length >= 32),
    previous_key_available: Boolean(c.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS), tables}});
});
app.post("/rekey", async c => {
  const body = object(await c.req.json());
  const table = choice(body.table, "数据表", ["accounts", "platform_vault", "oauth_sessions", "webhooks"] as const);
  const cursor = table === "oauth_sessions" ? text(body.cursor, "游标", 200) : integer(body.cursor, "游标", 0, Number.MAX_SAFE_INTEGER, 0);
  const result = await rekeyCredentials(rawDb(c.env), c.env.CREDENTIAL_ENCRYPTION_KEY || c.env.STORAGE_ENCRYPTION_KEY || "",
    c.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS, table, cursor);
  return c.json({success: true, data: result});
});
export default app;
