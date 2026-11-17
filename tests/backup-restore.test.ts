import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import backups, {
  BACKUP_TABLES,
  openBackup,
  sealBackup,
  validateBackup,
  type BackupDocument,
  type LegacyBackupDocument,
  type Schema11BackupDocument,
  type Schema12BackupDocument,
} from "../src/routes/backups";
import { registrationDefaults } from "../shared/registrations";
import { createSessionToken, getSessionSecret } from "../src/auth";
import { db } from "../src/storage/client";
import type { Env } from "../src/types";
import {
  Coordinator,
  type BackupRestoreRequest,
} from "../src/storage/coordinator";
import { MemoryControl } from "./storage-support";
import { D1Port } from "../src/storage/d1";
import {
  defaults,
  digest,
  eq,
  insert,
  remove,
  update,
  StorageError,
  type Row,
} from "../src/storage/model";
import { database } from "./helpers";

async function setup() {
  const fixture = await database(),
    control = new MemoryControl();
  const factory = async (_source: unknown, generation: string) =>
    new D1Port(fixture.DB, generation);
  const initial = {
    id: "d1",
    kind: "d1" as const,
    name: "D1",
    created: "test",
  };
  const coordinator = new Coordinator(control, factory, initial);
  const business = [
    "settings",
    "groups",
    "tags",
    "accounts",
    "account_tags",
    "cf_inbox_mails",
    "mail_rules",
    "platforms",
    "platform_vault",
    "temp_emails",
    "temp_mailboxes",
    "domains",
    "provider_accounts",
  ] as const;
  const tables = Object.fromEntries(business.map((t) => [t, [] as Row[]]));
  tables.groups = [{ ...defaults("groups"), id: 1, name: "Restored" }];
  tables.platforms = [
    {
      ...defaults("platforms"),
      name_key: "recovered",
      name: "Recovered",
      url: "https://example.test/",
      category: "服务",
      remark: "平台级备注",
      is_pinned: 1,
    },
    {
      ...defaults("platforms"),
      name_key: "empty",
      name: "Empty",
      remark: "暂无账号",
    },
  ];
  tables.platform_vault = [
    {
      ...defaults("platform_vault"),
      id: 30,
      platform_name: "Recovered",
      account_email: "recover@example.test",
      email_source: "external",
      password: "enc:v1:already-encrypted",
      totp_secret: "",
    },
  ];
  const request = async (): Promise<BackupRestoreRequest> => {
    const status = await coordinator.status();
    return {
      tables,
      expected: { active: status.active, revision: status.revision },
      restore_id: "a".repeat(64),
      backup_hash: await digest(tables),
    };
  };
  return {
    ...fixture,
    control,
    factory,
    initial,
    coordinator,
    request,
    tables,
  };
}

test("restore uses isolated D1, preserves control records, counters and exactly-once result across coordinator restart", async () => {
  const f = await setup();
  try {
    await f.coordinator.mutate([
      insert("settings", { key: "session_secret", value: "must-survive" }),
      insert("settings", { key: "default_prefix", value: "old-prefix" }),
      insert("idempotency_requests", {
        id: "restore-reservation",
        actor: "session:test",
        state: "in_progress",
        expires_at: "2000-01-01T00:00:00Z",
      }),
      insert("audit_logs", { action: "before.restore" }),
      insert("api_keys", {
        id: "key-id",
        key_hash: "hashed-only",
        prefix: "mhk_test",
        name: "Keep",
        expires_at: "2099-01-01T00:00:00Z",
      }),
      insert("webhooks", {
        name: "Keep webhook",
        url: "enc:v1:existing-ciphertext",
        secret: "enc:v1:existing-secret",
      }),
    ]);
    const input = await f.request();
    const result = await f.coordinator.restoreBackup(input);
    assert.equal(result.active.sourceId, "d1");
    assert.notEqual(result.active.generation, "legacy");
    assert.equal(
      (await f.coordinator.find("platform_vault"))[0].platform_name,
      "Recovered",
    );
    assert.deepEqual(
      await f.coordinator.find("platforms", { order: [["name_key", "asc"]] }),
      [...f.tables.platforms].sort((a, b) =>
        String(a.name_key).localeCompare(String(b.name_key)),
      ),
    );
    assert.equal(
      (
        await f.coordinator.find("settings", {
          where: eq("key", "session_secret"),
        })
      )[0].value,
      "must-survive",
    );
    assert.equal(await f.coordinator.count("idempotency_requests"), 1);
    assert.equal(await f.coordinator.count("api_keys"), 1);
    assert.equal(await f.coordinator.count("audit_logs"), 1);
    assert.equal(
      (await f.coordinator.find("webhooks"))[0].secret,
      "enc:v1:existing-secret",
    );
    assert.equal(
      await f.coordinator.count("settings", eq("key", "default_prefix")),
      0,
    );
    assert.equal((await new D1Port(f.DB).find("platform_vault")).length, 0);
    const restarted = new Coordinator(f.control, f.factory, f.initial);
    assert.deepEqual(await restarted.restoreBackup(input), result);
    const [next] = await restarted.mutate([
      insert("platform_vault", {
        platform_name: "Next",
        account_email: "next@example.test",
      }),
    ]);
    assert.equal(next.lastId, 31);
    await assert.rejects(
      restarted.restoreBackup({ ...input, backup_hash: "b".repeat(64) }),
      (e: any) => e.code === "RESTORE_ID_CONFLICT",
    );
  } finally {
    await f.dispose();
  }
});

test("restore refuses stale revision, active migration, nonbusiness uploads and verification mismatch without changing source", async () => {
  const f = await setup();
  try {
    const stale = await f.request();
    await f.coordinator.mutate([
      insert("settings", { key: "unrelated", value: "changed" }),
    ]);
    await assert.rejects(
      f.coordinator.restoreBackup(stale),
      (e: any) => e.code === "BACKUP_CHANGED",
    );
    const valid = await f.request();
    await assert.rejects(
      f.coordinator.restoreBackup({
        ...valid,
        tables: { ...valid.tables, api_keys: [] },
      }),
      (e: any) => e.status === 400,
    );
    await assert.rejects(
      f.coordinator.restoreBackup({
        ...valid,
        tables: {
          ...valid.tables,
          settings: [{ key: "admin_password", value: "injected" }],
        },
      }),
      (e: any) => e.status === 400,
    );
    const corrupt = new Coordinator(
      f.control,
      async (_source, generation) => {
        const port = new D1Port(f.DB, generation),
          copy = port.copy.bind(port);
        if (generation !== "legacy")
          port.copy = (table, rows) =>
            copy(
              table,
              table === "platform_vault"
                ? rows.map((r) => ({ ...r, platform_name: "corrupted" }))
                : rows,
            );
        return port;
      },
      f.initial,
    );
    await assert.rejects(
      corrupt.restoreBackup(valid),
      (e: any) => e.code === "RESTORE_VERIFY_FAILED",
    );
    assert.equal((await f.coordinator.status()).active.generation, "legacy");
    await f.coordinator.addSource({
      id: "other",
      kind: "d1",
      name: "Other",
      created: "test",
    });
    await f.coordinator.start("other");
    await assert.rejects(
      f.coordinator.restoreBackup(await f.request()),
      (e: any) => e.code === "BACKUP_BUSY",
    );
  } finally {
    await f.dispose();
  }
});

test("loss of final acknowledgement atomically preserves both cutover and restore receipt", async () => {
  const f = await setup();
  try {
    const input = await f.request();
    const original = f.control.atomic.bind(f.control);
    f.control.atomic = async (entries, remove) => {
      await original(entries, remove);
      if (Object.keys(entries).some((k) => k.startsWith("restore:")))
        throw new Error("acknowledgement lost");
    };
    await assert.rejects(
      f.coordinator.restoreBackup(input),
      /acknowledgement lost/,
    );
    f.control.atomic = original;
    const restarted = new Coordinator(f.control, f.factory, f.initial);
    const recovered = await restarted.restoreBackup(input);
    assert.deepEqual((await restarted.status()).active, recovered.active);
    assert.equal(await restarted.count("platform_vault"), 1);
  } finally {
    await f.dispose();
  }
});

test("preserved push and OAuth state cannot be rebound to missing or different business identities", async () => {
  const f = await setup();
  try {
    const [account] = await f.coordinator.mutate([
      insert("accounts", {
        email: "original@outlook.com",
        refresh_token: "token",
        client_id: "client",
      }),
    ]);
    await f.coordinator.mutate([
      insert("push_state", { account_id: account.lastId }),
      insert("oauth_sessions", {
        state_hash: "oauth-state",
        verifier: "existing-ciphertext",
        group_id: 1,
        expires_at: Math.floor(Date.now() / 1000) + 600,
      }),
    ]);
    const request = await f.request();
    await assert.rejects(
      f.coordinator.restoreBackup(request),
      (e: any) => e.code === "BACKUP_CONTROL_REFERENCE_CONFLICT",
    );
    f.tables.accounts = [
      { ...account.rows[0], email: "different@outlook.com" },
    ];
    await assert.rejects(
      f.coordinator.restoreBackup(await f.request()),
      (e: any) => e.code === "BACKUP_CONTROL_REFERENCE_CONFLICT",
    );
    f.tables.accounts = account.rows;
    await assert.rejects(
      f.coordinator.restoreBackup(await f.request()),
      (e: any) => e.code === "BACKUP_CONTROL_REFERENCE_CONFLICT",
    );
    assert.equal((await f.coordinator.status()).active.generation, "legacy");
    f.tables.groups = await f.coordinator.find("groups");
    await f.coordinator.restoreBackup(await f.request());
    assert.equal(await f.coordinator.count("push_state"), 1);
    assert.equal(
      (await f.coordinator.find("oauth_sessions"))[0].verifier,
      "existing-ciphertext",
    );
  } finally {
    await f.dispose();
  }
});

test("restore rejects objects already claimed for deletion and permits pending markers to survive a verified cutover", async () => {
  const f = await setup();
  try {
    const key = `mail/${crypto.randomUUID()}/raw.eml`;
    f.tables.cf_inbox_mails = [
      {
        ...defaults("cf_inbox_mails"),
        id: 1,
        recipient: "mail@example.test",
        sender: "sender@example.test",
        raw_object_key: key,
      },
    ];
    await f.coordinator.mutate([
      insert("mail_object_gc", { key, state: "deleting" }),
    ]);
    await assert.rejects(
      f.coordinator.restoreBackup(await f.request()),
      (e: any) =>
        ["BACKUP_EXTERNAL_MISSING", "OBJECT_GC_CONFLICT"].includes(e.code),
    );
    assert.equal((await f.coordinator.status()).active.generation, "legacy");
    await f.coordinator.mutate([
      update("mail_object_gc", eq("key", key), { state: "pending" }),
    ]);
    await f.coordinator.restoreBackup(await f.request());
    assert.equal(
      (await f.coordinator.find("mail_object_gc"))[0].state,
      "pending",
    );
    const [claimed] = await f.coordinator.mutate([
      { op: "claimMailObject", key, time: Date.now() },
    ]);
    assert.equal(claimed.changes, 0);
    assert.equal(await f.coordinator.count("mail_object_gc"), 0);
  } finally {
    await f.dispose();
  }
});

const backupApp = new Hono<{ Bindings: Env }>();
backupApp.onError((e, c) =>
  c.json(
    {
      success: false,
      error: e instanceof StorageError ? e.code : "INVALID_REQUEST",
      message: e.message,
    },
    (e instanceof StorageError || e instanceof HTTPException
      ? e.status
      : 500) as 400,
  ),
);
backupApp.route("/api/backups", backups);
const PASSPHRASE = "test-only-portable-backup-passphrase";

async function httpFixture() {
  const f = await setup();
  let intercepted: BackupRestoreRequest | undefined;
  const env: Env = {
    ...f.env,
    CREDENTIAL_ENCRYPTION_KEY: "test-only-credential-key-32-or-longer",
  };
  env.STORAGE = {
    idFromName: () => "test",
    get: () => ({
      fetch: async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)),
          path = new URL(url).pathname;
        try {
          let data;
          if (path === "/auth/settings") data = await f.coordinator.security();
          else if (path === "/status") data = await f.coordinator.status();
          else if (path === "/data/find")
            data = await f.coordinator.find(body.table, body.query);
          else if (path === "/data/count")
            data = await f.coordinator.count(body.table, body.where);
          else if (path === "/data/mutate")
            data = await f.coordinator.mutate(body.mutations);
          else if (path === "/backup/restore") {
            intercepted = structuredClone(body);
            data = await f.coordinator.restoreBackup(body);
          } else throw new Error(`unexpected internal path ${path}`);
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
  const cookie = `mailhub_session=${await createSessionToken("admin", await getSessionSecret(env))}`;
  const request = async (
    path: string,
    body?: unknown,
    key?: string,
    override: Partial<Env> = {},
    session = cookie,
  ) => {
    const response = await backupApp.request(
      `https://mailhub.test/api/backups${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Cookie: session,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { ...env, ...override },
    );
    return { response, data: (await response.json()) as any };
  };
  const exportFile = async () => {
    const r = await request("/export", {
      include_credentials: true,
      confirm: "EXPORT_CREDENTIALS",
      passphrase: PASSPHRASE,
    });
    assert.equal(r.response.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  await db(env).mutate([
    insert("platform_vault", {
      platform_name: "Saved",
      account_email: "saved@example.test",
      email_source: "external",
      password: "vault-plaintext",
      totp_secret: "totp-plaintext",
    }),
    insert("accounts", {
      email: "saved@outlook.com",
      client_id: "test-client",
      refresh_token: "refresh-plaintext",
      password: "outlook-plaintext",
    }),
    insert(
      "platforms",
      {
        name_key: "saved",
        name: "Saved",
        url: "https://example.test/platform",
        category: "开发工具",
        remark: "平台级说明",
        is_pinned: 1,
      },
      { conflict: "update" },
    ),
    insert("platforms", {
      name_key: "empty",
      name: "Empty",
      remark: "尚无账号的平台",
    }),
    insert("webhooks", {
      name: "Current",
      url: "https://example.test/hook",
      secret: "webhook-plaintext",
    }),
  ]);
  return { ...f, env, request, exportFile, intercepted: () => intercepted };
}

test("HTTP export-preview-restore encrypts business credentials once, preserves controls and replays across the generation switch", async () => {
  const f = await httpFixture();
  try {
    const manifest = await f.request("/manifest");
    assert.equal(manifest.data.data.schema_version, 13);
    assert.equal(manifest.data.data.tables.length, 13);
    assert.equal(manifest.data.data.restore_available, true);
    const backup = await f.exportFile();
    const document = await openBackup(backup, PASSPHRASE);
    assert.equal(
      document.tables.accounts[0].refresh_token,
      "refresh-plaintext",
    );
    assert.ok(!("refresh_token_fingerprint" in document.tables.accounts[0]));
    await db(f.env).mutate([
      update("platform_vault", eq("id", 1), {
        password: "current-plaintext",
        platform_name: "Current",
      }),
      update("platforms", eq("name_key", "saved"), {
        remark: "更新后的说明",
        is_pinned: 0,
      }),
      remove("platforms", eq("name_key", "empty")),
    ]);
    const controlBefore = (await f.coordinator.find("webhooks"))[0];
    const preview = await f.request("/preview", {
      backup,
      passphrase: PASSPHRASE,
    });
    assert.equal(preview.response.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.data.writes_performed, false);
    assert.ok(preview.data.data.confirmation_token);
    const body = {
      backup,
      passphrase: PASSPHRASE,
      confirmation_token: preview.data.data.confirmation_token,
      confirm: "RESTORE_BACKUP",
    };
    const restored = await f.request("/restore", body, "restore-business-1");
    assert.equal(restored.response.status, 200, JSON.stringify(restored.data));
    assert.notEqual(restored.data.data.active.generation, "legacy");
    const intercepted = f.intercepted()!;
    assert.equal(Object.keys(intercepted.tables).length, BACKUP_TABLES.length);
    assert.ok(!JSON.stringify(intercepted).includes("refresh-plaintext"));
    assert.ok(
      String(intercepted.tables.accounts[0].refresh_token).startsWith(
        "enc:v1:",
      ),
    );
    assert.ok(intercepted.tables.accounts[0].refresh_token_fingerprint);
    assert.equal(
      (await db(f.env).first("platform_vault", eq("id", 1)))?.password,
      "vault-plaintext",
    );
    assert.equal(
      (await db(f.env).first("accounts", eq("id", 1)))?.refresh_token,
      "refresh-plaintext",
    );
    assert.deepEqual(
      await db(f.env).select("platforms", { order: [["name_key", "asc"]] }),
      document.tables.platforms,
    );
    assert.equal(document.tables.platforms.length, 2);
    assert.equal(document.tables.platforms[0].name, "Empty");
    assert.equal(document.tables.platforms[1].remark, "平台级说明");
    assert.equal(document.tables.platforms[1].is_pinned, 1);
    assert.equal(
      document.tables.platforms[1].url,
      "https://example.test/platform",
    );
    assert.deepEqual((await f.coordinator.find("webhooks"))[0], controlBefore);
    assert.ok(
      (await f.coordinator.find("idempotency_requests")).some(
        (r) => r.state === "complete",
      ),
    );
    assert.ok(
      (await f.coordinator.find("audit_logs")).some(
        (r) => r.action === "post.backup" && r.status === 200,
      ),
    );
    assert.equal(
      (await new D1Port(f.DB).find("idempotency_requests"))[0].state,
      "in_progress",
    );
    const second = await f.request("/restore", body, "restore-business-1");
    assert.equal(second.response.headers.get("Idempotency-Replayed"), "true");
    assert.deepEqual(second.data, restored.data);
    assert.deepEqual(
      (await f.coordinator.status()).active,
      restored.data.data.active,
    );
  } finally {
    await f.dispose();
  }
});

async function rehash<
  T extends
    | BackupDocument
    | LegacyBackupDocument
    | Schema11BackupDocument
    | Schema12BackupDocument,
>(document: T): Promise<T> {
  for (const [table, rows] of Object.entries(document.tables)) {
    document.manifest.table_counts[table] = rows.length;
    document.manifest.table_hashes[table] = await digest(rows);
  }
  document.manifest.data_hash = await digest(document.tables);
  return document;
}

// Captured from the released schema 10 exporter, independent of the current model.
const SCHEMA_10_HASH =
  "1d98b24a791a91074f2772ae9f11d3c94ee4b3b12f611d0a5f3be69166c2e846";
// Captured from the released schema 12 exporter before registration metadata.
const SCHEMA_12_HASH =
  "72aa98743ab083b912db09f37b2e8878b1e5a541b9ecbaf6de361dc77fd66beb";
const SCHEMA_11_HASH =
  "1b47ae4e2ed3d92d1618bc1cde4be774a20d5fb162649fb2bf61d0a893ca7d8c";
const REGISTRATION_FIELDS = Object.keys(
  registrationDefaults,
) as (keyof typeof registrationDefaults)[];

// Literal schema 12 rows must not depend on defaults() or the current exporter.
async function frozenSchema12Backup(): Promise<Schema12BackupDocument> {
  return rehash({
    manifest: {
      format: "mailhub-backup",
      version: 1,
      schema_version: 12,
      schema_hash: SCHEMA_12_HASH,
      created_at: "2024-03-01T00:00:00.000Z",
      redacted: false,
      restorable: true,
      consistency: "revision_checked",
      table_counts: {},
      table_hashes: {},
      data_hash: "",
      excluded: [
        "administrator/session secrets",
        "API keys",
        "OAuth sessions",
        "idempotency records",
        "audit logs",
        "webhook configuration and delivery queue",
        "storage connections/coordinator state",
        "Worker secrets/configuration",
        "R2 object contents",
      ],
      external_dependencies: [
        "R2 objects referenced by raw_object_key/attachment_manifest must be retained in the destination bucket",
        "Domain routing, provider access and Worker environment configuration must be configured separately",
      ],
    },
    tables: {
      settings: [],
      groups: [],
      tags: [],
      accounts: [],
      account_tags: [],
      cf_inbox_mails: [],
      mail_rules: [],
      platform_vault: [
        {
          id: 31,
          platform_name: "Historical",
          platform_url: "historical URL kept verbatim",
          account_email: "LOGIN@Example.test",
          email_source: "cf_domain",
          username: "unchanged username",
          password: "schema-12-password",
          totp_secret: null,
          status: "banned",
          category: "历史分类",
          proxy_node: "",
          remark: "manual status and note survive",
          last_code: "123456",
          last_code_at: "2024-02-29T10:00:00.000Z",
          is_pinned: 1,
          created_at: "2024-02-01T00:00:00.000Z",
          updated_at: "2024-02-29T00:00:00.000Z",
        },
      ],
      platforms: [
        {
          name_key: "historical",
          name: "Historical",
          url: "https://example.test/platform",
          category: "历史分类",
          remark: "catalog preserved",
          is_pinned: 1,
          created_at: "2024-01-01T00:00:00.000Z",
          updated_at: "2024-02-01T00:00:00.000Z",
        },
      ],
      provider_accounts: [
        {
          id: 17,
          provider: "mailtm",
          address: "provider@example.test",
          remote_id: "provider-id",
          password: "provider-password",
          token: "provider-token",
          token_expires_at: "",
          credential_version: "v1",
          status: "disabled",
          auth_status: "unchecked",
          remark: "provider note",
          last_checked_at: "",
          last_error: "",
          last_error_code: "",
          created_at: "2024-02-01T00:00:00.000Z",
          updated_at: "2024-02-02T00:00:00.000Z",
        },
      ],
      temp_emails: [],
      temp_mailboxes: [
        {
          id: 23,
          address: "login@example.test",
          prefix: "login",
          domain: "example.test",
          expires_at: "",
          is_permanent: 1,
          associated_platform: "Historical",
          associated_vault_id: 31,
          remark: "protected mailbox",
          is_pinned: 1,
          created_at: "2024-02-01T00:00:00.000Z",
          updated_at: "2024-02-29T00:00:00.000Z",
        },
      ],
      domains: [],
    },
  });
}

async function schema12Backup(
  document: BackupDocument,
): Promise<Schema12BackupDocument> {
  const copy = structuredClone(document);
  for (const row of copy.tables.platform_vault)
    for (const field of REGISTRATION_FIELDS) delete row[field];
  return rehash({
    ...copy,
    manifest: {
      ...copy.manifest,
      schema_version: 12,
      schema_hash: SCHEMA_12_HASH,
    },
  });
}

async function schema11Backup(
  document: BackupDocument,
): Promise<Schema11BackupDocument> {
  const copy = await schema12Backup(document);
  const { provider_accounts: _providers, ...tables } = copy.tables;
  delete copy.manifest.table_counts.provider_accounts;
  delete copy.manifest.table_hashes.provider_accounts;
  return rehash({
    manifest: {
      ...copy.manifest,
      schema_version: 11,
      schema_hash: SCHEMA_11_HASH,
    },
    tables,
  });
}

async function legacyBackup(
  document: BackupDocument,
): Promise<LegacyBackupDocument> {
  const copy = structuredClone(document);
  for (const row of copy.tables.platform_vault)
    for (const field of REGISTRATION_FIELDS) delete row[field];
  const {
    platforms: _platforms,
    provider_accounts: _providers,
    ...tables
  } = copy.tables;
  delete copy.manifest.table_counts.provider_accounts;
  delete copy.manifest.table_hashes.provider_accounts;
  delete copy.manifest.table_counts.platforms;
  delete copy.manifest.table_hashes.platforms;
  return rehash({
    manifest: {
      ...copy.manifest,
      schema_version: 10,
      schema_hash: SCHEMA_10_HASH,
    },
    tables,
  });
}

test("schema 10 encrypted backups validate the released schema before deterministic upgrade and preserve account-derived platforms on restore", async () => {
  const f = await httpFixture();
  try {
    await db(f.env).mutate([
      update("platform_vault", eq("id", 1), {
        platform_url: "https://example.test/legacy",
        category: "历史分类",
        remark: "账号备注保留在账号上",
      }),
      insert("platform_vault", {
        platform_name: "SAVED",
        platform_url: "https://example.test/second",
        account_email: "duplicate@example.test",
        email_source: "external",
        password: "other-account-secret",
      }),
    ]);
    const legacy = await legacyBackup(
      await openBackup(await f.exportFile(), PASSPHRASE),
    );
    const original = structuredClone(legacy);
    const converted = await validateBackup(legacy);
    assert.deepEqual(
      legacy,
      original,
      "conversion must not rewrite the uploaded document",
    );
    assert.equal(converted.manifest.schema_version, 13);
    assert.equal(Object.keys(converted.tables).length, 13);
    assert.deepEqual(
      converted.tables.platform_vault,
      legacy.tables.platform_vault.map((row) => ({
        ...registrationDefaults,
        ...row,
      })),
    );
    assert.deepEqual(converted.tables.platforms, [
      {
        name_key: "saved",
        name: "Saved",
        url: "https://example.test/legacy",
        category: "历史分类",
        remark: "",
        is_pinned: 0,
        created_at: legacy.tables.platform_vault[0].created_at,
        updated_at: legacy.tables.platform_vault[0].updated_at,
      },
    ]);
    const backup = await sealBackup(legacy, PASSPHRASE);
    assert.deepEqual(await openBackup(backup, PASSPHRASE), converted);
    assert.deepEqual(await validateBackup(legacy), converted);
    const preview = await f.request("/preview", {
      backup,
      passphrase: PASSPHRASE,
    });
    assert.equal(preview.response.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.data.table_counts.platforms, 1);
    assert.equal(preview.data.data.backup_hash, await digest(converted));
    const restored = await f.request(
      "/restore",
      {
        backup,
        passphrase: PASSPHRASE,
        confirmation_token: preview.data.data.confirmation_token,
        confirm: "RESTORE_BACKUP",
      },
      "restore-schema-10",
    );
    assert.equal(restored.response.status, 200, JSON.stringify(restored.data));
    assert.deepEqual(
      await db(f.env).select("platforms"),
      converted.tables.platforms,
    );
    assert.deepEqual(
      await db(f.env).select("platform_vault", { order: [["id", "asc"]] }),
      converted.tables.platform_vault,
    );
    assert.equal(
      await db(f.env).count("platforms", eq("name_key", "empty")),
      0,
      "the destination's unrelated catalog is replaced, not merged",
    );
  } finally {
    await f.dispose();
  }
});

test("schema 10 redacted plaintext remains preview-only and upgrades without introducing hidden account metadata", async () => {
  const f = await httpFixture();
  try {
    const legacy = await legacyBackup((await f.request("/export")).data);
    const converted = await validateBackup(legacy);
    assert.equal(converted.manifest.redacted, true);
    assert.equal(converted.manifest.restorable, false);
    assert.equal(converted.tables.platforms.length, 1);
    assert.ok(!("url" in converted.tables.platforms[0]));
    assert.ok(!("remark" in converted.tables.platforms[0]));
    const preview = await f.request("/preview", { backup: legacy });
    assert.equal(preview.response.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.data.restorable, false);
    assert.equal(preview.data.data.table_counts.platforms, 1);
    assert.equal(preview.data.data.confirmation_token, undefined);
    const unredacted = await legacyBackup(
      await openBackup(await f.exportFile(), PASSPHRASE),
    );
    assert.equal(
      (await f.request("/preview", { backup: unredacted })).response.status,
      400,
    );
    assert.equal((await f.coordinator.status()).active.generation, "legacy");
  } finally {
    await f.dispose();
  }
});

test("frozen schema 12 validates original fields and hashes before deterministic schema 13 upgrade", async () => {
  const f = await httpFixture();
  try {
    const exported = await openBackup(await f.exportFile(), PASSPHRASE);
    const legacy = await frozenSchema12Backup();
    const original = structuredClone(legacy);
    assert.equal(legacy.manifest.schema_hash, SCHEMA_12_HASH);
    assert.equal(
      REGISTRATION_FIELDS.some(
        (field: string) => field in legacy.tables.platform_vault[0],
      ),
      false,
    );

    const converted = await validateBackup(legacy);
    assert.deepEqual(legacy, original);
    assert.equal(converted.manifest.schema_version, 13);
    assert.deepEqual(
      Object.fromEntries(
        REGISTRATION_FIELDS.map((field: string) => [
          field,
          converted.tables.platform_vault[0][field],
        ]),
      ),
      registrationDefaults,
    );
    assert.equal(
      converted.tables.platform_vault[0].id,
      legacy.tables.platform_vault[0].id,
    );
    assert.equal(
      converted.tables.platform_vault[0].password,
      "schema-12-password",
    );
    assert.equal(converted.tables.platform_vault[0].status, "banned");
    assert.equal(
      converted.tables.platform_vault[0].remark,
      "manual status and note survive",
    );
    assert.deepEqual(
      converted.tables.platform_vault,
      legacy.tables.platform_vault.map((row) => ({
        ...registrationDefaults,
        ...row,
      })),
    );
    assert.deepEqual(
      converted.tables.provider_accounts,
      legacy.tables.provider_accounts,
    );
    assert.deepEqual(converted.tables.platforms, legacy.tables.platforms);
    assert.deepEqual(
      converted.tables.temp_mailboxes,
      legacy.tables.temp_mailboxes,
    );
    assert.deepEqual(await validateBackup(legacy), converted);
    const backup = await sealBackup(legacy, PASSPHRASE);
    assert.deepEqual(await openBackup(backup, PASSPHRASE), converted);

    for (const alter of [
      (d: Schema12BackupDocument) => {
        d.manifest.schema_hash = exported.manifest.schema_hash;
      },
      (d: Schema12BackupDocument) => {
        delete d.tables.platform_vault[0].totp_secret;
      },
      (d: Schema12BackupDocument) => {
        d.tables.provider_accounts[0].extra = "not-in-schema12";
      },
      ...REGISTRATION_FIELDS.map((field) => (d: Schema12BackupDocument) => {
        d.tables.platform_vault[0][field] = registrationDefaults[field];
      }),
    ]) {
      const tampered = structuredClone(legacy);
      alter(tampered);
      await rehash(tampered);
      await assert.rejects(validateBackup(tampered));
      await assert.rejects(
        openBackup(await sealBackup(tampered, PASSPHRASE), PASSPHRASE),
      );
    }

    const rowTampered = structuredClone(legacy);
    rowTampered.tables.platform_vault[0].status = "active";
    await assert.rejects(validateBackup(rowTampered), /哈希/);
    rowTampered.manifest.table_hashes.platform_vault = await digest(
      rowTampered.tables.platform_vault,
    );
    await assert.rejects(validateBackup(rowTampered), /整体哈希/);

    const preview = await f.request("/preview", {
      backup,
      passphrase: PASSPHRASE,
    });
    assert.equal(preview.response.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.data.backup_hash, await digest(converted));
    const restored = await f.request(
      "/restore",
      {
        backup,
        passphrase: PASSPHRASE,
        confirmation_token: preview.data.data.confirmation_token,
        confirm: "RESTORE_BACKUP",
      },
      "restore-frozen-schema-12",
    );
    assert.equal(restored.response.status, 200, JSON.stringify(restored.data));
    assert.deepEqual(await db(f.env).select("platform_vault"), [
      { ...converted.tables.platform_vault[0], totp_secret: "" },
    ]);
    assert.deepEqual(
      await db(f.env).select("provider_accounts"),
      legacy.tables.provider_accounts,
    );
    assert.deepEqual(
      await db(f.env).select("temp_mailboxes"),
      legacy.tables.temp_mailboxes,
    );
  } finally {
    await f.dispose();
  }
});

test("schema 11 and redacted schema 12 upgrade without requiring new fields in old projections", async () => {
  const f = await httpFixture();
  try {
    const encrypted = await openBackup(await f.exportFile(), PASSPHRASE);
    const schema11 = await schema11Backup(encrypted);
    const upgraded11 = await validateBackup(schema11);
    assert.equal(upgraded11.manifest.schema_version, 13);
    assert.deepEqual(upgraded11.tables.provider_accounts, []);
    assert.deepEqual(await validateBackup(schema11), upgraded11);
    const smuggled = structuredClone(schema11);
    smuggled.tables.platform_vault[0].workspace = "not-a-schema11-field";
    await assert.rejects(validateBackup(await rehash(smuggled)));
    const tampered = structuredClone(schema11);
    tampered.tables.platform_vault[0].status = "banned";
    await assert.rejects(validateBackup(tampered), /哈希/);
    tampered.manifest.table_hashes.platform_vault = await digest(
      tampered.tables.platform_vault,
    );
    await assert.rejects(validateBackup(tampered), /整体哈希/);
    assert.deepEqual(
      Object.fromEntries(
        REGISTRATION_FIELDS.map((field: string) => [
          field,
          upgraded11.tables.platform_vault[0][field],
        ]),
      ),
      registrationDefaults,
    );

    const currentRedacted = (await f.request("/export")).data;
    for (const project of [schema11Backup, schema12Backup]) {
      const legacyRedacted = await project(currentRedacted);
      const original = structuredClone(legacyRedacted);
      assert.equal(
        REGISTRATION_FIELDS.some(
          (field) => field in legacyRedacted.tables.platform_vault[0],
        ),
        false,
      );
      const upgradedRedacted = await validateBackup(legacyRedacted);
      assert.deepEqual(legacyRedacted, original);
      assert.equal(upgradedRedacted.manifest.schema_version, 13);
      assert.equal(upgradedRedacted.manifest.redacted, true);
      assert.equal(upgradedRedacted.manifest.restorable, false);
      assert.deepEqual(
        Object.fromEntries(
          REGISTRATION_FIELDS.map((field) => [
            field,
            upgradedRedacted.tables.platform_vault[0][field],
          ]),
        ),
        registrationDefaults,
      );
      assert.ok(!("password" in upgradedRedacted.tables.platform_vault[0]));
      assert.ok(!("totp_secret" in upgradedRedacted.tables.platform_vault[0]));
      const preview = await f.request("/preview", { backup: legacyRedacted });
      assert.equal(preview.response.status, 200, JSON.stringify(preview.data));
      assert.equal(preview.data.data.restorable, false);
      assert.equal(preview.data.data.confirmation_token, undefined);

      const addedMetadata = structuredClone(legacyRedacted);
      addedMetadata.tables.platform_vault[0].mailbox_link_state = "detached";
      await assert.rejects(validateBackup(await rehash(addedMetadata)));
    }
  } finally {
    await f.dispose();
  }
});

test("schema 13 validates and restores registration metadata, detached state and mailbox-address aliases", async () => {
  const f = await httpFixture();
  try {
    const fixedTimes = {
      registered_at: "2024-02-29T20:30:00+08:00",
      last_verified_at: "2025-03-01T08:09:10.000Z",
      expires_at: "2030-01-01T00:00:00.000Z",
    };
    await db(f.env).mutate([
      update("platform_vault", eq("id", 1), {
        email_source: "cf_domain",
        mailbox_address: "alias@example.test",
        mailbox_link_state: "auto",
        workspace: "Europe",
        account_identifier: "tenant-7",
        login_methods: '[ "password", "google", "password" ]',
        verification_sender: "auth@example.test",
        verification_keyword: "Your code",
        ...fixedTimes,
      }),
      insert("temp_mailboxes", {
        address: "alias@example.test",
        prefix: "alias",
        domain: "example.test",
        is_permanent: 1,
        associated_platform: "Saved",
        associated_vault_id: 1,
      }),
      insert("platform_vault", {
        platform_name: "Detached",
        account_email: "detached@example.test",
        email_source: "external",
        password: "detached-password",
        status: "banned",
        mailbox_link_state: "detached",
      }),
    ]);

    const backup = await f.exportFile();
    const document = await openBackup(backup, PASSPHRASE);
    assert.equal(document.manifest.schema_version, 13);
    assert.equal(document.tables.temp_mailboxes[0].associated_vault_id, 1);
    assert.equal(
      document.tables.platform_vault[0].mailbox_address,
      "alias@example.test",
    );
    assert.equal(
      document.tables.platform_vault[1].mailbox_link_state,
      "detached",
    );

    for (const [field, value] of [
      ["workspace", "x".repeat(101)],
      ["account_identifier", "x".repeat(201)],
      ["login_methods", '["unsupported"]'],
      ["login_methods", "not-json"],
      ["mailbox_address", "invalid-mailbox"],
      ["mailbox_link_state", "pending"],
      ["verification_sender", "x".repeat(255)],
      ["verification_keyword", "x".repeat(201)],
      ["registered_at", "not-a-date"],
      ["last_verified_at", "2024-02-30T00:00:00.000Z"],
      ["expires_at", "2030-01-01T00:00:00"],
      ...REGISTRATION_FIELDS.map((field) => [field, null]),
    ] as [string, Row[string]][]) {
      const invalidMetadata = structuredClone(document);
      invalidMetadata.tables.platform_vault[0][field] = value;
      await assert.rejects(
        validateBackup(await rehash(invalidMetadata)),
        field,
      );
    }

    const wrongAddress = structuredClone(document);
    wrongAddress.tables.temp_mailboxes[0].address = "saved@example.test";
    wrongAddress.tables.temp_mailboxes[0].prefix = "saved";
    await assert.rejects(
      validateBackup(await rehash(wrongAddress)),
      /地址不一致/,
    );
    wrongAddress.tables.platform_vault[0].mailbox_address = "";
    await assert.doesNotReject(validateBackup(await rehash(wrongAddress)));

    const redacted = await f.request("/export");
    assert.equal(redacted.response.status, 200);
    const redactedVault = redacted.data.tables.platform_vault[0];
    assert.equal(redactedVault.workspace, "Europe");
    assert.equal(redactedVault.mailbox_address, "alias@example.test");
    assert.equal(redactedVault.mailbox_link_state, "auto");
    assert.deepEqual(
      Object.fromEntries(
        REGISTRATION_FIELDS.map((field) => [field, redactedVault[field]]),
      ),
      Object.fromEntries(
        REGISTRATION_FIELDS.map((field) => [
          field,
          document.tables.platform_vault[0][field],
        ]),
      ),
    );
    assert.ok(!("password" in redactedVault));
    assert.ok(!("totp_secret" in redactedVault));
    assert.ok(!("last_code" in redactedVault));
    assert.ok(!("remark" in redactedVault));
    await validateBackup(redacted.data);

    const preview = await f.request("/preview", {
      backup,
      passphrase: PASSPHRASE,
    });
    assert.equal(preview.response.status, 200, JSON.stringify(preview.data));
    const restored = await f.request(
      "/restore",
      {
        backup,
        passphrase: PASSPHRASE,
        confirmation_token: preview.data.data.confirmation_token,
        confirm: "RESTORE_BACKUP",
      },
      "restore-registration-metadata",
    );
    assert.equal(restored.response.status, 200, JSON.stringify(restored.data));

    const restoredVault = await db(f.env).select("platform_vault", {
      order: [["id", "asc"]],
    });
    assert.deepEqual(restoredVault, document.tables.platform_vault);
    assert.equal(restoredVault[0].id, 1);
    assert.equal(restoredVault[0].mailbox_address, "alias@example.test");
    assert.equal(
      restoredVault[0].login_methods,
      '[ "password", "google", "password" ]',
    );
    assert.equal(restoredVault[0].registered_at, fixedTimes.registered_at);
    assert.equal(restoredVault[0].password, "vault-plaintext");
    assert.equal(restoredVault[1].mailbox_link_state, "detached");
    assert.equal(restoredVault[1].status, "banned");
    const restoredMailbox = await db(f.env).first("temp_mailboxes");
    assert.equal(restoredMailbox?.address, "alias@example.test");
    assert.equal(restoredMailbox?.associated_vault_id, 1);
  } finally {
    await f.dispose();
  }
});

test("schema 10 cannot smuggle schema 11 tables or new fields and rejects original hash tampering before conversion", async () => {
  const f = await httpFixture();
  try {
    const current = await openBackup(await f.exportFile(), PASSPHRASE);
    const legacy = await legacyBackup(current);
    for (const change of [
      (d: LegacyBackupDocument) => {
        d.manifest.schema_hash = current.manifest.schema_hash;
      },
      (d: LegacyBackupDocument) => {
        d.manifest.schema_version = 99 as 10;
      },
      (d: LegacyBackupDocument) => {
        (d.tables as any).platforms = current.tables.platforms;
      },
      (d: LegacyBackupDocument) => {
        d.tables.platform_vault[0].managed = 1;
      },
      (d: LegacyBackupDocument) => {
        d.tables.accounts[0].refresh_token_fingerprint = "not-a-legacy-field";
      },
      (d: LegacyBackupDocument) => {
        d.tables.accounts[0].group_id = 999;
      },
      (d: LegacyBackupDocument) => {
        d.tables.platform_vault[0].password = 123;
      },
    ]) {
      const altered = structuredClone(legacy);
      change(altered);
      await rehash(altered);
      await assert.rejects(validateBackup(altered));
      await assert.rejects(
        openBackup(await sealBackup(altered, PASSPHRASE), PASSPHRASE),
      );
    }
    const changed = structuredClone(legacy);
    changed.tables.platform_vault[0].platform_name = "Tampered";
    await assert.rejects(validateBackup(changed), /哈希/);
    changed.manifest.table_hashes.platform_vault = await digest(
      changed.tables.platform_vault,
    );
    await assert.rejects(validateBackup(changed), /整体哈希/);
    const disguised = structuredClone(current);
    disguised.manifest.schema_version = 10 as 13;
    disguised.manifest.schema_hash = SCHEMA_10_HASH;
    await assert.rejects(validateBackup(disguised));
    assert.equal((await f.coordinator.status()).active.generation, "legacy");
  } finally {
    await f.dispose();
  }
});

test("backup validation rejects authenticated schema, type, reference, uniqueness, hash and control injection attacks", async () => {
  const f = await httpFixture();
  try {
    const backup = await f.exportFile(),
      document = await openBackup(backup, PASSPHRASE);
    const tampered = {
      ...backup,
      ciphertext: `${backup.ciphertext[0] === "A" ? "B" : "A"}${backup.ciphertext.slice(1)}`,
    };
    await assert.rejects(openBackup(tampered, PASSPHRASE));
    await assert.rejects(
      openBackup(
        { ...backup, encryption: { ...backup.encryption, iterations: 1 } },
        PASSPHRASE,
      ),
    );
    await assert.rejects(openBackup(backup, "wrong-passphrase-1234"));
    for (const change of [
      (d: BackupDocument) => {
        d.manifest.schema_version = 7 as 13;
      },
      (d: BackupDocument) => {
        d.tables.accounts[0].id = "1";
      },
      (d: BackupDocument) => {
        d.tables.accounts[0].group_id = 999;
      },
      (d: BackupDocument) => {
        d.tables.accounts.push({
          ...d.tables.accounts[0],
          id: 50,
          email: "SAVED@outlook.com",
        });
      },
      (d: BackupDocument) => {
        d.tables.settings.push({
          ...defaults("settings"),
          key: "admin_password",
          value: "injected",
        });
      },
      (d: BackupDocument) => {
        d.tables.accounts[0].refresh_token_fingerprint = "injected";
      },
      (d: BackupDocument) => {
        d.tables.platform_vault[0].extra = "unknown";
      },
      (d: BackupDocument) => {
        d.tables.platforms[0].name_key = "wrong-name";
      },
      (d: BackupDocument) => {
        d.tables.platforms[0].is_pinned = 2;
      },
      (d: BackupDocument) => {
        d.tables.platforms[0].url = "javascript:alert(1)";
      },
      (d: BackupDocument) => {
        d.tables.platforms.push({ ...d.tables.platforms[0] });
      },
      (d: BackupDocument) => {
        (d.tables as any).api_keys = [];
      },
      (d: BackupDocument) => {
        d.tables.temp_mailboxes.push({
          ...defaults("temp_mailboxes"),
          id: 1,
          address: "mismatch@example.test",
          prefix: "mismatch",
          domain: "example.test",
          associated_vault_id: 1,
        });
      },
      (d: BackupDocument) => {
        d.tables.cf_inbox_mails.push({
          ...defaults("cf_inbox_mails"),
          id: 1,
          recipient: "test@example.test",
          sender: "sender@example.test",
          raw_object_key: "private/not-a-mail-object",
        });
      },
    ]) {
      const altered = structuredClone(document);
      change(altered);
      await rehash(altered);
      const response = await f.request("/dry-run", {
        backup: await sealBackup(altered, PASSPHRASE),
        passphrase: PASSPHRASE,
      });
      assert.equal(
        response.response.status,
        400,
        JSON.stringify(response.data),
      );
    }
    const changed = structuredClone(document);
    changed.tables.accounts[0].email = "changed@outlook.com";
    await assert.rejects(validateBackup(changed));
    const redacted = await f.request("/export");
    assert.equal(
      (await f.request("/preview", { backup: redacted.data })).data.data
        .restorable,
      false,
    );
    assert.equal(
      (await f.request("/preview", { backup: document })).response.status,
      400,
    );
    const limit = structuredClone(document);
    limit.tables.accounts[0].remark = "x".repeat(1024 * 1024);
    await assert.rejects(
      validateBackup(limit),
      (e: any) => e.code === "BACKUP_TOO_LARGE",
    );
    assert.equal((await f.coordinator.status()).active.generation, "legacy");
  } finally {
    await f.dispose();
  }
});

test("restore rejects stale previews, changed files/sessions, missing keys/objects, expired confirmation and unencrypted uploads", async () => {
  const f = await httpFixture();
  try {
    const backup = await f.exportFile();
    const preview = await f.request("/preview", {
      backup,
      passphrase: PASSPHRASE,
    });
    const body = {
      backup,
      passphrase: PASSPHRASE,
      confirmation_token: preview.data.data.confirmation_token,
      confirm: "RESTORE_BACKUP",
    };
    assert.equal((await f.request("/restore", body)).response.status, 400);
    assert.equal(
      (
        await f.request("/restore", body, "missing-key", {
          CREDENTIAL_ENCRYPTION_KEY: "",
          STORAGE_ENCRYPTION_KEY: "",
        })
      ).data.error,
      "CREDENTIAL_KEY_REQUIRED",
    );
    const raw = await f.request("/export");
    assert.equal(
      (
        await f.request(
          "/restore",
          { ...body, backup: raw.data },
          "raw-restore",
        )
      ).response.status,
      400,
    );
    const altered = await openBackup(backup, PASSPHRASE);
    altered.tables.platform_vault[0].platform_name = "Altered";
    const alternate = await sealBackup(await rehash(altered), PASSPHRASE);
    assert.equal(
      (
        await f.request(
          "/restore",
          { ...body, backup: alternate },
          "different-file",
        )
      ).data.error,
      "BACKUP_CHANGED",
    );
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + 11 * 60000;
      assert.equal(
        (await f.request("/restore", body, "expired-preview")).data.error,
        "BACKUP_PREVIEW_EXPIRED",
      );
      const otherSession = `mailhub_session=${await createSessionToken("admin", await getSessionSecret(f.env))}`;
      Date.now = originalNow;
      assert.equal(
        (await f.request("/restore", body, "other-session", {}, otherSession))
          .response.status,
        400,
      );
    } finally {
      Date.now = originalNow;
    }
    await db(f.env).mutate([
      update("platform_vault", eq("id", 1), {
        platform_name: "Concurrent change",
      }),
    ]);
    assert.equal(
      (await f.request("/restore", body, "stale-preview")).data.error,
      "BACKUP_CHANGED",
    );
    const missingObjects = await openBackup(backup, PASSPHRASE);
    missingObjects.tables.cf_inbox_mails.push({
      ...defaults("cf_inbox_mails"),
      id: 1,
      recipient: "mail@example.test",
      sender: "sender@example.test",
      raw_object_key: `mail/${crypto.randomUUID()}/raw.eml`,
    });
    const withObjects = await sealBackup(
      await rehash(missingObjects),
      PASSPHRASE,
    );
    assert.equal(
      (
        await f.request("/preview", {
          backup: withObjects,
          passphrase: PASSPHRASE,
        })
      ).data.error,
      "BACKUP_EXTERNAL_MISSING",
    );
    const newPreview = await f.request("/preview", {
      backup,
      passphrase: PASSPHRASE,
    });
    const secondBody = {
      ...body,
      confirmation_token: newPreview.data.data.confirmation_token,
    };
    await f.coordinator.addSource({
      id: "other",
      kind: "d1",
      name: "Other",
      created: "test",
    });
    await f.coordinator.start("other");
    assert.equal(
      (await f.request("/restore", secondBody, "active-sync")).data.error,
      "BACKUP_BUSY",
    );
    assert.equal((await f.coordinator.status()).active.generation, "legacy");
  } finally {
    await f.dispose();
  }
});

test("GC completing between R2 HEAD and restore cannot bypass the expected revision even after removing its marker", async () => {
  const f = await httpFixture();
  try {
    const document = await openBackup(await f.exportFile(), PASSPHRASE),
      key = `mail/${crypto.randomUUID()}/raw.eml`;
    document.tables.cf_inbox_mails.push({
      ...defaults("cf_inbox_mails"),
      id: 1,
      recipient: "mail@example.test",
      sender: "sender@example.test",
      raw_object_key: key,
    });
    const backup = await sealBackup(await rehash(document), PASSPHRASE);
    await f.coordinator.mutate([insert("mail_object_gc", { key })]);
    let race = false;
    const bucket = {
      head: async () => {
        if (race) {
          await f.coordinator.mutate([
            { op: "claimMailObject", key, time: Date.now() },
          ]);
          await f.coordinator.mutate([
            remove("mail_object_gc", eq("key", key)),
          ]);
        }
        return { key };
      },
    } as unknown as R2Bucket;
    const preview = await f.request(
      "/preview",
      { backup, passphrase: PASSPHRASE },
      undefined,
      { MAIL_OBJECTS: bucket },
    );
    assert.equal(preview.response.status, 200, JSON.stringify(preview.data));
    race = true;
    const response = await f.request(
      "/restore",
      {
        backup,
        passphrase: PASSPHRASE,
        confirmation_token: preview.data.data.confirmation_token,
        confirm: "RESTORE_BACKUP",
      },
      "gc-read-race",
      { MAIL_OBJECTS: bucket },
    );
    assert.equal(response.response.status, 409);
    assert.equal(response.data.error, "BACKUP_CHANGED");
    assert.equal(await f.coordinator.count("mail_object_gc"), 0);
    assert.equal((await f.coordinator.status()).active.generation, "legacy");
  } finally {
    await f.dispose();
  }
});

test(
  "actual Worker and SQLite Durable Object complete encrypted restore and replay after eviction",
  { timeout: 30000 },
  async () => {
    const { build } = await import("esbuild"),
      { Miniflare } = await import("miniflare"),
      { readFile, readdir } = await import("node:fs/promises");
    const bundle = await build({
      entryPoints: ["src/index.ts"],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
      external: ["cloudflare:*"],
    });
    const runtime = new Miniflare({
      workers: [
        {
          config: {
            name: "backup-runtime-test",
            compatibilityDate: "2026-11-01",
            manifest: {
              mainModule: "index.js",
              modules: {
                "index.js": {
                  type: "esm",
                  contents: bundle.outputFiles[0].text,
                },
              },
            },
            exports: {
              StorageCoordinator: { type: "durable-object", storage: "sqlite" },
            },
            env: {
              DB: { type: "d1", id: "backup-runtime-db" },
              STORAGE: {
                type: "durable-object",
                worker: "backup-runtime-test",
                exportName: "StorageCoordinator",
              },
              ADMIN_PASSWORD: {
                type: "json",
                value: "backup-runtime-password",
              },
              COOKIE_SECRET: { type: "json", value: "backup-runtime-cookie" },
              CREDENTIAL_ENCRYPTION_KEY: {
                type: "json",
                value: "backup-runtime-credential-key-test-only-32",
              },
              CF_DOMAINS: { type: "json", value: "example.test" },
            },
          },
        },
      ],
    });
    try {
      const DB = await runtime.getD1Database("DB");
      for (const file of (await readdir("migrations"))
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        const statements = (await readFile(`migrations/${file}`, "utf8"))
          .replace(/--[^\n]*/g, "")
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean);
        await DB.batch(statements.map((s) => DB.prepare(s)));
      }
      const worker = await runtime.getWorker();
      const login = await worker.fetch("https://mailhub.test/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "backup-runtime-password" }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get("Set-Cookie")!.split(";")[0];
      const request = async (
        path: string,
        body?: unknown,
        method = body === undefined ? "GET" : "POST",
        key?: string,
      ) => {
        const response = await worker.fetch(`https://mailhub.test${path}`, {
          method,
          headers: {
            Cookie: cookie,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
            ...(key ? { "Idempotency-Key": key } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const data = (await response.json()) as any;
        assert.equal(response.status, 200, JSON.stringify(data));
        return { response, data };
      };
      await request("/api/vault", {
        platform_name: "Runtime",
        account_email: "runtime@example.test",
        email_source: "external",
        password: "runtime-vault-original",
      });
      await request("/api/platforms", {
        name: "Runtime empty",
        url: "https://example.test/",
        category: "空平台",
        remark: "preserved",
        is_pinned: true,
      });
      const exported = await request("/api/backups/export", {
        include_credentials: true,
        confirm: "EXPORT_CREDENTIALS",
        passphrase: PASSPHRASE,
      });
      await request("/api/vault/1", { password: "runtime-vault-newer" }, "PUT");
      await request("/api/platforms/Runtime%20empty", undefined, "DELETE");
      const preview = await request("/api/backups/preview", {
        backup: exported.data,
        passphrase: PASSPHRASE,
      });
      const body = {
        backup: exported.data,
        passphrase: PASSPHRASE,
        confirmation_token: preview.data.data.confirmation_token,
        confirm: "RESTORE_BACKUP",
      };
      const restored = await request(
        "/api/backups/restore",
        body,
        "POST",
        "runtime-restore",
      );
      assert.equal(
        (await request("/api/vault/1")).data.data.password,
        "runtime-vault-original",
      );
      const restoredPlatforms = (await request("/api/platforms")).data.data;
      assert.equal(restoredPlatforms.length, 2);
      const empty = restoredPlatforms.find(
        (p: any) => p.name_key === "runtime empty",
      );
      assert.equal(empty.account_count, 0);
      assert.equal(empty.managed, true);
      assert.equal(empty.is_pinned, 1);
      assert.equal(empty.remark, "preserved");
      const stored = await DB.prepare(
        "SELECT body FROM storage_rows WHERE generation = ? AND table_name = 'platform_vault'",
      )
        .bind(restored.data.data.active.generation)
        .first<{ body: string }>();
      assert.ok(stored?.body.includes("enc:v1:"));
      assert.ok(!stored?.body.includes("runtime-vault-original"));
      await runtime.unsafeEvictDurableObject(
        "backup-runtime-test",
        "StorageCoordinator",
        { name: "mailhub-workspace" },
      );
      const replay = await request(
        "/api/backups/restore",
        body,
        "POST",
        "runtime-restore",
      );
      assert.equal(replay.response.headers.get("Idempotency-Replayed"), "true");
      assert.deepEqual(replay.data, restored.data);
      const namespace = await runtime.getDurableObjectNamespace("STORAGE"),
        stub = namespace.get(namespace.idFromName("mailhub-workspace"));
      const status = (await (
        await stub.fetch("https://internal/status", {
          method: "POST",
          body: "{}",
        })
      ).json()) as any;
      assert.deepEqual(status.data.active, restored.data.data.active);
    } finally {
      await runtime.dispose();
    }
  },
);
