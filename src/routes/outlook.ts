import { Hono } from "hono";
import { runTokenRefresh } from "../cron";
import { extractVerificationInfo } from "../code-extractor";
import {
  deleteMessage,
  downloadAttachment,
  fetchAttachments,
  fetchEmails,
  fetchMessage,
  FOLDERS,
  validNextLink,
  type GraphError,
} from "../graph";
import {
  checkOutlook,
  outlookCode,
  outlookFailure,
  replyOutlookMail,
  sendOutlookMail,
  withOutlook,
} from "../outlook";
import { importPreview, parseImport, validateAccount } from "../outlook-import";
import {
  accountBatchMutation,
  accountMutation,
  assertGroup,
  getAccount,
} from "../outlook-store";
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
} from "../storage/client";
import type { Env, OutlookAccount } from "../types";
import {
  boolean,
  choice,
  integer,
  invalid,
  object,
  since,
  text,
} from "../validation";
const app = new Hono<{ Bindings: Env }>();
function outboundStatus(
  error: GraphError,
): 400 | 401 | 403 | 404 | 409 | 413 | 429 | 502 {
  switch (error.status) {
    case 400:
    case 401:
    case 403:
    case 404:
    case 409:
    case 413:
    case 429:
      return error.status;
    default:
      return 502;
  }
}
app.get("/renewal", async (c) => {
  const active = eq("status", "active");
  const [last, due, attention, activeCount] = await Promise.all([
    db(c.env).first<{ value: string }>(
      "settings",
      eq("key", "token_refresh_last_run"),
    ),
    db(c.env).count(
      "accounts",
      and(
        active,
        { field: "token_refresh_status", op: "ne", value: "reauth_required" },
        or(eq("next_token_refresh_at", ""), {
          field: "next_token_refresh_at",
          op: "lte",
          value: new Date().toISOString(),
        }),
      ),
    ),
    db(c.env).count(
      "accounts",
      and(active, eq("token_refresh_status", "reauth_required")),
    ),
    db(c.env).count("accounts", active),
  ]);
  return c.json({
    success: true,
    data: {
      last_run: last ? JSON.parse(last.value) : null,
      due,
      attention,
      active: activeCount,
    },
  });
});
app.post("/renewal/run", async (c) => {
  await runTokenRefresh(c.env);
  return c.json({
    success: true,
    message: "已执行一轮到期账号续期，请查看最近执行结果",
  });
});
const authStates = [
  "unchecked",
  "healthy",
  "reauth_required",
  "error",
] as const;
app.get("/accounts", async (c) => {
  const query = text(c.req.query("q"), "搜索", 200).trim();
  const limit = integer(c.req.query("limit"), "每页数量", 1, 100, 30),
    page = integer(c.req.query("page"), "页码", 1, 100000, 1);
  const store = db(c.env),
    filters: Filter[] = [];
  if (query) {
    const [groups, platforms] = await Promise.all([
      collect(store, "groups", {
        where: search(query, "name"),
        columns: ["id"],
      }),
      collect(store, "platform_vault", {
        where: search(query, "platform_name"),
        columns: ["account_email"],
      }),
    ]);
    filters.push(
      or(
        search(query, "email", "remark"),
        oneOf(
          "group_id",
          groups.map((g) => g.id),
        ),
        oneOf(
          "email",
          platforms.map((p) => p.account_email),
        ),
      ),
    );
  }
  if (c.req.query("group_id"))
    filters.push(
      eq("group_id", integer(c.req.query("group_id"), "分组", 1, 1000000)),
    );
  if (c.req.query("tag_id")) {
    const links = await collect(store, "account_tags", {
      where: eq("tag_id", integer(c.req.query("tag_id"), "标签", 1, 1000000)),
      columns: ["account_id"],
    });
    filters.push(
      oneOf(
        "id",
        links.map((r) => r.account_id),
      ),
    );
  }
  if (c.req.query("status"))
    filters.push(
      eq(
        "status",
        choice(c.req.query("status"), "状态", ["active", "disabled"]),
      ),
    );
  if (c.req.query("auth_status"))
    filters.push(
      eq(
        "auth_status",
        choice(c.req.query("auth_status"), "授权状态", authStates),
      ),
    );
  const where = and(...filters);
  const [rows, total, all, disabled, healthy, unchecked, attention] =
    await Promise.all([
      store.select("accounts", {
        where,
        order: [["id", "desc"]],
        limit,
        offset: (page - 1) * limit,
      }),
      store.count("accounts", where),
      store.count("accounts"),
      store.count("accounts", eq("status", "disabled")),
      store.count(
        "accounts",
        and(eq("status", "active"), eq("auth_status", "healthy")),
      ),
      store.count(
        "accounts",
        and(eq("status", "active"), eq("auth_status", "unchecked")),
      ),
      store.count(
        "accounts",
        and(
          eq("status", "active"),
          oneOf("auth_status", ["error", "reauth_required"]),
        ),
      ),
    ]);
  const [groups, links, platforms, tags] = await Promise.all([
    collect(store, "groups", {
      where: oneOf(
        "id",
        rows.map((a) => a.group_id),
      ),
    }),
    collect(store, "account_tags", {
      where: oneOf(
        "account_id",
        rows.map((a) => a.id),
      ),
    }),
    collect(store, "platform_vault", {
      where: and(
        oneOf(
          "account_email",
          rows.map((a) => a.email),
        ),
        eq("email_source", "outlook"),
      ),
      columns: ["account_email"],
    }),
    collect(store, "tags"),
  ]);
  const groupMap = new Map(groups.map((g) => [g.id, g])),
    tagMap = new Map(tags.map((t) => [t.id, t]));
  return c.json({
    success: true,
    data: rows.map(({ password, refresh_token, ...row }) => ({
      ...row,
      has_password: password ? 1 : 0,
      group_name: groupMap.get(row.group_id)?.name || "",
      group_color: groupMap.get(row.group_id)?.color || "",
      platform_count: platforms.filter((p) => p.account_email === row.email)
        .length,
      tags: links
        .filter((l) => l.account_id === row.id)
        .map((l) => tagMap.get(l.tag_id))
        .filter(Boolean),
    })),
    total,
    page,
    limit,
    summary: { total: all, disabled, healthy, unchecked, attention },
  });
});
app.get("/accounts/export", async (c) => {
  const ids = (c.req.query("ids") || "")
    .split(",")
    .filter(Boolean)
    .map((id) => integer(id, "账号 ID", 1, Number.MAX_SAFE_INTEGER));
  if (!ids.length || ids.length > 100) invalid("请选中 1–100 个账号后导出");
  const results = await db(c.env).select("accounts", {
    where: oneOf("id", ids),
    order: [["id", "asc"]],
    columns: [
      "email",
      "password",
      "client_id",
      "refresh_token",
      "remark",
      "group_id",
    ],
  });
  return c.json(
    { version: 1, exported_at: new Date().toISOString(), accounts: results },
    200,
    { "Content-Disposition": 'attachment; filename="outlook-accounts.json"' },
  );
});
app.post("/accounts", async (c) => {
  const body = object(await c.req.json());
  const account = validateAccount(body);
  const group = integer(body.group_id, "分组", 1, 1000000, 1);
  const status = choice(body.status, "状态", ["active", "disabled"], "active");
  await assertGroup(c.env, group);
  const result = await db(c.env).mutate([
    accountMutation(account, group),
    update("accounts", eq("email", account.email), { status }),
  ]);
  const row = { id: result[0].rows[0]?.id, email: account.email };
  return c.json({
    success: true,
    data: row,
    message: "Outlook 账号已保存，请测试连接",
  });
});
app.post("/parse-preview", async (c) => {
  const body = object(await c.req.json());
  return c.json({
    success: true,
    ...importPreview(parseImport(body.raw_text)),
  });
});
app.post("/batch-import", async (c) => {
  const body = object(await c.req.json());
  if (body.raw_text !== undefined && body.accounts !== undefined)
    invalid("raw_text 与 accounts 请只提供一种，避免重复导入");
  const raw =
    body.accounts === undefined ? body.raw_text : JSON.stringify(body.accounts);
  const parsed = parseImport(raw);
  if (!parsed.accounts.length) invalid("未识别到有效账号，请检查导入预览");
  const group = integer(body.group_id, "分组", 1, 1000000, 1);
  const mode = choice(
    body.duplicate_mode,
    "重复处理方式",
    ["skip", "update"],
    "skip",
  );
  const sync = boolean(body.sync_to_vault, "同步至台账", true);
  await assertGroup(c.env, group);
  const existing = new Set(
    (
      await collect(db(c.env), "accounts", {
        where: oneOf(
          "email",
          parsed.accounts.map((a) => a.email),
        ),
        columns: ["email"],
      })
    ).map((r) => String(r.email)),
  );
  const toWrite = parsed.accounts.filter(
    (a) => mode === "update" || !existing.has(a.email),
  );
  let created = 0,
    updated = 0;
  for (let i = 0; i < toWrite.length; i += 50) {
    const chunk = toWrite.slice(i, i + 50);
    try {
      const saved = await db(c.env).mutate([
        accountBatchMutation(chunk, group, mode),
      ]);
      for (const result of saved)
        for (const row of result.rows) {
          if (existing.has(String(row.email))) updated++;
          else created++;
        }
      if (sync) {
        const linked = await collect(db(c.env), "platform_vault", {
          where: and(
            oneOf(
              "account_email",
              chunk.map((a) => a.email),
            ),
            { field: "platform_name", op: "ieq", value: "outlook" },
          ),
        });
        const accounts = await db(c.env).select("accounts", {
          where: oneOf(
            "email",
            chunk.map((a) => a.email),
          ),
        });
        await db(c.env).mutate(
          accounts.map((a) =>
            linked.some((v) => v.account_email === a.email)
              ? update(
                  "platform_vault",
                  and(eq("account_email", a.email), {
                    field: "platform_name",
                    op: "ieq",
                    value: "outlook",
                  }),
                  { password: a.password, updated_at: now() },
                )
              : insert("platform_vault", {
                  platform_name: "Outlook",
                  platform_url: "https://outlook.live.com",
                  account_email: a.email,
                  email_source: "outlook",
                  username: a.email,
                  password: a.password,
                  category: "微软生态",
                  remark: a.remark,
                }),
          ),
        );
      }
    } catch (error) {
      if (error instanceof Error && error.name === "StorageError") throw error;
      return c.json(
        {
          success: false,
          error: "IMPORT_PARTIAL",
          message: `导入中断，已有 ${created + updated} 个账号保存；修正后可用“跳过已有”重试`,
          created,
          updated,
          count: created + updated,
        },
        500,
      );
    }
  }
  return c.json({
    success: true,
    created,
    updated,
    count: created + updated,
    skipped: parsed.accounts.length - created - updated,
    duplicate_count: parsed.duplicate_count,
    invalid_count: parsed.error_count,
    errors: parsed.rows
      .filter((r) => r.error)
      .map(({ line, error }) => ({ line, error })),
    message: `新增 ${created} 个，更新 ${updated} 个，跳过 ${parsed.accounts.length - created - updated} 个，格式异常 ${parsed.error_count} 行`,
  });
});
app.post("/accounts/batch", async (c) => {
  const body = object(await c.req.json());
  const action = choice(body.action, "批量操作", [
    "check",
    "move",
    "enable",
    "disable",
    "delete",
    "tag",
    "untag",
  ]);
  if (
    !Array.isArray(body.ids) ||
    !body.ids.length ||
    body.ids.length > (action === "check" ? 10 : 50)
  )
    invalid(
      action === "check" ? "每次最多检查 10 个账号" : "每次最多操作 50 个账号",
    );
  const ids = [
    ...new Set(
      body.ids.map((id) => integer(id, "账号 ID", 1, Number.MAX_SAFE_INTEGER)),
    ),
  ];
  const where = oneOf("id", ids);
  if (action === "check") {
    const results = await db(c.env).select<OutlookAccount>("accounts", {
      where,
    });
    const checks: { id: number; success: boolean; message: string }[] = [];
    for (let i = 0; i < results.length; i += 3)
      checks.push(
        ...(await Promise.all(
          results.slice(i, i + 3).map(async (account) => {
            const result = await checkOutlook(c.env, account);
            return {
              id: account.id,
              success: !result.error,
              message: result.error?.message || "连接正常",
            };
          }),
        )),
      );
    return c.json({
      success: true,
      data: checks,
      message: `完成 ${checks.length} 个连接检查`,
    });
  }
  if (action === "move") {
    const group = integer(body.group_id, "分组", 1, 1000000);
    await assertGroup(c.env, group);
    await db(c.env).mutate([
      update("accounts", where, { group_id: group, updated_at: now() }),
    ]);
  } else if (action === "tag" || action === "untag") {
    const tag = integer(body.tag_id, "标签", 1, 1000000);
    if (!(await db(c.env).first("tags", eq("id", tag)))) invalid("标签不存在");
    if (action === "tag") {
      const accounts = await db(c.env).select("accounts", {
        where,
        columns: ["id"],
      });
      await db(c.env).mutate([
        {
          op: "insert",
          table: "account_tags",
          rows: accounts.map((a) => ({ account_id: a.id, tag_id: tag })),
          conflict: "ignore",
        },
      ]);
    } else
      await db(c.env).mutate([
        remove(
          "account_tags",
          and(eq("tag_id", tag), oneOf("account_id", ids)),
        ),
      ]);
  } else if (action === "delete") {
    await db(c.env).mutate([remove("accounts", where)]);
  } else
    await db(c.env).mutate([
      update("accounts", where, {
        status: action === "enable" ? "active" : "disabled",
        updated_at: now(),
      }),
    ]);
  return c.json({ success: true, message: `已处理 ${ids.length} 个账号` });
});
app.get("/accounts/:id", async (c) => {
  const account = await getAccount(
    c.env,
    integer(c.req.param("id"), "账号 ID", 1, Number.MAX_SAFE_INTEGER),
  );
  if (!account) return c.json({ success: false, message: "账号不存在" }, 404);
  return c.json({ success: true, data: account });
});
app.put("/accounts/:id", async (c) => {
  const account = await getAccount(
    c.env,
    integer(c.req.param("id"), "账号 ID", 1, Number.MAX_SAFE_INTEGER),
  );
  if (!account) return c.json({ success: false, message: "账号不存在" }, 404);
  const body = object(await c.req.json());
  if (body.email !== undefined && body.email !== account.email)
    invalid("邮箱地址不可修改，请添加新账号后调整平台绑定");
  const updated = validateAccount({
    ...account,
    ...body,
    email: account.email,
  });
  const group = integer(body.group_id, "分组", 1, 1000000, account.group_id);
  const status = choice(
    body.status,
    "状态",
    ["active", "disabled"],
    account.status === "active" ? "active" : "disabled",
  );
  await assertGroup(c.env, group);
  const changed =
    updated.client_id !== account.client_id ||
    updated.refresh_token !== account.refresh_token;
  await db(c.env).mutate([
    update("accounts", eq("id", account.id), {
      password: updated.password,
      client_id: updated.client_id,
      refresh_token: updated.refresh_token,
      remark: updated.remark,
      group_id: group,
      status,
      auth_status: changed ? "unchecked" : account.auth_status,
      last_error: changed ? "" : account.last_error,
      last_error_code: changed ? "" : account.last_error_code,
      last_checked_at: changed ? "" : account.last_checked_at,
      ...(changed
        ? {
            last_token_refresh_at: "",
            last_token_attempt_at: "",
            next_token_refresh_at: "",
            token_refresh_failures: 0,
            token_refresh_status: "pending",
            token_refresh_error: "",
          }
        : {}),
      updated_at: now(),
    }),
  ]);
  return c.json({ success: true, message: "账号已更新" });
});
app.post("/accounts/:id/check", async (c) => {
  const account = await getAccount(c.env, c.req.param("id"));
  if (!account) return c.json({ success: false, message: "账号不存在" }, 404);
  const result = await checkOutlook(c.env, account);
  return result.error
    ? c.json(outlookFailure(result.error), 400)
    : c.json({ success: true, message: "微软邮件连接正常" });
});
app.post("/accounts/:id/send", async (c) => {
  const account = await getAccount(
    c.env,
    integer(c.req.param("id"), "账号 ID", 1, Number.MAX_SAFE_INTEGER),
  );
  if (!account)
    return c.json(
      { success: false, error: "ACCOUNT_NOT_FOUND", message: "账号不存在" },
      404,
    );
  const result = await sendOutlookMail(c.env, account, await c.req.json());
  if (result.error) {
    if (result.error.retry_after)
      c.header("Retry-After", String(result.error.retry_after));
    return c.json(outlookFailure(result.error), outboundStatus(result.error));
  }
  return c.json({ success: true, data: result.data }, 202);
});
app.post("/accounts/:id/messages/:messageId/reply", async (c) => {
  const account = await getAccount(
    c.env,
    integer(c.req.param("id"), "账号 ID", 1, Number.MAX_SAFE_INTEGER),
  );
  if (!account)
    return c.json(
      { success: false, error: "ACCOUNT_NOT_FOUND", message: "账号不存在" },
      404,
    );
  const result = await replyOutlookMail(
    c.env,
    account,
    c.req.param("messageId"),
    await c.req.json(),
  );
  if (result.error) {
    if (result.error.retry_after)
      c.header("Retry-After", String(result.error.retry_after));
    return c.json(outlookFailure(result.error), outboundStatus(result.error));
  }
  return c.json({ success: true, data: result.data }, 202);
});
app.get("/accounts/:id/code", async (c) => {
  const account = await getAccount(c.env, c.req.param("id"));
  if (!account) return c.json({ success: false, message: "账号不存在" }, 404);
  const result = await outlookCode(c.env, account, {
    since: since(c.req.query("since")),
    sender: text(c.req.query("sender"), "发件人", 254),
    keyword: text(c.req.query("q"), "关键词", 200),
  });
  return result.error
    ? c.json(outlookFailure(result.error), 400)
    : c.json({ success: true, data: result.data });
});
app.get("/accounts/:id/emails", async (c) => {
  const folder = choice(c.req.query("folder"), "文件夹", FOLDERS, "inbox");
  const nextLink = text(c.req.query("cursor"), "分页链接", 16000);
  if (nextLink && !validNextLink(nextLink, folder))
    invalid("分页链接无效，请重新加载邮件");
  const options = {
    folder,
    top: integer(c.req.query("top"), "邮件数量", 1, 50, 20),
    keyword: text(c.req.query("q"), "关键词", 200),
    nextLink: nextLink || undefined,
    includeBody: true,
  };
  const account = await getAccount(c.env, c.req.param("id"));
  if (!account) return c.json({ success: false, message: "账号不存在" }, 404);
  const result = await withOutlook(c.env, account, (token) =>
    fetchEmails(token, options),
  );
  return result.error
    ? c.json(outlookFailure(result.error), 400)
    : c.json({
        success: true,
        data: result.data.items.map(({ body, ...mail }) => {
          const info = extractVerificationInfo(
            mail.subject,
            mail.bodyPreview,
            body?.content,
          );
          return {
            ...mail,
            verification_code: info.code,
            verification_link: info.link,
          };
        }),
        next_cursor: result.data.nextLink || "",
      });
});
app.get("/accounts/:id/messages/:message", async (c) => {
  const account = await getAccount(c.env, c.req.param("id"));
  if (!account) return c.json({ success: false, message: "账号不存在" }, 404);
  const result = await withOutlook(c.env, account, async (token) => {
    const message = await fetchMessage(token, c.req.param("message"));
    if (message.error) return message;
    const attachments = message.data.hasAttachments
      ? await fetchAttachments(token, message.data.id)
      : { data: [] };
    const verification = extractVerificationInfo(
      message.data.subject || "",
      message.data.bodyPreview || "",
      message.data.body?.content || "",
    );
    return {
      data: {
        ...message.data,
        verification_code: verification.code,
        verification_link: verification.link,
        attachments: attachments.data || [],
        attachment_error: attachments.error?.message || "",
      },
    };
  });
  return result.error
    ? c.json(outlookFailure(result.error), 400)
    : c.json({ success: true, data: result.data });
});
app.get(
  "/accounts/:id/messages/:message/attachments/:attachment",
  async (c) => {
    const account = await getAccount(c.env, c.req.param("id"));
    if (!account) return c.json({ success: false, message: "账号不存在" }, 404);
    const result = await withOutlook(c.env, account, (token) =>
      downloadAttachment(
        token,
        c.req.param("message"),
        c.req.param("attachment"),
      ),
    );
    if (result.error) return c.json(outlookFailure(result.error), 400);
    const headers = new Headers({
      "Content-Type":
        result.data.headers.get("Content-Type") || "application/octet-stream",
      "Content-Disposition": "attachment",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    return new Response(result.data.body, { headers });
  },
);
app.delete("/accounts/:id/messages/:message", async (c) => {
  const account = await getAccount(c.env, c.req.param("id"));
  if (!account) return c.json({ success: false, message: "账号不存在" }, 404);
  const result = await withOutlook(c.env, account, (token) =>
    deleteMessage(token, c.req.param("message")),
  );
  return result.error
    ? c.json(outlookFailure(result.error), 400)
    : c.json({
        success: true,
        message: "微软已确认删除邮件，可在微软邮箱中检查结果",
      });
});
app.delete("/accounts/:id", async (c) => {
  const [result] = await db(c.env).mutate([
    remove(
      "accounts",
      eq(
        "id",
        integer(c.req.param("id"), "账号 ID", 1, Number.MAX_SAFE_INTEGER),
      ),
    ),
  ]);
  return result.changes
    ? c.json({ success: true, message: "托管账号已删除，平台台账仍保留" })
    : c.json({ success: false, message: "账号不存在" }, 404);
});
export default app;
