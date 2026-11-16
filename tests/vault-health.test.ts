import { test } from "node:test";
import assert from "node:assert/strict";
import { database, ACCOUNT, microsoft, json } from "./helpers";

test("vault reports missing Outlook membership and follows real import/check/renewal/disable/delete transitions", async () => {
  const d = await database();
  try {
    const created = await d.request("/api/vault", {
      platform_name: "Outlook",
      account_email: ACCOUNT.email,
      email_source: "outlook",
      password: "vault-secret",
      totp_secret: "totp-private",
    });
    const id = created.data.data.id;
    const read = async () =>
      (await d.request(`/api/vault?platform=Outlook`)).data.data[0];
    let row = await read();
    assert.equal(row.status, "active"); // A manual registration is not evidence of a working mailbox.
    assert.equal(row.mailbox.state, "missing");
    assert.equal(row.needs_attention, true);
    assert.equal(row.mailbox.can_lookup, false);
    assert.equal(row.mailbox.action, "connect_outlook");
    assert.equal("password" in row, false);
    assert.equal("totp_secret" in row, false);
    assert.equal(row.has_password, 1);
    const imported = await d.request("/api/outlook/accounts", {
      ...ACCOUNT,
      sync_to_vault: false,
    });
    assert.equal(imported.response.status, 200);
    row = await read();
    assert.equal(row.mailbox.state, "unchecked");
    assert.equal(row.needs_attention, false);
    const accountId = row.mailbox.account_id;
    await microsoft(
      (url) =>
        url.hostname.startsWith("login.")
          ? json({
              access_token: "fake",
              refresh_token: "M.rotated-fictional-test-token-012345",
            })
          : json({ value: [] }),
      async () => {
        assert.equal(
          (await d.request(`/api/outlook/accounts/${accountId}/check`, {}))
            .response.status,
          200,
        );
      },
    );
    assert.equal((await read()).mailbox.state, "connected");
    await d.DB.prepare(
      "UPDATE accounts SET token_refresh_status='retrying', last_token_attempt_at=? WHERE id=?",
    )
      .bind(new Date().toISOString(), accountId)
      .run();
    row = await read();
    assert.equal(row.mailbox.state, "error");
    assert.equal(row.needs_attention, true);
    await d.DB.prepare(
      "UPDATE accounts SET token_refresh_status='reauth_required' WHERE id=?",
    )
      .bind(accountId)
      .run();
    assert.equal((await read()).mailbox.state, "reauth_required");
    await d.DB.prepare(
      "UPDATE accounts SET token_refresh_status='healthy', last_checked_at='2020-01-01 00:00:00' WHERE id=?",
    )
      .bind(accountId)
      .run();
    assert.equal((await read()).mailbox.state, "stale");
    await d.request(
      `/api/outlook/accounts/${accountId}`,
      { status: "disabled" },
      "PUT",
    );
    row = await read();
    assert.equal(row.mailbox.state, "disabled");
    assert.equal(row.mailbox.can_lookup, false);
    await d.request(`/api/outlook/accounts/${accountId}`, undefined, "DELETE");
    assert.equal((await read()).mailbox.state, "missing");
    await d.request("/api/outlook/accounts", {
      ...ACCOUNT,
      sync_to_vault: false,
    });
    assert.equal((await read()).mailbox.state, "unchecked");
    assert.equal(
      (await d.request(`/api/vault/${id}`)).data.data.password,
      "vault-secret",
    );
    const safeResponses = JSON.stringify([
      (await d.request("/api/vault/platforms")).data,
      (await d.request("/api/vault/stats")).data,
      await read(),
    ]);
    for (const secret of [
      ACCOUNT.refresh_token,
      ACCOUNT.password,
      "vault-secret",
      "totp-private",
      "M.rotated-fictional-test-token-012345",
    ])
      assert.equal(safeResponses.includes(secret), false);
  } finally {
    await d.dispose();
  }
});

test("platform overview groups case-insensitively without a 50-platform cap; search, triage, sorting and pages count matching accounts", async () => {
  const d = await database();
  try {
    const accounts = [
      ...Array.from({ length: 65 }, (_, i) => ({
        platform_name: i % 2 ? "Outlook" : "outlook",
        account_email: `member${i}@outlook.com`,
        email_source: "outlook",
        username: `user${i}`,
        remark: i === 64 ? "needle" : "",
      })),
      ...Array.from({ length: 55 }, (_, i) => ({
        platform_name: `Service ${String(i).padStart(2, "0")}`,
        account_email: `service${i}@example.test`,
        email_source: "external",
        category: "Work",
      })),
    ];
    await d.request("/api/vault/import", { accounts });
    const stats = (await d.request("/api/vault/stats")).data.data;
    assert.equal(stats.total_platforms, 56);
    assert.equal(stats.total_vault_accounts, 120);
    assert.equal(stats.attention_accounts, 65);
    const all = (await d.request("/api/vault/platforms")).data;
    assert.equal(all.data.length, 56);
    const page = (
      await d.request("/api/vault/platforms?page=1&limit=2&sort=count")
    ).data;
    assert.equal(page.total, 56);
    assert.equal(page.summary.accounts, 120);
    assert.equal(page.data.length, 2);
    assert.equal(page.data[0].count, 65);
    assert.equal(page.data[0].attention_count, 65);
    const last = (await d.request("/api/vault/platforms?page=28&limit=2")).data;
    assert.equal(last.data.length, 2);
    const attention = (await d.request("/api/vault/platforms?triage=attention"))
      .data;
    assert.equal(attention.data.length, 1);
    assert.equal(attention.summary.accounts, 65);
    const search = (await d.request("/api/vault/platforms?q=needle")).data;
    assert.equal(search.data.length, 1);
    assert.equal(search.data[0].count, 1);
    const list = (
      await d.request(
        "/api/vault?platform=OUTLOOK&triage=attention&page=4&limit=20",
      )
    ).data;
    assert.equal(list.total, 65);
    assert.equal(list.data.length, 5);
    assert.ok(list.data.every((r: any) => r.mailbox.state === "missing"));
    assert.equal(
      (await d.request("/api/vault/platforms?category=Work")).data.total,
      55,
    );
    assert.equal(
      (await d.request("/api/vault/platforms?q=does-not-exist")).data.summary
        .accounts,
      0,
    );
    assert.equal(
      (await d.request("/api/vault/platforms?triage=bogus")).response.status,
      400,
    );
    assert.equal(
      (await d.request("/api/vault/platforms?limit=500")).response.status,
      400,
    );
    assert.equal(
      (await d.request("/api/vault/platforms", undefined, "GET", {})).response
        .status,
      401,
    );
  } finally {
    await d.dispose();
  }
});

test("domain and external availability stay distinct from manual account status; unknown Outlook timestamps never claim connection", async () => {
  const d = await database();
  try {
    await d.request("/api/vault/import", {
      accounts: [
        {
          platform_name: "A",
          account_email: "a@example.test",
          email_source: "cf_domain",
        },
        {
          platform_name: "B",
          account_email: "b@unconfigured.test",
          email_source: "cf_domain",
        },
        {
          platform_name: "C",
          account_email: "c@external.test",
          email_source: "external",
          status: "banned",
        },
        {
          platform_name: "D",
          account_email: ACCOUNT.email,
          email_source: "outlook",
        },
      ],
    });
    await d.request("/api/outlook/accounts", {
      ...ACCOUNT,
      sync_to_vault: false,
    });
    await d.DB.prepare(
      "UPDATE accounts SET auth_status='healthy', last_checked_at='' WHERE email=?",
    )
      .bind(ACCOUNT.email)
      .run();
    const read = async (name: string) =>
      (await d.request(`/api/vault?platform=${name}`)).data.data[0];
    assert.equal((await read("A")).mailbox.state, "unchecked");
    assert.equal((await read("B")).mailbox.state, "missing");
    assert.equal((await read("B")).mailbox.can_lookup, true); // Existing CF mail remains accessible.
    assert.equal((await read("C")).mailbox.state, "external");
    assert.equal((await read("C")).needs_attention, true);
    assert.equal((await read("D")).mailbox.state, "unchecked");
    const unchecked = (await d.request("/api/vault?triage=unchecked")).data;
    assert.equal(unchecked.total, 2);
    await d.DB.prepare(
      "INSERT INTO domains (domain,enabled,dns_status) VALUES ('example.test',1,'ready')",
    ).run();
    assert.equal((await read("A")).mailbox.state, "configured");
    await d.DB.prepare(
      "UPDATE domains SET enabled=0 WHERE domain='example.test'",
    ).run();
    assert.equal((await read("A")).mailbox.state, "disabled");
    const result = (await d.request("/api/vault/platforms?triage=attention"))
      .data;
    assert.equal(result.summary.accounts, 3);
  } finally {
    await d.dispose();
  }
});
