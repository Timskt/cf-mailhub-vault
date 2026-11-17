import { extractVerificationInfo } from "./code-extractor";
import {
  fetchEmails,
  getAccessToken,
  replyMessage,
  sendMail,
  validMessageId,
  type GraphError,
  type GraphMailMessage,
  type GraphResult,
  type OutgoingAttachment,
  type ReplyMailInput,
  type SendMailInput,
} from "./graph";
import { and, db, eq, now, update } from "./storage/client";
import type { Env, OutlookAccount } from "./types";
import { invalid, object, text } from "./validation";

export const TOKEN_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REAUTH_ERRORS = new Set([
  "invalid_grant",
  "interaction_required",
  "consent_required",
  "login_required",
]);
export async function refreshOutlookToken(env: Env, account: OutlookAccount) {
  if (account.status !== "active")
    return {
      error: {
        code: "ACCOUNT_DISABLED",
        message: "该账号已停用，请先启用",
        status: 409,
      },
      currentToken: account.refresh_token,
      saved: false,
    };
  const secret =
    account.client_id === env.MICROSOFT_CLIENT_ID
      ? env.MICROSOFT_CLIENT_SECRET
      : undefined;
  const refreshed = await getAccessToken(
    account.client_id,
    account.refresh_token,
    secret,
  );
  const timestamp = new Date().toISOString();
  const failure = refreshed.error;
  const failures = failure ? (account.token_refresh_failures || 0) + 1 : 0;
  const needsAuth = !!failure && REAUTH_ERRORS.has(failure.code);
  const retryDelay = Math.min(
    TOKEN_REFRESH_INTERVAL_MS,
    15 * 60 * 1000 * 2 ** Math.min(failures - 1, 5),
  );
  const currentToken = refreshed.newRefreshToken || account.refresh_token;
  const [saved] = await db(env).mutate([
    update(
      "accounts",
      and(
        eq("id", account.id),
        eq("client_id", account.client_id),
        eq("refresh_token", account.refresh_token),
        eq("status", "active"),
      ),
      {
        refresh_token: currentToken,
        last_token_attempt_at: timestamp,
        next_token_refresh_at: needsAuth
          ? ""
          : new Date(
              Date.now() + (failure ? retryDelay : TOKEN_REFRESH_INTERVAL_MS),
            ).toISOString(),
        token_refresh_failures: failures,
        token_refresh_status: needsAuth
          ? "reauth_required"
          : failure
            ? "retrying"
            : "healthy",
        token_refresh_error: failure
          ? `${failure.code}: ${failure.message}`
          : "",
        ...(!failure ? { last_token_refresh_at: timestamp } : {}),
        ...(currentToken !== account.refresh_token
          ? { updated_at: timestamp }
          : {}),
        ...(needsAuth
          ? {
              auth_status: "reauth_required",
              last_error: failure!.message,
              last_error_code: failure!.code,
            }
          : {}),
      },
    ),
  ]);
  return { ...refreshed, currentToken, saved: saved.changes > 0 };
}

export async function withOutlook<T>(
  env: Env,
  account: OutlookAccount,
  action: (
    token: string,
    scopes?: readonly string[],
  ) => Promise<GraphResult<T>>,
  options: { sideEffect?: boolean } = {},
): Promise<GraphResult<T>> {
  if (account.status !== "active")
    return {
      error: {
        code: "ACCOUNT_DISABLED",
        message: "该账号已停用，请先启用",
        status: 409,
      },
    };
  const refreshed = await refreshOutlookToken(env, account);
  // Do not send with credentials from an account that was changed/disabled during refresh.
  if (options.sideEffect && !refreshed.error && !refreshed.saved)
    return {
      error: {
        code: "ACCOUNT_CHANGED",
        message: "账号在刷新授权期间发生变更，本次未发送，请重新加载账号后操作",
        status: 409,
      },
    };
  const result: GraphResult<T> =
    refreshed.error || !refreshed.token
      ? {
          error: refreshed.error || {
            code: "TOKEN_FAILED",
            message: "未获得有效访问令牌",
          },
        }
      : await action(refreshed.token, refreshed.scopes);
  // A concurrent import/edit or token rotation must not be overwritten by an older request.
  if (
    // After a non-idempotent action, a health write failure must not turn acceptance
    // into an HTTP 500 (and invite a duplicate send). Refresh state was saved above.
    // Missing send permission also says nothing about the existing read capability.
    !options.sideEffect &&
    refreshed.saved &&
    !["INVALID_QUERY", "ErrorItemNotFound", "HTTP_404"].includes(
      result.error?.code || "",
    )
  ) {
    const error = result.error;
    const status = error
      ? REAUTH_ERRORS.has(refreshed.error?.code || "")
        ? "reauth_required"
        : "error"
      : "healthy";
    await db(env).mutate([
      update(
        "accounts",
        and(
          eq("id", account.id),
          eq("client_id", account.client_id),
          eq("refresh_token", refreshed.currentToken),
          eq("status", "active"),
        ),
        {
          auth_status: status,
          last_checked_at: now(),
          last_error: error?.message || "",
          last_error_code: error?.code || "",
        },
      ),
    ]);
  }
  return result;
}

export const OUTLOOK_SEND_LIMITS = {
  subject_chars: 255,
  body_chars: 100_000,
  recipients: 100,
  attachments: 10,
  attachment_bytes: 3 * 1024 * 1024,
  request_bytes: 5 * 1024 * 1024,
  attempts_per_minute: 10,
  attempts_per_quarter_hour: 60,
} as const;
export async function reserveOutlookSend(
  env: Env,
  account: OutlookAccount,
): Promise<GraphError | undefined> {
  if (account.status !== "active") return undefined;
  const time = Math.floor(Date.now() / 1000);
  const counters = await db(env).mutate([
    {
      op: "throttle",
      identity: `send:minute:${account.id}`,
      time,
      windowSeconds: 60,
    },
    {
      op: "throttle",
      identity: `send:quarter:${account.id}`,
      time,
      windowSeconds: 900,
    },
  ]);
  const limits = [
    OUTLOOK_SEND_LIMITS.attempts_per_minute,
    OUTLOOK_SEND_LIMITS.attempts_per_quarter_hour,
  ];
  const blocked = counters
    .map((result, index) => ({ row: result.rows[0], limit: limits[index] }))
    .filter(({ row, limit }) => Number(row.attempts) > limit);
  if (blocked.length)
    return {
      code: "SEND_RATE_LIMITED",
      status: 429,
      message: "此邮箱的发送尝试过于频繁，请等待后再操作",
      retry_after: Math.max(
        ...blocked.map(({ row }) => Number(row.reset_at) - time),
      ),
    };
}
export const OUTLOOK_ATTACHMENT_TYPES: Readonly<Record<string, string>> = {
  txt: "text/plain",
  csv: "text/csv",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};
function onlyFields(value: unknown, fields: readonly string[], label: string) {
  const data = object(value);
  if (Object.keys(data).some((key) => !fields.includes(key)))
    invalid(`${label}包含不支持的字段`);
  return data;
}
function recipients(
  value: unknown,
  name: string,
  required = false,
): string[] | undefined {
  if (value === undefined && !required) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > OUTLOOK_SEND_LIMITS.recipients ||
    (required && !value.length)
  )
    invalid(`${name}须为邮箱地址数组，收件人合计为 1–100 个`);
  return value.map((item) => {
    const raw = text(item, name, 254);
    const email = raw.trim();
    const parts = email.split("@");
    const local = parts[0],
      domain = parts[1] || "";
    if (
      /[\x00-\x1f\x7f-\x9f]/.test(raw) ||
      parts.length !== 2 ||
      local.length > 64 ||
      !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/i.test(local) ||
      local.startsWith(".") ||
      local.endsWith(".") ||
      local.includes("..") ||
      !domain.includes(".") ||
      domain
        .split(".")
        .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    )
      invalid(`${name}含无效的邮箱地址`);
    return `${local}@${domain.toLowerCase()}`;
  });
}
function outgoingBody(value: unknown) {
  const body = text(value, "邮件正文", OUTLOOK_SEND_LIMITS.body_chars);
  if (!body.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(body))
    invalid("邮件正文须为非空纯文本，不能包含控制字符");
  return body;
}
function outgoingAttachments(value: unknown): OutgoingAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > OUTLOOK_SEND_LIMITS.attachments)
    invalid("附件须为数组，最多 10 个文件");
  let total = 0;
  return value.map((item) => {
    const data = onlyFields(
      item,
      ["name", "content_type", "content_base64"],
      "附件",
    );
    const name = text(data.name, "附件文件名", 255);
    if (
      !name ||
      name !== name.trim() ||
      name.startsWith(".") ||
      name.endsWith(".") ||
      /[\x00-\x1f\x7f-\x9f/\\:<>"|?*\u202a-\u202e\u2066-\u2069]/.test(name) ||
      new TextEncoder().encode(name).length > 255
    )
      invalid("附件文件名无效，不能包含路径或控制字符");
    const content_type = text(
      data.content_type,
      "附件 MIME 类型",
      128,
    ).toLowerCase();
    const extension = name.split(".").at(-1)!.toLowerCase();
    if (
      !Object.hasOwn(OUTLOOK_ATTACHMENT_TYPES, extension) ||
      content_type !== OUTLOOK_ATTACHMENT_TYPES[extension]
    )
      invalid("附件文件扩展名和 MIME 类型须匹配支持的文档、图片或 ZIP 类型");
    const content_base64 = text(
      data.content_base64,
      "附件 Base64",
      4 * Math.ceil(OUTLOOK_SEND_LIMITS.attachment_bytes / 3),
    );
    const padding = content_base64.endsWith("==")
      ? 2
      : content_base64.endsWith("=")
        ? 1
        : 0;
    const bytes = (content_base64.length / 4) * 3 - padding;
    if (
      !content_base64 ||
      content_base64.length % 4 !== 0 ||
      bytes <= 0 ||
      /[^A-Za-z0-9+/]/.test(
        content_base64.slice(0, content_base64.length - padding),
      )
    )
      invalid("附件须提供完整的标准 Base64 文件内容");
    total += bytes;
    if (total > OUTLOOK_SEND_LIMITS.attachment_bytes)
      invalid("附件解码后总大小不能超过 3 MiB");
    // Canonical encoding rejects truncated data and non-zero padding bits.
    try {
      if (btoa(atob(content_base64)) !== content_base64)
        invalid("附件 Base64 内容无效");
    } catch {
      invalid("附件 Base64 内容无效");
    }
    return { name, content_type, content_base64 };
  });
}
export function validateOutlookSend(value: unknown): SendMailInput {
  const input = onlyFields(
    value,
    ["to", "cc", "bcc", "subject", "body", "attachments"],
    "邮件",
  );
  const to = recipients(input.to, "收件人", true)!;
  const cc = recipients(input.cc, "抄送"),
    bcc = recipients(input.bcc, "密送");
  if (
    to.length + (cc?.length || 0) + (bcc?.length || 0) >
    OUTLOOK_SEND_LIMITS.recipients
  )
    invalid("收件人、抄送和密送合计不能超过 100 个");
  const subject = text(
    input.subject,
    "邮件主题",
    OUTLOOK_SEND_LIMITS.subject_chars,
  );
  if (!subject.trim() || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(subject))
    invalid("邮件主题须为非空单行文本");
  return {
    to,
    cc,
    bcc,
    subject,
    body: outgoingBody(input.body),
    attachments: outgoingAttachments(input.attachments),
  };
}
export function validateOutlookReply(value: unknown): ReplyMailInput {
  const input = onlyFields(value, ["body", "attachments"], "回复");
  return {
    body: outgoingBody(input.body),
    attachments: outgoingAttachments(input.attachments),
  };
}
export async function sendOutlookMail(
  env: Env,
  account: OutlookAccount,
  value: unknown,
) {
  const input = validateOutlookSend(value);
  const error = await reserveOutlookSend(env, account);
  if (error) return { error };
  return withOutlook(
    env,
    account,
    (token, scopes) => sendMail(token, input, scopes),
    { sideEffect: true },
  );
}
export async function replyOutlookMail(
  env: Env,
  account: OutlookAccount,
  messageId: string,
  value: unknown,
) {
  if (!validMessageId(messageId)) invalid("邮件 ID 无效");
  const input = validateOutlookReply(value);
  const error = await reserveOutlookSend(env, account);
  if (error) return { error };
  return withOutlook(
    env,
    account,
    (token, scopes) => replyMessage(token, messageId, input, scopes),
    { sideEffect: true },
  );
}

export interface CodeResult {
  match_scope?: "platform" | "mailbox";
  match_reason?: string;
  has_mail: boolean;
  code: string;
  link: string;
  message: string;
  subject?: string;
  sender?: string;
  received_at?: string;
  mail_id?: string;
  scanned?: number;
  checked_at?: string;
  limited?: boolean;
}
export function selectCode(
  mails: GraphMailMessage[],
  options: { since?: string; sender?: string } = {},
): CodeResult {
  const sorted = [...new Map(mails.map((m) => [m.id, m])).values()]
    .filter(
      (m) =>
        (!options.since ||
          Date.parse(m.receivedDateTime || "") >= Date.parse(options.since)) &&
        (!options.sender ||
          (m.from?.emailAddress?.address || "")
            .toLowerCase()
            .includes(options.sender.toLowerCase())),
    )
    .sort(
      (a, b) =>
        (Date.parse(b.receivedDateTime || "") || 0) -
        (Date.parse(a.receivedDateTime || "") || 0),
    );
  for (const mail of sorted) {
    const info = extractVerificationInfo(
      mail.subject || "",
      mail.bodyPreview || "",
      mail.body?.content || "",
    );
    if (info.code || info.link)
      return {
        has_mail: true,
        ...info,
        subject: mail.subject,
        sender: mail.from?.emailAddress?.address,
        received_at: mail.receivedDateTime,
        mail_id: mail.id,
        scanned: sorted.length,
        message: info.code ? "已找到最新匹配的验证码" : "已找到验证链接",
      };
  }
  return {
    has_mail: sorted.length > 0,
    code: "",
    link: "",
    scanned: sorted.length,
    message: sorted.length
      ? `已检查 ${sorted.length} 封邮件，未匹配到验证码或验证链接`
      : "指定条件下尚无邮件",
  };
}
export async function outlookCode(
  env: Env,
  account: OutlookAccount,
  options: { since?: string; sender?: string; keyword?: string } = {},
): Promise<GraphResult<CodeResult>> {
  return withOutlook(env, account, async (token) => {
    const folders = ["inbox", "junkemail"] as const;
    const pages = await Promise.all(
      folders.map((folder) =>
        fetchEmails(token, {
          folder,
          top: 10,
          includeBody: true,
          keyword: options.keyword,
          since: options.since,
        }),
      ),
    );
    const error = pages.find((p) => p.error)?.error;
    // Do not report an empty mailbox when Microsoft actually failed.
    if (error) return { error };
    const items = pages.flatMap((p) => p.data?.items || []);
    let found = selectCode(items, options);
    // Only read older pages if they can still contain a newer matching result.
    // Each folder stays within the previous 25-message budget; the usual path reads just 20.
    const extra = await Promise.all(
      pages.map(async (page, index) => {
        if (!page.data?.nextLink) return { data: { items: [] } };
        const oldest = Math.min(
          ...page.data.items.map((m) => Date.parse(m.receivedDateTime || "")),
        );
        if (
          Number.isFinite(oldest) &&
          ((found.received_at && oldest < Date.parse(found.received_at)) ||
            (options.since && oldest < Date.parse(options.since)))
        )
          return { data: { items: [] } };
        const next = new URL(page.data.nextLink);
        next.searchParams.set("$top", "15");
        return fetchEmails(token, {
          folder: folders[index],
          top: 15,
          includeBody: true,
          nextLink: next.href,
        });
      }),
    );
    const extraError = extra.find((p) => p.error)?.error;
    if (extraError) return { error: extraError };
    const inspected = [...items, ...extra.flatMap((p) => p.data?.items || [])];
    found = selectCode(inspected, options);
    return {
      data: {
        ...found,
        scanned: inspected.length,
        checked_at: new Date().toISOString(),
        limited: extra.some(
          (p) => p.data && "nextLink" in p.data && !!p.data.nextLink,
        ),
      },
    };
  });
}
export const checkOutlook = (env: Env, account: OutlookAccount) =>
  withOutlook(env, account, async (token) => {
    const page = await fetchEmails(token, { top: 1, includeBody: true });
    return page.error ? { error: page.error } : { data: { connected: true } };
  });
export function outlookFailure(error: GraphError) {
  return {
    success: false as const,
    error: error.code,
    message: error.message,
    ...(error.retry_after ? { retry_after: error.retry_after } : {}),
    ...(error.required_scopes
      ? { required_scopes: error.required_scopes }
      : {}),
    ...(error.draft_id ? { draft_id: error.draft_id } : {}),
    ...(error.delivery_unknown ? { delivery_unknown: true } : {}),
  };
}
