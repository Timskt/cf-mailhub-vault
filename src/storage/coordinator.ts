import { plan } from "./engine";
import {
  canonical,
  digest,
  oneOf,
  rowKey,
  schema,
  StorageError,
  tables,
  validateRow,
  type Commit,
  type DataPort,
  type Filter,
  type Mutation,
  type MutationResult,
  type Query,
  type Row,
  type Table,
} from "./model";
export const PORTABLE_BACKUP_TABLES = [
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
] as const satisfies readonly Table[];
export const BACKUP_PREFERENCES = [
  "default_prefix",
  "mail_retention_days",
  "token_refresh_batch",
  "default_mail_domain",
];
export interface BackupRestoreRequest {
  tables: Record<string, Row[]>;
  expected: { active: Dataset; revision: number };
  backup_hash: string;
  restore_id: string;
}
export interface BackupRestoreResult {
  active: Dataset;
  previous: Dataset;
  restored_rows: number;
}
type RestoreReceipt = { backup_hash: string; result: BackupRestoreResult };
export interface Source {
  id: string;
  name: string;
  kind: "d1" | "mysql" | "mongodb" | "redis";
  endpoint?: string;
  source?: string;
  secret?: string;
  transport?: "http" | "redis";
  purpose?: "primary" | "replica";
  created: string;
}
export interface Dataset {
  sourceId: string;
  generation: string;
}
export interface Job {
  id: string;
  from: Dataset;
  to: Dataset;
  phase: "copy" | "replay" | "verify" | "complete" | "cancelled";
  tableIndex: number;
  cursor: string | null;
  base: number;
  applied: number;
  copied: number;
  verified: number;
  retries: number;
  error: string;
  paused: boolean;
  started: string;
  finished?: string;
  autoSwitch: boolean;
  mode?: "switch" | "snapshot";
}
export interface ControlState {
  owner: string;
  active: Dataset;
  revision: number;
  sources: Source[];
  job?: Job;
  previous: Dataset[];
  security?: Record<string, string>;
  outbox?: { commit: Commit; results: MutationResult[] };
}
export interface ControlStorage {
  get<T>(key: string): Promise<T | undefined>;
  atomic(entries: Record<string, unknown>, remove?: string[]): Promise<void>;
  schedule(delayMs: number): Promise<void>;
  logsBefore(version: number, limit: number): Promise<string[]>;
}
export type PortFactory = (
  source: Source,
  generation: string,
  owner: string,
) => Promise<DataPort>;
const logKey = (version: number) => `log:${String(version).padStart(16, "0")}`;
export class Coordinator {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private storage: ControlStorage,
    private factory: PortFactory,
    private initial: Source,
  ) {}
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private async state() {
    let state = await this.storage.get<ControlState>("state");
    if (!state) {
      state = {
        owner: crypto.randomUUID(),
        active: { sourceId: this.initial.id, generation: "legacy" },
        revision: 0,
        sources: [this.initial],
        previous: [],
      };
      const port = await this.port(state, state.active);
      state.revision = (await port.info()).version;
      const settings = await port.find("settings", {
        where: {
          field: "key",
          op: "in",
          value: ["admin_password", "session_secret", "session_epoch"],
        },
      });
      state.security = Object.fromEntries(
        settings.map((r) => [String(r.key), String(r.value)]),
      );
      await this.save(state);
    }
    return state;
  }
  private save(state: ControlState) {
    return this.storage.atomic({ state });
  }
  private port(state: ControlState, dataset: Dataset) {
    const source = state.sources.find((s) => s.id === dataset.sourceId);
    if (!source) throw new StorageError("SOURCE_MISSING", "数据源配置不存在");
    return this.factory(source, dataset.generation, state.owner);
  }
  private async recover(state: ControlState) {
    if (!state.outbox) return;
    const pending = state.outbox.commit;
    await (await this.port(state, state.active)).commit(pending);
    state.revision = pending.version;
    delete state.outbox;
    state.security ||= {};
    for (const change of pending.changes)
      if (change.table === "settings") {
        const key = String(change.row?.key || JSON.parse(change.key)[0]);
        if (
          ["admin_password", "session_secret", "session_epoch"].includes(key)
        ) {
          if (change.row) state.security[key] = String(change.row.value);
          else delete state.security[key];
        }
      }
    const liveJob =
      state.job && !["complete", "cancelled"].includes(state.job.phase);
    await this.storage.atomic({
      state,
      ...(liveJob ? { [logKey(pending.version)]: pending } : {}),
    });
  }
  security() {
    return this.exclusive(async () => {
      const state = await this.state();
      // A password/session revocation may already have reached the database
      // when its acknowledgement was lost. Resolve that intent before using
      // the cached auth snapshot, or fail closed if recovery is unavailable.
      // Unrelated pending writes must not prevent administrative recovery of
      // an unavailable data source.
      if (
        state.outbox?.commit.changes.some(
          (change) =>
            change.table === "settings" &&
            ["admin_password", "session_secret", "session_epoch"].includes(
              String(change.row?.key || JSON.parse(change.key)[0]),
            ),
        )
      )
        await this.recover(state);
      return state.security || {};
    });
  }
  status() {
    return this.exclusive(async () => {
      const state = await this.state();
      return {
        active: state.active,
        revision: state.revision,
        sources: state.sources.map(({ secret, ...source }) => ({
          ...source,
          has_token: Boolean(secret),
        })),
        job: state.job || null,
        previous: state.previous,
        write_paused: state.job?.phase === "verify" && !state.job.paused,
        pending_write: Boolean(state.outbox),
      };
    });
  }
  find(table: Table, query?: Query) {
    return this.exclusive(async () => {
      const state = await this.state();
      await this.recover(state);
      return (await this.port(state, state.active)).find(table, query);
    });
  }
  count(table: Table, where?: Filter) {
    return this.exclusive(async () => {
      const state = await this.state();
      await this.recover(state);
      return (await this.port(state, state.active)).count(table, where);
    });
  }
  mutate(mutations: Mutation[]) {
    return this.exclusive(async () => {
      const state = await this.state();
      await this.recover(state);
      if (state.job?.phase === "verify" && !state.job.paused)
        throw new StorageError(
          "SWITCH_IN_PROGRESS",
          "正在完成数据一致性校验，写入暂时暂停，请稍后重试",
        );
      const port = await this.port(state, state.active),
        planned = await plan(port, mutations);
      if (!planned.commit.changes.length) return planned.results;
      state.outbox = planned;
      await this.storage.schedule(5000);
      await this.save(state);
      await this.recover(state);
      return planned.results;
    });
  }
  /** Business rows arrive already encrypted by the Worker. Control records are copied
   * byte-for-byte from the active source. A failed/incomplete target is never made active.
   * The final control transaction commits the pointer and replay receipt together.
   */
  restoreBackup(input: BackupRestoreRequest) {
    return this.exclusive(async (): Promise<BackupRestoreResult> => {
      if (
        !input ||
        !/^[a-f0-9]{64}$/.test(input.restore_id) ||
        !/^[a-f0-9]{64}$/.test(input.backup_hash)
      )
        throw new StorageError("INVALID_BACKUP", "恢复标识无效", 400);
      const receiptKey = `restore:${input.restore_id}`;
      const receipt = await this.storage.get<RestoreReceipt>(receiptKey);
      if (receipt) {
        if (receipt.backup_hash !== input.backup_hash)
          throw new StorageError(
            "RESTORE_ID_CONFLICT",
            "恢复标识已用于另一份备份",
            409,
          );
        return receipt.result;
      }
      const state = await this.state();
      if (
        state.outbox ||
        (state.job && !["complete", "cancelled"].includes(state.job.phase))
      )
        throw new StorageError(
          "BACKUP_BUSY",
          "请先完成或取消当前数据提交或同步任务",
          409,
        );
      if (
        !input.expected ||
        canonical(input.expected.active) !== canonical(state.active) ||
        input.expected.revision !== state.revision
      )
        throw new StorageError(
          "BACKUP_CHANGED",
          "恢复预览后数据版本发生变化，请重新预览",
          409,
        );
      if (
        !input.tables ||
        typeof input.tables !== "object" ||
        Array.isArray(input.tables) ||
        canonical(Object.keys(input.tables).sort()) !==
          canonical([...PORTABLE_BACKUP_TABLES].sort())
      )
        throw new StorageError(
          "INVALID_BACKUP",
          "备份仅能恢复约定的业务表",
          400,
        );
      let restoredRows = 0;
      for (const table of PORTABLE_BACKUP_TABLES) {
        const rows = input.tables[table];
        if (!Array.isArray(rows))
          throw new StorageError("INVALID_BACKUP", "备份数据表无效", 400);
        restoredRows += rows.length;
        const unique = new Set<string>();
        for (const row of rows) {
          if (!row || typeof row !== "object" || Array.isArray(row))
            throw new StorageError("INVALID_BACKUP", "备份记录无效", 400);
          validateRow(table, row);
          const key = rowKey(table, row);
          if (unique.has(key))
            throw new StorageError("INVALID_BACKUP", "备份存在重复主键", 400);
          unique.add(key);
          if (
            schema[table].auto &&
            (!Number.isSafeInteger(row.id) || Number(row.id) <= 0)
          )
            throw new StorageError("INVALID_BACKUP", "备份 ID 无效", 400);
          if (
            table === "settings" &&
            !BACKUP_PREFERENCES.includes(String(row.key))
          )
            throw new StorageError(
              "INVALID_BACKUP",
              "不能从备份覆盖认证设置",
              400,
            );
        }
      }
      if (
        restoredRows > 1000 ||
        new TextEncoder().encode(JSON.stringify(input.tables)).byteLength >
          2 * 1024 * 1024
      )
        throw new StorageError("BACKUP_TOO_LARGE", "便携备份超出恢复限制", 413);
      const source = await this.port(state, state.active),
        sourceRevision = await source.info();
      if (sourceRevision.version !== state.revision)
        throw new StorageError("BACKUP_CHANGED", "源数据版本不一致", 409);
      // GC claims and restore share this exclusive queue. A claimed object's physical
      // R2 deletion may already be running outside it, so it must never be relinked.
      const objectKeys = [
        ...new Set(
          input.tables.cf_inbox_mails
            .map((row) => String(row.raw_object_key || ""))
            .filter(Boolean),
        ),
      ];
      if (objectKeys.length) {
        const markers = await source.find("mail_object_gc", {
          where: oneOf("key", objectKeys),
          limit: 1000,
        });
        if (markers.some((row) => row.state === "deleting"))
          throw new StorageError(
            "BACKUP_EXTERNAL_MISSING",
            "备份引用的原始邮件正在删除，尚未切换数据集",
            409,
          );
      }
      const active = {
        sourceId: this.initial.id,
        generation: `restore-${crypto.randomUUID()}`,
      };
      if (state.sources.find((s) => s.id === active.sourceId)?.kind !== "d1")
        throw new StorageError(
          "RESTORE_TARGET_INVALID",
          "恢复目标必须为 D1",
          503,
        );
      const target = await this.port(state, active);
      const counters = { ...sourceRevision.counters };
      let controlRows = 0,
        controlBytes = 0;
      const hashes: Record<string, string> = {},
        counts: Record<string, number> = {};
      const retain = (rows: Row[]) => {
        controlRows += rows.length;
        controlBytes += new TextEncoder().encode(
          JSON.stringify(rows),
        ).byteLength;
        if (controlRows > 10000 || controlBytes > 16 * 1024 * 1024)
          throw new StorageError(
            "BACKUP_CONTROL_TOO_LARGE",
            "控制数据超过便携恢复限制，请使用全量迁移工具",
            413,
          );
      };
      const checkedAccounts = new Set<number>(),
        checkedGroups = new Set<number>();
      const checkRetainedReferences = async (table: Table, rows: Row[]) => {
        if (table !== "push_state" && table !== "oauth_sessions") return;
        const push = table === "push_state",
          checked = push ? checkedAccounts : checkedGroups;
        const parent = push ? "accounts" : "groups",
          identity = push ? "email" : "name";
        const ids = [
          ...new Set(
            rows.map((row) => Number(row[push ? "account_id" : "group_id"])),
          ),
        ].filter((id) => !checked.has(id));
        if (!ids.length) return;
        const originals = await source.find(parent, {
          where: oneOf("id", ids),
          columns: ["id", identity],
          limit: ids.length,
        });
        for (const id of ids) {
          const restored = input.tables[parent].find((row) => row.id === id),
            original = originals.find((row) => row.id === id);
          const sameIdentity =
            restored &&
            original &&
            (push
              ? String(restored.email).toLowerCase() ===
                String(original.email).toLowerCase()
              : restored.name === original.name);
          if (!sameIdentity)
            throw new StorageError(
              "BACKUP_CONTROL_REFERENCE_CONFLICT",
              push
                ? "保留的推送状态引用了缺失或已改变身份的账号，尚未切换"
                : "保留的 OAuth 会话引用了缺失或已改变身份的分组，请完成或清理会话后恢复",
              409,
            );
          checked.add(id);
        }
      };
      // A bounded portable restore refuses oversized control state instead of truncating it.
      // New isolated generations are retained if a copy fails; no active row is touched.
      for (const table of tables) {
        let rolling = "",
          count = 0;
        const write = async (rows: Row[]) => {
          if (!rows.length) return;
          for (const row of rows) {
            rolling = await digest([rolling, row]);
            count++;
            if (schema[table].auto)
              counters[table] = Math.max(counters[table] || 0, Number(row.id));
          }
          await target.copy(table, rows);
        };
        if (Object.hasOwn(input.tables, table)) {
          let rows = input.tables[table];
          if (table === "settings") {
            const retained: Row[] = [];
            let cursor: string | null = null;
            do {
              const page = await source.page(table, cursor, 100);
              const pageRetained = page.rows.filter(
                (r) => !BACKUP_PREFERENCES.includes(String(r.key)),
              );
              retain(pageRetained);
              retained.push(...pageRetained);
              cursor = page.cursor;
            } while (cursor);
            rows = [...rows, ...retained];
          }
          const sorted = [...rows].sort((a, b) =>
            rowKey(table, a) < rowKey(table, b) ? -1 : 1,
          );
          for (let i = 0; i < sorted.length; i += 25)
            await write(sorted.slice(i, i + 25));
        } else {
          let cursor: string | null = null;
          do {
            const page = await source.page(table, cursor, 50);
            retain(page.rows);
            await checkRetainedReferences(table, page.rows);
            await write(page.rows);
            cursor = page.cursor;
          } while (cursor);
        }
        hashes[table] = rolling;
        counts[table] = count;
      }
      // Re-read every staged record. Never infer success from copy acknowledgements alone.
      for (const table of tables) {
        let cursor: string | null = null,
          rolling = "",
          count = 0;
        do {
          const page = await target.page(table, cursor, 50);
          for (const row of page.rows) {
            rolling = await digest([rolling, row]);
            count++;
          }
          cursor = page.cursor;
          if (count > counts[table])
            throw new StorageError(
              "RESTORE_VERIFY_FAILED",
              "恢复目标记录数不一致，尚未切换",
              409,
            );
        } while (cursor);
        if (rolling !== hashes[table] || count !== counts[table])
          throw new StorageError(
            "RESTORE_VERIFY_FAILED",
            "恢复目标校验不一致，尚未切换",
            409,
          );
      }
      if (canonical(await source.info()) !== canonical(sourceRevision))
        throw new StorageError(
          "BACKUP_CHANGED",
          "源数据在恢复期间发生变化，尚未切换",
          409,
        );
      const targetRevision = {
        version: state.revision + 1,
        counters,
        hash: await digest({
          backup_hash: input.backup_hash,
          hashes,
          counts,
          counters,
        }),
      };
      await target.initialize(targetRevision);
      if (canonical(await target.info()) !== canonical(targetRevision))
        throw new StorageError(
          "RESTORE_VERIFY_FAILED",
          "恢复目标版本校验失败，尚未切换",
          409,
        );
      const previous = { ...state.active },
        result = { active, previous, restored_rows: restoredRows };
      state.active = active;
      state.revision = targetRevision.version;
      state.previous = [...state.previous, previous].slice(-20);
      await this.storage.atomic({
        state,
        [receiptKey]: {
          backup_hash: input.backup_hash,
          result,
        } satisfies RestoreReceipt,
      });
      return result;
    });
  }
  addSource(source: Source) {
    return this.exclusive(async () => {
      const state = await this.state();
      if (state.sources.length >= 20)
        throw new StorageError("SOURCE_LIMIT", "最多配置 20 个数据源", 400);
      if (
        state.sources.some(
          (s) =>
            s.id === source.id ||
            (s.endpoint === source.endpoint &&
              s.source === source.source &&
              s.kind !== "d1"),
        )
      )
        throw new StorageError(
          "SOURCE_EXISTS",
          "这个连接服务的数据源已添加",
          409,
        );
      await (await this.factory(source, "health-check", state.owner)).health();
      state.sources.push(source);
      await this.save(state);
      return source.id;
    });
  }
  updateSource(id: string, patch: { name?: string; secret?: string }) {
    return this.exclusive(async () => {
      const state = await this.state(),
        previous = state.sources.find((s) => s.id === id);
      if (!previous || previous.kind === "d1")
        throw new StorageError("SOURCE_MISSING", "远程数据源不存在", 404);
      const source = { ...previous, ...patch };
      const dataset =
        state.active.sourceId === id
          ? state.active
          : state.job?.to.sourceId === id
            ? state.job.to
            : { sourceId: id, generation: "health-check" };
      const port = await this.factory(source, dataset.generation, state.owner);
      await port.health();
      if (dataset.generation !== "health-check") await port.info();
      state.sources = state.sources.map((s) => (s.id === id ? source : s));
      await this.save(state);
    });
  }
  deleteSource(id: string) {
    return this.exclusive(async () => {
      const state = await this.state();
      if (
        id === "d1" ||
        state.active.sourceId === id ||
        (state.job &&
          !["complete", "cancelled"].includes(state.job.phase) &&
          state.job.to.sourceId === id)
      )
        throw new StorageError("SOURCE_IN_USE", "使用中的数据源不能移除", 409);
      state.sources = state.sources.filter((s) => s.id !== id);
      await this.save(state);
    });
  }
  health(id: string) {
    return this.exclusive(async () => {
      const state = await this.state(),
        start = Date.now();
      const dataset =
        id === state.active.sourceId
          ? state.active
          : { sourceId: id, generation: "health-check" };
      await (await this.port(state, dataset)).health();
      return { healthy: true, latency_ms: Date.now() - start };
    });
  }
  start(id: string, autoSwitch = true, mode: "switch" | "snapshot" = "switch") {
    return this.exclusive(async () => {
      const state = await this.state();
      await this.recover(state);
      if (state.job && !["complete", "cancelled"].includes(state.job.phase))
        throw new StorageError("JOB_ACTIVE", "请先完成或取消当前同步任务", 409);
      if (state.active.sourceId === id)
        throw new StorageError(
          "ALREADY_ACTIVE",
          "这个数据源已在使用中；同类型迁移请添加另一个实例",
          409,
        );
      if (
        mode === "switch" &&
        state.sources.find((s) => s.id === id)?.purpose === "replica"
      )
        throw new StorageError(
          "SOURCE_REPLICA_ONLY",
          "此数据源用于保存副本，请使用“同步副本”；当前主库继续提供服务",
          400,
        );
      const revision = await (await this.port(state, state.active)).info();
      const to = { sourceId: id, generation: crypto.randomUUID() };
      const target = await this.port(state, to);
      await target.health();
      await target.initialize(revision);
      state.job = {
        id: crypto.randomUUID(),
        from: { ...state.active },
        to,
        phase: "copy",
        tableIndex: 0,
        cursor: null,
        base: revision.version,
        applied: revision.version,
        copied: 0,
        verified: 0,
        retries: 0,
        error: "",
        paused: false,
        started: new Date().toISOString(),
        autoSwitch,
        mode,
      };
      await this.storage.schedule(50);
      await this.save(state);
      return state.job;
    });
  }
  retry() {
    return this.exclusive(async () => {
      const state = await this.state();
      if (!state.job || ["complete", "cancelled"].includes(state.job.phase))
        throw new StorageError("JOB_MISSING", "没有可恢复的同步任务", 409);
      // Failed verification resumes from replay: writes may have continued while paused.
      if (state.job.phase === "verify") {
        state.job.phase = "replay";
        state.job.cursor = null;
        state.job.tableIndex = 0;
        state.job.verified = 0;
      }
      state.job.paused = false;
      state.job.retries = 0;
      state.job.error = "";
      await this.save(state);
      await this.storage.schedule(50);
    });
  }
  cancel() {
    return this.exclusive(async () => {
      const state = await this.state();
      if (state.job && !["complete", "cancelled"].includes(state.job.phase)) {
        state.job.phase = "cancelled";
        state.job.finished = new Date().toISOString();
        state.job.paused = false;
        await this.save(state);
        await this.storage.schedule(50);
      }
    });
  }
  step() {
    return this.exclusive(async () => {
      const state = await this.state(),
        job = state.job;
      if (state.outbox) {
        await this.storage.schedule(15000);
        await this.recover(state);
      }
      if (!job || ["complete", "cancelled"].includes(job.phase)) {
        const keys = await this.storage.logsBefore(state.revision + 1, 50);
        if (keys.length) {
          await this.storage.atomic({}, keys);
          await this.storage.schedule(50);
        }
        return;
      }
      if (job.paused) return;
      await this.storage.schedule(15000);
      try {
        await this.recover(state);
        const source = await this.port(state, job.from),
          target = await this.port(state, job.to);
        if (job.phase === "copy") {
          const table = tables[job.tableIndex],
            page = await source.page(
              table,
              job.cursor,
              table === "cf_inbox_mails" ? 5 : 100,
            );
          await target.copy(table, page.rows);
          job.copied += page.rows.length;
          job.cursor = page.cursor;
          if (!page.cursor) {
            job.tableIndex++;
            if (job.tableIndex === tables.length) {
              job.phase = "replay";
              job.tableIndex = 0;
            }
          }
        } else if (job.phase === "replay") {
          // A process can stop after several target commits but before saving
          // the local cursor. Reconcile with the durable journal before replay.
          const applied = await target.info();
          if (applied.version < job.applied || applied.version > state.revision)
            throw new StorageError(
              "TARGET_REVISION_CONFLICT",
              "目标数据集版本异常，尚未切换",
            );
          if (applied.version > job.applied) {
            const recorded = await this.storage.get<Commit>(
              logKey(applied.version),
            );
            if (
              !recorded ||
              recorded.hash !== applied.hash ||
              canonical(recorded.counters) !== canonical(applied.counters)
            )
              throw new StorageError(
                "TARGET_REVISION_CONFLICT",
                "目标提交无法与增量日志核对，尚未切换",
              );
            job.applied = applied.version;
          }
          for (let i = 0; i < 10 && job.applied < state.revision; i++) {
            const commit = await this.storage.get<Commit>(
              logKey(job.applied + 1),
            );
            if (!commit)
              throw new StorageError(
                "JOURNAL_GAP",
                "增量日志不完整，请取消并重新同步",
              );
            await target.commit(commit);
            job.applied = commit.version;
          }
          if (job.applied === state.revision) {
            if (!job.autoSwitch) {
              job.paused = true;
              job.error = "初次同步已追平；点击继续后将校验并切换";
              job.autoSwitch = true;
            } else {
              job.phase = "verify";
              job.tableIndex = 0;
              job.cursor = null;
              job.verified = 0;
            }
          }
        } else {
          const table = tables[job.tableIndex];
          // The same cursor/page size must yield exactly the same canonical records.
          const [left, right] = await Promise.all([
            source.page(
              table,
              job.cursor,
              table === "cf_inbox_mails" ? 5 : 100,
            ),
            target.page(
              table,
              job.cursor,
              table === "cf_inbox_mails" ? 5 : 100,
            ),
          ]);
          if (
            left.cursor !== right.cursor ||
            (await digest(left.rows)) !== (await digest(right.rows))
          )
            throw new StorageError(
              "VERIFY_MISMATCH",
              `数据校验不一致（${table}），尚未切换`,
            );
          job.verified += left.rows.length;
          job.cursor = left.cursor;
          if (!left.cursor) job.tableIndex++;
          if (job.tableIndex === tables.length) {
            const [a, b] = await Promise.all([source.info(), target.info()]);
            if (canonical(a) !== canonical(b))
              throw new StorageError(
                "VERIFY_REVISION_MISMATCH",
                "版本或 ID 序列校验不一致，尚未切换",
              );
            if (job.mode !== "snapshot") {
              state.previous = [...state.previous, state.active].slice(-20);
              state.active = job.to;
            }
            job.phase = "complete";
            job.finished = new Date().toISOString();
          }
        }
        if (!job.paused) job.error = "";
        await this.save(state);
        await this.storage.schedule(job.phase === "verify" ? 25 : 100);
      } catch (error) {
        job.retries++;
        job.error =
          error instanceof StorageError
            ? `${error.code}: ${error.message}`
            : "同步暂时失败，请检查连接服务";
        // Resume writes after a verification error; re-enter verification only after replaying new changes.
        if (job.phase === "verify") {
          job.phase = "replay";
          job.tableIndex = 0;
          job.cursor = null;
          job.verified = 0;
        }
        job.paused =
          job.retries >= 5 ||
          (error instanceof StorageError &&
            [
              "VERIFY_MISMATCH",
              "VERIFY_REVISION_MISMATCH",
              "JOURNAL_GAP",
              "TARGET_REVISION_CONFLICT",
            ].includes(error.code));
        await this.save(state);
        if (!job.paused)
          await this.storage.schedule(Math.min(60000, 1000 * 2 ** job.retries));
      }
    });
  }
}
