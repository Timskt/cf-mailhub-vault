import test from "node:test";
import assert from "node:assert/strict";
import { database } from "./helpers";
import { MemoryControl } from "./storage-support";
import {
  Coordinator,
  type Source,
  type ControlState,
} from "../src/storage/coordinator";
import { D1Port } from "../src/storage/d1";
import { DirectStore } from "../src/storage/engine";
import {
  eq,
  and,
  oneOf,
  insert,
  update,
  remove,
  rowKey,
  tables,
  canonical,
  StorageError,
  type DataPort,
} from "../src/storage/model";
import {
  HttpPort,
  openSecret,
  sealSecret,
  connectionUrl,
} from "../src/storage/http";

test("connector authentication failures do not expire the administrator session", async (t) => {
  let status = 401;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ code: "UNAUTHORIZED" }, { status }),
  );
  const port = new HttpPort(
    {
      endpoint: "https://connector.example.test",
      source: "redis-a",
      token: "fictional",
    },
    "test-generation",
    "test-owner",
  );
  for (status of [401, 403]) {
    await assert.rejects(
      port.health(),
      (error: unknown) =>
        error instanceof StorageError &&
        error.status === 502 &&
        error.code === "CONNECTOR_AUTH_FAILED" &&
        error.message.includes("连接令牌"),
    );
  }
});
const initial: Source = { id: "d1", name: "D1", kind: "d1", created: "test" };
const target: Source = {
  id: "d1-b",
  name: "D1 isolated generation",
  kind: "d1",
  created: "test",
};
async function finish(coordinator: Coordinator) {
  for (let i = 0; i < 300; i++) {
    const status = await coordinator.status();
    if (status.job?.phase === "complete") return status;
    assert.equal(status.job?.paused, false, status.job?.error);
    await coordinator.step();
  }
  assert.fail("migration did not complete");
}
test("replica snapshots copy concurrent changes and verify data without changing the active database", async () => {
  const fixture = await database();
  try {
    const coordinator = new Coordinator(
      new MemoryControl(),
      async (_source, generation) => new D1Port(fixture.DB, generation),
      initial,
    );
    await coordinator.addSource({ ...target, purpose: "replica" });
    await coordinator.mutate([
      insert("settings", { key: "snapshot-test", value: "before" }),
    ]);
    await assert.rejects(
      coordinator.start(target.id),
      (e: any) => e.code === "SOURCE_REPLICA_ONLY",
    );
    await coordinator.start(target.id, true, "snapshot");
    await coordinator.step();
    await coordinator.mutate([
      update("settings", eq("key", "snapshot-test"), { value: "during-copy" }),
    ]);
    const status = await finish(coordinator);
    assert.equal(status.active.sourceId, "d1");
    assert.equal(status.active.generation, "legacy");
    assert.equal(status.job!.mode, "snapshot");
    assert.equal(status.previous.length, 0);
    const replica = new D1Port(fixture.DB, status.job!.to.generation);
    assert.equal(
      (await replica.find("settings", { where: eq("key", "snapshot-test") }))[0]
        .value,
      "during-copy",
    );
    assert.deepEqual(await replica.info(), await new D1Port(fixture.DB).info());
  } finally {
    await fixture.dispose();
  }
});
test("atomic storage changes preserve uniqueness, references, counters and rollback on failure", async () => {
  const fixture = await database();
  try {
    const port = new D1Port(fixture.DB),
      store = new DirectStore(port);
    const [saved] = await store.mutate([
      insert("accounts", {
        email: "a@example.test",
        client_id: "c",
        refresh_token: "t",
      }),
    ]);
    assert.equal(saved.lastId, 1);
    const before = await port.info();
    await assert.rejects(
      store.mutate([
        insert("settings", { key: "must-not-exist", value: "x" }),
        insert("accounts", {
          email: "b@example.test",
          client_id: "c",
          refresh_token: "t",
          group_id: 999,
        }),
      ]),
      /关联记录不存在/,
    );
    assert.equal(
      await store.first("settings", eq("key", "must-not-exist")),
      null,
    );
    assert.deepEqual(await port.info(), before);
    await store.mutate([
      insert("tags", { name: "生产" }),
      insert("account_tags", { account_id: 1, tag_id: 1 }),
      remove("accounts", eq("id", 1)),
    ]);
    assert.equal(await store.count("account_tags"), 0);
    const [next] = await store.mutate([
      insert("accounts", {
        email: "b@example.test",
        client_id: "c",
        refresh_token: "t",
      }),
    ]);
    assert.equal(next.lastId, 2);
  } finally {
    await fixture.dispose();
  }
});
test("online copy replays concurrent inserts, updates, deletes and preserves IDs when switching back", async () => {
  const fixture = await database();
  try {
    const memory = new MemoryControl(),
      factory = async (_source: Source, generation: string) =>
        new D1Port(fixture.DB, generation);
    let coordinator = new Coordinator(memory, factory, initial);
    await coordinator.addSource(target);
    await coordinator.mutate([
      {
        op: "insert",
        table: "platform_vault",
        rows: Array.from({ length: 110 }, (_, i) => ({
          platform_name: `平台${i}`,
          account_email: `a${i}@example.test`,
          password: `p<${i}>`,
          totp_secret: "秘密",
        })),
      },
    ]);
    await coordinator.mutate([
      insert("settings", { key: "session_epoch", value: "epoch-1" }),
      insert("temp_mailboxes", {
        address: "bound@example.test",
        is_permanent: 1,
      }),
      insert("cf_inbox_mails", {
        recipient: "bound@example.test",
        sender: "s@example.test",
        text_content: "a".repeat(800000),
      }),
    ]);
    await coordinator.start(target.id);
    await coordinator.step();
    await coordinator.mutate([
      update("platform_vault", eq("id", 1), { password: "rotated" }),
      remove("platform_vault", eq("id", 2)),
      insert("platform_vault", {
        platform_name: "During copy",
        account_email: "new@example.test",
      }),
    ]);
    // A new controller instance has only durable state, not the former process's memory.
    coordinator = new Coordinator(memory, factory, initial);
    let sawPausedWrites = false;
    for (let i = 0; i < 100; i++) {
      const status = await coordinator.status();
      if (status.job?.phase === "verify") {
        await assert.rejects(
          coordinator.mutate([
            insert("settings", { key: "blocked", value: "x" }),
          ]),
          /写入暂时暂停/,
        );
        sawPausedWrites = true;
      }
      if (status.job?.phase === "complete") break;
      await coordinator.step();
    }
    assert.ok(sawPausedWrites);
    assert.equal((await coordinator.status()).active.sourceId, target.id);
    assert.equal(await coordinator.count("platform_vault"), 110);
    assert.equal(
      (await coordinator.find("platform_vault", { where: eq("id", 1) }))[0]
        .password,
      "rotated",
    );
    assert.equal(
      (await coordinator.find("platform_vault", { where: eq("id", 2) })).length,
      0,
    );
    await coordinator.mutate([
      insert("platform_vault", {
        platform_name: "After switch",
        account_email: "after@example.test",
      }),
    ]);
    await coordinator.start("d1");
    await finish(coordinator);
    assert.equal(await coordinator.count("platform_vault"), 111);
    assert.equal(
      (await coordinator.find("platform_vault", { where: eq("id", 112) }))[0]
        .platform_name,
      "After switch",
    );
    assert.equal((await coordinator.security()).session_epoch, "epoch-1");
    assert.notEqual((await coordinator.status()).active.generation, "legacy");
  } finally {
    await fixture.dispose();
  }
});
test("an ambiguous source commit is recovered exactly once before later reads or writes", async () => {
  const fixture = await database();
  try {
    const memory = new MemoryControl();
    let fail = true;
    const factory = async (_source: Source, generation: string) => {
      const port = new D1Port(fixture.DB, generation),
        commit = port.commit.bind(port);
      port.commit = async (value) => {
        await commit(value);
        if (fail) {
          fail = false;
          throw new Error("response lost");
        }
      };
      return port;
    };
    let coordinator = new Coordinator(memory, factory, initial);
    await assert.rejects(
      coordinator.mutate([
        insert("platform_vault", {
          platform_name: "Once",
          account_email: "once@example.test",
        }),
      ]),
      /response lost/,
    );
    assert.equal((await coordinator.status()).pending_write, true);
    coordinator = new Coordinator(memory, factory, initial);
    assert.equal(await coordinator.count("platform_vault"), 1);
    assert.equal((await coordinator.status()).pending_write, false);
    const [saved] = await coordinator.mutate([
      insert("platform_vault", {
        platform_name: "Next",
        account_email: "next@example.test",
      }),
    ]);
    assert.equal(saved.lastId, 2);
  } finally {
    await fixture.dispose();
  }
});
test("copy failure resumes idempotently; verification mismatch never cuts over and cancel resumes normal writes", async () => {
  const fixture = await database();
  try {
    const memory = new MemoryControl();
    let failCopy = true,
      corrupt = false;
    const factory = async (_source: Source, generation: string) => {
      const port = new D1Port(fixture.DB, generation),
        copy = port.copy.bind(port);
      if (generation !== "legacy")
        port.copy = async (table, rows) => {
          await copy(
            table,
            corrupt && table === "groups"
              ? rows.map((r) => ({ ...r, name: "corrupted" }))
              : rows,
          );
          if (failCopy) {
            failCopy = false;
            throw new Error("network interruption after copy");
          }
        };
      return port;
    };
    const coordinator = new Coordinator(memory, factory, initial);
    await coordinator.addSource(target);
    await coordinator.start(target.id);
    await coordinator.step();
    assert.match((await coordinator.status()).job!.error, /同步暂时失败/);
    await finish(coordinator);
    corrupt = true;
    await coordinator.start("d1");
    for (let i = 0; i < 100 && !(await coordinator.status()).job?.paused; i++)
      await coordinator.step();
    const status = await coordinator.status();
    assert.equal(status.active.sourceId, target.id);
    assert.match(status.job!.error, /VERIFY_MISMATCH/);
    await coordinator.mutate([
      insert("settings", { key: "still-works", value: "true" }),
    ]);
    await coordinator.cancel();
    assert.equal((await coordinator.status()).job?.phase, "cancelled");
    assert.equal(
      (
        await coordinator.find("settings", { where: eq("key", "still-works") })
      )[0].value,
      "true",
    );
  } finally {
    await fixture.dispose();
  }
});
test("connection secrets require encryption and URLs cannot leak tokens into redirects or URL userinfo", async () => {
  const secret = "a".repeat(40),
    plaintext = "fictional-connector-token".repeat(2),
    encrypted = await sealSecret(plaintext, secret);
  assert.ok(!encrypted.includes(plaintext));
  assert.equal(await openSecret(encrypted, secret), plaintext);
  await assert.rejects(openSecret(encrypted, "b".repeat(40)), /解密/);
  await assert.rejects(sealSecret(plaintext, "short"), /32/);
  for (const url of [
    "http://db.example.com",
    "https://user:token@example.com",
    "https://example.com/?token=secret",
  ])
    assert.throws(() => connectionUrl(url));
  assert.equal(
    connectionUrl("http://localhost:8080", true),
    "http://localhost:8080",
  );
  assert.throws(() => connectionUrl("http://192.168.1.2:8080", true));
});

test("cleanup rechecks a platform binding that appeared after candidate selection", async () => {
  const fixture = await database();
  try {
    const store = new DirectStore(new D1Port(fixture.DB));
    const [mail] = await store.mutate([
      insert("cf_inbox_mails", {
        recipient: "new-binding@example.test",
        sender: "auth@example.test",
      }),
    ]);
    await store.mutate([
      insert("platform_vault", {
        platform_name: "New binding",
        account_email: "new-binding@example.test",
        email_source: "cf_domain",
      }),
    ]);
    const [cleaned] = await store.mutate([
      { op: "cleanMail", ids: [mail.lastId] },
    ]);
    assert.equal(cleaned.changes, 0);
    assert.equal(await store.count("cf_inbox_mails"), 1);
  } finally {
    await fixture.dispose();
  }
});

test("source configuration can update a token without moving the active dataset or exposing it", async () => {
  const fixture = await database();
  try {
    const memory = new MemoryControl();
    const source: Source = {
      id: "remote",
      name: "Remote",
      kind: "mysql",
      endpoint: "https://connector.example.test",
      source: "mysql-a",
      secret: "encrypted-original",
      created: "test",
    };
    const coordinator = new Coordinator(
      memory,
      async (config, gen) => {
        if (config.secret === "bad-token")
          throw new StorageError("INVALID_TOKEN", "连接令牌无效", 401);
        return new D1Port(fixture.DB, gen);
      },
      initial,
    );
    await coordinator.addSource(source);
    await coordinator.start(source.id);
    await finish(coordinator);
    const before = (await coordinator.status()).active;
    await coordinator.updateSource(source.id, {
      name: "Renamed",
      secret: "encrypted-new-token",
    });
    assert.deepEqual((await coordinator.status()).active, before);
    assert.ok(
      !JSON.stringify(await coordinator.status()).includes(
        "encrypted-new-token",
      ),
    );
    await assert.rejects(
      coordinator.updateSource(source.id, { secret: "bad-token" }),
    );
    assert.equal(
      (await memory.get<ControlState>("state"))!.sources.find(
        (s) => s.id === source.id,
      )!.secret,
      "encrypted-new-token",
    );
  } finally {
    await fixture.dispose();
  }
});

test("replay resumes after multiple target commits succeeded before the coordinator checkpoint was saved", async () => {
  const fixture = await database();
  try {
    const memory = new MemoryControl(),
      factory = async (_source: Source, generation: string) =>
        new D1Port(fixture.DB, generation);
    let coordinator = new Coordinator(memory, factory, initial);
    await coordinator.addSource(target);
    await coordinator.start(target.id);
    await coordinator.mutate([
      insert("settings", { key: "first-during-copy", value: "one" }),
    ]);
    await coordinator.mutate([
      insert("settings", { key: "second-during-copy", value: "two" }),
    ]);
    await coordinator.mutate([
      insert("settings", { key: "third-during-copy", value: "three" }),
    ]);
    while ((await coordinator.status()).job?.phase === "copy")
      await coordinator.step();
    const state = (await memory.get<ControlState>("state"))!,
      port = new D1Port(fixture.DB, state.job!.to.generation);
    // Simulate a process loss after two remote commits, retaining the old durable cursor.
    for (const version of [state.job!.base + 1, state.job!.base + 2]) {
      const commit = await memory.get<import("../src/storage/model").Commit>(
        `log:${String(version).padStart(16, "0")}`,
      );
      await port.commit(commit!);
    }
    coordinator = new Coordinator(memory, factory, initial);
    await finish(coordinator);
    assert.equal((await coordinator.status()).active.sourceId, target.id);
    assert.equal(
      (
        await coordinator.find("settings", {
          where: eq("key", "third-during-copy"),
        })
      )[0].value,
      "three",
    );
  } finally {
    await fixture.dispose();
  }
});
