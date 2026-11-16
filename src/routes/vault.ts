import { Hono } from "hono";
import {
  parseVaultImport,
  validateVaultAccount,
  vaultIdentity,
  vaultSources,
  vaultStatuses,
} from "../vault-import";
import { lookupCode, updateVaultCode } from "../codes";
import { prepareMailbox, normalizeDomain } from "../domains";
import { platformCatalog, platformKey } from "../platforms";
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
  or,
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
const sources = vaultSources;
const statuses = vaultStatuses;
const validated = validateVaultAccount;
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
  const ids = c.req
    .query("ids")
    ?.split(",")
    .filter(Boolean)
    .map((v) => integer(v, "账号 ID", 1, Number.MAX_SAFE_INTEGER));
  if (ids && (!ids.length || ids.length > 100)) invalid("请选中 1–100 个账号");
  let where = and(vaultWhere(c.req.query()), ids && oneOf("id", ids));
  if (c.req.query("triage")) {
    const triage = choice(c.req.query("triage"), "处理状态", triageStates);
    const inventory = await vaultInventory(c.env, where);
    where = and(
      where,
      oneOf(
        "id",
        inventory.filter((r) => matchesTriage(r, triage)).map((r) => r.id),
      ),
    );
  }
  const results = await db(c.env).select("platform_vault", {
    where,
    order: [["id", "asc"]],
    limit: 10001,
  });
  if (results.length > 10000) invalid("账号超过一万条，请缩小筛选范围");
  if (ids && results.length !== new Set(ids).size)
    return c.json(
      {
        success: false,
        message: "部分所选账号已不存在或不符合筛选，请刷新后重试",
      },
      409,
    );
  return c.json(
    { version: 1, exported_at: new Date().toISOString(), accounts: results },
    200,
    { "Content-Disposition": 'attachment; filename="platform-vault.json"' },
  );
});
app.post("/import-preview", async (c) => {
  const body = object(await c.req.json());
  const { accounts, ...preview } = parseVaultImport(
    body.raw_text,
    text(body.platform_name, "默认平台", 100),
  );
  return c.json({ success: true, ...preview });
});
app.post("/import", async (c) => {
  const body = object(await c.req.json());
  if (body.accounts !== undefined && body.raw_text !== undefined)
    invalid("accounts 与 raw_text 请只提供一种");
  let entries: ReturnType<typeof validated>[];
  let duplicateCount = 0;
  if (body.raw_text !== undefined) {
    const parsed = parseVaultImport(
      body.raw_text,
      text(body.platform_name, "默认平台", 100),
    );
    if (parsed.error_count)
      invalid(
        `有 ${parsed.error_count} 行格式错误，请先修正后重新预览；本次未写入任何账号`,
      );
    entries = parsed.accounts;
    duplicateCount = parsed.duplicate_count;
  } else {
    if (
      !Array.isArray(body.accounts) ||
      !body.accounts.length ||
      body.accounts.length > 200
    )
      invalid("每批请提供 1–200 条平台账号记录");
    const all = body.accounts.map(validated);
    entries = [
      ...new Map(
        all.map((account) => [vaultIdentity(account), account]),
      ).values(),
    ];
    duplicateCount = all.length - entries.length;
  }
  if (!entries.length) invalid("没有可导入的账号");
  const mode = choice(
    body.duplicate_mode,
    "已有账号",
    ["skip", "update"] as const,
    "skip",
  );
  const existing = await collect(db(c.env), "platform_vault", {
    columns: [
      "id",
      "platform_name",
      "account_email",
      "username",
      "email_source",
      "updated_at",
    ],
    order: [["id", "asc"]],
  });
  const identity = (a: Row) =>
    vaultIdentity({
      platform_name: String(a.platform_name),
      account_email: String(a.account_email),
      username: String(a.username),
    });
  const mutations: import("../storage/client").Mutation[] = [];
  const additions: Row[] = [];
  const addresses = new Set<string>();
  let created = 0,
    updated = 0,
    skipped = 0;
  for (const account of entries) {
    const prior = existing.find((a) => identity(a) === vaultIdentity(account));
    if (prior && mode === "skip") {
      skipped++;
      continue;
    }
    if (prior) {
      mutations.push(
        {
          op: "assertExists",
          table: "platform_vault",
          where: and(
            ...Object.entries(prior).map(([key, value]) => eq(key, value)),
          ),
          message: "已有账号发生变化，请重新预览",
        },
        update("platform_vault", eq("id", prior.id), {
          ...account,
          updated_at: now(),
        }),
      );
      if (prior.email_source === "cf_domain")
        addresses.add(String(prior.account_email));
      updated++;
    } else {
      additions.push(account);
      created++;
    }
    if (account.email_source === "cf_domain")
      addresses.add(account.account_email);
  }
  if (additions.length) {
    // Check case-insensitive identities inside the serialized transaction. A
    // concurrent import must never silently duplicate accounts or miscount rows.
    // Keep each query below D1's 100 bound-parameter limit.
    for (let offset = 0; offset < additions.length; offset += 25)
      mutations.unshift({
        op: "assertAbsent",
        table: "platform_vault",
        where: or(
          ...additions
            .slice(offset, offset + 25)
            .map((a) =>
              and(
                { field: "platform_name", op: "ieq", value: a.platform_name },
                eq("account_email", a.account_email),
                eq("username", a.username),
              ),
            ),
        ),
        message: "导入期间已有账号发生变化，请重新预览后重试",
      });
    mutations.push({ op: "insert", table: "platform_vault", rows: additions });
  }
  for (const address of addresses) {
    const [prefix, domain] = address.split("@");
    mutations.push(
      insert(
        "temp_mailboxes",
        { address, prefix, domain },
        { conflict: "ignore" },
      ),
      { op: "bindMailbox", address },
    );
  }
  if (mutations.length) await db(c.env).mutate(mutations);
  return c.json({
    success: true,
    created,
    updated,
    skipped,
    duplicate_count: duplicateCount,
    message: `新增 ${created} 条，更新 ${updated} 条，跳过 ${skipped} 条`,
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
  const summaries = summarizePlatforms(inventory);
  const catalog = await platformCatalog(c.env);
  const params = c.req.query();
  const accountFiltered =
    ["mailbox", "email_source", "status", "domain", "triage"].some(
      (key) => params[key],
    ) || params.has_code === "true";
  for (const platform of catalog) {
    if (
      summaries.some((p) => platformKey(p.platform_name) === platform.name_key)
    )
      continue;
    if (accountFiltered || platform.account_count > 0) continue;
    if (params.platform && platformKey(params.platform) !== platform.name_key)
      continue;
    if (
      params.category &&
      platformKey(params.category) !== platformKey(platform.category)
    )
      continue;
    if (
      params.q &&
      ![platform.name, platform.remark, platform.category].some((v) =>
        v.toLowerCase().includes(params.q.toLowerCase()),
      )
    )
      continue;
    summaries.push({
      platform_name: platform.name,
      count: 0,
      attention_count: 0,
      unchecked_count: 0,
      connected_count: 0,
      pinned_count: 0,
      sources: [],
      categories: [platform.category],
    });
  }
  const groups = summaries
    .map((summary) => {
      const definition = catalog.find(
        (p) => p.name_key === platformKey(summary.platform_name),
      );
      return {
        ...summary,
        platform_name: definition?.name || summary.platform_name,
        definition,
      };
    })
    .sort(
      (a, b) =>
        (sort === "count"
          ? b.count - a.count
          : sort === "attention"
            ? b.attention_count - a.attention_count
            : sort === "pinned"
              ? (b.definition?.is_pinned || 0) -
                  (a.definition?.is_pinned || 0) ||
                b.pinned_count - a.pinned_count
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
  const [total_cf_mails, total_outlook_accounts, rows, catalog] =
    await Promise.all([
      store.count("cf_inbox_mails"),
      store.count("accounts"),
      vaultInventory(c.env),
      platformCatalog(c.env),
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
      total_platforms: catalog.length,
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
