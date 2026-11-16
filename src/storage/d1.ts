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
  type Page,
  type Query,
  type Revision,
  type Row,
  type Table,
  type Value,
} from "./model";

export function sqlFilter(
  table: Table,
  filter: Filter | undefined,
  field: (name: string) => string,
  values: Value[],
): string {
  if (!filter) return "1=1";
  if ("and" in filter || "or" in filter) {
    const parts = "and" in filter ? filter.and : filter.or;
    return parts.length
      ? `(${parts.map((f) => sqlFilter(table, f, field, values)).join("and" in filter ? " AND " : " OR ")})`
      : "and" in filter
        ? "1=1"
        : "1=0";
  }
  if ("not" in filter)
    return `NOT (${sqlFilter(table, filter.not, field, values)})`;
  const column = field(fieldName(table, filter.field));
  if (filter.op === "in") {
    const list = filter.value as Value[];
    // JSON input avoids SQLite's 100 bound-parameter limit.
    values.push(JSON.stringify(list));
    return `${column} IN (SELECT value FROM json_each(?))`;
  }
  const value = filter.value as Value;
  if (value === null)
    return `${column} IS ${filter.op === "ne" ? "NOT " : ""}NULL`;
  if (filter.op === "contains" || filter.op === "ends") {
    values.push(
      (filter.op === "contains" ? "%" : "%") +
        String(value)
          .replaceAll("\\", "\\\\")
          .replaceAll("%", "\\%")
          .replaceAll("_", "\\_") +
        (filter.op === "contains" ? "%" : ""),
    );
    return `${column} LIKE ? ESCAPE '\\'`;
  }
  values.push(value);
  if (filter.op === "ieq") return `lower(${column}) = lower(?)`;
  if (filter.op === "dateLt" || filter.op === "dateGte")
    return `julianday(${column}) ${filter.op === "dateLt" ? "<" : ">="} julianday(?)`;
  return `${column} ${{ eq: "=", ne: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=" }[filter.op]} ?`;
}
export class D1Port implements DataPort {
  constructor(
    private db: D1Database,
    readonly generation = "legacy",
  ) {}
  private field(table: Table, name: string) {
    fieldName(table, name);
    if (this.generation === "legacy") return `"${name}"`;
    const expression = `json_extract(body, '$.${name}')`;
    const fallback = readFallbacks[table]?.[name];
    return fallback === undefined
      ? expression
      : `COALESCE(${expression}, ${typeof fallback === "number" ? fallback : `'${fallback}'`})`;
  }
  private base(table: Table) {
    return this.generation === "legacy"
      ? { from: `"${table}"`, where: "1=1", values: [] as Value[] }
      : {
          from: "storage_rows",
          where: "generation = ? AND table_name = ?",
          values: [this.generation, table] as Value[],
        };
  }
  async info(): Promise<Revision> {
    const meta = await this.db
      .prepare(
        "SELECT version, hash, counters FROM storage_meta WHERE generation = ?",
      )
      .bind(this.generation)
      .first<{ version: number; hash: string; counters: string }>();
    if (!meta) throw new StorageError("DATASET_MISSING", "数据集尚未初始化");
    const counters = JSON.parse(meta.counters);
    if (this.generation === "legacy") {
      const { results } = await this.db
        .prepare("SELECT name, seq FROM sqlite_sequence")
        .all<{ name: string; seq: number }>();
      for (const row of results)
        if (Object.hasOwn(schema, row.name))
          counters[row.name] = Math.max(counters[row.name] || 0, row.seq);
    }
    return { ...meta, counters };
  }
  async initialize(revision: Revision) {
    await this.db
      .prepare(
        "INSERT INTO storage_meta (generation, version, hash, counters) VALUES (?, ?, ?, ?) ON CONFLICT(generation) DO NOTHING",
      )
      .bind(
        this.generation,
        revision.version,
        revision.hash,
        JSON.stringify(revision.counters),
      )
      .run();
  }
  async health() {
    await this.db.prepare("SELECT count(*) AS n FROM storage_meta").first();
  }
  async find(table: Table, query: Query = {}) {
    const base = this.base(table),
      values = base.values;
    const where = sqlFilter(
      table,
      query.where,
      (n) => this.field(table, n),
      values,
    );
    const columns =
      query.columns
        ?.map((n) => `${this.field(table, n)} AS "${n}"`)
        .join(", ") || (this.generation === "legacy" ? "*" : "body");
    const order = query.order
      ?.map(
        ([name, dir]) =>
          `${this.field(table, name)} ${dir === "desc" ? "DESC" : "ASC"}`,
      )
      .join(", ");
    const { results } = await this.db
      .prepare(
        `SELECT ${columns} FROM ${base.from} WHERE ${base.where} AND ${where}${order ? ` ORDER BY ${order}` : ""} LIMIT ? OFFSET ?`,
      )
      .bind(...values, query.limit ?? 10000, query.offset || 0)
      .all<Row>();
    return this.generation === "legacy" || query.columns
      ? results
      : results.map((r) => readRow(table, JSON.parse(String(r.body)) as Row));
  }
  async count(table: Table, where?: Filter) {
    const base = this.base(table),
      clause = sqlFilter(
        table,
        where,
        (n) => this.field(table, n),
        base.values,
      );
    return (await this.db
      .prepare(
        `SELECT count(*) AS n FROM ${base.from} WHERE ${base.where} AND ${clause}`,
      )
      .bind(...base.values)
      .first<{ n: number }>())!.n;
  }
  async page(
    table: Table,
    cursor: string | null = null,
    limit = 100,
  ): Promise<Page> {
    const base = this.base(table);
    const key =
      this.generation === "legacy"
        ? `json_array(${schema[table].key.map((k) => `"${k}"`).join(",")})`
        : "row_key";
    const { results } = await this.db
      .prepare(
        `SELECT ${this.generation === "legacy" ? "*" : "body"}, ${key} AS __key FROM ${base.from} WHERE ${base.where} AND ${key} > ? ORDER BY ${key} COLLATE BINARY LIMIT ?`,
      )
      .bind(...base.values, cursor || "", limit + 1)
      .all<Row>();
    const selected: Row[] = [];
    let size = 0;
    for (const row of results.slice(0, limit)) {
      const { __key, ...fields } = row;
      const data =
        this.generation === "legacy" ? fields : JSON.parse(String(row.body));
      size += JSON.stringify(data).length;
      if (selected.length && size > 1500000) break;
      selected.push(data);
    }
    return {
      rows: selected,
      cursor:
        results.length > selected.length
          ? rowKey(table, selected[selected.length - 1])
          : null,
    };
  }
  private writes(changes: Commit["changes"]) {
    const statements: D1PreparedStatement[] = [];
    if (this.generation !== "legacy") {
      for (let i = 0; i < changes.length; i += 20) {
        const rows = changes.slice(i, i + 20).filter((c) => c.row);
        if (rows.length)
          statements.push(
            this.db
              .prepare(
                `INSERT INTO storage_rows(generation, table_name, row_key, body) VALUES ${rows.map(() => "(?,?,?,?)").join(",")} ON CONFLICT(generation, table_name, row_key) DO UPDATE SET body = excluded.body`,
              )
              .bind(
                ...rows.flatMap((c) => [
                  this.generation,
                  c.table,
                  c.key,
                  JSON.stringify(c.row),
                ]),
              ),
          );
        for (const c of changes.slice(i, i + 20).filter((c) => !c.row))
          statements.push(
            this.db
              .prepare(
                "DELETE FROM storage_rows WHERE generation=? AND table_name=? AND row_key=?",
              )
              .bind(this.generation, c.table, c.key),
          );
      }
    } else {
      // Native D1 tables are preserved during rollout, including foreign keys.
      for (let i = 0; i < changes.length;) {
        const c = changes[i];
        const fields = schema[c.table].key;
        if (!c.row) {
          const deletes = [];
          while (
            i < changes.length &&
            changes[i].table === c.table &&
            !changes[i].row &&
            deletes.length < 200
          )
            deletes.push(changes[i++].key);
          statements.push(
            this.db
              .prepare(
                `DELETE FROM "${c.table}" WHERE json_array(${fields.map((k) => `"${k}"`).join(",")}) IN (SELECT value FROM json_each(?))`,
              )
              .bind(JSON.stringify(deletes)),
          );
        } else {
          const columns = Object.keys(c.row),
            group = [],
            max = Math.max(1, Math.floor(95 / columns.length));
          while (
            i < changes.length &&
            changes[i].table === c.table &&
            changes[i].row &&
            Object.keys(changes[i].row!).join(",") === columns.join(",") &&
            group.length < max
          )
            group.push(changes[i++].row!);
          statements.push(
            this.db
              .prepare(
                `INSERT INTO "${c.table}" (${columns.map((k) => `"${k}"`).join(",")}) VALUES ${group.map(() => `(${columns.map(() => "?").join(",")})`).join(",")}
            ON CONFLICT(${fields.map((k) => `"${k}"`).join(",")}) DO UPDATE SET ${
              columns
                .filter((k) => !fields.includes(k))
                .map((k) => `"${k}" = excluded."${k}"`)
                .join(",") || `${fields[0]}=excluded.${fields[0]}`
            }`,
              )
              .bind(...group.flatMap((row) => columns.map((k) => row[k]))),
          );
        }
      }
    }
    return statements;
  }
  async commit(commit: Commit) {
    const current = await this.info();
    if (current.version === commit.version && current.hash === commit.hash)
      return;
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO storage_guard(value) SELECT CASE WHEN version = ? THEN 1 ELSE 0 END FROM storage_meta WHERE generation = ?",
        )
        .bind(commit.expected, this.generation),
      ...this.writes(commit.changes),
      this.db
        .prepare(
          "UPDATE storage_meta SET version = ?, hash = ?, counters = ? WHERE generation = ?",
        )
        .bind(
          commit.version,
          commit.hash,
          JSON.stringify(commit.counters),
          this.generation,
        ),
      this.db.prepare("DELETE FROM storage_guard"),
    ]);
  }
  async copy(table: Table, rows: Row[]) {
    if (this.generation === "legacy")
      throw new StorageError("LEGACY_COPY_FORBIDDEN", "不能覆盖原始数据集");
    if (rows.length)
      await this.db.batch(
        this.writes(
          rows.map((row) => ({ table, key: rowKey(table, row), row })),
        ),
      );
  }
}
