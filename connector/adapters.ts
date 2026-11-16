import {
  check,
  revision,
  pageRows,
  type Meta,
} from "../src/storage/port-utils";
import { RedisPort } from "../src/storage/redis-port";
import Redis from "ioredis";
import {
  MongoClient,
  type ClientSession,
  type Db,
  type Document,
} from "mongodb";
import mysql, {
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from "mysql2/promise";
import {
  fieldName,
  rowKey,
  schema,
  readFallbacks,
  readRow,
  StorageError,
  type Commit,
  type DataPort,
  type Filter,
  type Query,
  type Revision,
  type Row,
  type Table,
  type Value,
} from "../src/storage/model";
export interface SourceConfig {
  id: string;
  name: string;
  kind: "mysql" | "mongodb" | "redis";
  url: string;
  database?: string;
  prefix?: string;
  tls?: boolean;
}
function shouldApply(meta: Meta, commit: Commit) {
  if (meta.version === commit.version && meta.hash === commit.hash)
    return false;
  if (
    meta.version !== commit.expected ||
    commit.version !== commit.expected + 1
  )
    throw new StorageError("REVISION_CONFLICT", "Revision mismatch", 409);
  return true;
}
export interface ConnectorSource {
  config: SourceConfig;
  port(generation: string, owner: string): DataPort;
  close(): Promise<void>;
  health(): Promise<void>;
}

function myField(table: Table, field: string) {
  fieldName(table, field);
  const extract = `JSON_EXTRACT(body, '$.${field}')`;
  const raw = `CASE WHEN JSON_TYPE(${extract}) = 'NULL' THEN NULL ELSE JSON_UNQUOTE(${extract}) END`;
  const fallback = readFallbacks[table]?.[field];
  const value =
    fallback === undefined ? raw : `COALESCE(${raw}, '${fallback}')`;
  return typeof (schema[table].fields as Row)[field] === "number" ||
    field === "associated_vault_id"
    ? `CAST((${value}) AS SIGNED)`
    : `(${value})`;
}
function myWhere(
  table: Table,
  f: Filter | undefined,
  params: unknown[],
): string {
  if (!f) return "1=1";
  if ("and" in f || "or" in f) {
    const items = "and" in f ? f.and : f.or;
    return items.length
      ? `(${items.map((x) => myWhere(table, x, params)).join("and" in f ? " AND " : " OR ")})`
      : "and" in f
        ? "1=1"
        : "1=0";
  }
  if ("not" in f) return `NOT (${myWhere(table, f.not, params)})`;
  const field = myField(table, f.field),
    value = f.value;
  if (f.op === "in") {
    const list = value as Value[];
    if (!list.length) return "1=0";
    params.push(...list);
    return `${field} IN (${list.map(() => "?").join(",")})`;
  }
  if (value === null) return `${field} IS ${f.op === "ne" ? "NOT " : ""}NULL`;
  if (f.op === "contains") {
    params.push(value);
    return `LOCATE(LOWER(?), LOWER(${field})) > 0`;
  }
  if (f.op === "ends") {
    params.push(value, value);
    return `LOWER(RIGHT(${field}, CHAR_LENGTH(?))) = LOWER(?)`;
  }
  params.push(value);
  if (f.op === "ieq") return `LOWER(${field}) = LOWER(?)`;
  if (f.op === "dateLt" || f.op === "dateGte")
    return `CAST(REPLACE(REPLACE(${field},'T',' '),'Z','') AS DATETIME(3)) ${f.op === "dateLt" ? "<" : ">="} CAST(REPLACE(REPLACE(?,'T',' '),'Z','') AS DATETIME(3))`;
  return `${field} ${{ eq: "=", ne: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=" }[f.op]} ?`;
}
export async function mysqlSource(
  config: SourceConfig,
): Promise<ConnectorSource> {
  const pool = mysql.createPool({
    uri: config.url,
    connectionLimit: 4,
    connectTimeout: 5000,
    enableKeepAlive: true,
    decimalNumbers: true,
    charset: "utf8mb4_bin",
    ...(config.tls ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS mailhub_meta_v1 (generation VARCHAR(64) COLLATE utf8mb4_bin PRIMARY KEY, body JSON NOT NULL) ENGINE=InnoDB`,
  );
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS mailhub_rows_v1 (generation VARCHAR(64) COLLATE utf8mb4_bin NOT NULL, table_name VARCHAR(40) COLLATE utf8mb4_bin NOT NULL, row_key VARCHAR(512) COLLATE utf8mb4_bin NOT NULL, body JSON NOT NULL, PRIMARY KEY(generation, table_name, row_key)) ENGINE=InnoDB`,
  );
  const health = async () => {
    await pool.query("SELECT 1");
  };
  return {
    config,
    close: () => pool.end(),
    health,
    port: (generation, owner) => new MySQLPort(pool, generation, owner, health),
  };
}
class MySQLPort implements DataPort {
  constructor(
    private pool: Pool,
    private gen: string,
    private owner: string,
    readonly health: () => Promise<void>,
  ) {}
  private async meta(
    connection: Pool | PoolConnection = this.pool,
    lock = false,
  ): Promise<Meta> {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT body FROM mailhub_meta_v1 WHERE generation = ?${lock ? " FOR UPDATE" : ""}`,
      [this.gen],
    );
    return check(rows[0]?.body as Meta, this.owner);
  }
  async info() {
    return revision(await this.meta());
  }
  async initialize(rev: Revision) {
    await this.pool.execute(
      "INSERT IGNORE INTO mailhub_meta_v1(generation,body) VALUES (?,?)",
      [this.gen, JSON.stringify({ ...rev, owner: this.owner })],
    );
    await this.meta();
  }
  async find(table: Table, query: Query = {}) {
    await this.meta();
    const params: unknown[] = [this.gen, table],
      clause = myWhere(table, query.where, params);
    const order = query.order
      ?.map(
        ([field, dir]) =>
          `${myField(table, field)} ${dir === "desc" ? "DESC" : "ASC"}`,
      )
      .join(",");
    params.push(query.limit ?? 10000, query.offset || 0);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT body FROM mailhub_rows_v1 WHERE generation=? AND table_name=? AND ${clause}${order ? ` ORDER BY ${order}` : ""} LIMIT ? OFFSET ?`,
      params,
    );
    return rows
      .map((r) => readRow(table, r.body as Row))
      .map((row) =>
        query.columns
          ? Object.fromEntries(query.columns.map((k) => [k, row[k]]))
          : row,
      );
  }
  async count(table: Table, where?: Filter) {
    await this.meta();
    const params: unknown[] = [this.gen, table],
      clause = myWhere(table, where, params);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT count(*) AS n FROM mailhub_rows_v1 WHERE generation=? AND table_name=? AND ${clause}`,
      params,
    );
    return Number(rows[0].n);
  }
  async page(table: Table, cursor: string | null = null, limit = 100) {
    await this.meta();
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT body FROM mailhub_rows_v1 WHERE generation=? AND table_name=? AND row_key > ? ORDER BY row_key LIMIT ?",
      [this.gen, table, cursor || "", limit + 1],
    );
    return pageRows(
      rows.map((r) => r.body),
      table,
      limit,
    );
  }
  private async writes(conn: PoolConnection, changes: Commit["changes"]) {
    for (const change of changes) {
      if (change.row)
        await conn.execute(
          "INSERT INTO mailhub_rows_v1(generation,table_name,row_key,body) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE body=VALUES(body)",
          [this.gen, change.table, change.key, JSON.stringify(change.row)],
        );
      else
        await conn.execute(
          "DELETE FROM mailhub_rows_v1 WHERE generation=? AND table_name=? AND row_key=?",
          [this.gen, change.table, change.key],
        );
    }
  }
  private async transaction(
    fn: (conn: PoolConnection, meta: Meta) => Promise<void>,
  ) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await fn(conn, await this.meta(conn, true));
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }
  commit(commit: Commit) {
    return this.transaction(async (conn, meta) => {
      if (!shouldApply(meta, commit)) return;
      await this.writes(conn, commit.changes);
      await conn.execute(
        "UPDATE mailhub_meta_v1 SET body=? WHERE generation=?",
        [JSON.stringify({ ...revision(commit), owner: this.owner }), this.gen],
      );
    });
  }
  copy(table: Table, rows: Row[]) {
    return this.transaction(async (conn) =>
      this.writes(
        conn,
        rows.map((row) => ({ table, key: rowKey(table, row), row })),
      ),
    );
  }
}

function mongoWhere(table: Table, filter?: Filter): Document {
  if (!filter) return {};
  if ("and" in filter)
    return filter.and.length
      ? { $and: filter.and.map((f) => mongoWhere(table, f)) }
      : {};
  if ("or" in filter)
    return filter.or.length
      ? { $or: filter.or.map((f) => mongoWhere(table, f)) }
      : { $expr: false };
  if ("not" in filter) return { $nor: [mongoWhere(table, filter.not)] };
  fieldName(table, filter.field);
  const field = `body.${filter.field}`;
  const fallback = readFallbacks[table]?.[filter.field];
  if (
    fallback !== undefined &&
    ["eq", "ne", "in", "lt", "lte", "gt", "gte"].includes(filter.op)
  )
    return {
      $expr: {
        [`$${filter.op}`]: [
          { $ifNull: [`$${field}`, fallback] },
          { $literal: filter.value },
        ],
      },
    };
  const escaped = String(filter.value ?? "").replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  if (filter.op === "contains" || filter.op === "ends" || filter.op === "ieq")
    return {
      [field]: {
        $regex:
          (filter.op === "ieq" ? "^" : "") +
          escaped +
          (filter.op === "contains" ? "" : "$"),
        $options: "i",
      },
    };
  if (filter.op === "dateLt" || filter.op === "dateGte")
    return {
      $expr: {
        [filter.op === "dateLt" ? "$lt" : "$gte"]: [
          {
            $convert: {
              input: `$${field}`,
              to: "date",
              onError: null,
              onNull: null,
            },
          },
          new Date(String(filter.value)),
        ],
      },
      [field]: { $nin: ["", null] },
    };
  return {
    [field]: {
      [{
        eq: "$eq",
        ne: "$ne",
        lt: "$lt",
        lte: "$lte",
        gt: "$gt",
        gte: "$gte",
        in: "$in",
      }[filter.op] as string]: filter.value,
    },
  };
}
export async function mongoSource(
  config: SourceConfig,
): Promise<ConnectorSource> {
  const client = new MongoClient(config.url, {
    maxPoolSize: 4,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    socketTimeoutMS: 10000,
    retryWrites: true,
  });
  await client.connect();
  const database = client.db(config.database);
  const hello = await database.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== "isdbgrid") {
    await client.close();
    throw new Error("MongoDB requires a replica set for transactional commits");
  }
  await database
    .collection("mailhub_meta_v1")
    .createIndex({ generation: 1 }, { unique: true });
  await database
    .collection("mailhub_rows_v1")
    .createIndex(
      { generation: 1, table: 1, key: 1 },
      { unique: true, collation: { locale: "simple" } },
    );
  const health = async () => {
    await database.command({ ping: 1 });
  };
  return {
    config,
    close: () => client.close(),
    health,
    port: (generation, owner) =>
      new MongoPort(client, database, generation, owner, health),
  };
}
class MongoPort implements DataPort {
  constructor(
    private client: MongoClient,
    private database: Db,
    private gen: string,
    private owner: string,
    readonly health: () => Promise<void>,
  ) {}
  private get rows() {
    return this.database.collection("mailhub_rows_v1");
  }
  private get metas() {
    return this.database.collection("mailhub_meta_v1");
  }
  private async meta(session?: ClientSession) {
    const doc = await this.metas.findOne({ generation: this.gen }, { session });
    return check(doc?.body as Meta, this.owner);
  }
  async info() {
    return revision(await this.meta());
  }
  async initialize(rev: Revision) {
    await this.metas.updateOne(
      { generation: this.gen },
      { $setOnInsert: { body: { ...rev, owner: this.owner } } },
      { upsert: true, writeConcern: { w: "majority" } },
    );
    await this.meta();
  }
  async find(table: Table, query: Query = {}) {
    await this.meta();
    let cursor = this.rows.find({
      generation: this.gen,
      table,
      ...mongoWhere(table, query.where),
    });
    if (query.order)
      cursor = cursor.sort(
        Object.fromEntries(
          query.order.map(([field, dir]) => {
            fieldName(table, field);
            return [`body.${field}`, dir === "asc" ? 1 : -1];
          }),
        ),
      ) as typeof cursor;
    const rows = await cursor
      .skip(query.offset || 0)
      .limit(query.limit ?? 10000)
      .toArray();
    return rows
      .map((r) => readRow(table, r.body as Row))
      .map((row) =>
        query.columns
          ? Object.fromEntries(query.columns.map((k) => [k, row[k]]))
          : row,
      );
  }
  async count(table: Table, where?: Filter) {
    await this.meta();
    return this.rows.countDocuments({
      generation: this.gen,
      table,
      ...mongoWhere(table, where),
    });
  }
  async page(table: Table, cursor: string | null = null, limit = 100) {
    await this.meta();
    const rows = await this.rows
      .find({ generation: this.gen, table, key: { $gt: cursor || "" } })
      .sort({ key: 1 })
      .collation({ locale: "simple" })
      .limit(limit + 1)
      .toArray();
    return pageRows(
      rows.map((r) => r.body),
      table,
      limit,
    );
  }
  private async writes(session: ClientSession, changes: Commit["changes"]) {
    if (!changes.length) return;
    await this.rows.bulkWrite(
      changes.map((c) =>
        c.row
          ? {
              replaceOne: {
                filter: { generation: this.gen, table: c.table, key: c.key },
                replacement: {
                  generation: this.gen,
                  table: c.table,
                  key: c.key,
                  body: c.row,
                },
                upsert: true,
              },
            }
          : {
              deleteOne: {
                filter: { generation: this.gen, table: c.table, key: c.key },
              },
            },
      ),
      { session },
    );
  }
  private async transaction(
    fn: (session: ClientSession, meta: Meta) => Promise<void>,
  ) {
    const session = this.client.startSession();
    try {
      await session.withTransaction(
        async () => fn(session, await this.meta(session)),
        {
          readConcern: { level: "snapshot" },
          writeConcern: { w: "majority" },
          maxCommitTimeMS: 10000,
        },
      );
    } finally {
      await session.endSession();
    }
  }
  commit(commit: Commit) {
    return this.transaction(async (session, meta) => {
      if (!shouldApply(meta, commit)) return;
      await this.writes(session, commit.changes);
      await this.metas.updateOne(
        { generation: this.gen },
        { $set: { body: { ...revision(commit), owner: this.owner } } },
        { session },
      );
    });
  }
  copy(table: Table, rows: Row[]) {
    return this.transaction(async (session) =>
      this.writes(
        session,
        rows.map((row) => ({ table, key: rowKey(table, row), row })),
      ),
    );
  }
}

export async function redisSource(
  config: SourceConfig,
): Promise<ConnectorSource> {
  const redis = new Redis(config.url, {
    lazyConnect: true,
    connectTimeout: 5000,
    commandTimeout: 10000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(2000, times * 200),
  });
  let reportedConnectionError = false;
  redis.on("error", () => {
    if (!reportedConnectionError)
      console.warn("Redis connection unavailable", { source: config.id });
    reportedConnectionError = true;
  });
  redis.on("ready", () => {
    reportedConnectionError = false;
  });
  await redis.connect();
  const health = async () => {
    await redis.ping();
    const result = (await redis.config(
      "GET",
      "appendonly",
      "appendfsync",
      "maxmemory-policy",
    )) as string[];
    const flags = Object.fromEntries(
      Array.from({ length: result.length / 2 }, (_, i) => [
        result[i * 2],
        result[i * 2 + 1],
      ]),
    );
    if (
      flags.appendonly !== "yes" ||
      flags.appendfsync !== "always" ||
      flags["maxmemory-policy"] !== "noeviction"
    )
      throw new StorageError(
        "REDIS_DURABILITY_REQUIRED",
        "Redis primary storage requires appendonly yes, appendfsync always, maxmemory-policy noeviction",
      );
  };
  await health();
  return {
    config,
    close: async () => {
      redis.disconnect();
    },
    health,
    port: (generation, owner) =>
      new RedisPort(
        redis,
        `${config.prefix || "mailhub"}:{${generation}}:`,
        owner,
        health,
      ),
  };
}
export async function connectSource(
  config: SourceConfig,
): Promise<ConnectorSource> {
  if (config.kind === "mysql") return mysqlSource(config);
  if (config.kind === "mongodb") return mongoSource(config);
  if (config.kind === "redis") return redisSource(config);
  throw new Error("Unsupported source kind");
}
