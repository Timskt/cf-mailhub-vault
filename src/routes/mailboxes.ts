import { Hono } from "hono";
import { lookupCode } from "../codes";
import { allocateMailbox, normalizeDomain } from "../domains";
import { createMailboxBatch, previewMailboxes } from "../mailbox-batches";
import {
  and,
  collect,
  db,
  eq,
  now,
  oneOf,
  remove,
  search,
  update,
  type Filter,
} from "../storage/client";
import type { Env, TempMailbox } from "../types";
import { choice, integer, invalid, object, since, text } from "../validation";
const app = new Hono<{ Bindings: Env }>();
app.get("/:id/code", async (c) => {
  const mailbox = await db(c.env).first<TempMailbox>(
    "temp_mailboxes",
    eq("id", integer(c.req.param("id"), "邮箱 ID", 1, Number.MAX_SAFE_INTEGER)),
  );
  if (!mailbox) return c.json({ success: false, message: "邮箱不存在" }, 404);
  const result = await lookupCode(c.env, mailbox.address, "cf_domain", {
    since: since(c.req.query("since")),
    sender: text(c.req.query("sender"), "发件人", 254),
    keyword: text(c.req.query("q"), "关键词", 200),
  });
  return result.error
    ? c.json({ success: false, message: result.error.message }, 400)
    : c.json({ success: true, data: result.data });
});
app.get("/", async (c) => {
  const q = text(c.req.query("q"), "搜索", 200).trim();
  const status = choice(
    c.req.query("status"),
    "状态",
    ["all", "active", "permanent", "expired"],
    "all",
  );
  const domain = c.req.query("domain")
    ? normalizeDomain(c.req.query("domain"))
    : "";
  const limit = integer(c.req.query("limit"), "每页数量", 1, 100, 30);
  const page = integer(c.req.query("page"), "页码", 1, 100000, 1);
  const expire: Filter = and(
    eq("is_permanent", 0),
    { field: "expires_at", op: "ne", value: "" },
    { field: "expires_at", op: "dateLt", value: now() },
  );
  const active = and(eq("is_permanent", 0), { not: expire });
  const where = and(
    q ? search(q, "address", "remark", "associated_platform") : undefined,
    domain ? eq("domain", domain) : undefined,
    status === "expired"
      ? expire
      : status === "permanent"
        ? eq("is_permanent", 1)
        : status === "active"
          ? active
          : undefined,
  );
  const store = db(c.env);
  const [rows, total, all, permanent, expired, activeCount] = await Promise.all(
    [
      store.select<TempMailbox>("temp_mailboxes", {
        where,
        order: [
          ["is_pinned", "desc"],
          ["id", "desc"],
        ],
        limit,
        offset: (page - 1) * limit,
      }),
      store.count("temp_mailboxes", where),
      store.count("temp_mailboxes"),
      store.count("temp_mailboxes", eq("is_permanent", 1)),
      store.count("temp_mailboxes", expire),
      store.count("temp_mailboxes", active),
    ],
  );
  const mails = await collect(store, "cf_inbox_mails", {
    where: oneOf(
      "recipient",
      rows.map((m) => m.address),
    ),
    columns: ["recipient", "is_read", "created_at"],
  });
  const usage = new Map<
    string,
    { mail_count: number; unread_count: number; last_received_at: string }
  >();
  for (const m of mails) {
    const stats = usage.get(String(m.recipient)) || {
      mail_count: 0,
      unread_count: 0,
      last_received_at: "",
    };
    stats.mail_count++;
    if (!m.is_read) stats.unread_count++;
    if (String(m.created_at) > stats.last_received_at)
      stats.last_received_at = String(m.created_at);
    usage.set(String(m.recipient), stats);
  }
  return c.json({
    success: true,
    total,
    page,
    limit,
    summary: { total: all, permanent, expired, active: activeCount },
    data: rows.map((m) => ({
      ...m,
      ...(usage.get(m.address) || {
        mail_count: 0,
        unread_count: 0,
        last_received_at: "",
      }),
      is_expired: Boolean(
        !m.is_permanent &&
        m.expires_at &&
        Date.parse(m.expires_at) <= Date.now(),
      ),
      remaining_seconds: m.is_permanent
        ? 0
        : Math.max(
            0,
            Math.floor((Date.parse(m.expires_at) - Date.now()) / 1000),
          ),
    })),
  });
});
app.post("/generate", async (c) => {
  const body = object(await c.req.json());
  const data = await allocateMailbox(c.env, body);
  return c.json({ success: true, data, message: "邮箱已生成" });
});
app.post("/batch-preview", async (c) =>
  c.json({
    success: true,
    data: await previewMailboxes(c.env, await c.req.json()),
  }),
);
app.post("/batch", async (c) => {
  const data = await createMailboxBatch(c.env, await c.req.json());
  return c.json({
    success: true,
    data,
    message: `已生成 ${data.length} 个邮箱`,
  });
});
app.patch("/:id", async (c) => {
  const body = object(await c.req.json());
  const remark = text(body.remark, "用途备注", 500).trim();
  const [result] = await db(c.env).mutate([
    update(
      "temp_mailboxes",
      eq(
        "id",
        integer(c.req.param("id"), "邮箱 ID", 1, Number.MAX_SAFE_INTEGER),
      ),
      { remark, updated_at: now() },
    ),
  ]);
  return result.changes
    ? c.json({ success: true, message: "用途备注已更新" })
    : c.json({ success: false, message: "邮箱不存在" }, 404);
});
app.get("/:id", async (c) => {
  const row = await db(c.env).first<TempMailbox>(
    "temp_mailboxes",
    eq("id", integer(c.req.param("id"), "邮箱 ID", 1, Number.MAX_SAFE_INTEGER)),
  );
  return row
    ? c.json({ success: true, data: row })
    : c.json({ success: false, message: "邮箱不存在" }, 404);
});
app.post("/:id/extend", async (c) => {
  const id = integer(c.req.param("id"), "邮箱 ID", 1, Number.MAX_SAFE_INTEGER);
  const minutes = integer(
    object(await c.req.json()).minutes,
    "延长分钟",
    1,
    525600,
    60,
  );
  const row = await db(c.env).first<TempMailbox>(
    "temp_mailboxes",
    eq("id", id),
  );
  if (!row) return c.json({ success: false, message: "邮箱不存在" }, 404);
  if (row.is_permanent) invalid("永久邮箱无需延长有效期");
  const expires = new Date(
    Math.max(Date.now(), Date.parse(row.expires_at) || 0) + minutes * 60000,
  ).toISOString();
  await db(c.env).mutate([
    update("temp_mailboxes", eq("id", id), {
      expires_at: expires,
      updated_at: now(),
    }),
  ]);
  return c.json({
    success: true,
    message: `有效期已延长 ${minutes} 分钟`,
    expires_at: expires,
  });
});
app.post("/:id/toggle-permanent", async (c) => {
  const id = integer(c.req.param("id"), "邮箱 ID", 1, Number.MAX_SAFE_INTEGER);
  const row = await db(c.env).first<TempMailbox>(
    "temp_mailboxes",
    eq("id", id),
  );
  if (!row) return c.json({ success: false, message: "邮箱不存在" }, 404);
  const bound = await db(c.env).first(
    "platform_vault",
    and(eq("account_email", row.address), eq("email_source", "cf_domain")),
  );
  if (row.is_permanent && bound)
    invalid("此邮箱绑定了平台账号，需永久保留；请先调整平台绑定");
  const permanent = row.is_permanent ? 0 : 1;
  await db(c.env).mutate([
    update("temp_mailboxes", eq("id", id), {
      is_permanent: permanent,
      expires_at: permanent ? "" : new Date(Date.now() + 3600000).toISOString(),
      updated_at: now(),
    }),
    update("cf_inbox_mails", eq("recipient", row.address), {
      is_protected: permanent || (bound ? 1 : 0),
    }),
  ]);
  return c.json({
    success: true,
    message: permanent ? "已设为永久邮箱" : "已设为一小时有效",
  });
});
app.post("/:id/link-vault", async (c) => {
  const id = integer(c.req.param("id"), "邮箱 ID", 1, Number.MAX_SAFE_INTEGER);
  const vault = integer(
    object(await c.req.json()).vault_id,
    "台账 ID",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const row = await db(c.env).first<{ address: string }>(
    "temp_mailboxes",
    eq("id", id),
  );
  const account = await db(c.env).first<{ platform_name: string }>(
    "platform_vault",
    and(
      eq("id", vault),
      eq("account_email", row?.address || ""),
      eq("email_source", "cf_domain"),
    ),
  );
  if (!row || !account) invalid("邮箱与平台记录不匹配，请先在台账中绑定该邮箱");
  await db(c.env).mutate([
    update("temp_mailboxes", eq("id", id), {
      associated_vault_id: vault,
      associated_platform: account.platform_name,
      is_permanent: 1,
      expires_at: "",
      updated_at: now(),
    }),
    update("cf_inbox_mails", eq("recipient", row.address), { is_protected: 1 }),
  ]);
  return c.json({ success: true, message: "已关联平台并永久保护" });
});
app.delete("/:id", async (c) => {
  const id = integer(c.req.param("id"), "邮箱 ID", 1, Number.MAX_SAFE_INTEGER);
  const row = await db(c.env).first<{ address: string }>(
    "temp_mailboxes",
    eq("id", id),
  );
  if (!row) return c.json({ success: false, message: "邮箱不存在" }, 404);
  if (
    await db(c.env).first(
      "platform_vault",
      and(eq("account_email", row.address), eq("email_source", "cf_domain")),
    )
  )
    invalid("该邮箱仍绑定平台账号，请先调整平台绑定");
  // Keep an expired tombstone: catch-all must not silently revive a destroyed address.
  await db(c.env).mutate([
    update("temp_mailboxes", eq("id", id), {
      is_permanent: 0,
      expires_at: "1970-01-01T00:00:00.000Z",
      updated_at: now(),
    }),
    remove(
      "cf_inbox_mails",
      and(eq("recipient", row.address), eq("is_pinned", 0)),
    ),
  ]);
  return c.json({ success: true, message: "邮箱已停用，后续邮件将被拒收" });
});
export default app;
