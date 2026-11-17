import { parseDelimited } from "../shared/account-text";
import { choice, email, httpUrl, invalid, object, text } from "./validation";

export const vaultSources = [
  "cf_domain",
  "outlook",
  "gptmail",
  "mailtm",
  "mailgw",
  "external",
] as const;
export const vaultStatuses = [
  "active",
  "pending",
  "banned",
  "deprecated",
] as const;
export const vaultLoginMethods = [
  "password",
  "google",
  "microsoft",
  "sso",
  "magic_link",
  "passkey",
  "unknown",
] as const;
// The first eleven positions are the legacy TXT format. Append new columns;
// never insert them ahead of credentials or notes from an existing export.
export const vaultColumns = [
  "platform_name",
  "account_email",
  "password",
  "username",
  "email_source",
  "category",
  "status",
  "platform_url",
  "totp_secret",
  "proxy_node",
  "remark",
  "workspace",
  "account_identifier",
  "login_methods",
  "mailbox_address",
  "mailbox_link_state",
  "verification_sender",
  "verification_keyword",
  "registered_at",
  "last_verified_at",
  "expires_at",
] as const;
const importFields = [...vaultColumns, "is_pinned"] as const;
const columnCountError =
  "字段数量与格式不一致；空字段保留分隔符，含分隔符的字段请使用双引号";
export type VaultImportField = (typeof importFields)[number];
export type VaultImportMode = "merge" | "replace";

export function providedVaultFields(
  input: Record<string, unknown>,
): VaultImportField[] {
  return [
    ...new Set(
      Object.keys(input)
        .map((field) =>
          field === "email" && input.account_email === undefined
            ? "account_email"
            : field,
        )
        .filter((field): field is VaultImportField =>
          importFields.includes(field as VaultImportField),
        ),
    ),
  ];
}

function loginMethods(value: unknown): string {
  if (value === undefined || value === "") return '["unknown"]';
  let methods: unknown = value;
  if (typeof value === "string") {
    try {
      methods = JSON.parse(text(value, "登录方式", 1000));
    } catch {
      invalid("登录方式必须是有效的 JSON 数组");
    }
  }
  if (
    !Array.isArray(methods) ||
    methods.some(
      (method) =>
        typeof method !== "string" ||
        !vaultLoginMethods.includes(
          method as (typeof vaultLoginMethods)[number],
        ),
    )
  )
    invalid("登录方式必须是受支持的登录方式数组");
  return JSON.stringify(
    methods.length ? [...new Set(methods)].sort() : ["unknown"],
  );
}

function optionalTimestamp(value: unknown, name: string): string {
  const input = text(value, name, 40).trim();
  if (!input) return "";
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/i.exec(
      input,
    );
  if (!match) invalid(`${name} 请使用带时区的 ISO 8601 时间`);
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] =
    match;
  const y = Number(year),
    m = Number(month),
    d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    m < 1 ||
    m > 12 ||
    d < 1 ||
    d > days[m - 1] ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    Number(offsetHour || 0) > 23 ||
    Number(offsetMinute || 0) > 59 ||
    !Number.isFinite(Date.parse(input))
  )
    invalid(`${name} 请使用有效的 ISO 8601 时间`);
  return new Date(input).toISOString();
}

export function validateVaultAccount(input: unknown) {
  const body = object(input);
  const name = text(body.platform_name, "平台名称", 100).trim();
  if (!name) invalid("平台名称不能为空");
  if (
    body.is_pinned !== undefined &&
    ![0, 1, false, true].includes(body.is_pinned as number)
  )
    invalid("置顶状态无效");
  return {
    platform_name: name,
    platform_url: httpUrl(body.platform_url),
    account_email: email(body.account_email),
    email_source: choice(
      body.email_source,
      "邮箱来源",
      vaultSources,
      "cf_domain",
    ),
    username: text(body.username, "用户名", 254),
    password: text(body.password, "密码", 1000),
    totp_secret: text(body.totp_secret, "2FA", 1000),
    workspace: text(body.workspace, "工作区", 100),
    account_identifier: text(body.account_identifier, "账号标识", 200),
    login_methods: loginMethods(body.login_methods),
    mailbox_address:
      body.mailbox_address === undefined || body.mailbox_address === ""
        ? ""
        : email(body.mailbox_address),
    mailbox_link_state: choice(
      body.mailbox_link_state === "" ? undefined : body.mailbox_link_state,
      "邮箱关联状态",
      ["auto", "detached"] as const,
      "auto",
    ),
    verification_sender: text(body.verification_sender, "验证发件人", 254),
    verification_keyword: text(body.verification_keyword, "验证关键词", 200),
    registered_at: optionalTimestamp(body.registered_at, "注册时间"),
    last_verified_at: optionalTimestamp(body.last_verified_at, "最后核验时间"),
    expires_at: optionalTimestamp(body.expires_at, "到期时间"),
    status: choice(body.status, "账号状态", vaultStatuses, "active"),
    category: text(body.category, "分类", 100, "其他"),
    proxy_node: text(body.proxy_node, "节点", 300),
    remark: text(body.remark, "备注", 4000),
    is_pinned: body.is_pinned ? 1 : 0,
  };
}
export type VaultImportAccount = ReturnType<typeof validateVaultAccount>;
export function vaultIdentity(
  a: Pick<VaultImportAccount, "platform_name" | "account_email" | "username"> &
    Partial<
      Pick<
        VaultImportAccount,
        "email_source" | "workspace" | "account_identifier" | "login_methods"
      >
    >,
) {
  // JSON tuples also distinguish embedded separators in user-supplied IDs.
  return JSON.stringify([
    a.platform_name.toLowerCase(),
    a.account_email.toLowerCase(),
    a.username,
    a.email_source ?? "cf_domain",
    a.workspace ?? "",
    a.account_identifier ?? "",
    loginMethods(a.login_methods),
  ]);
}

/** Merge normalized import data without treating parser defaults as a patch. */
export function mergeVaultImport(
  prior: Partial<VaultImportAccount> | undefined,
  incoming: VaultImportAccount,
  provided_fields?: readonly VaultImportField[],
  mode: VaultImportMode = "merge",
): VaultImportAccount {
  choice(mode, "导入更新方式", ["merge", "replace"] as const);
  if (!prior || mode === "replace") return validateVaultAccount(incoming);
  const fields =
    provided_fields ??
    importFields.filter((field) => Object.hasOwn(incoming, field));
  const merged = { ...prior };
  for (const field of fields) {
    if (!importFields.includes(field)) invalid("导入字段无效");
    if (Object.hasOwn(incoming, field))
      Object.assign(merged, { [field]: incoming[field] });
  }
  return validateVaultAccount(merged);
}

export interface VaultImportRow {
  line: number;
  platform_name?: string;
  account_email?: string;
  username?: string;
  duplicate?: boolean;
  provided_fields?: VaultImportField[];
  error?: string;
}

export interface VaultImportSummary {
  accounts: VaultImportAccount[];
  rows: VaultImportRow[];
  /** Internal alignment for preview actions; only the final duplicate is written. */
  account_lines: number[];
  /** Aligned with deduplicated accounts; the last occurrence wins. */
  provided_fields?: VaultImportField[][];
  valid_count: number;
  error_count: number;
  duplicate_count: number;
}

const aliases: Record<string, string> = {
  平台: "platform_name",
  平台名称: "platform_name",
  platform: "platform_name",
  邮箱: "account_email",
  账号邮箱: "account_email",
  登录邮箱: "account_email",
  email: "account_email",
  密码: "password",
  用户名: "username",
  邮箱来源: "email_source",
  来源: "email_source",
  分类: "category",
  状态: "status",
  官网: "platform_url",
  平台官网: "platform_url",
  平台地址: "platform_url",
  "2fa": "totp_secret",
  "2fa密钥": "totp_secret",
  "2FA": "totp_secret",
  "totp 密钥": "totp_secret",
  代理: "proxy_node",
  节点: "proxy_node",
  代理节点: "proxy_node",
  备注: "remark",
  置顶: "is_pinned",
  工作区: "workspace",
  账号标识: "account_identifier",
  登录方式: "login_methods",
  收件邮箱: "mailbox_address",
  邮箱关联状态: "mailbox_link_state",
  验证发件人: "verification_sender",
  验证关键词: "verification_keyword",
  注册时间: "registered_at",
  最后核验时间: "last_verified_at",
  到期时间: "expires_at",
};
export function parseVaultImport(
  raw: unknown,
  platform = "",
): VaultImportSummary {
  const content = text(raw, "导入内容", 1024 * 1024).replace(/^\uFEFF/, "");
  if (new TextEncoder().encode(content).byteLength > 1024 * 1024)
    invalid("导入内容超过 1 MiB");
  if (!content.trim()) invalid("请粘贴账号或选择文件");
  const fallback = text(platform, "默认平台", 100).trim();
  let values: { line: number; value: unknown; error?: string }[];
  if (/^\s*[\[{]/.test(content)) {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return invalid("JSON 格式无效");
    }
    const entries = Array.isArray(parsed)
      ? parsed
      : (object(parsed).accounts ?? [parsed]);
    if (!Array.isArray(entries)) invalid("accounts 必须是数组");
    values = entries.map((value, i) => ({ value, line: i + 1 }));
  } else {
    const cleaned = content.replace(
      /^导出内容\s*[（(]\s*格式\s*[：:]\s*(.*?)\s*[）)]\s*$/m,
      "$1",
    );
    const first =
      cleaned
        .split(/\r?\n/)
        .find((line) => line.trim() && !/^\s*(#|\/\/)/.test(line)) || "";
    const delimiter = ["----", "\t", ",", "::", "|"].find((v) =>
      first.includes(v),
    );
    if (!delimiter) invalid("请使用 平台----邮箱----密码，或带表头的 CSV");
    let records;
    try {
      records = parseDelimited(cleaned, delimiter);
    } catch {
      return invalid("分隔符或引号格式无效，请检查字段是否正确闭合");
    }
    const rows = records.filter(
      (r) =>
        r.values.some((v) => v.trim()) && !/^\s*(#|\/\/)/.test(r.values[0]),
    );
    let columns: readonly string[] = vaultColumns;
    const header = rows[0]?.values.map(
      (v) => aliases[v.trim().toLowerCase()] || v.trim().toLowerCase(),
    );
    const hasHeader =
      header?.includes("account_email") &&
      header.every((v) => importFields.includes(v as VaultImportField));
    if (hasHeader) {
      if (new Set(header).size !== header.length)
        invalid("表头字段重复，请删除重复列后重新导入");
      columns = header;
      rows.shift();
    } else if (fallback && rows[0]?.values[0].includes("@"))
      columns = vaultColumns.filter((c) => c !== "platform_name");
    values = rows.map((row) => ({
      line: row.line,
      error:
        row.values.length > columns.length ||
        (hasHeader && row.values.length !== columns.length)
          ? columnCountError
          : undefined,
      value: Object.fromEntries(
        row.values
          .slice(0, columns.length)
          .map((value, i) => [columns[i], value]),
      ),
    }));
  }
  if (!values.length || values.length > 200)
    invalid("每批请提供 1–200 条账号记录");
  const unique = new Map<
    string,
    {
      account: VaultImportAccount;
      provided_fields: VaultImportField[];
      line: number;
    }
  >();
  const rows: VaultImportRow[] = values.map(
    ({ value, line, error: parseError }) => {
      let provided_fields: VaultImportField[] | undefined;
      try {
        const input = { ...object(value) };
        // Capture ownership before adding aliases, fallback values or defaults.
        provided_fields = providedVaultFields(input);
        if (parseError) invalid(parseError);
        input.platform_name ??= fallback;
        input.account_email ??= input.email;
        input.email_source ??= /@(outlook|hotmail|live|msn)\./i.test(
          String(input.account_email),
        )
          ? "outlook"
          : "external";
        if (typeof input.is_pinned === "string") {
          if (!["", "0", "1", "true", "false"].includes(input.is_pinned))
            invalid("置顶状态无效");
          input.is_pinned = ["1", "true"].includes(input.is_pinned) ? 1 : 0;
        }
        const account = validateVaultAccount(input);
        const key = vaultIdentity(account),
          duplicate = unique.has(key);
        unique.set(key, { account, provided_fields, line });
        return {
          line,
          platform_name: account.platform_name,
          account_email: account.account_email,
          username: account.username,
          duplicate,
          provided_fields,
        };
      } catch (error) {
        return {
          line,
          ...(provided_fields ? { provided_fields } : {}),
          error: error instanceof Error ? error.message : "账号格式无效",
        };
      }
    },
  );
  return {
    accounts: [...unique.values()].map((entry) => entry.account),
    rows,
    account_lines: [...unique.values()].map((entry) => entry.line),
    provided_fields: [...unique.values()].map((entry) => entry.provided_fields),
    valid_count: unique.size,
    error_count: rows.filter((r) => r.error !== undefined).length,
    duplicate_count: rows.filter((r) => r.duplicate).length,
  };
}
