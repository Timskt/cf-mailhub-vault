import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHmac } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createSessionToken, getSessionSecret } from "../src/auth";
import webhookRoutes from "../src/routes/webhooks";
import {
  db,
  eq,
  insert,
  remove,
  StorageError,
  update,
  type Row,
} from "../src/storage/client";
import type { Env } from "../src/types";
import {
  enqueueEvent,
  runWebhookDeliveries,
  verifyWebhookDestination,
  WEBHOOK_MAX_ATTEMPTS,
  webhookSignature,
  webhookUrl,
} from "../src/webhooks";

const destination =
  "https://hooks.example.org/callback?key=fictional-url-secret";
const secret = "mailhub-test-signing-key-0123456789";
let fixture: Awaited<ReturnType<typeof database>>;
let cookie: string;
const routeHost = new Hono<{ Bindings: Env }>();
routeHost.onError((error, c) =>
  c.json(
    {
      success: false,
      error: error instanceof StorageError ? error.code : "INVALID_REQUEST",
      message: error.message,
    },
    (error instanceof StorageError || error instanceof HTTPException
      ? error.status
      : 500) as 400,
  ),
);
// Mount the owned router directly: parent auth/index wiring is being edited in parallel.
routeHost.route("/hooks", webhookRoutes);
async function database() {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "webhook-tests",
          compatibilityDate: "2026-11-01",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents:
                  'export default { fetch() { return new Response("local"); } };',
              },
            },
          },
          env: { DB: { type: "d1", id: "webhook-db" } },
        },
      },
    ],
  });
  const DB = (await runtime.getD1Database("DB")) as unknown as D1Database;
  const files = (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = (
      await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8")
    )
      .replace(/--[^\n]*/g, "")
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    await DB.batch(sql.map((statement) => DB.prepare(statement)));
  }
  const env: Env = {
    DB,
    CF_DOMAINS: "example.test,mail.example.test",
    ADMIN_PASSWORD: "test-admin-password",
    COOKIE_SECRET: "test-cookie-secret",
    API_KEY: "test-api-key",
  };
  return { DB, env, dispose: () => runtime.dispose() };
}
before(async () => {
  fixture = await database();
  fixture.env.CREDENTIAL_ENCRYPTION_KEY =
    "fictional-webhook-credential-key-32-chars";
  cookie = `mailhub_session=${await createSessionToken("admin", await getSessionSecret(fixture.env))}`;
});
beforeEach(async () => {
  await db(fixture.env).mutate([
    remove("webhook_deliveries", undefined),
    remove("webhooks", undefined),
  ]);
});
after(async () => {
  await fixture?.dispose();
});

async function route(
  path: string,
  body?: unknown,
  options: { method?: string; session?: boolean; env?: Env; key?: string } = {},
) {
  const response = await routeHost.request(
    `https://mailhub.test/hooks${path === "/" ? "" : path}`,
    {
      method: options.method || (body === undefined ? "GET" : "POST"),
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.session === false ? {} : { Cookie: cookie }),
        ...(options.key ? { "X-API-Key": options.key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    options.env || fixture.env,
  );
  return { response, data: (await response.json()) as any };
}
async function hook(patch: Row = {}) {
  const [result] = await db(fixture.env).mutate([
    insert("webhooks", {
      name: "Fictional notification",
      url: destination,
      secret,
      events: '["mail.received"]',
      ...patch,
    }),
  ]);
  return result.lastId;
}
async function delivery(patch: Row = {}) {
  const webhookId = await hook();
  await enqueueEvent(
    fixture.env,
    "mail.received",
    { mail_id: 7, subject: "Fictional mail" },
    "evt-delivery",
  );
  const row = (await db(fixture.env).first(
    "webhook_deliveries",
    eq("webhook_id", webhookId),
  ))!;
  if (Object.keys(patch).length)
    await db(fixture.env).mutate([
      update("webhook_deliveries", eq("id", row.id), patch),
    ]);
  return { id: String(row.id), webhookId };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
type FetchHandler = (
  url: URL,
  init: RequestInit,
) => Response | Promise<Response>;
async function withFetch<T>(handler: FetchHandler, action: () => Promise<T>) {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    return handler(url, init);
  }) as typeof fetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = previous;
  }
}
function dns(url: URL, a = ["93.184.216.34"], aaaa: string[] = []) {
  assert.equal(url.origin, "https://cloudflare-dns.com");
  const type = url.searchParams.get("type") === "A" ? 1 : 28;
  return Response.json({
    Status: 0,
    Answer: (type === 1 ? a : aaaa).map((data) => ({ type, data })),
  });
}

test("HMAC signature matches an independently calculated UTF-8 fixed vector and binds timestamp and exact bytes", async () => {
  const payload =
    '{"id":"evt-fixed","event":"mail.received","data":{"subject":"你好"}}';
  const expected =
    "sha256=aac3187bb68f1d4edee184cd96649c890dcc4ffd2e275b68ea5efb7bf2ef7334";
  assert.equal(await webhookSignature(secret, "1700000000", payload), expected);
  assert.notEqual(
    await webhookSignature(secret, "1700000001", payload),
    expected,
  );
  assert.notEqual(
    await webhookSignature(secret, "1700000000", payload + "\n"),
    expected,
  );
  assert.notEqual(
    await webhookSignature(secret + "x", "1700000000", payload),
    expected,
  );
});

test("webhook URL validation rejects credentials, IP literals, non-HTTPS and local names", () => {
  assert.equal(webhookUrl(destination), destination);
  for (const url of [
    "http://hooks.example.org",
    "https://hooks.example.org:8443",
    "https://user:secret@hooks.example.org",
    "https://hooks.example.org/#fragment",
    "https://127.0.0.1",
    "https://2130706433",
    "https://0x7f000001",
    "https://[::1]",
    "https://localhost",
    "https://host.internal",
    "https://host.local",
    "https://host.lan",
    "https://hooks.invalid",
    "https://hooks.test",
    "file:///etc/passwd",
    "https://hooks.example.org/" + "x".repeat(2001),
  ])
    assert.throws(() => webhookUrl(url), { code: "INVALID_WEBHOOK_URL" }, url);
});

test("destination checks reject private DNS in either family, including expanded IPv6 forms", async (t) => {
  for (const ip of [
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "0:0:0:0:0:0:0:1",
    "0000:0000:0000:0000:0000:0000:0000:0001",
    "0:0:0:0:0:ffff:7f00:1",
  ])
    await t.test(ip, async () => {
      await withFetch(
        (url) =>
          ip.includes(":") ? dns(url, ["93.184.216.34"], [ip]) : dns(url, [ip]),
        async () => {
          await assert.rejects(verifyWebhookDestination(destination), {
            code: "WEBHOOK_DESTINATION_BLOCKED",
          });
        },
      );
    });
});

test("reserved IPv6 addresses are blocked consistently across equivalent zero-padded representations", async () => {
  const addresses = ["2001:db8::1", "2001:0db8::1"];
  assert.equal(
    new URL(`https://[${addresses[0]}]/`).hostname,
    new URL(`https://[${addresses[1]}]/`).hostname,
    "Both DNS answers describe exactly the same reserved address",
  );
  for (const ip of addresses) {
    await withFetch(
      (url) => dns(url, ["93.184.216.34"], [ip]),
      async () => {
        await assert.rejects(
          verifyWebhookDestination(destination),
          { code: "WEBHOOK_DESTINATION_BLOCKED" },
          ip,
        );
      },
    );
  }
});

test("DNS checks use a Workers-supported redirect policy and fail closed on redirects in real workerd", async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { verifyWebhookDestination } from './src/webhooks';
        export default { async fetch(request) {
          const redirect = new URL(request.url).searchParams.has('redirect');
          const calls = [];
          globalThis.fetch = async (input, init) => {
            const upstream = new Request(input, init);
            calls.push({url: upstream.url, redirect: upstream.redirect});
            if (redirect) return new Response(null, {status:302,headers:{Location:'https://untrusted.example.org'}});
            const type = new URL(upstream.url).searchParams.get('type') === 'A' ? 1 : 28;
            return Response.json({Status:0,Answer:type === 1 ? [{type:1,data:'93.184.216.34'}] : []});
          };
          try { return Response.json({ok:true,url:await verifyWebhookDestination('https://hooks.example.org/callback'),calls}); }
          catch (error) { return Response.json({ok:false,message:error.message,calls}); }
        }};
      `,
      resolveDir: process.cwd(),
      sourcefile: "webhook-runtime-entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "webhook-runtime-tests",
          compatibilityDate: "2026-11-01",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": { type: "esm", contents: bundle.outputFiles[0].text },
            },
          },
        },
      },
    ],
  });
  try {
    const worker = await runtime.getWorker();
    const success = (await (
      await worker.fetch("https://mailhub.test/")
    ).json()) as any;
    assert.equal(success.ok, true, JSON.stringify(success));
    assert.equal(success.calls.length, 2);
    assert.ok(success.calls.every((call: any) => call.redirect === "manual"));
    const redirected = (await (
      await worker.fetch("https://mailhub.test/?redirect=1")
    ).json()) as any;
    assert.equal(redirected.ok, false);
    assert.ok(
      redirected.calls.every(
        (call: any) => new URL(call.url).hostname === "cloudflare-dns.com",
      ),
    );
  } finally {
    await runtime.dispose();
  }
});

test("public A/AAAA answers are allowed, while empty, mixed, failed and redirected DNS lookups fail closed", async () => {
  await withFetch(
    (url) => dns(url, ["93.184.216.34"], ["2606:4700:4700::1111"]),
    async () => {
      assert.equal(await verifyWebhookDestination(destination), destination);
    },
  );
  for (const handler of [
    (url: URL) => dns(url, []),
    (url: URL) => dns(url, ["93.184.216.34", "10.0.0.7"]),
    () => Response.json({ Status: 3 }),
    () =>
      Response.json({
        Status: 0,
        Answer: [{ type: 5, data: "internal.example.org" }],
      }),
    () => new Response(null, { status: 503 }),
    () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://untrusted.example.org" },
      }),
    () => new Response("not JSON"),
    () => {
      throw new Error("DNS unavailable");
    },
  ])
    await withFetch(handler, () =>
      assert.rejects(verifyWebhookDestination(destination)),
    );
});

test("outbox subscriptions are filtered, deduplicated and redact all non-allowlisted fields with codes opt-in", async () => {
  const ordinary = await hook();
  const optedIn = await hook({
    include_code: 1,
    events: '["mail.received","code.extracted"]',
  });
  await hook({ enabled: 0 });
  await hook({ events: '["token.renew_failed"]' });
  const payload = {
    mail_id: 7,
    recipient: "receiver@example.test",
    sender: "sender@example.test",
    subject: "A".repeat(600),
    code: "246810",
    link: "https://example.test/verify?token=fictional-code-link",
    password: "password-must-not-leak",
    refresh_token: "refresh-must-not-leak",
    body: "body-must-not-leak",
    secret: "secret-must-not-leak",
    nested: { token: "nested-must-not-leak" },
  };
  await enqueueEvent(fixture.env, "mail.received", payload, "evt-identical");
  await enqueueEvent(
    fixture.env,
    "mail.received",
    { ...payload, subject: "changed duplicate" },
    "evt-identical",
  );
  const rows = await db(fixture.env).select("webhook_deliveries");
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const saved = JSON.parse(String(row.payload));
    assert.equal(saved.id, "evt-identical");
    assert.equal(saved.event, "mail.received");
    assert.equal(
      saved.data.subject,
      row.webhook_id === optedIn ? "A".repeat(500) : undefined,
    );
    assert.equal(saved.data.mail_id, 7);
    assert.ok(Number.isFinite(Date.parse(saved.created_at)));
    assert.equal(
      saved.data.code,
      row.webhook_id === optedIn ? "246810" : undefined,
    );
    assert.equal(
      saved.data.link,
      row.webhook_id === optedIn ? payload.link : undefined,
    );
    assert.ok(!String(row.payload).includes("must-not-leak"));
  }
  assert.ok(rows.some((row) => row.webhook_id === ordinary));
  await enqueueEvent(fixture.env, "code.extracted", payload, "evt-code");
  assert.equal(await db(fixture.env).count("webhook_deliveries"), 3);
});

test(
  "two simultaneous workers claim one delivery once and an active lease blocks a third worker",
  { timeout: 10000 },
  async () => {
    const { id } = await delivery();
    const started = deferred(),
      release = deferred();
    let posts = 0;
    await withFetch(
      async (url, init) => {
        if (url.hostname === "cloudflare-dns.com") return dns(url);
        posts++;
        assert.equal(init.redirect, "manual");
        assert.equal(init.method, "POST");
        const headers = new Headers(init.headers);
        assert.equal(headers.get("X-MailHub-Delivery"), id);
        assert.equal(headers.get("X-MailHub-Event"), "mail.received");
        assert.equal(headers.get("Authorization"), null);
        const signature = createHmac("sha256", secret)
          .update(`${headers.get("X-MailHub-Timestamp")}.${init.body}`)
          .digest("hex");
        assert.equal(headers.get("X-MailHub-Signature"), `sha256=${signature}`);
        started.resolve();
        await release.promise;
        return new Response(null, { status: 204 });
      },
      async () => {
        const first = runWebhookDeliveries(fixture.env),
          second = runWebhookDeliveries(fixture.env);
        try {
          await started.promise;
          assert.deepEqual(await runWebhookDeliveries(fixture.env), {
            processed: 0,
          });
          const inFlight = (await db(fixture.env).first(
            "webhook_deliveries",
            eq("id", id),
          ))!;
          assert.equal(inFlight.status, "delivering");
          assert.equal(inFlight.attempts, 1);
          assert.ok(Number(inFlight.lease_until) > Date.now());
        } finally {
          release.resolve();
          await Promise.allSettled([first, second]);
        }
        const results = await Promise.all([first, second]);
        assert.equal(
          results.reduce((sum, result) => sum + result.processed, 0),
          1,
        );
      },
    );
    assert.equal(posts, 1);
    const row = (await db(fixture.env).first(
      "webhook_deliveries",
      eq("id", id),
    ))!;
    assert.equal(row.status, "delivered");
    assert.equal(row.lease_token, "");
    assert.equal(row.lease_until, 0);
  },
);

test(
  "an expired lease is reclaimable and an old completion cannot overwrite its replacement",
  { timeout: 10000 },
  async () => {
    const { id } = await delivery();
    const started = deferred(),
      release = deferred();
    let posts = 0;
    await withFetch(
      async (url) => {
        if (url.hostname === "cloudflare-dns.com") return dns(url);
        if (++posts === 1) {
          started.resolve();
          await release.promise;
          return new Response(null, { status: 503 });
        }
        return new Response(null, { status: 204 });
      },
      async () => {
        const stale = runWebhookDeliveries(fixture.env);
        try {
          await started.promise;
          await db(fixture.env).mutate([
            update("webhook_deliveries", eq("id", id), {
              lease_until: Date.now() - 1,
            }),
          ]);
          assert.deepEqual(await runWebhookDeliveries(fixture.env), {
            processed: 1,
          });
        } finally {
          release.resolve();
          await Promise.allSettled([stale]);
        }
        await stale;
      },
    );
    const row = (await db(fixture.env).first(
      "webhook_deliveries",
      eq("id", id),
    ))!;
    assert.equal(posts, 2);
    assert.equal(row.status, "delivered");
    assert.equal(row.attempts, 2);
    assert.equal(row.http_status, 204);
    assert.equal(row.error, "");
  },
);

test("retries respect Retry-After, exponential delay and attempt ceiling without persisting response bodies", async () => {
  const { id } = await delivery();
  let posts = 0;
  await withFetch(
    (url) => {
      if (url.hostname === "cloudflare-dns.com") return dns(url);
      posts++;
      return new Response("receiver-secret-response", {
        status: 429,
        headers: { "Retry-After": "120" },
      });
    },
    async () => {
      const before = Date.now();
      await runWebhookDeliveries(fixture.env);
      const row = (await db(fixture.env).first(
        "webhook_deliveries",
        eq("id", id),
      ))!;
      assert.equal(row.status, "pending");
      assert.equal(row.attempts, 1);
      assert.ok(Number(row.next_attempt) >= before + 120000);
      assert.ok(Number(row.next_attempt) <= Date.now() + 125000);
      assert.ok(!JSON.stringify(row).includes("receiver-secret-response"));
      assert.deepEqual(await runWebhookDeliveries(fixture.env), {
        processed: 0,
      });
    },
  );
  assert.equal(posts, 1);
  await db(fixture.env).mutate([
    update("webhook_deliveries", eq("id", id), {
      attempts: WEBHOOK_MAX_ATTEMPTS - 1,
      next_attempt: 0,
    }),
  ]);
  await withFetch(
    (url) =>
      url.hostname === "cloudflare-dns.com"
        ? dns(url)
        : new Response(null, { status: 503 }),
    async () => {
      await runWebhookDeliveries(fixture.env);
      assert.deepEqual(await runWebhookDeliveries(fixture.env), {
        processed: 0,
      });
    },
  );
  const dead = (await db(fixture.env).first(
    "webhook_deliveries",
    eq("id", id),
  ))!;
  assert.equal(dead.status, "dead");
  assert.equal(dead.attempts, WEBHOOK_MAX_ATTEMPTS);
});

test("Retry-After HTTP dates, invalid headers, exponential fallback and the one-day cap are bounded", async (t) => {
  for (const [name, attempts, header, minimum, maximum] of [
    [
      "HTTP date",
      0,
      new Date(Date.now() + 180000).toUTCString(),
      170000,
      185000,
    ],
    ["invalid value", 2, "not a date", 120000, 125000],
    ["past HTTP date", 0, "Sat, 01 Jan 2000 00:00:00 GMT", 30000, 35000],
    ["one day cap", 0, "999999999999999999", 86400000, 86400000],
  ] as const)
    await t.test(name, async () => {
      await db(fixture.env).mutate([
        remove("webhook_deliveries", undefined),
        remove("webhooks", undefined),
      ]);
      const { id } = await delivery({ attempts });
      const before = Date.now();
      await withFetch(
        (url) =>
          url.hostname === "cloudflare-dns.com"
            ? dns(url)
            : new Response(null, {
                status: 503,
                headers: { "Retry-After": header },
              }),
        async () => {
          await runWebhookDeliveries(fixture.env);
        },
      );
      const row = (await db(fixture.env).first(
        "webhook_deliveries",
        eq("id", id),
      ))!;
      assert.equal(row.status, "pending");
      assert.ok(Number(row.next_attempt) >= before + minimum);
      assert.ok(Number(row.next_attempt) <= Date.now() + maximum);
    });
});

test(
  "dispatcher processes at most ten records per run and at most two concurrent HTTP deliveries",
  { timeout: 10000 },
  async () => {
    await hook();
    for (let i = 0; i < 11; i++)
      await enqueueEvent(
        fixture.env,
        "mail.received",
        { mail_id: i },
        `batch-${i}`,
      );
    let posts = 0,
      active = 0,
      maximum = 0;
    let pair: (() => void)[] = [];
    await withFetch(
      async (url) => {
        if (url.hostname === "cloudflare-dns.com") return dns(url);
        posts++;
        active++;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => {
          pair.push(resolve);
          if (pair.length === 2) {
            const ready = pair;
            pair = [];
            ready.forEach((done) => done());
          }
        });
        active--;
        return new Response(null, { status: 204 });
      },
      async () => {
        assert.deepEqual(await runWebhookDeliveries(fixture.env), {
          processed: 10,
        });
      },
    );
    assert.equal(posts, 10);
    assert.equal(maximum, 2);
    assert.equal(
      await db(fixture.env).count(
        "webhook_deliveries",
        eq("status", "pending"),
      ),
      1,
    );
  },
);

test("a crashed final attempt cannot exceed the maximum delivery count on lease recovery", async () => {
  const { id } = await delivery({
    attempts: WEBHOOK_MAX_ATTEMPTS,
    status: "delivering",
    lease_token: "crashed-final-attempt",
    lease_until: Date.now() - 1,
  });
  let posts = 0;
  await withFetch(
    (url) => {
      if (url.hostname === "cloudflare-dns.com") return dns(url);
      posts++;
      return new Response(null, { status: 204 });
    },
    async () => {
      await runWebhookDeliveries(fixture.env);
    },
  );
  assert.equal(posts, 0, "An expired final lease must not issue a ninth POST");
  const row = (await db(fixture.env).first(
    "webhook_deliveries",
    eq("id", id),
  ))!;
  assert.equal(row.status, "dead");
  assert.equal(row.attempts, WEBHOOK_MAX_ATTEMPTS);
});

test(
  "a live final lease is preserved and its late completion cannot overwrite exhaustion after lease expiry",
  { timeout: 10000 },
  async () => {
    const { id } = await delivery({ attempts: WEBHOOK_MAX_ATTEMPTS - 1 });
    const started = deferred(),
      release = deferred();
    let posts = 0;
    await withFetch(
      async (url) => {
        if (url.hostname === "cloudflare-dns.com") return dns(url);
        posts++;
        started.resolve();
        await release.promise;
        return new Response(null, { status: 204 });
      },
      async () => {
        const pending = runWebhookDeliveries(fixture.env);
        try {
          await started.promise;
          await runWebhookDeliveries(fixture.env);
          const active = (await db(fixture.env).first(
            "webhook_deliveries",
            eq("id", id),
          ))!;
          assert.equal(active.status, "delivering");
          assert.equal(active.attempts, WEBHOOK_MAX_ATTEMPTS);
          assert.ok(Number(active.lease_until) > Date.now());
          await db(fixture.env).mutate([
            update("webhook_deliveries", eq("id", id), {
              lease_until: Date.now() - 1,
            }),
          ]);
          await Promise.all([
            runWebhookDeliveries(fixture.env),
            runWebhookDeliveries(fixture.env),
          ]);
          const exhausted = (await db(fixture.env).first(
            "webhook_deliveries",
            eq("id", id),
          ))!;
          assert.equal(exhausted.status, "dead");
          assert.equal(exhausted.lease_token, "");
          assert.equal(exhausted.lease_until, 0);
        } finally {
          release.resolve();
          await Promise.allSettled([pending]);
        }
        await pending;
      },
    );
    const row = (await db(fixture.env).first(
      "webhook_deliveries",
      eq("id", id),
    ))!;
    assert.equal(posts, 1);
    assert.equal(row.status, "dead");
    assert.equal(row.attempts, WEBHOOK_MAX_ATTEMPTS);
    assert.notEqual(row.http_status, 204);
  },
);

test("exhausted pending and delivering rows cannot trigger DNS or POST even above the configured ceiling", async () => {
  const ids: string[] = [];
  for (const status of ["pending", "delivering"]) {
    for (const attempts of [WEBHOOK_MAX_ATTEMPTS, WEBHOOK_MAX_ATTEMPTS + 1]) {
      const { id } = await delivery({ status, attempts, lease_until: 0 });
      ids.push(id);
    }
  }
  await withFetch(
    () =>
      assert.fail(
        "Exhausted attempts must be terminalized before any network I/O",
      ),
    async () => {
      await runWebhookDeliveries(fixture.env);
    },
  );
  for (const id of ids) {
    const row = (await db(fixture.env).first(
      "webhook_deliveries",
      eq("id", id),
    ))!;
    assert.equal(row.status, "dead");
    assert.equal(row.lease_token, "");
    assert.ok(Number(row.attempts) >= WEBHOOK_MAX_ATTEMPTS);
  }
});

test("delivery never follows redirects, treats terminal 4xx as dead and retries transient network failures", async (t) => {
  for (const status of [
    301, 302, 307, 308, 400, 401, 403, 404, 410, 408, 425, 429, 500, 503, 0,
  ]) {
    await t.test(String(status), async () => {
      await db(fixture.env).mutate([
        remove("webhook_deliveries", undefined),
        remove("webhooks", undefined),
      ]);
      const { id } = await delivery();
      let posts = 0;
      await withFetch(
        (url, init) => {
          if (url.hostname === "cloudflare-dns.com") return dns(url);
          assert.equal(url.href, destination);
          assert.equal(init.redirect, "manual");
          posts++;
          if (!status)
            throw new Error(`network failure ${secret} ${destination}`);
          return new Response("untrusted-body", {
            status,
            headers: {
              Location: "https://untrusted.example.org",
              "Retry-After": "0",
            },
          });
        },
        async () => {
          await runWebhookDeliveries(fixture.env);
        },
      );
      assert.equal(posts, 1);
      const row = (await db(fixture.env).first(
        "webhook_deliveries",
        eq("id", id),
      ))!;
      assert.equal(
        row.status,
        status === 0 || [408, 425, 429].includes(status) || status >= 500
          ? "pending"
          : "dead",
      );
      assert.ok(!JSON.stringify(row).includes(secret));
      assert.ok(!JSON.stringify(row).includes("fictional-url-secret"));
      assert.ok(!JSON.stringify(row).includes("untrusted-body"));
    });
  }
});

test("private DNS and disabled subscriptions never receive notification payloads", async () => {
  const { id, webhookId } = await delivery();
  let posts = 0;
  await withFetch(
    (url) => {
      if (url.hostname === "cloudflare-dns.com")
        return dns(url, ["169.254.169.254"]);
      posts++;
      return new Response(null, { status: 204 });
    },
    async () => {
      await runWebhookDeliveries(fixture.env);
    },
  );
  assert.equal(posts, 0);
  assert.notEqual(
    (await db(fixture.env).first("webhook_deliveries", eq("id", id)))!.status,
    "delivered",
  );
  await db(fixture.env).mutate([
    update("webhook_deliveries", eq("id", id), { next_attempt: 0 }),
    update("webhooks", eq("id", webhookId), { enabled: 0 }),
  ]);
  await withFetch(
    () => {
      assert.fail("Disabled hooks must not perform any network request");
    },
    async () => {
      await runWebhookDeliveries(fixture.env);
    },
  );
  assert.equal(
    (await db(fixture.env).first("webhook_deliveries", eq("id", id)))!.status,
    "cancelled",
  );
});

test("webhook administration requires a session and encryption, returns secret once and redacts history", async () => {
  assert.equal(
    (await route("/", undefined, { session: false, key: fixture.env.API_KEY }))
      .response.status,
    401,
  );
  assert.equal(
    (
      await route(
        "/",
        { name: "New", url: destination, events: ["mail.received"] },
        {
          env: {
            ...fixture.env,
            CREDENTIAL_ENCRYPTION_KEY: undefined,
            STORAGE_ENCRYPTION_KEY: undefined,
          },
        },
      )
    ).response.status,
    400,
  );
  const created = await route("/", {
    name: "New",
    url: destination,
    events: ["mail.received", "mail.received"],
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.data.secret.length, 64);
  const stored = (await fixture.DB.prepare(
    "SELECT url,secret FROM webhooks WHERE id=?",
  )
    .bind(created.data.data.id)
    .first<{ url: string; secret: string }>())!;
  assert.ok(stored.url.startsWith("enc:v1:"));
  assert.ok(stored.secret.startsWith("enc:v1:"));
  assert.ok(!stored.secret.includes(created.data.data.secret));
  const listed = await route("/");
  assert.equal(listed.data.data[0].destination, "https://hooks.example.org");
  assert.deepEqual(listed.data.data[0].events, ["mail.received"]);
  assert.ok(!JSON.stringify(listed.data).includes(created.data.data.secret));
  assert.ok(!JSON.stringify(listed.data).includes("fictional-url-secret"));
  await enqueueEvent(
    fixture.env,
    "mail.received",
    { subject: "PRIVATE_SUBJECT" },
    "private-event",
  );
  const [row] = await db(fixture.env).select("webhook_deliveries");
  await db(fixture.env).mutate([
    update("webhook_deliveries", eq("id", row.id), {
      status: "dead",
      lease_token: "private-lease",
    }),
  ]);
  const history = await route("/deliveries");
  assert.equal(history.data.total, 1);
  for (const value of [
    "PRIVATE_SUBJECT",
    "private-lease",
    created.data.data.secret,
    "fictional-url-secret",
  ])
    assert.ok(!JSON.stringify(history.data).includes(value));
  assert.equal(
    (await route(`/deliveries/${row.id}/retry`, {})).response.status,
    200,
  );
  assert.equal(
    (await route(`/deliveries/${row.id}/retry`, {})).response.status,
    409,
  );
  const retried = (await db(fixture.env).first(
    "webhook_deliveries",
    eq("id", row.id),
  ))!;
  assert.equal(retried.status, "pending");
  assert.equal(retried.attempts, 0);
  assert.equal(retried.lease_token, "");
  assert.equal(
    (await route(`/${created.data.data.id}`, undefined, { method: "DELETE" }))
      .response.status,
    200,
  );
  await withFetch(
    () => {
      assert.fail("Deleted subscription must not trigger network I/O");
    },
    async () => {
      await runWebhookDeliveries(fixture.env);
    },
  );
  assert.equal(
    (await db(fixture.env).first("webhook_deliveries", eq("id", row.id)))!
      .status,
    "cancelled",
  );
});

test(
  "deleting a subscription during a pending POST prevents future delivery during bounded cancellation",
  { timeout: 10000 },
  async () => {
    const { id, webhookId } = await delivery();
    const started = deferred(),
      release = deferred();
    await withFetch(
      async (url) => {
        if (url.hostname === "cloudflare-dns.com") return dns(url);
        started.resolve();
        await release.promise;
        return new Response(null, { status: 503 });
      },
      async () => {
        const pending = runWebhookDeliveries(fixture.env);
        try {
          await started.promise;
          assert.equal(
            (await route(`/${webhookId}`, undefined, { method: "DELETE" }))
              .response.status,
            200,
          );
        } finally {
          release.resolve();
          await Promise.allSettled([pending]);
        }
        await pending;
        await db(fixture.env).mutate([
          update("webhook_deliveries", eq("id", id), { next_attempt: 0 }),
        ]);
      },
    );
    await withFetch(
      () => {
        assert.fail("Cancelled hook must not receive a second POST");
      },
      async () => {
        await runWebhookDeliveries(fixture.env);
      },
    );
    assert.equal(
      (await db(fixture.env).first("webhook_deliveries", eq("id", id)))!.status,
      "cancelled",
    );
  },
);

test("deleting a subscription with over 2000 pending deliveries succeeds and cancellation remains bounded", async () => {
  const webhookId = await hook();
  // Seed a large local history directly so setup does not itself hit the mutation cap.
  await fixture.DB.prepare(
    `WITH RECURSIVE history(n) AS (
      SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 2001
    ) INSERT INTO webhook_deliveries (id, webhook_id, event, payload)
      SELECT 'large-history-' || n, ?, 'mail.received', '{}' FROM history`,
  )
    .bind(webhookId)
    .run();
  try {
    const deleted = await route(`/${webhookId}`, undefined, {
      method: "DELETE",
    });
    assert.equal(deleted.response.status, 200);
    assert.equal(
      await db(fixture.env).first("webhooks", eq("id", webhookId)),
      null,
    );
    assert.equal(await db(fixture.env).count("webhook_deliveries"), 2001);
    await withFetch(
      () => {
        assert.fail("Deleted subscriptions must not perform network I/O");
      },
      async () => {
        assert.deepEqual(await runWebhookDeliveries(fixture.env), {
          processed: 10,
        });
      },
    );
    assert.equal(
      await db(fixture.env).count(
        "webhook_deliveries",
        eq("status", "cancelled"),
      ),
      10,
    );
    assert.equal(
      await db(fixture.env).count(
        "webhook_deliveries",
        eq("status", "pending"),
      ),
      1991,
    );
  } finally {
    await fixture.DB.prepare(
      "DELETE FROM webhook_deliveries WHERE webhook_id = ?",
    )
      .bind(webhookId)
      .run();
  }
});
