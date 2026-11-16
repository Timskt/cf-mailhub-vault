import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import {
  MailHubClient,
  MailHubError,
  verifyWebhook,
  type PollRuntime,
} from "../sdk/typescript/index";
import { operations } from "../shared/api-contract";

const origin = "https://mailhub.example.test";
const apiKey = "fictional-sdk-test-key";
const empty = {
  email: "user@example.test",
  source: "cf_domain",
  has_mail: false,
  code: "",
  link: "",
  message: "empty",
  outcome: "empty",
  poll_after_seconds: 10,
};
const found = { ...empty, outcome: "found", has_mail: true, code: "123456" };
const json = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) => Response.json(data, { status, headers });
function clock() {
  let time = 0;
  const waits: number[] = [];
  const runtime: PollRuntime = {
    monotonicMs: () => time,
    wallTimeMs: () => Date.UTC(2026, 10, 15) + time,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw new Error("aborted");
      waits.push(ms);
      time += ms;
    },
  };
  return {
    runtime,
    waits,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
function client(fetch: typeof globalThis.fetch, runtime?: PollRuntime) {
  return new MailHubClient({ baseUrl: origin, apiKey, fetch, runtime });
}

test("SDK methods match current operation routes, encode opaque IDs and explicitly attach mutation idempotency", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const sdk = client(async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return json(
      { success: true, data: { accepted: true } },
      calls.length >= 4 ? 202 : 200,
      {
        "X-Request-ID": "req-sdk",
        "Idempotency-Replayed": "true",
        "Idempotency-Key-Expires-At": "2026-11-22T00:00:00Z",
      },
    );
  });
  await sdk.inspectMailbox({ vault_id: 7 });
  await sdk.lookupVerification({
    email: "user@example.test",
    since: "2026-11-15T00:00:00Z",
  });
  await sdk.register(
    { platform_name: "Example", domain: "example.test", prefix: "user" },
    { idempotencyKey: "register-1" },
  );
  await sdk.sendMail(
    3,
    { to: ["recipient@example.test"], subject: "Test", body: "Approved" },
    { idempotencyKey: "send-1" },
  );
  const reply = await sdk.reply(
    3,
    "opaque/id?+#%",
    { body: "Reply" },
    { idempotencyKey: "reply-1" },
  );
  const ids = [
    "inspectMailbox",
    "lookupVerification",
    "registerPlatformMailbox",
    "sendOutlookMail",
    "replyOutlookMail",
  ];
  const paths = [
    "/api/automation/mailbox",
    "/api/automation/verification",
    "/api/external/register",
    "/api/outlook/accounts/3/send",
    "/api/outlook/accounts/3/messages/opaque%2Fid%3F%2B%23%25/reply",
  ];
  calls.forEach((call, i) => {
    assert.equal(call.url, origin + paths[i]);
    const op = operations.find((o) => o.operationId === ids[i])!;
    assert.equal(call.init.method?.toLowerCase(), op.method);
    assert.equal(call.init.redirect, "manual");
    assert.equal(
      new Headers(call.init.headers).get("Authorization"),
      `Bearer ${apiKey}`,
    );
    assert.equal(
      new Headers(call.init.headers).get("Idempotency-Key"),
      [null, null, "register-1", "send-1", "reply-1"][i],
    );
  });
  assert.equal(reply.status, 202);
  assert.equal(reply.request_id, "req-sdk");
  assert.equal(reply.idempotency_replayed, true);
  assert.ok(reply.idempotency_key_expires_at);
});

test("request errors retain code/request ID/retry windows and unknown-send details, and writes are never retried", async () => {
  let calls = 0;
  const sdk = client(async () => {
    calls++;
    return json(
      {
        success: false,
        error: "SEND_RATE_LIMITED",
        message: "Wait",
        retry_after: 30,
        retryable: true,
        delivery_unknown: true,
        draft_id: "draft",
        required_scopes: ["Mail.Send"],
      },
      429,
      { "X-Request-ID": "req-limited", "Retry-After": "45" },
    );
  });
  await assert.rejects(
    sdk.sendMail(
      1,
      { to: ["to@example.test"], subject: "Test", body: "Test" },
      { idempotencyKey: "write-once" },
    ),
    (error: unknown) => {
      assert.ok(error instanceof MailHubError);
      assert.equal(error.code, "SEND_RATE_LIMITED");
      assert.equal(error.status, 429);
      assert.equal(error.request_id, "req-limited");
      assert.equal(error.retry_after, 45);
      assert.equal(error.details.draft_id, "draft");
      assert.equal(error.details.delivery_unknown, true);
      assert.deepEqual(error.details.required_scopes, ["Mail.Send"]);
      return true;
    },
  );
  assert.equal(calls, 1);
  const transport = client(async () => {
    calls++;
    throw new Error(`private ${apiKey}`);
  });
  await assert.rejects(
    transport.register({ platform_name: "Example" }),
    (e: MailHubError) =>
      e.code === "NETWORK_ERROR" && !String(e).includes(apiKey),
  );
  assert.equal(calls, 2);
});

test("HTTP-date retry windows, redirects, malformed JSON and success:false are not silently treated as empty data", async () => {
  const c = clock();
  const responses = [
    json({ error: "THROTTLED", message: "Wait", retry_after: 10 }, 429, {
      "Retry-After": new Date(c.runtime.wallTimeMs() + 25000).toUTCString(),
      "X-Request-ID": "date-req",
    }),
    new Response("", {
      status: 302,
      headers: {
        Location: "https://other.example/",
        "X-Request-ID": "redirect-req",
      },
    }),
    new Response("<html>not json</html>", {
      headers: { "X-Request-ID": "invalid-req" },
    }),
    json({ success: false, error: "DENIED", message: "Denied" }),
  ];
  const sdk = client(async () => responses.shift()!, c.runtime);
  await assert.rejects(
    sdk.lookupVerification({ email: "user@example.test" }),
    (e: MailHubError) =>
      e.code === "THROTTLED" &&
      e.retry_after === 25 &&
      e.request_id === "date-req",
  );
  await assert.rejects(
    sdk.inspectMailbox({ vault_id: 1 }),
    (e: MailHubError) => e.status === 302 && e.request_id === "redirect-req",
  );
  await assert.rejects(
    sdk.lookupVerification({ email: "user@example.test" }),
    (e: MailHubError) =>
      e.code === "INVALID_RESPONSE" && e.request_id === "invalid-req",
  );
  await assert.rejects(
    sdk.lookupVerification({ email: "user@example.test" }),
    (e: MailHubError) => e.code === "DENIED",
  );
});

test("bounded polling fixes since and filters, honors empty + 429 windows, and never caches an empty idempotent result", async () => {
  const c = clock(),
    inputs: Record<string, unknown>[] = [];
  let calls = 0;
  const sdk = client(async (_url, init) => {
    inputs.push(JSON.parse(String(init?.body)));
    assert.equal(new Headers(init?.headers).has("Idempotency-Key"), false);
    calls++;
    if (calls === 1) return json({ success: true, data: empty });
    if (calls === 2)
      return json(
        { error: "RATE_LIMITED", message: "Wait", retry_after: 12 },
        429,
        { "Retry-After": "20", "X-Request-ID": "throttle" },
      );
    return json({ success: true, data: found }, 200, {
      "X-Request-ID": "found",
    });
  }, c.runtime);
  const result = await sdk.waitForVerification({
    email: "user@example.test",
    sender: "auth",
    q: "Login",
  });
  assert.equal(result.outcome, "found");
  assert.equal(result.data?.code, "123456");
  assert.equal(result.attempts, 3);
  assert.equal(result.elapsed_seconds, 30);
  assert.equal(result.request_id, "found");
  assert.deepEqual(c.waits, [10000, 20000]);
  assert.ok(
    inputs.every(
      (input) =>
        input.since === "2026-11-15T00:00:00.000Z" &&
        input.sender === "auth" &&
        input.q === "Login",
    ),
  );
});

test("poll deadline caps at 180s, never shortens Retry-After, and reports timeout with last error", async () => {
  const c = clock();
  let calls = 0;
  const sdk = client(async () => {
    calls++;
    return json({ success: true, data: empty });
  }, c.runtime);
  const result = await sdk.waitForVerification(
    { platform: "Example", since: "2026-11-14T00:00:00Z" },
    { timeoutSeconds: 999 },
  );
  assert.equal(result.outcome, "timeout");
  assert.equal(calls, 18);
  assert.ok(result.elapsed_seconds <= 180);
  assert.equal(result.since, "2026-11-14T00:00:00Z");
  let throttled = 0;
  const limited = client(async () => {
    throttled++;
    return json({ error: "RATE_LIMITED", message: "Wait" }, 429, {
      "Retry-After": "3600",
      "X-Request-ID": "long-window",
    });
  }, c.runtime);
  const timed = await limited.waitForVerification({ vault_id: 1 });
  assert.equal(timed.outcome, "timeout");
  assert.equal(throttled, 1);
  assert.equal(timed.last_error?.retry_after, 3600);
  assert.equal(timed.request_id, "long-window");
  await assert.rejects(
    client(async () =>
      json({ error: "RESOURCE_FORBIDDEN", message: "No" }, 403),
    ).waitForVerification({ vault_id: 1 }),
    (e: MailHubError) => e.code === "RESOURCE_FORBIDDEN",
  );
});

test("abort and request deadline bound fetch/body reads, including transports that ignore cancellation", async () => {
  const hung = client(async () => new Promise<Response>(() => {}));
  const controller = new AbortController();
  const pending = hung.waitForVerification(
    { vault_id: 1 },
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(pending, (e: MailHubError) => e.code === "ABORTED");
  const result = await hung.waitForVerification(
    { vault_id: 1 },
    { timeoutSeconds: 0.025 },
  );
  assert.equal(result.outcome, "timeout");
  let calls = 0;
  const blockedBody = client(async () => {
    calls++;
    return new Response(new ReadableStream({ start() {} }), {
      headers: { "X-Request-ID": "body-request" },
    });
  });
  await assert.rejects(
    blockedBody.register({ platform_name: "Example" }, { timeoutMs: 20 }),
    (e: MailHubError) =>
      e.code === "TIMEOUT" && e.request_id === "body-request",
  );
  assert.equal(calls, 1);
});

test("invalid URLs/targets/IDs/idempotency keys fail locally without sending credentials", async () => {
  for (const baseUrl of [
    "https://user:pass@host.test",
    "https://host.test/?token=x",
    "https://host.test/#x",
    "file:///tmp/test",
    "http://public.example.com",
    "https://host.test/api",
  ])
    assert.throws(() => new MailHubClient({ baseUrl, apiKey }));
  let calls = 0;
  const sdk = client(async () => {
    calls++;
    return json({ success: true, data: found });
  });
  for (const target of [
    {},
    { email: "a@example.test", vault_id: 1 },
    { vault_id: 1, source: "outlook" },
    { vault_id: -1 },
  ])
    await assert.rejects(sdk.lookupVerification(target as any));
  for (const path of [
    "https://other.test/api/test",
    "//other.test/api/test",
    "/api/../other",
    "/api/%2e%2e/other",
    "/api/\\other",
    "/api/test?key=secret",
  ])
    await assert.rejects(sdk.request("POST", path, { body: {} }));
  await assert.rejects(sdk.reply(1, "..", { body: "test" }));
  await assert.rejects(
    sdk.register({ platform_name: "Example" }, { idempotencyKey: "bad\nkey" }),
  );
  assert.equal(calls, 0);
});

test("webhook verification authenticates exact bytes, time window, event and delivery binding", async () => {
  const secret = "fictional-Webhook-UTF8-密钥",
    timestamp = "1800000000",
    subscriptionId = 5;
  const raw = new TextEncoder().encode(
    JSON.stringify({
      id: "event-中文",
      event: "code.extracted",
      created_at: "2026-11-15T00:00:00Z",
      data: { code: "123456" },
    }),
  );
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(raw)
    .digest("hex");
  const delivery = createHash("sha256")
    .update(JSON.stringify(["event-中文", subscriptionId]))
    .digest("hex");
  const headers = new Headers({
    "X-MailHub-Timestamp": timestamp,
    "X-MailHub-Signature": `sha256=${signature}`,
    "X-MailHub-Event": "code.extracted",
    "X-MailHub-Delivery": delivery,
  });
  const options = { secret, subscriptionId, nowSeconds: Number(timestamp) };
  const result = await verifyWebhook(raw, headers, options);
  assert.equal(result.delivery, delivery);
  assert.equal(result.payload.data.code, "123456");
  assert.equal(result.hash, createHash("sha256").update(raw).digest("hex"));
  for (const offset of [301, -301])
    await assert.rejects(
      verifyWebhook(raw, headers, {
        ...options,
        nowSeconds: Number(timestamp) + offset,
      }),
    );
  await verifyWebhook(raw, headers, {
    ...options,
    nowSeconds: Number(timestamp) + 300,
  });
  await assert.rejects(
    verifyWebhook(raw, headers, { ...options, secret: "incorrect" }),
  );
  await assert.rejects(
    verifyWebhook(
      new TextEncoder().encode(" " + new TextDecoder().decode(raw)),
      headers,
      options,
    ),
  );
  await assert.rejects(
    verifyWebhook(raw, headers, { ...options, subscriptionId: 6 }),
  );
  for (const [name, value] of [
    ["X-MailHub-Event", "mail.received"],
    ["X-MailHub-Delivery", "a".repeat(64)],
    ["X-MailHub-Signature", "sha256=not-hex"],
  ]) {
    const changed = new Headers(headers);
    changed.set(name, value);
    await assert.rejects(verifyWebhook(raw, changed, options));
  }
  const bytes = new Uint8Array(raw),
    configuration = { ...options };
  const pending = verifyWebhook(bytes, headers, configuration);
  bytes.fill(32);
  configuration.subscriptionId = 999;
  assert.deepEqual(
    await pending,
    result,
    "verification owns the bytes and trusted configuration across crypto awaits",
  );
  const duplicate = new Headers(headers);
  duplicate.append("x-mailhub-signature", `sha256=${signature}`);
  await assert.rejects(verifyWebhook(raw, duplicate, options));
});

test("polling snapshots input, handles link-only matches and retryable outages, and rejects malformed results", async () => {
  const c = clock();
  const input = { email: "user@example.test", since: "2026-11-14T00:00:00Z" };
  const captured: unknown[] = [];
  const sdk = client(async (_url, init) => {
    captured.push(JSON.parse(String(init?.body)));
    input.email = "changed@example.test";
    input.since = "2026-11-15T00:00:00Z";
    if (captured.length === 1)
      return json(
        { error: "UPSTREAM_ERROR", retryable: true, retry_after: 15 },
        503,
      );
    return json({
      success: true,
      data: {
        ...empty,
        outcome: "found",
        link: "https://verify.example.test/confirm",
      },
    });
  }, c.runtime);
  const result = await sdk.waitForVerification(input);
  assert.equal(result.outcome, "found");
  assert.equal(result.last_error, undefined);
  assert.equal(result.elapsed_seconds, 15);
  assert.deepEqual(
    captured,
    Array(2).fill({
      email: "user@example.test",
      since: "2026-11-14T00:00:00Z",
    }),
  );
  let calls = 0;
  const invalid = client(async () => {
    calls++;
    return json({ success: true, data: { ...empty, outcome: "found" } });
  });
  await assert.rejects(
    invalid.waitForVerification({ vault_id: 1 }),
    (e: MailHubError) => e.code === "INVALID_RESPONSE",
  );
  const zero = await invalid.waitForVerification(
    { vault_id: 1 },
    { timeoutSeconds: 0 },
  );
  assert.equal(zero.outcome, "timeout");
  assert.equal(zero.attempts, 0);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    invalid.waitForVerification({ vault_id: 1 }, { signal: aborted.signal }),
    (e: MailHubError) => e.code === "ABORTED",
  );
  assert.equal(calls, 1);
});

test("JSON response reads are bounded and success-only mutation envelopes are supported", async () => {
  let cancelled = false;
  const oversized = client(
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "X-Request-ID": "too-large" } },
      ),
  );
  await assert.rejects(
    oversized.lookupVerification({ vault_id: 1 }),
    (e: MailHubError) =>
      e.code === "RESPONSE_TOO_LARGE" && e.request_id === "too-large",
  );
  assert.equal(cancelled, true);
  assert.equal(
    (
      await client(async () => json({ success: true })).request<void>(
        "DELETE",
        "/api/example/1",
      )
    ).data,
    undefined,
  );
  assert.equal(
    (
      await client(
        async () => new Response(null, { status: 204 }),
      ).request<void>("DELETE", "/api/example/1")
    ).status,
    204,
  );
});

test("native fetch uses loopback transport, preserves explicit replay bytes, and refuses redirects without sending a second mutation", async (t) => {
  const calls: { path: string; body: string; auth?: string; key?: string }[] =
    [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    calls.push({
      path: request.url!,
      body,
      auth: request.headers.authorization,
      key: request.headers["idempotency-key"] as string | undefined,
    });
    response.setHeader("X-Request-ID", "native-req");
    if (request.url === "/api/external/register") {
      response.writeHead(307, { Location: "/api/redirect-target" });
      response.end();
      return;
    }
    if (request.url?.endsWith("/send")) {
      response.writeHead(409, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: "IDEMPOTENCY_UNKNOWN",
          message: "Read back",
          delivery_unknown: true,
        }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: true, data: found }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const sdk = new MailHubClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey,
  });
  const payload = { platform: "测试", since: "2026-11-15T00:00:00Z" };
  await sdk.lookupVerification(payload, { idempotencyKey: "explicit-replay" });
  await sdk.lookupVerification(payload, { idempotencyKey: "explicit-replay" });
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].key, "explicit-replay");
  assert.equal(calls[0].auth, `Bearer ${apiKey}`);
  await assert.rejects(
    sdk.register({ platform_name: "Example" }),
    (e: MailHubError) => e.status === 307 && e.request_id === "native-req",
  );
  await assert.rejects(
    sdk.sendMail(
      1,
      { to: ["to@example.test"], subject: "Test", body: "Test" },
      { idempotencyKey: "unknown-send" },
    ),
    (e: MailHubError) =>
      e.code === "IDEMPOTENCY_UNKNOWN" && e.details.delivery_unknown === true,
  );
  assert.equal(calls.length, 4);
  assert.equal(
    calls.some((call) => call.path === "/api/redirect-target"),
    false,
  );
});

test("provider verification targets preserve supported sources and reject unknown providers before fetch", async () => {
  const calls: RequestInit[] = [];
  const sdk = client(async (_input, init = {}) => {
    calls.push(init);
    return json({ success: true, data: { source: "mailtm" } });
  });
  for (const source of ["mailtm", "mailgw"] as const) {
    await sdk.lookupVerification({ email: "owned@provider.test", source });
    assert.equal(JSON.parse(String(calls.at(-1)!.body)).source, source);
  }
  await assert.rejects(
    sdk.lookupVerification({
      email: "owned@provider.test",
      source: "unknown",
    } as any),
  );
  assert.equal(calls.length, 2);
});
