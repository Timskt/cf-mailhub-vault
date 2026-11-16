import type { Env } from "../types";
import { Coordinator, type ControlStorage, type Source } from "./coordinator";
import { D1Port } from "./d1";
import { HttpPort, openSecret } from "./http";
import { StorageError, tableName } from "./model";
import { directRedisPort } from "./redis-direct";
export class StorageCoordinator {
  private coordinator: Coordinator;
  constructor(ctx: DurableObjectState, env: Env) {
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS control_chunks (key TEXT NOT NULL, part INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(key, part))",
    );
    const storage: ControlStorage = {
      get: async <T>(key: string) => {
        const chunks = ctx.storage.sql
          .exec<{ body: string }>(
            "SELECT body FROM control_chunks WHERE key=? ORDER BY part",
            key,
          )
          .toArray();
        if (!chunks.length) return undefined;
        return JSON.parse(chunks.map((c) => c.body).join("")) as T;
      },
      atomic: async (entries, remove = []) => {
        ctx.storage.transactionSync(() => {
          for (const key of [...Object.keys(entries), ...remove])
            ctx.storage.sql.exec("DELETE FROM control_chunks WHERE key=?", key);
          for (const [key, value] of Object.entries(entries)) {
            const json = JSON.stringify(value);
            for (let pos = 0, part = 0; pos < json.length; part++) {
              let end = Math.min(pos + 16000, json.length);
              if (end < json.length && /[\uD800-\uDBFF]/.test(json[end - 1]))
                end--;
              ctx.storage.sql.exec(
                "INSERT INTO control_chunks(key,part,body) VALUES (?,?,?)",
                key,
                part,
                json.slice(pos, end),
              );
              pos = end;
            }
          }
        });
      },
      schedule: (delay) => ctx.storage.setAlarm(Date.now() + delay),
      logsBefore: async (version, limit) =>
        ctx.storage.sql
          .exec<{ key: string }>(
            "SELECT DISTINCT key FROM control_chunks WHERE key LIKE 'log:%' AND key < ? ORDER BY key LIMIT ?",
            `log:${String(version).padStart(16, "0")}`,
            limit,
          )
          .toArray()
          .map((r) => r.key),
    };
    this.coordinator = new Coordinator(
      storage,
      async (source, generation, owner) => {
        if (source.kind === "d1") return new D1Port(env.DB, generation);
        if (source.kind === "redis" && source.transport === "redis")
          return directRedisPort(
            await openSecret(source.secret!, env.STORAGE_ENCRYPTION_KEY || ""),
            source.source!,
            generation,
            owner,
            source.purpose === "replica",
          );
        return new HttpPort(
          {
            endpoint: source.endpoint!,
            source: source.source!,
            token: await openSecret(
              source.secret!,
              env.STORAGE_ENCRYPTION_KEY || "",
            ),
          },
          generation,
          owner,
          source.kind,
        );
      },
      {
        id: "d1",
        name: "原始 Cloudflare D1",
        kind: "d1",
        created: new Date().toISOString(),
      },
    );
  }
  async fetch(request: Request) {
    try {
      const body = (await request.json()) as any,
        path = new URL(request.url).pathname;
      let data: unknown;
      if (path === "/data/find")
        data = await this.coordinator.find(tableName(body.table), body.query);
      else if (path === "/data/count")
        data = await this.coordinator.count(tableName(body.table), body.where);
      else if (path === "/data/mutate")
        data = await this.coordinator.mutate(body.mutations);
      else if (path === "/auth/settings")
        data = await this.coordinator.security();
      else if (path === "/status") data = await this.coordinator.status();
      else if (path === "/backup/restore")
        data = await this.coordinator.restoreBackup(body);
      else if (path === "/sources/add")
        data = await this.coordinator.addSource(body as Source);
      else if (path === "/sources/update")
        data = await this.coordinator.updateSource(body.id, body.patch);
      else if (path === "/sources/delete")
        data = await this.coordinator.deleteSource(body.id);
      else if (path === "/sources/health")
        data = await this.coordinator.health(body.id);
      else if (path === "/sync/start")
        data = await this.coordinator.start(
          body.id,
          body.autoSwitch !== false,
          body.mode,
        );
      else if (path === "/sync/retry") data = await this.coordinator.retry();
      else if (path === "/sync/cancel") data = await this.coordinator.cancel();
      else return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      return Response.json({ data: data ?? null });
    } catch (error) {
      if (error instanceof StorageError)
        return Response.json(
          { error: error.code, message: error.message },
          { status: error.status },
        );
      console.error("Storage coordinator failed", {
        type: error instanceof Error ? error.name : "Error",
      });
      return Response.json(
        {
          error: "STORAGE_UNAVAILABLE",
          message: "数据存储暂时不可用，请检查数据源连接和数据库迁移状态",
        },
        { status: 503 },
      );
    }
  }
  async alarm() {
    await this.coordinator.step();
  }
}
