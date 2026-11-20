import {
  isMailProvider,
  mailProviders,
  type MailProviderId,
  type ProviderAccount,
  type ProviderMail,
} from "../shared/mail-providers";
import { extractVerificationInfo } from "./code-extractor";
import type { CodeOptions } from "./codes";
import type { CodeResult } from "./outlook";
import {
  and,
  db,
  eq,
  now,
  StorageError,
  update,
  type Row,
} from "./storage/client";
import type { Env } from "./types";
import { invalid, text } from "./validation";

export const providerId = (value: unknown): MailProviderId => {
  const result = text(value, "邮箱服务商", 40);
  if (!isMailProvider(result)) invalid("邮箱服务商无效");
  return result;
};
export class ProviderError extends StorageError {
  constructor(
    code: string,
    message: string,
    status = 502,
    public retry_after?: number,
  ) {
    super(code, message, status);
  }
}
const fail = (
  code: string,
  message: string,
  status = 502,
  retryAfter?: number,
): never => {
  throw new ProviderError(code, message, status, retryAfter);
};
// Mail.tm and Mail.gw use compatible APIs; pace their requests through one local queue.
const queues = new Map<string, Promise<void>>();
async function pace(key: string) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.then(
    () => new Promise<void>((resolve) => setTimeout(resolve, 220)),
  );
  queues.set(key, next);
  await next;
  if (queues.get(key) === next) queues.delete(key);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail(
      "PROVIDER_RESPONSE_INVALID",
      "邮箱服务商返回了无法识别的数据，请稍后重试",
    );
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 1000) {
  return typeof value === "string" ? value.slice(0, max) : "";
}
function retryAfterSeconds(value: string | null) {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  const delay = Number.isFinite(seconds)
    ? Math.ceil(seconds)
    : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isFinite(delay) && delay > 0
    ? Math.min(86400, delay)
    : undefined;
}
export function messageId(value: unknown) {
  const result = text(value, "服务商记录 ID", 200);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) invalid("服务商记录 ID 无效");
  return result;
}
async function request(
  provider: MailProviderId,
  path: string,
  token = "",
  body?: unknown,
) {
  const base = mailProviders.find((p) => p.id === provider);
  if (!base) return fail("PROVIDER_UNSUPPORTED", "邮箱服务商尚未接入", 400);
  await pace(base.family);
  let response: Response;
  try {
    response = await fetch(base.api + path, {
      method: body === undefined ? "GET" : "POST",
      // Workers do not implement redirect:"error". Manual redirects keep the
      // allowlist boundary explicit and still prevent credentials from being
      // forwarded to another host.
      redirect: "manual",
      signal: AbortSignal.timeout(12000),
      headers: {
        Accept:
          provider === "mailtm" || provider === "mailgw"
            ? "application/ld+json"
            : "application/json",
        ...(token
          ? provider === "mailslurp"
            ? { "x-api-key": token }
            : provider === "mailinator"
              ? { Authorization: token }
              : { Authorization: `Bearer ${token}` }
          : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return fail(
      timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE",
      timedOut
        ? `${base.name} 请求超时；账号凭据尚未判定失效，请稍后重试`
        : `${base.name} 暂时无法连接，请稍后重试`,
      timedOut ? 504 : 502,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401)
      return fail(
        "PROVIDER_AUTH_FAILED",
        provider === "mailslurp"
          ? "MailSlurp API Key 无效或已撤销，请更新 API Key 后测试连接"
          : provider === "mailinator"
            ? "Mailinator API Token 无效或已撤销，请更新 Token 后测试连接"
            : "邮箱密码或登录令牌已失效，请在编辑账号中更新密码并测试连接",
        401,
      );
    if (response.status === 404)
      return fail(
        provider === "mailslurp"
          ? path.startsWith("/inboxes/") || path === "/inboxes/byEmailAddress"
            ? "PROVIDER_ACCOUNT_GONE"
            : "PROVIDER_NOT_FOUND"
          : provider === "mailinator"
            ? path === "/api/v2/domains" ||
              (path.includes("/inboxes/") && !path.includes("/messages/"))
              ? "PROVIDER_ACCOUNT_GONE"
              : "PROVIDER_NOT_FOUND"
            : ["/me", "/messages"].includes(path.split("?")[0])
              ? "PROVIDER_ACCOUNT_GONE"
              : "PROVIDER_NOT_FOUND",
        provider === "mailslurp"
          ? "MailSlurp Inbox 或邮件已不存在；请在 MailSlurp 控制台检查保留期限"
          : provider === "mailinator"
            ? "Mailinator 私有域或收件地址不存在，请检查账户域名和 Inbox"
            : "服务商上的邮箱或邮件已不存在，临时邮箱可能已到期",
        404,
      );
    if (response.status === 422 || response.status === 409)
      return fail(
        "PROVIDER_ACCOUNT_REJECTED",
        "服务商未接受此账号：地址可能已占用、域名不可用或密码不符合要求。已有账号请使用“接入已有账号”",
        400,
      );
    if (response.status === 429) {
      const retryAfter =
        retryAfterSeconds(response.headers.get("Retry-After")) || 1;
      return fail(
        "PROVIDER_RATE_LIMITED",
        `邮箱服务商请求过于频繁，请至少等待 ${retryAfter} 秒后重试`,
        429,
        retryAfter,
      );
    }
    if (response.status === 403)
      return fail(
        "PROVIDER_ACCESS_DENIED",
        provider === "mailslurp"
          ? "MailSlurp API Key 无权读取此 Inbox，请检查 API Key 所属账户和访问范围"
          : provider === "mailinator"
            ? "Mailinator Token 无权读取此私有域，请检查团队成员权限"
            : "服务商拒绝访问此邮箱，请检查账号状态或在服务商网站登录",
        403,
      );
    const retryAfter = retryAfterSeconds(response.headers.get("Retry-After"));
    if (response.status >= 500)
      return fail(
        "PROVIDER_UPSTREAM_ERROR",
        `${base.name} 暂时返回服务错误，请稍后重试`,
        503,
        retryAfter,
      );
    return fail(
      "PROVIDER_UNAVAILABLE",
      `${base.name} 服务暂时异常，请稍后重试`,
      502,
      retryAfter,
    );
  }
  try {
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2 * 1024 * 1024) {
        await reader.cancel();
        return fail(
          "PROVIDER_RESPONSE_TOO_LARGE",
          "服务商邮件内容超过 2 MiB，请在服务商网站查看",
          413,
        );
      }
      chunks.push(chunk.value);
    }
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    return record(JSON.parse(new TextDecoder().decode(all)));
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    return fail(
      "PROVIDER_RESPONSE_INVALID",
      "邮箱服务商返回了无法识别的数据，请稍后重试",
    );
  }
}
function collection(data: Record<string, unknown>) {
  const members = data["hydra:member"] ?? data.member;
  if (!Array.isArray(members) || members.length > 100)
    return fail("PROVIDER_RESPONSE_INVALID", "邮箱服务商列表格式无效");
  const total = data["hydra:totalItems"] ?? data.totalItems;
  if (
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < members.length
  )
    return fail("PROVIDER_RESPONSE_INVALID", "邮箱服务商分页信息无效");
  return { members: members.map(record), total };
}
export async function providerDomains(provider: MailProviderId, page = 1) {
  if (!mailProviders.find((p) => p.id === provider)?.canCreate)
    return fail(
      "PROVIDER_CAPABILITY_UNSUPPORTED",
      `${mailProviders.find((p) => p.id === provider)?.name} 不提供可创建邮箱的域名列表，请接入已有 Inbox`,
      400,
    );
  const { members, total } = collection(
    await request(provider, `/domains?page=${page}`),
  );
  return {
    data: members
      .filter((d) => d.isActive === true && d.isPrivate !== true)
      .map((d) => ({ domain: string(d.domain, 253) }))
      .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d.domain)),
    total,
    page,
    limit: 30,
  };
}
function mailinatorAddress(address: string) {
  const split = address.lastIndexOf("@");
  if (split < 1 || split === address.length - 1)
    return fail("PROVIDER_IDENTITY_MISMATCH", "Mailinator 邮箱地址无效", 400);
  return { inbox: address.slice(0, split), domain: address.slice(split + 1) };
}
function mailinatorInboxPath(account: ProviderAccount, suffix = "") {
  const { inbox } = mailinatorAddress(account.address);
  return `/api/v2/domains/${encodeURIComponent(account.remote_id)}/inboxes/${encodeURIComponent(inbox)}${suffix}`;
}
function providerMessagePath(account: ProviderAccount, id: string) {
  const safeId = encodeURIComponent(messageId(id));
  if (account.provider === "mailslurp") return `/emails/${safeId}`;
  if (account.provider === "mailinator")
    return mailinatorInboxPath(account, `/messages/${safeId}`);
  return `/messages/${safeId}`;
}
function identity(
  data: Record<string, unknown>,
  address: string,
  expectedId?: string,
  provider?: MailProviderId,
) {
  const id = messageId(data.id);
  const returnedAddress =
    provider === "mailslurp" ? string(data.emailAddress) : string(data.address);
  if (
    returnedAddress.toLowerCase() !== address ||
    (expectedId && id !== expectedId)
  )
    return fail(
      "PROVIDER_IDENTITY_MISMATCH",
      "服务商返回的账号与当前邮箱不一致，请重新接入",
      409,
    );
  if (data.isDeleted === true || data.isDisabled === true)
    return fail(
      "PROVIDER_ACCOUNT_DISABLED",
      "此邮箱已被服务商停用或删除，请在服务商网站检查",
      400,
    );
  return id;
}
export async function providerLogin(
  provider: MailProviderId,
  address: string,
  password: string,
  expectedId?: string,
) {
  if (provider === "mailinator") {
    const { inbox, domain } = mailinatorAddress(address);
    const result = await request(provider, "/api/v2/domains", password);
    if (!Array.isArray(result.domains) || result.domains.length > 100)
      return fail("PROVIDER_RESPONSE_INVALID", "Mailinator 私有域列表格式无效");
    const privateDomain = result.domains
      .map(record)
      .find((item) => string(item.name, 253).toLowerCase() === domain);
    if (!privateDomain)
      return fail(
        "PROVIDER_DOMAIN_NOT_OWNED",
        "此邮箱域名不属于当前 Mailinator 团队的私有域，请核对 Team Settings 中的域名",
        400,
      );
    if (privateDomain.verified === false)
      return fail(
        "PROVIDER_DOMAIN_UNVERIFIED",
        "Mailinator 私有域尚未验证，请先在 Mailinator 完成域名验证",
        400,
      );
    if (expectedId && expectedId !== domain)
      return fail(
        "PROVIDER_IDENTITY_MISMATCH",
        "保存的 Mailinator 私有域与邮箱地址不一致，请重新接入",
        409,
      );
    const remote = await request(
      provider,
      `/api/v2/domains/${encodeURIComponent(domain)}/inboxes/${encodeURIComponent(inbox)}?limit=1&decode_subject=true`,
      password,
    );
    if (
      !Array.isArray(remote.msgs) ||
      remote.msgs.length > 99 ||
      (typeof remote.domain === "string" &&
        remote.domain.toLowerCase() !== domain) ||
      (typeof remote.to === "string" &&
        remote.to.toLowerCase() !== inbox.toLowerCase())
    )
      return fail(
        "PROVIDER_IDENTITY_MISMATCH",
        "Mailinator 返回的私有域或收件地址与当前账号不匹配",
        409,
      );
    return {
      token: password,
      remote_id: domain,
      token_expires_at: new Date(Date.now() + 365 * 86400000).toISOString(),
    };
  }
  if (provider === "mailslurp") {
    const lookup = expectedId
      ? { exists: true, inboxId: expectedId }
      : await request(
          provider,
          `/inboxes/byEmailAddress?emailAddress=${encodeURIComponent(address)}`,
          password,
        );
    if (
      lookup.exists !== true ||
      typeof lookup.inboxId !== "string" ||
      !lookup.inboxId
    )
      return fail(
        "PROVIDER_ACCOUNT_GONE",
        "此 API Key 下找不到对应的 MailSlurp Inbox，请核对邮箱地址和所属账户",
        404,
      );
    const remote_id = messageId(lookup.inboxId);
    identity(
      await request(
        provider,
        `/inboxes/${encodeURIComponent(remote_id)}`,
        password,
      ),
      address,
      remote_id,
      provider,
    );
    return {
      token: password,
      remote_id,
      token_expires_at: new Date(Date.now() + 365 * 86400000).toISOString(),
    };
  }
  const result = await request(provider, "/token", "", { address, password });
  if (
    typeof result.token !== "string" ||
    !result.token ||
    result.token.length > 16384 ||
    /\s/.test(result.token)
  )
    return fail("PROVIDER_RESPONSE_INVALID", "服务商未返回有效的登录令牌");
  const token = result.token;
  const remote_id = identity(
    await request(provider, "/me", token),
    address,
    expectedId,
    provider,
  );
  if (result.id !== remote_id)
    return fail("PROVIDER_IDENTITY_MISMATCH", "服务商登录身份校验失败", 409);
  return {
    token,
    remote_id,
    token_expires_at: new Date(Date.now() + 30 * 60000).toISOString(),
  };
}
export async function createProviderMailbox(
  provider: MailProviderId,
  address: string,
  password: string,
) {
  // Never retry creation automatically: a timeout may still mean the account was created.
  identity(
    await request(provider, "/accounts", "", { address, password }),
    address,
  );
}
export function providerSummary(account: ProviderAccount) {
  const { password, token, token_expires_at, credential_version, ...safe } =
    account;
  return { ...safe, has_password: !!password };
}
const current = (a: ProviderAccount) =>
  and(
    eq("id", a.id),
    eq("credential_version", a.credential_version),
    eq("status", a.status),
  );
async function saveState(env: Env, account: ProviderAccount, fields: Row) {
  const [result] = await db(env).mutate([
    update("provider_accounts", current(account), fields),
  ]);
  if (!result.changes)
    return fail(
      "PROVIDER_ACCOUNT_CHANGED",
      "账号已修改或移除，请刷新后重试",
      409,
    );
}
export async function getProviderAccount(env: Env, id: number) {
  const account = await db(env).first<ProviderAccount>(
    "provider_accounts",
    eq("id", id),
  );
  if (!account)
    return fail("PROVIDER_ACCOUNT_NOT_FOUND", "外部邮箱账号不存在", 404);
  return account;
}
async function authorized<T>(
  env: Env,
  account: ProviderAccount,
  fn: (token: string, currentAccount: ProviderAccount) => Promise<T>,
) {
  if (account.status !== "active")
    return fail(
      "PROVIDER_ACCOUNT_DISABLED",
      "此邮箱已在本平台停用，请先启用",
      400,
    );
  let token = account.token;
  const login = async () => {
    const result = await providerLogin(
      account.provider,
      account.address,
      account.password,
      account.remote_id,
    );
    await saveState(env, account, result);
    token = result.token;
    account = { ...account, ...result };
  };
  try {
    const fresh =
      !token ||
      !Number.isFinite(Date.parse(account.token_expires_at)) ||
      Date.parse(account.token_expires_at) <= Date.now();
    if (fresh) await login();
    let result: T;
    try {
      result = await fn(token, account);
    } catch (error) {
      if (
        !(error instanceof ProviderError) ||
        error.code !== "PROVIDER_AUTH_FAILED" ||
        fresh
      )
        throw error;
      await login();
      result = await fn(token, account);
    }
    await saveState(env, account, {
      auth_status: "healthy",
      last_checked_at: now(),
      last_error: "",
      last_error_code: "",
    });
    return result;
  } catch (error) {
    if (
      error instanceof ProviderError &&
      error.code !== "PROVIDER_ACCOUNT_CHANGED"
    ) {
      // A deleted message does not prove that the mailbox or credentials failed.
      if (error.code !== "PROVIDER_NOT_FOUND")
        await saveState(env, account, {
          auth_status: [
            "PROVIDER_AUTH_FAILED",
            "PROVIDER_ACCOUNT_GONE",
            "PROVIDER_ACCOUNT_DISABLED",
            "PROVIDER_IDENTITY_MISMATCH",
          ].includes(error.code)
            ? "reauth_required"
            : "error",
          last_checked_at: now(),
          last_error: error.message,
          last_error_code: error.code,
        });
      // Provider 401 must not log the administrator out of this application.
      if (error.status === 401) error.status = 400;
    }
    throw error;
  }
}
function message(
  data: Record<string, unknown>,
  account: ProviderAccount,
): ProviderMail {
  if (account.provider === "mailinator") {
    const { inbox, domain } = mailinatorAddress(account.address);
    const to = string(data.to, 254).toLowerCase();
    const toLocal = to.includes("@") ? to.slice(0, to.indexOf("@")) : to;
    if (
      account.remote_id.toLowerCase() !== domain ||
      (toLocal && toLocal !== inbox.toLowerCase()) ||
      (typeof data.domain === "string" && data.domain.toLowerCase() !== domain)
    )
      return fail("PROVIDER_IDENTITY_MISMATCH", "邮件所属账号不匹配", 409);
    const parts = Array.isArray(data.parts) ? data.parts.map(record) : [];
    const partBody = (part: Record<string, unknown>) =>
      string(part.body, 1024 * 1024);
    const contentType = (part: Record<string, unknown>) => {
      const headers = record(part.headers);
      const entry = Object.entries(headers).find(
        ([key]) => key.toLowerCase() === "content-type",
      );
      return entry ? string(entry[1]).toLowerCase() : "";
    };
    const text_content = parts
      .filter((part) => contentType(part).includes("text/plain"))
      .map(partBody)
      .join("\n");
    const html_content = parts
      .filter((part) => contentType(part).includes("text/html"))
      .map(partBody)
      .join("\n");
    const fallbackBody = string(data.body, 1024 * 1024);
    const textBody =
      text_content || string(data.text, 1024 * 1024) || fallbackBody;
    const htmlBody = html_content || string(data.html, 1024 * 1024);
    const subject = string(data.subject, 1000);
    const info = extractVerificationInfo(subject, textBody, htmlBody);
    const from = string(data.fromfull || data.origfrom || data.from, 512);
    const sender = from.match(/<([^<>]+)>/)?.[1] || from;
    const sender_name =
      string(data.from, 254) || from.replace(/<[^<>]+>/, "").trim();
    const time = typeof data.time === "number" ? data.time : Number(data.time);
    const created_at =
      Number.isFinite(time) && time > 0
        ? new Date(time).toISOString()
        : string(data.created_at, 50);
    return {
      id: messageId(data.id),
      subject,
      sender: sender.slice(0, 254),
      sender_name,
      created_at,
      is_read: data.is_read === true || data.seen === true ? 1 : 0,
      text_content: textBody,
      html_content: htmlBody,
      verification_code: info.code || "",
      verification_link: info.link || "",
      has_attachments: parts.some((part) => {
        const headers = record(part.headers);
        const disposition = Object.entries(headers).find(
          ([key]) => key.toLowerCase() === "content-disposition",
        );
        return disposition && /attachment/i.test(string(disposition[1]));
      }),
    };
  }
  const mailSlurp = account.provider === "mailslurp";
  const inboxId = mailSlurp ? data.inboxId : data.accountId;
  if (inboxId !== account.remote_id)
    return fail("PROVIDER_IDENTITY_MISMATCH", "邮件所属账号不匹配", 409);
  const sender = mailSlurp
    ? {
        address: string(data.from, 254),
        name: string(data.fromName),
      }
    : record(data.from);
  const subject = string(data.subject, 1000),
    mailSlurpBody = string(data.body, 1024 * 1024),
    text_content = mailSlurp
      ? string(
          data.isHTML === true
            ? (data.textExcerpt ?? data.bodyExcerpt)
            : (data.body ?? data.textExcerpt ?? data.bodyExcerpt),
          1024 * 1024,
        )
      : string(data.text ?? data.intro, 1024 * 1024);
  const html_content = mailSlurp
    ? data.isHTML === true
      ? mailSlurpBody
      : ""
    : (Array.isArray(data.html)
        ? data.html.filter((s) => typeof s === "string").join("\n")
        : string(data.html, 1024 * 1024)
      ).slice(0, 1024 * 1024);
  const info = extractVerificationInfo(subject, text_content, html_content);
  return {
    id: messageId(data.id),
    subject,
    sender: string(sender.address, 254),
    sender_name: string(sender.name),
    created_at: string(data.createdAt, 50),
    is_read: (mailSlurp ? data.read : data.seen) === true ? 1 : 0,
    text_content,
    html_content,
    verification_code: info.code || "",
    verification_link: info.link || "",
    has_attachments: mailSlurp
      ? Array.isArray(data.attachments) && data.attachments.length > 0
      : data.hasAttachments === true,
  };
}
async function readMessages(
  account: ProviderAccount,
  token: string,
  page: number,
) {
  if (account.provider === "mailslurp") {
    const result = await request(
      account.provider,
      `/inboxes/${encodeURIComponent(account.remote_id)}/emails/paginated?page=${page - 1}&size=30&sort=DESC`,
      token,
    );
    const members = result.content;
    const total = result.totalElements;
    if (
      !Array.isArray(members) ||
      members.length > 100 ||
      typeof total !== "number" ||
      !Number.isSafeInteger(total) ||
      total < members.length
    )
      return fail("PROVIDER_RESPONSE_INVALID", "MailSlurp 邮件分页格式无效");
    return {
      data: members.map((item) => {
        const mail = record(item);
        return message(
          {
            ...mail,
            inboxId: mail.inboxId ?? account.remote_id,
          },
          account,
        );
      }),
      total,
      page,
      limit: 30,
    };
  }
  if (account.provider === "mailinator") {
    const offset = (page - 1) * 30;
    const result = await request(
      account.provider,
      `${mailinatorInboxPath(account)}?limit=31&skip=${offset}&sort=descending&decode_subject=true`,
      token,
    );
    const members = result.msgs;
    if (
      !Array.isArray(members) ||
      members.length > 31 ||
      (typeof result.domain === "string" &&
        result.domain.toLowerCase() !== account.remote_id.toLowerCase())
    )
      return fail("PROVIDER_RESPONSE_INVALID", "Mailinator 邮件分页格式无效");
    const data = members.slice(0, 30);
    const hasMore = members.length > 30;
    return {
      data: data.map((item) => message(record(item), account)),
      total: offset + (hasMore ? members.length : data.length),
      has_more: hasMore,
      page,
      limit: 30,
    };
  }
  const { members, total } = collection(
    await request(account.provider, `/messages?page=${page}`, token),
  );
  return {
    data: members
      .filter((m) => m.isDeleted !== true)
      .map((m) => message(m, account)),
    total,
    page,
    limit: 30,
  };
}
export async function providerMessages(
  env: Env,
  account: ProviderAccount,
  page: number,
) {
  return authorized(env, account, (token, currentAccount) =>
    readMessages(currentAccount, token, page),
  );
}
export async function providerMessage(
  env: Env,
  account: ProviderAccount,
  id: string,
) {
  return authorized(env, account, async (token, currentAccount) => {
    account = currentAccount;
    const result = message(
      await request(account.provider, providerMessagePath(account, id), token),
      account,
    );
    if (result.id !== id)
      return fail(
        "PROVIDER_IDENTITY_MISMATCH",
        "服务商返回的邮件与请求不一致",
        409,
      );
    return result;
  });
}
export async function checkProviderAccount(env: Env, account: ProviderAccount) {
  return authorized(env, account, async (token, currentAccount) => {
    account = currentAccount;
    if (account.provider !== "mailinator")
      identity(
        await request(
          account.provider,
          account.provider === "mailslurp"
            ? `/inboxes/${encodeURIComponent(account.remote_id)}`
            : "/me",
          token,
        ),
        account.address,
        account.remote_id,
        account.provider,
      );
    await readMessages(account, token, 1);
    return { connected: true };
  });
}
export async function providerCode(
  env: Env,
  account: ProviderAccount,
  options: CodeOptions = {},
): Promise<CodeResult> {
  return authorized(env, account, async (token, currentAccount) => {
    account = currentAccount;
    const list = await readMessages(account, token, 1);
    const candidates = list.data
      .filter(
        (m) =>
          (!options.since ||
            Date.parse(m.created_at) >= Date.parse(options.since)) &&
          (!options.sender ||
            m.sender.toLowerCase().includes(options.sender.toLowerCase())),
      )
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    let scanned = 0;
    // Bounded detail reads find links/codes omitted from the provider's intro.
    for (const summary of candidates.slice(0, 10)) {
      let detail: ProviderMail;
      try {
        const idPath = encodeURIComponent(summary.id);
        detail = message(
          await request(
            account.provider,
            providerMessagePath(account, idPath),
            token,
          ),
          account,
        );
      } catch (error) {
        if (
          error instanceof ProviderError &&
          error.code === "PROVIDER_NOT_FOUND"
        )
          continue;
        throw error;
      }
      scanned++;
      if (detail.id !== summary.id)
        return fail(
          "PROVIDER_IDENTITY_MISMATCH",
          "服务商返回的邮件与请求不一致",
          409,
        );
      if (
        options.keyword &&
        !`${detail.subject}\n${detail.text_content}\n${detail.html_content}`
          .toLowerCase()
          .includes(options.keyword.toLowerCase())
      )
        continue;
      if (detail.verification_code || detail.verification_link)
        return {
          has_mail: true,
          code: detail.verification_code,
          link: detail.verification_link,
          subject: detail.subject,
          sender: detail.sender,
          received_at: detail.created_at,
          mail_id: detail.id,
          scanned,
          checked_at: now(),
          limited: list.total > list.data.length || candidates.length > 10,
          message: "已找到最新匹配的验证码或验证链接",
        };
    }
    return {
      has_mail: !!candidates.length,
      code: "",
      link: "",
      scanned,
      checked_at: now(),
      limited: list.total > list.data.length || candidates.length > 10,
      message: candidates.length
        ? "已检查的邮件中未找到验证码或链接，可调整条件或打开收件箱"
        : "指定条件下尚无邮件",
    };
  });
}
