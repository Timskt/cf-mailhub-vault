import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { database, ACCOUNT } from "./helpers";
import { app } from "../src/index";
import { sha256, verifyPassword, getSessionSecret } from "../src/auth";
import { runCleanup } from "../src/cron";
import { handleIncomingEmail } from "../src/email-handler";

let db: Awaited<ReturnType<typeof database>>;
before(async () => {
  db = await database();
});
after(async () => {
  await db.dispose();
});

test("existing database upgrades preserve credentials and create all management tables", async () => {
  const old = await database(false);
  try {
    await old.apply(old.files[0]);
    await old.apply(old.files[1]);
    await old.DB.prepare(
      "INSERT INTO accounts (email, client_id, refresh_token) VALUES (?, ?, ?)",
    )
      .bind(ACCOUNT.email, ACCOUNT.client_id, ACCOUNT.refresh_token)
      .run();
    await old.DB.prepare(
      "INSERT INTO platform_vault (platform_name,account_email,email_source) VALUES ('Existing','old@example.test','cf_domain')",
    ).run();
    await old.DB.prepare(
      "INSERT INTO cf_inbox_mails(recipient,sender) VALUES ('old@example.test','auth@example.test')",
    ).run();
    await old.apply(old.files[2]);
    const row = await old.DB.prepare("SELECT * FROM accounts").first<any>();
    assert.equal(row.refresh_token, ACCOUNT.refresh_token);
    assert.equal(row.auth_status, "unchecked");
    assert.equal(
      (
        await old.DB.prepare(
          "SELECT is_permanent FROM temp_mailboxes WHERE address='old@example.test'",
        ).first<any>()
      ).is_permanent,
      1,
    );
    assert.equal(
      (
        await old.DB.prepare(
          "SELECT is_protected FROM cf_inbox_mails WHERE recipient='old@example.test'",
        ).first<any>()
      ).is_protected,
      1,
    );
    for (const table of [
      "domains",
      "oauth_sessions",
      "auth_attempts",
      "temp_mailboxes",
    ])
      assert.ok(
        await old.DB.prepare("SELECT name FROM sqlite_master WHERE name = ?")
          .bind(table)
          .first(),
      );
  } finally {
    await old.dispose();
  }
});
test("without COOKIE_SECRET a random persistent signing key is used independently of the password", async () => {
  const env = { ...db.env, COOKIE_SECRET: undefined };
  const first = await getSessionSecret(env),
    second = await getSessionSecret(env);
  assert.equal(first, second);
  assert.ok(first.length > 60);
  assert.equal(first.includes(env.ADMIN_PASSWORD!), false);
});
test("mailbox compatibility and private endpoints require authentication, and reject cross-origin writes", async () => {
  for (const path of [
    "/api/vault",
    "/api/outlook/accounts",
    "/api/emails/list?address=sample@example.test",
    "/api/emails/view/1",
  ]) {
    assert.equal(
      (await db.request(path, undefined, "GET", {})).response.status,
      401,
    );
    assert.equal(
      (
        await db.request(
          `${path}${path.includes("?") ? "&" : "?"}api_key=test-api-key`,
          undefined,
          "GET",
          {},
        )
      ).response.status,
      401,
    );
  }
  assert.equal(
    (await db.request("/api/mailbox/generate", {}, "POST", {})).response.status,
    401,
  );
  assert.equal(
    (
      await db.request("/api/vault", {}, "POST", {
        "X-API-Key": "test-api-key",
        Origin: "https://evil.test",
      })
    ).response.status,
    403,
  );
  const disabled = await app.request(
    "https://mailhub.test/api/vault",
    {},
    { ...db.env, ADMIN_PASSWORD: undefined, API_KEY: undefined },
  );
  assert.equal(disabled.status, 503);
});
test("legacy password is upgraded; password hashes cannot log in; new password invalidates other sessions", async () => {
  const legacy = await sha256("legacy-admin-password");
  await db.DB.prepare(
    "INSERT INTO settings (key,value) VALUES ('admin_password',?)",
  )
    .bind(legacy)
    .run();
  const bad = await db.request(
    "/api/auth/login",
    { password: legacy },
    "POST",
    {},
  );
  assert.equal(bad.response.status, 401);
  const login = await db.request(
    "/api/auth/login",
    { password: "legacy-admin-password" },
    "POST",
    {},
  );
  assert.equal(login.data.success, true);
  const stored = await db.DB.prepare(
    "SELECT value FROM settings WHERE key='admin_password'",
  ).first<{ value: string }>();
  assert.ok(stored?.value.startsWith("pbkdf2:"));
  assert.equal(
    await verifyPassword("legacy-admin-password", stored!.value),
    true,
  );
  const cookie = login.response.headers.get("set-cookie")!.split(";")[0];
  assert.match(login.response.headers.get("set-cookie")!, /HttpOnly/i);
  assert.match(login.response.headers.get("set-cookie")!, /Secure/i);
  assert.equal(
    (await db.request("/api/vault", undefined, "GET", { Cookie: cookie }))
      .response.status,
    200,
  );
  const changed = await db.request(
    "/api/settings/password",
    { new_password: "new-admin-password" },
    "POST",
    { Cookie: cookie },
  );
  assert.equal(changed.data.success, true);
  assert.equal(
    (await db.request("/api/vault", undefined, "GET", { Cookie: cookie }))
      .response.status,
    401,
  );
  assert.equal(
    (
      await db.request("/api/vault", undefined, "GET", {
        Cookie: changed.response.headers.get("set-cookie")!.split(";")[0],
      })
    ).response.status,
    200,
  );
});
test("login attempts are bounded without trusting a client-controlled username", async () => {
  const headers = { "CF-Connecting-IP": "192.0.2.4" };
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await db.request(
          "/api/auth/login",
          { password: "wrong" },
          "POST",
          headers,
        )
      ).response.status,
      401,
    );
  const blocked = await db.request(
    "/api/auth/login",
    { password: "new-admin-password" },
    "POST",
    headers,
  );
  assert.equal(blocked.response.status, 429);
  assert.ok(Number(blocked.response.headers.get("Retry-After")) > 0);
});
test("domain defaults, enablement and validation apply to every mailbox generation path", async () => {
  assert.equal(
    (await db.request("/api/settings/domains", { domain: "HTTPS://bad.test/" }))
      .response.status,
    400,
  );
  const added = await db.request("/api/settings/domains", {
    domain: "Other.test.",
    remark: "第二域名",
  });
  assert.equal(added.data.success, true);
  assert.equal(
    (
      await db.request(
        "/api/settings/domains/other.test",
        { is_default: true },
        "PUT",
      )
    ).data.success,
    true,
  );
  const generated = await db.request("/api/mailboxes/generate", {});
  assert.ok(generated.data.data.address.endsWith("@other.test"));
  const compat = await db.request("/api/mailbox/custom", {
    prefix: "custom",
    domain: "mail.example.test",
    expiration: "1d",
  });
  assert.equal(compat.data.address, "custom@mail.example.test");
  const external = await db.request("/api/external/register", {
    platform_name: "Domain service",
    domain: "mail.example.test",
  });
  assert.ok(external.data.data.email.endsWith("@mail.example.test"));
  await db.request(
    "/api/settings/domains/other.test",
    { enabled: false },
    "PUT",
  );
  const publicDomains = await db.request("/api/domains", undefined, "GET", {});
  assert.equal(publicDomains.data.domains.includes("other.test"), false);
  for (const path of [
    "/api/mailboxes/generate",
    "/api/mailbox/generate",
    "/api/external/register",
  ]) {
    const result = await db.request(path, {
      domain: "other.test",
      platform_name: "should not allocate",
    });
    assert.equal(result.response.status, 400);
  }
  const fallback = await db.request("/api/mailboxes/generate", {});
  assert.ok(fallback.data.data.address.endsWith("@example.test"));
  assert.equal(
    (await db.request("/api/mailboxes/generate", { domain: "unknown.test" }))
      .response.status,
    400,
  );
});

async function ingest(
  address: string,
  id: string,
  body = "Your verification code is 123456",
) {
  const content = `From: Auth <auth@example.test>\r\nTo: ${address}\r\nMessage-ID: <${id}@mailhub.test>\r\nSubject: Verification\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
  let rejected = "";
  await handleIncomingEmail(
    {
      to: address,
      from: "auth@example.test",
      raw: new Blob([content]).stream(),
      rawSize: Buffer.byteLength(content),
      headers: new Headers(),
      setReject(reason: string) {
        rejected = reason;
      },
    } as ForwardableEmailMessage,
    db.env,
  );
  return rejected;
}
test("real MIME ingestion deduplicates, rejects disabled and expired destinations, preserves destroyed addresses", async () => {
  const generated = await db.request("/api/mailboxes/generate", {
    prefix: "lifecycle",
    domain: "example.test",
  });
  const box = generated.data.data;
  assert.equal(await ingest(box.address, "first"), "");
  assert.equal(await ingest(box.address, "first"), "");
  assert.equal(
    (
      await db.DB.prepare(
        "SELECT count(*) AS n FROM cf_inbox_mails WHERE recipient = ?",
      )
        .bind(box.address)
        .first<any>()
    ).n,
    1,
  );
  const code = await db.request(`/api/external/code?email=${box.address}`);
  assert.equal(code.data.code, "123456");
  await db.DB.prepare(
    "UPDATE temp_mailboxes SET expires_at='2000-01-01T00:00:00Z' WHERE id=?",
  )
    .bind(box.id)
    .run();
  assert.match(await ingest(box.address, "expired"), /expired/);
  assert.equal(
    (await db.request(`/api/mailboxes/${box.id}/extend`, { minutes: 60 })).data
      .success,
    true,
  );
  assert.equal(await ingest(box.address, "extended"), "");
  await db.request(`/api/mailboxes/${box.id}`, undefined, "DELETE");
  assert.match(await ingest(box.address, "destroyed"), /expired/);
  assert.match(await ingest("someone@other.test", "disabled"), /not enabled/);
});
test("platform binding and permanent mailboxes survive manual and scheduled cleanup", async () => {
  const created = await db.request("/api/vault", {
    platform_name: "Protected service",
    account_email: "protected@example.test",
    email_source: "cf_domain",
    password: "private",
    totp_secret: "PRIVATE2FA",
  });
  const id = created.data.data.id;
  const box = await db.DB.prepare(
    "SELECT * FROM temp_mailboxes WHERE address='protected@example.test'",
  ).first<any>();
  assert.equal(box.is_permanent, 1);
  await ingest(box.address, "protected");
  await db.DB.prepare(
    "UPDATE cf_inbox_mails SET created_at='2000-01-01 00:00:00'",
  ).run();
  assert.equal(
    (await db.request(`/api/mailboxes/${box.id}`, undefined, "DELETE")).response
      .status,
    400,
  );
  assert.equal(
    (await db.request(`/api/mailboxes/${box.id}/toggle-permanent`, {})).response
      .status,
    400,
  );
  await db.request("/api/cf-mails/clean", {});
  await runCleanup(db.env);
  assert.ok(
    await db.DB.prepare("SELECT id FROM cf_inbox_mails WHERE recipient=?")
      .bind(box.address)
      .first(),
  );
  const list = await db.request("/api/vault?q=Protected");
  assert.equal(list.data.data[0].has_password, 1);
  assert.equal("password" in list.data.data[0], false);
  assert.equal("totp_secret" in list.data.data[0], false);
  await db.request(`/api/vault/${id}`, undefined, "DELETE");
  await db.request(`/api/mailboxes/${box.id}/toggle-permanent`, {});
  await db.request("/api/cf-mails/clean", {});
  assert.equal(
    await db.DB.prepare("SELECT id FROM cf_inbox_mails WHERE recipient=?")
      .bind(box.address)
      .first(),
    null,
  );
});
test("vault backup restore deduplicates and reconciles CF mailbox protection; search spans unloaded pages", async () => {
  const entries = Array.from({ length: 35 }, (_, i) => ({
    platform_name: `Restore service ${i}`,
    account_email: `restore${i}@example.test`,
    username: `user${i}`,
    password: "restore-password",
    email_source: "cf_domain",
  }));
  assert.equal(
    (await db.request("/api/vault/import", { accounts: entries })).data.success,
    true,
  );
  assert.match(
    (await db.request("/api/vault/import", { accounts: entries })).data.message,
    /0 条/,
  );
  assert.equal(
    (await db.request("/api/vault?limit=2&page=2&q=Restore")).data.data.length,
    2,
  );
  const search = await db.request("/api/search?q=restore0%40example.test");
  assert.equal(search.data.data.vault.length, 1);
  assert.equal("password" in search.data.data.vault[0], false);
  const restored = await db.DB.prepare(
    "SELECT is_permanent, associated_vault_id FROM temp_mailboxes WHERE address='restore0@example.test'",
  ).first<any>();
  assert.equal(restored.is_permanent, 1);
  assert.ok(restored.associated_vault_id);
  const backup = await db.request("/api/vault/export");
  assert.ok(
    backup.data.accounts.some((a: any) => a.password === "restore-password"),
  );
  const settings = await db.request("/api/settings");
  assert.equal("api_key" in settings.data.data, false);
});
test("incoming mail without Message-ID is deduplicated by content; pinned mail survives expiry cleanup", async () => {
  const content =
    "From: auth@example.test\r\nTo: retry@example.test\r\nSubject: Retried message\r\n\r\nVerification code: 246810";
  for (let i = 0; i < 2; i++)
    await handleIncomingEmail(
      {
        to: "retry@example.test",
        from: "auth@example.test",
        raw: new Blob([content]).stream(),
        rawSize: Buffer.byteLength(content),
        headers: new Headers(),
        setReject() {
          assert.fail("unexpected rejection");
        },
      } as unknown as ForwardableEmailMessage,
      db.env,
    );
  assert.equal(
    (
      await db.DB.prepare(
        "SELECT count(*) AS n FROM cf_inbox_mails WHERE recipient='retry@example.test'",
      ).first<any>()
    ).n,
    1,
  );
  await db.DB.prepare(
    "UPDATE cf_inbox_mails SET is_pinned=1 WHERE recipient='retry@example.test'",
  ).run();
  await db.DB.prepare(
    "UPDATE temp_mailboxes SET expires_at='2000-01-01T00:00:00Z' WHERE address='retry@example.test'",
  ).run();
  await runCleanup(db.env);
  assert.ok(
    await db.DB.prepare(
      "SELECT id FROM cf_inbox_mails WHERE recipient='retry@example.test'",
    ).first(),
  );
});
