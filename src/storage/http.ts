import {
  StorageError,
  type Commit,
  type DataPort,
  type Filter,
  type Page,
  type Query,
  type Revision,
  type Row,
  type Table,
} from "./model";
export interface RemoteConnection {
  endpoint: string;
  source: string;
  token: string;
}
export function connectionUrl(input: string, allowLocal = false) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new StorageError("INVALID_ENDPOINT", "连接服务地址无效", 400);
  }
  const local = [
    "localhost",
    "127.0.0.1",
    "[::1]",
    "host.docker.internal",
  ].includes(url.hostname);
  if (
    (url.protocol !== "https:" &&
      !(allowLocal && local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new StorageError(
      "INVALID_ENDPOINT",
      "连接服务须使用 HTTPS，且地址不能含账号、查询参数或锚点",
      400,
    );
  return url.toString().replace(/\/$/, "");
}
export class HttpPort implements DataPort {
  constructor(
    readonly connection: RemoteConnection,
    readonly generation: string,
    readonly owner: string,
    readonly kind?: string,
  ) {}
  async call<T>(op: string, data: unknown = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.connection.endpoint}/v1/data`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.connection.token}`,
        },
        body: JSON.stringify({
          source: this.connection.source,
          generation: this.generation,
          owner: this.owner,
          op,
          data,
        }),
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new StorageError(
        "CONNECTOR_UNREACHABLE",
        "无法连接数据库服务，请检查地址、网络和服务状态",
      );
    }
    if (response.status >= 300 && response.status < 400)
      throw new StorageError(
        "CONNECTOR_REDIRECT_REJECTED",
        "连接服务地址发生重定向，请填写最终 HTTPS 地址",
        400,
      );
    const body = (await response.json().catch(() => ({}))) as {
      data: T;
      code?: string;
    };
    const connectorAuthFailed = [401, 403].includes(response.status);
    if (!response.ok)
      throw new StorageError(
        connectorAuthFailed
          ? "CONNECTOR_AUTH_FAILED"
          : body.code || "CONNECTOR_FAILED",
        connectorAuthFailed
          ? "连接服务令牌无效或权限不足，请检查连接令牌"
          : response.status === 409
            ? "数据版本或数据集所有者冲突，已停止写入"
            : "数据库服务执行失败，请检查服务器日志",
        // The administrator's session is still valid. Upstream authentication
        // failures must not become the application's own 401/logout signal.
        connectorAuthFailed
          ? 502
          : response.status >= 500
            ? 503
            : response.status,
      );
    return body.data;
  }
  info(): Promise<Revision> {
    return this.call("info");
  }
  find(table: Table, query?: Query): Promise<Row[]> {
    return this.call("find", { table, query });
  }
  count(table: Table, where?: Filter): Promise<number> {
    return this.call("count", { table, where });
  }
  page(table: Table, cursor?: string | null, limit = 100): Promise<Page> {
    return this.call("page", { table, cursor, limit });
  }
  commit(commit: Commit): Promise<void> {
    return this.call("commit", commit);
  }
  copy(table: Table, rows: Row[]): Promise<void> {
    return this.call("copy", { table, rows });
  }
  initialize(revision: Revision): Promise<void> {
    return this.call("initialize", revision);
  }
  async health(): Promise<void> {
    const result = await this.call<{ kind?: string }>("health");
    if (this.kind && result.kind !== this.kind)
      throw new StorageError(
        "SOURCE_KIND_MISMATCH",
        "选择的数据库类型与连接服务配置不一致",
        400,
      );
  }
}
export async function sealSecret(value: string, secret: string) {
  if (secret.length < 32)
    throw new StorageError(
      "ENCRYPTION_KEY_REQUIRED",
      "请配置至少 32 位的 STORAGE_ENCRYPTION_KEY Secret",
    );
  const key = await crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(value),
    ),
  );
  return `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...bytes))}`;
}
export async function openSecret(value: string, secret: string) {
  try {
    const [iv, data] = value
      .split(".")
      .map((s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
    const key = await crypto.subtle.importKey(
      "raw",
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    return new TextDecoder().decode(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data),
    );
  } catch {
    throw new StorageError(
      "DECRYPTION_FAILED",
      "无法解密连接配置，请恢复原 STORAGE_ENCRYPTION_KEY",
    );
  }
}
