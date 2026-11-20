import { resolveTarget, AutomationError, automationError } from "../automation";
import { Hono } from "hono";
import { securityMiddleware } from "../auth";
import { lookupCode } from "../codes";
import { prepareMailbox } from "../domains";
import { outlookFailure } from "../outlook";
import { db, insert } from "../storage/client";
import type { Env } from "../types";
import { choice, email, invalid, object, since, text } from "../validation";
const app = new Hono<{ Bindings: Env }>();
app.use("*", securityMiddleware());
app.get("/code", async (c) => {
  let address = c.req.query("email") ? email(c.req.query("email")) : "";
  let source = c.req.query("source")
    ? choice(c.req.query("source"), "邮箱来源", [
        "cf_domain",
        "outlook",
        "mailtm",
        "mailgw",
        "mailslurp",
        "mailinator",
      ])
    : "";
  if (source && !address) invalid("source 只用于明确的 email 目标");
  const platform = text(c.req.query("platform"), "平台名称", 100).trim();
  if (!address && platform) {
    try {
      const target = await resolveTarget(
        c.env,
        {
          platform,
          source: undefined,
        },
        c.get("auth"),
      );
      address = target.email;
      source = target.source;
    } catch (error) {
      if (!(error instanceof AutomationError)) throw error;
      return c.json(automationError(error), error.status as 400);
    }
  }
  if (!address) invalid("请提供 email 或唯一的 platform");
  if (!source) {
    try {
      source = (
        await resolveTarget(c.env, { email: address, source: undefined })
      ).source;
    } catch (error) {
      if (!(error instanceof AutomationError)) throw error;
      return c.json(automationError(error), error.status as 400);
    }
  }
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
