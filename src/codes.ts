import { isMailProvider, type ProviderAccount } from "../shared/mail-providers";
import { providerCode, ProviderError } from "./mail-providers";
import { extractVerificationInfo } from "./code-extractor";
import type { GraphResult } from "./graph";
import { deliveryAddress } from "../shared/registrations";
import { StorageError } from "./storage/model";
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
  match?: "platform" | "mailbox";
}
export async function lookupVaultCode(
  env: Env,
  account: PlatformAccount,
  options: CodeOptions = {},
) {
  if (account.mailbox_link_state === "detached")
    throw new StorageError(
      "MAILBOX_DETACHED",
      "此平台注册已解除收件连接；请先重新关联。",
      409,
    );
  const mode = options.match || "mailbox";
  const sender = options.sender || account.verification_sender || "";
  const keyword = options.keyword || account.verification_keyword || "";
  if (mode === "platform" && !sender && !keyword)
    throw new StorageError(
      "VERIFICATION_RULE_REQUIRED",
      "尚未配置此平台的发件人或关键词；请配置规则，或明确选择查整个邮箱。",
      409,
    );
  const result = await lookupCode(
    env,
    deliveryAddress(account),
    account.email_source,
    mode === "platform" ? { ...options, sender, keyword } : options,
  );
  if (result.data) {
    result.data.match_scope = mode;
    result.data.match_reason =
      mode === "platform"
        ? [sender && `发件人包含 ${sender}`, keyword && `关键词 ${keyword}`]
            .filter(Boolean)
            .join("；")
        : "邮箱范围查询，未确认属于此平台";
    if (mode === "platform") await updateVaultCode(env, account, result.data);
  }
  return result;
}
export async function lookupCode(
  env: Env,
  address: string,
  source: string,
  options: CodeOptions = {},
): Promise<GraphResult<CodeResult>> {
  if (source === "outlook") {
    const account = await db(env).first<OutlookAccount>("accounts", {
      field: "email",
      op: "ieq",
      value: address,
    });
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
  if (isMailProvider(source)) {
    const account = await db(env).first<ProviderAccount>(
      "provider_accounts",
      and(eq("provider", source), {
        field: "address",
        op: "ieq",
        value: address,
      }),
    );
    if (!account)
      return {
        error: {
          code: "PROVIDER_ACCOUNT_NOT_FOUND",
          message: "该邮箱尚未接入，请在外部邮箱中添加账号",
          status: 404,
        },
      };
    try {
      return { data: await providerCode(env, account, options) };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      return {
        error: {
          code: error.code,
          message: error.message,
          status: error.status,
        },
      };
    }
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
      {
        op: "assertExists",
        table: "platform_vault",
        where: and(
          eq("id", account.id),
          eq("updated_at", account.updated_at),
          eq("platform_name", account.platform_name),
          eq("account_email", account.account_email),
          eq("email_source", account.email_source),
          eq("mailbox_address", account.mailbox_address || ""),
          eq("mailbox_link_state", account.mailbox_link_state || "auto"),
          eq("verification_sender", account.verification_sender || ""),
          eq("verification_keyword", account.verification_keyword || ""),
        ),
        message: "查询期间平台注册或收件规则已发生变化，请重新查收",
      },
      update("platform_vault", eq("id", account.id), {
        last_code: result.code,
        last_code_at: result.received_at || now(),
        updated_at: now(),
      }),
    ]);
}
