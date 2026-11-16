import { Hono } from "hono";
import { mailObjectResponse, publicMailObjects } from "../mail-objects";
import { normalizeDomain } from "../domains";
import { cleanMail } from "../mail-cleanup";
import { mailCategories, mailIds, mailPatch } from "../mail-workflows";
import {
  and,
  collect,
  db,
  eq,
  or,
  oneOf,
  remove,
  search,
  update,
} from "../storage/client";
import type { CfInboxMail, Env } from "../types";
import { choice, integer, object, since, text } from "../validation";
const app = new Hono<{ Bindings: Env }>();
app.get("/", async (c) => {
  const recipient = text(c.req.query("recipient"), "收件人", 254)
      .trim()
      .toLowerCase(),
    q = text(c.req.query("q"), "搜索", 200).trim();
  const folder = choice(
    c.req.query("folder"),
    "文件夹",
    ["all", "inbox", "archived"],
    "all",
  );
  const category = choice(
    c.req.query("category"),
    "分类",
    ["", ...mailCategories],
    "",
  );
  const base = and(
    c.req.query("since")
      ? {
          field: "created_at",
          op: "dateGte",
          value: since(c.req.query("since")),
        }
      : undefined,
    recipient ? eq("recipient", recipient) : undefined,
    c.req.query("domain")
      ? {
          field: "recipient",
          op: "ends",
          value: `@${normalizeDomain(c.req.query("domain"))}`,
        }
      : undefined,
    c.req.query("unread") === "true" ? eq("is_read", 0) : undefined,
    category ? eq("category", category) : undefined,
    c.req.query("verification") === "true"
      ? or(
          { field: "verification_code", op: "ne", value: "" },
          { field: "verification_link", op: "ne", value: "" },
        )
      : undefined,
    q
      ? search(q, "subject", "sender", "text_content", "verification_code")
      : undefined,
  );
  const where = and(
    base,
    folder === "all"
      ? undefined
      : eq("is_archived", folder === "archived" ? 1 : 0),
  );
  const page = integer(c.req.query("page"), "页码", 1, 100000, 1),
    limit = integer(c.req.query("limit"), "每页数量", 1, 100, 30);
  const [data, total, inbox, archived] = await Promise.all([
    db(c.env).select("cf_inbox_mails", {
      where,
      columns: [
        "id",
        "recipient",
        "sender",
        "sender_name",
        "subject",
        "verification_code",
        "verification_link",
        "is_read",
        "is_pinned",
        "is_protected",
        "is_archived",
        "category",
        "rule_name",
        "dkim_status",
        "spf_status",
        "created_at",
      ],
      order: [
        ["is_pinned", "desc"],
        ["created_at", "desc"],
        ["id", "desc"],
      ],
      limit,
      offset: (page - 1) * limit,
    }),
    db(c.env).count("cf_inbox_mails", where),
    db(c.env).count("cf_inbox_mails", and(base, eq("is_archived", 0))),
    db(c.env).count("cf_inbox_mails", and(base, eq("is_archived", 1))),
  ]);
  return c.json({
    success: true,
    data,
    page,
    limit,
    total,
    summary: { inbox, archived, all: inbox + archived },
  });
});
app.post("/batch", async (c) => {
  const body = object(await c.req.json());
  const ids = mailIds(body.ids),
    patch = mailPatch(body.patch);
  const [result] = await db(c.env).mutate([
    update("cf_inbox_mails", oneOf("id", ids), patch),
  ]);
  return c.json({
    success: true,
    data: { changed: result.changes },
    message: `已更新 ${result.changes} 封邮件`,
  });
});
app.get("/recipients", async (c) => {
  const q = text(c.req.query("q"), "搜索", 200).trim(),
    domain = c.req.query("domain")
      ? normalizeDomain(c.req.query("domain"))
      : "";
  const rows = await collect(db(c.env), "cf_inbox_mails", {
    where: and(
      search(q, "recipient"),
      domain
        ? { field: "recipient", op: "ends", value: `@${domain}` }
        : undefined,
    ),
    columns: ["recipient", "is_read", "is_protected", "created_at"],
  });
  const groups = new Map<
    string,
    {
      recipient: string;
      mail_count: number;
      unread_count: number;
      is_protected: number;
      last_received_at: string;
    }
  >();
  for (const row of rows) {
    const key = String(row.recipient),
      group = groups.get(key) || {
        recipient: key,
        mail_count: 0,
        unread_count: 0,
        is_protected: 0,
        last_received_at: "",
      };
    group.mail_count++;
    if (!row.is_read) group.unread_count++;
    group.is_protected = Math.max(group.is_protected, Number(row.is_protected));
    if (String(row.created_at) > group.last_received_at)
      group.last_received_at = String(row.created_at);
    groups.set(key, group);
  }
  return c.json({
    success: true,
    data: [...groups.values()]
      .sort(
        (a, b) =>
          b.unread_count - a.unread_count ||
          b.last_received_at.localeCompare(a.last_received_at),
      )
      .slice(0, 300),
  });
});
app.post("/clean", async (c) =>
  c.json({
    success: true,
    message: `已清理 ${await cleanMail(c.env)} 封未受保护的临时邮件`,
  }),
);
app.get("/:id", async (c) => {
  const markRead =
    choice(c.req.query("mark_read"), "mark_read", ["true", "false"], "true") ===
    "true";
  const id = integer(c.req.param("id"), "邮件 ID", 1, Number.MAX_SAFE_INTEGER),
    mail = await db(c.env).first<CfInboxMail>("cf_inbox_mails", eq("id", id));
  if (!mail) return c.json({ success: false, message: "邮件不存在" }, 404);
  if (markRead)
    await db(c.env).mutate([
      update("cf_inbox_mails", eq("id", id), { is_read: 1 }),
    ]);
  return c.json({
    success: true,
    data: { ...mail, ...publicMailObjects(mail as unknown as import("../storage/model").Row), raw_object_key: undefined, attachment_manifest: undefined, is_read: markRead ? 1 : mail.is_read },
  });
});
app.get("/:id/raw", async c => {
  const mail = await db(c.env).first("cf_inbox_mails", eq("id", integer(c.req.param("id"), "邮件 ID", 1, Number.MAX_SAFE_INTEGER)));
  if (!mail) return c.json({success: false, message: "邮件不存在"}, 404);
  return mailObjectResponse(c.env, mail);
});
app.get("/:id/attachments/:attachment", async c => {
  const mail = await db(c.env).first("cf_inbox_mails", eq("id", integer(c.req.param("id"), "邮件 ID", 1, Number.MAX_SAFE_INTEGER)));
  if (!mail) return c.json({success: false, message: "邮件不存在"}, 404);
  return mailObjectResponse(c.env, mail, c.req.param("attachment"));
});
app.patch("/:id", async (c) => {
  const patch = mailPatch(await c.req.json()),
    id = integer(c.req.param("id"), "邮件 ID", 1, Number.MAX_SAFE_INTEGER);
  const [result] = await db(c.env).mutate([
    update("cf_inbox_mails", eq("id", id), patch),
  ]);
  return result.changes
    ? c.json({ success: true, message: "邮件状态已更新" })
    : c.json({ success: false, message: "邮件不存在" }, 404);
});
app.delete("/:id", async (c) => {
  const [result] = await db(c.env).mutate([
    remove(
      "cf_inbox_mails",
      eq(
        "id",
        integer(c.req.param("id"), "邮件 ID", 1, Number.MAX_SAFE_INTEGER),
      ),
    ),
  ]);
  return result.changes
    ? c.json({ success: true, message: "邮件已删除" })
    : c.json({ success: false, message: "邮件不存在" }, 404);
});
export default app;
