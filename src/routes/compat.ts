import { Hono } from "hono";
import { allocateMailbox } from "../domains";
import { and, db, eq, search, update } from "../storage/client";
import type { CfInboxMail, Env } from "../types";
import { email, integer, invalid, object, text } from "../validation";
const app = new Hono<{ Bindings: Env }>();
for (const endpoint of ["generate", "custom"])
  app.post(`/mailbox/${endpoint}`, async (c) => {
    const body = object(await c.req.json());
    const expiration = text(body.expiration, "有效期", 20, "1h");
    const match = expiration.match(/^(\d+)(m|h|d)$/);
    if (!match && expiration !== "permanent")
      invalid("有效期支持 60m、1h、1d 或 permanent");
    const minutes = match
      ? Number(match[1]) * ({ m: 1, h: 60, d: 1440 }[match[2]] || 1)
      : 0;
    if (endpoint === "custom" && !body.prefix) invalid("请提供 prefix");
    const box = await allocateMailbox(c.env, {
      domain: body.domain,
      prefix: endpoint === "custom" ? body.prefix : undefined,
      duration_minutes: minutes,
    });
    return c.json({ ...box, expiration });
  });
app.get("/emails/list", async (c) => {
  const address = email(c.req.query("address") || c.req.query("mailbox"));
  const q = text(c.req.query("q"), "搜索", 200);
  const results = await db(c.env).select<CfInboxMail>("cf_inbox_mails", {
    where: and(
      eq("recipient", address),
      search(q, "subject", "sender", "verification_code"),
    ),
    order: [
      ["created_at", "desc"],
      ["id", "desc"],
    ],
    limit: 50,
  });
  return c.json({
    emails: results.map((m) => ({
      id: m.id,
      from: m.sender,
      to: m.recipient,
      subject: m.subject,
      received_at: m.created_at,
      read: Boolean(m.is_read),
      verify_code: m.verification_code,
    })),
  });
});
app.get("/emails/view/:id", async (c) => {
  const id = integer(c.req.param("id"), "邮件 ID", 1, Number.MAX_SAFE_INTEGER);
  const mail = await db(c.env).first<CfInboxMail>(
    "cf_inbox_mails",
    eq("id", id),
  );
  if (!mail) return c.json({ error: "NOT_FOUND", message: "邮件不存在" }, 404);
  await db(c.env).mutate([
    update("cf_inbox_mails", eq("id", id), { is_read: 1 }),
  ]);
  return c.json({
    id: mail.id,
    from: mail.sender,
    to: mail.recipient,
    subject: mail.subject,
    body: mail.text_content,
    html_body: mail.html_content,
    received_at: mail.created_at,
    verify_code: mail.verification_code,
  });
});
export default app;
