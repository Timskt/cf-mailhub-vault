import { cleanMail } from "./mail-cleanup";
import { refreshOutlookToken } from "./outlook";
import {
  and,
  db,
  eq,
  ne,
  remove,
  insert,
  now,
  or,
  oneOf,
} from "./storage/client";
import type { Env, OutlookAccount } from "./types";
import { enqueueEvent } from "./webhooks";
export async function runTokenRefresh(env: Env): Promise<void> {
  const setting = await db(env).first<{ value: string }>(
    "settings",
    eq("key", "token_refresh_batch"),
  );
  const batch = Math.max(1, Math.min(8, Number(setting?.value) || 5));
  const results = await db(env).select<OutlookAccount>("accounts", {
    where: and(
      eq("status", "active"),
      ne("token_refresh_status", "reauth_required"),
      or(eq("next_token_refresh_at", ""), {
        field: "next_token_refresh_at",
        op: "lte",
        value: new Date().toISOString(),
      }),
    ),
    order: [
      ["next_token_refresh_at", "asc"],
      ["id", "asc"],
    ],
    limit: batch,
  });
  let renewed = 0,
    failed = 0;
  for (let i = 0; i < results.length; i += 3) {
    const outcomes = await Promise.allSettled(
      results
        .slice(i, i + 3)
        .map((account) => refreshOutlookToken(env, account)),
    );
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === "fulfilled" && !outcome.value.error) renewed++;
      else {
        failed++;
        const account = results[i + index];
        await enqueueEvent(
          env,
          "token.renew_failed",
          {
            account_id: account.id,
            error_code:
              outcome.status === "fulfilled"
                ? outcome.value.error?.code || "TOKEN_REFRESH_FAILED"
                : "TOKEN_REFRESH_FAILED",
          },
          `renew:${account.id}:${account.next_token_refresh_at || "initial"}`,
        );
      }
    }
  }
  await db(env).mutate([
    insert(
      "settings",
      {
        key: "token_refresh_last_run",
        value: JSON.stringify({
          at: new Date().toISOString(),
          attempted: results.length,
          renewed,
          failed,
        }),
        updated_at: now(),
      },
      { conflict: "update" },
    ),
  ]);
}
export async function runCleanup(env: Env): Promise<void> {
  const setting = await db(env).first<{ value: string }>(
    "settings",
    eq("key", "mail_retention_days"),
  );
  await cleanMail(
    env,
    Math.max(1, Math.min(365, Number(setting?.value) || 15)),
  );
  const time = Math.floor(Date.now() / 1000);
  await db(env).mutate([
    remove("oauth_sessions", { field: "expires_at", op: "lte", value: time }),
    remove("auth_attempts", { field: "reset_at", op: "lte", value: time }),
  ]);
  const deliveries = await db(env).select<{ id: string }>(
    "webhook_deliveries",
    {
      where: and(oneOf("status", ["delivered", "dead", "cancelled"]), {
        field: "updated_at",
        op: "dateLt",
        value: new Date(Date.now() - 30 * 86400000).toISOString(),
      }),
      columns: ["id"],
      limit: 500,
    },
  );
  if (deliveries.length)
    await db(env).mutate([
      remove(
        "webhook_deliveries",
        oneOf(
          "id",
          deliveries.map((row) => row.id),
        ),
      ),
    ]);
}
