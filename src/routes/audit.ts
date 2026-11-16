import { Hono } from "hono";
import { adminSessionMiddleware, securityMiddleware } from "../auth";
import { auditIdentity, recordAudit, redactAuditMetadata } from "../audit";
import { and, db, eq, oneOf, remove, type Filter } from "../storage/client";
import type { Env } from "../types";
import { choice, integer, invalid, object, since, text } from "../validation";

/** Mount at /api/audit. Purging is bounded, repeat with the same cutoff for large logs. */
const app = new Hono<{ Bindings: Env }>();
app.use("*", securityMiddleware());
app.use("*", adminSessionMiddleware());
app.get("/", async (c) => {
  const filters: Filter[] = [];
  const action = text(c.req.query("action"), "操作", 80);
  if (action) filters.push(eq("action", action));
  if (c.req.query("actor_type"))
    filters.push(
      eq(
        "actor_type",
        choice(c.req.query("actor_type"), "身份类型", [
          "admin_session",
          "api_key",
          "master_key",
          "anonymous",
          "system",
        ]),
      ),
    );
  for (const key of ["before", "after"] as const)
    if (c.req.query(key))
      filters.push({
        field: "created_at",
        op: key === "before" ? "lt" : "gte",
        value: since(c.req.query(key)),
      });
  const where = and(...filters),
    page = integer(c.req.query("page"), "页码", 1, 100000, 1),
    limit = integer(c.req.query("limit"), "每页数量", 1, 100, 30);
  const [rows, total] = await Promise.all([
    db(c.env).select("audit_logs", {
      where,
      limit,
      offset: (page - 1) * limit,
      order: [["id", "desc"]],
    }),
    db(c.env).count("audit_logs", where),
  ]);
  return c.json({
    success: true,
    data: rows.map((row) => ({
      ...row,
      metadata: redactAuditMetadata(JSON.parse(String(row.metadata))),
    })),
    page,
    limit,
    total,
  });
});
app.delete("/", async (c) => {
  const before = since(object(await c.req.json()).before);
  if (!before || Date.parse(before) >= Date.now())
    invalid("请指定早于当前时间的清理截止时间");
  const rows = await db(c.env).select<{ id: number }>("audit_logs", {
    where: { field: "created_at", op: "lt", value: before },
    columns: ["id"],
    limit: 1000,
    order: [["id", "asc"]],
  });
  const [result] = rows.length
    ? await db(c.env).mutate([
        remove(
          "audit_logs",
          oneOf(
            "id",
            rows.map((r) => r.id),
          ),
        ),
      ])
    : [];
  const deleted = result?.changes || 0;
  await recordAudit(c.env, {
    ...auditIdentity(c.get("auth")!),
    request_id: c.res.headers.get("X-Request-ID") || "",
    action: "audit.purge",
    resource: "audit",
    status: 200,
    metadata: { deleted },
  });
  return c.json({
    success: true,
    data: { deleted, has_more: rows.length === 1000 },
  });
});
export default app;
