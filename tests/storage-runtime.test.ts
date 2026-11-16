import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { readFile, readdir } from "node:fs/promises";

test(
  "actual Worker and SQLite Durable Object preserve large Unicode commits, sessions and storage state through eviction",
  { timeout: 30000 },
  async () => {
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
            name: "runtime-storage-test",
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
              DB: { type: "d1", id: "runtime-db" },
              STORAGE: {
                type: "durable-object",
                worker: "runtime-storage-test",
                exportName: "StorageCoordinator",
              },
              ADMIN_PASSWORD: { type: "json", value: "runtime-test-password" },
              COOKIE_SECRET: { type: "json", value: "runtime-cookie-secret" },
              CREDENTIAL_ENCRYPTION_KEY: {
                type: "json",
                value:
                  "runtime-fictional-credential-key-at-least-32-characters",
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
        const sql = (await readFile(`migrations/${file}`, "utf8"))
          .replace(/--[^\n]*/g, "")
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean);
        await DB.batch(sql.map((s) => DB.prepare(s)));
      }
      const worker = await runtime.getWorker();
      const login = await worker.fetch("https://mailhub.test/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "runtime-test-password" }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const importToken =
        "M.C525_BAY.0.U.MsaArtifacts.FICTIONAL!not*a-real-token_0123456789";
      const imported = await worker.fetch(
        "https://mailhub.test/api/outlook/batch-import",
        {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify({
            raw_text:
              "导出内容（格式：邮箱----密码----client_id----refresh_token）\n" +
              `RuntimeImport@outlook.com----TestOnly42!----9e5f94bc-e8a4-4e73-b8be-63364c29d753----${importToken}`,
            duplicate_mode: "update",
            sync_to_vault: true,
          }),
        },
      );
      const importResult = (await imported.json()) as any;
      assert.equal(imported.status, 200);
      assert.equal(importResult.created, 1);
      assert.equal(importResult.invalid_count, 0);
      const namespace = await runtime.getDurableObjectNamespace("STORAGE"),
        stub = namespace.get(namespace.idFromName("mailhub-workspace"));
      const text = '中文🔑<tag>"\n'.repeat(30000);
      const write = await stub.fetch("https://internal/data/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutations: [
            {
              op: "insert",
              table: "cf_inbox_mails",
              rows: [
                {
                  recipient: "runtime@example.test",
                  sender: "qa@example.test",
                  text_content: text,
                },
              ],
            },
          ],
        }),
      });
      assert.equal(write.status, 200, await write.text());
      await runtime.unsafeEvictDurableObject(
        "runtime-storage-test",
        "StorageCoordinator",
        { name: "mailhub-workspace" },
      );
      const mail = await worker.fetch("https://mailhub.test/api/cf-mails/1", {
        headers: { Cookie: cookie },
      });
      assert.equal(mail.status, 200);
      assert.equal(((await mail.json()) as any).data.text_content, text);
      const account = await DB.prepare(
        "SELECT email,password,refresh_token FROM accounts WHERE email=?",
      )
        .bind("runtimeimport@outlook.com")
        .first<any>();
      assert.match(account?.password, /^enc:v1:/);
      assert.match(account?.refresh_token, /^enc:v1:/);
      const linkedAccount = await DB.prepare(
        "SELECT password FROM platform_vault WHERE account_email=?",
      )
        .bind("runtimeimport@outlook.com")
        .first<any>();
      assert.match(linkedAccount?.password, /^enc:v1:/);
      assert.notEqual(
        linkedAccount?.password,
        account.password,
        "independent random IVs",
      );
      const detail = await worker.fetch(
        "https://mailhub.test/api/outlook/accounts/1",
        { headers: { Cookie: cookie } },
      );
      const detailBody = (await detail.json()) as any;
      assert.equal(detailBody.data.refresh_token, importToken);
      assert.equal(detailBody.data.password, "TestOnly42!");
      const status = await worker.fetch(
        "https://mailhub.test/api/settings/storage",
        { headers: { Cookie: cookie } },
      );
      const body = (await status.json()) as any;
      assert.equal(status.status, 200);
      assert.equal(body.data.active.sourceId, "d1");
      assert.equal(body.data.pending_write, false);
      const denied = await worker.fetch(
        "https://mailhub.test/api/settings/storage",
      );
      assert.equal(denied.status, 401);
    } finally {
      await runtime.dispose();
    }
  },
);
