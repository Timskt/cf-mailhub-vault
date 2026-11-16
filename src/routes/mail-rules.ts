import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  mailIds,
  ruleFilter,
  rulePatch,
  validateRule,
} from "../mail-workflows";
import {
  and,
  db,
  digest,
  eq,
  insert,
  now,
  oneOf,
  remove,
  update,
  type Row,
} from "../storage/client";
import type { Env } from "../types";
import { integer, invalid, object, text } from "../validation";
const app = new Hono<{ Bindings: Env }>();
const id = (value: string) =>
  integer(value, "规则 ID", 1, Number.MAX_SAFE_INTEGER);
async function getRule(env: Env, value: string) {
  const rule = await db(env).first("mail_rules", eq("id", id(value)));
  if (!rule) throw new HTTPException(404, { message: "规则不存在" });
  return rule;
}
async function preview(env: Env, rule: Row) {
  const where = ruleFilter(rule);
  const [mails, total] = await Promise.all([
    db(env).select("cf_inbox_mails", {
      where,
      order: [
        ["created_at", "desc"],
        ["id", "desc"],
      ],
      limit: 100,
      columns: [
        "id",
        "sender",
        "recipient",
        "subject",
        "created_at",
        "category",
        "is_read",
        "is_archived",
        "is_pinned",
      ],
    }),
    db(env).count("cf_inbox_mails", where),
  ]);
  return {
    mails,
    total,
    limited: total > mails.length,
    revision: await digest(rule),
    changes: rulePatch(rule),
  };
}
app.get("/", async (c) =>
  c.json({
    success: true,
    data: await db(c.env).select("mail_rules", {
      order: [
        ["priority", "asc"],
        ["id", "asc"],
      ],
    }),
  }),
);
app.post("/preview", async (c) =>
  c.json({
    success: true,
    data: await preview(c.env, validateRule(await c.req.json())),
  }),
);
app.post("/", async (c) => {
  const row = validateRule(await c.req.json());
  if ((await db(c.env).count("mail_rules")) >= 50)
    invalid("最多保留 50 条规则，请编辑或删除已有规则");
  const [result] = await db(c.env).mutate([insert("mail_rules", row)]);
  return c.json({
    success: true,
    data: result.rows[0],
    message: "规则已保存，将用于后续新来信",
  });
});
app.put("/:id", async (c) => {
  const rule = await getRule(c.env, c.req.param("id"));
  const row = validateRule(await c.req.json());
  const [result] = await db(c.env).mutate([
    update("mail_rules", eq("id", rule.id), { ...row, updated_at: now() }),
  ]);
  return c.json({ success: true, data: result.rows[0], message: "规则已更新" });
});
app.delete("/:id", async (c) => {
  await db(c.env).mutate([
    remove("mail_rules", eq("id", id(c.req.param("id")))),
  ]);
  return c.json({
    success: true,
    message: "规则已删除；已处理的邮件保留当前状态",
  });
});
app.post("/:id/preview", async (c) =>
  c.json({
    success: true,
    data: await preview(c.env, await getRule(c.env, c.req.param("id"))),
  }),
);
app.post("/:id/apply", async (c) => {
  const body = object(await c.req.json());
  const ids = mailIds(body.ids),
    revision = text(body.revision, "预览版本", 64);
  const rule = await getRule(c.env, c.req.param("id"));
  if (!rule.enabled) invalid("请先启用这条规则，再处理已有邮件");
  if ((await digest(rule)) !== revision)
    throw new HTTPException(409, { message: "规则已变化，请重新预览后应用" });
  const [, result] = await db(c.env).mutate([
    {
      op: "assertExists",
      table: "mail_rules",
      where: and(...Object.entries(rule).map(([key, value]) => eq(key, value))),
    },
    update(
      "cf_inbox_mails",
      and(oneOf("id", ids), ruleFilter(rule)),
      rulePatch(rule),
    ),
  ]);
  return c.json({
    success: true,
    data: { changed: result.changes },
    message: `已处理 ${result.changes} 封邮件`,
  });
});
export default app;
