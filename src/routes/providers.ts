import { Hono } from "hono";
import {
  mailProviders,
  type ProviderAccount,
} from "../../shared/mail-providers";
import {
  checkProviderAccount,
  createProviderMailbox,
  getProviderAccount,
  providerCode,
  providerDomains,
  providerId,
  providerLogin,
  providerMessage,
  providerMessages,
  providerSummary,
  ProviderError,
} from "../mail-providers";
import {
  and,
  collect,
  db,
  eq,
  insert,
  now,
  remove,
  search,
  update,
} from "../storage/client";
import { mailboxReferenceFilter } from "../registration";
import type { Env } from "../types";
import {
  choice,
  email,
  integer,
  invalid,
  object,
  since,
  text,
} from "../validation";

const app = new Hono<{ Bindings: Env }>();
// An upstream auth failure does not invalidate the administrator's session.
app.use("*", async (c, next) => {
  await next();
  if (c.error instanceof ProviderError) {
    const status = c.error.status === 401 ? 400 : c.error.status;
    return c.json(
      {
        success: false,
        error: c.error.code,
        message: c.error.message,
        ...(c.error.retry_after ? { retry_after: c.error.retry_after } : {}),
      },
      status as 400,
      c.error.retry_after ? { "Retry-After": String(c.error.retry_after) } : {},
    );
  }
});
app.get("/", async (c) => {
  const rows = await collect<
    Pick<ProviderAccount, "provider" | "status" | "auth_status">
  >(db(c.env), "provider_accounts", {
    columns: ["provider", "status", "auth_status"],
  });
  return c.json({
    success: true,
    data: mailProviders.map((provider) => ({
      id: provider.id,
      name: provider.name,
      url: provider.url,
      docs: provider.docs,
      credential_label: provider.credentialLabel,
      description: provider.description,
      integration_hint: provider.integrationHint,
      can_create: provider.canCreate,
      account_count: rows.filter((r) => r.provider === provider.id).length,
      attention_count: rows.filter(
        (r) =>
          r.provider === provider.id &&
          r.status === "active" &&
          ["error", "reauth_required"].includes(r.auth_status),
      ).length,
      capabilities: [
        ...(provider.canCreate ? ["create"] : []),
        "connect",
        "messages",
        "verification",
        ...(provider.id === "mailslurp" || provider.id === "mailinator"
          ? ["api_key"]
          : ["password_login"]),
      ],
    })),
  });
});
app.get("/:provider/domains", async (c) =>
  c.json({
    success: true,
    ...(await providerDomains(
      providerId(c.req.param("provider")),
      integer(c.req.query("page"), "页码", 1, 1000, 1),
    )),
  }),
);
app.get("/accounts", async (c) => {
  const q = text(c.req.query("q"), "搜索", 200).trim();
  const provider = c.req.query("provider")
    ? providerId(c.req.query("provider"))
    : "";
  const status = choice(
    c.req.query("status"),
    "状态",
    ["all", "active", "disabled", "attention"],
    "all",
  );
  const page = integer(c.req.query("page"), "页码", 1, 100000, 1),
    limit = integer(c.req.query("limit"), "每页数量", 1, 100, 30);
  const where = and(
    q ? search(q, "address", "remark") : undefined,
    provider ? eq("provider", provider) : undefined,
    status === "attention"
      ? and(eq("status", "active"), {
          field: "auth_status",
          op: "in",
          value: ["error", "reauth_required"],
        })
      : status === "all"
        ? undefined
        : eq("status", status),
  );
  const [rows, total] = await Promise.all([
    db(c.env).select<ProviderAccount>("provider_accounts", {
      where,
      order: [["id", "desc"]],
      limit,
      offset: (page - 1) * limit,
    }),
    db(c.env).count("provider_accounts", where),
  ]);
  return c.json({
    success: true,
    data: rows.map(providerSummary),
    total,
    page,
    limit,
  });
});
app.post("/accounts", async (c) => {
  const body = object(await c.req.json()),
    provider = providerId(body.provider);
  const mode = choice(body.mode, "接入方式", ["connect", "create"], "connect");
  const providerInfo = mailProviders.find((p) => p.id === provider)!;
  if (mode === "create" && !providerInfo.canCreate)
    invalid(`${providerInfo.name} 不支持通过 MailHub 创建邮箱，请接入已有邮箱`);
  const credentialLabel = providerInfo.credentialLabel;
  const address = email(body.address),
    password = text(body.password, credentialLabel, 1000);
  if (!password || (mode === "create" && password.length < 8))
    invalid("请填写邮箱密码；创建新邮箱时至少 8 个字符");
  const remark = text(body.remark, "用途备注", 1000);
  const where = and(eq("provider", provider), eq("address", address));
  if (await db(c.env).first("provider_accounts", where))
    invalid("此服务商的邮箱已接入，请编辑已有账号");
  if (mode === "connect") {
    let credentials;
    try {
      credentials = await providerLogin(provider, address, password);
    } catch (error) {
      if (error instanceof ProviderError && error.status === 401)
        error.status = 400;
      throw error;
    }
    const results = await db(c.env).mutate([
      {
        op: "assertAbsent",
        table: "provider_accounts",
        where,
        message: "此邮箱已接入，请刷新列表",
      },
      insert("provider_accounts", {
        provider,
        address,
        password,
        remark,
        ...credentials,
        credential_version: crypto.randomUUID(),
      }),
    ]);
    const result = results[1];
    return c.json(
      {
        success: true,
        data: providerSummary(result.rows[0] as unknown as ProviderAccount),
        message: "邮箱身份已验证，接入成功，可查收邮件",
      },
      201,
    );
  }
  // Store credentials before remote creation. A timeout must leave a recoverable account.
  const results = await db(c.env).mutate([
    {
      op: "assertAbsent",
      table: "provider_accounts",
      where,
      message: "此邮箱已接入，请刷新列表",
    },
    insert("provider_accounts", {
      provider,
      address,
      password,
      remark,
      credential_version: crypto.randomUUID(),
    }),
  ]);
  const account = results[1].rows[0] as unknown as ProviderAccount;
  try {
    await createProviderMailbox(provider, address, password);
    const credentials = await providerLogin(provider, address, password);
    const [updated] = await db(c.env).mutate([
      update(
        "provider_accounts",
        and(
          eq("id", account.id),
          eq("credential_version", account.credential_version),
        ),
        { ...credentials, updated_at: now() },
      ),
    ]);
    if (!updated.changes)
      throw new ProviderError(
        "PROVIDER_ACCOUNT_CHANGED",
        "账号已修改，请刷新后测试连接",
        409,
      );
    return c.json(
      {
        success: true,
        data: providerSummary(updated.rows[0] as unknown as ProviderAccount),
        message: "邮箱已创建并保存，可查收邮件",
      },
      201,
    );
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    await db(c.env).mutate([
      update(
        "provider_accounts",
        and(
          eq("id", account.id),
          eq("credential_version", account.credential_version),
        ),
        {
          auth_status: "error",
          last_error: error.message,
          last_error_code: error.code,
        },
      ),
    ]);
    return c.json(
      {
        success: false,
        error: error.code,
        data: { id: account.id, address, provider },
        message: `${error.message}。本地已保留地址和密码，请在账号列表测试连接或编辑修复，不要重复创建。`,
      },
      (error.status === 401 ? 400 : error.status) as 400,
    );
  }
});
app.get("/accounts/:id", async (c) => {
  const account = await getProviderAccount(
    c.env,
    integer(c.req.param("id"), "账号 ID", 1, Number.MAX_SAFE_INTEGER),
  );
  return c.json({
    success: true,
    data: {
      ...providerSummary(account),
      password: account.password,
      credential_version: account.credential_version,
    },
  });
});
app.put("/accounts/:id", async (c) => {
  const account = await getProviderAccount(
    c.env,
    integer(c.req.param("id"), "账号 ID", 1, Number.MAX_SAFE_INTEGER),
  );
  const body = object(await c.req.json());
  if (
    Object.keys(body).some(
      (key) =>
        !["password", "remark", "status", "credential_version"].includes(key),
    )
  )
    invalid("只允许修改密码、用途备注和启用状态");
  if (
    body.credential_version !== undefined &&
    body.credential_version !== account.credential_version
  )
    throw new ProviderError(
      "PROVIDER_ACCOUNT_CHANGED",
      "账号已修改，请重新打开编辑窗口",
      409,
    );
  const password = text(body.password, "邮箱密码", 1000, account.password);
  if (!password) invalid("邮箱密码不能为空");
  const status = choice(
    body.status,
    "状态",
    ["active", "disabled"],
    account.status,
  );
  const changed = password !== account.password;
  const [result] = await db(c.env).mutate([
    update(
      "provider_accounts",
      and(
        eq("id", account.id),
        eq("credential_version", account.credential_version),
      ),
      {
        password,
        status,
        remark: text(body.remark, "备注", 1000, account.remark),
        updated_at: now(),
        credential_version: crypto.randomUUID(),
        ...(changed
          ? {
              token: "",
              token_expires_at: "",
              auth_status: "unchecked",
              last_checked_at: "",
              last_error: "",
              last_error_code: "",
            }
          : {}),
      },
    ),
  ]);
  if (!result.changes)
    throw new ProviderError(
      "PROVIDER_ACCOUNT_CHANGED",
      "账号已修改，请重新打开编辑窗口",
      409,
    );
  return c.json({
    success: true,
    data: providerSummary(result.rows[0] as unknown as ProviderAccount),
    message: "账号已保存，密码用于登录服务商，不会修改服务商的密码",
  });
});
app.delete("/accounts/:id", async (c) => {
  const account = await getProviderAccount(
    c.env,
    integer(c.req.param("id"), "账号 ID", 1, Number.MAX_SAFE_INTEGER),
  );
  await db(c.env).mutate([
    {
      op: "assertAbsent",
      table: "platform_vault",
      where: and(
        mailboxReferenceFilter(account.address),
        eq("email_source", account.provider),
      ),
      message: "此邮箱仍绑定平台账号，请先调整平台绑定",
    },
    remove("provider_accounts", eq("id", account.id)),
  ]);
  return c.json({ success: true, message: "已从本平台移除，服务商邮箱仍保留" });
});
app.post("/accounts/:id/check", async (c) => {
  const account = await getProviderAccount(
    c.env,
    integer(c.req.param("id"), "账号 ID", 1, Number.MAX_SAFE_INTEGER),
  );
  return c.json({
    success: true,
    data: await checkProviderAccount(c.env, account),
    message: "邮箱身份与收件连接检查通过",
  });
});
app.get("/accounts/:id/messages", async (c) => {
  const account = await getProviderAccount(
    c.env,
    integer(c.req.param("id"), "账号 ID", 1, Number.MAX_SAFE_INTEGER),
  );
  return c.json({
    success: true,
    ...(await providerMessages(
      c.env,
      account,
      integer(c.req.query("page"), "页码", 1, 100000, 1),
    )),
  });
});
app.get("/accounts/:id/messages/:messageId", async (c) => {
  const account = await getProviderAccount(
    c.env,
    integer(c.req.param("id"), "账号 ID", 1, Number.MAX_SAFE_INTEGER),
  );
  return c.json({
    success: true,
    data: await providerMessage(c.env, account, c.req.param("messageId")),
  });
});
app.get("/accounts/:id/code", async (c) => {
  const account = await getProviderAccount(
    c.env,
    integer(c.req.param("id"), "账号 ID", 1, Number.MAX_SAFE_INTEGER),
  );
  return c.json({
    success: true,
    data: await providerCode(c.env, account, {
      since: since(c.req.query("since")),
      sender: text(c.req.query("sender"), "发件人", 254),
      keyword: text(c.req.query("q"), "关键词", 200),
    }),
  });
});
export default app;
