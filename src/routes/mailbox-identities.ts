import { Hono } from "hono";
import type { ProviderAccount } from "../../shared/mail-providers";
import { deliveryAddress } from "../../shared/registrations";
import { registrationDefaults } from "../../shared/registrations";
import { vaultSources } from "../vault-import";
import { collect, db, eq, and, type Row } from "../storage/client";
import { enrichVault } from "../vault-health";
import { mailboxReferenceFilter } from "../registration";
import type { Env, PlatformAccount } from "../types";
import { choice, email, integer, text } from "../validation";

const app = new Hono<{ Bindings: Env }>();
const safeColumns = [
  "id",
  "platform_name",
  "platform_url",
  "account_email",
  "email_source",
  "username",
  "status",
  "category",
  "remark",
  "is_pinned",
  "last_code",
  "last_code_at",
  "created_at",
  "updated_at",
  ...Object.keys(registrationDefaults),
];
export async function mailboxIdentities(env: Env) {
  const store = db(env);
  const [vault, outlook, providers, cf, platformCount] = await Promise.all([
    collect<PlatformAccount>(store, "platform_vault", { columns: safeColumns }),
    collect<Row>(store, "accounts", { columns: ["id", "email"] }),
    collect<Pick<ProviderAccount, "id" | "provider" | "address">>(
      store,
      "provider_accounts",
      { columns: ["id", "provider", "address"] },
    ),
    collect<Row>(store, "temp_mailboxes", {
      columns: ["id", "address", "expires_at", "is_permanent"],
    }),
    store.count("platforms"),
  ]);
  const groups = new Map<
    string,
    {
      id: string;
      address: string;
      source: PlatformAccount["email_source"];
      account_id: number | null;
      registrations: PlatformAccount[];
      expires_at: string;
      protected: boolean;
    }
  >();
  function add(
    source: PlatformAccount["email_source"],
    address: string,
    account_id: number | null = null,
    expires_at = "",
    protectedMailbox = false,
  ) {
    address = address.toLowerCase();
    const id = `${source}:${address}`;
    let row = groups.get(id);
    if (!row) {
      row = {
        id,
        address,
        source,
        account_id,
        registrations: [],
        expires_at,
        protected: protectedMailbox,
      };
      groups.set(id, row);
    }
    if (account_id !== null) row.account_id = account_id;
    return row;
  }
  for (const r of outlook) add("outlook", String(r.email), Number(r.id));
  for (const r of providers) add(r.provider, r.address, r.id);
  for (const r of cf)
    add(
      "cf_domain",
      String(r.address),
      Number(r.id),
      String(r.expires_at || ""),
      !!r.is_permanent,
    );
  for (const r of vault)
    add(r.email_source, deliveryAddress(r)).registrations.push(r);
  const raw = [...groups.values()];
  const enriched = await enrichVault(
    env,
    raw.map((r) => ({
      account_email: r.address,
      email_source: r.source,
      status: "active",
    })),
  );
  const data = raw
    .map((r, i) => ({
      id: r.id,
      address: r.address,
      source: r.source,
      account_id: r.account_id,
      health:
        r.source === "cf_domain" &&
        !r.protected &&
        r.expires_at &&
        Date.parse(r.expires_at) <= Date.now()
          ? {
              ...enriched[i].mailbox,
              state: "disabled" as const,
              label: "邮箱已过期 / 停用",
              message:
                "此临时邮箱已过期或停用，新的邮件将被拒收；已保存邮件仍可查询。",
              needs_attention: true,
              can_lookup: true,
            }
          : enriched[i].mailbox,
      registration_count: r.registrations.length,
      platform_count: new Set(
        r.registrations.map((v) => v.platform_name.trim().toLowerCase()),
      ).size,
      platforms: [...new Set(r.registrations.map((v) => v.platform_name))],
      expires_at: r.expires_at,
      protected: r.protected || r.registrations.length > 0,
      affected_registrations: r.registrations.filter(
        (v) => v.mailbox_link_state !== "detached",
      ).length,
    }))
    .sort(
      (a, b) =>
        a.address.localeCompare(b.address) || a.source.localeCompare(b.source),
    );
  const attention = data.filter((r) => r.health.needs_attention);
  return {
    data,
    summary: {
      total_platforms: platformCount,
      unique_addresses: new Set(data.map((r) => r.address)).size,
      total_registrations: vault.length,
      total_connections: data.filter((r) => r.account_id !== null).length,
      attention_connections: attention.length,
      affected_registrations: attention.reduce(
        (n, r) => n + r.affected_registrations,
        0,
      ),
      due_registrations: vault.filter(
        (r) =>
          r.status !== "deprecated" &&
          r.expires_at &&
          Number.isFinite(Date.parse(r.expires_at)) &&
          Date.parse(r.expires_at) <= Date.now() + 7 * 86400000,
      ).length,
    },
  };
}
app.get("/", async (c) => {
  const page = integer(c.req.query("page"), "页码", 1, 100000, 1),
    limit = integer(c.req.query("limit"), "每页数量", 1, 100, 30);
  const q = text(c.req.query("q"), "搜索", 200).trim().toLowerCase();
  const source = c.req.query("source")
    ? choice(c.req.query("source"), "来源", vaultSources)
    : "";
  const { data, summary } = await mailboxIdentities(c.env);
  const filtered = data.filter(
    (r) =>
      (!source || r.source === source) &&
      (!q || `${r.address} ${r.platforms.join(" ")}`.toLowerCase().includes(q)),
  );
  return c.json({
    success: true,
    data: filtered.slice((page - 1) * limit, page * limit),
    page,
    limit,
    total: filtered.length,
    summary,
  });
});
function parseIdentity(id: string) {
  const split = id.indexOf(":");
  const source = choice(id.slice(0, split), "来源", vaultSources);
  const address = email(id.slice(split + 1));
  return { source, address, id: `${source}:${address}` };
}
app.get("/:id/registrations", async (c) => {
  const identity = parseIdentity(c.req.param("id"));
  const page = integer(c.req.query("page"), "页码", 1, 100000, 1),
    limit = integer(c.req.query("limit"), "每页数量", 1, 100, 30);
  const all = await collect<PlatformAccount>(db(c.env), "platform_vault", {
    columns: safeColumns,
    where: and(
      eq("email_source", identity.source),
      mailboxReferenceFilter(identity.address),
    ),
    order: [["id", "asc"]],
  });
  return c.json({
    success: true,
    data: await enrichVault(c.env, all.slice((page - 1) * limit, page * limit)),
    total: all.length,
    page,
    limit,
    summary: {
      platforms: new Set(all.map((r) => r.platform_name.toLowerCase())).size,
      registrations: all.length,
    },
  });
});
app.get("/:id/impact", async (c) => {
  const id = parseIdentity(c.req.param("id")).id;
  const { data } = await mailboxIdentities(c.env),
    identity = data.find((r) => r.id === id);
  if (!identity)
    return c.json({ success: false, message: "邮箱身份不存在" }, 404);
  return c.json({
    success: true,
    data: {
      identity,
      registrations: identity.registration_count,
      protected: identity.protected,
    },
  });
});
app.get("/:id", async (c) => {
  const id = parseIdentity(c.req.param("id")).id;
  const { data } = await mailboxIdentities(c.env),
    identity = data.find((r) => r.id === id);
  return identity
    ? c.json({ success: true, data: identity })
    : c.json({ success: false, message: "邮箱身份不存在" }, 404);
});
export default app;
