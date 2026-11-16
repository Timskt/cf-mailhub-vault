export type Value = string | number | null;
export type Row = Record<string, Value>;
const stamp = "$now";
const stamps = { created_at: stamp, updated_at: stamp };
const numbered = (fields: Row, unique: string[][] = []) => ({
  key: ["id"],
  auto: true,
  fields: { id: 0, ...fields },
  unique,
});
export const schema = {
  settings: {
    key: ["key"],
    auto: false,
    fields: { key: "", value: "", ...stamps },
    unique: [],
  },
  groups: numbered({ name: "", description: "", color: "#2563eb", ...stamps }, [
    ["name"],
  ]),
  tags: numbered({ name: "", color: "#6366f1", created_at: stamp }, [["name"]]),
  accounts: numbered(
    {
      email: "",
      client_id: "",
      refresh_token: "",
      refresh_token_fingerprint: "",
      password: "",
      group_id: 1,
      remark: "",
      status: "active",
      ...stamps,
      auth_status: "unchecked",
      last_checked_at: "",
      last_error: "",
      last_error_code: "",
      last_token_refresh_at: "",
      last_token_attempt_at: "",
      next_token_refresh_at: "",
      token_refresh_failures: 0,
      token_refresh_status: "pending",
      token_refresh_error: "",
    },
    [["email"]],
  ),
  account_tags: {
    key: ["account_id", "tag_id"],
    auto: false,
    fields: { account_id: 0, tag_id: 0 },
    unique: [],
  },
  push_state: {
    key: ["account_id"],
    auto: false,
    fields: { account_id: 0, last_pushed_at: "", updated_at: stamp },
    unique: [],
  },
  cf_inbox_mails: numbered({
    message_id: "",
    recipient: "",
    sender: "",
    sender_name: "",
    subject: "",
    text_content: "",
    html_content: "",
    raw_size: 0,
    raw_object_key: "",
    attachment_manifest: "[]",
    verification_code: "",
    verification_link: "",
    dkim_status: "unknown",
    spf_status: "unknown",
    is_read: 0,
    is_pinned: 0,
    is_protected: 0,
    is_archived: 0,
    category: "general",
    rule_name: "",
    expires_at: "",
    created_at: stamp,
  }),
  mail_rules: numbered({
    name: "",
    enabled: 1,
    priority: 100,
    sender_contains: "",
    recipient: "",
    domain: "",
    subject_contains: "",
    verification_only: 0,
    action_category: "",
    mark_read: 0,
    archive: 0,
    pin: 0,
    ...stamps,
  }),
  mail_object_gc: {
    key: ["key"],
    auto: false,
    unique: [],
    fields: {
      key: "",
      available_at: 0,
      attempts: 0,
      state: "pending",
      created_at: stamp,
    },
  },
  webhooks: numbered({
    name: "",
    url: "",
    secret: "",
    events: "[]",
    include_code: 0,
    enabled: 1,
    ...stamps,
  }),
  webhook_deliveries: {
    key: ["id"],
    auto: false,
    unique: [],
    fields: {
      id: "",
      webhook_id: 0,
      event: "",
      payload: "",
      status: "pending",
      attempts: 0,
      next_attempt: 0,
      lease_token: "",
      lease_until: 0,
      http_status: 0,
      error: "",
      ...stamps,
    },
  },
  platform_vault: numbered({
    platform_name: "",
    platform_url: "",
    account_email: "",
    email_source: "cf_domain",
    username: "",
    password: "",
    totp_secret: "",
    status: "active",
    category: "AI工具",
    proxy_node: "",
    remark: "",
    last_code: "",
    last_code_at: "",
    is_pinned: 0,
    ...stamps,
  }),
  temp_emails: numbered(
    { email: "", source: "gptmail", remark: "", ...stamps },
    [["email"]],
  ),
  temp_mailboxes: numbered(
    {
      address: "",
      prefix: "",
      domain: "",
      expires_at: "",
      is_permanent: 0,
      associated_platform: "",
      associated_vault_id: null,
      remark: "",
      is_pinned: 0,
      ...stamps,
    },
    [["address"]],
  ),
  domains: {
    key: ["domain"],
    auto: false,
    fields: {
      domain: "",
      enabled: 1,
      remark: "",
      dns_status: "unchecked",
      last_checked_at: "",
      last_received_at: "",
      ...stamps,
    },
    unique: [],
  },
  oauth_sessions: {
    key: ["state_hash"],
    auto: false,
    fields: {
      state_hash: "",
      verifier: "",
      session_hash: "",
      redirect_uri: "",
      group_id: 1,
      expires_at: 0,
    },
    unique: [],
  },
  auth_attempts: {
    key: ["identity"],
    auto: false,
    fields: { identity: "", attempts: 0, reset_at: 0 },
    unique: [],
  },
  api_keys: {
    key: ["id"],
    auto: false,
    unique: [["key_hash"]],
    fields: {
      id: "",
      key_hash: "",
      prefix: "",
      name: "",
      scopes: "[]",
      restrictions: "{}",
      expires_at: "",
      revoked_at: "",
      last_used_at: "",
      ...stamps,
    },
  },
  idempotency_requests: {
    key: ["id"],
    auto: false,
    unique: [],
    fields: {
      id: "",
      actor: "",
      key_hash: "",
      request_hash: "",
      route: "",
      state: "in_progress",
      response_status: 0,
      response_headers: "{}",
      response_ciphertext: "",
      expires_at: "",
      ...stamps,
    },
  },
  audit_logs: numbered({
    actor_type: "",
    actor_id: "",
    api_key_prefix: "",
    request_id: "",
    action: "",
    resource: "",
    method: "",
    route: "",
    status: 0,
    metadata: "{}",
    created_at: stamp,
  }),
  // Append new tables: persisted migration jobs address tables by index.
  platforms: {
    key: ["name_key"],
    auto: false,
    fields: {
      name_key: "",
      name: "",
      url: "",
      category: "其他",
      remark: "",
      is_pinned: 0,
      ...stamps,
    },
    unique: [],
  },
} satisfies Record<
  string,
  { key: string[]; auto: boolean; fields: Row; unique: string[][] }
>;
export type Table = keyof typeof schema;
// Older portable datasets have no physical ALTER TABLE. Keep queries and returned
// rows consistent without rewriting their contents or changing snapshot hashes.
export const readFallbacks: Partial<Record<Table, Row>> = {
  accounts: { refresh_token_fingerprint: "" },
  cf_inbox_mails: {
    is_archived: 0,
    category: "general",
    rule_name: "",
    raw_object_key: "",
    attachment_manifest: "[]",
  },
};
export function readRow(table: Table, row: Row): Row {
  return { ...readFallbacks[table], ...row };
}
export const tables = Object.keys(schema) as Table[];
export function tableName(value: string): Table {
  if (!Object.hasOwn(schema, value))
    throw new StorageError("INVALID_TABLE", "未知数据表", 400);
  return value as Table;
}
export function fieldName(table: Table, field: string) {
  if (!Object.hasOwn(schema[table].fields, field))
    throw new StorageError("INVALID_FIELD", "未知字段", 400);
  return field;
}
export const now = () => new Date().toISOString();
export function defaults(table: Table): Row {
  const time = now();
  return Object.fromEntries(
    Object.entries(schema[table].fields).map(([key, value]) => [
      key,
      value === stamp ? time : value,
    ]),
  );
}
export function rowKey(table: Table, row: Row): string {
  return JSON.stringify(schema[table].key.map((k) => row[k]));
}
export function validateRow(table: Table, row: Row) {
  for (const [key, value] of Object.entries(row)) {
    fieldName(table, key);
    if (
      value !== null &&
      typeof value !== "string" &&
      !(typeof value === "number" && Number.isSafeInteger(value))
    )
      throw new StorageError("INVALID_ROW", "记录类型无效", 400);
  }
  if (
    schema[table].key.some(
      (k) => row[k] === undefined || row[k] === null || row[k] === "",
    )
  )
    throw new StorageError("INVALID_KEY", "记录缺少主键", 400);
}
export class StorageError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 503,
  ) {
    super(message);
    this.name = "StorageError";
  }
}
export type Filter =
  | {
      field: string;
      op:
        | "eq"
        | "ne"
        | "lt"
        | "lte"
        | "gt"
        | "gte"
        | "contains"
        | "ends"
        | "ieq"
        | "in"
        | "dateLt"
        | "dateGte";
      value: Value | Value[];
    }
  | { and: Filter[] }
  | { or: Filter[] }
  | { not: Filter };
export const eq = (field: string, value: Value): Filter => ({
  field,
  op: "eq",
  value,
});
export const ne = (field: string, value: Value): Filter => ({
  field,
  op: "ne",
  value,
});
export const oneOf = (field: string, value: Value[]): Filter => ({
  field,
  op: "in",
  value,
});
export const contains = (field: string, value: string): Filter => ({
  field,
  op: "contains",
  value,
});
export const and = (...filters: (Filter | undefined | false)[]): Filter => ({
  and: filters.filter(Boolean) as Filter[],
});
export const or = (...filters: Filter[]): Filter => ({ or: filters });
export const search = (value: string, ...fields: string[]): Filter =>
  or(...fields.map((field) => contains(field, value)));
export function matches(row: Row, filter?: Filter): boolean {
  if (!filter) return true;
  if ("and" in filter) return filter.and.every((f) => matches(row, f));
  if ("or" in filter) return filter.or.some((f) => matches(row, f));
  if ("not" in filter) return !matches(row, filter.not);
  const a = row[filter.field],
    b = filter.value;
  switch (filter.op) {
    case "eq":
      return a === b;
    case "ne":
      return a !== b;
    case "in":
      return Array.isArray(b) && b.includes(a);
    case "contains":
      return String(a ?? "")
        .toLowerCase()
        .includes(String(b).toLowerCase());
    case "ends":
      return String(a ?? "")
        .toLowerCase()
        .endsWith(String(b).toLowerCase());
    case "ieq":
      return String(a ?? "").toLowerCase() === String(b).toLowerCase();
    case "dateLt":
      return parseTime(a) < parseTime(b as Value);
    case "dateGte":
      return parseTime(a) >= parseTime(b as Value);
    case "lt":
      return a !== null && b !== null && a < (b as string | number);
    case "lte":
      return a !== null && b !== null && a <= (b as string | number);
    case "gt":
      return a !== null && b !== null && a > (b as string | number);
    case "gte":
      return a !== null && b !== null && a >= (b as string | number);
  }
}
function parseTime(value: Value) {
  return Date.parse(
    String(value).replace(" ", "T") +
      (/Z$|[+-]\d\d:\d\d$/.test(String(value)) ? "" : "Z"),
  );
}
export interface Query {
  where?: Filter;
  order?: [string, "asc" | "desc"][];
  limit?: number;
  offset?: number;
  columns?: string[];
}
export function queryRows(rows: Row[], query: Query = {}) {
  let result = rows.filter((row) => matches(row, query.where));
  if (query.order)
    result.sort((a, b) => {
      for (const [field, direction] of query.order!) {
        const x = a[field] ?? "",
          y = b[field] ?? "";
        if (x !== y) return (x < y ? -1 : 1) * (direction === "asc" ? 1 : -1);
      }
      return 0;
    });
  result = result.slice(
    query.offset || 0,
    (query.offset || 0) + (query.limit ?? 10000),
  );
  return query.columns
    ? result.map((row) =>
        Object.fromEntries(query.columns!.map((k) => [k, row[k]])),
      )
    : result;
}
export interface Change {
  table: Table;
  key: string;
  row: Row | null;
}
export interface Revision {
  version: number;
  hash: string;
  counters: Record<string, number>;
}
export interface Commit extends Revision {
  expected: number;
  changes: Change[];
}
export interface Page {
  rows: Row[];
  cursor: string | null;
}
export interface DataPort {
  info(): Promise<Revision>;
  find(table: Table, query?: Query): Promise<Row[]>;
  count(table: Table, where?: Filter): Promise<number>;
  page(table: Table, cursor?: string | null, limit?: number): Promise<Page>;
  commit(commit: Commit): Promise<void>;
  copy(table: Table, rows: Row[]): Promise<void>;
  initialize(revision: Revision): Promise<void>;
  health(): Promise<void>;
}
export type Mutation =
  | {
      op: "platform";
      action: "create" | "update" | "merge" | "delete";
      source: string;
      definition?: Row;
      target?: string;
    }
  | {
      op: "assertExists";
      table: Table;
      where: Filter;
      message?: string;
      minimum?: number;
    }
  | {
      op: "assertAbsent";
      table: Table;
      where: Filter;
      message?: string;
    }
  | { op: "bindMailbox"; address: string }
  | { op: "confirmMailObject"; key: string }
  | { op: "claimMailObject"; key: string; time: number }
  | {
      op: "insert";
      table: Table;
      rows: Row[];
      conflict?: "ignore" | "update";
      match?: string[];
      patch?: Row;
      onConflictSet?: Row;
      keepNonEmpty?: string[];
    }
  | {
      op: "update";
      table: Table;
      where?: Filter;
      set?: Row;
      increment?: Record<string, number>;
      toggle?: string[];
    }
  | { op: "delete"; table: Table; where?: Filter }
  | { op: "throttle"; identity: string; time: number; windowSeconds?: number }
  | { op: "cleanMail"; ids: number[] };
export interface MutationResult {
  rows: Row[];
  changes: number;
  lastId: number;
}
export interface DataStore {
  select<T = Row>(table: Table, query?: Query): Promise<T[]>;
  first<T = Row>(
    table: Table,
    where?: Filter,
    query?: Omit<Query, "where">,
  ): Promise<T | null>;
  count(table: Table, where?: Filter): Promise<number>;
  mutate(mutations: Mutation[]): Promise<MutationResult[]>;
}
export const insert = (
  table: Table,
  row: Row,
  options: Omit<
    Extract<Mutation, { op: "insert" }>,
    "op" | "table" | "rows"
  > = {},
): Mutation => ({ op: "insert", table, rows: [row], ...options });
export const update = (
  table: Table,
  where: Filter | undefined,
  set: Row,
): Mutation => ({ op: "update", table, where, set });
export const remove = (table: Table, where?: Filter): Mutation => ({
  op: "delete",
  table,
  where,
});
export async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(value)),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
