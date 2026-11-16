import { Hono } from "hono";
import { lookupCode, updateVaultCode } from "../codes";
import { prepareMailbox, normalizeDomain } from "../domains";
import { outlookFailure } from "../outlook";
import {
  enrichVault,
  matchesTriage,
  summarizePlatforms,
  triageStates,
  vaultInventory,
} from "../vault-health";
import {
  and,
  collect,
  db,
  eq,
  insert,
  now,
  oneOf,
  remove,
  search,
  update,
  type Filter,
  type Row,
} from "../storage/client";
import type { Env, PlatformAccount } from "../types";
import {
  boolean,
  choice,
  email,
  httpUrl,
  integer,
  invalid,
  object,
  since,
  text,
} from "../validation";
const app = new Hono<{ Bindings: Env }>();
const sources = ["cf_domain", "outlook", "gptmail", "external"] as const;
const statuses = ["active", "pending", "banned", "deprecated"] as const;
function validated(input: unknown) {
  const body = object(input);
  const name = text(body.platform_name, "平台名称", 100).trim();
  if (!name) invalid("平台名称不能为空");
  return {
    platform_name: name,
    platform_url: httpUrl(body.platform_url),
    account_email: email(body.account_email),
    email_source: choice(body.email_source, "邮箱来源", sources, "cf_domain"),
    username: text(body.username, "用户名", 254),
    password: text(body.password, "密码", 1000),
    totp_secret: text(body.totp_secret, "2FA", 1000),
    status: choice(body.status, "账号状态", statuses, "active"),
    category: text(body.category, "分类", 100, "其他"),
    proxy_node: text(body.proxy_node, "节点", 300),
    remark: text(body.remark, "备注", 4000),
  };
}
export async function protectMailbox(env: Env, address: string) {
  const store = db(env);
  const account = await store.first<{ id: number; platform_name: string }>(
    "platform_vault",
    and(eq("account_email", address), eq("email_source", "cf_domain")),
    { order: [["id", "asc"]] },
  );
  if (account) {
    const [prefix, domain] = address.split("@");
    await store.mutate([
      insert(
        "temp_mailboxes",
        {
          address,
          prefix,
          domain,
          is_permanent: 1,
          expires_at: "",
          associated_platform: account.platform_name,
          associated_vault_id: account.id,
          updated_at: now(),
        },
        { conflict: "update" },
      ),
      update("cf_inbox_mails", eq("recipient", address), { is_protected: 1 }),
    ]);
  } else {
    const mailbox = await store.first(
      "temp_mailboxes",
      and(eq("address", address), eq("is_permanent", 1)),
    );
    await store.mutate([
      update("temp_mailboxes", eq("address", address), {
        associated_platform: "",
        associated_vault_id: null,
      }),
      update("cf_inbox_mails", eq("recipient", address), {
        is_protected: mailbox ? 1 : 0,
      }),
    ]);
  }
}
function vaultWhere(params: Record<string, string>) {
  const filters: Filter[] = [];
  if (params.mailbox)
    filters.push({
      field: "account_email",
      op: "ieq",
      value: email(params.mailbox),
    });
  for (const field of ["category", "status", "platform"] as const) {
    const value = text(params[field], field, 100).trim();
    if (value)
      filters.push({
        field: field === "platform" ? "platform_name" : field,
        op: "ieq",
        value,
      });
  }
  if (params.email_source)
    filters.push(
      eq("email_source", choice(params.email_source, "来源", sources)),
    );
  if (params.domain)
    filters.push({
      field: "account_email",
      op: "ends",
      value: `@${normalizeDomain(params.domain)}`,
    });
  if (params.has_code === "true")
    filters.push({ field: "last_code", op: "ne", value: "" });
  const q = text(params.q, "搜索", 200).trim();
  if (q)
    filters.push(
      search(
        q,
        "platform_name",
        "account_email",
        "username",
        "remark",
        "last_code",
      ),
    );
  return and(...filters);
}
app.get("/", async (c) => {
  const page = integer(c.req.query("page"), "页码", 1, 100000, 1),
    limit = integer(c.req.query("limit"), "每页数量", 1, 100, 30);
  let where = vaultWhere(c.req.query());
  const triage = c.req.query("triage")
    ? choice(c.req.query("triage"), "待处理筛选", triageStates)
    : "";
  if (triage) {
    const inventory = await vaultInventory(c.env, where);
    where = and(
      where,
      oneOf(
        "id",
        inventory.filter((r) => matchesTriage(r, triage)).map((r) => r.id),
      ),
    );
  }
  const [rows, total] = await Promise.all([
    db(c.env).select<PlatformAccount>("platform_vault", {
      where,
      order: [
        ["is_pinned", "desc"],
        ["updated_at", "desc"],
        ["id", "desc"],
      ],
      limit,
      offset: (page - 1) * limit,
    }),
    db(c.env).count("platform_vault", where),
  ]);
  return c.json({
    success: true,
    data: await enrichVault(
      c.env,
      rows.map(({ password, totp_secret, ...r }) => ({
        ...r,
        has_password: password ? 1 : 0,
        has_totp: totp_secret ? 1 : 0,
      })),
    ),
    page,
    limit,
    total,
  });
});
app.get("/export", async (c) => {
  const results = await db(c.env).select("platform_vault", {
    order: [["id", "asc"]],
    limit: 10001,
  });
  if (results.length > 10000) invalid("账号超过一万条，请使用数据库备份");
  return c.json(
    { version: 1, exported_at: new Date().toISOString(), accounts: results },
    200,
    { "Content-Disposition": 'attachment; filename="platform-vault.json"' },
  );
});
app.post("/import", async (c) => {
  const body = object(await c.req.json());
  if (
    !Array.isArray(body.accounts) ||
    !body.accounts.length ||
    body.accounts.length > 200
  )
    invalid("每批请提供 1–200 条平台账号记录");
  const entries = [
    ...new Map(
      body.accounts.map((value) => {
        const account = validated(value);
        return [
          `${account.platform_name.toLowerCase()}\0${account.account_email}\0${account.username}`,
          account,
        ] as const;
      }),
    ).values(),
  ];
  let changes = 0;
  // Explicit logical identity preserves case-insensitive platform-name duplicate behavior.
  const existing = await collect(db(c.env), "platform_vault", {
    columns: ["platform_name", "account_email", "username"],
  });
  const identities = new Set(
    existing.map(
      (a) =>
        `${String(a.platform_name).toLowerCase()}\0${a.account_email}\0${a.username}`,
    ),
  );
  const pending = entries.filter(
    (a) =>
      !identities.has(
        `${a.platform_name.toLowerCase()}\0${a.account_email}\0${a.username}`,
      ),
  );
  if (pending.length) {
    const [saved] = await db(c.env).mutate([
      { op: "insert", table: "platform_vault", rows: pending },
    ]);
    changes = saved.changes;
  }
  const addresses = [
    ...new Set(
      entries
        .filter((a) => a.email_source === "cf_domain")
        .map((a) => a.account_email),
    ),
  ];
  if (addresses.length) {
    const linked = await collect(db(c.env), "platform_vault", {
      where: and(
        oneOf("account_email", addresses),
        eq("email_source", "cf_domain"),
      ),
      columns: ["id", "platform_name", "account_email"],
      order: [["id", "desc"]],
    });
    const first = [
      ...new Map(linked.map((row) => [row.account_email, row])).values(),
    ];
    await db(c.env).mutate([
      {
        op: "insert",
        table: "temp_mailboxes",
        conflict: "update",
        rows: first.map((row) => {
          const address = String(row.account_email),
            [prefix, domain] = address.split("@");
          return {
            address,
            prefix,
            domain,
            is_permanent: 1,
            expires_at: "",
            associated_vault_id: row.id,
            associated_platform: row.platform_name,
            updated_at: now(),
          };
        }),
      },
      update("cf_inbox_mails", oneOf("recipient", addresses), {
        is_protected: 1,
      }),
    ]);
  }
  return c.json({
    success: true,
    message: `已恢复 ${changes} 条记录，已有记录自动跳过`,
  });
});
app.get("/platforms", async (c) => {
  const triage = c.req.query("triage")
    ? choice(c.req.query("triage"), "待处理筛选", triageStates)
    : "";
  const inventory = (
    await vaultInventory(c.env, vaultWhere(c.req.query()))
  ).filter((r) => matchesTriage(r, triage));
  const sort = choice(
    c.req.query("sort"),
    "排序",
    ["name", "count", "attention", "pinned"] as const,
    "name",
  );
  const groups = summarizePlatforms(inventory).sort(
    (a, b) =>
      (sort === "count"
        ? b.count - a.count
        : sort === "attention"
          ? b.attention_count - a.attention_count
          : sort === "pinned"
            ? b.pinned_count - a.pinned_count
            : 0) || a.platform_name.localeCompare(b.platform_name, "zh-CN"),
  );
  // Keep the legacy array response; pagination is opt-in and counts never truncate.
  const paged =
    c.req.query("page") !== undefined || c.req.query("limit") !== undefined;
  const page = integer(c.req.query("page"), "页码", 1, 100000, 1),
    limit = integer(c.req.query("limit"), "每页数量", 1, 100, 24);
  return c.json({
    success: true,
    data: paged ? groups.slice((page - 1) * limit, page * limit) : groups,
    total: groups.length,
    ...(paged ? { page, limit } : {}),
    summary: {
      accounts: inventory.length,
      platforms: groups.length,
      attention: inventory.filter((r) => r.needs_attention).length,
      unchecked: inventory.filter((r) => matchesTriage(r, "unchecked")).length,
    },
  });
});
app.get("/stats", async (c) => {
  const store = db(c.env);
  const [total_cf_mails, total_outlook_accounts, rows] = await Promise.all([
    store.count("cf_inbox_mails"),
    store.count("accounts"),
    vaultInventory(c.env),
  ]);
  const groups = new Map<string, number>();
  for (const row of rows)
    groups.set(
      String(row.category),
      (groups.get(String(row.category)) || 0) + 1,
    );
  return c.json({
    success: true,
    data: {
      total_vault_accounts: rows.length,
      active_vault_accounts: rows.filter((r) => r.status === "active").length,
      total_platforms: summarizePlatforms(rows).length,
      attention_accounts: rows.filter((r) => r.needs_attention).length,
      unchecked_accounts: rows.filter((r) => matchesTriage(r, "unchecked"))
        .length,
      total_cf_mails,
      total_outlook_accounts,
      categories: [...groups].map(([category, count]) => ({ category, count })),
    },
  });
});
app.post("/", async (c) => {
  const body = object(await c.req.json());
  let box: Awaited<ReturnType<typeof prepareMailbox>> | undefined;
  if (boolean(body.generate_email, "自动生成邮箱") || !body.account_email) {
    validated({
      ...body,
      account_email: "pending@example.test",
      email_source: "cf_domain",
    });
    box = await prepareMailbox(c.env, {
      domain: body.domain,
      is_permanent: true,
    });
    body.account_email = box.address;
    body.email_source = "cf_domain";
  }
  const account = validated(body);
  const [result] = await db(c.env).mutate([
    insert("platform_vault", account),
    ...(box
      ? [
          insert("temp_mailboxes", box),
          { op: "bindMailbox" as const, address: box.address },
        ]
      : []),
  ]);
  if (!box && account.email_source === "cf_domain")
    await protectMailbox(c.env, account.account_email);
  return c.json({
    success: true,
    data: { id: result.lastId, account_email: account.account_email },
    message: "平台账号已登记",
  });
});
app.post("/batch", async (c) => {
  const body = object(await c.req.json());
  if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 100)
    invalid("每批支持 1–100 个平台账号 ID");
  const ids = [
    ...new Set(
      body.ids.map((id) => integer(id, "账号 ID", 1, Number.MAX_SAFE_INTEGER)),
    ),
  ];
  const input = object(body.patch),
    patch: Row = {};
  for (const key of Object.keys(input)) {
    if (key === "status")
      patch.status = choice(input.status, "账号状态", statuses);
    else if (key === "category")
      patch.category = text(input.category, "分类", 100).trim();
    else if (key === "remark") patch.remark = text(input.remark, "备注", 4000);
    else if (key === "is_pinned")
      patch.is_pinned = boolean(input.is_pinned, "置顶") ? 1 : 0;
    else invalid("批量整理仅支持 status、category、remark、is_pinned");
  }
  if (!Object.keys(patch).length) invalid("patch 不能为空");
  const results = await db(c.env).mutate([
    {
      op: "assertExists",
      table: "platform_vault",
      where: oneOf("id", ids),
      minimum: ids.length,
      message: "部分账号已不存在，本批未修改；请刷新账号列表",
    },
    update("platform_vault", oneOf("id", ids), { ...patch, updated_at: now() }),
  ]);
  return c.json({
    success: true,
    data: { ids, changed: results.at(-1)!.changes },
  });
});
app.post("/:id/pin", async (c) => {
  await db(c.env).mutate([
    {
      op: "update",
      table: "platform_vault",
      where: eq(
        "id",
        integer(c.req.param("id"), "ID", 1, Number.MAX_SAFE_INTEGER),
      ),
      toggle: ["is_pinned"],
    },
  ]);
  return c.json({ success: true });
});
app.put("/:id", async (c) => {
  const id = integer(c.req.param("id"), "ID", 1, Number.MAX_SAFE_INTEGER);
  const existing = await db(c.env).first<PlatformAccount>(
    "platform_vault",
    eq("id", id),
  );
  if (!existing)
    return c.json({ success: false, message: "台账记录不存在" }, 404);
  const account = validated({ ...existing, ...object(await c.req.json()) });
  await db(c.env).mutate([
    update("platform_vault", eq("id", id), { ...account, updated_at: now() }),
  ]);
  if (existing.email_source === "cf_domain")
    await protectMailbox(c.env, existing.account_email);
  if (account.email_source === "cf_domain")
    await protectMailbox(c.env, account.account_email);
  return c.json({ success: true, message: "台账已更新" });
});
app.get("/:id", async (c) => {
  const account = await db(c.env).first<PlatformAccount>(
    "platform_vault",
    eq("id", integer(c.req.param("id"), "ID", 1, Number.MAX_SAFE_INTEGER)),
  );
  return account
    ? c.json({ success: true, data: account })
    : c.json({ success: false, message: "台账记录不存在" }, 404);
});
app.delete("/:id", async (c) => {
  const id = integer(c.req.param("id"), "ID", 1, Number.MAX_SAFE_INTEGER);
  const [deleted] = await db(c.env).mutate([
    remove("platform_vault", eq("id", id)),
  ]);
  const account = deleted.rows[0] as unknown as PlatformAccount | undefined;
  if (!account)
    return c.json({ success: false, message: "台账记录不存在" }, 404);
  if (account.email_source === "cf_domain")
    await protectMailbox(c.env, account.account_email);
  return c.json({ success: true, message: "台账已删除" });
});
app.get("/:id/code", async (c) => {
  const account = await db(c.env).first<PlatformAccount>(
    "platform_vault",
    eq("id", integer(c.req.param("id"), "ID", 1, Number.MAX_SAFE_INTEGER)),
  );
  if (!account)
    return c.json({ success: false, message: "台账记录不存在" }, 404);
  const result = await lookupCode(
    c.env,
    account.account_email,
    account.email_source,
    {
      since: since(c.req.query("since")),
      sender: text(c.req.query("sender"), "发件人", 254),
      keyword: text(c.req.query("q"), "关键词", 200),
    },
  );
  if (result.error) return c.json(outlookFailure(result.error), 400);
  await updateVaultCode(c.env, account, result.data);
  return c.json({ success: true, data: result.data });
});
export default app;
