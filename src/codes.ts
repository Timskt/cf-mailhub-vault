import { extractVerificationInfo } from "./code-extractor";
import type { GraphResult } from "./graph";
import { outlookCode, type CodeResult } from "./outlook";
import { and, db, eq, now, search, update } from "./storage/client";
import type {
  CfInboxMail,
  Env,
  OutlookAccount,
  PlatformAccount,
} from "./types";
export interface CodeOptions {
  since?: string;
  sender?: string;
  keyword?: string;
}
export async function lookupCode(
  env: Env,
  address: string,
  source: string,
  options: CodeOptions = {},
): Promise<GraphResult<CodeResult>> {
  if (source === "outlook") {
    const account = await db(env).first<OutlookAccount>(
      "accounts",
      { field: "email", op: "ieq", value: address },
    );
    return account
      ? outlookCode(env, account, options)
      : {
          error: {
            code: "ACCOUNT_NOT_FOUND",
            message: "该邮箱尚未加入 Outlook 账号池",
            status: 404,
          },
        };
  }
  if (source !== "cf_domain")
    return {
      error: {
        code: "UNSUPPORTED_SOURCE",
        message: "该邮箱来源暂不支持自动取码",
        status: 400,
      },
    };
  const results = await db(env).select<CfInboxMail>("cf_inbox_mails", {
    where: and(
      eq("recipient", address),
      options.since
        ? { field: "created_at", op: "dateGte", value: options.since }
        : undefined,
      options.sender ? search(options.sender, "sender") : undefined,
      options.keyword
        ? search(options.keyword, "subject", "text_content")
        : undefined,
    ),
    order: [
      ["created_at", "desc"],
      ["id", "desc"],
    ],
    limit: 25,
  });
  for (const mail of results) {
    const extracted = extractVerificationInfo(
      mail.subject,
      mail.text_content,
      mail.html_content,
    );
    const code = mail.verification_code || extracted.code,
      link = mail.verification_link || extracted.link;
    if (code || link)
      return {
        data: {
          has_mail: true,
          code,
          link,
          subject: mail.subject,
          sender: mail.sender,
          received_at: mail.created_at,
          mail_id: String(mail.id),
          scanned: results.length,
          checked_at: new Date().toISOString(),
          message: "已找到最新匹配的验证码或验证链接",
        },
      };
  }
  return {
    data: {
      has_mail: results.length > 0,
      code: "",
      link: "",
      scanned: results.length,
      checked_at: new Date().toISOString(),
      limited: results.length === 25,
      message: results.length
        ? "近期邮件中未找到验证码或验证链接"
        : "指定条件下尚无邮件",
    },
  };
}
export async function updateVaultCode(
  env: Env,
  account: PlatformAccount,
  result: CodeResult,
) {
  if (result.code)
    await db(env).mutate([
      update("platform_vault", eq("id", account.id), {
        last_code: result.code,
        last_code_at: result.received_at || now(),
        updated_at: now(),
      }),
    ]);
}
