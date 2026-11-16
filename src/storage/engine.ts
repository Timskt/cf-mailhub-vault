import {
  and,
  defaults,
  digest,
  eq,
  matches,
  oneOf,
  or,
  rowKey,
  schema,
  StorageError,
  validateRow,
  type Change,
  type Commit,
  type DataPort,
  type DataStore,
  type Filter,
  type Mutation,
  type MutationResult,
  type Query,
  type Row,
  type Table,
} from "./model";

// A plan is side-effect free. The coordinator persists it before calling the adapter's atomic commit.
export async function plan(
  port: DataPort,
  mutations: Mutation[],
): Promise<{ commit: Commit; results: MutationResult[] }> {
  const revision = await port.info();
  const counters = { ...revision.counters };
  const dirty = new Map<string, Change>();
  const results: MutationResult[] = [];
  const remember = (table: Table, row: Row, deleted = false) =>
    dirty.set(`${table}:${rowKey(table, row)}`, {
      table,
      key: rowKey(table, row),
      row: deleted ? null : row,
    });
  const queueObjectDeletion = (row: Row) => {
    if (typeof row.raw_object_key === "string" && row.raw_object_key)
      remember("mail_object_gc", {
        ...defaults("mail_object_gc"),
        key: row.raw_object_key,
        available_at: Date.now() + 7 * 86400000,
      });
  };
  async function find(table: Table, where?: Filter) {
    const rows = await port.find(table, { where, limit: 10001 });
    if (rows.length > 10000)
      throw new StorageError(
        "BATCH_TOO_LARGE",
        "单次操作超过一万条记录，请拆分操作",
        413,
      );
    const map = new Map(rows.map((r) => [rowKey(table, r), r]));
    for (const item of dirty.values())
      if (item.table === table) {
        map.delete(item.key);
        if (item.row && matches(item.row, where)) map.set(item.key, item.row);
      }
    return [...map.values()];
  }
  async function references(table: Table, rows: Row[]) {
    if (table === "cf_inbox_mails") {
      const keys = rows
        .map((row) => row.raw_object_key)
        .filter(
          (value): value is string => typeof value === "string" && !!value,
        );
      if (
        keys.length &&
        (
          await find(
            "mail_object_gc",
            and(oneOf("key", keys), eq("state", "deleting")),
          )
        ).length
      )
        throw new StorageError(
          "MAIL_OBJECT_EXPIRED",
          "原始邮件对象已进入回收，本次提交已取消，请重新上传",
          409,
        );
    }
    for (const [child, field, parent, parentKey] of [
      ["accounts", "group_id", "groups", "id"],
      ["account_tags", "account_id", "accounts", "id"],
      ["account_tags", "tag_id", "tags", "id"],
      ["push_state", "account_id", "accounts", "id"],
    ] as const) {
      if (table !== child || !rows.length) continue;
      const values = [...new Set(rows.map((row) => row[field]))];
      const parents = new Set(
        (await find(parent, oneOf(parentKey, values))).map(
          (row) => row[parentKey],
        ),
      );
      if (values.some((v) => !parents.has(v)))
        throw new StorageError(
          "REFERENCE_MISSING",
          "关联记录不存在，请刷新后重试",
          409,
        );
    }
  }
  for (const mutation of mutations) {
    const result: MutationResult = { rows: [], changes: 0, lastId: 0 };
    if (mutation.op === "assertExists") {
      if (
        (await find(mutation.table, mutation.where)).length <
        (mutation.minimum ?? 1)
      )
        throw new StorageError(
          "STALE_PREVIEW",
          mutation.message || "规则已变化，请重新预览后应用",
          409,
        );
    } else if (mutation.op === "confirmMailObject") {
      const linked = await find(
        "cf_inbox_mails",
        eq("raw_object_key", mutation.key),
      );
      if (linked.length) {
        const pending = await find("mail_object_gc", eq("key", mutation.key));
        if (!pending.length || pending.some((row) => row.state !== "pending"))
          throw new StorageError(
            "MAIL_OBJECT_EXPIRED",
            "原始邮件上传已过期，请重新上传",
            409,
          );
        for (const row of pending) remember("mail_object_gc", row, true);
      }
    } else if (mutation.op === "claimMailObject") {
      const pending = (
        await find(
          "mail_object_gc",
          and(eq("key", mutation.key), {
            field: "available_at",
            op: "lte",
            value: mutation.time,
          }),
        )
      )[0];
      if (pending) {
        if (
          (await find("cf_inbox_mails", eq("raw_object_key", mutation.key)))
            .length
        )
          remember("mail_object_gc", pending, true);
        else {
          const claimed = { ...pending, state: "deleting" };
          remember("mail_object_gc", claimed);
          result.rows.push(claimed);
          result.changes = 1;
        }
      }
    } else if (mutation.op === "bindMailbox") {
      // Resolve the generated vault ID inside the same atomic commit.
      const vault = (
        await find(
          "platform_vault",
          and(
            eq("account_email", mutation.address),
            eq("email_source", "cf_domain"),
          ),
        )
      ).sort((a, b) => Number(a.id) - Number(b.id))[0];
      const box = (
        await find("temp_mailboxes", eq("address", mutation.address))
      )[0];
      if (vault && !box)
        throw new StorageError("REFERENCE_MISSING", "关联邮箱不存在", 409);
      if (box) {
        const row = {
          ...box,
          associated_platform: vault?.platform_name || "",
          associated_vault_id: vault?.id ?? null,
          ...(vault ? { is_permanent: 1, expires_at: "" } : {}),
        };
        remember("temp_mailboxes", row);
        result.rows.push(row);
        result.changes++;
      }
      for (const mail of await find(
        "cf_inbox_mails",
        eq("recipient", mutation.address),
      )) {
        remember("cf_inbox_mails", {
          ...mail,
          is_protected: vault || box?.is_permanent ? 1 : 0,
        });
        result.changes++;
      }
    } else if (mutation.op === "throttle") {
      const existing = (
        await find("auth_attempts", eq("identity", mutation.identity))
      )[0];
      const reset = !existing || Number(existing.reset_at) <= mutation.time;
      const row = {
        identity: mutation.identity,
        attempts: reset ? 1 : Number(existing.attempts) + 1,
        reset_at: reset
          ? mutation.time + (mutation.windowSeconds ?? 900)
          : existing.reset_at,
      };
      remember("auth_attempts", row);
      result.rows.push(row);
      result.changes = 1;
    } else if (mutation.op === "cleanMail") {
      const candidates = await find(
        "cf_inbox_mails",
        and(
          oneOf("id", mutation.ids),
          eq("is_pinned", 0),
          eq("is_protected", 0),
        ),
      );
      const addresses = [...new Set(candidates.map((r) => r.recipient))];
      const boxes = await find(
        "temp_mailboxes",
        and(oneOf("address", addresses), eq("is_permanent", 1)),
      );
      const vaults = await find(
        "platform_vault",
        and(oneOf("account_email", addresses), eq("email_source", "cf_domain")),
      );
      const protectedAddresses = new Set([
        ...boxes.map((b) => b.address),
        ...vaults.map((v) => v.account_email),
      ]);
      for (const row of candidates)
        if (!protectedAddresses.has(row.recipient)) {
          remember("cf_inbox_mails", row, true);
          queueObjectDeletion(row);
          result.changes++;
        }
    } else if (mutation.op === "insert") {
      const { table } = mutation;
      const keys = [
        schema[table].key,
        ...schema[table].unique,
        ...(mutation.match ? [mutation.match] : []),
      ];
      const candidates = await find(
        table,
        or(
          ...keys.map((fields) =>
            and(
              ...fields.map((field) =>
                oneOf(
                  field,
                  mutation.rows
                    .map((row) => row[field])
                    .filter((v) => v !== undefined),
                ),
              ),
            ),
          ),
        ),
      );
      if (schema[table].auto && counters[table] === undefined) {
        const latest = await port.find(table, {
          order: [["id", "desc"]],
          limit: 1,
        });
        counters[table] = Number(latest[0]?.id || 0);
      }
      for (const input of mutation.rows) {
        const match = mutation.match;
        const prior = candidates.find((r) =>
          (match ? [match] : keys).some((fields) =>
            fields.every(
              (field) =>
                input[field] !== undefined && r[field] === input[field],
            ),
          ),
        );
        if (prior && mutation.conflict === "ignore") continue;
        if (prior && mutation.conflict !== "update")
          throw new StorageError("CONFLICT", "记录已存在", 409);
        let row: Row;
        if (prior) {
          const patch = mutation.patch ?? {
            ...input,
            ...mutation.onConflictSet,
          };
          row = { ...prior, ...patch };
          for (const field of mutation.keepNonEmpty || [])
            if (patch[field] === "") row[field] = prior[field];
          for (const field of schema[table].key) row[field] = prior[field];
        } else {
          row = { ...defaults(table), ...input };
          if (schema[table].auto && !row.id) row.id = ++counters[table];
          if (schema[table].auto)
            counters[table] = Math.max(counters[table] || 0, Number(row.id));
        }
        validateRow(table, row);
        if (
          candidates.some(
            (r) =>
              rowKey(table, r) !== rowKey(table, row) &&
              keys.some((fields) =>
                fields.every((field) => r[field] === row[field]),
              ),
          )
        )
          throw new StorageError("CONFLICT", "记录已存在", 409);
        remember(table, row);
        const index = candidates.findIndex(
          (r) => rowKey(table, r) === rowKey(table, row),
        );
        if (index >= 0) candidates[index] = row;
        else candidates.push(row);
        result.rows.push(row);
        result.changes++;
        result.lastId = Number(row.id || 0);
      }
      await references(table, result.rows);
    } else {
      const { table } = mutation;
      const rows = await find(table, mutation.where);
      for (const prior of rows) {
        if (mutation.op === "delete") {
          remember(table, prior, true);
          if (table === "cf_inbox_mails") queueObjectDeletion(prior);
          result.rows.push(prior);
        } else {
          const row = { ...prior, ...mutation.set };
          for (const [field, delta] of Object.entries(mutation.increment || {}))
            row[field] = Number(row[field]) + delta;
          for (const field of mutation.toggle || [])
            row[field] = row[field] ? 0 : 1;
          if (schema[table].key.some((field) => row[field] !== prior[field]))
            throw new StorageError("IMMUTABLE_KEY", "不能修改记录主键", 400);
          validateRow(table, row);
          if (
            schema[table].unique.some((fields) =>
              fields.some((f) => row[f] !== prior[f]),
            )
          ) {
            const conflicts = await find(
              table,
              or(
                ...schema[table].unique.map((fields) =>
                  and(...fields.map((field) => eq(field, row[field]))),
                ),
              ),
            );
            if (conflicts.some((r) => rowKey(table, r) !== rowKey(table, row)))
              throw new StorageError("CONFLICT", "记录已存在", 409);
          }
          remember(table, row);
          result.rows.push(row);
        }
        result.changes++;
      }
      if (mutation.op === "update") await references(table, result.rows);
      if (mutation.op === "delete" && rows.length) {
        const ids = rows.map((r) => r.id);
        if (
          table === "groups" &&
          (await find("accounts", oneOf("group_id", ids))).length
        )
          throw new StorageError("REFERENCE_EXISTS", "分组仍有账号", 409);
        for (const [parent, child, field] of [
          ["accounts", "account_tags", "account_id"],
          ["accounts", "push_state", "account_id"],
          ["tags", "account_tags", "tag_id"],
        ] as const) {
          if (table === parent)
            for (const row of await find(child, oneOf(field, ids)))
              remember(child, row, true);
        }
      }
    }
    results.push(result);
  }
  const changes = [...dirty.values()];
  if (changes.length > 2000)
    throw new StorageError(
      "BATCH_TOO_LARGE",
      "单次事务最多变更两千条记录，请分批操作",
      413,
    );
  const body = {
    expected: revision.version,
    version: revision.version + 1,
    counters,
    changes,
  };
  if (
    new TextEncoder().encode(JSON.stringify(body)).byteLength >
    8 * 1024 * 1024
  )
    throw new StorageError(
      "COMMIT_TOO_LARGE",
      "这批数据超过事务限制，请分批操作",
      413,
    );
  return { commit: { ...body, hash: await digest(body) }, results };
}
export class DirectStore implements DataStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly port: DataPort) {}
  select<T = Row>(table: Table, query?: Query) {
    return this.port.find(table, query) as Promise<T[]>;
  }
  async first<T = Row>(
    table: Table,
    where?: Filter,
    query?: Omit<Query, "where">,
  ) {
    return (
      (await this.select<T>(table, { ...query, where, limit: 1 }))[0] || null
    );
  }
  count(table: Table, where?: Filter) {
    return this.port.count(table, where);
  }
  mutate(mutations: Mutation[]) {
    const next = this.tail.then(async () => {
      const planned = await plan(this.port, mutations);
      await this.port.commit(planned.commit);
      return planned.results;
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}
