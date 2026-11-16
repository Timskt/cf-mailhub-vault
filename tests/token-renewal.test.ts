import test from "node:test";
import assert from "node:assert/strict";
import { database, ACCOUNT, TOKEN, microsoft, json } from "./helpers";
import { runTokenRefresh } from "../src/cron";

test("scheduled renewal saves rotated credentials without reading mail and only selects due accounts", async () => {
  const fixture = await database();
  try {
    await fixture.request("/api/outlook/batch-import", {
      accounts: [ACCOUNT],
      sync_to_vault: false,
    });
    let calls = 0;
    await microsoft(
      (url, init) => {
        assert.equal(url.hostname, "login.microsoftonline.com");
        assert.equal(
          new URLSearchParams(String(init.body)).get("refresh_token"),
          TOKEN,
        );
        assert.equal(
          new URLSearchParams(String(init.body)).get("scope"),
          "https://graph.microsoft.com/.default offline_access",
        );
        calls++;
        return json({
          access_token: "fictional-access",
          refresh_token: TOKEN + "_renewed",
        });
      },
      async () => {
        await runTokenRefresh(fixture.env);
        await runTokenRefresh(fixture.env);
      },
    );
    assert.equal(calls, 1);
    const row = await fixture.DB.prepare("SELECT * FROM accounts").first<any>();
    assert.equal(row.refresh_token, TOKEN + "_renewed");
    assert.equal(row.token_refresh_status, "healthy");
    assert.equal(row.token_refresh_failures, 0);
    assert.ok(Date.parse(row.last_token_refresh_at) <= Date.now());
    assert.ok(Date.parse(row.next_token_refresh_at) > Date.now() + 5 * 3600000);
    assert.equal(row.auth_status, "unchecked");
  } finally {
    await fixture.dispose();
  }
});

test("temporary failures retry, revoked tokens stop, and replacing credentials resumes renewal", async () => {
  const fixture = await database();
  try {
    await fixture.request("/api/outlook/batch-import", {
      accounts: [ACCOUNT],
      sync_to_vault: false,
    });
    await microsoft(
      () => json({ error: "temporarily_unavailable" }, 503),
      () => runTokenRefresh(fixture.env),
    );
    let row = await fixture.DB.prepare("SELECT * FROM accounts").first<any>();
    assert.equal(row.token_refresh_status, "retrying");
    assert.equal(row.token_refresh_failures, 1);
    assert.equal(row.refresh_token, TOKEN);
    const delay = Date.parse(row.next_token_refresh_at) - Date.now();
    assert.ok(delay > 14 * 60000 && delay <= 15 * 60000);
    await fixture.DB.prepare(
      "UPDATE accounts SET next_token_refresh_at=''",
    ).run();
    let calls = 0;
    await microsoft(
      () => {
        calls++;
        return json({ error: "invalid_grant" }, 400);
      },
      async () => {
        await runTokenRefresh(fixture.env);
        await runTokenRefresh(fixture.env);
      },
    );
    assert.equal(calls, 1);
    row = await fixture.DB.prepare("SELECT * FROM accounts").first<any>();
    assert.equal(row.token_refresh_status, "reauth_required");
    assert.equal(row.auth_status, "reauth_required");
    assert.equal(row.next_token_refresh_at, "");
    await fixture.request("/api/outlook/batch-import", {
      accounts: [{ ...ACCOUNT, refresh_token: TOKEN + "_replacement" }],
      duplicate_mode: "update",
      sync_to_vault: false,
    });
    row = await fixture.DB.prepare("SELECT * FROM accounts").first<any>();
    assert.equal(row.token_refresh_status, "pending");
    assert.equal(row.token_refresh_failures, 0);
    assert.equal(row.token_refresh_error, "");
    await microsoft(
      () => json({ access_token: "new-access" }),
      () => runTokenRefresh(fixture.env),
    );
    row = await fixture.DB.prepare("SELECT * FROM accounts").first<any>();
    assert.equal(row.token_refresh_status, "healthy");
  } finally {
    await fixture.dispose();
  }
});
