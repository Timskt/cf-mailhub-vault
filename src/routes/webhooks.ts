import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { getSessionSecret, verifySessionToken } from "../auth";
import {
  and,
  db,
  eq,
  insert,
  now,
  oneOf,
  remove,
  update,
} from "../storage/client";
import type { Env } from "../types";
import { boolean, choice, integer, invalid, object, text } from "../validation";
import { WEBHOOK_EVENTS, webhookUrl } from "../webhooks";
const app = new Hono<{ Bindings: Env }>();
app.use("*", async (c, next) => {
  if (
    !(await verifySessionToken(
      getCookie(c, "mailhub_session") || "",
      await getSessionSecret(c.env),
    ))
  )
    return c.json(
      {
        success: false,
        error: "ADMIN_SESSION_REQUIRED",
        message: "请使用管理员会话管理事件通知",
      },
      401,
    );
  return next();
});
app.get("/", async (c) => {
  const rows = await db(c.env).select("webhooks", {
    order: [["id", "desc"]],
    limit: 50,
  });
  return c.json({
    success: true,
    data: rows.map(({ secret, url, events, ...row }) => ({
      ...row,
      destination: new URL(String(url)).origin,
      events: JSON.parse(String(events)),
    })),
    encryption_ready: Boolean(
      (c.env.CREDENTIAL_ENCRYPTION_KEY || c.env.STORAGE_ENCRYPTION_KEY || "")
        .length >= 32,
    ),
  });
});
app.post("/", async (c) => {
  if (
    (c.env.CREDENTIAL_ENCRYPTION_KEY || c.env.STORAGE_ENCRYPTION_KEY || "")
      .length < 32
  )
    invalid("请先配置凭据加密密钥，再保存通知地址与签名密钥");
  if ((await db(c.env).count("webhooks")) >= 50)
    invalid("最多保存 50 个事件订阅");
  const body = object(await c.req.json());
  const name = text(body.name, "名称", 100).trim();
  if (!name) invalid("请填写名称");
  const url = webhookUrl(text(body.url, "通知地址", 2000));
  if (!Array.isArray(body.events) || !body.events.length)
    invalid("请至少选择一个事件");
  const events = [
    ...new Set(
      body.events.map((event) => choice(event, "事件", WEBHOOK_EVENTS)),
    ),
  ];
  const secret =
    crypto.randomUUID().replaceAll("-", "") +
    crypto.randomUUID().replaceAll("-", "");
  const [saved] = await db(c.env).mutate([
    insert("webhooks", {
      name,
      url,
      secret,
      events: JSON.stringify(events),
      include_code: boolean(body.include_code, "通知包含验证码") ? 1 : 0,
    }),
  ]);
  return c.json(
    {
      success: true,
      data: { id: saved.lastId, secret },
      message: "签名密钥仅显示一次，请保存到接收服务",
    },
    201,
  );
});
app.patch("/:id", async (c) => {
  const id = integer(c.req.param("id"), "订阅 ID", 1, Number.MAX_SAFE_INTEGER);
  const body = object(await c.req.json());
  const [saved] = await db(c.env).mutate([
    update("webhooks", eq("id", id), {
      enabled: boolean(body.enabled, "启用") ? 1 : 0,
      updated_at: now(),
    }),
  ]);
  return saved.changes
    ? c.json({ success: true })
    : c.json({ success: false, message: "订阅不存在" }, 404);
});
app.delete("/:id", async (c) => {
  const id = integer(c.req.param("id"), "订阅 ID", 1, Number.MAX_SAFE_INTEGER);
  // The dispatcher cancels pending deliveries in bounded batches once the hook
  // disappears. Deleting a subscription must not require rewriting its history.
  await db(c.env).mutate([remove("webhooks", eq("id", id))]);
  return c.json({ success: true });
});
app.get("/deliveries", async (c) => {
  const page = integer(c.req.query("page"), "页码", 1, 100000, 1);
  const status = c.req.query("status")
    ? choice(c.req.query("status"), "状态", [
        "pending",
        "delivering",
        "delivered",
        "dead",
        "cancelled",
      ])
    : "";
  const id = c.req.query("webhook_id")
    ? integer(c.req.query("webhook_id"), "订阅 ID", 1, Number.MAX_SAFE_INTEGER)
    : 0;
  const where = and(
    status ? eq("status", status) : undefined,
    id ? eq("webhook_id", id) : undefined,
  );
  const [rows, total] = await Promise.all([
    db(c.env).select("webhook_deliveries", {
      where,
      order: [
        ["created_at", "desc"],
        ["id", "asc"],
      ],
      limit: 30,
      offset: (page - 1) * 30,
    }),
    db(c.env).count("webhook_deliveries", where),
  ]);
  return c.json({
    success: true,
    data: rows.map(({ payload, lease_token, ...row }) => row),
    total,
    page,
    limit: 30,
  });
});
app.post("/deliveries/:id/retry", async (c) => {
  const id = text(c.req.param("id"), "投递 ID", 100);
  const row = await db(c.env).first("webhook_deliveries", eq("id", id));
  if (!row) return c.json({ success: false, message: "投递记录不存在" }, 404);
  if (
    !(await db(c.env).first(
      "webhooks",
      and(eq("id", row.webhook_id), eq("enabled", 1)),
    ))
  )
    invalid("请先启用对应的事件订阅");
  const [saved] = await db(c.env).mutate([
    update(
      "webhook_deliveries",
      and(eq("id", id), oneOf("status", ["dead", "cancelled"])),
      {
        status: "pending",
        attempts: 0,
        lease_token: "",
        lease_until: 0,
        next_attempt: Date.now(),
        error: "",
        updated_at: now(),
      },
    ),
  ]);
  return saved.changes
    ? c.json({ success: true, message: "已加入重试队列" })
    : c.json(
        { success: false, message: "投递正在进行或已成功，无需重复发送" },
        409,
      );
});
export default app;
