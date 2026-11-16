import assert from "node:assert/strict";
import test from "node:test";
import { createSessionToken, getSessionSecret } from "../src/auth";
import {
  Coordinator,
  type Source,
  type ControlState,
} from "../src/storage/coordinator";
import { D1Port } from "../src/storage/d1";
import { db, eq, insert, update } from "../src/storage/client";
import type { Env } from "../src/types";
import { database } from "./helpers";
import { MemoryControl } from "./storage-support";

async function setup() {
  const f = await database();
  const memory = new MemoryControl();
  const initial: Source = {
    id: "d1",
    name: "Test",
    kind: "d1",
    created: "test",
  };
  let loseAck = false,
    offline = false;
  const factory = async (_source: Source, generation: string) => {
    const port = new D1Port(f.DB, generation);
    const commit = port.commit.bind(port);
    port.commit = async (value) => {
      if (offline) throw new Error("storage offline");
      await commit(value);
      if (loseAck) {
        loseAck = false;
        throw new Error("acknowledgement lost");
      }
    };
    return port;
  };
  let coordinator = new Coordinator(memory, factory, initial);
  f.env.CREDENTIAL_ENCRYPTION_KEY = "fictional-session-recovery-encryption-key";
  f.env.STORAGE = {
    idFromName: () => "test",
    get: () => ({
      fetch: async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname,
          body = JSON.parse(String(init.body));
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
          else throw new Error("unexpected internal request");
          return Response.json({ data });
        } catch {
          return Response.json(
            { error: "STORAGE_UNAVAILABLE", message: "Storage unavailable" },
            { status: 503 },
          );
        }
      },
    }),
  } as unknown as Env["STORAGE"];
  await db(f.env).mutate([
    insert("settings", { key: "session_epoch", value: "old-epoch" }),
    insert("platform_vault", {
      platform_name: "Recovery",
      account_email: "recovery@example.test",
      password: "fictional-sensitive-password",
    }),
  ]);
  const cookie = `mailhub_session=${await createSessionToken("admin", await getSessionSecret(f.env))}`;
  return {
    ...f,
    memory,
    cookie,
    coordinator: () => coordinator,
    loseAcknowledgement: () => {
      loseAck = true;
    },
    setOffline: (value: boolean) => {
      offline = value;
    },
    restart: () => {
      coordinator = new Coordinator(memory, factory, initial);
    },
  };
}

test("session revocation recovers a committed security intent before the first sensitive read after restart", async () => {
  const f = await setup();
  try {
    f.loseAcknowledgement();
    await assert.rejects(
      f
        .coordinator()
        .mutate([
          update("settings", eq("key", "session_epoch"), {
            value: "new-epoch",
          }),
        ]),
      /acknowledgement lost/,
    );
    assert.equal(
      (await f.memory.get<ControlState>("state"))!.security!.session_epoch,
      "old-epoch",
    );
    assert.equal(
      (await f.DB.prepare(
        "SELECT value FROM settings WHERE key='session_epoch'",
      ).first<{ value: string }>())!.value,
      "new-epoch",
    );
    f.restart();
    const first = await f.request("/api/vault/1", undefined, "GET", {
      Cookie: f.cookie,
    });
    assert.equal(first.response.status, 401);
    assert.equal(first.data.data, undefined);
    assert.equal(
      JSON.stringify(first.data).includes("fictional-sensitive-password"),
      false,
    );
    assert.equal((await f.coordinator().status()).pending_write, false);
    const current = `mailhub_session=${await createSessionToken("admin", await getSessionSecret(f.env))}`;
    const allowed = await f.request("/api/vault/1", undefined, "GET", {
      Cookie: current,
    });
    assert.equal(allowed.response.status, 200);
    assert.equal(allowed.data.data.password, "fictional-sensitive-password");
  } finally {
    await f.dispose();
  }
});

test("pending security changes fail closed until recovery is confirmed", async () => {
  const f = await setup();
  try {
    f.loseAcknowledgement();
    await assert.rejects(
      f
        .coordinator()
        .mutate([
          update("settings", eq("key", "session_epoch"), {
            value: "new-epoch",
          }),
        ]),
    );
    f.restart();
    f.setOffline(true);
    for (let attempt = 0; attempt < 2; attempt++) {
      const denied = await f.request("/api/vault/1", undefined, "GET", {
        Cookie: f.cookie,
      });
      assert.equal(denied.response.status, 503);
      assert.equal(denied.data.error, "STORAGE_UNAVAILABLE");
      assert.equal(denied.data.data, undefined);
    }
    assert.equal((await f.coordinator().status()).pending_write, true);
    f.setOffline(false);
    assert.equal(
      (await f.request("/api/vault/1", undefined, "GET", { Cookie: f.cookie }))
        .response.status,
      401,
    );
  } finally {
    await f.dispose();
  }
});

test("an unrelated pending write does not block the administrator storage recovery panel", async () => {
  const f = await setup();
  try {
    f.loseAcknowledgement();
    await assert.rejects(
      f
        .coordinator()
        .mutate([
          update("platform_vault", eq("id", 1), {
            remark: "pending non-security write",
          }),
        ]),
    );
    f.restart();
    f.setOffline(true);
    const status = await f.request("/api/settings/storage", undefined, "GET", {
      Cookie: f.cookie,
    });
    assert.equal(status.response.status, 200);
    assert.equal(status.data.data.pending_write, true);
    assert.equal((await f.coordinator().security()).session_epoch, "old-epoch");
  } finally {
    await f.dispose();
  }
});
