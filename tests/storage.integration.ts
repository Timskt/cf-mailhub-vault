import test from "node:test";
import assert from "node:assert/strict";
import { serve } from "@hono/node-server";
import {
  connectSource,
  type SourceConfig,
  type ConnectorSource,
} from "../connector/adapters";
import { connectorApp } from "../connector/server";
import { HttpPort } from "../src/storage/http";
import { D1Port } from "../src/storage/d1";
import { encryptCredentialRows } from "../src/storage/secure";
import { DirectStore } from "../src/storage/engine";
import { Coordinator, type Source } from "../src/storage/coordinator";
import { MemoryControl } from "./storage-support";
import { app } from "../src/index";
import { database, ACCOUNT } from "./helpers";
import {
  digest,
  and,
  eq,
  ne,
  oneOf,
  search,
  insert,
  update,
  remove,
  canonical,
  defaults,
  tables,
  rowKey,
  type DataPort,
  type Row,
} from "../src/storage/model";
const configs: SourceConfig[] = [
  {
    id: "mysql-a",
    name: "MySQL A",
    kind: "mysql",
    url: "mysql://root:mailhub-test-only@127.0.0.1:33077/mailhub_test",
  },
  {
    id: "mongodb-a",
    name: "MongoDB A",
    kind: "mongodb",
    url: "mongodb://127.0.0.1:27077/mailhub_test?replicaSet=rs0&directConnection=true",
  },
  {
    id: "redis-a",
    name: "Redis server A",
    kind: "redis",
    url: "redis://127.0.0.1:6387",
    prefix: "mailhub-integration",
  },
  {
    id: "redis-b",
    name: "Redis server B",
    kind: "redis",
    url: "redis://127.0.0.1:6388",
    prefix: "mailhub-integration",
  },
];
const token = "local-integration-connector-token-32-characters";
test(
  "independent platforms rename, merge and preserve account credentials on every remote database",
  { timeout: 60000 },
  async () => {
    for (const config of configs) {
      const source = await connectSource(config);
      try {
        const port = source.port(crypto.randomUUID(), crypto.randomUUID());
        await port.initialize({ version: 0, hash: "", counters: {} });
        const store = new DirectStore(port);
        await store.mutate([
          {
            op: "platform",
            action: "create",
            source: "Empty",
            definition: { name_key: "empty", name: "Empty", remark: "keep" },
          },
          insert("platform_vault", {
            platform_name: "Source",
            account_email: "demo@example.test",
            password: "preserved",
          }),
        ]);
        await store.mutate([
          {
            op: "platform",
            action: "update",
            source: "source",
            definition: { name_key: "renamed", name: "Renamed" },
          },
        ]);
        await assert.rejects(
          store.mutate([
            { op: "platform", action: "delete", source: "renamed" },
          ]),
          /仍有账号/,
        );
        await store.mutate([
          {
            op: "platform",
            action: "merge",
            source: "Renamed",
            target: "Empty",
          },
        ]);
        assert.equal(await store.count("platforms"), 1, config.id);
        assert.equal(
          (await store.first("platforms"))?.remark,
          "keep",
          config.id,
        );
        const account = await store.first("platform_vault");
        assert.equal(account?.platform_name, "Empty", config.id);
        assert.equal(account?.password, "preserved", config.id);
        await assert.rejects(
          store.mutate([
            {
              op: "assertAbsent",
              table: "platform_vault",
              where: { field: "platform_name", op: "ieq", value: "EMPTY" },
            },
            insert("platform_vault", {
              platform_name: "Empty",
              account_email: "demo@example.test",
            }),
          ]),
          /已变化/,
        );
        assert.equal(await store.count("platform_vault"), 1, config.id);
      } finally {
        await source.close();
      }
    }
  },
);
test(
  "portable mail workflow fields and rules work on old MySQL, MongoDB and Redis datasets",
  { timeout: 60000 },
  async () => {
    const fixture = await database();
    try {
      for (const config of configs) {
        const source = await connectSource(config);
        try {
          const port = source.port(crypto.randomUUID(), crypto.randomUUID());
          await port.initialize({ version: 0, hash: "", counters: {} });
          const old = {
            ...defaults("cf_inbox_mails"),
            id: 1,
            recipient: "legacy@example.test",
            subject: "Old content",
          };
          delete old.category;
          delete old.is_archived;
          delete old.rule_name;
          await port.copy("cf_inbox_mails", [old]);
          assert.equal(
            await port.count("cf_inbox_mails", eq("is_archived", 0)),
            1,
            config.id,
          );
          assert.equal(
            (
              await port.find("cf_inbox_mails", {
                where: eq("category", "general"),
                columns: ["category", "is_archived"],
              })
            )[0].is_archived,
            0,
            config.id,
          );
          assert.deepEqual((await port.page("cf_inbox_mails")).rows, [old]);
          const store = new DirectStore(port);
          await store.mutate([
            insert("mail_rules", {
              name: "Receipt workflow",
              domain: "example.test",
              archive: 1,
            }),
            update("cf_inbox_mails", eq("id", 1), {
              is_archived: 1,
              category: "billing",
              rule_name: "Receipt workflow",
            }),
          ]);
          const target = new D1Port(fixture.DB, crypto.randomUUID());
          await target.initialize(await port.info());
          for (const table of ["mail_rules", "cf_inbox_mails"] as const) {
            const rows = (await port.page(table)).rows;
            await target.copy(table, rows);
            assert.deepEqual((await target.page(table)).rows, rows);
          }
          assert.equal(
            await target.count("cf_inbox_mails", eq("is_archived", 1)),
            1,
          );
        } finally {
          await source.close();
        }
      }
    } finally {
      await fixture.dispose();
    }
  },
);
async function all(port: DataPort) {
  const result: Record<string, Row[]> = {};
  for (const table of tables) {
    const rows: Row[] = [];
    let cursor: string | null = null;
    do {
      const page = await port.page(table, cursor);
      rows.push(...page.rows);
      cursor = page.cursor;
    } while (cursor);
    result[table] = rows;
  }
  return result;
}
test(
  "real MySQL, MongoDB, Redis adapters obey one portable query and atomic revision contract over HTTP",
  { timeout: 120000 },
  async (t) => {
    const sources: ConnectorSource[] = [];
    let server: ReturnType<typeof serve> | undefined;
    try {
      for (const config of configs) sources.push(await connectSource(config));
      const app = connectorApp(sources, token);
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
      await new Promise<void>((resolve) => server!.once("listening", resolve));
      const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const unauthorized = await fetch(`${endpoint}/v1/sources`);
      assert.equal(unauthorized.status, 401);
      for (const config of configs)
        await t.test(config.kind + ": " + config.id, async () => {
          const port = new HttpPort(
            { endpoint, source: config.id, token },
            crypto.randomUUID(),
            crypto.randomUUID(),
          );
          await port.initialize({ version: 0, hash: "", counters: {} });
          const store = new DirectStore(port);
          await store.mutate([
            insert("groups", { id: 1, name: "默认分组" }),
            insert("accounts", { ...ACCOUNT, group_id: 1 }),
            insert("temp_mailboxes", {
              address: "hello@example.test",
              associated_vault_id: null,
            }),
            {
              op: "insert",
              table: "platform_vault",
              rows: [
                {
                  platform_name: "Alpha_100%",
                  account_email: "hello@example.test",
                  password: "null",
                  totp_secret: "🔑中文",
                  created_at: "2024-01-01 00:00:00",
                },
                {
                  platform_name: "Beta",
                  account_email: "b@example.test",
                  created_at: "2026-01-01T00:00:00.000Z",
                  status: "banned",
                },
                { platform_name: "gamma", account_email: "g@example.net" },
              ],
            },
          ]);
          assert.equal(
            (
              await store.select("platform_vault", {
                where: search("_100%", "platform_name"),
              })
            )[0].password,
            "null",
          );
          assert.equal(
            (
              await store.select("platform_vault", {
                where: {
                  field: "platform_name",
                  op: "ieq",
                  value: "ALPHA_100%",
                },
              })
            )[0].totp_secret,
            "🔑中文",
          );
          assert.equal(
            await store.count("platform_vault", {
              field: "account_email",
              op: "ends",
              value: "@example.test",
            }),
            2,
          );
          assert.equal(
            await store.count(
              "platform_vault",
              and(oneOf("id", [1, 2]), ne("status", "banned")),
            ),
            1,
          );
          assert.equal(
            await store.count("platform_vault", {
              field: "created_at",
              op: "dateLt",
              value: "2025-01-01T00:00:00Z",
            }),
            1,
          );
          assert.equal(
            (
              await store.select("platform_vault", {
                order: [["id", "desc"]],
                offset: 1,
                limit: 1,
                columns: ["id", "platform_name"],
              })
            )[0].id,
            2,
          );
          assert.equal(
            await store.count(
              "temp_mailboxes",
              eq("associated_vault_id", null),
            ),
            1,
          );
          const before = await port.info();
          const change = {
            table: "settings" as const,
            key: '["idempotent"]',
            row: {
              key: "idempotent",
              value: "yes",
              created_at: "now",
              updated_at: "now",
            },
          };
          const payload = {
            expected: before.version,
            version: before.version + 1,
            counters: before.counters,
            changes: [change],
          };
          const commit = { ...payload, hash: await digest(payload) };
          await port.commit(commit);
          await port.commit(commit);
          assert.equal((await port.info()).version, commit.version);
          await assert.rejects(
            port.commit({
              ...commit,
              hash: "b".repeat(64),
              changes: [{ ...change, row: { ...change.row, value: "wrong" } }],
            }),
          );
          assert.equal(
            (await store.first("settings", eq("key", "idempotent")))!.value,
            "yes",
          );
          const intruder = new HttpPort(
            { endpoint, source: config.id, token },
            port.generation,
            crypto.randomUUID(),
          );
          await assert.rejects(intruder.info());
          await assert.rejects(intruder.copy("settings", [change.row]));
          await store.mutate([remove("platform_vault", eq("id", 3))]);
          const [next] = await store.mutate([
            insert("platform_vault", {
              platform_name: "Next",
              account_email: "next@example.test",
            }),
          ]);
          assert.equal(next.lastId, 4);
          const rows = await all(port);
          assert.equal(rows.accounts[0].refresh_token, ACCOUNT.refresh_token);
        });
      await t.test(
        "D1 → MySQL → MongoDB → Redis server A → Redis server B → D1 with concurrent changes",
        async () => {
          const fixture = await database();
          try {
            const memory = new MemoryControl(),
              initial: Source = {
                id: "d1",
                kind: "d1",
                name: "D1",
                created: "test",
              };
            const factory = async (
              source: Source,
              generation: string,
              owner: string,
            ) =>
              source.kind === "d1"
                ? new D1Port(fixture.DB, generation)
                : new HttpPort(
                    { endpoint, source: source.id, token },
                    generation,
                    owner,
                  );
            let coordinator = new Coordinator(memory, factory, initial);
            for (const config of configs)
              await coordinator.addSource({
                id: config.id,
                name: config.name,
                kind: config.kind,
                endpoint,
                source: config.id,
                secret: "masked-test",
                created: "test",
              });
            const providerRows = await encryptCredentialRows(
              "provider_accounts",
              [
                {
                  ...defaults("provider_accounts"),
                  id: 1,
                  provider: "mailtm",
                  address: "owned@provider.test",
                  password: "fictional-migrating-password",
                  token: "fictional-migrating-token",
                  credential_version: "v1",
                },
              ],
              "fictional-migration-encryption-key-32-characters",
            );
            await coordinator.mutate([
              insert("provider_accounts", providerRows[0]),
              insert("accounts", { ...ACCOUNT }),
              insert("tags", { name: "生产", color: "#336699" }),
              insert("account_tags", { account_id: 1, tag_id: 1 }),
              insert("domains", { domain: "example.test" }),
              insert("settings", {
                key: "session_secret",
                value: "session-survives-migration",
              }),
              insert("cf_inbox_mails", {
                recipient: "hello@example.test",
                sender: "auth@example.test",
                text_content: "code 123456",
                is_protected: 1,
              }),
              {
                op: "insert",
                table: "platform_vault",
                rows: Array.from({ length: 105 }, (_, i) => ({
                  platform_name: `测试 ${i}`,
                  account_email: `p${i}@example.test`,
                  password: `password-${i}`,
                  totp_secret: '中文 " <script>',
                })),
              },
            ]);
            for (const target of [...configs.map((c) => c.id), "d1"]) {
              const previous = (await coordinator.status()).active;
              const previousConfig = (await coordinator.status()).sources.find(
                (s) => s.id === previous.sourceId,
              )!;
              await coordinator.start(target);
              await coordinator.step();
              await coordinator.mutate([
                insert("platform_vault", {
                  platform_name: `Added during ${target}`,
                  account_email: `${target}@example.test`,
                }),
                update("accounts", eq("id", 1), {
                  refresh_token: `rotated-${target}`,
                }),
                remove("platform_vault", eq("id", 1)),
                update("settings", eq("key", "session_secret"), {
                  value: `session-${target}`,
                }),
              ]);
              coordinator = new Coordinator(memory, factory, initial);
              let finished = false;
              for (let i = 0; i < 200; i++) {
                const status = await coordinator.status();
                assert.equal(status.job?.paused, false, status.job?.error);
                if (status.job?.phase === "complete") {
                  finished = true;
                  break;
                }
                await coordinator.step();
              }
              assert.ok(finished, target);
              const provider = (
                await coordinator.find("provider_accounts", {
                  where: eq("id", 1),
                })
              )[0];
              assert.equal(provider.password, providerRows[0].password);
              assert.equal(provider.token, providerRows[0].token);
              assert.match(String(provider.password), /^enc:v1:/);

              const state = await memory.get<any>("state"),
                source = await factory(
                  previousConfig,
                  previous.generation,
                  state.owner,
                ),
                active = await factory(
                  state.sources.find((s: Source) => s.id === target),
                  state.active.generation,
                  state.owner,
                );
              assert.equal(
                canonical(await all(source)),
                canonical(await all(active)),
                target,
              );
              assert.equal(
                canonical(await source.info()),
                canonical(await active.info()),
                target,
              );
              assert.equal(
                (await coordinator.security()).session_secret,
                `session-${target}`,
              );
              assert.equal(
                (await coordinator.find("accounts", { where: eq("id", 1) }))[0]
                  .refresh_token,
                `rotated-${target}`,
              );
            }
            // Exercise actual app routes against the active remote backend, not just the adapter protocol.
            for (const config of configs.slice(0, 3)) {
              await coordinator.start(config.id);
              for (
                let i = 0;
                i < 200 &&
                (await coordinator.status()).job?.phase !== "complete";
                i++
              )
                await coordinator.step();
              fixture.env.STORAGE = {
                idFromName: () => "test-workspace",
                get: () => ({
                  fetch: async (input: string, init: RequestInit) => {
                    const body = JSON.parse(String(init.body)),
                      path = new URL(input).pathname;
                    const data =
                      path === "/data/find"
                        ? await coordinator.find(body.table, body.query)
                        : path === "/data/count"
                          ? await coordinator.count(body.table, body.where)
                          : path === "/data/mutate"
                            ? await coordinator.mutate(body.mutations)
                            : path === "/auth/settings"
                              ? await coordinator.security()
                              : await coordinator.status();
                    return Response.json({ data });
                  },
                }),
              } as unknown as DurableObjectNamespace;
              const imported = await fixture.request(
                "/api/outlook/batch-import",
                {
                  accounts: [
                    { ...ACCOUNT, email: `api-${config.id}@outlook.com` },
                  ],
                  sync_to_vault: false,
                },
              );
              assert.equal(imported.response.status, 200);
              assert.equal(imported.data.created, 1);
              const listing = await fixture.request(
                `/api/outlook/accounts?q=api-${config.id}`,
              );
              assert.equal(listing.data.total, 1);
              assert.ok(
                !JSON.stringify(listing.data).includes(ACCOUNT.refresh_token),
              );
              const id = listing.data.data[0].id;
              const registered = await fixture.request(
                "/api/external/register",
                {
                  platform_name: "API atomic registration",
                  domain: "example.test",
                  prefix: `atomic-${config.id}`,
                },
              );
              assert.equal(registered.response.status, 200, config.id);
              const registrationId = registered.data.data.id;
              const registeredBox = (
                await fixture.request(`/api/mailboxes?q=atomic-${config.id}`)
              ).data.data[0];
              assert.equal(
                registeredBox.associated_vault_id,
                registrationId,
                config.id,
              );
              assert.equal(registeredBox.is_permanent, 1, config.id);
              const organized = await fixture.request("/api/vault/batch", {
                ids: [registrationId],
                patch: { status: "pending", is_pinned: true },
              });
              assert.equal(organized.data.data.changed, 1, config.id);
              const diagnosis = await fixture.request(
                "/api/automation/mailbox",
                { vault_id: registrationId },
              );
              assert.equal(diagnosis.data.data.source, "cf_domain", config.id);
              assert.equal(
                diagnosis.data.data.mailbox.id,
                registeredBox.id,
                config.id,
              );
              const verification = await fixture.request(
                "/api/automation/verification/batch",
                {
                  items: [
                    { vault_id: registrationId },
                    { email: `missing-${config.id}@outlook.com` },
                  ],
                },
              );
              assert.equal(
                verification.data.data.results[0].data.outcome,
                "empty",
                config.id,
              );
              assert.equal(
                verification.data.data.results[1].error,
                "ACCOUNT_NOT_FOUND",
                config.id,
              );
              await fixture.request(
                `/api/vault/${registrationId}`,
                undefined,
                "DELETE",
              );
              const vaultIds: number[] = [];
              for (const email of [
                `api-${config.id}@outlook.com`,
                `missing-${config.id}@outlook.com`,
              ]) {
                const vault = await fixture.request("/api/vault", {
                  platform_name: "Health integration",
                  account_email: email,
                  email_source: "outlook",
                  password: "vault-health-private",
                });
                assert.equal(vault.response.status, 200, config.id);
                vaultIds.push(vault.data.data.id);
              }
              const platforms = await fixture.request(
                "/api/vault/platforms?platform=health%20integration",
              );
              assert.equal(platforms.data.data[0].count, 2, config.id);
              assert.equal(
                platforms.data.data[0].attention_count,
                1,
                config.id,
              );
              assert.equal(
                platforms.data.data[0].unchecked_count,
                1,
                config.id,
              );
              const needingConnection = await fixture.request(
                "/api/vault?platform=Health%20integration&triage=attention",
              );
              assert.equal(needingConnection.data.total, 1, config.id);
              assert.equal(
                needingConnection.data.data[0].mailbox.state,
                "missing",
                config.id,
              );
              assert.equal(
                JSON.stringify(needingConnection.data).includes(
                  "vault-health-private",
                ),
                false,
              );
              for (const vaultId of vaultIds)
                await fixture.request(
                  `/api/vault/${vaultId}`,
                  undefined,
                  "DELETE",
                );
              const group = await fixture.request("/api/outlook/groups", {
                name: `Group ${config.id}`,
                color: "#123456",
              });
              await fixture.request("/api/outlook/accounts/batch", {
                action: "move",
                ids: [id],
                group_id: group.data.data.id,
              });
              const filtered = await fixture.request(
                `/api/outlook/accounts?group_id=${group.data.data.id}`,
              );
              assert.equal(filtered.data.total, 1);
              const box = await fixture.request("/api/mailboxes/generate", {
                domain: "example.test",
                prefix: `api-${config.id}`,
                duration_minutes: 60,
              });
              assert.equal(box.response.status, 200);
              const login = await fixture.request(
                "/api/auth/login",
                { password: fixture.env.ADMIN_PASSWORD },
                "POST",
                {},
              );
              assert.equal(login.response.status, 200);
              const cookie = login.response.headers
                .get("set-cookie")!
                .split(";")[0];
              assert.equal(
                (
                  await fixture.request("/api/auth/me", undefined, "GET", {
                    Cookie: cookie,
                  })
                ).data.authenticated,
                true,
              );
              assert.equal(
                (await fixture.request("/api/settings/storage")).response
                  .status,
                401,
              );
              assert.equal(
                (await fixture.request("/api/vault?q=测试")).data.total,
                104,
              );
            }
            await coordinator.start("d1");
            for (
              let i = 0;
              i < 200 && (await coordinator.status()).job?.phase !== "complete";
              i++
            )
              await coordinator.step();
            assert.equal(await coordinator.count("platform_vault"), 109);
            assert.equal((await coordinator.status()).active.sourceId, "d1");
          } finally {
            await fixture.dispose();
          }
        },
      );
    } finally {
      if (server)
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      for (const source of sources) await source.close();
    }
  },
);
