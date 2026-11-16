import { Hono } from "hono";
import { and, db, eq, insert, ne, remove, update } from "../storage/client";
import type { Env } from "../types";
import { integer, invalid, object, text } from "../validation";
const app = new Hono<{ Bindings: Env }>();
for (const table of ["groups", "tags"] as const) {
  app.get(`/${table}`, async (c) => {
    const rows = await db(c.env).select(table, { order: [["id", "asc"]] });
    const accounts = await db(c.env).select(
      table === "groups" ? "accounts" : "account_tags",
      { columns: [table === "groups" ? "group_id" : "tag_id"] },
    );
    const counts = new Map<number, number>();
    for (const a of accounts) {
      const id = Number(a.group_id ?? a.tag_id);
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    return c.json({
      success: true,
      data: rows.map((row) => ({
        ...row,
        account_count: counts.get(Number(row.id)) || 0,
      })),
    });
  });
  app.post(`/${table}`, async (c) => {
    const body = object(await c.req.json()),
      name = text(body.name, "名称", 40).trim(),
      color = text(body.color, "颜色", 7, "#0071e3");
    if (!name || !/^#[0-9a-f]{6}$/i.test(color))
      invalid("请提供名称和有效颜色");
    if (await db(c.env).first(table, eq("name", name))) invalid("名称已存在");
    const [result] = await db(c.env).mutate([insert(table, { name, color })]);
    return c.json({ success: true, data: result.rows[0], message: "已创建" });
  });
  app.put(`/${table}/:id`, async (c) => {
    const id = integer(c.req.param("id"), "ID", 1, 1000000),
      body = object(await c.req.json());
    const name = text(body.name, "名称", 40).trim(),
      color = text(body.color, "颜色", 7, "#0071e3");
    if (!name || !/^#[0-9a-f]{6}$/i.test(color))
      invalid("请提供名称和有效颜色");
    if (await db(c.env).first(table, and(eq("name", name), ne("id", id))))
      invalid("名称已存在");
    const [result] = await db(c.env).mutate([
      update(table, eq("id", id), { name, color }),
    ]);
    return result.changes
      ? c.json({ success: true, message: "已更新" })
      : c.json({ success: false, message: "记录不存在" }, 404);
  });
  app.delete(`/${table}/:id`, async (c) => {
    const id = integer(c.req.param("id"), "ID", 1, 1000000);
    if (table === "groups" && id === 1) invalid("默认分组不能删除");
    await db(c.env).mutate(
      table === "groups"
        ? [
            update("accounts", eq("group_id", id), { group_id: 1 }),
            remove("groups", eq("id", id)),
          ]
        : [remove("tags", eq("id", id))],
    );
    return c.json({
      success: true,
      message:
        table === "groups" ? "分组已删除，账号已移至默认分组" : "标签已删除",
    });
  });
}
export default app;
