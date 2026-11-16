import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import {
  database,
  ACCOUNT,
  APP_ID,
  TOKEN,
  microsoft,
  json,
  mail,
} from "./helpers";
import { fetchEmails, fetchMessage, validNextLink } from "../src/graph";
import { selectCode } from "../src/outlook";
import { withOutlook } from "../src/outlook";
import type { OutlookAccount } from "../src/types";
import { runTokenRefresh } from "../src/cron";

let db: Awaited<ReturnType<typeof database>>;
before(async () => {
  db = await database();
});
after(async () => {
  await db.dispose();
});

test("Outlook batch import deduplicates, masks preview, handles skips/updates and supports export restore", async () => {
  const preview = await db.request("/api/outlook/parse-preview", {
    raw_text: JSON.stringify([ACCOUNT, { ...ACCOUNT, remark: "last" }]),
  });
  assert.equal(preview.data.valid_count, 1);
  assert.equal(preview.data.duplicate_count, 1);
  assert.equal(JSON.stringify(preview.data).includes(TOKEN), false);
  assert.equal(
    (await db.request("/api/outlook/batch-import", { accounts: [ACCOUNT] }))
      .data.created,
    1,
  );
  const skip = await db.request("/api/outlook/batch-import", {
    accounts: [{ ...ACCOUNT, password: "replacement" }],
  });
  assert.equal(skip.data.skipped, 1);
  assert.equal(skip.data.count, 0);
  const update = await db.request("/api/outlook/batch-import", {
    accounts: [{ ...ACCOUNT, refresh_token: TOKEN + "rotated", password: "" }],
    duplicate_mode: "update",
  });
  assert.equal(update.data.updated, 1);
  const stored = await db.DB.prepare("SELECT * FROM accounts WHERE email=?")
    .bind(ACCOUNT.email)
    .first<any>();
  assert.equal(stored.password, ACCOUNT.password);
  assert.equal(stored.refresh_token, TOKEN + "rotated");
  assert.equal(stored.auth_status, "unchecked");
  const vaults = await db.DB.prepare(
    "SELECT * FROM platform_vault WHERE email_source='outlook'",
  ).all<any>();
  assert.equal(vaults.results.length, 1);
  assert.equal(vaults.results[0].password, ACCOUNT.password);
  const list = await db.request("/api/outlook/accounts");
  assert.equal("password" in list.data.data[0], false);
  assert.equal("refresh_token" in list.data.data[0], false);
  const exported = await db.request(
    `/api/outlook/accounts/export?ids=${stored.id}`,
  );
  const imported = await db.request("/api/outlook/batch-import", {
    raw_text: JSON.stringify(exported.data),
  });
  assert.equal(imported.data.skipped, 1);
  assert.equal(imported.data.invalid_count, 0);
});
test("200-row imports stay within D1 bind limits and preserve skip/update counts", async () => {
  const accounts = Array.from({ length: 200 }, (_, i) => ({
    ...ACCOUNT,
    email: `bulk${i}@outlook.com`,
  }));
  const created = await db.request("/api/outlook/batch-import", {
    accounts,
    sync_to_vault: true,
  });
  assert.equal(created.data.created, 200);
  assert.equal(created.data.invalid_count, 0);
  const updated = await db.request("/api/outlook/batch-import", {
    accounts,
    duplicate_mode: "update",
  });
  assert.equal(updated.data.updated, 200);
  assert.equal(updated.data.created, 0);
});
test("groups, tags, bulk actions, filtering and account edits compose without losing credentials", async () => {
  const group = await db.request("/api/outlook/groups", {
    name: "Work",
    color: "#0071e3",
  });
  const tag = await db.request("/api/outlook/tags", {
    name: "Priority",
    color: "#008844",
  });
  assert.equal(group.data.success, true);
  assert.equal(tag.data.success, true);
  const account = await db.DB.prepare("SELECT * FROM accounts WHERE email=?")
    .bind(ACCOUNT.email)
    .first<any>();
  await db.request("/api/outlook/accounts/batch", {
    action: "move",
    ids: [account.id],
    group_id: group.data.data.id,
  });
  await db.request("/api/outlook/accounts/batch", {
    action: "tag",
    ids: [account.id],
    tag_id: tag.data.data.id,
  });
  const filtered = await db.request(
    `/api/outlook/accounts?group_id=${group.data.data.id}&tag_id=${tag.data.data.id}&limit=1`,
  );
  assert.equal(filtered.data.total, 1);
  assert.equal(filtered.data.data[0].tags[0].name, "Priority");
  await db.request("/api/outlook/accounts/batch", {
    action: "untag",
    ids: [account.id],
    tag_id: tag.data.data.id,
  });
  assert.equal(
    (await db.request(`/api/outlook/accounts?tag_id=${tag.data.data.id}`)).data
      .total,
    0,
  );
  await db.request(
    `/api/outlook/accounts/${account.id}`,
    { remark: "Edited", status: "disabled" },
    "PUT",
  );
  const detail = await db.request(`/api/outlook/accounts/${account.id}`);
  assert.equal(detail.data.data.refresh_token, account.refresh_token);
  assert.equal(detail.data.data.password, account.password);
  assert.equal(detail.data.data.status, "disabled");
  const disabled = await db.request(
    `/api/outlook/accounts/${account.id}/emails`,
  );
  assert.equal(disabled.data.error, "ACCOUNT_DISABLED");
  await db.request("/api/outlook/accounts/batch", {
    action: "enable",
    ids: [account.id],
  });
  await db.request(
    `/api/outlook/groups/${group.data.data.id}`,
    undefined,
    "DELETE",
  );
  assert.equal(
    (await db.request(`/api/outlook/accounts/${account.id}`)).data.data
      .group_id,
    1,
  );
  assert.equal(
    (await db.request("/api/outlook/groups/1", undefined, "DELETE")).response
      .status,
    400,
  );
});
test("Graph pagination preserves opaque cursor and rejects bearer-token exfiltration targets", async () => {
  const next =
    "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=a%2Bb%2F%3D&$top=20";
  assert.equal(validNextLink(next, "inbox"), true);
  assert.equal(
    validNextLink(
      "https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages?$skip=20",
      "inbox",
    ),
    true,
  );
  for (const link of [
    "https://evil.test/v1.0/me/mailFolders/inbox/messages",
    "https://graph.microsoft.com@evil.test/v1.0/me/mailFolders/inbox/messages",
    "https://graph.microsoft.com/v1.0/me/mailFolders/junkemail/messages",
    "https://graph.microsoft.com/v1.0/me/drive",
    next + "#fragment",
  ])
    assert.equal(validNextLink(link, "inbox"), false);
  let requested = "";
  await microsoft(
    (url, init) => {
      requested = url.href;
      assert.equal(init.redirect, "manual");
      return json({ value: [mail("a")], "@odata.nextLink": next });
    },
    async () => {
      assert.equal(
        (await fetchEmails("test-access", { nextLink: next })).data?.nextLink,
        next,
      );
      assert.equal(requested, next);
      requested = "";
      assert.equal(
        (await fetchEmails("test-access", { nextLink: "https://evil.test/" }))
          .error?.code,
        "INVALID_QUERY",
      );
      assert.equal(requested, "");
    },
  );
});
test("concurrent credential edits cannot be overwritten by an in-flight token refresh", async () => {
  const account = await db.DB.prepare("SELECT * FROM accounts WHERE email=?")
    .bind(ACCOUNT.email)
    .first<OutlookAccount>();
  assert.ok(account);
  const replacement = TOKEN + "_new_manual_import";
  await microsoft(
    async () => {
      await db.DB.prepare(
        "UPDATE accounts SET refresh_token=?,auth_status='unchecked' WHERE id=?",
      )
        .bind(replacement, account.id)
        .run();
      return json({
        access_token: "old-request-access",
        refresh_token: TOKEN + "_stale_response",
      });
    },
    async () => {
      const result = await withOutlook(db.env, account, async () => ({
        data: true,
      }));
      assert.equal(result.data, true);
      const row = await db.DB.prepare(
        "SELECT refresh_token,auth_status FROM accounts WHERE id=?",
      )
        .bind(account.id)
        .first<any>();
      assert.equal(row.refresh_token, replacement);
      assert.equal(row.auth_status, "unchecked");
    },
  );
});
test("Graph search avoids incompatible orderby and invalid upstream responses are errors", async () => {
  await microsoft(
    (url) => {
      assert.equal(url.searchParams.get("$search"), '"sign in"');
      assert.equal(url.searchParams.has("$orderby"), false);
      return json({ value: [mail("search")] });
    },
    async () => {
      assert.equal(
        (await fetchEmails("access", { keyword: "sign in" })).data?.items
          .length,
        1,
      );
    },
  );
  await microsoft(
    () => json({ value: [{ subject: "missing ID" }] }),
    async () => {
      assert.equal(
        (await fetchEmails("access")).error?.code,
        "INVALID_RESPONSE",
      );
    },
  );
  await microsoft(
    () => json({ error: { code: "ErrorAccessDenied" } }, 403),
    async () => {
      const result = await fetchMessage("access", "message");
      assert.match(result.error!.message, /权限/);
    },
  );
});
test("OTP selection finds non-first and junk messages, filters by age/sender, deduplicates", () => {
  const messages = [
    mail("newsletter", "News update", "2026-11-14T09:00:00Z"),
    mail("otp", "Your verification code is 135790", "2026-11-14T08:30:00Z"),
    mail("old", "Your code is 999999", "2026-11-13T08:00:00Z"),
  ];
  assert.equal(selectCode(messages).code, "135790");
  assert.equal(
    selectCode(messages, { since: "2026-11-14T08:45:00.000Z" }).code,
    "",
  );
  assert.equal(
    selectCode(messages, { sender: "no-match.test" }).has_mail,
    false,
  );
  assert.equal(selectCode([messages[1], messages[1]]).scanned, 1);
});
test("vault, external and cron Outlook requests persist rotated tokens and expose actual Microsoft failures", async () => {
  const row = await db.DB.prepare("SELECT * FROM accounts WHERE email=?")
    .bind(ACCOUNT.email)
    .first<any>();
  let sequence = 0;
  const requestedFolders: string[] = [];
  await microsoft(
    (url, init) => {
      if (url.hostname === "login.microsoftonline.com") {
        assert.ok(new URLSearchParams(String(init.body)).get("refresh_token"));
        sequence++;
        return json({
          access_token: "access",
          refresh_token: `${TOKEN}_rotation_${sequence}`,
        });
      }
      requestedFolders.push(url.pathname);
      return json({
        value: url.pathname.includes("junkemail")
          ? [mail("junk-otp", "Verification code 654321")]
          : [mail("news", "Monthly newsletter")],
      });
    },
    async () => {
      const vault = await db.DB.prepare(
        "SELECT id FROM platform_vault WHERE account_email=? AND email_source='outlook'",
      )
        .bind(ACCOUNT.email)
        .first<any>();
      assert.equal(
        (await db.request(`/api/vault/${vault.id}/code`)).data.data.code,
        "654321",
      );
      assert.equal(
        (
          await db.DB.prepare("SELECT refresh_token FROM accounts WHERE id=?")
            .bind(row.id)
            .first<any>()
        ).refresh_token,
        `${TOKEN}_rotation_1`,
      );
      assert.equal(
        (await db.request(`/api/external/code?email=${ACCOUNT.email}`)).data
          .code,
        "654321",
      );
      assert.ok(requestedFolders.some((p) => p.includes("junkemail")));
      await db.DB.prepare("UPDATE accounts SET status='disabled' WHERE id != ?")
        .bind(row.id)
        .run();
      await db.DB.prepare(
        "UPDATE accounts SET next_token_refresh_at='' WHERE id=?",
      )
        .bind(row.id)
        .run();
      await runTokenRefresh(db.env);
      assert.equal(
        (
          await db.DB.prepare("SELECT refresh_token FROM accounts WHERE id=?")
            .bind(row.id)
            .first<any>()
        ).refresh_token,
        `${TOKEN}_rotation_3`,
      );
    },
  );
  await microsoft(
    () =>
      json(
        {
          error: "invalid_grant",
          error_description: "UPSTREAM_SECRET_NOT_TO_ECHO",
        },
        400,
      ),
    async () => {
      const failed = await db.request(`/api/outlook/accounts/${row.id}/code`);
      assert.equal(failed.data.success, false);
      assert.equal(failed.data.error, "invalid_grant");
      assert.equal(
        JSON.stringify(failed.data).includes("UPSTREAM_SECRET"),
        false,
      );
      assert.equal(
        (
          await db.DB.prepare("SELECT auth_status FROM accounts WHERE id=?")
            .bind(row.id)
            .first<any>()
        ).auth_status,
        "reauth_required",
      );
      await runTokenRefresh(db.env); // no active accounts are eligible; must not report them healthy
    },
  );
});
test("mail reader extracts codes, streams attachments and surfaces permission errors on delete", async () => {
  const row = await db.DB.prepare("SELECT id FROM accounts WHERE email=?")
    .bind(ACCOUNT.email)
    .first<any>();
  await microsoft(
    (url) => {
      if (url.hostname === "login.microsoftonline.com")
        return json({ access_token: "access" });
      if (url.pathname.endsWith("/$value"))
        return new Response("attachment-content", {
          headers: { "Content-Type": "text/plain" },
        });
      if (url.pathname.endsWith("/attachments"))
        return json({
          value: [
            {
              id: "file/a",
              name: "test'<.txt",
              size: 18,
              contentType: "text/plain",
            },
          ],
        });
      return json({
        ...mail("message/a"),
        hasAttachments: true,
        body: {
          contentType: "html",
          content: "<p>Verification code: 246810</p>",
        },
      });
    },
    async () => {
      const message = await db.request(
        `/api/outlook/accounts/${row.id}/messages/message%2Fa`,
      );
      assert.equal(message.data.data.verification_code, "246810");
      assert.equal(message.data.data.attachments.length, 1);
      const { app } = await import("../src/index");
      const attachment = await app.request(
        `https://mailhub.test/api/outlook/accounts/${row.id}/messages/message%2Fa/attachments/file%2Fa`,
        { headers: { "X-API-Key": "test-api-key" } },
        db.env,
      );
      assert.equal(await attachment.text(), "attachment-content");
      assert.equal(attachment.headers.get("content-disposition"), "attachment");
    },
  );
  await microsoft(
    (url) =>
      url.hostname === "login.microsoftonline.com"
        ? json({ access_token: "access" })
        : json({ error: { code: "ErrorAccessDenied" } }, 403),
    async () => {
      const deleted = await db.request(
        `/api/outlook/accounts/${row.id}/messages/message`,
        undefined,
        "DELETE",
      );
      assert.equal(deleted.data.success, false);
      assert.match(deleted.data.message, /Mail.ReadWrite/);
    },
  );
});
test("OAuth uses own app PKCE and a session-bound single-use state", async () => {
  db.env.MICROSOFT_CLIENT_ID = APP_ID;
  db.env.MICROSOFT_CLIENT_SECRET = "fictional-app-secret";
  const login = await db.request(
    "/api/auth/login",
    { password: db.env.ADMIN_PASSWORD },
    "POST",
    {},
  );
  const cookie = login.response.headers.get("set-cookie")!.split(";")[0];
  const start = await db.request("/api/outlook/oauth/start", {}, "POST", {
    Cookie: cookie,
  });
  assert.equal(start.data.success, true);
  const authorize = new URL(start.data.url);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    authorize.searchParams.get("redirect_uri"),
    "https://mailhub.test/api/outlook/oauth/callback",
  );
  const state = authorize.searchParams.get("state")!;
  await microsoft(
    (url, init) => {
      if (url.hostname === "login.microsoftonline.com") {
        const params = new URLSearchParams(String(init.body));
        assert.equal(params.get("client_secret"), "fictional-app-secret");
        assert.equal(params.get("code_verifier")!.length, 64);
        return json({
          access_token: "access",
          refresh_token: TOKEN + "_oauth",
        });
      }
      return json({ mail: "oauth@outlook.com" });
    },
    async () => {
      const { app } = await import("../src/index");
      const callback = () =>
        app.request(
          `https://mailhub.test/api/outlook/oauth/callback?state=${state}&code=fake-code`,
          { headers: { Cookie: cookie } },
          db.env,
        );
      assert.match(await (await callback()).text(), /已授权并保存/);
      assert.match(await (await callback()).text(), /过期或已使用/);
      const saved = await db.DB.prepare(
        "SELECT refresh_token FROM accounts WHERE email='oauth@outlook.com'",
      ).first<any>();
      assert.equal(saved.refresh_token, TOKEN + "_oauth");
    },
  );
});
