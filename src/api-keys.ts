import type { Context } from "hono";
import { and, db, eq, insert, now, update, type Row } from "./storage/client";
import type { Env } from "./types";
import { email, integer, invalid, object, text } from "./validation";
import { mailboxReferenceFilter } from "./registration";

export const API_SCOPES = [
  "verify:read",
  "mailbox:write",
  "vault:read",
  "vault:write",
  "admin",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export interface ResourceRestrictions {
  emails?: readonly string[];
  platforms?: readonly string[];
}
export interface AuthContext {
  readonly kind: "admin_session" | "master_key" | "api_key";
  readonly actor: string;
  readonly keyId?: string;
  readonly keyPrefix: string;
  readonly scopes: readonly ApiScope[];
  readonly restrictions: Readonly<ResourceRestrictions>;
}
export interface ApiKeyRecord {
  id: string;
  key_hash: string;
  prefix: string;
  name: string;
  scopes: string;
  restrictions: string;
  expires_at: string;
  revoked_at: string;
  last_used_at: string;
  created_at: string;
  updated_at: string;
}
export async function hashApiKey(value: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
function scopes(value: unknown): ApiScope[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > API_SCOPES.length ||
    value.some((v) => !API_SCOPES.includes(v))
  )
    invalid("scopes 须为非空的有效权限列表");
  return [...new Set(value)] as ApiScope[];
}
export function parseRestrictions(value: unknown): ResourceRestrictions {
  const input = value === undefined ? {} : object(value);
  if (Object.keys(input).some((k) => !["emails", "platforms"].includes(k)))
    invalid("资源限制仅支持 emails、platforms");
  const output: { emails?: string[]; platforms?: string[] } = {};
  for (const field of ["emails", "platforms"] as const) {
    if (input[field] === undefined) continue;
    if (
      !Array.isArray(input[field]) ||
      !input[field].length ||
      input[field].length > 100
    )
      invalid(`${field} 须包含 1–100 个精确值`);
    output[field] = [
      ...new Set(
        (input[field] as unknown[]).map((v) => {
          const result =
            field === "emails"
              ? email(v)
              : text(v, "平台名称", 100).trim().toLowerCase();
          if (!result || /[\u0000-\u001f\u007f*]/.test(result))
            invalid("资源限制不支持空值、通配符或控制字符");
          return result;
        }),
      ),
    ];
  }
  return output;
}
export function apiKeyMetadata(row: ApiKeyRecord) {
  const { key_hash, scopes: rawScopes, restrictions, ...metadata } = row;
  return {
    ...metadata,
    scopes: scopes(JSON.parse(rawScopes)),
    restrictions: parseRestrictions(JSON.parse(restrictions)),
  };
}
export async function createApiKey(env: Env, value: unknown) {
  const body = object(value);
  if (
    Object.keys(body).some(
      (k) => !["name", "scopes", "restrictions", "expires_at"].includes(k),
    )
  )
    invalid("API Key 参数无效");
  const name = text(body.name, "名称", 80).trim();
  if (!name || /[\u0000-\u001f\u007f]/.test(name))
    invalid("请填写 API Key 名称");
  const allowed = scopes(body.scopes),
    restrictions = parseRestrictions(body.restrictions);
  const expiry =
    body.expires_at === undefined
      ? Date.now() + 30 * 86400000
      : Date.parse(text(body.expires_at, "到期时间", 40));
  if (
    !Number.isFinite(expiry) ||
    expiry <= Date.now() ||
    expiry > Date.now() + 365 * 86400000 ||
    (body.expires_at !== undefined &&
      !/(?:Z|[+-]\d\d:\d\d)$/i.test(String(body.expires_at)))
  )
    invalid("到期时间必须带时区且在未来 365 天内");
  if ((await db(env).count("api_keys")) >= 1000)
    invalid("API Key 数量已达到 1000 个上限");
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const token = `mhk_${Array.from(secret, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  const row = {
    id: crypto.randomUUID(),
    key_hash: await hashApiKey(token),
    prefix: token.slice(0, 12),
    name,
    scopes: JSON.stringify(allowed),
    restrictions: JSON.stringify(restrictions),
    expires_at: new Date(expiry).toISOString(),
    revoked_at: "",
    last_used_at: "",
    created_at: now(),
    updated_at: now(),
  };
  await db(env).mutate([insert("api_keys", row)]);
  return { ...apiKeyMetadata(row), key: token };
}
export async function authenticateApiKey(
  env: Env,
  token: string,
): Promise<AuthContext | null> {
  if (!/^mhk_[a-f0-9]{64}$/.test(token)) return null;
  const row = await db(env).first<ApiKeyRecord>(
    "api_keys",
    eq("key_hash", await hashApiKey(token)),
  );
  if (
    !row ||
    row.revoked_at ||
    !Number.isFinite(Date.parse(row.expires_at)) ||
    Date.parse(row.expires_at) <= Date.now()
  )
    return null;
  let metadata;
  try {
    metadata = apiKeyMetadata(row);
  } catch {
    return null;
  }
  // Freeze arrays as well as the context so downstream handlers cannot accidentally broaden a grant.
  const restrictions = Object.freeze(
    Object.fromEntries(
      Object.entries(metadata.restrictions).map(([k, v]) => [
        k,
        Object.freeze([...v]),
      ]),
    ),
  ) as ResourceRestrictions;
  return Object.freeze({
    kind: "api_key",
    actor: `key:${row.id}`,
    keyId: row.id,
    keyPrefix: row.prefix,
    scopes: Object.freeze(metadata.scopes),
    restrictions,
  });
}
export async function touchApiKey(env: Env, auth: AuthContext) {
  if (!auth.keyId) return;
  await db(env).mutate([
    update(
      "api_keys",
      and(eq("id", auth.keyId), {
        or: [
          eq("last_used_at", ""),
          {
            field: "last_used_at",
            op: "lt",
            value: new Date(Date.now() - 300000).toISOString(),
          },
        ],
      }),
      { last_used_at: now() },
    ),
  ]);
}
export class AuthorizationError extends Error {
  constructor(
    public code = "FORBIDDEN",
    message = "API Key 没有此操作或资源的权限",
  ) {
    super(message);
  }
}
export function requireScopes(
  auth: AuthContext,
  required: readonly ApiScope[],
) {
  if (auth.kind !== "api_key" || auth.scopes.includes("admin")) return;
  if (!required.every((scope) => auth.scopes.includes(scope)))
    throw new AuthorizationError("INSUFFICIENT_SCOPE");
}
export function sessionOnlyPath(path: string) {
  return (
    /^\/api\/(?:auth\/)?(?:api-keys|audit|backups)(?:\/|$)/.test(path) ||
    /^\/api\/settings\/(?:storage|credentials|password|api-key|webhooks)(?:\/|$)/.test(
      path,
    ) ||
    /^\/api\/outlook\/oauth(?:\/|$)/.test(path)
  );
}
type Policy = {
  scopes: ApiScope[];
  resource?:
    | "vault"
    | "mailbox"
    | "mail"
    | "outlook"
    | "provider"
    | "target"
    | "register";
  id?: number;
  collection?: boolean;
};
function policy(method: string, path: string): Policy | null {
  const read = method === "GET" || method === "HEAD";
  if (path === "/api/capabilities" && read) return { scopes: [] };
  if (
    /^\/api\/automation\/(?:mailbox|verification(?:\/batch)?)$/.test(path) &&
    method === "POST"
  )
    return { scopes: ["verify:read"], resource: "target" };
  if (path === "/api/external/code" && read)
    return { scopes: ["verify:read"], resource: "target" };
  if (path === "/api/external/register" && method === "POST")
    return { scopes: ["mailbox:write", "vault:write"], resource: "register" };
  const providerAccount = path.match(
    /^\/api\/providers\/accounts\/(\d+)(?:\/(code|check|messages(?:\/[^/]+)?))?$/,
  );
  if (providerAccount)
    return {
      scopes: [
        providerAccount[2] === "code" && read
          ? "verify:read"
          : read
            ? "admin"
            : "mailbox:write",
      ],
      resource: "provider",
      id: Number(providerAccount[1]),
    };
  if (
    /^\/api\/providers(?:\/accounts|\/(?:mailtm|mailgw|mailslurp|mailinator)\/domains)?$/.test(
      path,
    )
  )
    return { scopes: [read ? "admin" : "mailbox:write"], collection: true };
  let match = path.match(
    /^\/api\/(vault|mailboxes)\/(\d+)(?:\/(code|pin|extend|toggle-permanent|link-vault))?$/,
  );
  if (match) {
    const vault = match[1] === "vault";
    if (match[3] === "code" && read)
      return {
        scopes: ["verify:read"],
        resource: vault ? "vault" : "mailbox",
        id: Number(match[2]),
      };
    if (
      (!match[3] &&
        ["GET", "HEAD", "PUT", "PATCH", "DELETE"].includes(method)) ||
      (match[3] && method === "POST")
    )
      return {
        scopes: [
          vault
            ? read
              ? "vault:read"
              : "vault:write"
            : read
              ? "verify:read"
              : "mailbox:write",
        ],
        resource: vault ? "vault" : "mailbox",
        id: Number(match[2]),
      };
  }
  if (
    /^\/api\/vault(?:\/(?:platforms|stats|export|import|import-preview|batch))?$/.test(
      path,
    ) &&
    (read || method === "POST")
  )
    return {
      scopes: [read ? "vault:read" : "vault:write"],
      resource: "vault",
      collection: true,
    };
  if (
    /^\/api\/mailboxes(?:\/(?:generate|batch|batch-preview))?$/.test(path) &&
    (read || method === "POST")
  )
    return {
      scopes: [read ? "verify:read" : "mailbox:write"],
      resource: "mailbox",
      collection: true,
    };
  if (/^\/api\/mailbox\/(generate|custom)$/.test(path) && method === "POST")
    return { scopes: ["mailbox:write"], resource: "mailbox", collection: true };
  match = path.match(
    /^\/api\/cf-mails\/(\d+)\/(?:raw|attachments(?:\/[^/]+)?)$/,
  );
  if (match && read)
    return { scopes: ["admin"], resource: "mail", id: Number(match[1]) };
  if (/^\/api\/cf-mails(?:\/(?:\d+|batch|clean|recipients))?$/.test(path))
    return {
      scopes: [read ? "admin" : "mailbox:write"],
      resource: "mail",
      id: /^\/api\/cf-mails\/\d+$/.test(path)
        ? Number(path.split("/").at(-1))
        : undefined,
      collection: true,
    };
  if (path === "/api/emails/list" && read)
    return { scopes: ["admin"], resource: "mail", collection: true };
  match = path.match(/^\/api\/emails\/view\/(\d+)$/);
  if (match && read)
    return { scopes: ["admin"], resource: "mail", id: Number(match[1]) };
  match = path.match(
    /^\/api\/outlook\/accounts\/(\d+)\/(?:send|messages\/[^/]+\/reply)$/,
  );
  if (match && method === "POST")
    return { scopes: ["admin"], resource: "outlook", id: Number(match[1]) };
  match = path.match(
    /^\/api\/outlook\/accounts\/(\d+)(?:\/(code|check|recovery|emails|raw|messages(?:\/[^/]+(?:\/(?:raw|attachments(?:\/[^/]+)?))?)?))?$/,
  );
  if (match)
    return {
      scopes: [
        match[2] === "code" && read
          ? "verify:read"
          : read
            ? "admin"
            : "mailbox:write",
      ],
      resource: "outlook",
      id: Number(match[1]),
    };
  if (
    /^\/api\/outlook\/(?:accounts(?:\/(?:batch|export))?|parse-preview|batch-import|renewal(?:\/run)?|groups(?:\/\d+)?|tags(?:\/\d+)?)$/.test(
      path,
    ) ||
    /^\/api\/mail-rules(?:\/(?:\d+|preview)(?:\/(?:preview|apply))?)?$/.test(
      path,
    ) ||
    /^\/api\/settings(?:\/domains(?:\/[^/]+(?:\/check)?)?)?$/.test(path) ||
    /^\/api\/platforms(?:\/[^/]+(?:\/merge)?)?$/.test(path) ||
    /^\/api\/mailbox-identities(?:\/[^/]+(?:\/(?:registrations|impact))?)?$/.test(
      path,
    ) ||
    path === "/api/search"
  )
    return { scopes: ["admin"], collection: true };
  return null; // New routes never implicitly inherit scoped admin access.
}
const ieq = (field: string, value: string) => ({
  field,
  op: "ieq" as const,
  value,
});
async function resourceAllowed(
  env: Env,
  auth: AuthContext,
  address?: unknown,
  platform?: unknown,
) {
  const restrictions = auth.restrictions,
    emailValue = String(address || "")
      .trim()
      .toLowerCase(),
    platformValue = String(platform || "")
      .trim()
      .toLowerCase();
  if (
    restrictions.emails &&
    (!emailValue || !restrictions.emails.includes(emailValue))
  )
    throw new AuthorizationError("RESOURCE_FORBIDDEN");
  if (restrictions.platforms) {
    if (platformValue) {
      if (!restrictions.platforms.includes(platformValue))
        throw new AuthorizationError("RESOURCE_FORBIDDEN");
    } else {
      if (!emailValue) throw new AuthorizationError("RESOURCE_FORBIDDEN");
      const links = await db(env).select("platform_vault", {
        where: and(mailboxReferenceFilter(emailValue), {
          or: restrictions.platforms.map((p) => ieq("platform_name", p)),
        }),
        columns: ["id"],
        limit: 1,
      });
      if (!links.length) throw new AuthorizationError("RESOURCE_FORBIDDEN");
    }
  }
}
/** Authorize both login identity and actual mailbox before reading or mutating a registration. */
export async function authorizeVaultAccount(
  env: Env,
  auth: AuthContext | undefined,
  row: {
    account_email?: unknown;
    platform_name?: unknown;
    mailbox_address?: unknown;
  },
) {
  if (auth?.kind !== "api_key") return;
  await resourceAllowed(env, auth, row.account_email, row.platform_name);
  if (row.mailbox_address)
    await resourceAllowed(env, auth, row.mailbox_address, row.platform_name);
}
async function rowAllowed(
  env: Env,
  auth: AuthContext,
  resource: Policy["resource"],
  id: number,
): Promise<Row> {
  const table =
    resource === "vault"
      ? "platform_vault"
      : resource === "mailbox"
        ? "temp_mailboxes"
        : resource === "outlook"
          ? "accounts"
          : resource === "provider"
            ? "provider_accounts"
            : "cf_inbox_mails";
  const columns =
    resource === "vault"
      ? ["account_email", "platform_name", "mailbox_address"]
      : resource === "mailbox"
        ? ["address", "associated_platform"]
        : resource === "outlook"
          ? ["email"]
          : resource === "provider"
            ? ["address"]
            : ["recipient"];
  const row = await db(env).first(table, eq("id", id), { columns });
  if (!row) throw new AuthorizationError("RESOURCE_FORBIDDEN");
  await resourceAllowed(
    env,
    auth,
    row.account_email ?? row.address ?? row.email ?? row.recipient,
    resource === "vault" ? row.platform_name : undefined,
  );
  if (resource === "vault" && row.mailbox_address)
    await resourceAllowed(env, auth, row.mailbox_address, row.platform_name);
  return row;
}
async function targetAllowed(env: Env, auth: AuthContext, input: unknown) {
  const body = object(input);
  if (
    [body.email, body.vault_id, body.platform].filter((v) => v !== undefined)
      .length !== 1
  )
    invalid("email、vault_id、platform 必须且只能提供一个");
  if (body.vault_id !== undefined)
    return rowAllowed(
      env,
      auth,
      "vault",
      integer(body.vault_id, "台账 ID", 1, Number.MAX_SAFE_INTEGER),
    );
  if (body.email !== undefined)
    return resourceAllowed(env, auth, email(body.email));
  const platform = text(body.platform, "平台名称", 100).trim().toLowerCase();
  if (
    !platform ||
    (auth.restrictions.platforms &&
      !auth.restrictions.platforms.includes(platform))
  )
    throw new AuthorizationError("RESOURCE_FORBIDDEN");
  const rows = await db(env).select("platform_vault", {
    where: ieq("platform_name", platform),
    columns: ["account_email", "platform_name", "mailbox_address"],
    limit: 2,
  });
  if (rows.length !== 1)
    throw new AuthorizationError(
      "RESOURCE_FORBIDDEN",
      "受限密钥需要唯一且获准的台账目标，请使用 vault_id",
    );
  await authorizeVaultAccount(env, auth, rows[0]);
}
export async function authorizeApiRequest(
  c: Context<{ Bindings: Env }>,
  auth: AuthContext,
) {
  const path = c.req.path.replace(/\/$/, ""),
    method = c.req.method;
  if (sessionOnlyPath(path) && auth.kind !== "admin_session")
    throw new AuthorizationError(
      "ADMIN_SESSION_REQUIRED",
      "此操作需要管理员登录会话",
    );
  if (auth.kind !== "api_key") return;
  const rule = policy(method, path);
  if (!rule) throw new AuthorizationError();
  requireScopes(auth, rule.scopes);
  const restricted = !!(
    auth.restrictions.emails || auth.restrictions.platforms
  );
  const write = !["GET", "HEAD", "OPTIONS"].includes(method);
  // Composite allocation must not be used to acquire mailbox write through a vault-only key.
  let body: Record<string, unknown> = {};
  if (write && rule.resource) {
    const raw = await c.req.text();
    if (raw) {
      if (
        !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(
          c.req.header("Content-Type") || "",
        )
      )
        invalid("写入请求须使用 application/json");
      body = object(JSON.parse(raw));
    }
  }
  if (
    path === "/api/vault" &&
    method === "POST" &&
    (body.generate_email || !body.account_email)
  )
    requireScopes(auth, ["mailbox:write"]);
  if (!restricted || path === "/api/capabilities") return;
  if (rule.resource === "target") {
    if (path.endsWith("/batch")) {
      if (
        !Array.isArray(body.items) ||
        !body.items.length ||
        body.items.length > 5
      )
        invalid("items 须包含 1–5 个查收请求");
      for (const item of body.items) await targetAllowed(c.env, auth, item);
    } else if (path === "/api/external/code" && c.req.query("email")) {
      // This legacy route prioritizes email over platform. Authorize the actual
      // lookup target; an unrelated platform query must never confer access.
      await resourceAllowed(c.env, auth, email(c.req.query("email")));
    } else await targetAllowed(c.env, auth, write ? body : c.req.query());
    return;
  }
  if (rule.id !== undefined) {
    const row = await rowAllowed(c.env, auth, rule.resource, rule.id);
    if (rule.resource === "vault" && write)
      await resourceAllowed(
        c.env,
        auth,
        body.account_email ?? row.account_email,
        body.platform_name ?? row.platform_name,
      );
    if (rule.resource === "vault" && write && body.mailbox_address)
      await resourceAllowed(
        c.env,
        auth,
        body.mailbox_address,
        body.platform_name ?? row.platform_name,
      );
    if (rule.resource === "outlook" && write && body.email !== undefined)
      await resourceAllowed(c.env, auth, email(body.email));
    if (path.endsWith("/link-vault"))
      await rowAllowed(
        c.env,
        auth,
        "vault",
        integer(body.vault_id, "台账 ID", 1, Number.MAX_SAFE_INTEGER),
      );
    return;
  }
  if (path === "/api/vault/batch" || path === "/api/cf-mails/batch") {
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 100)
      invalid("ids 须包含 1–100 个 ID");
    for (const id of new Set(body.ids))
      await rowAllowed(
        c.env,
        auth,
        rule.resource,
        integer(id, "ID", 1, Number.MAX_SAFE_INTEGER),
      );
    return;
  }
  if (
    path === "/api/vault" &&
    method === "POST" &&
    body.account_email &&
    !body.generate_email
  ) {
    await authorizeVaultAccount(c.env, auth, {
      ...body,
      account_email: email(body.account_email),
    });
    return;
  }
  if (
    path === "/api/vault/import" &&
    Array.isArray(body.accounts) &&
    body.accounts.length > 0 &&
    body.accounts.length <= 200
  ) {
    for (const item of body.accounts) {
      const row = object(item);
      await authorizeVaultAccount(c.env, auth, {
        ...row,
        account_email: email(row.account_email),
      });
    }
    return;
  }
  if (["/api/cf-mails", "/api/emails/list"].includes(path) && !write) {
    const address =
      path === "/api/cf-mails"
        ? c.req.query("recipient")
        : c.req.query("address") || c.req.query("mailbox");
    if (address) {
      await resourceAllowed(c.env, auth, email(address));
      return;
    }
  }
  // Aggregate and vault list routes are deliberately denied for restricted keys. Do not
  // rely on a query parameter unless the route's own storage query enforces it.
  if (
    [
      "/api/mailboxes/generate",
      "/api/mailbox/custom",
      "/api/external/register",
    ].includes(path) &&
    method === "POST" &&
    body.prefix &&
    body.domain
  ) {
    // Only deterministic addresses can be evaluated before allocation.
    const address = email(
      `${text(body.prefix, "prefix", 64).trim()}@${text(body.domain, "domain", 253).trim()}`,
    );
    if (rule.resource === "register")
      await resourceAllowed(c.env, auth, address, body.platform_name);
    else await resourceAllowed(c.env, auth, address);
    return;
  }
  throw new AuthorizationError(
    "RESOURCE_SCOPE_REQUIRED",
    "此接口无法限定到获准资源，请使用明确的邮箱或台账 ID",
  );
}
