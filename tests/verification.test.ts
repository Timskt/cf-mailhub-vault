import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { database, ACCOUNT, microsoft, json, mail } from "./helpers";

let db: Awaited<ReturnType<typeof database>>;
let id: number;
before(async () => {
  db = await database();
  await db.request("/api/outlook/batch-import", { accounts: [ACCOUNT] });
  id = Number(
    (
      await db.DB.prepare("SELECT id FROM accounts WHERE email=?")
        .bind(ACCOUNT.email)
        .first<any>()
    ).id,
  );
});
after(async () => {
  await db.dispose();
});
const cursor = (folder: string) =>
  `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?$skip=10&$top=10`;

test("quick lookup checks ten per folder first and pushes since to Microsoft", async () => {
  let pages = 0;
  await microsoft(
    (url) => {
      if (url.hostname === "login.microsoftonline.com")
        return json({ access_token: "access" });
      pages++;
      assert.equal(url.searchParams.get("$top"), "10");
      assert.match(
        url.searchParams.get("$filter") || "",
        /receivedDateTime ge 2026-11-14T07:00:00.000Z/,
      );
      assert.match(url.searchParams.get("$select") || "", /,body$/);
      const folder = url.pathname.includes("junkemail") ? "junkemail" : "inbox";
      return json({
        value:
          folder === "inbox"
            ? [
                mail("code", "Your code is 123456", "2026-11-14T10:00:00Z"),
                mail("news", "News", "2026-11-14T08:00:00Z"),
              ]
            : [mail("junk", "Newsletter", "2026-11-14T07:00:00Z")],
        "@odata.nextLink": cursor(folder),
      });
    },
    async () => {
      const r = await db.request(
        `/api/outlook/accounts/${id}/code?since=2026-11-14T07%3A00%3A00Z`,
      );
      assert.equal(r.data.data.code, "123456");
      assert.equal(r.data.data.scanned, 3);
      assert.ok(r.data.data.checked_at);
      assert.equal(pages, 2);
    },
  );
});
test("continues a dense folder when it can contain a newer match than the other folder", async () => {
  let pages = 0;
  await microsoft(
    (url) => {
      if (url.hostname === "login.microsoftonline.com")
        return json({ access_token: "access" });
      pages++;
      if (!url.pathname.includes("junkemail"))
        return json({
          value: [mail("old", "Your code is 111111", "2026-11-14T07:00:00Z")],
        });
      if (url.searchParams.has("$skip")) {
        assert.equal(url.searchParams.get("$top"), "15");
        return json({
          value: [mail("new", "Your code is 222222", "2026-11-14T08:00:00Z")],
        });
      }
      return json({
        value: [mail("noise", "A newsletter", "2026-11-14T09:00:00Z")],
        "@odata.nextLink": cursor("junkemail"),
      });
    },
    async () => {
      const r = await db.request(`/api/outlook/accounts/${id}/code`);
      assert.equal(r.data.data.code, "222222");
      assert.equal(pages, 3);
    },
  );
});
test("reports throttling instead of returning a potentially stale success from a partial scan", async () => {
  await microsoft(
    (url) => {
      if (url.hostname === "login.microsoftonline.com")
        return json({ access_token: "access" });
      if (url.searchParams.has("$skip"))
        return json({ error: { code: "TooManyRequests" } }, 429);
      return json({
        value: [mail("noise", "Newsletter")],
        "@odata.nextLink": cursor(
          url.pathname.includes("junkemail") ? "junkemail" : "inbox",
        ),
      });
    },
    async () => {
      const r = await db.request(`/api/outlook/accounts/${id}/code`);
      assert.equal(r.data.success, false);
      assert.equal(r.response.status, 400);
    },
  );
});
test("mail list returns detected code and button link without exposing full body or marking it read", async () => {
  await microsoft(
    (url, init) => {
      if (url.hostname === "login.microsoftonline.com")
        return json({ access_token: "access" });
      assert.equal(init.method, "GET");
      return json({
        value: [
          {
            ...mail("html"),
            body: {
              contentType: "html",
              content:
                '<p>Private body</p><a href="https://example.test/t?x=1&amp;y=2">Verify email</a>',
            },
          },
        ],
      });
    },
    async () => {
      const r = await db.request(`/api/outlook/accounts/${id}/emails`);
      assert.equal(r.data.data[0].verification_code, "246810");
      assert.equal(
        r.data.data[0].verification_link,
        "https://example.test/t?x=1&y=2",
      );
      assert.equal("body" in r.data.data[0], false);
    },
  );
});
test("domain list filters detected codes or links; mailbox quick lookup respects sender/time and preserves unread", async () => {
  const box = await db.request("/api/mailboxes/generate", {
    domain: "example.test",
    prefix: "verification-test",
  });
  const address = box.data.data.address;
  for (const [subject, code, link, time] of [
    ["News", "", "", "2026-11-14 10:00:00"],
    [
      "Confirm email",
      "",
      "https://example.test/verify?t=x",
      "2026-11-14 09:00:00",
    ],
    ["Your code is 333333", "333333", "", "2026-11-14 08:00:00"],
  ])
    await db.DB.prepare(
      "INSERT INTO cf_inbox_mails(recipient,sender,subject,verification_code,verification_link,created_at) VALUES(?,?,?,?,?,?)",
    )
      .bind(address, "auth@example.test", subject, code, link, time)
      .run();
  const list = await db.request(
    `/api/cf-mails?recipient=${address}&verification=true&limit=1`,
  );
  assert.equal(list.data.total, 2);
  assert.equal(
    list.data.data[0].verification_link,
    "https://example.test/verify?t=x",
  );
  const code = await db.request(
    `/api/mailboxes/${box.data.data.id}/code?since=2026-11-14T08%3A30%3A00Z&sender=auth`,
  );
  assert.equal(code.data.data.link, "https://example.test/verify?t=x");
  assert.equal(code.data.data.code, "");
  const empty = await db.request(
    `/api/mailboxes/${box.data.data.id}/code?sender=missing`,
  );
  assert.equal(empty.data.data.has_mail, false);
  assert.equal(
    (
      await db.DB.prepare(
        "SELECT COUNT(*) as n FROM cf_inbox_mails WHERE recipient=? AND is_read=1",
      )
        .bind(address)
        .first<any>()
    ).n,
    0,
  );
  assert.equal(
    (await db.request(`/api/mailboxes/${box.data.data.id}/code?since=invalid`))
      .response.status,
    400,
  );
});
