import {
  StorageError,
  type DataStore,
  type Filter,
  type Mutation,
  type MutationResult,
  type Query,
  type Row,
  type Table,
  schema,
  and,
  eq,
} from "./model";

const protectedFields: Partial<Record<Table, readonly string[]>> = {
  accounts: ["password", "refresh_token"],
  platform_vault: ["password", "totp_secret"],
  provider_accounts: ["password", "token"],
  oauth_sessions: ["verifier"],
  webhooks: ["secret", "url"],
};
const PREFIX = "enc:v1:";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function b64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function unb64(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
async function aesKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", encoder.encode(secret)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
async function fingerprint(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(`accounts:refresh_token:${value}`),
      ),
    ),
  );
}
async function seal(value: string, secret: string, context: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
      await aesKey(secret),
      encoder.encode(value),
    ),
  );
  return `${PREFIX}${b64(iv)}:${b64(ciphertext)}`;
}
async function open(value: string, secrets: string[], context: string) {
  if (!value.startsWith(PREFIX)) return value;
  for (const secret of secrets) {
    try {
      const [iv, ciphertext, extra] = value.slice(PREFIX.length).split(":");
      if (extra || !iv || !ciphertext) throw new Error("Invalid envelope");
      return decoder.decode(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: unb64(iv),
            additionalData: encoder.encode(context),
          },
          await aesKey(secret),
          unb64(ciphertext),
        ),
      );
    } catch {
      /* Try previous key during a controlled key rotation. */
    }
  }
  throw new StorageError(
    "CREDENTIAL_DECRYPT_FAILED",
    "敏感数据无法解密，请恢复正确的凭据加密密钥",
    503,
  );
}
export async function encryptCredentialRows(
  table: Table,
  rows: Row[],
  current: string,
): Promise<Row[]> {
  if (current.length < 32)
    throw new StorageError(
      "CREDENTIAL_KEY_REQUIRED",
      "恢复前请配置至少 32 位的凭据加密密钥",
      503,
    );
  return Promise.all(rows.map((row) => protectRow(table, row, current)));
}
async function protectRow(table: Table, row: Row, current?: string) {
  const result = { ...row };
  if (!current) return result;
  for (const field of protectedFields[table] || []) {
    const value = result[field];
    if (value === undefined) continue;
    if (typeof value !== "string")
      throw new StorageError("INVALID_ROW", "凭据字段必须为字符串", 400);
    result[field] = value
      ? await seal(value, current, `${table}:${field}`)
      : "";
    if (table === "accounts" && field === "refresh_token")
      result.refresh_token_fingerprint = value
        ? await fingerprint(value, current)
        : "";
  }
  return result;
}

/** Encrypt before the coordinator persists intents/logs. Connectors only see ciphertext.
 * Legacy plaintext remains readable; the explicit rekey job rewrites it in bounded pages.
 * Refresh-token equality uses a keyed blind index, preserving atomic token CAS.
 */
export class SecureStore implements DataStore {
  private readonly secrets: string[];
  constructor(
    private readonly inner: DataStore,
    private readonly current?: string,
    previous?: string,
  ) {
    if (current && current.length < 32)
      throw new StorageError(
        "CREDENTIAL_KEY_INVALID",
        "凭据加密密钥至少需要 32 个字符",
        503,
      );
    if (previous && previous.length < 32)
      throw new StorageError(
        "CREDENTIAL_KEY_INVALID",
        "旧凭据加密密钥至少需要 32 个字符",
        503,
      );
    this.secrets = [current, previous].filter((v): v is string => Boolean(v));
  }
  private async encode(table: Table, row: Row) {
    return protectRow(table, row, this.current);
  }
  private async decode<T>(table: Table, row: Row): Promise<T> {
    const result = { ...row };
    for (const field of protectedFields[table] || []) {
      if (typeof result[field] === "string")
        result[field] = await open(
          String(result[field]),
          this.secrets,
          `${table}:${field}`,
        );
    }
    if (table === "accounts") delete result.refresh_token_fingerprint;
    return result as T;
  }
  private async filter(
    table: Table,
    filter?: Filter,
  ): Promise<Filter | undefined> {
    if (!filter) return undefined;
    if ("and" in filter)
      return {
        and: await Promise.all(
          filter.and.map(async (f) => (await this.filter(table, f))!),
        ),
      };
    if ("or" in filter)
      return {
        or: await Promise.all(
          filter.or.map(async (f) => (await this.filter(table, f))!),
        ),
      };
    if ("not" in filter)
      return { not: (await this.filter(table, filter.not))! };
    if (!(protectedFields[table] || []).includes(filter.field)) return filter;
    if (
      table === "accounts" &&
      filter.field === "refresh_token" &&
      ["eq", "ne"].includes(filter.op)
    ) {
      if (!this.secrets.length) return filter;
      const equality: Filter = {
        or: [
          { field: "refresh_token", op: "eq", value: filter.value },
          {
            field: "refresh_token_fingerprint",
            op: "in",
            value: await Promise.all(
              this.secrets.map((secret) =>
                fingerprint(String(filter.value), secret),
              ),
            ),
          },
        ],
      };
      return filter.op === "ne" ? { not: equality } : equality;
    }
    throw new StorageError(
      "CREDENTIAL_QUERY_UNSUPPORTED",
      "不支持搜索或排序敏感凭据字段",
      400,
    );
  }
  async select<T = Row>(table: Table, query: Query = {}) {
    if (
      query.order?.some(([field]) =>
        (protectedFields[table] || []).includes(field),
      )
    )
      throw new StorageError(
        "CREDENTIAL_QUERY_UNSUPPORTED",
        "不支持按凭据排序",
        400,
      );
    const rows = await this.inner.select<Row>(table, {
      ...query,
      where: await this.filter(table, query.where),
    });
    return Promise.all(rows.map((row) => this.decode<T>(table, row)));
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
  async count(table: Table, where?: Filter) {
    return this.inner.count(table, await this.filter(table, where));
  }
  async mutate(mutations: Mutation[]): Promise<MutationResult[]> {
    const encoded = await Promise.all(
      mutations.map(async (mutation): Promise<Mutation> => {
        if (mutation.op === "insert")
          return {
            ...mutation,
            rows: await Promise.all(
              mutation.rows.map((row) => this.encode(mutation.table, row)),
            ),
            ...(mutation.patch
              ? { patch: await this.encode(mutation.table, mutation.patch) }
              : {}),
            ...(mutation.onConflictSet
              ? {
                  onConflictSet: await this.encode(
                    mutation.table,
                    mutation.onConflictSet,
                  ),
                }
              : {}),
          };
        if (mutation.op === "update")
          return {
            ...mutation,
            where: await this.filter(mutation.table, mutation.where),
            ...(mutation.set
              ? { set: await this.encode(mutation.table, mutation.set) }
              : {}),
          };
        if (mutation.op === "delete")
          return {
            ...mutation,
            where: await this.filter(mutation.table, mutation.where),
          };
        if (mutation.op === "assertExists" || mutation.op === "assertAbsent")
          return {
            ...mutation,
            where: (await this.filter(mutation.table, mutation.where))!,
          };
        return mutation;
      }),
    );
    const results = await this.inner.mutate(encoded);
    return Promise.all(
      results.map(async (result, index) => {
        const mutation = mutations[index];
        return {
          ...result,
          rows:
            "table" in mutation
              ? await Promise.all(
                  result.rows.map((row) =>
                    this.decode<Row>(mutation.table, row),
                  ),
                )
              : result.rows,
        };
      }),
    );
  }
}
export const credentialFields = protectedFields;

export async function rekeyCredentials(
  store: DataStore,
  current: string,
  previous: string | undefined,
  table: Table,
  cursor: string | number = "",
  limit = 50,
) {
  if (!current || current.length < 32)
    throw new StorageError(
      "CREDENTIAL_KEY_REQUIRED",
      "请先配置凭据加密密钥",
      503,
    );
  const fields = protectedFields[table];
  if (!fields)
    throw new StorageError("INVALID_TABLE", "该表不含支持重加密的凭据", 400);
  const key = schema[table].key[0];
  const rows = await store.select(table, {
    where: cursor !== "" ? { field: key, op: "gt", value: cursor } : undefined,
    order: [[key, "asc"]],
    limit,
  });
  const secrets = [current, previous].filter((s): s is string => Boolean(s));
  let changed = 0;
  for (const row of rows) {
    const patch: Row = {};
    for (const field of fields) {
      const plaintext = await open(
        String(row[field] || ""),
        secrets,
        `${table}:${field}`,
      );
      patch[field] = plaintext
        ? await seal(plaintext, current, `${table}:${field}`)
        : "";
      if (table === "accounts" && field === "refresh_token")
        patch.refresh_token_fingerprint = plaintext
          ? await fingerprint(plaintext, current)
          : "";
    }
    // Compare original ciphertext inside the transaction. A concurrent import or
    // token rotation wins; never overwrite it with a value read earlier.
    const [result] = await store.mutate([
      {
        op: "update",
        table,
        where: and(
          eq(key, row[key]),
          ...fields.map((field) => eq(field, row[field])),
        ),
        set: patch,
      },
    ]);
    changed += result.changes;
  }
  return {
    table,
    scanned: rows.length,
    changed,
    skipped: rows.length - changed,
    cursor: rows.at(-1)?.[key] ?? cursor,
    complete: rows.length < limit,
  };
}
