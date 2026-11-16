import assert from "node:assert/strict";
import test from "node:test";
import { database, ACCOUNT } from "./helpers";
import {
  and,
  db,
  rawDb,
  eq,
  insert,
  update,
  type DataStore,
} from "../src/storage/client";
import { rekeyCredentials } from "../src/storage/secure";

test("credential encryption covers writes, exports, token CAS and plaintext upgrades", async () => {
  const f = await database();
  try {
    await db(f.env).mutate([insert("accounts", ACCOUNT)]);
    f.env.CREDENTIAL_ENCRYPTION_KEY =
      "fictional-encryption-key-for-tests-at-least-32";
    const legacy = await db(f.env).first("accounts", eq("id", 1));
    assert.equal(legacy?.refresh_token, ACCOUNT.refresh_token);
    const [rotated] = await db(f.env).mutate([
      update(
        "accounts",
        and(eq("id", 1), eq("refresh_token", ACCOUNT.refresh_token)),
        {
          refresh_token: "rotated-token",
          password: "private-password",
        },
      ),
      insert("platform_vault", {
        platform_name: "Test",
        account_email: "test@example.test",
        password: "vault-secret",
        totp_secret: "JBSWY3DPEHPK3PXP",
      }),
    ]);
    assert.equal(rotated.changes, 1);
    assert.equal(rotated.rows[0].refresh_token, "rotated-token");
    assert.equal("refresh_token_fingerprint" in rotated.rows[0], false);
    const stored = await rawDb(f.env).first("accounts", eq("id", 1));
    assert.match(String(stored?.refresh_token), /^enc:v1:/);
    assert.match(String(stored?.password), /^enc:v1:/);
    assert.notEqual(stored?.refresh_token_fingerprint, "rotated-token");
    assert.equal(
      (await db(f.env).first("accounts", eq("refresh_token", "rotated-token")))
        ?.id,
      1,
    );
    const [stale] = await db(f.env).mutate([
      update(
        "accounts",
        and(eq("id", 1), eq("refresh_token", ACCOUNT.refresh_token)),
        { refresh_token: "stale" },
      ),
    ]);
    assert.equal(stale.changes, 0);
    const [next] = await db(f.env).mutate([
      update(
        "accounts",
        and(eq("id", 1), eq("refresh_token", "rotated-token")),
        { refresh_token: "next-token" },
      ),
    ]);
    assert.equal(next.changes, 1);
    const vaultStored = await rawDb(f.env).first("platform_vault", eq("id", 1));
    assert.ok(!JSON.stringify(vaultStored).includes("vault-secret"));
    assert.equal(
      (await f.request("/api/vault/1")).data.data.password,
      "vault-secret",
    );
    const list = await f.request("/api/vault");
    assert.equal(list.data.data[0].has_totp, 1);
    assert.ok(!JSON.stringify(list.data).includes("JBSWY3DPEHPK3PXP"));
    assert.equal(
      (await f.request("/api/vault/export")).data.accounts[0].totp_secret,
      "JBSWY3DPEHPK3PXP",
    );
  } finally {
    await f.dispose();
  }
});

test("rekey compares original ciphertext so a concurrent token refresh wins, then resumes safely", async () => {
  const f = await database();
  try {
    await db(f.env).mutate([insert("accounts", ACCOUNT)]);
    const current = "test-rekey-key-thirty-two-characters-or-more";
    f.env.CREDENTIAL_ENCRYPTION_KEY = current;
    const raw = rawDb(f.env);
    let intercepted = false;
    const race: DataStore = {
      select: (...args) => raw.select(...args),
      first: (...args) => raw.first(...args),
      count: (...args) => raw.count(...args),
      mutate: async (mutations) => {
        if (!intercepted) {
          intercepted = true;
          await db(f.env).mutate([
            update("accounts", eq("id", 1), {
              refresh_token: "concurrent-new-token",
            }),
          ]);
        }
        return raw.mutate(mutations);
      },
    };
    const skipped = await rekeyCredentials(
      race,
      current,
      undefined,
      "accounts",
      0,
    );
    assert.equal(skipped.skipped, 1);
    assert.equal(
      (await db(f.env).first("accounts", eq("id", 1)))?.refresh_token,
      "concurrent-new-token",
    );
    const done = await rekeyCredentials(raw, current, undefined, "accounts", 0);
    assert.equal(done.changed, 1);
    assert.equal(done.complete, true);
    const row = await db(f.env).first(
      "accounts",
      eq("refresh_token", "concurrent-new-token"),
    );
    assert.equal(row?.password, ACCOUNT.password);
    assert.equal(row?.refresh_token, "concurrent-new-token");
    await assert.rejects(
      () =>
        db(f.env).select("accounts", {
          where: { field: "password", op: "contains", value: "test" },
        }),
      /不支持/,
    );
  } finally {
    await f.dispose();
  }
});

test("related vault lookup filters exact mailbox before pagination and total counting", async () => {
  const f = await database();
  try {
    await db(f.env).mutate([
      insert("platform_vault", {
        platform_name: "Match",
        account_email: "Match@example.test",
      }),
      insert("platform_vault", {
        platform_name: "Other",
        account_email: "nomatch@example.test",
      }),
    ]);
    const result = await f.request(
      "/api/vault?mailbox=MATCH%40example.test&limit=1",
    );
    assert.equal(result.response.status, 200);
    assert.equal(result.data.total, 1);
    assert.equal(result.data.data[0].platform_name, "Match");
  } finally {
    await f.dispose();
  }
});

test("credential rotation accepts previous key and fails closed for wrong or missing keys", async () => {
  const f = await database();
  try {
    const old = "fictional-old-key-at-least-thirty-two-characters";
    f.env.CREDENTIAL_ENCRYPTION_KEY = old;
    await db(f.env).mutate([insert("accounts", ACCOUNT)]);
    f.env.CREDENTIAL_ENCRYPTION_KEY =
      "fictional-new-key-at-least-thirty-two-characters";
    await assert.rejects(
      () => db(f.env).first("accounts", eq("id", 1)),
      /无法解密/,
    );
    f.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS = old;
    const row = await db(f.env).first("accounts", eq("id", 1));
    assert.equal(row?.refresh_token, ACCOUNT.refresh_token);
    await db(f.env).mutate([
      update(
        "accounts",
        and(eq("id", 1), eq("refresh_token", ACCOUNT.refresh_token)),
        { refresh_token: "new-key-token", password: ACCOUNT.password },
      ),
    ]);
    delete f.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS;
    assert.equal(
      (await db(f.env).first("accounts", eq("id", 1)))?.refresh_token,
      "new-key-token",
    );
    delete f.env.CREDENTIAL_ENCRYPTION_KEY;
    await assert.rejects(
      () => db(f.env).first("accounts", eq("id", 1)),
      /无法解密/,
    );
  } finally {
    await f.dispose();
  }
});
