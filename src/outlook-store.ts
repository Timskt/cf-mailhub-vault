import type { ImportAccount } from "./outlook-import";
import { db, eq, now } from "./storage/client";
import type { Env, OutlookAccount } from "./types";
import { invalid } from "./validation";
export async function assertGroup(env: Env, id: number) {
  if (!(await db(env).first("groups", eq("id", id)))) invalid("所选分组不存在");
}
export function accountBatchMutation(
  accounts: ImportAccount[],
  group: number,
  mode: "skip" | "update" = "update",
) {
  return {
    op: "insert" as const,
    table: "accounts" as const,
    rows: accounts.map((account) => ({ ...account, group_id: group })),
    conflict: mode === "skip" ? ("ignore" as const) : ("update" as const),
    keepNonEmpty: ["password", "remark"],
    onConflictSet: {
      auth_status: "unchecked",
      last_error: "",
      last_error_code: "",
      last_checked_at: "",
      last_token_refresh_at: "",
      last_token_attempt_at: "",
      next_token_refresh_at: "",
      token_refresh_failures: 0,
      token_refresh_status: "pending",
      token_refresh_error: "",
      updated_at: now(),
    },
  };
}
export function accountMutation(
  account: ImportAccount,
  group: number,
  mode: "skip" | "update" = "update",
) {
  return accountBatchMutation([account], group, mode);
}
export async function getAccount(
  env: Env,
  id: string | number,
): Promise<OutlookAccount | null> {
  return db(env).first<OutlookAccount>("accounts", eq("id", Number(id)));
}
