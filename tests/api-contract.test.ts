import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiSnippet, type SnippetEntry } from "../web/lib/api-examples";
import {
  API_VERSION,
  operations,
  openApi,
  schemas,
} from "../shared/api-contract";
import {
  developerGuide,
  postmanCollection,
  webhookReceiverExample,
  workflows,
} from "../shared/api-guides";
import {
  MANUAL_REDIRECT_URI,
  PUBLIC_CLIENT_ID,
} from "../shared/outlook-recovery";
import { app } from "../src/index";
import { database, ACCOUNT, microsoft, json, mail } from "./helpers";
import { db, eq, insert, update } from "../src/storage/client";
import {
  createSessionToken,
  getSessionSecret,
  IDEMPOTENCY_RETENTION_SECONDS,
  IDEMPOTENCY_RESPONSE_LIMIT,
} from "../src/auth";
import { OUTLOOK_SEND_LIMITS } from "../src/outlook";
import {
  WEBHOOK_MAX_ATTEMPTS,
  webhookSignature,
  enqueueEvent,
} from "../src/webhooks";
import {
  BACKUP_MAX_BYTES,
  BACKUP_MAX_ROWS,
  BACKUP_PBKDF2_ITERATIONS,
} from "../src/routes/backups";
import { DirectStore } from "../src/storage/engine";
import { D1Port } from "../src/storage/d1";
import { Coordinator } from "../src/storage/coordinator";
import { MemoryControl } from "./storage-support";
import { StorageError } from "../src/storage/model";
import type { Env } from "../src/types";

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
function conforms(
  schema: Record<string, unknown>,
  value: unknown,
  label: string,
) {
  const validate = ajv.compile({ ...schema, components: { schemas } });
  assert.equal(
    validate(value),
    true,
    `${label}: ${JSON.stringify(validate.errors)}`,
  );
}
const responseConforms = (operationId: string, data: unknown) =>
  conforms(
    operations.find((o) => o.operationId === operationId)!.response,
    data,
    operationId,
  );

test("all catalog examples produce valid cURL/Python syntax and JavaScript requests with matching JSON bodies", async () => {
  const spec = openApi();
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const python: string[] = [],
    shell: string[] = [];
  for (const operation of operations) {
    const entry = {
      ...(spec.paths[operation.path][operation.method] as object),
      path: operation.path,
      method: operation.method.toUpperCase(),
    } as SnippetEntry;
    python.push(apiSnippet(entry, "python", "https://mailhub.example"));
    shell.push(apiSnippet(entry, "curl", "https://mailhub.example"));
    let sent: { url: string; init: RequestInit } | undefined;
    const execute = new AsyncFunction(
      "process",
      "fetch",
      "AbortSignal",
      apiSnippet(entry, "javascript", "https://mailhub.example"),
    );
    await execute(
      {
        env: {
          MAILHUB_URL: "https://mailhub.example/",
          MAILHUB_API_KEY: "example-only",
          MAILHUB_ADMIN_COOKIE: "example-cookie",
          MAILHUB_IDEMPOTENCY_KEY: "example-operation-1",
        },
      },
      async (url: string, init: RequestInit) => {
        sent = { url, init };
        return {
          ok: true,
          json: async () => ({ success: true }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      },
      { timeout: () => undefined },
    );
    assert.equal(
      sent?.init.method,
      operation.method.toUpperCase(),
      operation.operationId,
    );
    assert.ok(sent!.url.startsWith("https://mailhub.example/"));
    if (operation.body)
      assert.deepEqual(
        JSON.parse(String(sent?.init.body)),
        operation.example ?? {},
        operation.operationId,
      );
  }
  const parsed = spawnSync(
    "python3",
    [
      "-c",
      "import sys,json,ast\nfor code in json.load(sys.stdin): ast.parse(code)",
    ],
    { input: JSON.stringify(python), encoding: "utf8" },
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  const checked = spawnSync("bash", ["-n"], {
    input: shell.join("\n\n"),
    encoding: "utf8",
  });
  assert.equal(checked.status, 0, checked.stderr);
});

test("generated JavaScript parses 201/202 JSON, preserves binary downloads and uses typed encoded path IDs", async () => {
  const spec = openApi();
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const entryFor = (name: string): SnippetEntry => {
    const operation = operations.find((o) => o.operationId === name)!;
    return {
      ...(spec.paths[operation.path][operation.method] as object),
      path: operation.path,
      method: operation.method.toUpperCase(),
    } as SnippetEntry;
  };
  for (const [name, reader, suffix] of [
    ["createScopedApiKey", "json", "/api/api-keys"],
    ["createWebhook", "json", "/api/settings/webhooks"],
    ["sendOutlookMail", "json", "/api/outlook/accounts/1/send"],
    [
      "replyOutlookMail",
      "json",
      "/api/outlook/accounts/1/messages/REPLACE_MESSAGEID/reply",
    ],
    ["downloadDomainMailRaw", "binary", "/api/cf-mails/1/raw"],
    ["revokeScopedApiKey", "json", "/api/api-keys/REPLACE_ID"],
    [
      "retryWebhookDelivery",
      "json",
      "/api/settings/webhooks/deliveries/REPLACE_ID/retry",
    ],
  ]) {
    let actualReader = "";
    await new AsyncFunction(
      "process",
      "fetch",
      "AbortSignal",
      apiSnippet(entryFor(name), "javascript", "https://mailhub.test"),
    )(
      {
        env: {
          MAILHUB_URL: "https://mailhub.test/",
          MAILHUB_API_KEY: "fixture",
          MAILHUB_ADMIN_COOKIE: "fixture",
        },
      },
      async (url: string) => {
        assert.equal(url, "https://mailhub.test" + suffix, name);
        return {
          ok: true,
          json: async () => {
            actualReader = "json";
            return { success: true };
          },
          arrayBuffer: async () => {
            actualReader = "binary";
            return new ArrayBuffer(0);
          },
        };
      },
      { timeout: () => undefined },
    );
    assert.equal(actualReader, reader, name);
    const python = apiSnippet(entryFor(name), "python", "https://mailhub.test");
    assert.ok(
      python.includes(
        reader === "json"
          ? "result = response.json()"
          : "result = response.content",
      ),
      name,
    );
  }
  const encoded = entryFor("replyOutlookMail");
  encoded.parameters = encoded.parameters.map((p) =>
    p.name === "messageId" ? { ...p, example: "message/with+space ?#" } : p,
  );
  for (const language of ["javascript", "python", "curl"])
    assert.ok(
      apiSnippet(encoded, language, "https://mailhub.test").includes(
        "message%2Fwith%2Bspace%20%3F%23",
      ),
    );
});

test("restore examples send the caller's stable Idempotency-Key in all languages and stop before I/O when missing", async () => {
  const operation = operations.find((o) => o.operationId === "restoreBackup")!;
  const spec = openApi();
  const entry = {
    ...(spec.paths[operation.path][operation.method] as object),
    path: operation.path,
    method: "POST",
  } as SnippetEntry;
  const snippets = Object.fromEntries(
    ["javascript", "python", "curl"].map((language) => [
      language,
      apiSnippet(entry, language, "https://mailhub.test"),
    ]),
  );
  const env = {
    MAILHUB_URL: "https://mailhub.test",
    MAILHUB_ADMIN_COOKIE: "fixture-cookie",
    MAILHUB_IDEMPOTENCY_KEY: "restore-stable-123",
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction(
    "process",
    "fetch",
    "AbortSignal",
    snippets.javascript,
  );
  let calls = 0;
  const fetch = async (_url: string, init: RequestInit) => {
    calls++;
    assert.equal(
      new Headers(init.headers).get("Idempotency-Key"),
      env.MAILHUB_IDEMPOTENCY_KEY,
    );
    assert.equal(
      new Headers(init.headers).get("Cookie"),
      env.MAILHUB_ADMIN_COOKIE,
    );
    assert.equal(new Headers(init.headers).has("Authorization"), false);
    return { ok: true, json: async () => ({ success: true }) };
  };
  await execute({ env }, fetch, { timeout: () => undefined });
  await assert.rejects(
    execute({ env: { ...env, MAILHUB_IDEMPOTENCY_KEY: "" } }, fetch, {
      timeout: () => undefined,
    }),
    /MAILHUB_IDEMPOTENCY_KEY/,
  );
  assert.equal(calls, 1);
  const pythonHarness = `import json,os,sys,types\ncode=json.load(sys.stdin)\ncalls=[]\nclass Response:\n def raise_for_status(self): pass\n def json(self): return {"success":True}\ndef post(url,**kwargs):\n calls.append(kwargs)\n return Response()\nsys.modules["requests"]=types.SimpleNamespace(post=post)\nexec(code,{})\nassert calls[0]["headers"]["Idempotency-Key"]==os.environ["MAILHUB_IDEMPOTENCY_KEY"]\nassert "Authorization" not in calls[0]["headers"]\ndel os.environ["MAILHUB_IDEMPOTENCY_KEY"]\ntry: exec(code,{})\nexcept (KeyError,ValueError): pass\nelse: raise AssertionError("missing key accepted")\nassert len(calls)==1\n`;
  const python = spawnSync("python3", ["-c", pythonHarness], {
    input: JSON.stringify(snippets.python),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(python.status, 0, python.stderr);
  const shell = spawnSync("bash", [], {
    input: 'curl() { printf "%s\\n" "$@"; }\n' + snippets.curl,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(shell.status, 0, shell.stderr);
  assert.ok(
    shell.stdout
      .split("\n")
      .includes("Idempotency-Key: " + env.MAILHUB_IDEMPOTENCY_KEY),
  );
  const missing = spawnSync("bash", [], {
    input:
      'unset MAILHUB_IDEMPOTENCY_KEY\ncurl() { printf "REQUEST_SENT"; }\n' +
      snippets.curl,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.notEqual(missing.status, 0);
  assert.ok(!missing.stdout.includes("REQUEST_SENT"));
  const optional = {
    ...entry,
    parameters: entry.parameters.map((p) =>
      p.in === "header" ? { ...p, required: false } : p,
    ),
  };
  for (const language of ["javascript", "python", "curl"])
    assert.ok(
      !apiSnippet(optional, language, "https://mailhub.test").includes(
        "MAILHUB_IDEMPOTENCY_KEY",
      ),
      "Optional keys must not freeze repeated polling results",
    );
});

test("OpenAPI covers every concrete route, has unique stable IDs and valid executable example schemas", () => {
  const spec = openApi();
  assert.equal(spec.openapi, "3.1.0");
  assert.equal(operations.length, 127);
  for (const [path, method, operationId] of [
    ["/api/outlook/oauth/start", "post", "startOutlookOAuth"],
    ["/api/outlook/oauth/callback", "get", "finishOutlookOAuth"],
    ["/api/outlook/oauth/exchange", "post", "exchangeOutlookOAuth"],
    ["/api/outlook/accounts/{id}/recovery", "get", "getOutlookRecovery"],
  ])
    assert.equal((spec.paths[path][method] as any).operationId, operationId);
  for (const workflow of workflows)
    for (const operationId of workflow.operations)
      assert.ok(
        operations.some((o) => o.operationId === operationId),
        `${workflow.id}: ${operationId}`,
      );
  const concrete = app.routes.filter(
    (r) =>
      r.method !== "ALL" &&
      !r.path.includes("*") &&
      ![
        "/openapi.json",
        "/postman.json",
        "/api-doc.md",
        "/api-doc.json",
        "/llms.txt",
        "/llms-full.txt",
      ].includes(r.path),
  );
  const actual = new Set(
    concrete.map(
      (r) => `${r.method.toLowerCase()} ${r.path.replace(/:(\w+)/g, "{$1}")}`,
    ),
  );
  const documented = new Set(operations.map((o) => `${o.method} ${o.path}`));
  assert.deepEqual([...documented].sort(), [...actual].sort());
  assert.equal(
    new Set(operations.map((o) => o.operationId)).size,
    operations.length,
  );
  for (const operation of operations) {
    if (operation.example !== undefined && operation.body)
      conforms(
        operation.body,
        operation.example,
        `${operation.operationId} request`,
      );
    if (operation.responseExample)
      responseConforms(operation.operationId, operation.responseExample);
  }
  const collection = postmanCollection("https://mailhub.example");
  assert.equal(
    collection.item.reduce((count, group) => count + group.item.length, 0),
    operations.length,
  );
  assert.equal(collection.variable.find((v) => v.key === "api_key")?.value, "");
  const guide = developerGuide("https://mailhub.example");
  assert.match(guide, /```/);
  assert.ok(!guide.includes("[CODE]") && !guide.includes("\0"));
});

test("new API routes require auth; public documentation is credential-free and has request IDs", async () => {
  const f = await database();
  try {
    for (const path of [
      "/api/capabilities",
      "/api/automation/mailbox",
      "/api/automation/verification",
      "/api/automation/verification/batch",
      "/api/vault/batch",
    ]) {
      const r = await f.request(
        path,
        path === "/api/capabilities" ? undefined : {},
        path === "/api/capabilities" ? "GET" : "POST",
        {},
      );
      assert.equal(r.response.status, 401, path);
    }
    const r = await f.request("/api/capabilities", undefined, "GET", {
      Authorization: `Bearer ${f.env.API_KEY}`,
    });
    responseConforms("getCapabilities", r.data);
    assert.equal(r.data.data.limits.verification_batch, 5);
    assert.match(r.response.headers.get("X-Request-ID")!, /^[\da-f-]{36}$/);
    assert.equal(r.response.headers.get("Cache-Control"), "no-store");
    const ids = new Set<string>();
    for (const path of [
      "/openapi.json",
      "/postman.json",
      "/api-doc.md",
      "/api-doc.json",
      "/llms.txt",
      "/llms-full.txt",
    ]) {
      const response = await app.request(
        `https://mailhub.example${path}`,
        {},
        f.env,
      );
      assert.equal(response.status, 200);
      const content = await response.text();
      for (const secret of [
        f.env.API_KEY!,
        f.env.COOKIE_SECRET!,
        f.env.ADMIN_PASSWORD!,
      ])
        assert.ok(!content.includes(secret), path);
      ids.add(response.headers.get("X-Request-ID")!);
    }
    assert.equal(ids.size, 6);
    f.env.MICROSOFT_CLIENT_ID = ACCOUNT.client_id;
    f.env.MICROSOFT_CLIENT_SECRET = "fake-oauth-secret";
    const forged = await f.request("/api/outlook/oauth/start", {}, "POST", {
      "X-API-Key": f.env.API_KEY!,
      Cookie: "mailhub_session=forged",
    });
    assert.equal(forged.response.status, 401);
    const cookie = await createSessionToken(
      "admin",
      await getSessionSecret(f.env),
    );
    const allowed = await f.request(
      "/api/automation/mailbox",
      { email: "user@example.test" },
      "POST",
      { Cookie: `mailhub_session=${cookie}` },
    );
    assert.equal(allowed.response.status, 200);
    responseConforms("inspectMailbox", allowed.data);
  } finally {
    await f.dispose();
  }
});

test("mailbox discovery distinguishes ambiguity, missing Outlook and unsupported sources without reading secrets", async () => {
  const f = await database();
  try {
    await db(f.env).mutate([
      insert("platform_vault", {
        platform_name: "Example",
        account_email: "missing@outlook.com",
        email_source: "outlook",
        password: "private-vault-password",
      }),
      insert("platform_vault", {
        platform_name: "example",
        account_email: "other@example.test",
        email_source: "cf_domain",
      }),
    ]);
    const missing = await f.request("/api/automation/mailbox", { vault_id: 1 });
    responseConforms("inspectMailbox", missing.data);
    assert.equal(missing.data.data.health.state, "missing");
    assert.equal(missing.data.data.health.can_lookup, false);
    assert.equal(missing.data.data.live_check, false);
    assert.ok(!JSON.stringify(missing.data).includes("private-vault-password"));
    const ambiguity = await f.request("/api/automation/verification", {
      platform: "EXAMPLE",
    });
    assert.equal(ambiguity.response.status, 409);
    assert.equal(ambiguity.data.error, "AMBIGUOUS_TARGET");
    assert.equal(ambiguity.data.retryable, false);
    const unknown = await f.request("/api/automation/verification", {
      email: "external@example.org",
    });
    assert.equal(unknown.data.error, "UNSUPPORTED_SOURCE");
    assert.equal(unknown.data.success, false);
    const noPool = await f.request("/api/automation/verification", {
      email: "MISSING@OUTLOOK.COM",
    });
    assert.equal(noPool.response.status, 404);
    assert.equal(noPool.data.error, "ACCOUNT_NOT_FOUND");
    for (const input of [
      {},
      { email: "a@example.test", vault_id: 1 },
      { vault_id: 1, source: "outlook" },
      { platform: " " },
      { email: "bad" },
      { email: "a@example.test", since: "2026-11-15 12:00" },
    ]) {
      assert.equal(
        (await f.request("/api/automation/verification", input)).response
          .status,
        400,
      );
    }
    assert.equal(
      (await f.request("/api/automation/mailbox", { vault_id: 900 })).response
        .status,
      404,
    );
  } finally {
    await f.dispose();
  }
});

test("batch verification preserves order and distinguishes found, empty, invalid and provider retryable failures", async () => {
  const f = await database();
  try {
    await db(f.env).mutate([
      insert("cf_inbox_mails", {
        recipient: "found@example.test",
        sender: "auth@example.test",
        subject: "Your verification code is 246810",
        verification_code: "246810",
        created_at: "2026-11-15T01:00:00Z",
      }),
      insert("accounts", ACCOUNT),
    ]);
    const r = await microsoft(
      () =>
        new Response(JSON.stringify({ error: "too_many_requests" }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "42" },
        }),
      () =>
        f.request("/api/automation/verification/batch", {
          items: [
            { email: "found@example.test", since: "2026-11-15T00:00:00Z" },
            { email: "found@example.test", since: "2026-11-15T02:00:00Z" },
            { email: "bad" },
            { email: "missing@outlook.com" },
            { email: ACCOUNT.email },
          ],
        }),
    );
    assert.equal(r.response.status, 200);
    responseConforms("batchLookupVerification", r.data);
    const results = r.data.data.results;
    assert.deepEqual(
      results.map((x: any) => x.index),
      [0, 1, 2, 3, 4],
    );
    assert.equal(results[0].data.outcome, "found");
    assert.equal(results[0].data.code, "246810");
    assert.equal(results[1].data.outcome, "empty");
    assert.equal(results[2].error, "INVALID_REQUEST");
    assert.equal(results[3].error, "ACCOUNT_NOT_FOUND");
    assert.equal(results[4].status, 429);
    assert.equal(results[4].retryable, true);
    assert.equal(results[4].retry_after, 42);
    assert.deepEqual(r.data.data.summary, {
      total: 5,
      succeeded: 2,
      failed: 3,
    });
    const single = await microsoft(
      () =>
        new Response("{}", { status: 429, headers: { "Retry-After": "42" } }),
      () => f.request("/api/automation/verification", { email: ACCOUNT.email }),
    );
    assert.equal(single.response.status, 429);
    assert.equal(single.response.headers.get("Retry-After"), "42");
    for (const items of [
      [],
      Array.from({ length: 6 }, () => ({ email: "a@example.test" })),
      "bad",
    ])
      assert.equal(
        (await f.request("/api/automation/verification/batch", { items }))
          .response.status,
        400,
      );
  } finally {
    await f.dispose();
  }
});

test("same Outlook address is serialized within a batch and each refresh uses the latest persisted token", async () => {
  const f = await database();
  try {
    await db(f.env).mutate([insert("accounts", ACCOUNT)]);
    const seen: string[] = [];
    await microsoft(
      async (url, init) => {
        if (url.hostname === "login.microsoftonline.com") {
          seen.push(
            new URLSearchParams(String(init.body)).get("refresh_token")!,
          );
          return json({
            access_token: "fake-access",
            refresh_token: `rotated-${seen.length}`,
            expires_in: 3600,
          });
        }
        return json({
          value: [
            mail(
              "message",
              "Your verification code is 246810",
              "2026-11-15T01:00:00Z",
            ),
          ],
        });
      },
      async () => {
        const r = await f.request("/api/automation/verification/batch", {
          items: [
            { email: ACCOUNT.email },
            { email: ACCOUNT.email.toUpperCase() },
          ],
        });
        assert.equal(r.data.data.summary.succeeded, 2);
        assert.ok(
          r.data.data.results.every((x: any) => x.data.outcome === "found"),
        );
      },
    );
    assert.deepEqual(seen, [ACCOUNT.refresh_token, "rotated-1"]);
    assert.equal(
      (await db(f.env).first("accounts", eq("email", ACCOUNT.email)))
        ?.refresh_token,
      "rotated-2",
    );
  } finally {
    await f.dispose();
  }
});

test("registration validates before writing and commits linked records atomically; concurrency does not duplicate a fixed prefix", async () => {
  const f = await database();
  try {
    for (const [path, body] of [
      ["/api/external/register", { platform_name: "Test", password: 123 }],
      [
        "/api/vault",
        { platform_name: "Test", generate_email: true, status: "not-valid" },
      ],
    ] as const)
      assert.equal((await f.request(path, body)).response.status, 400);
    assert.equal(await db(f.env).count("temp_mailboxes"), 0);
    assert.equal(await db(f.env).count("platform_vault"), 0);
    const attempts = await Promise.all(
      [1, 2].map(() =>
        f.request("/api/external/register", {
          platform_name: "Test",
          domain: "example.test",
          prefix: "fixed",
        }),
      ),
    );
    assert.equal(attempts.filter((r) => r.response.ok).length, 1);
    assert.equal(await db(f.env).count("temp_mailboxes"), 1);
    assert.equal(await db(f.env).count("platform_vault"), 1);
    const box = await db(f.env).first(
      "temp_mailboxes",
      eq("address", "fixed@example.test"),
    );
    const account = await db(f.env).first(
      "platform_vault",
      eq("account_email", "fixed@example.test"),
    );
    assert.equal(box?.is_permanent, 1);
    assert.equal(box?.expires_at, "");
    assert.equal(box?.associated_vault_id, account?.id);
    responseConforms(
      "registerPlatformMailbox",
      attempts.find((r) => r.response.ok)!.data,
    );
    // A later failure in the same plan must not persist an earlier vault/mailbox insert.
    const store = new DirectStore(new D1Port(f.DB));
    await assert.rejects(
      store.mutate([
        insert("platform_vault", {
          platform_name: "Rollback",
          account_email: "atomic@example.test",
          email_source: "cf_domain",
        }),
        insert("temp_mailboxes", { address: "fixed@example.test" }),
        { op: "bindMailbox", address: "atomic@example.test" },
      ]),
    );
    assert.equal(await store.count("platform_vault"), 1);
  } finally {
    await f.dispose();
  }
});

test("bulk vault updates are all-or-nothing, preserve credentials, and repeat with stable final values", async () => {
  const f = await database();
  try {
    await db(f.env).mutate([
      insert("platform_vault", {
        platform_name: "Test",
        account_email: "a@example.test",
        password: "private",
        status: "active",
      }),
      insert("platform_vault", {
        platform_name: "Other",
        account_email: "b@example.test",
      }),
    ]);
    const body = {
      ids: [1, 2, 1],
      patch: { status: "pending", is_pinned: true, category: "Dev" },
    };
    for (let i = 0; i < 2; i++) {
      const r = await f.request("/api/vault/batch", body);
      assert.equal(r.data.data.changed, 2);
      assert.deepEqual(r.data.data.ids, [1, 2]);
      responseConforms("batchUpdateVaultAccounts", r.data);
    }
    const missing = await f.request("/api/vault/batch", {
      ids: [1, 999],
      patch: { status: "banned" },
    });
    assert.equal(missing.response.status, 409);
    const first = await db(f.env).first("platform_vault", eq("id", 1));
    assert.equal(first?.status, "pending");
    assert.equal(first?.password, "private");
    assert.equal(first?.is_pinned, 1);
    for (const bad of [
      { ids: [], patch: { is_pinned: true } },
      { ids: [1], patch: {} },
      { ids: [1], patch: { password: "no" } },
      { ids: [1], patch: { is_pinned: 1 } },
      { ids: Array(101).fill(1), patch: { status: "active" } },
    ])
      assert.equal(
        (await f.request("/api/vault/batch", bad)).response.status,
        400,
      );
    await db(f.env).mutate([
      {
        op: "insert",
        table: "platform_vault",
        rows: Array.from({ length: 98 }, (_, i) => ({
          platform_name: `Batch ${i}`,
          account_email: `batch-${i}@example.test`,
        })),
      },
    ]);
    const fullBatch = await f.request("/api/vault/batch", {
      ids: Array.from({ length: 100 }, (_, i) => i + 1),
      patch: { category: "Full batch" },
    });
    assert.equal(fullBatch.response.status, 200);
    assert.equal(fullBatch.data.data.changed, 100);
    assert.equal(
      await db(f.env).count("platform_vault", eq("category", "Full batch")),
      100,
    );
  } finally {
    await f.dispose();
  }
});

test("incremental CF mail retrieval and mark_read=false preserve unread state while old defaults remain compatible", async () => {
  const f = await database();
  try {
    await db(f.env).mutate([
      insert("cf_inbox_mails", {
        recipient: "a@example.test",
        subject: "new",
        created_at: "2026-11-15T01:00:00Z",
      }),
      insert("cf_inbox_mails", {
        recipient: "a@example.test",
        subject: "old",
        created_at: "2026-11-14T01:00:00Z",
      }),
    ]);
    const listing = await f.request(
      "/api/cf-mails?since=2026-11-15T00%3A00%3A00Z",
    );
    responseConforms("listDomainMail", listing.data);
    assert.equal(listing.data.total, 1);
    const read = await f.request("/api/cf-mails/1?mark_read=false");
    responseConforms("getDomainMail", read.data);
    assert.equal(read.data.data.is_read, 0);
    assert.equal(
      (await db(f.env).first("cf_inbox_mails", eq("id", 1)))?.is_read,
      0,
    );
    assert.equal((await f.request("/api/cf-mails/1")).data.data.is_read, 1);
    assert.equal(
      (await f.request("/api/cf-mails?since=invalid")).response.status,
      400,
    );
    assert.equal(
      (await f.request("/api/cf-mails/1?mark_read=0")).response.status,
      400,
    );
    for (const [path, operation] of [
      ["/api/vault", "listVaultAccounts"],
      ["/api/mailboxes", "listMailboxes"],
      ["/api/outlook/accounts", "listOutlookAccounts"],
      ["/api/outlook/renewal", "getOutlookRenewal"],
      ["/api/settings/domains", "listDomainSettings"],
    ])
      responseConforms(operation, (await f.request(path)).data);
  } finally {
    await f.dispose();
  }
});

test("2.4 contract exposes actual success statuses, grants, body bounds and durable idempotency limits", () => {
  const spec = openApi();
  assert.equal(API_VERSION, "2.4.0");
  assert.equal(spec.info.version, API_VERSION);
  const entry = (operationId: string) => {
    const operation = operations.find((o) => o.operationId === operationId)!;
    return spec.paths[operation.path][operation.method] as any;
  };
  for (const [name, status] of [
    ["sendOutlookMail", 202],
    ["replyOutlookMail", 202],
    ["createScopedApiKey", 201],
    ["createWebhook", 201],
  ] as const) {
    assert.ok(entry(name).responses[status]);
    assert.equal(entry(name).responses[200], undefined, name);
  }
  for (const name of ["sendOutlookMail", "replyOutlookMail"]) {
    const documented = entry(name);
    assert.equal(
      documented["x-request-body-max-bytes"],
      OUTLOOK_SEND_LIMITS.request_bytes,
    );
    assert.deepEqual(documented["x-authorization"].required_grants, ["admin"]);
    assert.deepEqual(
      documented["x-rate-limit"].windows.map((w: any) => w.attempts),
      [
        OUTLOOK_SEND_LIMITS.attempts_per_minute,
        OUTLOOK_SEND_LIMITS.attempts_per_quarter_hour,
      ],
    );
    assert.equal(
      documented["x-idempotency"].completed_retention_seconds,
      IDEMPOTENCY_RETENTION_SECONDS,
    );
    assert.equal(
      documented["x-idempotency"].max_response_bytes,
      IDEMPOTENCY_RESPONSE_LIMIT,
    );
  }
  assert.equal(
    entry("restoreBackup")["x-request-body-max-bytes"],
    2 * 1024 * 1024,
  );
  assert.ok(
    entry("restoreBackup").parameters.some(
      (p: any) => p.name === "Idempotency-Key" && p.required,
    ),
  );
  assert.deepEqual(
    entry("registerPlatformMailbox")["x-authorization"].required_grants,
    ["mailbox:write", "vault:write"],
  );
  assert.deepEqual(
    entry("lookupVerification")["x-authorization"].required_grants,
    ["verify:read"],
  );
  for (const name of [
    "listScopedApiKeys",
    "listAuditLog",
    "getBackupManifest",
    "getCredentialProtection",
    "listWebhooks",
    "startOutlookOAuth",
    "exchangeOutlookOAuth",
    "finishOutlookOAuth",
    "getApiKey",
    "changeAdminPassword",
  ]) {
    assert.deepEqual(entry(name).security, [{ AdminSession: [] }], name);
    assert.equal(entry(name)["x-authorization"].admin_scope_override, false);
  }
  assert.deepEqual(entry("getOutlookRecovery").security, [
    { ApiKey: [] },
    { BearerAuth: [] },
    { AdminSession: [] },
  ]);
  assert.deepEqual(
    entry("getOutlookRecovery")["x-authorization"].required_grants,
    ["admin"],
  );
  assert.equal(
    entry("getOutlookRecovery")["x-authorization"].resource_restrictions_apply,
    true,
  );
  for (const name of [
    "startOutlookOAuth",
    "exchangeOutlookOAuth",
    "getOutlookRecovery",
  ])
    assert.equal(entry(name)["x-credential-response"], false);
  const attention = entry("listOutlookAccounts").parameters.find(
    (p: any) => p.name === "attention",
  );
  assert.deepEqual(attention.schema.enum, ["true", "false"]);
  assert.equal(attention.schema.default, undefined);
  assert.deepEqual(
    entry("exportOutlookAccounts").parameters.find(
      (p: any) => p.name === "attention",
    ),
    attention,
  );
  const limitProperties = (schemas.BackupCapabilities.properties as any).limits
    .properties;
  assert.equal(limitProperties.max_plaintext_bytes.const, BACKUP_MAX_BYTES);
  assert.equal(limitProperties.max_rows.const, BACKUP_MAX_ROWS);
  assert.equal(
    (schemas.EncryptedBackup.properties as any).encryption.properties.iterations
      .const,
    BACKUP_PBKDF2_ITERATIONS,
  );
  assert.equal(
    spec.webhooks.mailhubEvent.post["x-delivery-policy"].max_attempts,
    WEBHOOK_MAX_ATTEMPTS,
  );
  for (const name of ["listVaultAccounts", "listPlatforms"]) {
    assert.equal(
      entry(name).parameters.find((p: any) => p.name === "mailbox").schema
        .format,
      "email",
    );
  }
  const postman = postmanCollection("https://mailhub.test");
  const restore = postman.item
    .flatMap((g) => g.item)
    .find((r) => r.name.startsWith("restoreBackup ·"))!;
  assert.equal(
    restore.request.header.find((h) => h.key === "Idempotency-Key")!.disabled,
    false,
  );
  assert.equal(restore.request.auth?.type, "noauth");
});

test("OAuth contract validates both start modes and a mocked manual exchange without exposing credentials", async () => {
  const f = await database();
  try {
    f.env.MICROSOFT_CLIENT_ID = ACCOUNT.client_id;
    f.env.MICROSOFT_CLIENT_SECRET = "contract-fixture-web-secret";
    const session = {
      Cookie: `mailhub_session=${await createSessionToken("admin", await getSessionSecret(f.env))}`,
    };
    const created = await f.request("/api/outlook/accounts", {
      ...ACCOUNT,
      status: "disabled",
    });
    const accountId = created.data.data.id;
    const before = Math.floor(Date.now() / 1000);
    const web = await f.request(
      "/api/outlook/oauth/start",
      {},
      "POST",
      session,
    );
    assert.equal(web.response.status, 200);
    responseConforms("startOutlookOAuth", web.data);
    assert.equal(web.data.data.mode, "web");
    assert.equal(web.data.data.client_id, ACCOUNT.client_id);
    assert.equal(
      web.data.data.redirect_uri,
      "https://mailhub.test/api/outlook/oauth/callback",
    );

    const request = {
      mode: "manual",
      account_id: accountId,
      email: ACCOUNT.email,
      send_mail: false,
    };
    conforms(schemas.OutlookOAuthStart, request, "manual start request");
    const manual = await f.request(
      "/api/outlook/oauth/start",
      request,
      "POST",
      session,
    );
    assert.equal(manual.response.status, 200);
    responseConforms("startOutlookOAuth", manual.data);
    assert.equal(manual.data.data.mode, "manual");
    assert.equal(manual.data.data.client_id, PUBLIC_CLIENT_ID);
    assert.equal(manual.data.data.redirect_uri, MANUAL_REDIRECT_URI);
    for (const start of [web.data, manual.data]) {
      const params = new URL(start.url).searchParams;
      assert.equal(params.get("state"), start.data.state);
      assert.equal(params.get("redirect_uri"), start.data.redirect_uri);
      assert.equal(params.get("code_challenge_method"), "S256");
      assert.equal(params.get("scope")!.includes("Mail.Send"), false);
      assert.ok(start.data.expires_at >= before + 600);
      assert.ok(start.data.expires_at <= Math.floor(Date.now() / 1000) + 600);
      for (const secret of [
        ACCOUNT.refresh_token,
        ACCOUNT.password,
        f.env.MICROSOFT_CLIENT_SECRET,
      ])
        assert.ok(!JSON.stringify(start).includes(secret));
    }
    assert.throws(() =>
      responseConforms("startOutlookOAuth", {
        success: true,
        url: web.data.url,
      }),
    );
    assert.throws(() =>
      responseConforms("startOutlookOAuth", {
        ...manual.data,
        data: { ...manual.data.data, expires_at: "1794787800" },
      }),
    );
    const exchange = {
      state: manual.data.data.state,
      response: `${MANUAL_REDIRECT_URI}/?${new URLSearchParams({ state: manual.data.data.state, code: "fixture-code" })}`,
    };
    for (const response of [exchange.response, "fixture-code"])
      conforms(
        schemas.OutlookOAuthExchange,
        { ...exchange, response },
        "manual exchange request",
      );
    let tokenCalls = 0,
      profileCalls = 0;
    await microsoft(
      (url, init) => {
        if (url.hostname === "login.microsoftonline.com") {
          tokenCalls++;
          const params = new URLSearchParams(String(init.body));
          assert.equal(params.get("client_id"), PUBLIC_CLIENT_ID);
          assert.equal(params.get("client_secret"), null);
          assert.equal(params.get("redirect_uri"), MANUAL_REDIRECT_URI);
          assert.ok(params.get("code_verifier"));
          return json({
            access_token: "fixture-access-token",
            refresh_token: ACCOUNT.refresh_token + "-new",
          });
        }
        assert.equal(url.pathname, "/v1.0/me");
        profileCalls++;
        return json({ mail: ACCOUNT.email });
      },
      async () => {
        const saved = await f.request(
          "/api/outlook/oauth/exchange",
          exchange,
          "POST",
          session,
        );
        assert.equal(saved.response.status, 200, JSON.stringify(saved.data));
        responseConforms("exchangeOutlookOAuth", saved.data);
        assert.deepEqual(saved.data.data, {
          id: accountId,
          email: ACCOUNT.email,
          status: "disabled",
          auth_status: "unchecked",
        });
        for (const field of [
          "password",
          "refresh_token",
          "access_token",
          "client_secret",
        ])
          assert.throws(() =>
            responseConforms("exchangeOutlookOAuth", {
              ...saved.data,
              data: { ...saved.data.data, [field]: "fixture-secret" },
            }),
          );
        assert.equal(
          (
            await f.request(
              "/api/outlook/oauth/exchange",
              exchange,
              "POST",
              session,
            )
          ).response.status,
          409,
        );
      },
    );
    assert.equal(tokenCalls, 1);
    assert.equal(profileCalls, 1);
    for (const path of [
      "/api/outlook/oauth/start",
      "/api/outlook/oauth/exchange",
    ])
      assert.equal(
        (await f.request(path, {}, "POST")).response.status,
        401,
        path,
      );
  } finally {
    await f.dispose();
  }
});

test("recovery contract validates safe account fields, diagnosis actions and email-restricted admin access", async () => {
  const f = await database();
  try {
    const session = {
      Cookie: `mailhub_session=${await createSessionToken("admin", await getSessionSecret(f.env))}`,
    };
    const account = await f.request("/api/outlook/accounts", ACCOUNT);
    const accountId = account.data.data.id;
    const path = `/api/outlook/accounts/${accountId}/recovery`;
    await microsoft(
      () => assert.fail("Recovery must not contact Microsoft"),
      async () => {
        for (const [patch, action] of [
          [{ status: "disabled" }, "enable"],
          [{ last_error_code: "invalid_client" }, "configure"],
          [{ last_error_code: "ErrorAccessDenied" }, "authorize"],
          [{ auth_status: "reauth_required" }, "authorize"],
          [{ token_refresh_status: "retrying" }, "retry"],
          [{ auth_status: "error" }, "check"],
          [{ auth_status: "healthy" }, "check"],
          [{ auth_status: "unchecked" }, "check"],
        ] as const) {
          await db(f.env).mutate([
            update("accounts", eq("id", accountId), {
              status: "active",
              auth_status: "unchecked",
              token_refresh_status: "pending",
              last_error_code: "",
              token_refresh_error: "",
              ...patch,
            }),
          ]);
          const recovery = await f.request(path, undefined, "GET", session);
          assert.equal(recovery.response.status, 200);
          responseConforms("getOutlookRecovery", recovery.data);
          assert.equal(recovery.data.data.diagnosis.action, action);
          assert.deepEqual(
            Object.keys(recovery.data.data.account).sort(),
            [
              "id",
              "email",
              "client_id",
              "group_id",
              "status",
              "auth_status",
              "last_error",
              "last_error_code",
              "last_checked_at",
              "token_refresh_status",
              "token_refresh_error",
              "next_token_refresh_at",
            ].sort(),
          );
          for (const secret of [ACCOUNT.password, ACCOUNT.refresh_token])
            assert.ok(!JSON.stringify(recovery.data).includes(secret));
          assert.throws(() =>
            responseConforms("getOutlookRecovery", {
              ...recovery.data,
              data: {
                ...recovery.data.data,
                account: {
                  ...recovery.data.data.account,
                  refresh_token: "fixture-secret",
                },
              },
            }),
          );
          assert.throws(() =>
            responseConforms("getOutlookRecovery", {
              ...recovery.data,
              data: {
                ...recovery.data.data,
                diagnosis: {
                  ...recovery.data.data.diagnosis,
                  action: "unknown",
                },
              },
            }),
          );
        }
        for (const [scopes, emails, expectedStatus, expectedError] of [
          [["admin"], [ACCOUNT.email], 200, undefined],
          [["admin"], ["other@outlook.com"], 403, "RESOURCE_FORBIDDEN"],
          [["mailbox:write"], [ACCOUNT.email], 403, "INSUFFICIENT_SCOPE"],
        ] as const) {
          const key = await f.request(
            "/api/api-keys",
            {
              name: "Recovery contract",
              scopes,
              restrictions: { emails },
            },
            "POST",
            session,
          );
          assert.equal(key.response.status, 201);
          const recovery = await f.request(path, undefined, "GET", {
            "X-API-Key": key.data.data.key,
          });
          assert.equal(recovery.response.status, expectedStatus);
          if (expectedStatus === 200)
            responseConforms("getOutlookRecovery", recovery.data);
          else assert.equal(recovery.data.error, expectedError);
        }
      },
    );
  } finally {
    await f.dispose();
  }
});

test("Outlook list/export intersect raw auth_status with attention while summary buckets stay disjoint", async () => {
  const f = await database();
  try {
    const fixtures = [
      ["healthy", "active", "healthy", "healthy"],
      ["unchecked", "active", "unchecked", "pending"],
      ["auth", "active", "error", "pending"],
      ["renewal", "active", "healthy", "retrying"],
      ["both", "active", "reauth_required", "reauth_required"],
      ["unchecked-renewal", "active", "unchecked", "reauth_required"],
      ["disabled", "disabled", "reauth_required", "reauth_required"],
    ];
    await db(f.env).mutate(
      fixtures.map(([name, status, auth_status, token_refresh_status]) =>
        insert("accounts", {
          ...ACCOUNT,
          email: `${name}@outlook.com`,
          status,
          auth_status,
          token_refresh_status,
        }),
      ),
    );
    const summary = {
      total: 7,
      disabled: 1,
      healthy: 1,
      unchecked: 1,
      attention: 4,
    };
    for (const [query, names] of [
      ["attention=true", ["auth", "renewal", "both", "unchecked-renewal"]],
      ["attention=true&status=disabled", []],
      ["attention=true&q=renewal", ["renewal", "unchecked-renewal"]],
      ["auth_status=healthy", ["healthy", "renewal"]],
      ["auth_status=unchecked", ["unchecked", "unchecked-renewal"]],
      ["attention=true&auth_status=healthy", ["renewal"]],
      ["attention=true&auth_status=unchecked", ["unchecked-renewal"]],
      ["attention=true&auth_status=error", ["auth"]],
      ["attention=true&auth_status=reauth_required", ["both"]],
      ["attention=false", ["healthy", "unchecked", "disabled"]],
      ["attention=false&auth_status=healthy", ["healthy"]],
      ["attention=false&auth_status=unchecked", ["unchecked"]],
    ] as const) {
      const expected = names.map((name) => `${name}@outlook.com`).sort();
      const listing = await f.request(`/api/outlook/accounts?${query}`);
      assert.equal(listing.response.status, 200);
      responseConforms("listOutlookAccounts", listing.data);
      assert.deepEqual(
        listing.data.data.map((row: any) => row.email).sort(),
        expected,
        query,
      );
      assert.deepEqual(listing.data.summary, summary);
      const authStatus = new URLSearchParams(query).get("auth_status");
      if (authStatus)
        assert.ok(
          listing.data.data.every((row: any) => row.auth_status === authStatus),
          query,
        );
      const exported = await f.request(`/api/outlook/accounts/export?${query}`);
      assert.equal(exported.response.status, 200);
      responseConforms("exportOutlookAccounts", exported.data);
      assert.deepEqual(
        exported.data.accounts.map((row: any) => row.email).sort(),
        expected,
        query,
      );
    }
    const selected = await f.request(
      "/api/outlook/accounts/export?ids=1&attention=true",
    );
    responseConforms("exportOutlookAccounts", selected.data);
    assert.equal(selected.data.accounts[0].email, "healthy@outlook.com");
    assert.equal(
      (await f.request("/api/outlook/accounts?attention=false")).data.total,
      3,
    );
    assert.equal((await f.request("/api/outlook/accounts")).data.total, 7);
  } finally {
    await f.dispose();
  }
});

test("scoped key 201/metadata, session-only boundaries and composite grants match the public contract", async () => {
  const f = await database();
  try {
    const session = {
      Cookie: `mailhub_session=${await createSessionToken("admin", await getSessionSecret(f.env))}`,
    };
    const issue = async (scopes: string[], restrictions?: unknown) => {
      const result = await f.request(
        "/api/api-keys",
        {
          name: "Contract fixture",
          scopes,
          ...(restrictions ? { restrictions } : {}),
        },
        "POST",
        session,
      );
      assert.equal(result.response.status, 201, JSON.stringify(result.data));
      responseConforms("createScopedApiKey", result.data);
      return result.data.data;
    };
    const verify = await issue(["verify:read"], {
      emails: ["allowed@example.test"],
    });
    const verification = await f.request(
      "/api/automation/mailbox",
      { email: "allowed@example.test" },
      "POST",
      { "X-API-Key": verify.key },
    );
    responseConforms("inspectMailbox", verification.data);
    assert.equal(verification.response.status, 200);
    assert.equal(
      (
        await f.request(
          "/api/automation/mailbox",
          { email: "other@example.test" },
          "POST",
          { "X-API-Key": verify.key },
        )
      ).data.error,
      "RESOURCE_FORBIDDEN",
    );
    const vault = await issue(["vault:write"]);
    const allocation = {
      platform_name: "Contract",
      domain: "example.test",
      prefix: "contract",
    };
    assert.equal(
      (
        await f.request("/api/external/register", allocation, "POST", {
          "X-API-Key": vault.key,
        })
      ).data.error,
      "INSUFFICIENT_SCOPE",
    );
    assert.equal(
      (
        await f.request(
          "/api/vault",
          { platform_name: "Contract", generate_email: true },
          "POST",
          { "X-API-Key": vault.key },
        )
      ).data.error,
      "INSUFFICIENT_SCOPE",
    );
    const combined = await issue(["vault:write", "mailbox:write"]);
    const registered = await f.request(
      "/api/external/register",
      allocation,
      "POST",
      { "X-API-Key": combined.key },
    );
    assert.equal(registered.response.status, 200);
    responseConforms("registerPlatformMailbox", registered.data);
    const admin = await issue(["admin"]);
    for (const path of [
      "/api/api-keys",
      "/api/audit",
      "/api/backups/manifest",
      "/api/settings/credentials",
      "/api/settings/webhooks",
      "/api/settings/api-key",
    ]) {
      for (const key of [f.env.API_KEY!, admin.key]) {
        const denied = await f.request(path, undefined, "GET", {
          "X-API-Key": key,
        });
        assert.equal(denied.response.status, 401, path);
        assert.equal(denied.data.error, "ADMIN_SESSION_REQUIRED", path);
      }
    }
    const listed = await f.request("/api/api-keys", undefined, "GET", session);
    responseConforms("listScopedApiKeys", listed.data);
    assert.ok(!JSON.stringify(listed.data).includes(verify.key));
    const restrictedAdmin = await issue(["admin"], {
      emails: ["contract@example.test"],
    });
    assert.equal(
      (
        await f.request(
          "/api/vault?mailbox=contract@example.test",
          undefined,
          "GET",
          { "X-API-Key": restrictedAdmin.key },
        )
      ).data.error,
      "RESOURCE_SCOPE_REQUIRED",
    );
    responseConforms(
      "listAuditLog",
      (await f.request("/api/audit?limit=100", undefined, "GET", session)).data,
    );
    responseConforms(
      "purgeAuditLog",
      (
        await f.request(
          "/api/audit",
          { before: "2000-01-01T00:00:00Z" },
          "DELETE",
          session,
        )
      ).data,
    );
    responseConforms(
      "revokeScopedApiKey",
      (
        await f.request(
          `/api/api-keys/${verify.id}`,
          undefined,
          "DELETE",
          session,
        )
      ).data,
    );
    assert.equal(
      (
        await f.request("/api/capabilities", undefined, "GET", {
          "X-API-Key": verify.key,
        })
      ).response.status,
      401,
    );
  } finally {
    await f.dispose();
  }
});

test("vault mailbox filtering is exact and case-insensitive; summaries expose has_totp without secrets", async () => {
  const f = await database();
  try {
    await db(f.env).mutate([
      insert("platform_vault", {
        platform_name: "Alpha",
        account_email: "Case@example.test",
        password: "contract-private-password",
        totp_secret: "JBSWY3DPEHPK3PXP",
      }),
      insert("platform_vault", {
        platform_name: "Beta",
        account_email: "case@example.test",
      }),
      insert("platform_vault", {
        platform_name: "Other",
        account_email: "showcase@example.test",
      }),
    ]);
    const first = await f.request(
      "/api/vault?mailbox=CASE%40EXAMPLE.TEST&limit=1&page=1",
    );
    const second = await f.request(
      "/api/vault?mailbox=CASE%40EXAMPLE.TEST&limit=1&page=2",
    );
    for (const result of [first, second])
      responseConforms("listVaultAccounts", result.data);
    assert.equal(first.data.total, 2);
    assert.notEqual(first.data.data[0].id, second.data.data[0].id);
    assert.deepEqual(
      [first.data.data[0].has_totp, second.data.data[0].has_totp].sort(),
      [0, 1],
    );
    assert.ok(
      !JSON.stringify([first.data, second.data]).includes("JBSWY3DPEHPK3PXP"),
    );
    const platforms = await f.request(
      "/api/vault/platforms?mailbox=case%40example.test",
    );
    responseConforms("listPlatforms", platforms.data);
    assert.equal(platforms.data.total, 2);
  } finally {
    await f.dispose();
  }
});

test("documented 202 send/reply and 5 MiB body boundary work with durable replay and account rate limits", async () => {
  const f = await database();
  try {
    await db(f.env).mutate([insert("accounts", ACCOUNT)]);
    let sent = 0;
    const send = {
      to: ["recipient@example.test"],
      subject: "Contract test",
      body: "Test",
    };
    await microsoft(
      (url) =>
        url.hostname === "login.microsoftonline.com"
          ? json({
              access_token: "fixture",
              expires_in: 3600,
              scope: "Mail.ReadWrite Mail.Send",
            })
          : (sent++, new Response(null, { status: 202 })),
      async () => {
        const headers = {
          "X-API-Key": f.env.API_KEY!,
          "Idempotency-Key": "contract-send-202",
        };
        const first = await f.request(
          "/api/outlook/accounts/1/send",
          send,
          "POST",
          headers,
        );
        assert.equal(first.response.status, 202, JSON.stringify(first.data));
        responseConforms("sendOutlookMail", first.data);
        const replay = await f.request(
          "/api/outlook/accounts/1/send",
          send,
          "POST",
          headers,
        );
        assert.equal(replay.response.status, 202);
        assert.equal(
          replay.response.headers.get("Idempotency-Replayed"),
          "true",
        );
        assert.deepEqual(replay.data, first.data);
        const reply = await f.request(
          "/api/outlook/accounts/1/messages/message-1/reply",
          { body: "Reply" },
        );
        assert.equal(reply.response.status, 202);
        responseConforms("replyOutlookMail", reply.data);
        for (
          let attempt = 2;
          attempt < OUTLOOK_SEND_LIMITS.attempts_per_minute;
          attempt++
        )
          assert.equal(
            (await f.request("/api/outlook/accounts/1/send", send)).response
              .status,
            202,
          );
        const limited = await f.request(
          "/api/outlook/accounts/1/messages/message-1/reply",
          { body: "Rate limited" },
        );
        assert.equal(limited.response.status, 429);
        conforms(schemas.Error, limited.data, "rate limit");
        assert.equal(limited.data.error, "SEND_RATE_LIMITED");
        assert.equal(
          limited.response.headers.get("Retry-After"),
          String(limited.data.retry_after),
        );
        assert.equal(sent, OUTLOOK_SEND_LIMITS.attempts_per_minute);
      },
    );
    const oversized = await f.request("/api/outlook/accounts/1/send", {
      ...send,
      body: "x".repeat(5 * 1024 * 1024),
    });
    assert.equal(oversized.response.status, 413);
    assert.equal(oversized.data.error, "REQUEST_TOO_LARGE");
    const ordinary = await f.request("/api/vault", {
      platform_name: "Too large",
      remark: "x".repeat(2 * 1024 * 1024),
    });
    assert.equal(ordinary.response.status, 413);
    // Above the ordinary 2 MiB bound still reaches send's field validator under its 5 MiB limit.
    const sendValidation = await f.request("/api/outlook/accounts/1/send", {
      ...send,
      body: "x".repeat(2 * 1024 * 1024 + 1),
    });
    assert.equal(sendValidation.response.status, 400);
  } finally {
    await f.dispose();
  }
});

test("idempotency completion expires without promising reexecution; unknown remains durable past retention", async () => {
  const f = await database();
  try {
    const headers = {
      "X-API-Key": f.env.API_KEY!,
      "Idempotency-Key": "contract-retention",
    };
    const input = {
      platform_name: "Retention",
      domain: "example.test",
      prefix: "retention",
    };
    const first = await f.request(
      "/api/external/register",
      input,
      "POST",
      headers,
    );
    assert.equal(first.response.status, 200);
    const expiry = first.response.headers.get("Idempotency-Key-Expires-At")!;
    assert.ok(
      Math.abs(
        Date.parse(expiry) - Date.now() - IDEMPOTENCY_RETENTION_SECONDS * 1000,
      ) < 5000,
    );
    const replay = await f.request(
      "/api/external/register",
      input,
      "POST",
      headers,
    );
    assert.deepEqual(replay.data, first.data);
    const [record] = await db(f.env).select("idempotency_requests");
    await db(f.env).mutate([
      update("idempotency_requests", eq("id", record.id), {
        expires_at: "2000-01-01T00:00:00Z",
      }),
    ]);
    assert.equal(
      (await f.request("/api/external/register", input, "POST", headers)).data
        .error,
      "IDEMPOTENCY_UNKNOWN",
    );
    await db(f.env).mutate([
      update("idempotency_requests", eq("id", record.id), { state: "unknown" }),
    ]);
    await f.request(
      "/api/external/register",
      { ...input, prefix: "second" },
      "POST",
      { ...headers, "Idempotency-Key": "contract-fresh" },
    );
    assert.ok(
      await db(f.env).first("idempotency_requests", eq("id", record.id)),
    );
    assert.equal(
      (await f.request("/api/external/register", input, "POST", headers)).data
        .error,
      "IDEMPOTENCY_UNKNOWN",
    );
    assert.equal(
      (
        await f.request(
          "/api/external/register",
          { ...input, remark: "different" },
          "POST",
          headers,
        )
      ).data.error,
      "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(await db(f.env).count("platform_vault"), 2);
  } finally {
    await f.dispose();
  }
});

test("credential rekey, OAuth send grant and webhook management responses conform without leaking list secrets", async () => {
  const f = await database();
  try {
    f.env.CREDENTIAL_ENCRYPTION_KEY =
      "fictional-contract-credential-key-at-least-32";
    f.env.MICROSOFT_CLIENT_ID = ACCOUNT.client_id;
    f.env.MICROSOFT_CLIENT_SECRET = "fictional-client-secret";
    const session = {
      Cookie: `mailhub_session=${await createSessionToken("admin", await getSessionSecret(f.env))}`,
    };
    await db(f.env).mutate([insert("accounts", ACCOUNT)]);
    responseConforms(
      "getCredentialProtection",
      (await f.request("/api/settings/credentials", undefined, "GET", session))
        .data,
    );
    for (const table of [
      "accounts",
      "platform_vault",
      "oauth_sessions",
      "webhooks",
    ]) {
      const result = await f.request(
        "/api/settings/credentials/rekey",
        { table, cursor: table === "oauth_sessions" ? "" : 0 },
        "POST",
        session,
      );
      assert.equal(result.response.status, 200);
      responseConforms("rekeyCredentials", result.data);
    }
    for (const send_mail of [false, true]) {
      const started = await f.request(
        "/api/outlook/oauth/start",
        { send_mail },
        "POST",
        session,
      );
      assert.equal(started.response.status, 200);
      responseConforms("startOutlookOAuth", started.data);
      assert.equal(
        new URL(started.data.url).searchParams
          .get("scope")!
          .includes("Mail.Send"),
        send_mail,
      );
    }
    const hook = await f.request(
      "/api/settings/webhooks",
      {
        name: "Contract webhook",
        url: "https://hooks.example.org/mailhub",
        events: ["mail.received"],
      },
      "POST",
      session,
    );
    assert.equal(hook.response.status, 201);
    responseConforms("createWebhook", hook.data);
    const listing = await f.request(
      "/api/settings/webhooks",
      undefined,
      "GET",
      session,
    );
    responseConforms("listWebhooks", listing.data);
    assert.ok(!JSON.stringify(listing.data).includes(hook.data.data.secret));
    assert.equal(listing.data.data[0].include_code, 0);
    await enqueueEvent(
      f.env,
      "mail.received",
      {
        mail_id: 1,
        recipient: "user@example.test",
        subject: "private-subject",
        code: "012345",
        link: "https://example.test/private",
      },
      "contract-event",
    );
    const [stored] = await db(f.env).select("webhook_deliveries");
    const payload = JSON.parse(String(stored.payload));
    conforms(schemas.WebhookEvent, payload, "webhook event");
    for (const field of ["subject", "code", "link"])
      assert.equal(field in payload.data, false);
    const history = await f.request(
      "/api/settings/webhooks/deliveries",
      undefined,
      "GET",
      session,
    );
    responseConforms("listWebhookDeliveries", history.data);
    assert.equal("payload" in history.data.data[0], false);
    await db(f.env).mutate([
      update("webhook_deliveries", eq("id", stored.id), { status: "dead" }),
    ]);
    responseConforms(
      "retryWebhookDelivery",
      (
        await f.request(
          `/api/settings/webhooks/deliveries/${stored.id}/retry`,
          undefined,
          "POST",
          session,
        )
      ).data,
    );
    responseConforms(
      "setWebhookEnabled",
      (
        await f.request(
          `/api/settings/webhooks/${hook.data.data.id}`,
          { enabled: false },
          "PATCH",
          session,
        )
      ).data,
    );
    responseConforms(
      "deleteWebhook",
      (
        await f.request(
          `/api/settings/webhooks/${hook.data.data.id}`,
          undefined,
          "DELETE",
          session,
        )
      ).data,
    );
  } finally {
    await f.dispose();
  }
});

test("CF raw/attachment endpoints serve binary downloads and expose only the public directory", async () => {
  const f = await database();
  try {
    const mime =
      'From: sender@example.test\r\nTo: user@example.test\r\nSubject: Attachment\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="contract"\r\n\r\n--contract\r\nContent-Type: text/plain\r\n\r\nHello\r\n--contract\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="note.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\nbm90ZQ==\r\n--contract--\r\n';
    const rawKey = "mail/11111111-2222-4333-8444-555555555555/raw.eml";
    f.env.MAIL_OBJECTS = {
      get: async (key: string) => {
        assert.equal(key, rawKey);
        const bytes = new TextEncoder().encode(mime);
        return {
          body: new Response(bytes).body,
          arrayBuffer: async () => bytes.buffer,
        };
      },
    } as unknown as R2Bucket;
    await db(f.env).mutate([
      insert("cf_inbox_mails", {
        recipient: "user@example.test",
        sender: "sender@example.test",
        raw_object_key: rawKey,
        attachment_manifest: JSON.stringify([
          { id: "0", name: "note.txt", size: 4, contentType: "text/plain" },
        ]),
      }),
    ]);
    const detail = await f.request("/api/cf-mails/1?mark_read=false");
    responseConforms("getDomainMail", detail.data);
    assert.equal(detail.data.data.has_raw, true);
    assert.equal("raw_object_key" in detail.data.data, false);
    assert.equal("attachment_manifest" in detail.data.data, false);
    for (const [path, expected] of [
      ["raw", mime],
      ["attachments/0", "note"],
    ]) {
      const response = await app.request(
        `https://mailhub.test/api/cf-mails/1/${path}`,
        { headers: { "X-API-Key": f.env.API_KEY! } },
        f.env,
      );
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("Content-Type"),
        "application/octet-stream",
      );
      assert.match(
        response.headers.get("Content-Disposition")!,
        /^attachment;/,
      );
      assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
      assert.equal(await response.text(), expected);
    }
    assert.equal(
      (await db(f.env).first("cf_inbox_mails", eq("id", 1)))?.is_read,
      0,
    );
    delete f.env.MAIL_OBJECTS;
    const unavailable = await f.request("/api/cf-mails/1/raw");
    assert.equal(unavailable.response.status, 404);
    assert.equal(unavailable.data.error, "MAIL_OBJECT_UNAVAILABLE");
    conforms(schemas.Error, unavailable.data, "raw missing");
  } finally {
    await f.dispose();
  }
});

test("backup manifest, encrypted export, both previews and actual atomic restore match the public contract", async () => {
  const f = await database();
  try {
    const coordinator = new Coordinator(
      new MemoryControl(),
      async (_source, generation) => new D1Port(f.DB, generation),
      { id: "d1", name: "D1", kind: "d1", created: "test" },
    );
    f.env.CREDENTIAL_ENCRYPTION_KEY =
      "fictional-contract-backup-encryption-key-32";
    f.env.STORAGE = {
      idFromName: () => "test",
      get: () => ({
        fetch: async (url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body)),
            path = new URL(url).pathname;
          try {
            let data;
            if (path === "/auth/settings") data = await coordinator.security();
            else if (path === "/status") data = await coordinator.status();
            else if (path === "/data/find")
              data = await coordinator.find(body.table, body.query);
            else if (path === "/data/count")
              data = await coordinator.count(body.table, body.where);
            else if (path === "/data/mutate")
              data = await coordinator.mutate(body.mutations);
            else if (path === "/backup/restore")
              data = await coordinator.restoreBackup(body);
            else throw new Error(`Unexpected internal path ${path}`);
            return Response.json({ data });
          } catch (error) {
            if (!(error instanceof StorageError)) throw error;
            return Response.json(
              { error: error.code, message: error.message },
              { status: error.status },
            );
          }
        },
      }),
    } as unknown as Env["STORAGE"];
    const session = {
      Cookie: `mailhub_session=${await createSessionToken("admin", await getSessionSecret(f.env))}`,
    };
    await db(f.env).mutate([
      insert("platform_vault", {
        platform_name: "Saved",
        account_email: "backup@example.test",
        email_source: "external",
        password: "backup-private-password",
        totp_secret: "JBSWY3DPEHPK3PXP",
      }),
    ]);
    const manifest = await f.request(
      "/api/backups/manifest",
      undefined,
      "GET",
      session,
    );
    responseConforms("getBackupManifest", manifest.data);
    assert.equal(manifest.data.data.restore_available, true);
    assert.equal(manifest.data.data.tables.length, 12);
    assert.equal(manifest.data.data.schema_version, 11);
    assert.ok(manifest.data.data.tables.includes("platforms"));
    assert.ok(manifest.data.data.excluded.includes("R2 object contents"));
    const redacted = await f.request(
      "/api/backups/export",
      undefined,
      "GET",
      session,
    );
    responseConforms("exportRedactedBackup", redacted.data);
    assert.equal(redacted.data.manifest.restorable, false);
    assert.ok(
      !JSON.stringify(redacted.data).includes("backup-private-password"),
    );
    const passphrase = "fictional-backup-passphrase-contract";
    const exported = await f.request(
      "/api/backups/export",
      { include_credentials: true, confirm: "EXPORT_CREDENTIALS", passphrase },
      "POST",
      session,
    );
    assert.equal(exported.response.status, 200, JSON.stringify(exported.data));
    responseConforms("exportEncryptedBackup", exported.data);
    assert.ok(
      !JSON.stringify(exported.data).includes("backup-private-password"),
    );
    const request = { backup: exported.data, passphrase };
    let token = "";
    for (const [path, operation] of [
      ["dry-run", "dryRunBackup"],
      ["preview", "previewBackupRestore"],
    ]) {
      const preview = await f.request(
        `/api/backups/${path}`,
        request,
        "POST",
        session,
      );
      assert.equal(preview.response.status, 200, JSON.stringify(preview.data));
      responseConforms(operation, preview.data);
      assert.equal(preview.data.data.writes_performed, false);
      token = preview.data.data.confirmation_token;
      assert.ok(token);
    }
    const restoreBody = {
      ...request,
      confirmation_token: token,
      confirm: "RESTORE_BACKUP",
    };
    const headers = {
      ...session,
      "Idempotency-Key": "contract-backup-restore",
    };
    const restored = await f.request(
      "/api/backups/restore",
      restoreBody,
      "POST",
      headers,
    );
    assert.equal(restored.response.status, 200, JSON.stringify(restored.data));
    responseConforms("restoreBackup", restored.data);
    assert.match(restored.data.data.active.generation, /^restore-/);
    const replay = await f.request(
      "/api/backups/restore",
      restoreBody,
      "POST",
      headers,
    );
    assert.deepEqual(replay.data, restored.data);
    assert.equal(replay.response.headers.get("Idempotency-Replayed"), "true");
  } finally {
    await f.dispose();
  }
});

test("published webhook receiver verifies exact bytes, five-minute clock and delivery binding, then deduplicates after restart", async () => {
  const receiver = await import(
    `data:text/javascript;base64,${Buffer.from(webhookReceiverExample).toString("base64")}`
  );
  const directory = await mkdtemp(join(tmpdir(), "mailhub-receiver-contract-"));
  const path = join(directory, "inbox.sqlite");
  let inbox = receiver.openInbox(path);
  try {
    const secret = "fixture-signature-secret",
      subscriptionId = 7,
      nowSeconds = 1700000000;
    const config = { secret, subscriptionId, nowSeconds };
    const payload = {
      id: "contract-receiver",
      event: "mail.received",
      created_at: "2026-11-15T00:00:00Z",
      data: { recipient: "user@example.test", subject: "你好" },
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = await webhookSignature(
      secret,
      String(nowSeconds),
      raw.toString(),
    );
    assert.equal(
      signature,
      "sha256=" +
        createHmac("sha256", secret)
          .update(String(nowSeconds) + ".")
          .update(raw)
          .digest("hex"),
    );
    const headers = new Headers({
      "X-MailHub-Timestamp": String(nowSeconds),
      "X-MailHub-Signature": signature,
      "X-MailHub-Event": payload.event,
      "X-MailHub-Delivery": createHash("sha256")
        .update(JSON.stringify([payload.id, subscriptionId]))
        .digest("hex"),
    });
    assert.equal(
      receiver.receiveMailHubWebhook(raw, headers, config, inbox).status,
      204,
    );
    inbox.close();
    inbox = receiver.openInbox(path);
    assert.equal(
      receiver.receiveMailHubWebhook(raw, headers, config, inbox).status,
      204,
    );
    assert.equal(
      inbox.prepare("SELECT COUNT(*) AS count FROM inbox").get().count,
      1,
    );
    for (const offset of [-301, 301])
      assert.equal(
        receiver.receiveMailHubWebhook(
          raw,
          headers,
          { ...config, nowSeconds: nowSeconds + offset },
          inbox,
        ).status,
        400,
      );
    for (const offset of [-300, 300])
      assert.equal(
        receiver.receiveMailHubWebhook(
          raw,
          headers,
          { ...config, nowSeconds: nowSeconds + offset },
          inbox,
        ).status,
        204,
      );
    assert.equal(
      receiver.receiveMailHubWebhook(
        Buffer.concat([raw, Buffer.from("\n")]),
        headers,
        config,
        inbox,
      ).status,
      400,
    );
    assert.equal(
      receiver.receiveMailHubWebhook(
        raw,
        headers,
        { ...config, secret: "wrong-secret" },
        inbox,
      ).status,
      400,
    );
    for (const [name, value] of [
      ["X-MailHub-Delivery", "a".repeat(64)],
      ["X-MailHub-Event", "code.extracted"],
      ["X-MailHub-Signature", "sha256=ff"],
    ]) {
      const forged = new Headers(headers);
      forged.set(name, value);
      assert.equal(
        receiver.receiveMailHubWebhook(raw, forged, config, inbox).status,
        400,
      );
    }
    assert.equal(
      inbox.prepare("SELECT COUNT(*) AS count FROM inbox").get().count,
      1,
    );
    assert.ok(
      !webhookReceiverExample.includes("fetch("),
      "Receiver must not automatically follow links",
    );
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});
