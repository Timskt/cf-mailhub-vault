import type { Env } from "../types";
import { D1Port } from "./d1";
import { DirectStore } from "./engine";
import { SecureStore } from "./secure";
import {
  StorageError,
  type DataStore,
  type Filter,
  type Mutation,
  type Query,
  type Row,
  type Table,
} from "./model";
export * from "./model";
const direct = new WeakMap<object, DirectStore>();
export async function storageCall<T>(
  env: Env,
  path: string,
  payload?: unknown,
): Promise<T> {
  if (!env.STORAGE)
    throw new StorageError(
      "STORAGE_NOT_ENABLED",
      "请先配置存储协调器绑定 STORAGE",
      503,
    );
  const response = await env.STORAGE.get(
    env.STORAGE.idFromName("mailhub-workspace"),
  ).fetch(`https://storage.internal${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const data = (await response.json()) as {
    data: T;
    error?: string;
    message?: string;
  };
  if (!response.ok)
    throw new StorageError(
      data.error || "STORAGE_UNAVAILABLE",
      data.message || "存储服务暂时不可用",
      response.status,
    );
  return data.data;
}
class CoordinatedStore implements DataStore {
  constructor(private env: Env) {}
  select<T = Row>(table: Table, query?: Query): Promise<T[]> {
    return storageCall(this.env, "/data/find", { table, query });
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
  count(table: Table, where?: Filter): Promise<number> {
    return storageCall(this.env, "/data/count", { table, where });
  }
  mutate(mutations: Mutation[]) {
    return storageCall<import("./model").MutationResult[]>(
      this.env,
      "/data/mutate",
      { mutations },
    );
  }
}
export function rawDb(env: Env): DataStore {
  if (env.STORAGE) return new CoordinatedStore(env);
  // Compatibility for installations that have not enabled the coordinator yet.
  let store = direct.get(env.DB);
  if (!store) {
    store = new DirectStore(new D1Port(env.DB));
    direct.set(env.DB, store);
  }
  return store;
}
export function db(env: Env): DataStore {
  return new SecureStore(
    rawDb(env),
    env.CREDENTIAL_ENCRYPTION_KEY || env.STORAGE_ENCRYPTION_KEY,
    env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS,
  );
}
// Used for small projections (group counts and relation keys); messages are always paged.
export async function collect<T = Row>(
  store: DataStore,
  table: Table,
  query: Query = {},
): Promise<T[]> {
  const result: T[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await store.select<T>(table, { ...query, limit: 500, offset });
    result.push(...page);
    if (page.length < 500) return result;
  }
}
