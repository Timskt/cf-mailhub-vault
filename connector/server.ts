import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { timingSafeEqual } from "node:crypto";
import {
  digest,
  fieldName,
  rowKey,
  StorageError,
  tableName,
  validateRow,
  type Commit,
  type Filter,
  type Query,
  type Row,
  type Table,
} from "../src/storage/model";
import type { ConnectorSource } from "./adapters";
function same(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function filter(table: Table, value: Filter | undefined, depth = 0): void {
  if (!value) return;
  if (depth > 12)
    throw new StorageError("INVALID_FILTER", "Filter nesting too deep", 400);
  if ("and" in value || "or" in value) {
    const entries = "and" in value ? value.and : value.or;
    if (!Array.isArray(entries) || entries.length > 1000)
      throw new StorageError("INVALID_FILTER", "Invalid filter", 400);
    entries.forEach((v) => filter(table, v, depth + 1));
  } else if ("not" in value) filter(table, value.not, depth + 1);
  else {
    fieldName(table, value.field);
    if (
      ![
        "eq",
        "ne",
        "lt",
        "lte",
        "gt",
        "gte",
        "contains",
        "ends",
        "ieq",
        "in",
        "dateLt",
        "dateGte",
      ].includes(value.op)
    )
      throw new StorageError("INVALID_FILTER", "Invalid filter operator", 400);
  }
}
function query(table: Table, value: Query = {}) {
  filter(table, value.where);
  if (
    value.limit !== undefined &&
    (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 10001)
  )
    throw new StorageError("INVALID_LIMIT", "Invalid query limit", 400);
  if (
    value.offset !== undefined &&
    (!Number.isInteger(value.offset) ||
      value.offset < 0 ||
      value.offset > 10000000)
  )
    throw new StorageError("INVALID_OFFSET", "Invalid query offset", 400);
  value.columns?.forEach((k) => fieldName(table, k));
  value.order?.forEach(([k, dir]) => {
    fieldName(table, k);
    if (!["asc", "desc"].includes(dir))
      throw new StorageError("INVALID_ORDER", "Invalid order", 400);
  });
}
export function connectorApp(sources: ConnectorSource[], token: string) {
  if (token.length < 32)
    throw new Error("CONNECTOR_TOKEN must contain at least 32 characters");
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.use("/v1/*", async (c, next) => {
    if (!same(c.req.header("Authorization") || "", `Bearer ${token}`))
      return c.json({ code: "UNAUTHORIZED" }, 401);
    return next();
  });
  app.use("/v1/*", bodyLimit({ maxSize: 12 * 1024 * 1024 }));
  app.get("/v1/sources", (c) =>
    c.json({
      data: sources.map((s) => ({
        id: s.config.id,
        name: s.config.name,
        kind: s.config.kind,
      })),
    }),
  );
  app.post("/v1/data", async (c) => {
    const body = await c.req.json();
    const source = sources.find((s) => s.config.id === body.source);
    if (!source) return c.json({ code: "SOURCE_NOT_FOUND" }, 404);
    if (
      typeof body.generation !== "string" ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(body.generation) ||
      typeof body.owner !== "string" ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(body.owner)
    )
      return c.json({ code: "INVALID_DATASET" }, 400);
    const port = source.port(body.generation, body.owner),
      data = body.data || {};
    let result: unknown;
    switch (body.op) {
      case "health":
        await source.health();
        result = { healthy: true, kind: source.config.kind };
        break;
      case "initialize":
        if (
          !Number.isSafeInteger(data.version) ||
          data.version < 0 ||
          typeof data.hash !== "string" ||
          !data.counters ||
          typeof data.counters !== "object"
        )
          throw new StorageError("INVALID_REVISION", "Invalid revision", 400);
        await port.initialize(data);
        result = null;
        break;
      case "info":
        result = await port.info();
        break;
      case "find": {
        const table = tableName(data.table);
        query(table, data.query);
        result = await port.find(table, data.query);
        break;
      }
      case "count": {
        const table = tableName(data.table);
        filter(table, data.where);
        result = await port.count(table, data.where);
        break;
      }
      case "page": {
        const table = tableName(data.table);
        if (
          data.cursor &&
          (typeof data.cursor !== "string" || data.cursor.length > 512)
        )
          throw new StorageError("INVALID_CURSOR", "Invalid cursor", 400);
        const limit = data.limit ?? 100;
        if (!Number.isInteger(limit) || limit < 1 || limit > 500)
          throw new StorageError("INVALID_LIMIT", "Invalid page limit", 400);
        result = await port.page(table, data.cursor, limit);
        break;
      }
      case "copy": {
        const table = tableName(data.table);
        if (!Array.isArray(data.rows) || data.rows.length > 500)
          throw new StorageError("INVALID_ROWS", "Invalid copy size", 400);
        data.rows.forEach((row: Row) => validateRow(table, row));
        await port.copy(table, data.rows);
        result = null;
        break;
      }
      case "commit": {
        const commit = data as Commit;
        if (
          !Number.isSafeInteger(commit.expected) ||
          commit.expected < 0 ||
          commit.version !== commit.expected + 1 ||
          !Array.isArray(commit.changes) ||
          commit.changes.length > 20000 ||
          !/^[a-f0-9]{64}$/.test(commit.hash)
        )
          throw new StorageError("INVALID_COMMIT", "Invalid commit", 400);
        for (const change of commit.changes) {
          const table = tableName(change.table);
          if (typeof change.key !== "string" || change.key.length > 512)
            throw new StorageError("INVALID_KEY", "Invalid key", 400);
          if (change.row) {
            validateRow(table, change.row);
            if (rowKey(table, change.row) !== change.key)
              throw new StorageError("INVALID_KEY", "Key mismatch", 400);
          }
        }
        if (
          (await digest({
            expected: commit.expected,
            version: commit.version,
            counters: commit.counters,
            changes: commit.changes,
          })) !== commit.hash
        )
          throw new StorageError(
            "INVALID_DIGEST",
            "Commit digest mismatch",
            400,
          );
        await port.commit(commit);
        result = null;
        break;
      }
      default:
        return c.json({ code: "INVALID_OPERATION" }, 400);
    }
    return c.json({ data: result });
  });
  app.onError((error, c) => {
    if (error instanceof StorageError)
      return c.json({ code: error.code }, error.status as 400);
    // Driver errors may contain DSNs and values; never forward or log their message.
    console.error("Connector operation failed", { type: error.name });
    return c.json({ code: "DATABASE_ERROR" }, 503);
  });
  return app;
}
