import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { app } from "../src/index";
import * as graph from "../src/graph";
import * as outlook from "../src/outlook";
import type { OutlookAccount } from "../src/types";
import { ACCOUNT, TOKEN, database, json, microsoft } from "./helpers";

let db: Awaited<ReturnType<typeof database>>;
let accountId: number;
const attachment = {
  name: "说明.txt",
  content_type: "text/plain",
  content_base64: Buffer.from("fictional attachment\n", "utf8").toString(
    "base64",
  ),
};
const sendInput = {
  to: ["recipient@example.test"],
  subject: "Fictional subject",
  body: "Fictional message\n<script>literal text</script>",
};
const path = () => `/api/outlook/accounts/${accountId}`;
const accepted = () => new Response(null, { status: 202 });
const token = (scope?: string) =>
  json({
    access_token: "fictional-access",
    refresh_token: TOKEN + "_rotated",
    ...(scope === undefined ? {} : { scope }),
  });
const filePayload = (file = attachment) => ({
  "@odata.type": "#microsoft.graph.fileAttachment",
  name: file.name,
  contentType: file.content_type,
  contentBytes: file.content_base64,
});

before(async () => {
  db = await database();
  await db.request("/api/outlook/accounts", ACCOUNT);
  accountId = (await db.DB.prepare("SELECT id FROM accounts WHERE email=?")
    .bind(ACCOUNT.email)
    .first<{ id: number }>())!.id;
});
beforeEach(async () => {
  await db.DB.prepare("DELETE FROM auth_attempts WHERE identity LIKE 'send:%'").run();
  await db.DB.prepare(
    "UPDATE accounts SET status='active',refresh_token=?,auth_status='healthy',last_error='',last_error_code='' WHERE id=?",
  )
    .bind(TOKEN, accountId)
    .run();
});
after(async () => db?.dispose());

test("send uses rotated credentials, text-only Graph payload and 202 acceptance", async () => {
  const calls: string[] = [];
  await microsoft(
    (url, init) => {
      calls.push(url.pathname);
      assert.equal(init.redirect, "manual");
      assert.equal(init.method, "POST");
      if (url.hostname === "login.microsoftonline.com") {
        const body = new URLSearchParams(String(init.body));
        assert.equal(body.get("refresh_token"), TOKEN);
        assert.equal(
          body.get("scope"),
          "https://graph.microsoft.com/.default offline_access",
        );
        return token("Mail.Send");
      }
      assert.equal(url.pathname, "/v1.0/me/sendMail");
      assert.equal(
        new Headers(init.headers).get("Authorization"),
        "Bearer fictional-access",
      );
      assert.equal(
        new Headers(init.headers).get("Content-Type"),
        "application/json",
      );
      assert.deepEqual(JSON.parse(String(init.body)), {
        message: {
          subject: sendInput.subject,
          body: { contentType: "Text", content: sendInput.body },
          toRecipients: [
            { emailAddress: { address: "recipient@example.test" } },
          ],
          ccRecipients: [{ emailAddress: { address: "cc@example.test" } }],
          bccRecipients: [{ emailAddress: { address: "bcc@example.test" } }],
          attachments: [filePayload()],
        },
      });
      return accepted();
    },
    async () => {
      const result = await db.request(`${path()}/send`, {
        ...sendInput,
        cc: ["cc@example.test"],
        bcc: ["bcc@example.test"],
        attachments: [attachment],
      });
      assert.equal(result.response.status, 202);
      assert.deepEqual(result.data, {
        success: true,
        data: { accepted: true },
      });
      assert.ok(result.response.headers.get("X-Request-ID"));
      assert.equal(calls.length, 2);
      const row = await db.DB.prepare(
        "SELECT refresh_token FROM accounts WHERE id=?",
      )
        .bind(accountId)
        .first<{ refresh_token: string }>();
      assert.equal(row!.refresh_token, TOKEN + "_rotated");
    },
  );
});

test("plain reply preserves threading with Mail.Send alone and encodes opaque message IDs", async () => {
  const messageId = "AAMk+/=?#opaque";
  let graphCalls = 0;
  await microsoft(
    (url, init) => {
      if (url.hostname === "login.microsoftonline.com")
        return token("Mail.Send");
      graphCalls++;
      assert.equal(
        url.pathname,
        `/v1.0/me/messages/${encodeURIComponent(messageId)}/reply`,
      );
      assert.deepEqual(JSON.parse(String(init.body)), {
        message: { body: { contentType: "Text", content: sendInput.body } },
      });
      return accepted();
    },
    async () => {
      const result = await db.request(
        `${path()}/messages/${encodeURIComponent(messageId)}/reply`,
        { body: sendInput.body },
      );
      assert.equal(result.response.status, 202);
      assert.deepEqual(result.data.data, { accepted: true });
      assert.equal(graphCalls, 1);
    },
  );
});

test("attached replies create a reply draft, add validated files then send that draft once", async () => {
  const calls: string[] = [];
  const draftId = "draft+/=";
  await microsoft(
    (url, init) => {
      if (url.hostname === "login.microsoftonline.com")
        return token("Mail.ReadWrite https://graph.microsoft.com/Mail.Send");
      calls.push(url.pathname);
      assert.equal(init.method, "POST");
      if (url.pathname.endsWith("/createReply")) {
        assert.deepEqual(JSON.parse(String(init.body)), {
          message: { body: { contentType: "Text", content: "Reply text" } },
        });
        return json({ id: draftId, isDraft: true }, 201);
      }
      if (url.pathname.endsWith("/attachments")) {
        assert.deepEqual(JSON.parse(String(init.body)), filePayload());
        return json({ id: "attachment-id" }, 201);
      }
      assert.equal(init.body, undefined);
      return accepted();
    },
    async () => {
      const result = await db.request(`${path()}/messages/original/reply`, {
        body: "Reply text",
        attachments: [attachment],
      });
      assert.equal(result.response.status, 202);
      assert.deepEqual(calls, [
        "/v1.0/me/messages/original/createReply",
        `/v1.0/me/messages/${encodeURIComponent(draftId)}/attachments`,
        `/v1.0/me/messages/${encodeURIComponent(draftId)}/send`,
      ]);
    },
  );
});

test("known missing scopes fail before any Graph write without changing mailbox health", async () => {
  for (const [scope, endpoint, input, required] of [
    ["Mail.ReadWrite", "/send", sendInput, ["Mail.Send"]],
    ["", "/send", sendInput, ["Mail.Send"]],
    ["Mail.Send.Shared", "/send", sendInput, ["Mail.Send"]],
    [
      "Mail.Send",
      "/messages/original/reply",
      { body: "Reply", attachments: [attachment] },
      ["Mail.ReadWrite", "Mail.Send"],
    ],
    [
      "Mail.ReadWrite",
      "/messages/original/reply",
      { body: "Reply", attachments: [attachment] },
      ["Mail.ReadWrite", "Mail.Send"],
    ],
  ] as const) {
    let writes = 0;
    await microsoft(
      (url) => {
        if (url.hostname === "login.microsoftonline.com") return token(scope);
        writes++;
        return accepted();
      },
      async () => {
        const result = await db.request(path() + endpoint, input);
        assert.equal(result.response.status, 403);
        assert.equal(result.data.error, "PERMISSION_REQUIRED");
        assert.deepEqual(result.data.required_scopes, required);
        assert.equal(writes, 0);
        const row = await db.DB.prepare(
          "SELECT auth_status,last_error FROM accounts WHERE id=?",
        )
          .bind(accountId)
          .first<any>();
        assert.equal(row.auth_status, "healthy");
        assert.equal(row.last_error, "");
      },
    );
  }
});

test("opaque token capability falls back to Graph and maps forbidden without exposing upstream content", async () => {
  await microsoft(
    (url) =>
      url.hostname === "login.microsoftonline.com"
        ? token()
        : json(
            {
              error: {
                code: "ErrorAccessDenied",
                message: "SECRET body and token",
              },
            },
            403,
          ),
    async () => {
      const result = await db.request(`${path()}/send`, sendInput);
      assert.equal(result.response.status, 403);
      assert.equal(result.data.error, "PERMISSION_REQUIRED");
      assert.deepEqual(result.data.required_scopes, ["Mail.Send"]);
      assert.equal(JSON.stringify(result.data).includes("SECRET"), false);
    },
  );
});

test("invalid send and reply fields are rejected before refresh or write", async () => {
  const invalidInputs: unknown[] = [
    null,
    [],
    {},
    { ...sendInput, to: [] },
    { ...sendInput, to: ["bad"] },
    { ...sendInput, to: ["a@example.test\r\nBcc: b@example.test"] },
    { ...sendInput, to: ["a@example.test,b@example.test"] },
    { ...sendInput, to: ["a..b@example.test"] },
    { ...sendInput, cc: ["bad"] },
    { ...sendInput, bcc: [123] },
    { ...sendInput, to: Array(101).fill("a@example.test") },
    {
      ...sendInput,
      to: Array(100).fill("a@example.test"),
      cc: ["b@example.test"],
    },
    { ...sendInput, subject: "a".repeat(256) },
    { ...sendInput, subject: "\r\nInjected" },
    { ...sendInput, subject: " " },
    { ...sendInput, body: "" },
    { ...sendInput, body: "a".repeat(100001) },
    { ...sendInput, body: "\u0000" },
    { ...sendInput, body: { contentType: "HTML", content: "<script/>" } },
    { ...sendInput, body_type: "html" },
    { ...sendInput, from: "spoof@example.test" },
    { ...sendInput, attachments: {} },
    { ...sendInput, attachments: Array(11).fill(attachment) },
    ...[
      { ...attachment, name: "../secret.txt" },
      { ...attachment, name: "foo\\secret.txt" },
      { ...attachment, name: "bad\r\n.txt" },
      { ...attachment, name: "x".repeat(256) },
      {
        ...attachment,
        name: "payload.exe",
        content_type: "application/x-msdownload",
      },
      { ...attachment, name: "payload.svg", content_type: "image/svg+xml" },
      { ...attachment, content_type: "text/plain\r\nInjected: true" },
      { ...attachment, content_type: "application/pdf" },
      { ...attachment, content_base64: "not base64!" },
      { ...attachment, content_base64: "Zg=" },
      { ...attachment, content_base64: "Zh==" },
      { ...attachment, content_base64: "" },
      { ...attachment, contentBytes: "different" },
      {
        ...attachment,
        "@odata.type": "#microsoft.graph.referenceAttachment",
        sourceUrl: "https://evil.test",
      },
      { ...attachment, isInline: true },
    ].map((file) => ({ ...sendInput, attachments: [file] })),
  ];
  let calls = 0;
  await microsoft(
    () => {
      calls++;
      return accepted();
    },
    async () => {
      for (const input of invalidInputs) {
        const result = await db.request(`${path()}/send`, input);
        assert.equal(
          result.response.status,
          400,
          `Invalid input was not rejected: ${JSON.stringify(input).slice(0, 200)}`,
        );
      }
      for (const input of [
        null,
        {},
        { body: "" },
        { body: "a".repeat(100001) },
        { body: "text", to: ["other@example.test"] },
        { body: "text", body_type: "html" },
      ]) {
        assert.equal(
          (await db.request(`${path()}/messages/original/reply`, input))
            .response.status,
          400,
        );
      }
      assert.equal(calls, 0);
    },
  );
});

test("aggregate attachment size uses decoded bytes with an exact 3 MiB ceiling", () => {
  const oneMiB = {
    ...attachment,
    content_base64: Buffer.alloc(1024 * 1024).toString("base64"),
  };
  assert.equal(
    outlook.validateOutlookSend({
      ...sendInput,
      attachments: [oneMiB, oneMiB, oneMiB],
    }).attachments?.length,
    3,
  );
  assert.throws(() =>
    outlook.validateOutlookSend({
      ...sendInput,
      attachments: [oneMiB, oneMiB, oneMiB, attachment],
    }),
  );
  assert.throws(() =>
    outlook.validateOutlookReply({
      body: "reply",
      attachments: [
        {
          ...attachment,
          content_base64: Buffer.alloc(3 * 1024 * 1024 + 1).toString("base64"),
        },
      ],
    }),
  );
});

test("missing, disabled, invalid and unauthenticated accounts never reach Microsoft", async () => {
  let calls = 0;
  await microsoft(
    () => {
      calls++;
      return accepted();
    },
    async () => {
      assert.equal(
        (await db.request("/api/outlook/accounts/999999/send", sendInput))
          .response.status,
        404,
      );
      assert.equal(
        (await db.request("/api/outlook/accounts/nope/send", sendInput))
          .response.status,
        400,
      );
      assert.equal(
        (await db.request(`${path()}/send`, sendInput, "POST", {})).response
          .status,
        401,
      );
      await db.DB.prepare("UPDATE accounts SET status='disabled' WHERE id=?")
        .bind(accountId)
        .run();
      const result = await db.request(`${path()}/send`, sendInput);
      assert.equal(result.response.status, 409);
      assert.equal(result.data.error, "ACCOUNT_DISABLED");
      assert.equal(calls, 0);
    },
  );
});

test("malformed JSON, unsupported content and unsafe message IDs do not reach Microsoft", async () => {
  let calls = 0;
  await microsoft(
    () => {
      calls++;
      return accepted();
    },
    async () => {
      const response = await app.request(
        `https://mailhub.test${path()}/send`,
        {
          method: "POST",
          headers: {
            "X-API-Key": "test-api-key",
            "Content-Type": "application/json",
          },
          body: "{",
        },
        db.env,
      );
      assert.equal(response.status, 400);
      for (const id of ["\u0000", "x".repeat(2049)])
        assert.equal(
          (
            await db.request(
              `${path()}/messages/${encodeURIComponent(id)}/reply`,
              { body: "reply" },
            )
          ).response.status,
          400,
        );
      assert.equal(calls, 0);
    },
  );
});

test("refresh failures stop sending and preserve the existing reauthorization lifecycle", async () => {
  let calls = 0;
  await microsoft(
    (url) => {
      calls++;
      assert.equal(url.hostname, "login.microsoftonline.com");
      return json(
        { error: "invalid_grant", error_description: "SECRET refresh" },
        400,
      );
    },
    async () => {
      const result = await db.request(`${path()}/send`, sendInput);
      assert.equal(result.response.status, 400);
      assert.equal(result.data.error, "invalid_grant");
      assert.equal(calls, 1);
      assert.equal(JSON.stringify(result.data).includes("SECRET"), false);
      const row = await db.DB.prepare(
        "SELECT token_refresh_status FROM accounts WHERE id=?",
      )
        .bind(accountId)
        .first<any>();
      assert.equal(row.token_refresh_status, "reauth_required");
    },
  );
});

test("a concurrent account disable during refresh prevents an outbound side effect", async () => {
  await microsoft(
    async (url) => {
      assert.equal(url.hostname, "login.microsoftonline.com");
      await db.DB.prepare("UPDATE accounts SET status='disabled' WHERE id=?")
        .bind(accountId)
        .run();
      return token("Mail.Send");
    },
    async () => {
      const result = await db.request(`${path()}/send`, sendInput);
      assert.equal(result.response.status, 409);
      assert.equal(result.data.error, "ACCOUNT_CHANGED");
    },
  );
});

test("Graph rate limits, missing messages and authentication failures retain their HTTP meaning", async () => {
  for (const [status, code] of [
    [429, "TooManyRequests"],
    [404, "ErrorItemNotFound"],
    [401, "InvalidAuthenticationToken"],
  ] as const) {
    let writes = 0;
    await microsoft(
      (url) => {
        if (url.hostname === "login.microsoftonline.com")
          return token("Mail.Send");
        writes++;
        const response = json(
          { error: { code, message: "SECRET upstream body" } },
          status,
        );
        if (status === 429) response.headers.set("Retry-After", "17");
        return response;
      },
      async () => {
        const result = await db.request(`${path()}/messages/original/reply`, {
          body: "Reply",
        });
        assert.equal(result.response.status, status);
        assert.equal(result.data.error, code);
        assert.equal(writes, 1);
        assert.equal(JSON.stringify(result.data).includes("SECRET"), false);
        if (status === 429) {
          assert.equal(result.data.retry_after, 17);
          assert.equal(result.response.headers.get("Retry-After"), "17");
        }
      },
    );
  }
});

test("ambiguous delivery failures are never automatically retried or reported accepted", async () => {
  for (const failure of [
    () => {
      throw new DOMException("SECRET body", "TimeoutError");
    },
    () => {
      throw new Error("SECRET token");
    },
    () => json({ error: { code: "ErrorInternalServerError" } }, 503),
    () => json({ error: { code: "RequestTimeout" } }, 408),
    () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://evil.test" },
      }),
    () => json({ unexpected: true }),
  ]) {
    let writes = 0;
    await microsoft(
      (url) => {
        if (url.hostname === "login.microsoftonline.com")
          return token("Mail.Send");
        writes++;
        return failure();
      },
      async () => {
        const result = await db.request(`${path()}/send`, sendInput);
        assert.equal(result.response.status, 502);
        assert.equal(result.data.success, false);
        assert.equal(result.data.delivery_unknown, true);
        assert.equal(writes, 1);
        assert.equal(JSON.stringify(result.data).includes("SECRET"), false);
      },
    );
  }
});

test("failed attachment upload preserves draft reference and never sends a partial reply", async () => {
  const calls: string[] = [];
  await microsoft(
    (url) => {
      if (url.hostname === "login.microsoftonline.com")
        return token("Mail.ReadWrite Mail.Send");
      calls.push(url.pathname);
      if (url.pathname.endsWith("/createReply"))
        return json({ id: "safe-draft", isDraft: true }, 201);
      return json({ error: { code: "ErrorAccessDenied" } }, 403);
    },
    async () => {
      const result = await db.request(`${path()}/messages/original/reply`, {
        body: "Reply",
        attachments: [attachment],
      });
      assert.equal(result.response.status, 403);
      assert.equal(result.data.error, "PERMISSION_REQUIRED");
      assert.equal(result.data.draft_id, "safe-draft");
      assert.equal(result.data.delivery_unknown, undefined);
      assert.deepEqual(calls, [
        "/v1.0/me/messages/original/createReply",
        "/v1.0/me/messages/safe-draft/attachments",
      ]);
    },
  );
});

test("a failed draft send exposes its ID and uncertain outcome without re-creating or deleting it", async () => {
  const calls: string[] = [];
  await microsoft(
    (url) => {
      if (url.hostname === "login.microsoftonline.com")
        return token("Mail.ReadWrite Mail.Send");
      calls.push(url.pathname);
      if (url.pathname.endsWith("/createReply"))
        return json({ id: "safe-draft", isDraft: true }, 201);
      if (url.pathname.endsWith("/attachments"))
        return json({ id: "file" }, 201);
      throw new DOMException("fictional timeout", "TimeoutError");
    },
    async () => {
      const result = await db.request(`${path()}/messages/original/reply`, {
        body: "Reply",
        attachments: [attachment],
      });
      assert.equal(result.response.status, 502);
      assert.equal(result.data.draft_id, "safe-draft");
      assert.equal(result.data.delivery_unknown, true);
      assert.equal(calls.length, 3);
    },
  );
});

test("invalid createReply responses and missing permission cannot be treated as an accepted send", async () => {
  for (const response of [
    json({ body: "SECRET" }, 201),
    json({ id: "not-draft", isDraft: false }, 201),
    json({ id: "\u0000", isDraft: true }, 201),
  ]) {
    let calls = 0;
    await microsoft(
      () => {
        calls++;
        return response;
      },
      async () => {
        const result = await graph.createReply(
          "fictional-access",
          "original",
          "reply",
          ["Mail.ReadWrite"],
        );
        assert.equal(result.error?.code, "INVALID_RESPONSE");
        assert.equal(calls, 1);
        assert.equal(JSON.stringify(result).includes("SECRET"), false);
      },
    );
  }
  await microsoft(
    () => {
      assert.fail("Graph must not be called");
    },
    async () => {
      assert.equal(
        (
          await graph.createReply("fictional-access", "original", "reply", [
            "Mail.Send",
          ])
        ).error?.code,
        "PERMISSION_REQUIRED",
      );
    },
  );
});

test("accepted sends do not depend on a later health write that could fail after delivery", async () => {
  const account = (await db.DB.prepare("SELECT * FROM accounts WHERE id=?")
    .bind(accountId)
    .first<OutlookAccount>())!;
  const original = db.env.DB;
  try {
    await microsoft(
      (url) => {
        if (url.hostname === "login.microsoftonline.com")
          return token("Mail.Send");
        db.env.DB = {
          prepare() {
            throw new Error("storage unavailable after acceptance");
          },
        } as unknown as D1Database;
        return accepted();
      },
      async () => {
        assert.deepEqual(
          await outlook.sendOutlookMail(db.env, account, sendInput),
          { data: { accepted: true } },
        );
      },
    );
  } finally {
    db.env.DB = original;
  }
});
