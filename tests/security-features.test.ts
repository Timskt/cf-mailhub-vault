import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { app as application } from "../src/index";
import {
  authMiddleware,
  createSessionToken,
  getSessionSecret,
  sha256,
} from "../src/auth";
import keyRoutes from "../src/routes/api-keys";
import auditRoutes from "../src/routes/audit";
import backupRoutes, { openBackup } from "../src/routes/backups";
import { recordAudit } from "../src/audit";
import { db, eq, insert, update, StorageError } from "../src/storage/client";
import type { Env } from "../src/types";
import { database } from "./helpers";
import { D1Port } from "../src/storage/d1";

let fixture: Awaited<ReturnType<typeof database>>;
let cookie: string;
const host = new Hono<{ Bindings: Env }>();
host.onError((e, c) =>
  c.json(
    {
      success: false,
      error: e instanceof StorageError ? e.code : "INVALID_REQUEST",
      message: e.message,
    },
    (e instanceof StorageError || e instanceof HTTPException
      ? e.status
      : 500) as 400,
  ),
);
host.route("/api/api-keys", keyRoutes);
host.route("/api/audit", auditRoutes);
host.route("/api/backups", backupRoutes);
host.use("/api/test/*", authMiddleware());
let executions = 0;
let release: (() => void) | undefined;
let started: (() => void) | undefined;
host.post("/api/test/mutation", async (c) => {
  executions++;
  const body = await c.req.json();
  if (body.wait) {
    started?.();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  }
  if (body.fail) return c.json({ success: false }, 500);
  return c.json(
    {
      success: true,
      data: { executions, password: "fictional-response-secret" },
    },
    201,
  );
});
host.get("/api/test/context", (c) => c.json(c.get("auth")));
host.route("/", application);

async function request(
  path: string,
  body?: unknown,
  options: {
    method?: string;
    key?: string;
    session?: boolean;
    headers?: Record<string, string>;
    env?: Env;
  } = {},
) {
  const response = await host.request(
    `https://mailhub.test${path}`,
    {
      method: options.method || (body === undefined ? "GET" : "POST"),
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.key ? { "X-API-Key": options.key } : {}),
        ...(options.session ? { Cookie: cookie } : {}),
        ...options.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    options.env || fixture.env,
  );
  return { response, data: (await response.json()) as any };
}
async function issue(scopes: string[], restrictions?: unknown) {
  const result = await request(
    "/api/api-keys",
    { name: "Automation", scopes, ...(restrictions ? { restrictions } : {}) },
    { session: true },
  );
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  return result.data.data as {
    id: string;
    key: string;
    prefix: string;
    expires_at: string;
  };
}
before(async () => {
  fixture = await database();
  cookie = `mailhub_session=${await createSessionToken("admin", await getSessionSecret(fixture.env))}`;
  await db(fixture.env).mutate([
    insert("platform_vault", {
      platform_name: "Allowed",
      account_email: "allowed@example.test",
      password: "vault-secret",
      totp_secret: "TESTTOTPSECRET",
    }),
    insert("platform_vault", {
      platform_name: "Other",
      account_email: "other@example.test",
      password: "other-secret",
    }),
    insert("temp_mailboxes", {
      address: "allowed@example.test",
      prefix: "allowed",
      domain: "example.test",
      is_permanent: 1,
    }),
    insert("cf_inbox_mails", {
      recipient: "allowed@example.test",
      sender: "sender@example.test",
      text_content: "mail-body-secret",
      verification_code: "123456",
      verification_link: "https://example.test/?token=mail-token",
      subject: "subject-secret",
    }),
    insert("accounts", {
      email: "outlook@example.test",
      client_id: "public-client",
      refresh_token: "refresh-secret",
      password: "outlook-secret",
    }),
  ]);
});
after(async () => {
  await fixture?.dispose();
});

test("scoped keys store hashes, list only metadata, expire and revoke immediately", async () => {
  const key = await issue(["verify:read"], {
    emails: ["ALLOWED@example.test"],
    platforms: ["Allowed"],
  });
  assert.ok(key.key.startsWith("mhk_"));
  const row = await db(fixture.env).first("api_keys", eq("id", key.id));
  assert.equal(row?.key_hash, await sha256(key.key));
  assert.ok(!JSON.stringify(row).includes(key.key));
  assert.ok(Date.parse(key.expires_at) > Date.now());
  const listed = await request("/api/api-keys", undefined, { session: true });
  assert.equal(listed.response.status, 200);
  assert.ok(!JSON.stringify(listed.data).includes(key.key));
  assert.ok(!JSON.stringify(listed.data).includes(String(row!.key_hash)));
  assert.deepEqual(
    listed.data.data.find((k: any) => k.id === key.id).restrictions.emails,
    ["allowed@example.test"],
  );
  assert.equal(
    (
      await request(
        "/api/automation/mailbox",
        { email: "allowed@example.test" },
        { key: key.key },
      )
    ).response.status,
    200,
  );
  assert.equal(
    (
      await request(`/api/api-keys/${key.id}`, undefined, {
        method: "DELETE",
        session: true,
      })
    ).response.status,
    200,
  );
  assert.equal(
    (await request("/api/capabilities", undefined, { key: key.key })).response
      .status,
    401,
  );
  const expiring = await issue(["verify:read"]);
  await db(fixture.env).mutate([
    update("api_keys", eq("id", expiring.id), {
      expires_at: "2000-01-01T00:00:00.000Z",
    }),
  ]);
  assert.equal(
    (await request("/api/capabilities", undefined, { key: expiring.key }))
      .response.status,
    401,
  );
});

test("key inputs and resource restrictions fail closed", async () => {
  for (const body of [
    { scopes: ["anything"] },
    { scopes: [] },
    { scopes: ["verify:read"], restrictions: { emails: [] } },
    { scopes: ["verify:read"], restrictions: { emails: ["*@example.test"] } },
    { scopes: ["verify:read"], restrictions: { platforms: [""] } },
    { scopes: ["verify:read"], restrictions: { domains: ["example.test"] } },
    { scopes: ["verify:read"], expires_at: "2000-01-01T00:00:00Z" },
  ])
    assert.equal(
      (
        await request(
          "/api/api-keys",
          { name: "Invalid", ...body },
          { session: true },
        )
      ).response.status,
      400,
    );
  const key = await issue(["verify:read"]);
  for (const options of [{}, { key: fixture.env.API_KEY }, { key: key.key }])
    assert.ok(
      [401, 403].includes(
        (await request("/api/api-keys", undefined, options)).response.status,
      ),
    );
  assert.equal(
    (
      await request("/api/capabilities", undefined, {
        session: true,
        key: "invalid",
      })
    ).response.status,
    401,
  );
});

test("platform management and raw transfer endpoints do not broaden scoped API grants", async () => {
  const restricted = await issue(["admin"], { platforms: ["Allowed"] });
  const writer = await issue(["vault:write"]);
  for (const [path, body, method] of [
    ["/api/platforms", undefined, "GET"],
    ["/api/platforms", { name: "Unauthorized" }, "POST"],
    ["/api/platforms/Allowed", { name: "Renamed" }, "PUT"],
    ["/api/platforms/Allowed/merge", { target: "Other" }, "POST"],
    ["/api/platforms/Allowed", undefined, "DELETE"],
  ] as const) {
    for (const key of [restricted.key, writer.key])
      assert.equal(
        (await request(path, body, { key, method })).response.status,
        403,
        path,
      );
  }
  for (const path of ["/api/vault/import-preview", "/api/vault/import"])
    assert.equal(
      (
        await request(
          path,
          { raw_text: "Other----outside@example.test----secret" },
          { key: restricted.key },
        )
      ).response.status,
      403,
    );
  for (const path of ["/api/vault/export", "/api/outlook/accounts/export"])
    assert.equal(
      (await request(path, undefined, { key: restricted.key })).response.status,
      403,
    );
  assert.equal(
    (
      await request(
        "/api/vault/import-preview",
        { raw_text: "Preview----demo@example.test----secret" },
        { key: writer.key },
      )
    ).response.status,
    200,
  );
  assert.equal(
    await db(fixture.env).count("platforms", eq("name_key", "unauthorized")),
    0,
  );
});

test("verify scope cannot read credentials or mail bodies; indirect lookups enforce the resolved email and platform", async () => {
  const key = await issue(["verify:read"], {
    emails: ["allowed@example.test"],
    platforms: ["Allowed"],
  });
  for (const body of [
    { email: "allowed@example.test" },
    { vault_id: 1 },
    { platform: "Allowed" },
  ]) {
    const result = await request("/api/automation/verification", body, {
      key: key.key,
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.data.code, "123456");
  }
  for (const body of [
    { email: "other@example.test" },
    { vault_id: 2 },
    { platform: "Other" },
  ])
    assert.equal(
      (await request("/api/automation/verification", body, { key: key.key }))
        .response.status,
      403,
    );
  for (const path of [
    "/api/vault/1",
    "/api/vault/export",
    "/api/vault",
    "/api/outlook/accounts/1",
    "/api/cf-mails/1",
    "/api/emails/view/1",
    "/api/search?q=Allowed",
  ])
    assert.equal(
      (await request(path, undefined, { key: key.key })).response.status,
      403,
      path,
    );
  assert.equal(
    (await request("/api/vault/1/code", undefined, { key: key.key })).response
      .status,
    200,
  );
  assert.equal(
    (
      await request(
        "/api/automation/verification/batch",
        { items: [{ vault_id: 1 }, { vault_id: 2 }] },
        { key: key.key },
      )
    ).response.status,
    403,
  );
  const platformOnly = await issue(["verify:read"], { platforms: ["Allowed"] });
  assert.equal(
    (
      await request(
        "/api/automation/verification",
        { email: "other@example.test" },
        { key: platformOnly.key },
      )
    ).response.status,
    403,
  );
  // Resolving an allowed platform name must not bypass the independent email restriction.
  const wrongEmail = await issue(["verify:read"], {
    emails: ["other@example.test"],
    platforms: ["Allowed"],
  });
  assert.equal(
    (
      await request(
        "/api/automation/verification",
        { platform: "Allowed" },
        { key: wrongEmail.key },
      )
    ).response.status,
    403,
  );
});

test("vault/mailbox scopes are distinct; master remains broad and no key becomes an admin session", async () => {
  const vault = await issue(["vault:read", "vault:write"], {
    emails: ["allowed@example.test"],
    platforms: ["Allowed"],
  });
  assert.equal(
    (await request("/api/vault/1", undefined, { key: vault.key })).response
      .status,
    200,
  );
  assert.equal(
    (await request("/api/vault/2", undefined, { key: vault.key })).response
      .status,
    403,
  );
  assert.equal(
    (
      await request(
        "/api/vault/1",
        { account_email: "other@example.test" },
        { method: "PUT", key: vault.key },
      )
    ).response.status,
    403,
  );
  assert.equal(
    (
      await request(
        "/api/vault/batch",
        { ids: [1, 2], patch: { remark: "must not write" } },
        { key: vault.key },
      )
    ).response.status,
    403,
  );
  assert.equal(
    (
      await request(
        "/api/mailboxes/generate",
        { prefix: "new" },
        { key: vault.key },
      )
    ).response.status,
    403,
  );
  const mailbox = await issue(["mailbox:write"]);
  assert.equal(
    (
      await request(
        "/api/mailboxes/generate",
        { prefix: "scope-test" },
        { key: mailbox.key },
      )
    ).response.status,
    200,
  );
  assert.equal(
    (
      await request(
        "/api/vault",
        { platform_name: "No", account_email: "no@example.test" },
        { key: mailbox.key },
      )
    ).response.status,
    403,
  );
  const admin = await issue(["admin"]);
  for (const key of [admin.key, fixture.env.API_KEY!]) {
    assert.equal(
      (await request("/api/vault/1", undefined, { key })).response.status,
      200,
    );
    for (const path of [
      "/api/settings/storage",
      "/api/settings/api-key",
      "/api/audit",
      "/api/backups/export",
    ]) {
      const response = await request(path, undefined, { key });
      assert.ok([401, 403].includes(response.response.status), path);
    }
    const oauth = await request("/api/outlook/oauth/start", {}, { key });
    assert.ok([401, 403].includes(oauth.response.status));
  }
});

test("restricted lists fail closed and only the query actually consumed by the mail route can authorize it", async () => {
  const key = await issue(["admin"], {
    emails: ["allowed@example.test"],
    platforms: ["Allowed"],
  });
  for (const path of [
    "/api/vault",
    "/api/vault/platforms?platform=Allowed",
    "/api/vault/export?mailbox=allowed@example.test",
    "/api/vault/stats",
    "/api/mailboxes",
    "/api/cf-mails?address=allowed@example.test",
    "/api/emails/list?recipient=allowed@example.test&address=other@example.test",
  ])
    assert.equal(
      (await request(path, undefined, { key: key.key })).response.status,
      403,
      path,
    );
  assert.equal(
    (
      await request("/api/cf-mails?recipient=allowed@example.test", undefined, {
        key: key.key,
      })
    ).response.status,
    200,
  );
  assert.equal(
    (
      await request(
        "/api/emails/list?address=allowed@example.test",
        undefined,
        { key: key.key },
      )
    ).response.status,
    200,
  );
  const verify = await issue(["verify:read"], {
    emails: ["allowed@example.test"],
    platforms: ["Allowed"],
  });
  assert.equal(
    (
      await request("/api/external/code?platform=Allowed", undefined, {
        key: verify.key,
      })
    ).response.status,
    200,
  );
  assert.equal(
    (
      await request(
        "/api/external/code?email=allowed@example.test&platform=Other",
        undefined,
        { key: verify.key },
      )
    ).response.status,
    200,
  );
  assert.equal(
    (
      await request(
        "/api/external/code?email=other@example.test&platform=Allowed",
        undefined,
        { key: verify.key },
      )
    ).response.status,
    403,
  );
  const other = await issue(["verify:read"], {
    emails: ["other@example.test"],
    platforms: ["Allowed"],
  });
  assert.equal(
    (
      await request("/api/external/code?platform=Allowed", undefined, {
        key: other.key,
      })
    ).response.status,
    403,
  );
});

test("empty DELETE bodies are accepted; send/reply and raw mail require admin and support the 5 MiB exception", async () => {
  const harness = new Hono<{ Bindings: Env }>();
  harness.use("*", authMiddleware());
  harness.post("/api/outlook/accounts/:id/send", (c) =>
    c.json({ success: true }),
  );
  harness.post("/api/outlook/accounts/:id/messages/:message/reply", (c) =>
    c.json({ success: true }),
  );
  harness.post("/api/mailboxes/generate", (c) => c.json({ success: true }));
  harness.get(
    "/api/outlook/accounts/:id/messages/:message/attachments/:attachment",
    (c) => c.json({ success: true }),
  );
  const admin = await issue(["admin"]),
    writer = await issue(["mailbox:write"]);
  const mailBody = JSON.stringify({ padding: "x".repeat(3 * 1024 * 1024) });
  for (const path of [
    "/api/outlook/accounts/1/send",
    "/api/outlook/accounts/1/messages/test/reply",
  ]) {
    const options = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": admin.key,
        "Idempotency-Key": "send-body-1",
      },
      body: mailBody,
    };
    assert.equal(
      (
        await harness.request(
          path,
          {
            ...options,
            headers: { ...options.headers, "X-API-Key": writer.key },
          },
          fixture.env,
        )
      ).status,
      403,
    );
    assert.equal(
      (await harness.request(path, options, fixture.env)).status,
      200,
    );
    const replay = await harness.request(path, options, fixture.env);
    assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
    assert.equal(
      (
        await harness.request(
          path,
          {
            ...options,
            headers: { ...options.headers, "Idempotency-Key": "too-large" },
            body: JSON.stringify({ padding: "x".repeat(5 * 1024 * 1024) }),
          },
          fixture.env,
        )
      ).status,
      413,
    );
  }
  assert.equal(
    (
      await harness.request(
        "/api/mailboxes/generate",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": admin.key,
            "Idempotency-Key": "normal-body-limit",
          },
          body: mailBody,
        },
        fixture.env,
      )
    ).status,
    413,
  );
  for (const path of [
    "/api/cf-mails/1/raw",
    "/api/cf-mails/1/attachments/0",
    "/api/outlook/accounts/1/messages/test/attachments/0",
  ])
    assert.equal(
      (await request(path, undefined, { key: writer.key })).response.status,
      403,
    );
  for (const path of [
    "/api/settings/webhooks",
    "/api/settings/credentials",
    "/api/settings/storage",
    "/api/outlook/oauth/config",
    "/api/new-unreviewed-feature",
  ])
    assert.ok(
      [401, 403].includes(
        (await request(path, undefined, { key: admin.key })).response.status,
      ),
      path,
    );
  const [created] = await db(fixture.env).mutate([
    insert("platform_vault", {
      platform_name: "Delete",
      account_email: "delete@example.test",
      email_source: "external",
    }),
  ]);
  const deleter = await issue(["vault:write"], {
    emails: ["delete@example.test"],
  });
  assert.equal(
    (
      await request(`/api/vault/${created.lastId}`, undefined, {
        method: "DELETE",
        key: deleter.key,
      })
    ).response.status,
    200,
  );
});

test("durable idempotency replays the identical success and rejects body conflicts without duplicating mutations", async () => {
  const options = {
    key: fixture.env.API_KEY,
    headers: { "Idempotency-Key": "security-success-1" },
  };
  const start = executions;
  const first = await request("/api/test/mutation", { value: 1 }, options);
  assert.equal(first.response.status, 201);
  const second = await request(
    "/api/test/mutation",
    { value: 1 },
    { ...options, env: { ...fixture.env } },
  );
  assert.deepEqual(second.data, first.data);
  assert.equal(second.response.status, 201);
  assert.equal(second.response.headers.get("Idempotency-Replayed"), "true");
  assert.notEqual(
    first.response.headers.get("X-Request-ID"),
    second.response.headers.get("X-Request-ID"),
  );
  assert.equal(executions, start + 1);
  const conflict = await request("/api/test/mutation", { value: 2 }, options);
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.data.error, "IDEMPOTENCY_CONFLICT");
  const stored = await db(fixture.env).select("idempotency_requests");
  assert.ok(stored.some((r) => r.state === "complete"));
  assert.ok(!JSON.stringify(stored).includes("fictional-response-secret"));
  assert.ok(!JSON.stringify(stored).includes("security-success-1"));
});

test("in-progress and uncertain mutations never execute again, even after a timeout", async () => {
  const options = {
    key: fixture.env.API_KEY,
    headers: { "Idempotency-Key": "security-concurrent" },
  };
  const gate = new Promise<void>((resolve) => {
    started = resolve;
  });
  const first = request("/api/test/mutation", { wait: true }, options);
  await gate;
  try {
    const retry = await request("/api/test/mutation", { wait: true }, options);
    assert.equal(retry.response.status, 409);
    assert.equal(retry.data.error, "IDEMPOTENCY_UNKNOWN");
  } finally {
    release?.();
  }
  assert.equal((await first).response.status, 201);
  const failedOptions = {
    key: fixture.env.API_KEY,
    headers: { "Idempotency-Key": "security-failed" },
  };
  const beforeCount = executions;
  assert.equal(
    (await request("/api/test/mutation", { fail: true }, failedOptions))
      .response.status,
    500,
  );
  assert.equal(
    (await request("/api/test/mutation", { fail: true }, failedOptions)).data
      .error,
    "IDEMPOTENCY_UNKNOWN",
  );
  assert.equal(executions, beforeCount + 1);
});

test("cleanup expires only confirmed successes and preserves old pending/unknown tombstones", async () => {
  const pending = {
    key: fixture.env.API_KEY,
    headers: { "Idempotency-Key": "past-pending" },
  };
  const failed = {
    key: fixture.env.API_KEY,
    headers: { "Idempotency-Key": "past-failed" },
  };
  const gate = new Promise<void>((resolve) => {
    started = resolve;
  });
  const first = request(
    "/api/test/mutation",
    { wait: true, test: "expiry" },
    pending,
  );
  await gate;
  try {
    assert.equal(
      (
        await request(
          "/api/test/mutation",
          { fail: true, test: "expiry" },
          failed,
        )
      ).response.status,
      500,
    );
    await db(fixture.env).mutate([
      update("idempotency_requests", undefined, {
        expires_at: "2000-01-01T00:00:00Z",
      }),
    ]);
    const beforeCount = executions;
    await request(
      "/api/test/mutation",
      { cleanup: true },
      {
        key: fixture.env.API_KEY,
        headers: { "Idempotency-Key": "cleanup-trigger" },
      },
    );
    for (const [options, body] of [
      [pending, { wait: true, test: "expiry" }],
      [failed, { fail: true, test: "expiry" }],
    ] as const) {
      const response = await request("/api/test/mutation", body, options);
      assert.equal(response.response.status, 409);
      assert.equal(response.data.error, "IDEMPOTENCY_UNKNOWN");
    }
    assert.equal(executions, beforeCount + 1);
    const rows = await db(fixture.env).select("idempotency_requests");
    assert.ok(
      rows.some(
        (r) =>
          r.state === "in_progress" && String(r.expires_at).startsWith("2000"),
      ),
    );
    assert.ok(
      rows.some(
        (r) => r.state === "unknown" && String(r.expires_at).startsWith("2000"),
      ),
    );
    assert.ok(
      !rows.some(
        (r) =>
          r.state === "complete" && String(r.expires_at).startsWith("2000"),
      ),
    );
  } finally {
    release?.();
  }
  await first;
});

test("audit records only allowlisted metadata and only sessions can list or purge", async () => {
  await recordAudit(fixture.env, {
    actor_type: "admin_session",
    actor_id: "admin",
    action: "test.redaction",
    resource: "vault",
    status: 200,
    metadata: {
      count: 2,
      password: "audit-password",
      refresh_token: "audit-refresh",
      body: "audit-mail-body",
      nested: { token: "audit-token" },
    },
  });
  const listed = await request("/api/audit?limit=100", undefined, {
    session: true,
  });
  assert.equal(listed.response.status, 200);
  const content = JSON.stringify(listed.data);
  for (const secret of [
    "audit-password",
    "audit-refresh",
    "audit-mail-body",
    "audit-token",
    "fictional-response-secret",
    "mail-body-secret",
  ])
    assert.ok(!content.includes(secret), secret);
  assert.ok(
    listed.data.data.some(
      (row: any) => row.action === "test.redaction" && row.metadata.count === 2,
    ),
  );
  assert.ok(
    listed.data.data.some(
      (row: any) =>
        row.actor_type === "api_key" && row.api_key_prefix && row.request_id,
    ),
  );
  assert.ok(
    [401, 403].includes(
      (
        await request("/api/audit", undefined, {
          method: "DELETE",
          key: fixture.env.API_KEY,
        })
      ).response.status,
    ),
  );
  assert.equal(
    (
      await request(
        "/api/audit",
        { before: "2000-01-01T00:00:00Z" },
        { method: "DELETE", session: true },
      )
    ).response.status,
    200,
  );
});

test("ordinary reads and audit polling leave the data revision unchanged while sensitive reads and denials are audited", async () => {
  const count = await db(fixture.env).count("audit_logs"),
    before = await new D1Port(fixture.DB).info();
  for (const path of [
    "/api/audit",
    "/api/audit?limit=1",
    "/api/capabilities",
    "/api/vault",
    "/api/mailboxes",
    "/api/backups/manifest",
  ])
    assert.equal(
      (await request(path, undefined, { session: true })).response.status,
      200,
      path,
    );
  assert.equal(await db(fixture.env).count("audit_logs"), count);
  assert.deepEqual(await new D1Port(fixture.DB).info(), before);
  assert.equal(
    (await request("/api/vault/1", undefined, { session: true })).response
      .status,
    200,
  );
  assert.equal(await db(fixture.env).count("audit_logs"), count + 1);
  const scoped = await issue(["verify:read"]);
  const afterIssue = await db(fixture.env).count("audit_logs");
  assert.equal(
    (await request("/api/vault/1", undefined, { key: scoped.key })).response
      .status,
    403,
  );
  assert.equal(await db(fixture.env).count("audit_logs"), afterIssue + 1);
});

test("backup defaults to redacted data; full export is passphrase-encrypted and dry-run validates integrity", async () => {
  const redacted = await request("/api/backups/export", undefined, {
    session: true,
  });
  assert.equal(redacted.response.status, 200);
  assert.equal(redacted.data.manifest.restorable, false);
  const content = JSON.stringify(redacted.data);
  for (const secret of [
    "vault-secret",
    "refresh-secret",
    "TESTTOTPSECRET",
    "outlook-secret",
    "mail-body-secret",
    "123456",
    "mail-token",
    "subject-secret",
    fixture.env.COOKIE_SECRET!,
    fixture.env.API_KEY!,
  ])
    assert.ok(!content.includes(secret), secret);
  const passphrase = "test-only-long-backup-passphrase";
  const full = await request(
    "/api/backups/export",
    { include_credentials: true, passphrase, confirm: "EXPORT_CREDENTIALS" },
    { session: true },
  );
  assert.equal(full.response.status, 200, JSON.stringify(full.data));
  assert.equal(full.data.encryption.algorithm, "AES-256-GCM");
  assert.ok(!JSON.stringify(full.data).includes("vault-secret"));
  const plaintext = await openBackup(full.data, passphrase);
  assert.equal(plaintext.tables.platform_vault[0].password, "vault-secret");
  const beforeCount = await db(fixture.env).count("platform_vault");
  const dry = await request(
    "/api/backups/dry-run",
    { backup: full.data, passphrase },
    { session: true },
  );
  assert.equal(dry.response.status, 200);
  assert.equal(dry.data.data.writes_performed, false);
  assert.equal(await db(fixture.env).count("platform_vault"), beforeCount);
  assert.ok(!JSON.stringify(dry.data).includes("vault-secret"));
  assert.equal(
    (
      await request(
        "/api/backups/dry-run",
        { backup: full.data, passphrase: "wrong-but-long-passphrase" },
        { session: true },
      )
    ).response.status,
    400,
  );
  assert.equal(
    (
      await request(
        "/api/backups/export",
        { include_credentials: true },
        { session: true },
      )
    ).response.status,
    400,
  );
});

test("mailbox identity aggregates stay private and restricted keys authorize actual delivery aliases for every write and target", async () => {
  const key = await issue(["admin"], {
    emails: ["login-scope@example.test"],
    platforms: ["AliasScope"],
  });
  const payload = {
    platform_name: "AliasScope",
    account_email: "login-scope@example.test",
    mailbox_address: "private-delivery@example.test",
    email_source: "cf_domain",
    verification_sender: "auth@example.test",
  };
  const created = await request("/api/vault", payload, { session: true });
  const id = created.data.data.id;
  for (const path of [
    "/api/mailbox-identities",
    `/api/mailbox-identities/${encodeURIComponent("cf_domain:private-delivery@example.test")}`,
    `/api/mailbox-identities/${encodeURIComponent("cf_domain:private-delivery@example.test")}/registrations`,
    `/api/mailbox-identities/${encodeURIComponent("cf_domain:private-delivery@example.test")}/impact`,
  ])
    assert.equal(
      (await request(path, undefined, { key: key.key })).response.status,
      403,
      path,
    );
  assert.equal(
    (await request("/api/mailbox-identities", undefined, { session: true }))
      .response.status,
    200,
  );
  assert.equal(
    (await request("/api/vault", payload, { key: key.key })).response.status,
    403,
    "create alias",
  );
  assert.equal(
    (
      await request(
        "/api/vault/import",
        { accounts: [payload] },
        { key: key.key },
      )
    ).response.status,
    403,
    "import alias",
  );
  assert.equal(
    (
      await request(
        "/api/vault/import",
        {
          accounts: [
            {
              platform_name: payload.platform_name,
              account_email: payload.account_email,
              email_source: "cf_domain",
              remark: "should stay private",
            },
          ],
          duplicate_mode: "update",
        },
        { key: key.key },
      )
    ).response.status,
    403,
    "merge alias",
  );
  for (const target of [{ vault_id: id }, { platform: payload.platform_name }])
    assert.equal(
      (await request("/api/automation/verification", target, { key: key.key }))
        .response.status,
      403,
      JSON.stringify(target),
    );
  const allowed = await issue(["admin"], {
    emails: [payload.account_email, payload.mailbox_address],
    platforms: [payload.platform_name],
  });
  assert.equal(
    (await request(`/api/vault/${id}`, undefined, { key: allowed.key }))
      .response.status,
    200,
  );
  assert.equal(
    (
      await request(
        "/api/automation/verification",
        { vault_id: id, match: "platform" },
        { key: allowed.key },
      )
    ).response.status,
    200,
  );
  const updated = await request(
    "/api/vault/import",
    {
      accounts: [
        {
          platform_name: payload.platform_name,
          account_email: payload.account_email,
          remark: "allowed alias patch",
        },
      ],
      duplicate_mode: "update",
    },
    { key: allowed.key },
  );
  assert.equal(updated.response.status, 200, JSON.stringify(updated.data));
});
