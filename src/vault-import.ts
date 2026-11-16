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
] as const;
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
    status: choice(body.status, "账号状态", vaultStatuses, "active"),
    category: text(body.category, "分类", 100, "其他"),
    proxy_node: text(body.proxy_node, "节点", 300),
    remark: text(body.remark, "备注", 4000),
    is_pinned: body.is_pinned ? 1 : 0,
  };
}
export type VaultImportAccount = ReturnType<typeof validateVaultAccount>;
export function vaultIdentity(
  a: Pick<VaultImportAccount, "platform_name" | "account_email" | "username">,
) {
  return `${a.platform_name.toLowerCase()}\0${a.account_email}\0${a.username}`;
}
const aliases: Record<string, string> = {
  平台: "platform_name",
  平台名称: "platform_name",
  platform: "platform_name",
  邮箱: "account_email",
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
  "2fa": "totp_secret",
  "2fa密钥": "totp_secret",
  "2FA": "totp_secret",
  代理: "proxy_node",
  节点: "proxy_node",
  备注: "remark",
  置顶: "is_pinned",
};
export function parseVaultImport(raw: unknown, platform = "") {
  const content = text(raw, "导入内容", 1024 * 1024).replace(/^\uFEFF/, "");
  if (new TextEncoder().encode(content).byteLength > 1024 * 1024)
    invalid("导入内容超过 1 MiB");
  if (!content.trim()) invalid("请粘贴账号或选择文件");
  const fallback = text(platform, "默认平台", 100).trim();
  let values: { line: number; value: unknown }[];
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
      header.every((v) =>
        [...vaultColumns, "is_pinned"].includes(
          v as (typeof vaultColumns)[number],
        ),
      );
    if (hasHeader) {
      if (new Set(header).size !== header.length)
        invalid("表头字段重复，请删除重复列后重新导入");
      columns = header;
      rows.shift();
    } else if (fallback && rows[0]?.values[0].includes("@"))
      columns = vaultColumns.filter((c) => c !== "platform_name");
    values = rows.map((row) => ({
      line: row.line,
      value:
        row.values.length > columns.length ||
        (hasHeader && row.values.length !== columns.length)
          ? {
              __error:
                "字段数量与格式不一致；空字段保留分隔符，含分隔符的字段请使用双引号",
            }
          : Object.fromEntries(
              columns.map((col, i) => [col, row.values[i] ?? ""]),
            ),
    }));
  }
  if (!values.length || values.length > 200)
    invalid("每批请提供 1–200 条账号记录");
  const unique = new Map<string, VaultImportAccount>();
  const rows = values.map(({ value, line }) => {
    try {
      const input = { ...object(value) };
      if (input.__error) invalid(String(input.__error));
      input.platform_name ||= fallback;
      input.account_email ??= input.email;
      input.email_source ||= /@(outlook|hotmail|live|msn)\./i.test(
        String(input.account_email),
      )
        ? "outlook"
        : "external";
      input.status ||= "active";
      input.category ||= "其他";
      if (typeof input.is_pinned === "string") {
        if (!["", "0", "1", "true", "false"].includes(input.is_pinned))
          invalid("置顶状态无效");
        input.is_pinned = ["1", "true"].includes(input.is_pinned) ? 1 : 0;
      }
      const account = validateVaultAccount(input);
      const key = vaultIdentity(account),
        duplicate = unique.has(key);
      unique.set(key, account);
      return {
        line,
        platform_name: account.platform_name,
        account_email: account.account_email,
        username: account.username,
        duplicate,
      };
    } catch (error) {
      return {
        line,
        error: error instanceof Error ? error.message : "账号格式无效",
      };
    }
  });
  return {
    accounts: [...unique.values()],
    rows,
    valid_count: unique.size,
    error_count: rows.filter((r) => "error" in r).length,
    duplicate_count: rows.filter((r) => r.duplicate).length,
  };
}
