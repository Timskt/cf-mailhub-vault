import { getDomains, type MailDomain } from "./domains";
import { collect, db, type Filter } from "./storage/client";
import type { Env, OutlookAccount, PlatformAccount } from "./types";

export interface MailboxHealth {
  state:
    | "missing"
    | "disabled"
    | "reauth_required"
    | "error"
    | "unchecked"
    | "stale"
    | "connected"
    | "configured"
    | "external";
  label: string;
  message: string;
  needs_attention: boolean;
  can_lookup: boolean;
  action:
    | "connect_outlook"
    | "manage_outlook"
    | "check_outlook"
    | "manage_domains"
    | null;
  account_id?: number;
  checked_at?: string;
}
type MailReference = Pick<PlatformAccount, "account_email" | "email_source">;
type OutlookHealth = Pick<
  OutlookAccount,
  | "id"
  | "email"
  | "status"
  | "auth_status"
  | "last_checked_at"
  | "last_token_attempt_at"
  | "token_refresh_status"
>;
export type VaultSummaryRow = Pick<
  PlatformAccount,
  | "id"
  | "platform_name"
  | "account_email"
  | "email_source"
  | "status"
  | "category"
  | "is_pinned"
  | "updated_at"
>;
export type EnrichedVault<T> = T & {
  mailbox: MailboxHealth;
  needs_attention: boolean;
};
export const triageStates = ["attention", "unchecked", "connected"] as const;
export type Triage = "" | (typeof triageStates)[number];

function outlookHealth(account?: OutlookHealth): MailboxHealth {
  const base = {
    needs_attention: true,
    can_lookup: false,
    action: "manage_outlook" as const,
    account_id: account?.id,
    checked_at: account?.last_checked_at || undefined,
  };
  if (!account)
    return {
      ...base,
      state: "missing",
      label: "邮箱未接入",
      message: "该邮箱尚未加入 Outlook 账号池，请导入凭据或完成微软授权。",
      action: "connect_outlook",
    };
  if (account.status !== "active")
    return {
      ...base,
      state: "disabled",
      label: "邮箱已停用",
      message: "Outlook 账号已停用，收件和自动续期暂停。请在账号池中启用。",
    };
  if (
    account.auth_status === "reauth_required" ||
    account.token_refresh_status === "reauth_required"
  )
    return {
      ...base,
      state: "reauth_required",
      label: "邮箱需重新授权",
      message: "微软授权已失效，请重新授权或更新 Refresh Token。",
    };
  if (account.token_refresh_status === "retrying")
    return {
      ...base,
      state: "error",
      label: "邮箱续期异常",
      message: "最近一次续期失败，后台将自动重试；也可以立即检查连接。",
      can_lookup: true,
      action: "check_outlook",
      checked_at: account.last_token_attempt_at || base.checked_at,
    };
  if (account.auth_status === "error")
    return {
      ...base,
      state: "error",
      label: "邮箱连接异常",
      message: "最近一次收件检查失败。请重试连接检查，持续失败时更新授权。",
      can_lookup: true,
      action: "check_outlook",
    };
  const checked = Date.parse(
    (account.last_checked_at || "").replace(" ", "T") +
      (/Z$|[+-]\d\d:\d\d$/.test(account.last_checked_at || "") ? "" : "Z"),
  );
  if (account.auth_status !== "healthy" || !Number.isFinite(checked))
    return {
      ...base,
      state: "unchecked",
      label: "邮箱待检查",
      message: "已保存 Outlook 凭据，尚未验证收件连接。请先检查连接。",
      needs_attention: false,
      can_lookup: true,
      action: "check_outlook",
    };
  if (Date.now() - checked > 24 * 60 * 60 * 1000)
    return {
      ...base,
      state: "stale",
      label: "邮箱需复查",
      message:
        "上次收件检查已超过 24 小时，请复查当前连接。自动续期成功不代表收件权限已验证。",
      needs_attention: false,
      can_lookup: true,
      action: "check_outlook",
    };
  return {
    ...base,
    state: "connected",
    label: "邮箱已连接",
    message: "最近一次收件检查成功，仅代表邮箱连接状态。",
    needs_attention: false,
    can_lookup: true,
    action: "check_outlook",
  };
}
function domainHealth(domain?: MailDomain): MailboxHealth {
  // Historical CF mail remains readable even if routing is no longer configured.
  const base = {
    needs_attention: true,
    can_lookup: true,
    action: "manage_domains" as const,
    checked_at: domain?.last_checked_at || undefined,
  };
  if (!domain)
    return {
      ...base,
      state: "missing",
      label: "收件域名未接入",
      message:
        "该域名未接入工作区，请到域名管理添加并配置邮件路由。仍可查询已保存邮件。",
    };
  if (!domain.enabled)
    return {
      ...base,
      state: "disabled",
      label: "收件域名已停用",
      message: "该收件域名已停用，请到域名管理启用。仍可查询已保存邮件。",
    };
  if (domain.dns_status === "incomplete")
    return {
      ...base,
      state: "error",
      label: "收件 DNS 待完善",
      message:
        "最近一次 DNS 检查未通过，请检查域名邮件路由。仍可查询已保存邮件。",
    };
  if (domain.dns_status !== "ready")
    return {
      ...base,
      state: "unchecked",
      label: "收件域名待检查",
      message:
        "域名已添加，尚未确认 DNS 配置。可查询已保存邮件，请检查新邮件路由。",
      needs_attention: false,
    };
  return {
    ...base,
    state: "configured",
    label: "收件 DNS 已就绪",
    message: "上次 DNS 检查通过，新邮件是否可达仍取决于 Cloudflare 邮件路由。",
    needs_attention: false,
  };
}
/** Read only health projections: never load credentials or call Microsoft while listing. */
export async function enrichVault<T extends MailReference & { status: string }>(
  env: Env,
  rows: T[],
): Promise<EnrichedVault<T>[]> {
  const [outlook, domains] = await Promise.all([
    rows.some((r) => r.email_source === "outlook")
      ? collect<OutlookHealth>(db(env), "accounts", {
          columns: [
            "id",
            "email",
            "status",
            "auth_status",
            "last_checked_at",
            "last_token_attempt_at",
            "token_refresh_status",
          ],
          order: [["id", "asc"]],
        })
      : [],
    rows.some((r) => r.email_source === "cf_domain") ? getDomains(env) : [],
  ]);
  const accounts = new Map(outlook.map((a) => [a.email.toLowerCase(), a]));
  const mailDomains = new Map(domains.map((d) => [d.domain, d]));
  return rows.map((row) => {
    const address = row.account_email.toLowerCase();
    const mailbox: MailboxHealth =
      row.email_source === "outlook"
        ? outlookHealth(accounts.get(address))
        : row.email_source === "cf_domain"
          ? domainHealth(mailDomains.get(address.split("@")[1]))
          : {
              state: "external",
              label: "外部邮箱 · 手动查收",
              message: "该邮箱来源暂不支持自动收件，请在邮箱服务商处查收。",
              needs_attention: false,
              can_lookup: false,
              action: null,
            };
    return {
      ...row,
      mailbox,
      needs_attention:
        mailbox.needs_attention || ["banned", "pending"].includes(row.status),
    };
  });
}
export function matchesTriage(
  row: EnrichedVault<{ status: string }>,
  triage: Triage,
) {
  if (triage === "attention") return row.needs_attention;
  if (triage === "unchecked")
    return ["unchecked", "stale"].includes(row.mailbox.state);
  if (triage === "connected") return row.mailbox.state === "connected";
  return true;
}
export async function vaultInventory(env: Env, where?: Filter) {
  const rows = await collect<VaultSummaryRow>(db(env), "platform_vault", {
    columns: [
      "id",
      "platform_name",
      "account_email",
      "email_source",
      "status",
      "category",
      "is_pinned",
      "updated_at",
    ],
    where,
    order: [["id", "asc"]],
  });
  return enrichVault(env, rows);
}
export function summarizePlatforms(rows: EnrichedVault<VaultSummaryRow>[]) {
  const groups = new Map<
    string,
    {
      platform_name: string;
      count: number;
      attention_count: number;
      unchecked_count: number;
      connected_count: number;
      pinned_count: number;
      sources: string[];
      categories: string[];
    }
  >();
  for (const row of rows) {
    const key = row.platform_name.toLowerCase();
    const group = groups.get(key) || {
      platform_name: row.platform_name,
      count: 0,
      attention_count: 0,
      unchecked_count: 0,
      connected_count: 0,
      pinned_count: 0,
      sources: [],
      categories: [],
    };
    group.count++;
    group.attention_count += Number(row.needs_attention);
    group.unchecked_count += Number(matchesTriage(row, "unchecked"));
    group.connected_count += Number(matchesTriage(row, "connected"));
    group.pinned_count += Number(!!row.is_pinned);
    if (!group.sources.includes(row.email_source))
      group.sources.push(row.email_source);
    if (!group.categories.includes(row.category))
      group.categories.push(row.category);
    groups.set(key, group);
  }
  return [...groups.values()];
}
