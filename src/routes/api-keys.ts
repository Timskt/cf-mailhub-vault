import { Hono } from "hono";
import { apiKeyMetadata, createApiKey, type ApiKeyRecord } from "../api-keys";
import { adminSessionMiddleware, securityMiddleware } from "../auth";
import { auditIdentity, recordAudit } from "../audit";
import { db, eq, now, update } from "../storage/client";
import type { Env } from "../types";
import { integer, invalid } from "../validation";

/** Mount at /api/api-keys. Local security also protects mounts before global auth. */
const app = new Hono<{ Bindings: Env }>();
app.use("*", securityMiddleware());
app.use("*", adminSessionMiddleware());
app.get("/", async (c) => {
  const page = integer(c.req.query("page"), "页码", 1, 100000, 1);
  const limit = integer(c.req.query("limit"), "每页数量", 1, 100, 30);
  const [rows, total] = await Promise.all([
    db(c.env).select<ApiKeyRecord>("api_keys", {
      order: [
        ["created_at", "desc"],
        ["id", "asc"],
      ],
      limit,
      offset: (page - 1) * limit,
    }),
    db(c.env).count("api_keys"),
  ]);
  return c.json({
    success: true,
    data: rows.map(apiKeyMetadata),
    page,
    limit,
    total,
  });
});
app.post("/", async (c) => {
  const data = await createApiKey(c.env, await c.req.json());
  await recordAudit(c.env, {
    ...auditIdentity(c.get("auth")!),
    request_id: c.res.headers.get("X-Request-ID") || "",
    action: "api_key.create",
    resource: "api_keys",
    status: 201,
    metadata: { scopes: data.scopes },
  });
  return c.json({ success: true, data }, 201);
});
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[a-f\d-]{36}$/.test(id)) invalid("API Key ID 无效");
  const row = await db(c.env).first("api_keys", eq("id", id));
  if (!row)
    return c.json(
      { success: false, error: "NOT_FOUND", message: "API Key 不存在" },
      404,
    );
  await db(c.env).mutate([
    update("api_keys", eq("id", id), {
      revoked_at: row.revoked_at || now(),
      updated_at: now(),
    }),
  ]);
  return c.json({ success: true });
});
export default app;
