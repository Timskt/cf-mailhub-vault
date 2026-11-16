import { db, eq, insert } from "./storage/client";
import type { Env, TempMailbox } from "./types";
import { invalid, text } from "./validation";

export interface MailDomain {
  domain: string;
  enabled: number;
  remark: string;
  source: "environment" | "database";
  is_default: boolean;
  dns_status: string;
  last_checked_at: string;
  last_received_at: string;
}

export function normalizeDomain(value: unknown): string {
  const input = text(value, "域名", 253)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (!input || /[\s/@:#?*\\]/.test(input))
    invalid("请输入纯域名，例如 mail.example.com");
  let domain: string;
  try {
    domain = new URL(`https://${input}`).hostname;
  } catch {
    return invalid("域名格式无效");
  }
  const labels = domain.split(".");
  if (
    domain.length > 253 ||
    labels.length < 2 ||
    /^\d+(\.\d+){3}$/.test(domain) ||
    labels.some(
      (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  )
    invalid("域名格式无效");
  return domain;
}

export async function getDomains(env: Env): Promise<MailDomain[]> {
  const environment = (env.CF_DOMAINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeDomain);
  const [results, preferred] = await Promise.all([
    db(env).select<Omit<MailDomain, "source" | "is_default">>("domains", {
      order: [
        ["created_at", "asc"],
        ["domain", "asc"],
      ],
    }),
    db(env).first<{ value: string }>(
      "settings",
      eq("key", "default_mail_domain"),
    ),
  ]);
  const domains = new Map<string, MailDomain>();
  for (const domain of environment)
    domains.set(domain, {
      domain,
      enabled: 1,
      remark: "",
      source: "environment",
      is_default: false,
      dns_status: "unchecked",
      last_checked_at: "",
      last_received_at: "",
    });
  for (const row of results)
    domains.set(row.domain, {
      ...row,
      source: environment.includes(row.domain) ? "environment" : "database",
      is_default: false,
    });
  const list = [...domains.values()];
  const defaultDomain =
    list.find((d) => d.enabled && d.domain === preferred?.value) ||
    list.find((d) => d.enabled);
  if (defaultDomain) defaultDomain.is_default = true;
  return list.sort(
    (a, b) =>
      Number(b.is_default) - Number(a.is_default) ||
      a.domain.localeCompare(b.domain),
  );
}

export async function chooseDomain(
  env: Env,
  requested?: unknown,
): Promise<string> {
  const domains = (await getDomains(env)).filter((d) => d.enabled);
  if (!domains.length) invalid("尚无可用域名，请先到系统设置接入邮件域名");
  if (requested) {
    const normalized = normalizeDomain(requested);
    if (!domains.some((d) => d.domain === normalized))
      invalid("该域名尚未接入或已停用");
    return normalized;
  }
  return domains[0].domain;
}

export async function prepareMailbox(
  env: Env,
  options: {
    domain?: unknown;
    prefix?: unknown;
    duration_minutes?: unknown;
    is_permanent?: unknown;
    remark?: unknown;
  } = {},
) {
  const domain = await chooseDomain(env, options.domain);
  let prefix = text(options.prefix, "邮箱前缀", 64).trim().toLowerCase();
  if (prefix && !/^[a-z0-9][a-z0-9._+-]{0,63}$/.test(prefix))
    invalid("邮箱前缀仅支持字母、数字及 . _ + -");
  if (!prefix) {
    const setting = await db(env).first<{ value: string }>(
      "settings",
      eq("key", "default_prefix"),
    );
    const base = (setting?.value ?? env.DEFAULT_PREFIX ?? "tmp")
      .replace(/[^a-z0-9_-]/gi, "")
      .slice(0, 30);
    prefix = `${base ? `${base}_` : ""}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  }
  const minutes = options.duration_minutes ?? 60;
  if (
    typeof minutes !== "number" ||
    !Number.isSafeInteger(minutes) ||
    minutes < -1 ||
    minutes > 525600
  )
    invalid("有效期须为 1–525600 分钟，0 或 -1 表示永久");
  if (
    options.is_permanent !== undefined &&
    typeof options.is_permanent !== "boolean"
  )
    invalid("is_permanent 必须是布尔值");
  const permanent = options.is_permanent === true || minutes <= 0;
  const address = `${prefix}@${domain}`;
  const existing = await db(env).first(
    "temp_mailboxes",
    eq("address", address),
  );
  if (existing)
    invalid("该邮箱地址已存在，请使用另一个前缀或从台账中切换至该邮箱");
  const expires = permanent
    ? ""
    : new Date(Date.now() + minutes * 60000).toISOString();
  if (address.length > 254) invalid("邮箱地址超过 254 个字符");
  return {
    address,
    prefix,
    domain,
    expires_at: expires,
    is_permanent: permanent ? 1 : 0,
    remark: text(options.remark, "备注"),
  };
}

export async function allocateMailbox(
  env: Env,
  options: Parameters<typeof prepareMailbox>[1] = {},
) {
  const prepared = await prepareMailbox(env, options);
  const [saved] = await db(env).mutate([insert("temp_mailboxes", prepared)]);
  const row = saved.rows[0] as unknown as TempMailbox;
  if (!row) throw new Error("Mailbox insert failed");
  return {
    ...row,
    remaining_seconds: row.is_permanent
      ? 0
      : Math.max(
          0,
          Math.ceil((Date.parse(row.expires_at) - Date.now()) / 1000),
        ),
    is_expired: false,
  };
}
