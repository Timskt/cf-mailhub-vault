import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import PostalMime from "postal-mime";
import { handleIncomingEmail } from "../src/email-handler";
import {
  attachmentManifest,
  collectMailObjects,
  mailObjectResponse,
  publicMailObjects,
  saveRawMail,
} from "../src/mail-objects";
import {
  db,
  eq,
  insert,
  remove,
  StorageError,
  update,
} from "../src/storage/client";
import type { Env } from "../src/types";

let fixture: Awaited<ReturnType<typeof database>>;
let runtime: Miniflare;
let bucket: R2Bucket;
const binary = Buffer.from([0, 1, 2, 3, 127, 128, 254, 255]);
const filename = "报告.txt";
const utf8Attachment = Buffer.from("附件内容\n", "utf8");
async function database() {
  const dbRuntime = new Miniflare({
    workers: [
      {
        config: {
          name: "mail-object-database-tests",
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
          env: { DB: { type: "d1", id: "mail-object-db" } },
        },
      },
    ],
  });
  const DB = (await dbRuntime.getD1Database("DB")) as unknown as D1Database;
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
  return { DB, env, dispose: () => dbRuntime.dispose() };
}
function mime(
  messageId: string | null = "fixture-id",
  text = "Your verification code is 246810.",
) {
  return [
    "From: Test Sender <sender@example.org>",
    "To: receiver@example.test",
    ...(messageId === null ? [] : [`Message-ID: <${messageId}@example.org>`]),
    "Subject: Your verification code is 246810",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="mailhub-fixture-boundary"',
    "",
    "--mailhub-fixture-boundary",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(text, "utf8").toString("base64"),
    "--mailhub-fixture-boundary",
    "Content-Type: application/octet-stream",
    'Content-Disposition: attachment; filename="binary.bin"',
    "Content-Transfer-Encoding: base64",
    "",
    binary.toString("base64"),
    "--mailhub-fixture-boundary",
    "Content-Type: text/plain; charset=UTF-8",
    `Content-Disposition: attachment; filename*=utf-8''${encodeURIComponent(filename)}`,
    "Content-Transfer-Encoding: base64",
    "",
    utf8Attachment.toString("base64"),
    "--mailhub-fixture-boundary--",
    "",
  ].join("\r\n");
}
function bytes(raw: string) {
  return new TextEncoder().encode(raw).buffer;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function bucketWith(
  overrides: Partial<Record<"put" | "get" | "delete", (...args: any[]) => any>>,
): R2Bucket {
  return new Proxy(bucket, {
    get(target, property) {
      if (typeof property === "string" && property in overrides)
        return overrides[property as keyof typeof overrides];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
async function ingest(
  raw = mime(),
  env: Env = fixture.env,
  options: { to?: string; rawSize?: number } = {},
) {
  const rejected: string[] = [];
  await handleIncomingEmail(
    {
      to: options.to || "receiver@example.test",
      from: "sender@example.org",
      raw: new Blob([raw]).stream(),
      rawSize: options.rawSize ?? Buffer.byteLength(raw),
      headers: new Headers({ "Authentication-Results": "dkim=pass; spf=pass" }),
      setReject(reason: string) {
        rejected.push(reason);
      },
    } as unknown as ForwardableEmailMessage,
    env,
  );
  return rejected;
}
async function firstMail() {
  return (await db(fixture.env).first("cf_inbox_mails"))!;
}
async function objectKeys() {
  return (await bucket.list({ prefix: "mail/", limit: 1000 })).objects.map(
    (o) => o.key,
  );
}
async function makeDue(key?: string) {
  await db(fixture.env).mutate([
    update("mail_object_gc", key ? eq("key", key) : undefined, {
      available_at: Date.now() - 1,
    }),
  ]);
}
function assertGraceDeadline(
  value: unknown,
  startedAt: number,
  finishedAt: number,
  hours: number,
) {
  const deadline = Number(value);
  const grace = hours * 60 * 60 * 1000;
  assert.ok(
    deadline >= startedAt + grace && deadline <= finishedAt + grace,
    `Expected exactly ${hours} hours of grace from the operation`,
  );
}
before(async () => {
  fixture = await database();
  const bundle = await build({
    stdin: {
      contents: `
      import { mailObjectResponse } from './src/mail-objects';
      export default { async fetch(request, env) {
        const url = new URL(request.url), key = url.searchParams.get('key');
        return mailObjectResponse(env, {id: Number(url.searchParams.get('id') || '1'),raw_object_key:key},url.searchParams.get('attachment') ?? undefined);
      }};
    `,
      resolveDir: process.cwd(),
      sourcefile: "mail-object-runtime-entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "mail-object-tests",
          compatibilityDate: "2026-11-01",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": { type: "esm", contents: bundle.outputFiles[0].text },
            },
          },
          env: { MAIL_OBJECTS: { type: "r2", name: "mail-object-fixtures" } },
        },
      },
    ],
  });
  bucket = (await runtime.getR2Bucket("MAIL_OBJECTS")) as unknown as R2Bucket;
  fixture.env.MAIL_OBJECTS = bucket;
});
beforeEach(async () => {
  await db(fixture.env).mutate([
    remove("cf_inbox_mails", undefined),
    remove("mail_object_gc", undefined),
    remove("temp_mailboxes", undefined),
    remove("platform_vault", undefined),
    remove("mail_rules", undefined),
    remove("domains", undefined),
    remove("webhook_deliveries", undefined),
    remove("webhooks", undefined),
  ]);
  const keys = await objectKeys();
  if (keys.length) await bucket.delete(keys);
});
after(async () => {
  await runtime?.dispose();
  await fixture?.dispose();
});

async function nativeDownload(
  mail: { id?: unknown; raw_object_key?: unknown },
  attachment?: string,
) {
  const query = new URLSearchParams({
    key: String(mail.raw_object_key || ""),
    id: String(mail.id || 1),
  });
  if (attachment !== undefined) query.set("attachment", attachment);
  return (await runtime.getWorker()).fetch(`https://mailhub.test/?${query}`);
}

test("attachment downloads consume R2 once in native workerd", async () => {
  await ingest();
  const response = await nativeDownload(await firstMail(), "0");
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), binary);
});

test("MIME ingestion stores exact original EML, attachment manifest and readable binary/UTF-8 downloads in R2", async () => {
  const raw = mime();
  assert.deepEqual(await ingest(raw), []);
  const mail = await firstMail();
  assert.ok(
    /^mail\/[0-9a-f-]{36}\/raw\.eml$/.test(String(mail.raw_object_key)),
  );
  assert.equal(mail.raw_size, Buffer.byteLength(raw));
  assert.equal(mail.verification_code, "246810");
  assert.equal(mail.dkim_status, "pass");
  assert.equal(mail.spf_status, "pass");
  assert.equal(await db(fixture.env).count("mail_object_gc"), 0);
  const object = (await bucket.get(String(mail.raw_object_key)))!;
  assert.equal(await object.text(), raw);
  assert.equal(object.httpMetadata?.contentType, "message/rfc822");
  assert.equal(object.httpMetadata?.contentDisposition, "attachment");
  const visible = publicMailObjects(mail);
  assert.equal(visible.has_raw, true);
  assert.deepEqual(visible.attachments, [
    {
      id: "0",
      name: "binary.bin",
      size: binary.length,
      contentType: "application/octet-stream",
    },
    {
      id: "1",
      name: filename,
      size: utf8Attachment.length,
      contentType: "text/plain",
    },
  ]);
  assert.equal(
    JSON.stringify(visible).includes(String(mail.raw_object_key)),
    false,
  );
  for (const [id, expected, expectedName] of [
    [undefined, Buffer.from(raw), `mail-${mail.id}.eml`],
    ["0", binary, "binary.bin"],
    ["1", utf8Attachment, filename],
  ] as const) {
    const response = await nativeDownload(mail, id);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
    assert.equal(
      response.headers.get("Content-Type"),
      "application/octet-stream",
    );
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(
      response.headers.get("Content-Disposition"),
      `attachment; filename*=UTF-8''${encodeURIComponent(expectedName)}`,
    );
  }
});

test("manifest filenames remove header controls and attachment responses reject invalid indices", async () => {
  const parsed = await new PostalMime().parse(mime());
  parsed.attachments[0].filename = "evil\r\nX-Header: yes\u0000.bin";
  assert.equal(attachmentManifest(parsed)[0].name, "evilX-Header: yes.bin");
  parsed.attachments[0].filename = null;
  assert.equal(attachmentManifest(parsed)[0].name, "attachment-1");
  await ingest();
  for (const id of ["-1", "../0", "1.0", "2", "1000", "not-an-id"])
    assert.equal((await nativeDownload(await firstMail(), id)).status, 404);
});

test("unconfigured storage and missing objects report distinct errors without losing body-only ingestion", async () => {
  const env = { ...fixture.env, MAIL_OBJECTS: undefined };
  assert.equal(await saveRawMail(env, bytes(mime())), "");
  assert.deepEqual(await collectMailObjects(env), { deleted: 0 });
  assert.deepEqual(await ingest(mime(), env), []);
  const mail = await firstMail();
  assert.equal(mail.raw_object_key, "");
  assert.deepEqual(publicMailObjects(mail), {
    has_raw: false,
    attachments: [],
  });
  assert.match(String(mail.text_content), /246810/);
  const unavailable = await mailObjectResponse(env, mail);
  assert.equal(unavailable.status, 404);
  assert.equal(
    ((await unavailable.json()) as any).error,
    "MAIL_OBJECT_UNAVAILABLE",
  );
  const missing = await mailObjectResponse(fixture.env, {
    ...mail,
    raw_object_key: `mail/${crypto.randomUUID()}/raw.eml`,
  });
  assert.equal(missing.status, 503);
  assert.equal(((await missing.json()) as any).error, "MAIL_OBJECT_MISSING");
  assert.equal(await db(fixture.env).count("mail_object_gc"), 0);
});

test("sequential duplicate receipt preserves manual state and creates no extra object or webhook event", async () => {
  await db(fixture.env).mutate([
    insert("webhooks", {
      name: "Events",
      url: "https://hooks.example.org",
      secret: "fictional-signing-secret",
      events: '["mail.received","code.extracted"]',
    }),
  ]);
  await ingest();
  const original = await firstMail();
  await db(fixture.env).mutate([
    update("cf_inbox_mails", eq("id", original.id), {
      is_read: 1,
      is_pinned: 1,
      category: "manual",
    }),
  ]);
  await ingest();
  const mail = await firstMail();
  assert.equal(await db(fixture.env).count("cf_inbox_mails"), 1);
  assert.equal(await db(fixture.env).count("webhook_deliveries"), 2);
  assert.equal(mail.raw_object_key, original.raw_object_key);
  assert.equal(mail.is_read, 1);
  assert.equal(mail.is_pinned, 1);
  assert.equal(mail.category, "manual");
  assert.equal((await objectKeys()).length, 1);
  assert.equal(await db(fixture.env).count("mail_object_gc"), 0);
});

test("messages without Message-ID deduplicate by bytes, but the same message delivered to two recipients is retained twice", async () => {
  const raw = mime(null);
  await ingest(raw);
  await ingest(raw);
  await ingest(raw, fixture.env, { to: "second@example.test" });
  const rows = await db(fixture.env).select("cf_inbox_mails");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].message_id, rows[1].message_id);
  assert.match(String(rows[0].message_id), /^[a-f0-9]{64}$/);
  assert.notEqual(rows[0].raw_object_key, rows[1].raw_object_key);
});

test(
  "concurrent duplicate uploads commit one mail and retain only the losing object for orphan GC",
  { timeout: 10000 },
  async () => {
    const bothUploaded = deferred();
    let puts = 0;
    const env = {
      ...fixture.env,
      MAIL_OBJECTS: bucketWith({
        put: async (...args: Parameters<R2Bucket["put"]>) => {
          const object = await bucket.put(...args);
          if (++puts === 2) bothUploaded.resolve();
          await bothUploaded.promise;
          return object;
        },
      }),
    };
    const startedAt = Date.now();
    await Promise.all([ingest(mime(), env), ingest(mime(), env)]);
    const finishedAt = Date.now();
    assert.equal(puts, 2);
    assert.equal(await db(fixture.env).count("cf_inbox_mails"), 1);
    assert.equal((await objectKeys()).length, 2);
    const [orphan] = await db(fixture.env).select("mail_object_gc");
    assert.ok(orphan);
    const mail = await firstMail();
    assert.notEqual(orphan.key, mail.raw_object_key);
    assertGraceDeadline(orphan.available_at, startedAt, finishedAt, 24);
    assert.deepEqual(await collectMailObjects(fixture.env), { deleted: 0 });
    await makeDue(String(orphan.key));
    assert.deepEqual(await collectMailObjects(fixture.env), { deleted: 1 });
    assert.deepEqual(await objectKeys(), [mail.raw_object_key]);
    assert.equal(await db(fixture.env).count("mail_object_gc"), 0);
  },
);

test("orphan intent is durable before upload; failed upload and interrupted commits are reclaimed after grace", async () => {
  const failedStartedAt = Date.now();
  const env = {
    ...fixture.env,
    MAIL_OBJECTS: bucketWith({
      put: async (key: string) => {
        const intent = await db(fixture.env).first(
          "mail_object_gc",
          eq("key", key),
        );
        assert.ok(intent);
        assertGraceDeadline(
          intent.available_at,
          failedStartedAt,
          Date.now(),
          24,
        );
        throw new Error("fictional R2 upload failure");
      },
    }),
  };
  await assert.rejects(ingest(mime(), env), /fictional R2 upload failure/);
  assert.equal(await db(fixture.env).count("cf_inbox_mails"), 0);
  assert.equal(await db(fixture.env).count("mail_object_gc"), 1);
  // Successful R2 put followed by process death before the mail transaction.
  const startedAt = Date.now();
  const uploaded = await saveRawMail(fixture.env, bytes(mime("interrupted")));
  const finishedAt = Date.now();
  const orphan = (await db(fixture.env).first(
    "mail_object_gc",
    eq("key", uploaded),
  ))!;
  assertGraceDeadline(orphan.available_at, startedAt, finishedAt, 24);
  assert.ok(await bucket.head(uploaded));
  assert.deepEqual(await collectMailObjects(fixture.env), { deleted: 0 });
  await makeDue();
  assert.deepEqual(await collectMailObjects(fixture.env), { deleted: 2 });
  assert.equal((await objectKeys()).length, 0);
  assert.equal(await db(fixture.env).count("mail_object_gc"), 0);
});

test("mail commit rollback leaves the recovery intent, and confirmMailObject removes it only for a committed reference", async () => {
  const key = await saveRawMail(fixture.env, bytes(mime()));
  await assert.rejects(
    db(fixture.env).mutate([
      insert("cf_inbox_mails", {
        message_id: "atomic",
        recipient: "receiver@example.test",
        raw_object_key: key,
      }),
      { op: "confirmMailObject", key },
      { op: "assertExists", table: "mail_rules", where: eq("id", 999999) },
    ]),
    { code: "STALE_PREVIEW" },
  );
  assert.equal(await db(fixture.env).count("cf_inbox_mails"), 0);
  assert.ok(await db(fixture.env).first("mail_object_gc", eq("key", key)));
  await db(fixture.env).mutate([{ op: "confirmMailObject", key }]);
  assert.ok(await db(fixture.env).first("mail_object_gc", eq("key", key)));
  await db(fixture.env).mutate([
    insert("cf_inbox_mails", {
      message_id: "atomic",
      recipient: "receiver@example.test",
      raw_object_key: key,
    }),
    { op: "confirmMailObject", key },
  ]);
  assert.equal(await db(fixture.env).count("mail_object_gc"), 0);
  assert.ok(await bucket.head(key));
});

test("deleting a mail schedules object cleanup; shared active references protect it until the last mail is removed", async () => {
  await ingest();
  const original = await firstMail(),
    key = String(original.raw_object_key);
  await db(fixture.env).mutate([
    insert("cf_inbox_mails", {
      message_id: "shared",
      recipient: "other@example.test",
      raw_object_key: key,
    }),
  ]);
  const startedAt = Date.now();
  await db(fixture.env).mutate([
    remove("cf_inbox_mails", eq("id", original.id)),
  ]);
  const finishedAt = Date.now();
  const queued = (await db(fixture.env).first(
    "mail_object_gc",
    eq("key", key),
  ))!;
  assertGraceDeadline(queued.available_at, startedAt, finishedAt, 7 * 24);
  assert.deepEqual(await collectMailObjects(fixture.env), { deleted: 0 });
  await makeDue();
  assert.deepEqual(await collectMailObjects(fixture.env), { deleted: 0 });
  assert.ok(await bucket.head(key));
  assert.equal(await db(fixture.env).count("mail_object_gc"), 0);
  await db(fixture.env).mutate([
    remove("cf_inbox_mails", eq("raw_object_key", key)),
  ]);
  await makeDue();
  assert.deepEqual(await collectMailObjects(fixture.env), { deleted: 1 });
  assert.equal(await bucket.head(key), null);
});

test("cleanMail honors pinned, protected and permanent-mailbox references and queues only deleted objects", async () => {
  const keys = await Promise.all(
    [0, 1, 2, 3].map(() => saveRawMail(fixture.env, bytes(mime()))),
  );
  const [a, b, c, d] = await db(fixture.env).mutate(
    keys.map((key, i) =>
      insert("cf_inbox_mails", {
        message_id: `protected-${i}`,
        recipient: i === 3 ? "permanent@example.test" : "receiver@example.test",
        raw_object_key: key,
        is_pinned: i === 1 ? 1 : 0,
        is_protected: i === 2 ? 1 : 0,
      }),
    ),
  );
  const startedAt = Date.now();
  await db(fixture.env).mutate([
    ...keys.map((key) => ({ op: "confirmMailObject" as const, key })),
    insert("temp_mailboxes", {
      address: "permanent@example.test",
      prefix: "permanent",
      domain: "example.test",
      is_permanent: 1,
    }),
    { op: "cleanMail", ids: [a.lastId, b.lastId, c.lastId, d.lastId] },
  ]);
  const finishedAt = Date.now();
  assert.equal(await db(fixture.env).count("cf_inbox_mails"), 3);
  const queued = await db(fixture.env).select("mail_object_gc");
  assert.deepEqual(
    queued.map((row) => row.key),
    [keys[0]],
  );
  assertGraceDeadline(queued[0].available_at, startedAt, finishedAt, 7 * 24);
  assert.deepEqual(await collectMailObjects(fixture.env), { deleted: 0 });
  assert.ok(await bucket.head(keys[0]));
  await makeDue();
  assert.deepEqual(await collectMailObjects(fixture.env), { deleted: 1 });
  for (const key of keys.slice(1)) assert.ok(await bucket.head(key));
});

test("R2 delete failures retain queue with delayed retry and reject arbitrary non-mail object keys", async () => {
  const key = await saveRawMail(fixture.env, bytes(mime()));
  await makeDue(key);
  let deletes = 0;
  const env = {
    ...fixture.env,
    MAIL_OBJECTS: bucketWith({
      delete: async () => {
        deletes++;
        throw new Error("fictional R2 deletion failure");
      },
    }),
  };
  const before = Date.now();
  assert.deepEqual(await collectMailObjects(env), { deleted: 0 });
  const retry = (await db(fixture.env).first(
    "mail_object_gc",
    eq("key", key),
  ))!;
  assert.equal(retry.attempts, 1);
  assert.equal(retry.state, "deleting");
  assert.ok(Number(retry.available_at) >= before + 3600000);
  assert.deepEqual(await collectMailObjects(env), { deleted: 0 });
  assert.equal(deletes, 1);
  await assert.rejects(
    db(fixture.env).mutate([
      insert("cf_inbox_mails", {
        message_id: "failed-delete-confirmation",
        recipient: "receiver@example.test",
        raw_object_key: key,
      }),
      { op: "confirmMailObject", key },
    ]),
    { code: "MAIL_OBJECT_EXPIRED", status: 409 },
  );
  assert.equal(await db(fixture.env).count("cf_inbox_mails"), 0);
  assert.ok(await bucket.head(key));
  for (const invalid of [
    "private/credentials.json",
    "../secret",
    "mail/not-a-uuid/raw.eml",
    `mail/${crypto.randomUUID()}/attachment.bin`,
  ])
    await db(fixture.env).mutate([
      insert("mail_object_gc", { key: invalid, available_at: 0 }),
    ]);
  assert.deepEqual(await collectMailObjects(env), { deleted: 0 });
  assert.equal(deletes, 1);
  await makeDue(key);
  assert.deepEqual(await collectMailObjects(fixture.env), { deleted: 1 });
  assert.equal(await bucket.head(key), null);
  assert.equal(
    await db(fixture.env).first("mail_object_gc", eq("key", key)),
    null,
  );
});

test("disabled domains, expired mailboxes and declared/actual oversize messages never upload an object", async () => {
  assert.equal(
    (await ingest(mime(), fixture.env, { to: "receiver@unconfigured.test" }))
      .length,
    1,
  );
  await db(fixture.env).mutate([
    insert("temp_mailboxes", {
      address: "expired@example.test",
      prefix: "expired",
      domain: "example.test",
      expires_at: "2000-01-01T00:00:00.000Z",
    }),
  ]);
  assert.equal(
    (await ingest(mime(), fixture.env, { to: "expired@example.test" })).length,
    1,
  );
  assert.equal(
    (await ingest(mime(), fixture.env, { rawSize: 20 * 1024 * 1024 + 1 }))
      .length,
    1,
  );
  const env = { ...fixture.env, MAIL_OBJECTS: undefined };
  assert.equal(
    (await ingest("x".repeat(2 * 1024 * 1024 + 1), env, { rawSize: 1 })).length,
    1,
  );
  assert.equal(await db(fixture.env).count("cf_inbox_mails"), 0);
  assert.equal(await db(fixture.env).count("mail_object_gc"), 0);
  assert.equal((await objectKeys()).length, 0);
});

test(
  "a delayed mail confirmation racing GC cannot leave a live reference to a deleted object",
  { timeout: 10000 },
  async () => {
    const key = await saveRawMail(fixture.env, bytes(mime()));
    // Model a worker interrupted past the orphan grace period, then resumed.
    await makeDue(key);
    const deleting = deferred(),
      release = deferred();
    const env = {
      ...fixture.env,
      MAIL_OBJECTS: bucketWith({
        delete: async (value: string | string[]) => {
          deleting.resolve();
          await release.promise;
          return bucket.delete(value);
        },
      }),
    };
    const collecting = collectMailObjects(env);
    try {
      await deleting.promise;
      assert.equal(
        (await db(fixture.env).first("mail_object_gc", eq("key", key)))!.state,
        "deleting",
      );
      await assert.rejects(
        db(fixture.env).mutate([
          insert("webhook_deliveries", {
            id: "late-confirmation-event",
            webhook_id: 1,
            event: "mail.received",
            payload: "{}",
          }),
          insert("cf_inbox_mails", {
            message_id: "late-confirmation",
            recipient: "receiver@example.test",
            raw_object_key: key,
          }),
          { op: "confirmMailObject", key },
        ]),
        (error: unknown) =>
          error instanceof StorageError &&
          error.code === "MAIL_OBJECT_EXPIRED" &&
          error.status === 409,
      );
      assert.equal(await db(fixture.env).count("webhook_deliveries"), 0);
      assert.equal(await db(fixture.env).count("cf_inbox_mails"), 0);
    } finally {
      release.resolve();
      await Promise.allSettled([collecting]);
    }
    await collecting;
    const live = await db(fixture.env).count(
      "cf_inbox_mails",
      eq("raw_object_key", key),
    );
    const object = await bucket.head(key);
    assert.ok(
      !live || object,
      "GC deleted raw EML after a concurrent successful confirmation established an active reference",
    );
  },
);

test("GC cannot claim before grace and confirmation before claim protects the committed mail", async () => {
  const key = await saveRawMail(fixture.env, bytes(mime()));
  const [early] = await db(fixture.env).mutate([
    { op: "claimMailObject", key, time: Date.now() },
  ]);
  assert.equal(early.changes, 0);
  assert.equal(
    (await db(fixture.env).first("mail_object_gc", eq("key", key)))!.state,
    "pending",
  );
  await makeDue(key);
  await db(fixture.env).mutate([
    insert("cf_inbox_mails", {
      message_id: "confirmation-won",
      recipient: "receiver@example.test",
      raw_object_key: key,
    }),
    { op: "confirmMailObject", key },
  ]);
  const [late] = await db(fixture.env).mutate([
    { op: "claimMailObject", key, time: Date.now() },
  ]);
  assert.equal(late.changes, 0);
  assert.deepEqual(await collectMailObjects(fixture.env), { deleted: 0 });
  assert.ok(await bucket.head(key));
  assert.equal(await db(fixture.env).count("cf_inbox_mails"), 1);
  assert.equal(await db(fixture.env).count("mail_object_gc"), 0);
});

test("confirmation after completed GC rejects the missing marker and rolls back every business write", async () => {
  const key = await saveRawMail(fixture.env, bytes(mime()));
  await makeDue(key);
  assert.deepEqual(await collectMailObjects(fixture.env), { deleted: 1 });
  assert.equal(await db(fixture.env).count("mail_object_gc"), 0);
  await assert.rejects(
    db(fixture.env).mutate([
      insert("domains", { domain: "late.example.test" }),
      insert("cf_inbox_mails", {
        message_id: "deleted-before-confirmation",
        recipient: "receiver@example.test",
        raw_object_key: key,
      }),
      { op: "confirmMailObject", key },
    ]),
    { code: "MAIL_OBJECT_EXPIRED", status: 409 },
  );
  assert.equal(await db(fixture.env).count("domains"), 0);
  assert.equal(await db(fixture.env).count("cf_inbox_mails"), 0);
  assert.equal(await bucket.head(key), null);
});

test("existing mail cannot be repointed to an object whose deletion has already been claimed", async () => {
  await ingest();
  const mail = await firstMail();
  const key = await saveRawMail(fixture.env, bytes(mime("orphan")));
  await makeDue(key);
  const [claim] = await db(fixture.env).mutate([
    { op: "claimMailObject", key, time: Date.now() },
  ]);
  assert.equal(claim.changes, 1);
  await assert.rejects(
    db(fixture.env).mutate([
      update("cf_inbox_mails", eq("id", mail.id), { raw_object_key: key }),
    ]),
    { code: "MAIL_OBJECT_EXPIRED", status: 409 },
  );
  assert.equal((await firstMail()).raw_object_key, mail.raw_object_key);
  // A new collector can finish a deleting marker left by an interrupted worker.
  assert.deepEqual(await collectMailObjects(fixture.env), { deleted: 1 });
  assert.ok(await bucket.head(String(mail.raw_object_key)));
  assert.equal(await bucket.head(key), null);
});

test(
  "overlapping GC workers keep late confirmations fenced when one R2 deletion fails",
  { timeout: 10000 },
  async () => {
    const key = await saveRawMail(fixture.env, bytes(mime()));
    await makeDue(key);
    const started = deferred(),
      release = deferred();
    let deletes = 0;
    const env = {
      ...fixture.env,
      MAIL_OBJECTS: bucketWith({
        delete: async (value: string | string[]) => {
          if (++deletes > 1)
            throw new Error("fictional overlapping delete failure");
          started.resolve();
          await release.promise;
          return bucket.delete(value);
        },
      }),
    };
    const first = collectMailObjects(env);
    try {
      await started.promise;
      assert.deepEqual(await collectMailObjects(env), { deleted: 0 });
      assert.equal(
        (await db(fixture.env).first("mail_object_gc", eq("key", key)))!.state,
        "deleting",
      );
      await assert.rejects(
        db(fixture.env).mutate([
          insert("cf_inbox_mails", {
            message_id: "overlapping-gc-confirmation",
            recipient: "receiver@example.test",
            raw_object_key: key,
          }),
          { op: "confirmMailObject", key },
        ]),
        { code: "MAIL_OBJECT_EXPIRED", status: 409 },
      );
    } finally {
      release.resolve();
      await Promise.allSettled([first]);
    }
    assert.deepEqual(await first, { deleted: 1 });
    assert.equal(await db(fixture.env).count("cf_inbox_mails"), 0);
    assert.equal(await db(fixture.env).count("mail_object_gc"), 0);
    assert.equal(await bucket.head(key), null);
  },
);
