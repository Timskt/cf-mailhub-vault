import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createSessionToken, getSessionSecret, sha256 } from "../src/auth";
import { runCleanup } from "../src/cron";
import { app } from "../src/index";
import { rawDb, eq, type Commit } from "../src/storage/client";
import { D1Port } from "../src/storage/d1";
import { DirectStore } from "../src/storage/engine";
import type { Env } from "../src/types";
import { ACCOUNT, TOKEN, database, json, microsoft } from "./helpers";

function gate(label: string) {
  let open!: () => void;
  const ready = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    open,
    async wait() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          ready,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Timed out: ${label}`)),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function instance(base: Env) {
  // Different binding identities create independent DirectStore queues, while
  // both D1Ports still execute real transactions against the same test database.
  const env = {
    ...base,
    DB: new Proxy(base.DB, {
      get(target, property) {
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
  const store = rawDb(env);
  assert.ok(store instanceof DirectStore);
  assert.ok(store.port instanceof D1Port);
  return { env, store, port: store.port };
}

async function fixture(t: TestContext) {
  const f = await database();
  t.after(() => f.dispose());
  const cookie = `mailhub_session=${await createSessionToken("admin", await getSessionSecret(f.env))}`;
  const first = instance(f.env),
    second = instance(f.env);
  assert.notEqual(first.store, second.store);
  assert.notEqual(first.port, second.port);
  async function post(env: Env, path: string, body: unknown) {
    const response = await app.request(
      `https://mailhub.test/api/outlook/oauth/${path}`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
    return { response, data: (await response.json()) as any };
  }
  async function start(body: Record<string, unknown> = {}) {
    const result = await post(f.env, "start", { mode: "manual", ...body });
    assert.equal(result.response.status, 200);
    return result.data.data as { state: string; expires_at: number };
  }
  const exchange = (env: Env, state: string) =>
    post(env, "exchange", { state, response: "same-code" });
  return { ...f, first, second, start, exchange };
}

test(
  "separate D1 instances exchange one state only once when both claims were planned at the same revision",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const flow = await f.start({ email: "claim-race@outlook.com" });
    const firstRead = gate("first authorization read"),
      bothRead = gate("both authorization reads");
    const secondPlanned = gate("second claim planned"),
      firstCommitted = gate("first claim committed");
    const loserFinished = gate("losing exchange finished");
    const gates = [
      firstRead,
      bothRead,
      secondPlanned,
      firstCommitted,
      loserFinished,
    ];
    const plans: Commit[] = [];
    let readers = 0;
    for (const [index, { port }] of [f.first, f.second].entries()) {
      const find = port.find.bind(port),
        commit = port.commit.bind(port);
      let read = false;
      t.mock.method(
        port,
        "find",
        async (...args: Parameters<D1Port["find"]>) => {
          const rows = await find(...args);
          if (!read && args[0] === "oauth_sessions" && args[1]?.limit === 1) {
            read = true;
            if (index === 0) firstRead.open();
            if (++readers === 2) bothRead.open();
            await bothRead.wait();
          }
          return rows;
        },
      );
      t.mock.method(port, "commit", async (value: Commit) => {
        if (!value.changes.some((change) => change.table === "oauth_sessions"))
          return commit(value);
        plans[index] = value;
        if (index === 0) {
          await secondPlanned.wait();
          try {
            await commit(value);
          } finally {
            firstCommitted.open();
          }
        } else {
          secondPlanned.open();
          await firstCommitted.wait();
          await commit(value);
        }
      });
    }
    let tokenCalls = 0;
    await microsoft(
      async (url) => {
        if (url.hostname === "login.microsoftonline.com") {
          if (++tokenCalls > 1) return json({ error: "invalid_grant" }, 400);
          await loserFinished.wait();
          return json({
            access_token: "fake-access",
            refresh_token: TOKEN + "_authorized",
          });
        }
        assert.equal(url.pathname, "/v1.0/me");
        return json({ mail: "claim-race@outlook.com" });
      },
      async () => {
        const pending: ReturnType<typeof f.exchange>[] = [];
        try {
          pending.push(f.exchange(f.first.env, flow.state));
          // Complete the first audit intent before starting the second request, then
          // let both authorize/plan together. No unrelated audit-write race is tested.
          await firstRead.wait();
          pending.push(
            f.exchange(f.second.env, flow.state).finally(loserFinished.open),
          );
          const results = await Promise.all(pending);
          assert.equal(plans.length, 2);
          assert.equal(plans[0].expected, plans[1].expected);
          assert.equal(
            tokenCalls,
            1,
            "one authorization code must reach Microsoft at most once",
          );
          assert.deepEqual(
            results.map((r) => r.response.status),
            [200, 409],
          );
          assert.equal(results[1].data.error, "OAUTH_RESTART_REQUIRED");
          const replay = await f.exchange(f.second.env, flow.state);
          assert.equal(replay.response.status, 409);
          assert.equal(replay.data.error, "OAUTH_RESTART_REQUIRED");
          assert.equal(tokenCalls, 1);
        } finally {
          gates.forEach((g) => g.open());
          await Promise.allSettled(pending);
        }
      },
    );
  },
);

test(
  "a credential edit during the profile request preserves newer credentials and returns the OAuth restart code",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const created = await f.request("/api/outlook/accounts", {
      ...ACCOUNT,
      email: "save-race@outlook.com",
    });
    const id = created.data.data.id;
    const flow = await f.start({ account_id: id });
    let tokenCalls = 0;
    await microsoft(
      async (url) => {
        if (url.hostname === "login.microsoftonline.com") {
          tokenCalls++;
          return json({
            access_token: "fake-access",
            refresh_token: TOKEN + "_stale_authorization",
          });
        }
        assert.equal(url.pathname, "/v1.0/me");
        const edit = await f.request(
          `/api/outlook/accounts/${id}`,
          {
            client_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            refresh_token: TOKEN + "_newer",
          },
          "PUT",
        );
        assert.equal(edit.response.status, 200);
        return json({ mail: "save-race@outlook.com" });
      },
      async () => {
        const result = await f.exchange(f.first.env, flow.state);
        assert.equal(result.response.status, 409);
        assert.equal(result.data.error, "OAUTH_RESTART_REQUIRED");
        const saved = (await f.request(`/api/outlook/accounts/${id}`)).data
          .data;
        assert.equal(saved.refresh_token, TOKEN + "_newer");
        assert.equal(saved.client_id, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
        assert.equal(saved.password, ACCOUNT.password);
        assert.equal(saved.remark, ACCOUNT.remark);
        assert.equal(
          (await f.exchange(f.second.env, flow.state)).response.status,
          409,
        );
        assert.equal(tokenCalls, 1);
      },
    );
  },
);

test(
  "a request that crosses the expiry boundary before claiming never contacts Microsoft even before cleanup",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    let clock = Date.now();
    t.mock.method(Date, "now", () => clock);
    const flow = await f.start({ email: "expiry-race@outlook.com" });
    const read = gate("authorization read before expiry"),
      release = gate("release expired authorization");
    const find = f.first.port.find.bind(f.first.port);
    let paused = false,
      tokenCalls = 0;
    t.mock.method(
      f.first.port,
      "find",
      async (...args: Parameters<D1Port["find"]>) => {
        const rows = await find(...args);
        if (!paused && args[0] === "oauth_sessions" && args[1]?.limit === 1) {
          paused = true;
          read.open();
          await release.wait();
        }
        return rows;
      },
    );
    await microsoft(
      async (url) => {
        if (url.hostname === "login.microsoftonline.com") {
          tokenCalls++;
          return json({ error: "invalid_grant" }, 400);
        }
        throw new Error("An expired flow must not fetch a profile");
      },
      async () => {
        const pending = f.exchange(f.first.env, flow.state);
        try {
          await read.wait();
          clock = flow.expires_at * 1000;
          release.open();
          const result = await pending;
          assert.equal(tokenCalls, 0, "expiry must be checked again when claiming");
          assert.equal(result.response.status, 409);
          assert.equal(result.data.error, "OAUTH_RESTART_REQUIRED");
        } finally {
          release.open();
          await pending;
        }
      },
    );
  },
);

test(
  "claims survive early cleanup and an expired, cleaned claim cannot be reused by an already-authorized contender",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    let clock = Date.now();
    t.mock.method(Date, "now", () => clock);
    const flow = await f.start({ email: "cleanup-race@outlook.com" });
    const stateHash = await sha256(flow.state);
    const staleRead = gate("stale contender read"),
      releaseStale = gate("release stale contender");
    const providerEntered = gate("winning provider request"),
      releaseProvider = gate("release provider");
    const gates = [staleRead, releaseStale, providerEntered, releaseProvider];
    const find = f.second.port.find.bind(f.second.port);
    let paused = false,
      tokenCalls = 0;
    t.mock.method(
      f.second.port,
      "find",
      async (...args: Parameters<D1Port["find"]>) => {
        const rows = await find(...args);
        if (!paused && args[0] === "oauth_sessions" && args[1]?.limit === 1) {
          paused = true;
          staleRead.open();
          await releaseStale.wait();
        }
        return rows;
      },
    );
    await microsoft(
      async (url, init) => {
        if (url.hostname === "login.microsoftonline.com") {
          if (++tokenCalls > 1) return json({ error: "invalid_grant" }, 400);
          assert.equal(
            new URLSearchParams(String(init.body)).get("code_verifier")?.length,
            64,
          );
          providerEntered.open();
          await releaseProvider.wait();
          return json({
            access_token: "fake-access",
            refresh_token: TOKEN + "_authorized",
          });
        }
        assert.equal(url.pathname, "/v1.0/me");
        return json({ mail: "cleanup-race@outlook.com" });
      },
      async () => {
        const pending: ReturnType<typeof f.exchange>[] = [];
        try {
          const stale = f.exchange(f.second.env, flow.state);
          pending.push(stale);
          await staleRead.wait();
          const winner = f.exchange(f.first.env, flow.state);
          pending.push(winner);
          await providerEntered.wait();

          clock = (flow.expires_at - 1) * 1000;
          const fresh = await f.start({ email: "unrelated@outlook.com" });
          await runCleanup(f.env);
          const claim = await rawDb(f.env).first(
            "oauth_sessions",
            eq("state_hash", stateHash),
          );
          assert.ok(
            claim,
            "starting another flow and cron cleanup must retain the unexpired claim",
          );
          assert.equal(claim.expires_at, flow.expires_at);
          assert.equal(claim.verifier, "");
          assert.notEqual(JSON.parse(String(claim.context)).version, 1);

          clock = flow.expires_at * 1000;
          await runCleanup(f.env);
          assert.equal(
            await rawDb(f.env).first(
              "oauth_sessions",
              eq("state_hash", stateHash),
            ),
            null,
          );
          assert.ok(
            await rawDb(f.env).first(
              "oauth_sessions",
              eq("state_hash", await sha256(fresh.state)),
            ),
          );
          const replay = await f.exchange(f.env, flow.state);
          assert.equal(replay.response.status, 409);
          assert.equal(replay.data.error, "OAUTH_RESTART_REQUIRED");
          releaseStale.open();
          const rejected = await stale;
          assert.equal(rejected.response.status, 409);
          assert.equal(rejected.data.error, "OAUTH_RESTART_REQUIRED");
          releaseProvider.open();
          assert.equal((await winner).response.status, 200);
          assert.equal(tokenCalls, 1);
        } finally {
          gates.forEach((g) => g.open());
          await Promise.allSettled(pending);
        }
      },
    );
  },
);
