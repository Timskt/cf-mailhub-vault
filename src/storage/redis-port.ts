import {
  matches,
  queryRows,
  rowKey,
  readRow,
  StorageError,
  type Commit,
  type DataPort,
  type Filter,
  type Query,
  type Revision,
  type Row,
  type Table,
} from "./model";
import { check, revision, pageRows } from "./port-utils";
export interface RedisCommands {
  hget(key: string, field: string): Promise<string | null>;
  hsetnx(key: string, field: string, value: string): Promise<number>;
  hscan(
    key: string,
    cursor: string,
    match: "MATCH",
    pattern: string,
    count: "COUNT",
    size: number,
  ): Promise<[string, string[]]>;
  eval(script: string, keys: number, ...args: string[]): Promise<unknown>;
}
// One HSET mutates records, deletion tombstones and the revision together. Redis Lua
// scripts do not roll back earlier commands on runtime errors, so never spread a
// commit across several HSET/HDEL/ZADD calls.
const REDIS_WRITE = `
local raw = redis.call('HGET', KEYS[1], '__meta')
if not raw then return redis.error_reply('DATASET_MISSING') end
local meta = cjson.decode(raw)
if meta.owner ~= ARGV[1] then return redis.error_reply('OWNER_CONFLICT') end
local payload = cjson.decode(ARGV[2])
if ARGV[3] == 'commit' then
  if meta.version == payload.version and meta.hash == payload.hash then return 'ok' end
  if meta.version ~= payload.expected or payload.version ~= payload.expected + 1 then return redis.error_reply('REVISION_CONFLICT') end
end
local values = {}
for _, change in ipairs(payload.changes) do
  table.insert(values, change.field)
  table.insert(values, change.value)
end
if ARGV[3] == 'commit' then
  table.insert(values, '__meta'); table.insert(values, ARGV[4])
end
if #values > 0 then redis.call('HSET', KEYS[1], unpack(values)) end
return 'ok'`;
export class RedisPort implements DataPort {
  constructor(
    private redis: RedisCommands,
    private prefix: string,
    private owner: string,
    readonly health: () => Promise<void>,
  ) {}
  private async meta() {
    const raw = await this.redis.hget(`${this.prefix}dataset-v1`, "__meta");
    return check(raw ? JSON.parse(raw) : null, this.owner);
  }
  async info() {
    return revision(await this.meta());
  }
  async initialize(rev: Revision) {
    await this.redis.hsetnx(
      `${this.prefix}dataset-v1`,
      "__meta",
      JSON.stringify({ ...rev, owner: this.owner }),
    );
    await this.meta();
  }
  async page(table: Table, cursor: string | null = null, limit = 100) {
    const rows = (await this.scan(table)).filter(
      (row) => rowKey(table, row) > (cursor || ""),
    );
    rows.sort((a, b) => {
      const x = rowKey(table, a),
        y = rowKey(table, b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return pageRows(rows.slice(0, limit + 1), table, limit);
  }
  private async scan(table: Table) {
    await this.meta();
    const rows = new Map<string, Row>();
    let cursor = "0",
      seen = 0;
    do {
      const result = await this.redis.hscan(
        `${this.prefix}dataset-v1`,
        cursor,
        "MATCH",
        `${table}|*`,
        "COUNT",
        500,
      );
      cursor = result[0];
      for (let i = 0; i < result[1].length; i += 2) {
        seen++;
        if (result[1][i + 1])
          rows.set(result[1][i], JSON.parse(result[1][i + 1]));
      }
      if (seen > 100000)
        throw new StorageError(
          "REDIS_SCAN_LIMIT",
          "Redis查询超过十万条（含删除记录），请切换到MySQL或MongoDB",
          413,
        );
    } while (cursor !== "0");
    return [...rows.values()];
  }
  async find(table: Table, query?: Query) {
    return queryRows(
      (await this.scan(table)).map((row) => readRow(table, row)),
      query,
    );
  }
  async count(table: Table, where?: Filter) {
    return (await this.scan(table)).filter((row) =>
      matches(readRow(table, row), where),
    ).length;
  }
  private async apply(
    payload: { changes: Commit["changes"] } & Partial<Commit>,
    mode: string,
  ) {
    if (payload.changes.length > 2000)
      throw new StorageError(
        "BATCH_TOO_LARGE",
        "A commit supports at most 2000 row changes",
        413,
      );
    const command = {
      expected: payload.expected,
      version: payload.version,
      hash: payload.hash,
      changes: payload.changes.map((c) => ({
        field: `${c.table}|${c.key}`,
        value: c.row ? JSON.stringify(c.row) : "",
      })),
    };
    const meta =
      mode === "commit"
        ? JSON.stringify({
            version: payload.version,
            hash: payload.hash,
            counters: payload.counters,
            owner: this.owner,
          })
        : "";
    try {
      await this.redis.eval(
        REDIS_WRITE,
        1,
        `${this.prefix}dataset-v1`,
        this.owner,
        JSON.stringify(command),
        mode,
        meta,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        /OWNER_CONFLICT|REVISION_CONFLICT/.test(error.message)
      )
        throw new StorageError(
          "REVISION_CONFLICT",
          "Redis owner or revision mismatch",
          409,
        );
      throw error;
    }
  }
  commit(commit: Commit) {
    return this.apply(commit, "commit");
  }
  copy(table: Table, rows: Row[]) {
    return this.apply(
      { changes: rows.map((row) => ({ table, key: rowKey(table, row), row })) },
      "copy",
    );
  }
}
