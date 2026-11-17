import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiKey } from "../src/api-keys";
import { db, eq, insert, update, StorageError } from "../src/storage/client";
import { Coordinator } from "../src/storage/coordinator";
import { D1Port } from "../src/storage/d1";
import type { Row } from "../src/storage/model";
import type { Env } from "../src/types";
import { database } from "./helpers";
import { MemoryControl } from "./storage-support";

test("restricted vault consumers reauthorize the row actually consumed after a concurrent address change", async (t) => {
  const cases = [
    { path: "/api/vault/1", reads: 1 },
    { path: "/api/vault/1/code?match=mailbox", reads: 1 },
    { path: "/api/vault/1", reads: 1, body: { remark: "forbidden edit" }, method: "PUT" },
    { path: "/api/vault/1", reads: 1, method: "DELETE" },
    { path: "/api/vault/1/pin", reads: 1, body: {} },
    { path: "/api/vault/batch", reads: 1, body: { ids: [1], patch: { remark: "forbidden bulk edit" } } },
    { path: "/api/automation/mailbox", reads: 1, body: { vault_id: 1 } },
    { path: "/api/automation/verification", reads: 1, body: { vault_id: 1 } },
    { path: "/api/automation/verification", reads: 2, body: { vault_id: 1 } },
    { path: "/api/automation/verification/batch", reads: 2, body: { items: [{ vault_id: 1 }] }, batch: true },
    { path: "/api/external/code?platform=Scoped", reads: 1 },
  ];
  for (const scenario of cases) await t.test(`${scenario.method || (scenario.body ? "POST" : "GET")} ${scenario.path} after read ${scenario.reads}`, async () => {
    const f = await database();
    try {
      const coordinator = new Coordinator(new MemoryControl(), async (_source, generation) => new D1Port(f.DB, generation), { id: "d1", name: "D1", kind: "d1", created: "test" });
      let remaining = 0;
      f.env.STORAGE = {
        idFromName: () => "authorization-race",
        get: () => ({ fetch: async (url: string, init: RequestInit) => {
          const input = JSON.parse(String(init.body));
          try {
            let data: unknown;
            switch (new URL(url).pathname) {
              case "/auth/settings": data = await coordinator.security(); break;
              case "/data/count": data = await coordinator.count(input.table, input.where); break;
              case "/data/mutate": data = await coordinator.mutate(input.mutations); break;
              case "/data/find":
                data = await coordinator.find(input.table, input.query);
                if (input.table === "platform_vault" && remaining > 0 && --remaining === 0) {
                  // Commit after the read has resolved but before its snapshot is
                  // consumed. The next handler read must authorize the new row.
                  await coordinator.mutate([update("platform_vault", eq("id", 1), { account_email: "private@example.test", password: "private-race-password", updated_at: "2090-01-01T00:00:00.000Z" })]);
                }
                break;
              default: throw new Error("Unexpected coordinator path");
            }
            return Response.json({ data });
          } catch (error) {
            if (!(error instanceof StorageError)) throw error;
            return Response.json({ error: error.code, message: error.message }, { status: error.status });
          }
        } }),
      } as unknown as Env["STORAGE"];
      await db(f.env).mutate([
        insert("platform_vault", { platform_name: "Scoped", account_email: "allowed@example.test", email_source: "cf_domain", password: "old-permitted-password" }),
        insert("cf_inbox_mails", { recipient: "private@example.test", verification_code: "888888" }),
      ]);
      const key = await createApiKey(f.env, { name: "Race test", scopes: ["admin"], restrictions: { emails: ["allowed@example.test"] } });
      remaining = scenario.reads;
      const result = await f.request(scenario.path, scenario.body, scenario.method || (scenario.body ? "POST" : "GET"), { "X-API-Key": key.key });
      assert.equal(remaining, 0, "the intended interleaving must execute");
      if (scenario.batch) {
        assert.equal(result.response.status, 200);
        assert.equal(result.data.data.results[0].success, false);
        assert.equal(result.data.data.results[0].status, 403);
      } else assert.equal(result.response.status, 403, JSON.stringify(result.data));
      assert.ok(!JSON.stringify(result.data).includes("private-race-password"));
      assert.ok(!JSON.stringify(result.data).includes("888888"));
      const saved = (await coordinator.find("platform_vault"))[0] as Row;
      assert.equal(saved.password, "private-race-password");
      assert.equal(saved.remark, "");
      assert.equal(saved.is_pinned, 0);
    } finally { await f.dispose(); }
  });
});
