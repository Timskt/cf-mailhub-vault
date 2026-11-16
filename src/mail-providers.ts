import {
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
import { choice, invalid, text } from "./validation";

export const providerId = (value: unknown) =>
  choice(value, "邮箱服务商", ["mailtm", "mailgw"]);
export class ProviderError extends StorageError {}
const fail = (code: string, message: string, status = 502): never => {
  throw new ProviderError(code, message, status);
};
// Pace calls within an isolate; upstream 429 remains authoritative across isolates/IPs.
const queues = new Map<string, Promise<void>>();
async function pace(provider: string) {
  const previous = queues.get(provider) || Promise.resolve();
  const next = previous.then(
    () => new Promise<void>((resolve) => setTimeout(resolve, 160)),
  );
  queues.set(provider, next);
  await next;
  if (queues.get(provider) === next) queues.delete(provider);
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
  await pace(provider);
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
        Accept: "application/ld+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return fail(
      "PROVIDER_UNAVAILABLE",
      `${base.name} 暂时无法连接，请稍后重试`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401)
      return fail(
        "PROVIDER_AUTH_FAILED",
        "邮箱密码或登录令牌已失效，请在编辑账号中更新密码并测试连接",
        401,
      );
    if (response.status === 404)
      return fail(
        ["/me", "/messages"].includes(path.split("?")[0])
          ? "PROVIDER_ACCOUNT_GONE"
          : "PROVIDER_NOT_FOUND",
        "服务商上的邮箱或邮件已不存在，临时邮箱可能已到期",
        404,
      );
    if (response.status === 422 || response.status === 409)
      return fail(
        "PROVIDER_ACCOUNT_REJECTED",
        "服务商未接受此账号：地址可能已占用、域名不可用或密码不符合要求。已有账号请使用“接入已有账号”",
        400,
      );
    if (response.status === 429)
      return fail(
        "PROVIDER_RATE_LIMITED",
        "邮箱服务商请求过于频繁，请稍后重试",
        429,
      );
    if (response.status === 403)
      return fail(
        "PROVIDER_ACCESS_DENIED",
        "服务商拒绝访问此邮箱，请检查账号状态或在服务商网站登录",
        403,
      );
    return fail(
      "PROVIDER_UNAVAILABLE",
      `${base.name} 服务暂时异常，请稍后重试`,
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
function identity(
  data: Record<string, unknown>,
  address: string,
  expectedId?: string,
) {
  const id = messageId(data.id);
  if (
    string(data.address).toLowerCase() !== address ||
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
  if (data.accountId !== account.remote_id)
    return fail("PROVIDER_IDENTITY_MISMATCH", "邮件所属账号不匹配", 409);
  const sender = record(data.from);
  const subject = string(data.subject, 1000),
    text_content = string(data.text ?? data.intro, 1024 * 1024);
  const html_content = (
    Array.isArray(data.html)
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
    is_read: data.seen === true ? 1 : 0,
    text_content,
    html_content,
    verification_code: info.code || "",
    verification_link: info.link || "",
    has_attachments: data.hasAttachments === true,
  };
}
async function readMessages(
  account: ProviderAccount,
  token: string,
  page: number,
) {
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
      await request(
        account.provider,
        `/messages/${encodeURIComponent(messageId(id))}`,
        token,
      ),
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
    identity(
      await request(account.provider, "/me", token),
      account.address,
      account.remote_id,
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
        detail = message(
          await request(
            account.provider,
            `/messages/${encodeURIComponent(summary.id)}`,
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
