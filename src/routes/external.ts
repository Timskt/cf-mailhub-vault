import { Hono } from "hono";
import { securityMiddleware } from "../auth";
import { lookupCode } from "../codes";
import { prepareMailbox } from "../domains";
import { outlookFailure } from "../outlook";
import { db, insert } from "../storage/client";
import type { Env } from "../types";
import { email, invalid, object, since, text } from "../validation";
const app = new Hono<{ Bindings: Env }>();
app.use("*", securityMiddleware());
app.get("/code", async (c) => {
  let address = c.req.query("email") ? email(c.req.query("email")) : "";
  let source = "";
  const platform = text(c.req.query("platform"), "平台名称", 100).trim();
  if (!address && platform) {
    const matches = {
      results: await db(c.env).select<{
        account_email: string;
        email_source: string;
      }>("platform_vault", {
        where: { field: "platform_name", op: "ieq", value: platform },
        order: [["id", "desc"]],
        limit: 2,
      }),
    };
    if (matches.results.length > 1)
      invalid("该平台绑定了多个账号，请提供 email 精确指定");
    address = matches.results[0]?.account_email || "";
    source = matches.results[0]?.email_source || "";
  }
  if (!address) invalid("请提供 email 或唯一的 platform");
  if (!source)
    source = (await db(c.env).first("accounts", {
      field: "email",
      op: "ieq",
      value: address,
    }))
      ? "outlook"
      : "cf_domain";
  const result = await lookupCode(c.env, address, source, {
    since: since(c.req.query("since")),
    sender: text(c.req.query("sender"), "发件人", 254),
    keyword: text(c.req.query("q"), "关键词", 200),
  });
  return result.error
    ? c.json(outlookFailure(result.error), 400)
    : c.json({ success: true, ...result.data });
});
app.post("/register", async (c) => {
  const body = object(await c.req.json());
  const platform = text(body.platform_name, "平台名称", 100).trim();
  if (!platform) invalid("platform_name 必填");
  // Validate every field before allocating an address; commit both records together.
  const fields = {
    platform_name: platform,
    email_source: "cf_domain",
    username: text(body.username, "用户名", 254),
    password: text(body.password, "密码"),
    category: text(body.category, "分类", 100, "其他"),
    remark: text(body.remark, "备注", 4000),
  };
  const mailbox = await prepareMailbox(c.env, {
    domain: body.domain,
    prefix: body.prefix,
    is_permanent: true,
  });
  const [result] = await db(c.env).mutate([
    insert("platform_vault", { ...fields, account_email: mailbox.address }),
    insert("temp_mailboxes", mailbox),
    { op: "bindMailbox", address: mailbox.address },
  ]);
  return c.json({
    success: true,
    data: {
      id: result.lastId,
      email: mailbox.address,
      platform_name: platform,
    },
  });
});
export default app;
