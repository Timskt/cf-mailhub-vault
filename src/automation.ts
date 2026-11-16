import { HTTPException } from "hono/http-exception";
import { lookupCode, type CodeOptions } from "./codes";
import { getDomains } from "./domains";
import { db, eq, StorageError } from "./storage/client";
import type { Env } from "./types";
import { enrichVault } from "./vault-health";
import {
  choice,
  email,
  integer,
  invalid,
  object,
  since,
  text,
} from "./validation";

export const AUTOMATION_LIMITS = {
  verification_batch: 5,
  verification_concurrency: 2,
  vault_batch: 100,
  poll_interval_seconds: 10,
  poll_deadline_seconds: 180,
} as const;
export class AutomationError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public retryable = false,
    public retry_after?: number,
  ) {
    super(message);
  }
}
export function automationError(error: unknown) {
  if (error instanceof AutomationError)
    return {
      success: false as const,
      status: error.status,
      error: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.retry_after ? { retry_after: error.retry_after } : {}),
    };
  if (error instanceof HTTPException)
    return {
      success: false as const,
      status: error.status,
      error: "INVALID_REQUEST",
      message: error.message,
      retryable: false,
    };
  if (error instanceof StorageError)
    return {
      success: false as const,
      status: error.status,
      error: error.code,
      message: error.message,
      retryable: error.status >= 500,
      ...(error.status >= 500 ? { retry_after: 5 } : {}),
    };
  return {
    success: false as const,
    status: 500,
    error: "SERVER_ERROR",
    message: "服务暂时无法处理请求，请稍后重试",
    retryable: true,
    retry_after: 10,
  };
}

export function parseTarget(input: unknown) {
  const body = object(input);
  if (
    [body.email, body.vault_id, body.platform].filter((v) => v !== undefined)
      .length !== 1
  )
    invalid("email、vault_id、platform 必须且只能提供一个");
  if (body.source !== undefined && body.email === undefined)
    invalid("source 只用于 email；台账记录使用已登记来源");
  return {
    ...(body.email !== undefined ? { email: email(body.email) } : {}),
    ...(body.vault_id !== undefined
      ? {
          vault_id: integer(
            body.vault_id,
            "台账 ID",
            1,
            Number.MAX_SAFE_INTEGER,
          ),
        }
      : {}),
    ...(body.platform !== undefined
      ? { platform: text(body.platform, "平台名称", 100).trim() }
      : {}),
    source:
      body.source === undefined
        ? undefined
        : choice(body.source, "邮箱来源", ["cf_domain", "outlook"]),
  };
}
type Target = ReturnType<typeof parseTarget>;
export function parseVerification(input: unknown) {
  const body = object(input);
  return {
    target: parseTarget(body),
    options: {
      since: since(body.since),
      sender: text(body.sender, "发件人", 254),
      keyword: text(body.q, "关键词", 200),
    } satisfies CodeOptions,
  };
}

export async function resolveTarget(env: Env, target: Target) {
  const store = db(env);
  let address = target.email || "",
    source: string = target.source || "",
    vaultId = target.vault_id;
  if (target.vault_id || target.platform !== undefined) {
    if (target.platform === "") invalid("平台名称不能为空");
    const rows = await store.select<{
      id: number;
      account_email: string;
      email_source: string;
    }>("platform_vault", {
      where: target.vault_id
        ? eq("id", target.vault_id)
        : { field: "platform_name", op: "ieq", value: target.platform! },
      columns: ["id", "account_email", "email_source"],
      limit: 2,
    });
    if (!rows.length)
      throw new AutomationError(
        "TARGET_NOT_FOUND",
        "未找到平台账号，请使用账号列表核对 vault_id 或 platform",
        404,
      );
    if (rows.length > 1)
      throw new AutomationError(
        "AMBIGUOUS_TARGET",
        "该平台有多个账号，请用 vault_id 或 email 精确指定",
        409,
      );
    address = rows[0].account_email.toLowerCase();
    source = rows[0].email_source;
    vaultId = rows[0].id;
  }
  if (!source) {
    const outlook = await store.first(
      "accounts",
      { field: "email", op: "ieq", value: address },
      { columns: ["id"] },
    );
    const domains = await getDomains(env);
    const cf = domains.some((d) => d.domain === address.split("@")[1]);
    const refs = await store.select<{ email_source: string }>(
      "platform_vault",
      {
        where: { field: "account_email", op: "ieq", value: address },
        columns: ["email_source"],
      },
    );
    const candidates = new Set([
      ...refs.map((r) => r.email_source),
      ...(outlook ? ["outlook"] : []),
      ...(cf ? ["cf_domain"] : []),
    ]);
    if (candidates.size > 1)
      throw new AutomationError(
        "AMBIGUOUS_SOURCE",
        "此地址有多个邮箱来源，请明确提供 source 或使用 vault_id",
        409,
      );
    if (candidates.size) source = [...candidates][0];
    else {
      source = /@(outlook|hotmail|live|msn)\.(com|cn)$/i.test(address)
        ? "outlook"
        : "external";
    }
  }
  return { email: address, source, ...(vaultId ? { vault_id: vaultId } : {}) };
}
export async function inspectMailbox(env: Env, input: Target) {
  const target = await resolveTarget(env, input);
  const [enriched] = await enrichVault(env, [
    {
      account_email: target.email,
      email_source: target.source as "cf_domain",
      status: "active",
    },
  ]);
  const box =
    target.source === "cf_domain"
      ? await db(env).first("temp_mailboxes", eq("address", target.email), {
          columns: ["id", "is_permanent", "expires_at"],
        })
      : null;
  return {
    ...target,
    health: enriched.mailbox,
    mailbox: box
      ? {
          id: box.id,
          is_permanent: !!box.is_permanent,
          expires_at: box.expires_at,
          is_expired:
            !box.is_permanent &&
            !!box.expires_at &&
            Date.parse(String(box.expires_at)) <= Date.now(),
        }
      : null,
    observed_at: new Date().toISOString(),
    live_check: false,
  };
}
export async function verifyTarget(
  env: Env,
  parsed: ReturnType<typeof parseVerification>,
  resolved?: Awaited<ReturnType<typeof resolveTarget>>,
) {
  const target = resolved || (await resolveTarget(env, parsed.target));
  const result = await lookupCode(
    env,
    target.email,
    target.source,
    parsed.options,
  );
  if (result.error) {
    const e = result.error;
    const status =
      e.status === 429
        ? 429
        : e.status === 404
          ? 404
          : e.status === 409
            ? 409
            : e.status && e.status < 500
              ? 409
              : 502;
    throw new AutomationError(
      e.code,
      e.message,
      status,
      status === 429 || status >= 500,
      e.retry_after || (status === 429 ? 30 : status >= 500 ? 10 : undefined),
    );
  }
  return {
    ...target,
    ...result.data,
    outcome:
      result.data.code || result.data.link
        ? ("found" as const)
        : ("empty" as const),
    poll_after_seconds: AUTOMATION_LIMITS.poll_interval_seconds,
  };
}

export async function batchVerification(env: Env, value: unknown) {
  const body = object(value);
  if (
    !Array.isArray(body.items) ||
    !body.items.length ||
    body.items.length > AUTOMATION_LIMITS.verification_batch
  )
    invalid(
      `items 须包含 1–${AUTOMATION_LIMITS.verification_batch} 个查收请求`,
    );
  // Isolate per-item failures. Keep order and serialize repeated addresses so one batch
  // never refreshes the same Microsoft credential concurrently.
  const locks = new Map<string, Promise<unknown>>();
  const results: Record<string, unknown>[] = new Array(body.items.length);
  let cursor = 0;
  const items: unknown[] = body.items;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        const parsed = parseVerification(items[index]);
        const target = await resolveTarget(env, parsed.target);
        const key = `${target.source}:${target.email}`;
        const prior = locks.get(key) || Promise.resolve();
        const current = prior
          .catch(() => {})
          .then(() => verifyTarget(env, parsed, target));
        locks.set(key, current);
        const data = await current;
        results[index] = { index, success: true, data };
      } catch (e) {
        results[index] = { index, ...automationError(e) };
      }
    }
  }
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          AUTOMATION_LIMITS.verification_concurrency,
          items.length,
        ),
      },
      worker,
    ),
  );
  const succeeded = results.filter((r) => r.success).length;
  return {
    results,
    summary: {
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
    },
    completed_at: new Date().toISOString(),
  };
}
