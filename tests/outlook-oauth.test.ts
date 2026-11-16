import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { database, ACCOUNT, APP_ID, TOKEN, json, microsoft } from "./helpers";
import { app } from "../src/index";
import { createSessionToken, verifySessionToken } from "../src/auth";
import { db as store, eq, update } from "../src/storage/client";
import {
  MANUAL_REDIRECT_URI,
  PUBLIC_CLIENT_ID,
  parseAuthorizationResponse,
  outlookDiagnosis,
} from "../shared/outlook-recovery";

let f: Awaited<ReturnType<typeof database>>;
let cookie: string;
before(async () => {
  f = await database();
  const r = await f.request(
    "/api/auth/login",
    { password: f.env.ADMIN_PASSWORD },
    "POST",
    {},
  );
  cookie = r.response.headers.get("set-cookie")!.split(";")[0];
});
after(async () => f.dispose());
const start = (body: Record<string, unknown> = {}) =>
  f.request("/api/outlook/oauth/start", { mode: "manual", ...body }, "POST", {
    Cookie: cookie,
  });
const exchange = (
  state: string,
  response = "test-code",
  headers = { Cookie: cookie },
) =>
  f.request(
    "/api/outlook/oauth/exchange",
    { state, response },
    "POST",
    headers,
  );
const callbackUrl = (state: string, code = "test-code") =>
  `${MANUAL_REDIRECT_URI}/?${new URLSearchParams({ state, code })}`;
function provider(
  address: string,
  inspect?: (params: URLSearchParams) => void,
) {
  return (url: URL, init: RequestInit) => {
    if (url.hostname === "login.microsoftonline.com") {
      inspect?.(new URLSearchParams(String(init.body)));
      return json({
        access_token: "fake-access",
        refresh_token: TOKEN + "_authorized",
      });
    }
    assert.equal(url.pathname, "/v1.0/me");
    return json({ mail: address });
  };
}
test("authorization-code extraction accepts opaque raw codes and exact state-bound URLs only", () => {
  assert.equal(
    parseAuthorizationResponse("M.code%2B123", "state").code,
    "M.code+123",
  );
  assert.deepEqual(
    parseAuthorizationResponse(callbackUrl("state", "M.code+abc/="), "state"),
    { code: "M.code+abc/=", state: "state", fromUrl: true },
  );
  for (const value of [
    callbackUrl("other"),
    "https://localhost/?code=test-code",
    "https://evil.test/?code=a&state=state",
    "https://localhost.evil.test/?code=a&state=state",
    "https://localhost@evil.test/?code=a&state=state",
    "https://localhost:1234/?code=a&state=state",
    "http://localhost/?code=a&state=state",
    "https://localhost/other?code=a&state=state",
    callbackUrl("state") + "&code=duplicate",
    callbackUrl("state") + "&state=duplicate",
    callbackUrl("state") + "#code=hidden",
    "javascript:alert(1)",
    "code=abc&state=state",
    "bad%FF",
    "",
    "x".repeat(16385),
  ])
    assert.throws(() => parseAuthorizationResponse(value, "state"), value);
  assert.throws(
    () =>
      parseAuthorizationResponse(
        "https://localhost/?error=access_denied&state=state&error_description=private",
        "state",
      ),
    /未完成或已取消/,
  );
});
test("manual flow works without configured web app; PKCE, state, scopes and secret boundaries hold", async () => {
  const r = await start({ email: "manual@outlook.com" });
  assert.equal(r.response.status, 200);
  const url = new URL(r.data.url);
  assert.equal(url.searchParams.get("client_id"), PUBLIC_CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), MANUAL_REDIRECT_URI);
  assert.equal(url.searchParams.get("login_hint"), "manual@outlook.com");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope")!.includes("Mail.Send"), false);
  const state = r.data.data.state;
  await microsoft(
    provider("manual@outlook.com", (params) => {
      assert.equal(params.has("client_secret"), false);
      assert.equal(params.get("client_id"), PUBLIC_CLIENT_ID);
      assert.equal(params.get("code_verifier")!.length, 64);
      assert.equal(params.get("redirect_uri"), MANUAL_REDIRECT_URI);
    }),
    async () => {
      const saved = await exchange(state, callbackUrl(state));
      assert.equal(saved.response.status, 200);
      assert.equal(saved.data.data.email, "manual@outlook.com");
      assert.equal(saved.data.data.auth_status, "unchecked");
      assert.equal(JSON.stringify(saved.data).includes(TOKEN), false);
      assert.equal((await exchange(state)).response.status, 409);
    },
  );
  assert.equal((await start({ mode: "web" })).response.status, 400);
  assert.equal(
    (await f.request("/api/outlook/oauth/start", { mode: "manual" })).response
      .status,
    401,
  );
});
test("wrong session, wrong state URL, and malformed callback do not consume a valid flow", async () => {
  const r = await start();
  const state = r.data.data.state;
  const other = await f.request(
    "/api/auth/login",
    { password: f.env.ADMIN_PASSWORD },
    "POST",
    {},
  );
  const otherCookie = other.response.headers.get("set-cookie")!.split(";")[0];
  assert.notEqual(otherCookie, cookie);
  assert.equal(
    (await exchange(state, "test-code", { Cookie: otherCookie })).response
      .status,
    409,
  );
  assert.equal(
    (await exchange(state, callbackUrl("wrong"))).response.status,
    400,
  );
  assert.equal(
    (await exchange(state, "https://evil.test/secret")).response.status,
    400,
  );
  await microsoft(provider("isolated@outlook.com"), async () => {
    assert.equal((await exchange(state)).response.status, 200);
  });
});
test("contextual repair rejects a different mailbox and preserves all existing account metadata", async () => {
  const group = await f.request("/api/outlook/groups", {
    name: "OAuth keep group",
  });
  const account = await f.request("/api/outlook/accounts", {
    ...ACCOUNT,
    email: "repair@outlook.com",
    group_id: group.data.data.id,
    status: "disabled",
  });
  const id = account.data.data.id;
  const tag = await f.request("/api/outlook/tags", { name: "OAuth keep tag" });
  await f.request("/api/outlook/accounts/batch", {
    action: "tag",
    ids: [id],
    tag_id: tag.data.data.id,
  });
  const wrong = await start({ account_id: id });
  await microsoft(provider("someone-else@outlook.com"), async () => {
    const r = await exchange(wrong.data.data.state);
    assert.equal(r.response.status, 409);
    assert.match(r.data.message, /不匹配/);
  });
  const good = await start({ account_id: id, send_mail: true });
  assert.equal(
    new URL(good.data.url).searchParams.get("login_hint"),
    "repair@outlook.com",
  );
  assert.match(new URL(good.data.url).searchParams.get("scope")!, /Mail.Send/);
  await microsoft(provider("repair@outlook.com"), async () => {
    assert.equal((await exchange(good.data.data.state)).response.status, 200);
  });
  const saved = (await f.request(`/api/outlook/accounts/${id}`)).data.data;
  assert.equal(saved.password, ACCOUNT.password);
  assert.equal(saved.remark, ACCOUNT.remark);
  assert.equal(saved.status, "disabled");
  assert.equal(saved.group_id, group.data.data.id);
  assert.equal(saved.refresh_token, TOKEN + "_authorized");
  const links = await store(f.env).select("account_tags", {
    where: eq("account_id", id),
  });
  assert.equal(links[0].tag_id, tag.data.data.id);
  const health = await f.request(`/api/outlook/accounts/${id}/recovery`);
  assert.equal(health.data.data.diagnosis.action, "enable");
  assert.equal(JSON.stringify(health.data).includes(TOKEN), false);
  assert.equal("password" in health.data.data.account, false);
});
test("concurrent edit/deletion during authorization cannot be overwritten or resurrected", async () => {
  for (const operation of ["edit", "delete"]) {
    const address = `${operation}@outlook.com`;
    const id = (
      await f.request("/api/outlook/accounts", { ...ACCOUNT, email: address })
    ).data.data.id;
    const r = await start({ account_id: id });
    await microsoft(
      provider(address, () => {}),
      async () => {
        if (operation === "delete")
          await f.request(`/api/outlook/accounts/${id}`, undefined, "DELETE");
        else
          await f.request(
            `/api/outlook/accounts/${id}`,
            { refresh_token: TOKEN + "_newer" },
            "PUT",
          );
        assert.equal((await exchange(r.data.data.state)).response.status, 409);
      },
    );
    const saved = await store(f.env).first("accounts", eq("id", id));
    if (operation === "delete") assert.equal(saved, null);
    else assert.equal(saved?.refresh_token, TOKEN + "_newer");
  }
});
test("expired sessions and failed exchanges cannot be retried or replayed; provider messages are sanitized", async () => {
  const expired = await start();
  await store(f.env).mutate([
    update("oauth_sessions", undefined, { expires_at: 1 }),
  ]);
  assert.equal((await exchange(expired.data.data.state)).response.status, 409);
  const r = await start();
  await microsoft(
    () =>
      json(
        { error: "invalid_grant", error_description: "SECRET-MUST-NOT-LEAK" },
        400,
      ),
    async () => {
      const failed = await exchange(r.data.data.state);
      assert.equal(failed.response.status, 502);
      assert.equal(
        JSON.stringify(failed.data).includes("SECRET-MUST-NOT-LEAK"),
        false,
      );
      assert.equal((await exchange(r.data.data.state)).response.status, 409);
    },
  );
});
test("web and manual sessions are not interchangeable; callback binds verified identity and returns safe account context", async () => {
  f.env.MICROSOFT_CLIENT_ID = APP_ID;
  f.env.MICROSOFT_CLIENT_SECRET = "fictional-secret";
  const r = await start({ mode: "web", email: "web@outlook.com" });
  const state = r.data.data.state;
  assert.equal((await exchange(state)).response.status, 409);
  await microsoft(
    provider("web@outlook.com", (params) => {
      assert.equal(params.get("client_secret"), "fictional-secret");
    }),
    async () => {
      const callback = () =>
        app.request(
          `https://mailhub.test/api/outlook/oauth/callback?state=${state}&code=test-code`,
          { headers: { Cookie: cookie } },
          f.env,
        );
      const response = await callback();
      const html = await response.text();
      assert.match(html, /已授权并保存/);
      assert.match(html, /web@outlook.com/);
      assert.equal(html.includes(TOKEN), false);
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.match(await (await callback()).text(), /过期或已使用/);
    },
  );
  assert.equal((await start({ client_id: APP_ID })).response.status, 400);
});
test("repair diagnosis distinguishes revoked consent, permissions, disabled and retryable failures", () => {
  assert.equal(
    outlookDiagnosis({ auth_status: "reauth_required" }).action,
    "authorize",
  );
  assert.equal(
    outlookDiagnosis({ last_error_code: "ErrorAccessDenied" }).kind,
    "permissions",
  );
  assert.equal(
    outlookDiagnosis({ last_error_code: "invalid_client" }).action,
    "configure",
  );
  assert.equal(
    outlookDiagnosis({ last_error_code: "TIMEOUT", auth_status: "error" })
      .action,
    "retry",
  );
  assert.equal(
    outlookDiagnosis({ status: "disabled", auth_status: "reauth_required" })
      .action,
    "enable",
  );
});
test("logins have distinct signed session IDs even within one clock tick", async () => {
  const tokens = await Promise.all(
    Array.from({ length: 3 }, () =>
      createSessionToken("admin", "session-test-secret"),
    ),
  );
  assert.equal(new Set(tokens).size, 3);
  for (const token of tokens) {
    assert.equal(await verifySessionToken(token, "session-test-secret"), true);
    assert.equal(await verifySessionToken(token, "other-secret"), false);
  }
});
test("current renewal diagnosis takes priority over an older mailbox-check failure", () => {
  assert.equal(
    outlookDiagnosis({
      last_error_code: "TIMEOUT",
      token_refresh_status: "retrying",
      token_refresh_error: "invalid_client: application expired",
    }).action,
    "configure",
  );
  assert.equal(
    outlookDiagnosis({
      last_error_code: "TIMEOUT",
      token_refresh_status: "reauth_required",
      token_refresh_error: "invalid_grant: revoked",
    }).action,
    "authorize",
  );
  assert.equal(
    outlookDiagnosis({
      last_error_code: "ErrorAccessDenied",
      token_refresh_status: "healthy",
      token_refresh_error: "",
    }).kind,
    "permissions",
  );
});
test("attention inventory includes renewal errors without inflating healthy counts", async () => {
  const id = (
    await f.request("/api/outlook/accounts", {
      ...ACCOUNT,
      email: "renewal-failed@outlook.com",
    })
  ).data.data.id;
  await store(f.env).mutate([
    update("accounts", eq("id", id), {
      auth_status: "healthy",
      token_refresh_status: "retrying",
      token_refresh_error: "NETWORK_ERROR: temporary",
    }),
  ]);
  const attention = await f.request("/api/outlook/accounts?attention=true");
  assert.ok(attention.data.data.some((a: any) => a.id === id));
  assert.equal(attention.data.total, attention.data.summary.attention);
  assert.equal(
    attention.data.summary.total,
    attention.data.summary.healthy +
      attention.data.summary.attention +
      attention.data.summary.unchecked +
      attention.data.summary.disabled,
  );
  const healthy = await f.request(
    "/api/outlook/accounts?auth_status=healthy&attention=true",
  );
  assert.equal(
    healthy.data.data.some((a: any) => a.id === id),
    true,
  );
});
test("concurrent exchanges claim a code once and save credentials encrypted", async () => {
  f.env.CREDENTIAL_ENCRYPTION_KEY =
    "a-private-test-encryption-key-with-32-characters";
  try {
    const r = await start({ email: "encrypted@outlook.com" });
    let calls = 0;
    await microsoft(
      provider("encrypted@outlook.com", () => {
        calls++;
      }),
      async () => {
        const results = await Promise.all([
          exchange(r.data.data.state),
          exchange(r.data.data.state),
        ]);
        assert.deepEqual(
          results.map((r) => r.response.status).sort(),
          [200, 409],
        );
        assert.equal(calls, 1);
      },
    );
    const row = await f.DB.prepare(
      "SELECT refresh_token FROM accounts WHERE email='encrypted@outlook.com'",
    ).first<any>();
    assert.equal(row.refresh_token.includes(TOKEN), false);
    assert.equal(
      (
        await store(f.env).first(
          "accounts",
          eq("email", "encrypted@outlook.com"),
        )
      )?.refresh_token,
      TOKEN + "_authorized",
    );
  } finally {
    delete f.env.CREDENTIAL_ENCRYPTION_KEY;
  }
});
