import type { Vault } from "./types";

export const mailboxSources: [string, string][] = [
  ["cf_domain", "自建域名"],
  ["outlook", "Outlook"],
  ["mailtm", "Mail.tm"],
  ["mailgw", "Mail.gw"],
  ["external", "外部邮箱"],
  ["gptmail", "GPTMail（手动查收）"],
];
export const sourceName = (source: string) =>
  mailboxSources.find(([id]) => id === source)?.[1] || source;
export const identityPath = ({
  address,
  source,
}: {
  address: string;
  source: string;
}) =>
  `/api/mailbox-identities/${encodeURIComponent(`${source}:${address.trim().toLowerCase()}`)}`;
export const registrationMailbox = (
  account: Pick<Vault, "account_email" | "email_source" | "mailbox_address">,
) => ({
  address: account.mailbox_address || account.account_email,
  source: account.email_source,
});
export const loginMethodChoices = [
  ["password", "密码登录"],
  ["google", "Google"],
  ["microsoft", "Microsoft"],
  ["sso", "SSO"],
  ["magic_link", "邮件登录链接"],
  ["passkey", "通行密钥"],
  ["unknown", "未知"],
] as const;
export function loginMethods(value?: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value || '["unknown"]');
    if (Array.isArray(parsed)) {
      const known = loginMethodChoices.map(([id]) => id as string);
      const values = parsed.filter(
        (item): item is string =>
          typeof item === "string" && known.includes(item),
      );
      if (values.length) return [...new Set(values)];
    }
  } catch {
    /* Older registrations may not contain structured login methods. */
  }
  return ["unknown"];
}
export const loginMethodLabel = (value?: string) =>
  loginMethods(value)
    .map(
      (method) =>
        loginMethodChoices.find(([id]) => id === method)?.[1] || method,
    )
    .join(" · ");
