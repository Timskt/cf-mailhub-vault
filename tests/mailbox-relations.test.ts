import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { db, eq, insert, remove, update } from "../src/storage/client";
import { Coordinator } from "../src/storage/coordinator";
import { D1Port } from "../src/storage/d1";
import { StorageError, type Mutation, type Row } from "../src/storage/model";
import type { Env } from "../src/types";
import { database } from "./helpers";
import { MemoryControl } from "./storage-support";

const address = "relations@example.test";

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

async function fixture(t: TestContext, permanent = 0) {
  const f = await database();
  t.after(() => f.dispose());
  const coordinator = new Coordinator(
    new MemoryControl(),
    async (_source, generation) => new D1Port(f.DB, generation),
    { id: "d1", name: "D1", kind: "d1", created: "test" },
  );
  let beforeMutation: ((mutations: Mutation[]) => Promise<void>) | undefined;
  // Only the transport is local. Reads, planning, serialization and commits use
  // the real Coordinator and Miniflare D1, without replacing their behavior.
  f.env.STORAGE = {
    idFromName: () => "mailbox-relations",
    get: () => ({
      fetch: async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        try {
          let data: unknown;
          switch (new URL(url).pathname) {
            case "/auth/settings":
              data = await coordinator.security();
              break;
            case "/data/find":
              data = await coordinator.find(body.table, body.query);
              break;
            case "/data/count":
              data = await coordinator.count(body.table, body.where);
              break;
            case "/data/mutate":
              await beforeMutation?.(body.mutations);
              data = await coordinator.mutate(body.mutations);
              break;
            default:
              throw new Error(`Unexpected storage path: ${url}`);
          }
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
  const store = db(f.env);
  const [box] = await store.mutate([
    insert("temp_mailboxes", {
      address,
      prefix: "relations",
      domain: "example.test",
      is_permanent: permanent,
      expires_at: permanent ? "" : "2099-01-01T00:00:00.000Z",
    }),
    insert("cf_inbox_mails", {
      recipient: address,
      subject: "Unpinned fixture",
      raw_object_key: "mail/relations-unpinned.eml",
      is_protected: permanent,
    }),
    insert("cf_inbox_mails", {
      recipient: address,
      subject: "Pinned fixture",
      raw_object_key: "mail/relations-pinned.eml",
      is_pinned: 1,
      is_protected: permanent,
    }),
  ]);
  const id = box.lastId;
  function pauseMailboxWrite() {
    assert.equal(beforeMutation, undefined);
    const reached = gate("mailbox request ready to mutate");
    const release = gate("release mailbox request");
    beforeMutation = async (mutations) => {
      if (
        !mutations.some(
          (m) => m.op === "update" && m.table === "temp_mailboxes",
        )
      )
        return;
      // Pause before entering the exclusive queue, so the competing operation
      // can commit after the HTTP handler's reads and before its transaction.
      beforeMutation = undefined;
      reached.open();
      await release.wait();
    };
    t.after(release.open);
    return { reached, release };
  }
  async function createVault(name = "First", extra: Row = {}) {
    const result = await f.request("/api/vault", {
      platform_name: name,
      account_email: address,
      email_source: "cf_domain",
      ...extra,
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
    return result.data.data.id as number;
  }
  async function snapshot() {
    return Promise.all(
      (
        [
          "temp_mailboxes",
          "platform_vault",
          "cf_inbox_mails",
          "mail_object_gc",
        ] as const
      ).map((table) =>
        store.select(table, {
          order: [[table === "mail_object_gc" ? "key" : "id", "asc"]],
        }),
      ),
    );
  }
  return {
    ...f,
    store,
    coordinator,
    id,
    pauseMailboxWrite,
    createVault,
    snapshot,
  };
}

for (const operation of ["delete", "cancel permanent"] as const) {
  test(
    `${operation} rejects a CF registration committed after the unbound check without touching mail or GC`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t, operation === "cancel permanent" ? 1 : 0);
      const { reached, release } = f.pauseMailboxWrite();
      const pending =
        operation === "delete"
          ? f.request(`/api/mailboxes/${f.id}`, undefined, "DELETE")
          : f.request(`/api/mailboxes/${f.id}/toggle-permanent`, {});
      try {
        await reached.wait();
        await f.createVault();
        const before = await f.snapshot();
        assert.equal(before[0][0].is_permanent, 1);
        assert.ok(before[2].every((mail) => mail.is_protected === 1));
        release.open();
        const result = await pending;
        assert.deepEqual(
          await f.snapshot(),
          before,
          "a newly protected mailbox, its messages and raw-object GC must remain unchanged",
        );
        assert.equal(result.response.status, 409, JSON.stringify(result.data));
        assert.equal(result.data.error, "STALE_PREVIEW");
      } finally {
        release.open();
        await pending;
      }
    },
  );
}

for (const change of ["delete", "email", "source", "platform"] as const) {
  test(
    `manual linking rejects a target whose ${change} changed after validation`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t);
      await f.createVault();
      const target = await f.createVault("Selected");
      const { reached, release } = f.pauseMailboxWrite();
      const pending = f.request(`/api/mailboxes/${f.id}/link-vault`, {
        vault_id: target,
      });
      try {
        await reached.wait();
        const changed =
          change === "delete"
            ? await f.request(`/api/vault/${target}`, undefined, "DELETE")
            : await f.request(
                `/api/vault/${target}`,
                change === "email"
                  ? { account_email: "moved@example.test" }
                  : change === "source"
                    ? { email_source: "external" }
                    : { platform_name: "Renamed" },
                "PUT",
              );
        assert.equal(
          changed.response.status,
          200,
          JSON.stringify(changed.data),
        );
        const before = await f.snapshot();
        release.open();
        const result = await pending;
        assert.deepEqual(
          await f.snapshot(),
          before,
          "a stale link must not overwrite the committed representative or protection",
        );
        assert.equal(result.response.status, 409, JSON.stringify(result.data));
        assert.equal(result.data.error, "STALE_PREVIEW");
      } finally {
        release.open();
        await pending;
      }
    },
  );
}

test(
  "two cancellations that read the same permanent state cannot both commit",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, 1);
    const { reached, release } = f.pauseMailboxWrite();
    const pending = f.request(`/api/mailboxes/${f.id}/toggle-permanent`, {});
    try {
      await reached.wait();
      const winner = await f.request(
        `/api/mailboxes/${f.id}/toggle-permanent`,
        {},
      );
      assert.equal(winner.response.status, 200, JSON.stringify(winner.data));
      const before = await f.snapshot();
      release.open();
      const stale = await pending;
      assert.equal(stale.response.status, 409, JSON.stringify(stale.data));
      assert.equal(stale.data.error, "STALE_PREVIEW");
      assert.deepEqual(await f.snapshot(), before);
    } finally {
      release.open();
      await pending;
    }
  },
);

for (const operation of ["delete", "toggle-permanent", "link-vault"] as const) {
  test(
    `${operation} rejects a mailbox removed after validation`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t, operation === "toggle-permanent" ? 1 : 0);
      const target = operation === "link-vault" ? await f.createVault() : 0;
      const { reached, release } = f.pauseMailboxWrite();
      const pending =
        operation === "delete"
          ? f.request(`/api/mailboxes/${f.id}`, undefined, "DELETE")
          : f.request(`/api/mailboxes/${f.id}/${operation}`, {
              vault_id: target,
            });
      try {
        await reached.wait();
        await f.coordinator.mutate([remove("temp_mailboxes", eq("id", f.id))]);
        const before = await f.snapshot();
        release.open();
        const result = await pending;
        assert.deepEqual(await f.snapshot(), before);
        assert.equal(result.response.status, 409, JSON.stringify(result.data));
        assert.equal(result.data.error, "STALE_PREVIEW");
      } finally {
        release.open();
        await pending;
      }
    },
  );
}

test("unbound toggles and deletion retain tombstone, pin and source semantics", async (t) => {
  const f = await fixture(t);
  const external = await f.createVault("Same address, other source", {
    email_source: "external",
  });
  await f.createVault("Other address", { account_email: "other@example.test" });
  for (const permanent of [1, 0]) {
    const result = await f.request(
      `/api/mailboxes/${f.id}/toggle-permanent`,
      {},
    );
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
    assert.equal(
      (await f.store.first("temp_mailboxes", eq("id", f.id)))?.is_permanent,
      permanent,
    );
    assert.ok(
      (
        await f.store.select("cf_inbox_mails", {
          where: eq("recipient", address),
        })
      ).every((mail) => mail.is_protected === permanent),
    );
  }
  const deleted = await f.request(
    `/api/mailboxes/${f.id}`,
    undefined,
    "DELETE",
  );
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.data));
  const box = await f.store.first("temp_mailboxes", eq("id", f.id));
  assert.equal(box?.expires_at, "1970-01-01T00:00:00.000Z");
  assert.equal(box?.is_permanent, 0);
  const mails = await f.store.select("cf_inbox_mails");
  assert.equal(mails.length, 1);
  assert.equal(mails[0].is_pinned, 1);
  assert.deepEqual(
    (await f.store.select("mail_object_gc")).map((row) => row.key),
    ["mail/relations-unpinned.eml"],
  );
  assert.ok(await f.store.first("platform_vault", eq("id", external)));
  assert.equal(
    (
      await f.request(`/api/mailboxes/${f.id}/link-vault`, {
        vault_id: external,
      })
    ).response.status,
    400,
  );
  assert.equal(
    (await f.request("/api/mailboxes/999999", undefined, "DELETE")).response
      .status,
    404,
  );
});

test("bindMailbox keeps a valid manual representative on ordinary import edits and falls back only when it leaves", async (t) => {
  const f = await fixture(t);
  const first = await f.createVault();
  const selected = await f.createVault("Selected");
  const link = await f.request(`/api/mailboxes/${f.id}/link-vault`, {
    vault_id: selected,
  });
  assert.equal(link.response.status, 200, JSON.stringify(link.data));
  const edited = await f.request("/api/vault/import", {
    duplicate_mode: "update",
    accounts: [
      {
        platform_name: "First",
        account_email: address,
        email_source: "cf_domain",
        remark: "ordinary edit of another registration",
      },
    ],
  });
  assert.equal(edited.response.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.updated, 1);
  let box = await f.store.first("temp_mailboxes", eq("id", f.id));
  assert.equal(box?.associated_vault_id, selected);
  assert.equal(box?.associated_platform, "Selected");
  await f.coordinator.mutate([
    update("platform_vault", eq("id", selected), { platform_name: "Renamed" }),
    { op: "bindMailbox", address },
  ]);
  box = await f.store.first("temp_mailboxes", eq("id", f.id));
  assert.equal(box?.associated_vault_id, selected);
  assert.equal(box?.associated_platform, "Renamed");
  await f.coordinator.mutate([
    remove("platform_vault", eq("id", selected)),
    { op: "bindMailbox", address },
  ]);
  box = await f.store.first("temp_mailboxes", eq("id", f.id));
  assert.equal(box?.associated_vault_id, first);
  assert.equal(box?.associated_platform, "First");
  await f.coordinator.mutate([
    remove("platform_vault", eq("id", first)),
    { op: "bindMailbox", address },
  ]);
  box = await f.store.first("temp_mailboxes", eq("id", f.id));
  assert.equal(box?.associated_vault_id, null);
  assert.equal(box?.associated_platform, "");
  assert.equal(box?.is_permanent, 1);
  assert.ok(
    (await f.store.select("cf_inbox_mails")).every((m) => m.is_protected === 1),
  );
});

for (const reference of [
  {
    name: "alias",
    fields: {
      account_email: "login+alias@example.test",
      mailbox_address: address,
    },
  },
  { name: "detached", fields: { mailbox_link_state: "detached" } },
  {
    name: "detached alias",
    fields: {
      account_email: "login+alias@example.test",
      mailbox_address: address,
      mailbox_link_state: "detached",
    },
  },
]) {
  for (const operation of ["delete", "cancel permanent"] as const) {
    test(
      `${operation} rejects a concurrent ${reference.name} CF reference atomically`,
      { timeout: 20000 },
      async (t) => {
        const f = await fixture(t, operation === "cancel permanent" ? 1 : 0);
        const { reached, release } = f.pauseMailboxWrite();
        const pending =
          operation === "delete"
            ? f.request(`/api/mailboxes/${f.id}`, undefined, "DELETE")
            : f.request(`/api/mailboxes/${f.id}/toggle-permanent`, {});
        try {
          await reached.wait();
          await f.coordinator.mutate([
            insert("platform_vault", {
              platform_name: "Concurrent reference",
              account_email: address,
              email_source: "cf_domain",
              ...reference.fields,
            }),
            { op: "bindMailbox", address },
          ]);
          const before = await f.snapshot();
          release.open();
          const result = await pending;
          assert.deepEqual(await f.snapshot(), before);
          assert.equal(
            result.response.status,
            409,
            JSON.stringify(result.data),
          );
          assert.equal(result.data.error, "STALE_PREVIEW");
        } finally {
          release.open();
          await pending;
        }
      },
    );
  }
}

for (const linkState of ["auto", "detached"] as const) {
  test(`an existing ${linkState} alias blocks deletion and demotion and supports manual linking`, async (t) => {
    const f = await fixture(t, 1);
    const [vault] = await f.coordinator.mutate([
      insert("platform_vault", {
        platform_name: "Alias registration",
        account_email: "login+alias@example.test",
        mailbox_address: address.toUpperCase(),
        mailbox_link_state: linkState,
        email_source: "cf_domain",
      }),
    ]);
    const before = await f.snapshot();
    for (const result of [
      await f.request(`/api/mailboxes/${f.id}`, undefined, "DELETE"),
      await f.request(`/api/mailboxes/${f.id}/toggle-permanent`, {}),
    ])
      assert.equal(result.response.status, 400, JSON.stringify(result.data));
    assert.deepEqual(await f.snapshot(), before);
    const linked = await f.request(`/api/mailboxes/${f.id}/link-vault`, {
      vault_id: vault.lastId,
    });
    assert.equal(linked.response.status, 200, JSON.stringify(linked.data));
    assert.equal(
      (await f.store.first("temp_mailboxes", eq("id", f.id)))
        ?.associated_vault_id,
      vault.lastId,
    );
  });

  test(`bindMailbox protects the effective address of an ${linkState} alias`, async (t) => {
    const f = await fixture(t);
    const [vault] = await f.coordinator.mutate([
      insert("platform_vault", {
        platform_name: "Alias registration",
        account_email: "login+alias@example.test",
        mailbox_address: address,
        mailbox_link_state: linkState,
        email_source: "cf_domain",
      }),
      { op: "bindMailbox", address },
    ]);
    const box = await f.store.first("temp_mailboxes", eq("id", f.id));
    assert.equal(box?.associated_vault_id, vault.lastId);
    assert.equal(box?.associated_platform, "Alias registration");
    assert.equal(box?.is_permanent, 1);
    assert.equal(box?.expires_at, "");
    assert.ok(
      (await f.store.select("cf_inbox_mails")).every(
        (m) => m.is_protected === 1,
      ),
    );
  });

  test(`cleanMail retains an ${linkState} alias even when cached protection is stale, and cleans its unmapped login address`, async (t) => {
    const f = await fixture(t);
    const login = "login+alias@example.test";
    await f.coordinator.mutate([
      insert("platform_vault", {
        platform_name: "Alias registration",
        account_email: login,
        mailbox_address: address.toUpperCase(),
        mailbox_link_state: linkState,
        email_source: "cf_domain",
      }),
      insert("cf_inbox_mails", {
        recipient: login,
        subject: "Unmapped login address",
        raw_object_key: "mail/unmapped-login.eml",
      }),
    ]);
    const mails = await f.store.select("cf_inbox_mails");
    assert.ok(mails.every((mail) => mail.is_protected === 0));
    const [result] = await f.coordinator.mutate([
      { op: "cleanMail", ids: mails.map((mail) => Number(mail.id)) },
    ]);
    assert.equal(result.changes, 1);
    assert.deepEqual(
      (await f.store.select("cf_inbox_mails", { order: [["id", "asc"]] })).map(
        (mail) => mail.recipient,
      ),
      [address, address],
    );
    assert.deepEqual(
      (await f.store.select("mail_object_gc")).map((row) => row.key),
      ["mail/unmapped-login.eml"],
    );
  });
}

test("an explicit alias mapped elsewhere does not bind or protect its login address", async (t) => {
  const f = await fixture(t, 1);
  const [vault] = await f.coordinator.mutate([
    insert("platform_vault", {
      platform_name: "Mapped elsewhere",
      account_email: address,
      mailbox_address: "elsewhere@example.test",
      email_source: "cf_domain",
    }),
    { op: "bindMailbox", address },
  ]);
  assert.equal(
    (await f.store.first("temp_mailboxes", eq("id", f.id)))
      ?.associated_vault_id,
    null,
  );
  assert.equal(
    (
      await f.request(`/api/mailboxes/${f.id}/link-vault`, {
        vault_id: vault.lastId,
      })
    ).response.status,
    400,
  );
  assert.equal(
    (await f.request(`/api/mailboxes/${f.id}/toggle-permanent`, {})).response
      .status,
    200,
  );
  assert.equal(
    (await f.request(`/api/mailboxes/${f.id}`, undefined, "DELETE")).response
      .status,
    200,
  );
});
