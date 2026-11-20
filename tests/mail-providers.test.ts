import test from "node:test";
import assert from "node:assert/strict";
import { database, json } from "./helpers";
import { db, eq, insert, update } from "../src/storage/client";
import { createApiKey } from "../src/api-keys";
import {
  openBackup,
  validateBackup,
  type LegacyBackupDocument,
  type Schema11BackupDocument,
  type Schema12BackupDocument,
} from "../src/routes/backups";
import { registrationDefaults } from "../shared/registrations";
import { digest } from "../src/storage/model";
import { operations, schemas } from "../shared/api-contract";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const address = "managed@provider.test",
  password = "Fictional-only-password-82",
  token = "fictional-provider-token";
const remote = {
  id: "remote123",
  address,
  isDisabled: false,
  isDeleted: false,
};
const mail = {
  id: "message123",
  accountId: remote.id,
  from: { address: "auth@example.test", name: "Example" },
  subject: "Sign in",
  intro: "Open the message to continue",
  createdAt: new Date().toISOString(),
  seen: false,
  isDeleted: false,
};
const collection = (members: unknown[], total = members.length) =>
  json({ "hydra:member": members, "hydra:totalItems": total });
type Handler = (
  url: URL,
  init: RequestInit,
) => Response | Promise<Response | undefined> | undefined;
async function provider<T>(run: () => Promise<T>, override?: Handler) {
  const original = globalThis.fetch;
  const calls: { path: string; method: string; host: string }[] = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (
      ![
        "api.mail.tm",
        "api.mail.gw",
        "api.mailslurp.com",
        "api.mailinator.com",
      ].includes(url.hostname)
    )
      throw new Error("Unexpected request: " + url.origin);
    assert.equal(init.redirect, "manual");
    calls.push({
      path: url.pathname,
      method: init.method || "GET",
      host: url.hostname,
    });
    const response = await override?.(url, init);
    if (response) return response;
    if (url.pathname === "/domains")
      return collection([
        { domain: "example.test", isActive: true, isPrivate: false },
        { domain: "private.test", isActive: true, isPrivate: true },
      ]);
    if (url.pathname === "/api/v2/domains")
      return json({
        domains: [{ name: "provider.test", verified: true }],
      });
    if (url.pathname === "/api/v2/domains/provider.test/inboxes/managed") {
      assert.equal(new Headers(init.headers).get("Authorization"), password);
      return json({
        domain: "provider.test",
        to: "managed",
        msgs: [
          {
            id: mail.id,
            domain: "provider.test",
            to: "managed",
            subject: mail.subject,
            from: "Example",
            origfrom: "auth@example.test",
            time: Date.parse(mail.createdAt),
          },
        ],
      });
    }
    if (
      url.pathname ===
      `/api/v2/domains/provider.test/inboxes/managed/messages/${mail.id}`
    ) {
      assert.equal(new Headers(init.headers).get("Authorization"), password);
      return json({
        id: mail.id,
        domain: "provider.test",
        to: "managed",
        subject: mail.subject,
        from: "Example",
        fromfull: "Example <auth@example.test>",
        time: Date.parse(mail.createdAt),
        parts: [
          {
            headers: { "content-type": "text/plain; charset=utf-8" },
            body: "Your verification code is 238641",
          },
          {
            headers: { "content-type": "text/html; charset=utf-8" },
            body: '<a href="https://example.test/verify?token=fictional">Verify</a>',
          },
        ],
      });
    }
    if (url.pathname === "/accounts") return json(remote, 201);
    if (url.pathname === "/token") {
      const body = JSON.parse(String(init.body));
      assert.equal(body.address, address);
      assert.equal(body.password, password);
      return json({ id: remote.id, token });
    }
    if (url.hostname !== "api.mailinator.com")
      assert.equal(
        new Headers(init.headers).get("Authorization"),
        `Bearer ${token}`,
      );
    if (url.pathname === "/me") return json(remote);
    if (url.pathname === "/messages") return collection([mail]);
    if (url.pathname === `/messages/${mail.id}`)
      return json({
        ...mail,
        text: "Your verification code is 238641",
        html: [
          '<a href="https://example.test/verify?token=fictional">Verify email</a>',
        ],
      });
    throw new Error("Unexpected route: " + url.pathname);
  }) as typeof fetch;
  try {
    const result = await run();
    return { result, calls };
  } finally {
    globalThis.fetch = original;
  }
}
async function connect(
  f: Awaited<ReturnType<typeof database>>,
  source = "mailtm",
  mode = "connect",
) {
  const result = await f.request("/api/providers/accounts", {
    provider: source,
    address,
    password,
    mode,
    remark: "Owned inbox",
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  return result.data.data;
}
function conforms(id: string, data: unknown) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const operation = operations.find((o) => o.operationId === id)!;
  const validate = ajv.compile({
    ...operation.response,
    components: { schemas },
  });
  assert.equal(validate(data), true, JSON.stringify(validate.errors));
}

test("Mail.tm and Mail.gw connect, paginate, read bodies and extract links hidden beyond message intro", async () => {
  const f = await database();
  try {
    const { calls } = await provider(async () => {
      for (const source of ["mailtm", "mailgw"]) {
        const domains = await f.request(`/api/providers/${source}/domains`);
        assert.deepEqual(domains.data.data, [{ domain: "example.test" }]);
        conforms("listProviderDomains", domains.data);
        const a = await connect(f, source);
        assert.equal(a.auth_status, "unchecked");
        assert.equal(JSON.stringify(a).includes(password), false);
        assert.equal(JSON.stringify(a).includes(token), false);
        const list = await f.request(
          `/api/providers/accounts/${a.id}/messages?page=2`,
        );
        conforms("listProviderMessages", list.data);
        assert.equal(list.data.page, 2);
        const detail = await f.request(
          `/api/providers/accounts/${a.id}/messages/${mail.id}`,
        );
        conforms("getProviderMessage", detail.data);
        assert.equal(detail.data.data.verification_code, "238641");
        const code = await f.request(
          `/api/providers/accounts/${a.id}/code?sender=auth&q=verification`,
        );
        conforms("lookupProviderVerification", code.data);
        assert.equal(code.data.data.code, "238641");
        assert.match(code.data.data.link, /verify/);
        const checked = await f.request(
          `/api/providers/accounts/${a.id}/check`,
          {},
          "POST",
        );
        conforms("checkProviderAccount", checked.data);
        assert.equal(
          (await f.request(`/api/providers/accounts/${a.id}`)).data.data
            .auth_status,
          "healthy",
        );
      }
      conforms("listMailProviders", (await f.request("/api/providers")).data);
      const list = await f.request("/api/providers/accounts");
      conforms("listProviderAccounts", list.data);
      assert.equal(JSON.stringify(list.data).includes(password), false);
      assert.equal(JSON.stringify(list.data).includes(token), false);
    });
    assert.deepEqual(
      new Set(calls.map((c) => c.host)),
      new Set(["api.mail.tm", "api.mail.gw"]),
    );
  } finally {
    await f.dispose();
  }
});

test("provider domain routes authorize admin API keys and reject keys without admin scope", async () => {
  const f = await database();
  try {
    const admin = await createApiKey(f.env, {
      name: "Provider domains",
      scopes: ["admin"],
    });
    const writer = await createApiKey(f.env, {
      name: "Provider writer",
      scopes: ["mailbox:write"],
    });
    await provider(async () => {
      for (const source of ["mailtm", "mailgw"]) {
        const result = await f.request(
          `/api/providers/${source}/domains`,
          undefined,
          "GET",
          { "X-API-Key": admin.key },
        );
        assert.equal(result.response.status, 200, JSON.stringify(result.data));
      }
      for (const source of ["mailslurp", "mailinator"]) {
        const result = await f.request(
          `/api/providers/${source}/domains`,
          undefined,
          "GET",
          { "X-API-Key": admin.key },
        );
        assert.equal(result.response.status, 400);
        assert.equal(result.data.error, "PROVIDER_CAPABILITY_UNSUPPORTED");
      }
      const denied = await f.request(
        "/api/providers/mailtm/domains",
        undefined,
        "GET",
        { "X-API-Key": writer.key },
      );
      assert.equal(denied.response.status, 403);
      assert.equal(denied.data.error, "INSUFFICIENT_SCOPE");
    });
  } finally {
    await f.dispose();
  }
});

test("MailSlurp lookup requires exists=true even if the response contains an inbox ID", async () => {
  const f = await database();
  try {
    await provider(
      async () => {
        const result = await f.request("/api/providers/accounts", {
          provider: "mailslurp",
          address,
          password: "fictional-mailslurp-api-key",
        });
        assert.equal(result.response.status, 404);
        assert.equal(result.data.error, "PROVIDER_ACCOUNT_GONE");
        assert.equal(await db(f.env).count("provider_accounts"), 0);
      },
      (url) =>
        url.pathname === "/inboxes/byEmailAddress"
          ? json({ exists: false, inboxId: remote.id })
          : undefined,
    );
  } finally {
    await f.dispose();
  }
});

test("MailSlurp connects an owned inbox by address, pages and reads mail through its API key", async () => {
  const f = await database();
  try {
    const { calls } = await provider(
      async () => {
        const catalog = await f.request("/api/providers");
        const mailSlurp = catalog.data.data.find(
          (entry: any) => entry.id === "mailslurp",
        );
        assert.equal(mailSlurp.credential_label, "MailSlurp API Key");
        assert.equal(mailSlurp.can_create, false);
        assert.ok(mailSlurp.capabilities.includes("api_key"));
        const domains = await f.request("/api/providers/mailslurp/domains");
        assert.equal(domains.response.status, 400);
        assert.equal(domains.data.error, "PROVIDER_CAPABILITY_UNSUPPORTED");

        const account = await connect(f, "mailslurp");
        assert.equal(account.auth_status, "unchecked");

        const list = await f.request(
          `/api/providers/accounts/${account.id}/messages?page=1`,
        );
        assert.equal(list.response.status, 200, JSON.stringify(list.data));
        assert.equal(list.data.total, 1);
        assert.equal(list.data.data[0].sender, "auth@example.test");
        assert.equal(list.data.data[0].verification_code, "238641");

        const detail = await f.request(
          `/api/providers/accounts/${account.id}/messages/${mail.id}`,
        );
        assert.equal(detail.response.status, 200, JSON.stringify(detail.data));
        assert.equal(
          detail.data.data.text_content,
          "Your verification code is 238641",
        );

        const code = await f.request(
          `/api/providers/accounts/${account.id}/code?sender=auth&q=verification`,
        );
        assert.equal(code.data.data.code, "238641");

        const checked = await f.request(
          `/api/providers/accounts/${account.id}/check`,
          {},
          "POST",
        );
        assert.equal(
          checked.response.status,
          200,
          JSON.stringify(checked.data),
        );
      },
      (url, init) => {
        if (url.hostname !== "api.mailslurp.com") return undefined;
        assert.equal(new Headers(init.headers).get("x-api-key"), password);
        if (url.pathname === "/inboxes/byEmailAddress") {
          assert.equal(url.searchParams.get("emailAddress"), address);
          return json({ exists: true, inboxId: remote.id });
        }
        if (url.pathname === `/inboxes/${remote.id}`)
          return json({ id: remote.id, emailAddress: address });
        if (url.pathname === `/inboxes/${remote.id}/emails/paginated`)
          return json({
            content: [
              {
                id: mail.id,
                inboxId: remote.id,
                from: "auth@example.test",
                fromName: "Example",
                to: [address],
                subject: "Sign in",
                bodyExcerpt: "Open the message to continue",
                textExcerpt: "Your verification code is 238641",
                createdAt: mail.createdAt,
                read: false,
                attachments: [],
              },
            ],
            totalElements: 1,
          });
        if (url.pathname === `/emails/${mail.id}`)
          return json({
            id: mail.id,
            inboxId: remote.id,
            from: "auth@example.test",
            fromName: "Example",
            to: [address],
            subject: "Sign in",
            body: "Your verification code is 238641",
            isHTML: false,
            createdAt: mail.createdAt,
            read: false,
          });
        throw new Error(`Unexpected MailSlurp route: ${url.pathname}`);
      },
    );
    assert.equal(
      calls.some((call) => call.path === "/domains"),
      false,
    );
    assert.ok(calls.some((call) => call.path === "/inboxes/byEmailAddress"));
    assert.ok(calls.some((call) => call.path === `/emails/${mail.id}`));
  } finally {
    await f.dispose();
  }
});

test("Mailinator connects only an owned private domain and safely reads messages", async () => {
  const f = await database();
  try {
    const offsets: number[] = [];
    const summary = (id: string) => ({
      id,
      domain: "provider.test",
      to: "managed",
      subject: mail.subject,
      from: "Example",
      origfrom: "auth@example.test",
      time: Date.parse(mail.createdAt),
    });
    const { calls } = await provider(
      async () => {
        const catalog = await f.request("/api/providers");
        const mailinator = catalog.data.data.find(
          (entry: any) => entry.id === "mailinator",
        );
        assert.equal(mailinator.credential_label, "Mailinator API Token");
        assert.equal(mailinator.can_create, false);
        assert.ok(mailinator.capabilities.includes("api_key"));
        const domains = await f.request("/api/providers/mailinator/domains");
        assert.equal(domains.response.status, 400);
        assert.equal(domains.data.error, "PROVIDER_CAPABILITY_UNSUPPORTED");

        const account = await connect(f, "mailinator");
        assert.equal(account.remote_id, "provider.test");
        assert.equal(account.auth_status, "unchecked");
        assert.equal(JSON.stringify(account).includes(password), false);

        const list = await f.request(
          `/api/providers/accounts/${account.id}/messages?page=1`,
        );
        assert.equal(list.response.status, 200, JSON.stringify(list.data));
        assert.equal(list.data.total, 31);
        assert.equal(list.data.has_more, true);
        assert.equal(list.data.data.length, 30);
        assert.equal(list.data.data[0].sender, "auth@example.test");

        const next = await f.request(
          `/api/providers/accounts/${account.id}/messages?page=2`,
        );
        assert.equal(next.response.status, 200, JSON.stringify(next.data));
        assert.equal(next.data.total, 31);
        assert.equal(next.data.has_more, false);
        assert.equal(next.data.data.length, 1);
        assert.deepEqual(offsets.slice(0, 2), [0, 30]);

        const detail = await f.request(
          `/api/providers/accounts/${account.id}/messages/${mail.id}`,
        );
        assert.equal(detail.response.status, 200, JSON.stringify(detail.data));
        assert.equal(detail.data.data.verification_code, "238641");
        assert.match(detail.data.data.html_content, /example\.test\/verify/);

        const code = await f.request(
          `/api/providers/accounts/${account.id}/code?sender=auth&q=verification`,
        );
        assert.equal(code.data.data.code, "238641");
        assert.match(code.data.data.link, /verify/);

        const checked = await f.request(
          `/api/providers/accounts/${account.id}/check`,
          {},
          "POST",
        );
        assert.equal(
          checked.response.status,
          200,
          JSON.stringify(checked.data),
        );
        assert.equal(
          (await f.request(`/api/providers/accounts/${account.id}`)).data.data
            .auth_status,
          "healthy",
        );
      },
      (url) => {
        if (
          url.hostname !== "api.mailinator.com" ||
          url.pathname !== "/api/v2/domains/provider.test/inboxes/managed" ||
          url.searchParams.get("limit") !== "31"
        )
          return undefined;
        const offset = Number(url.searchParams.get("skip") || 0);
        offsets.push(offset);
        const messages =
          offset === 0
            ? Array.from({ length: 31 }, (_, index) =>
                summary(index === 0 ? mail.id : `message-${index}`),
              )
            : [summary("older-message")];
        return json({ domain: "provider.test", to: "managed", msgs: messages });
      },
    );
    assert.ok(calls.some((call) => call.path === "/api/v2/domains"));
    assert.ok(
      calls.some((call) =>
        call.path.startsWith("/api/v2/domains/provider.test/inboxes/managed"),
      ),
    );
    assert.ok(calls.every((call) => !call.path.includes("token=")));
    assert.ok(calls.every((call) => call.host === "api.mailinator.com"));
  } finally {
    await f.dispose();
  }
});

test("Mailinator rejects addresses outside the token owner's private domains", async () => {
  const f = await database();
  try {
    await provider(
      async () => {
        const result = await f.request("/api/providers/accounts", {
          provider: "mailinator",
          address,
          password,
          mode: "connect",
        });
        assert.equal(result.response.status, 400);
        assert.equal(result.data.error, "PROVIDER_DOMAIN_NOT_OWNED");
        assert.equal(
          (await f.request("/api/providers/accounts")).data.total,
          0,
        );
      },
      (url) =>
        url.pathname === "/api/v2/domains"
          ? json({ domains: [{ name: "other-private.test", verified: true }] })
          : undefined,
    );
  } finally {
    await f.dispose();
  }
});

test("stored passwords and tokens are encrypted; detail reveals password only to approved credentials", async () => {
  const f = await database();
  f.env.CREDENTIAL_ENCRYPTION_KEY = "f".repeat(40);
  try {
    await provider(async () => {
      const a = await connect(f);
      const raw = await f.DB.prepare(
        "SELECT password, token FROM provider_accounts WHERE id = ?",
      )
        .bind(a.id)
        .first<{ password: string; token: string }>();
      assert.match(raw!.password, /^enc:v1:/);
      assert.match(raw!.token, /^enc:v1:/);
      const detail = await f.request(`/api/providers/accounts/${a.id}`);
      conforms("getProviderAccount", detail.data);
      assert.equal(detail.data.data.password, password);
      assert.equal("token" in detail.data.data, false);
      assert.equal(
        (
          await f.request(
            `/api/providers/accounts/${a.id}`,
            undefined,
            "GET",
            {},
          )
        ).response.status,
        401,
      );
      const verify = await createApiKey(f.env, {
        name: "verify",
        scopes: ["verify:read"],
        restrictions: { emails: [address] },
      });
      const wrong = await createApiKey(f.env, {
        name: "wrong",
        scopes: ["admin"],
        restrictions: { emails: ["other@example.test"] },
      });
      const own = await createApiKey(f.env, {
        name: "own",
        scopes: ["admin"],
        restrictions: { emails: [address] },
      });
      assert.equal(
        (
          await f.request(`/api/providers/accounts/${a.id}`, undefined, "GET", {
            "X-API-Key": verify.key,
          })
        ).response.status,
        403,
      );
      assert.equal(
        (
          await f.request(
            `/api/providers/accounts/${a.id}/code`,
            undefined,
            "GET",
            { "X-API-Key": verify.key },
          )
        ).response.status,
        200,
      );
      assert.equal(
        (
          await f.request(`/api/providers/accounts/${a.id}`, undefined, "GET", {
            "X-API-Key": wrong.key,
          })
        ).response.status,
        403,
      );
      assert.equal(
        (
          await f.request(`/api/providers/accounts/${a.id}`, undefined, "GET", {
            "X-API-Key": own.key,
          })
        ).response.status,
        200,
      );
      assert.equal(
        (
          await f.request("/api/providers/accounts", undefined, "GET", {
            "X-API-Key": own.key,
          })
        ).response.status,
        403,
      );
      assert.equal(detail.response.headers.get("cache-control"), "no-store");
    });
  } finally {
    await f.dispose();
  }
});

test("token expiry and revoked tokens reauthenticate once; wrong password never logs out administrator or leaks provider payload", async () => {
  const f = await database();
  try {
    let a: any;
    await provider(async () => {
      a = await connect(f);
    });
    await db(f.env).mutate([
      update("provider_accounts", eq("id", a.id), {
        token_expires_at: "2000-01-01T00:00:00Z",
      }),
    ]);
    const expired = await provider(async () => {
      assert.equal(
        (await f.request(`/api/providers/accounts/${a.id}/messages`)).response
          .status,
        200,
      );
    });
    assert.equal(expired.calls.filter((c) => c.path === "/token").length, 1);
    let rejected = false;
    const revoked = await provider(
      async () => {
        assert.equal(
          (await f.request(`/api/providers/accounts/${a.id}/messages`)).response
            .status,
          200,
        );
      },
      (url) => {
        if (url.pathname === "/messages" && !rejected) {
          rejected = true;
          return json({ secret: password }, 401);
        }
      },
    );
    assert.equal(revoked.calls.filter((c) => c.path === "/token").length, 1);
    await db(f.env).mutate([
      update("provider_accounts", eq("id", a.id), { token: "" }),
    ]);
    const bad = await provider(
      async () => {
        const r = await f.request(`/api/providers/accounts/${a.id}/messages`);
        assert.equal(r.response.status, 400);
        assert.equal(r.data.error, "PROVIDER_AUTH_FAILED");
        assert.equal(JSON.stringify(r.data).includes(password), false);
      },
      (url) =>
        url.pathname === "/token"
          ? json({ description: password }, 401)
          : undefined,
    );
    assert.equal(bad.calls.length, 1);
    assert.equal(
      (await f.request(`/api/providers/accounts/${a.id}`)).data.data
        .auth_status,
      "reauth_required",
    );
  } finally {
    await f.dispose();
  }
});

test("new mailbox creation retains a recoverable local credential on ambiguous remote failure and never retries account creation", async () => {
  const f = await database();
  try {
    const failed = await provider(
      async () => {
        const r = await f.request("/api/providers/accounts", {
          provider: "mailtm",
          mode: "create",
          address,
          password,
        });
        assert.equal(r.response.status, 502);
        assert.ok(r.data.data.id);
        assert.equal(JSON.stringify(r.data).includes(password), false);
        return r.data.data.id as number;
      },
      (url) => {
        if (url.pathname === "/accounts")
          throw new Error("Timeout after provider commit");
      },
    );
    assert.equal(failed.calls.filter((c) => c.path === "/accounts").length, 1);
    const detail = await f.request(`/api/providers/accounts/${failed.result}`);
    assert.equal(detail.data.data.password, password);
    assert.equal(detail.data.data.auth_status, "error");
    await provider(async () => {
      assert.equal(
        (await f.request(`/api/providers/accounts/${failed.result}/check`, {}))
          .response.status,
        200,
      );
      assert.equal(
        (
          await f.request("/api/providers/accounts", {
            provider: "mailtm",
            mode: "create",
            address,
            password,
          })
        ).response.status,
        400,
      );
    });
  } finally {
    await f.dispose();
  }
});

test("providers without mailbox creation return a provider-specific capability error", async () => {
  const f = await database();
  try {
    const result = await f.request("/api/providers/accounts", {
      provider: "mailinator",
      mode: "create",
      address: "managed@private.test",
      password: "fictional-api-token",
    });
    assert.equal(result.response.status, 400);
    assert.match(result.data.message, /Mailinator Private/);
    assert.match(result.data.message, /接入已有邮箱/);
  } finally {
    await f.dispose();
  }
});

test("provider identity mismatch is rejected, malformed domains and rate limits are explicit, disabled accounts perform no fetch", async () => {
  const f = await database();
  try {
    await provider(
      async () => {
        const r = await f.request("/api/providers/accounts", {
          provider: "mailtm",
          address,
          password,
        });
        assert.equal(r.response.status, 409);
        assert.equal(await db(f.env).count("provider_accounts"), 0);
      },
      (url) =>
        url.pathname === "/me"
          ? json({ ...remote, address: "other@example.test" })
          : undefined,
    );
    let a: any;
    await provider(async () => {
      a = await connect(f);
    });
    await provider(
      async () => {
        const r = await f.request(`/api/providers/accounts/${a.id}/messages`);
        assert.equal(r.response.status, 429);
        assert.equal(r.data.error, "PROVIDER_RATE_LIMITED");
        assert.equal(r.data.retry_after, 17);
        assert.equal(r.response.headers.get("Retry-After"), "17");
      },
      (url) => {
        if (url.pathname !== "/messages") return undefined;
        const response = json({}, 429);
        response.headers.set("Retry-After", "17");
        return response;
      },
    );
    await provider(
      async () => {
        assert.equal(
          (await f.request("/api/providers/mailtm/domains")).response.status,
          502,
        );
      },
      () => json({ "hydra:member": {}, "hydra:totalItems": 0 }),
    );
    await f.request(
      `/api/providers/accounts/${a.id}`,
      { status: "disabled" },
      "PUT",
    );
    const disabled = await provider(async () => {
      assert.equal(
        (await f.request(`/api/providers/accounts/${a.id}/messages`)).response
          .status,
        400,
      );
    });
    assert.equal(disabled.calls.length, 0);
    assert.equal(
      (
        await f.request("/api/providers/accounts", {
          provider: "https://evil.test",
          address,
          password,
        })
      ).response.status,
      400,
    );
  } finally {
    await f.dispose();
  }
});

test("platform binding, health, unified verification and removal protections include external providers", async () => {
  const f = await database();
  try {
    await provider(async () => {
      const a = await connect(f);
      const vault = await f.request("/api/vault", {
        platform_name: "Provider app",
        account_email: address,
        email_source: "mailtm",
      });
      const vid = vault.data.data.id;
      const before = await f.request("/api/automation/mailbox", {
        vault_id: vid,
      });
      assert.equal(before.data.data.health.state, "unchecked");
      const code = await f.request("/api/automation/verification", {
        email: address,
      });
      assert.equal(code.response.status, 200, JSON.stringify(code.data));
      assert.equal(code.data.data.source, "mailtm");
      assert.equal(code.data.data.code, "238641");
      assert.equal(
        (await f.request(`/api/vault/${vid}/code`)).data.data.code,
        "238641",
      );
      assert.equal(
        (await f.request("/api/automation/mailbox", { vault_id: vid })).data
          .data.health.state,
        "connected",
      );
      assert.equal(
        (
          await f.request(
            `/api/providers/accounts/${a.id}`,
            undefined,
            "DELETE",
          )
        ).response.status,
        409,
      );
      await f.request(`/api/vault/${vid}`, undefined, "DELETE");
      assert.equal(
        (
          await f.request(
            `/api/providers/accounts/${a.id}`,
            undefined,
            "DELETE",
          )
        ).response.status,
        200,
      );
      assert.equal(await db(f.env).count("provider_accounts"), 0);
    });
  } finally {
    await f.dispose();
  }
});

test("editing during a slow provider request cannot restore stale token or overwrite the new credentials", async () => {
  const f = await database();
  try {
    let a: any;
    await provider(async () => {
      a = await connect(f);
    });
    let changed = false;
    await provider(
      async () => {
        const r = await f.request(`/api/providers/accounts/${a.id}/messages`);
        assert.equal(r.response.status, 409);
        assert.equal(r.data.error, "PROVIDER_ACCOUNT_CHANGED");
      },
      async (url) => {
        if (url.pathname === "/messages" && !changed) {
          changed = true;
          const r = await f.request(
            `/api/providers/accounts/${a.id}`,
            { password: "new-password" },
            "PUT",
          );
          assert.equal(r.response.status, 200);
        }
      },
    );
    const detail = await f.request(`/api/providers/accounts/${a.id}`);
    assert.equal(detail.data.data.password, "new-password");
    assert.equal(detail.data.data.auth_status, "unchecked");
    const row = await db(f.env).first("provider_accounts", eq("id", a.id));
    assert.equal(row!.token, "");
    assert.equal(
      (
        await f.request(
          `/api/providers/accounts/${a.id}`,
          { remark: "late edit", credential_version: "old" },
          "PUT",
        )
      ).response.status,
      409,
    );
  } finally {
    await f.dispose();
  }
});

test("registration metadata resolves a provider alias and keeps mailbox and platform verification scopes distinct", async () => {
  const f = await database();
  try {
    await provider(async () => {
      await connect(f);
      const created = await f.request("/api/vault", {
        platform_name: "Alias app",
        account_email: "login@separate.test",
        email_source: "mailtm",
        mailbox_address: address,
        workspace: "Team",
        account_identifier: "member-42",
        login_methods: ["google", "password"],
        verification_sender: "auth@example.test",
        verification_keyword: "verification",
        registered_at: "2026-11-15T08:00:00+08:00",
        expires_at: "",
      });
      assert.equal(created.response.status, 200, JSON.stringify(created.data));
      const id = created.data.data.id;
      const detail = await f.request(`/api/vault/${id}`);
      conforms("getVaultAccount", detail.data);
      assert.equal(detail.data.data.login_methods, '["google","password"]');
      assert.equal(detail.data.data.registered_at, "2026-11-15T00:00:00.000Z");
      const mailbox = await f.request("/api/automation/verification", {
        vault_id: id,
        match: "mailbox",
      });
      conforms("lookupVerification", mailbox.data);
      assert.equal(mailbox.data.data.email, address);
      assert.equal(mailbox.data.data.match_scope, "mailbox");
      assert.equal(
        (await f.request(`/api/vault/${id}`)).data.data.last_code,
        "",
      );
      const platform = await f.request(`/api/vault/${id}/code?match=platform`);
      conforms("lookupVaultCode", platform.data);
      assert.equal(platform.data.data.match_scope, "platform");
      assert.match(platform.data.data.match_reason, /auth@example.test/);
      assert.equal(
        (await f.request(`/api/vault/${id}`)).data.data.last_code,
        "238641",
      );
      const direct = await f.request("/api/automation/verification", {
        email: address,
        source: "mailtm",
        match: "platform",
      });
      assert.equal(direct.response.status, 400);
      assert.equal(direct.data.error, "PLATFORM_TARGET_REQUIRED");
      await f.request(
        `/api/vault/${id}`,
        { verification_sender: "", verification_keyword: "" },
        "PUT",
      );
      const unconfigured = await f.request(
        `/api/vault/${id}/code?match=platform`,
      );
      assert.equal(unconfigured.response.status, 409);
      assert.equal(unconfigured.data.error, "VERIFICATION_RULE_REQUIRED");
      await f.request(
        `/api/vault/${id}`,
        { mailbox_link_state: "detached" },
        "PUT",
      );
      const detached = await f.request("/api/automation/verification", {
        vault_id: id,
        match: "mailbox",
      });
      assert.equal(detached.response.status, 409);
      assert.equal(detached.data.error, "MAILBOX_DETACHED");
    });
  } finally {
    await f.dispose();
  }
});

test("schema 13 backups carry provider credentials and frozen schemas 10/11/12 upgrade deterministically", async () => {
  const f = await database();
  f.env.CREDENTIAL_ENCRYPTION_KEY = "e".repeat(40);
  try {
    await provider(async () => {
      await connect(f);
    });
    await f.request("/api/vault", {
      platform_name: "Backup app",
      account_email: address,
      email_source: "mailtm",
    });
    const login = await f.request(
      "/api/auth/login",
      { password: f.env.ADMIN_PASSWORD },
      "POST",
      {},
    );
    const headers = {
      Cookie: login.response.headers.get("set-cookie")!.split(";")[0],
    };
    const secret = "fictional-backup-passphrase";
    const response = await f.request(
      "/api/backups/export",
      {
        include_credentials: true,
        confirm: "EXPORT_CREDENTIALS",
        passphrase: secret,
      },
      "POST",
      headers,
    );
    assert.equal(response.response.status, 200, JSON.stringify(response.data));
    const backup = await openBackup(response.data, secret);
    assert.equal(backup.manifest.schema_version, 13);
    assert.equal(backup.tables.provider_accounts[0].password, password);
    const redacted = await f.request(
      "/api/backups/export",
      undefined,
      "GET",
      headers,
    );
    assert.equal(JSON.stringify(redacted.data).includes(password), false);
    assert.equal(JSON.stringify(redacted.data).includes(token), false);
    conforms("exportRedactedBackup", redacted.data);
    await validateBackup(redacted.data);
    const manifest = (
      await f.request("/api/backups/manifest", undefined, "GET", headers)
    ).data.data;
    for (const version of [10, 11, 12] as const) {
      const oldSchema = structuredClone(manifest.schema);
      oldSchema.platform_vault.fields =
        "account_email category created_at email_source id is_pinned last_code last_code_at password platform_name platform_url proxy_node remark status totp_secret updated_at username".split(
          " ",
        );
      if (version < 12) delete oldSchema.provider_accounts;
      if (version < 11) delete oldSchema.platforms;
      const tables = Object.fromEntries(
        Object.entries(backup.tables)
          .filter(([table]) => table in oldSchema)
          .map(([table, rows]) => [
            table,
            rows.map((row) =>
              Object.fromEntries(
                oldSchema[table].fields.map((field: string) => [
                  field,
                  row[field],
                ]),
              ),
            ),
          ]),
      );
      const old = {
        manifest: {
          ...backup.manifest,
          schema_version: version,
          schema_hash: await digest(oldSchema),
          data_hash: await digest(tables),
          table_counts: Object.fromEntries(
            Object.entries(tables).map(([table, rows]) => [table, rows.length]),
          ),
          table_hashes: Object.fromEntries(
            await Promise.all(
              Object.entries(tables).map(async ([table, rows]) => [
                table,
                await digest(rows),
              ]),
            ),
          ),
        },
        tables,
      } as
        LegacyBackupDocument | Schema11BackupDocument | Schema12BackupDocument;
      const schemaName =
        version === 10
          ? "LegacyBackupDocument"
          : `Schema${version}BackupDocument`;
      const ajv = new Ajv({ strict: false, allErrors: true });
      addFormats(ajv);
      const validate = ajv.compile({
        $ref: `#/components/schemas/${schemaName}`,
        components: { schemas },
      });
      assert.equal(validate(old), true, JSON.stringify(validate.errors));
      const converted = await validateBackup(old);
      assert.equal(converted.manifest.schema_version, 13);
      assert.deepEqual(
        converted.tables.provider_accounts,
        version === 12 ? backup.tables.provider_accounts : [],
      );
      if (version !== 10)
        assert.deepEqual(converted.tables.platforms, backup.tables.platforms);
      for (const [field, fallback] of Object.entries(registrationDefaults))
        assert.equal(
          converted.tables.platform_vault[0][field],
          fallback,
          `${version}: ${field}`,
        );
      assert.deepEqual(await validateBackup(old), converted);
    }
  } finally {
    await f.dispose();
  }
});

test("legacy verification detects provider ambiguity and accepts an explicit source without server errors", async () => {
  const f = await database();
  try {
    await provider(async () => {
      await connect(f, "mailtm");
      await connect(f, "mailgw");
      const ambiguous = await f.request(`/api/external/code?email=${address}`);
      assert.equal(ambiguous.response.status, 409);
      assert.equal(ambiguous.data.error, "AMBIGUOUS_SOURCE");
      const found = await f.request(
        `/api/external/code?email=${address}&source=mailtm`,
      );
      assert.equal(found.response.status, 200);
      assert.equal(found.data.code, "238641");
    });
  } finally {
    await f.dispose();
  }
});
