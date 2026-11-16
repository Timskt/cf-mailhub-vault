import { Hono } from "hono";
import { db, search } from "../storage/client";
import type { Env } from "../types";
import { text } from "../validation";
const app = new Hono<{ Bindings: Env }>();
app.get("/", async (c) => {
  const query = text(c.req.query("q"), "搜索", 200).trim();
  if (!query)
    return c.json({
      success: true,
      data: { vault: [], mails: [], outlook: [] },
    });
  const store = db(c.env);
  const [vault, mails, outlook] = await Promise.all([
    store.select("platform_vault", {
      where: search(
        query,
        "platform_name",
        "account_email",
        "username",
        "remark",
      ),
      columns: [
        "id",
        "platform_name",
        "account_email",
        "username",
        "last_code",
      ],
      order: [
        ["is_pinned", "desc"],
        ["id", "desc"],
      ],
      limit: 12,
    }),
    store.select("cf_inbox_mails", {
      where: search(
        query,
        "recipient",
        "sender",
        "subject",
        "verification_code",
      ),
      columns: ["id", "subject", "recipient", "sender"],
      order: [["id", "desc"]],
      limit: 8,
    }),
    store.select("accounts", {
      where: search(query, "email", "remark"),
      columns: ["id", "email", "remark", "auth_status"],
      order: [["id", "desc"]],
      limit: 8,
    }),
  ]);
  return c.json({ success: true, data: { vault, mails, outlook } });
});
export default app;
