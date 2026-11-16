import { Hono } from "hono";
import { platformCatalog, platformKey, platformRow } from "../platforms";
import { db } from "../storage/client";
import type { Env } from "../types";
import { boolean, httpUrl, invalid, object, text } from "../validation";

const app = new Hono<{ Bindings: Env }>();

function name(value: unknown, label = "平台名称") {
  const result = text(value, label, 100).trim();
  if (!result) invalid(`${label}不能为空`);
  return result;
}

function definitionBody(value: unknown, fallback = "") {
  const body = object(value);
  const platformName = name(body.name ?? fallback);
  return {
    name: platformName,
    url: httpUrl(body.url ?? body.platform_url),
    category: text(body.category, "平台分类", 100, "其他").trim() || "其他",
    remark: text(body.remark, "平台备注", 4000),
    is_pinned: boolean(body.is_pinned, "置顶", false),
  };
}

app.get("/", async (c) => {
  const data = await platformCatalog(c.env);
  return c.json({ success: true, data, total: data.length });
});

app.post("/", async (c) => {
  const input = definitionBody(await c.req.json());
  const [saved] = await db(c.env).mutate([
    {
      op: "platform",
      action: "create",
      source: input.name,
      definition: platformRow(input.name, {
        ...input,
        is_pinned: Number(input.is_pinned),
      }),
    },
  ]);
  return c.json({
    success: true,
    data: { ...saved.rows[0], account_count: 0, managed: true },
    message: "平台已创建",
  });
});

app.put("/:name", async (c) => {
  const source = name(c.req.param("name"));
  const input = definitionBody(await c.req.json(), source);
  const [saved] = await db(c.env).mutate([
    {
      op: "platform",
      action: "update",
      source,
      definition: platformRow(input.name, {
        ...input,
        is_pinned: Number(input.is_pinned),
      }),
    },
  ]);
  return c.json({
    success: true,
    data: { ...saved.rows[0], account_count: saved.changes, managed: true },
    message: "平台已更新，关联账号已同步",
  });
});

app.post("/:name/merge", async (c) => {
  const source = name(c.req.param("name"));
  const target = name(object(await c.req.json()).target, "目标平台名称");
  if (platformKey(source) === platformKey(target))
    invalid("源平台和目标平台不能相同");
  await db(c.env).mutate([{ op: "platform", action: "merge", source, target }]);
  return c.json({
    success: true,
    data: (await platformCatalog(c.env)).find(
      (p) => p.name_key === platformKey(target),
    ),
    message: "平台已合并，全部账号和邮箱关联已保留",
  });
});

app.delete("/:name", async (c) => {
  const source = name(c.req.param("name"));
  await db(c.env).mutate([{ op: "platform", action: "delete", source }]);
  return c.json({ success: true, message: "平台已删除" });
});

export default app;
