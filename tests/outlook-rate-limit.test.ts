import assert from "node:assert/strict";
import test from "node:test";
import { database, ACCOUNT } from "./helpers";
import { db, eq, insert, update } from "../src/storage/client";
import { reserveOutlookSend } from "../src/outlook";
import type { OutlookAccount } from "../src/types";

test("send attempts share durable per-account budgets across concurrent callers and windows", async () => {
  const f = await database();
  try {
    const [saved] = await db(f.env).mutate([insert("accounts", ACCOUNT)]);
    const account = saved.rows[0] as unknown as OutlookAccount;
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () =>
        reserveOutlookSend({ ...f.env }, account),
      ),
    );
    assert.equal(attempts.filter((result) => !result).length, 10);
    assert.equal(attempts.filter((result) => result?.status === 429).length, 2);
    assert.ok(attempts.find((result) => result)?.retry_after);
    await db(f.env).mutate([
      update("auth_attempts", eq("identity", `send:minute:${account.id}`), {
        reset_at: 0,
      }),
      update("auth_attempts", eq("identity", `send:quarter:${account.id}`), {
        attempts: 60,
      }),
    ]);
    assert.equal(
      (await reserveOutlookSend(f.env, account))?.code,
      "SEND_RATE_LIMITED",
    );
    const [second] = await db(f.env).mutate([
      insert("accounts", { ...ACCOUNT, email: "other@outlook.com" }),
    ]);
    assert.equal(
      await reserveOutlookSend(
        f.env,
        second.rows[0] as unknown as OutlookAccount,
      ),
      undefined,
    );
  } finally {
    await f.dispose();
  }
});
