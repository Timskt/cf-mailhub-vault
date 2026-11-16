import { StorageError } from "./model";
import { RedisPort, type RedisCommands } from "./redis-port";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_RESPONSE = 16 * 1024 * 1024;
type Reply = string | number | null | Reply[];

export function redisConnection(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new StorageError(
      "INVALID_REDIS_URL",
      "请填写有效的 redis:// 或 rediss:// 连接地址",
      400,
    );
  }
  const database = url.pathname.replace(/^\//, "") || "0";
  if (
    !["redis:", "rediss:"].includes(url.protocol) ||
    !url.hostname ||
    !url.password ||
    url.search ||
    url.hash ||
    !/^\d{1,2}$/.test(database) ||
    Number(database) > 15 ||
    /^(localhost|127\.|0\.|169\.254\.|\[::1\])/i.test(url.hostname) ||
    url.hostname.endsWith(".local")
  )
    throw new StorageError(
      "INVALID_REDIS_URL",
      "请提供含密码的公网 Redis 地址，数据库编号为 0–15；不支持查询参数",
      400,
    );
  try {
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
  } catch {
    throw new StorageError(
      "INVALID_REDIS_URL",
      "连接地址中的用户名或密码编码无效",
      400,
    );
  }
  return {
    url,
    database: Number(database),
    endpoint: `${url.protocol}//${url.host}/${database}`,
  };
}

export function encodeRedis(args: (string | number)[]) {
  const chunks = [encoder.encode(`*${args.length}\r\n`)];
  for (const arg of args) {
    const bytes = encoder.encode(String(arg));
    chunks.push(
      encoder.encode(`$${bytes.length}\r\n`),
      bytes,
      encoder.encode("\r\n"),
    );
  }
  const result = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export class RedisReader {
  private buffer = new Uint8Array(0);
  private offset = 0;
  private received = 0;
  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}
  private async more() {
    const { done, value } = await this.reader.read();
    if (done)
      throw new StorageError(
        "REDIS_DISCONNECTED",
        "Redis 连接在响应完成前关闭",
      );
    this.received += value.length;
    if (this.received > MAX_RESPONSE)
      throw new StorageError(
        "REDIS_RESPONSE_LIMIT",
        "Redis 响应超过容量限制",
        413,
      );
    const combined = new Uint8Array(
      this.buffer.length - this.offset + value.length,
    );
    combined.set(this.buffer.subarray(this.offset));
    combined.set(value, this.buffer.length - this.offset);
    this.buffer = combined;
    this.offset = 0;
  }
  private async bytes(length: number) {
    while (this.buffer.length - this.offset < length) await this.more();
    const result = this.buffer.slice(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  private async line() {
    for (;;) {
      for (let i = this.offset; i + 1 < this.buffer.length; i++) {
        if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) {
          const line = decoder.decode(this.buffer.subarray(this.offset, i));
          this.offset = i + 2;
          return line;
        }
      }
      if (this.buffer.length - this.offset > 65536)
        throw new StorageError("REDIS_PROTOCOL_ERROR", "Redis 响应格式无效");
      await this.more();
    }
  }
  async read(depth = 0): Promise<Reply> {
    if (depth > 8)
      throw new StorageError("REDIS_PROTOCOL_ERROR", "Redis 响应嵌套过深");
    const prefix = decoder.decode(await this.bytes(1));
    const line = await this.line();
    if (prefix === "+") return line;
    if (prefix === "-") {
      const code = [
        "WRONGPASS",
        "NOAUTH",
        "NOPERM",
        "OOM",
        "DATASET_MISSING",
        "OWNER_CONFLICT",
        "REVISION_CONFLICT",
      ].find((c) => line.includes(c));
      throw new StorageError(
        code ? `REDIS_${code}` : "REDIS_COMMAND_FAILED",
        code === "WRONGPASS" || code === "NOAUTH"
          ? "Redis 用户名或密码无效"
          : code === "OOM"
            ? "Redis 容量不足，原数据源继续保留"
            : "Redis 拒绝了请求，请检查权限、容量或数据集状态",
        code === "OWNER_CONFLICT" || code === "REVISION_CONFLICT" ? 409 : 503,
      );
    }
    if (!/^-?\d+$/.test(line))
      throw new StorageError("REDIS_PROTOCOL_ERROR", "Redis 响应格式无效");
    const number = Number(line);
    if (!Number.isSafeInteger(number))
      throw new StorageError("REDIS_PROTOCOL_ERROR", "Redis 响应数值无效");
    if (prefix === ":") return number;
    if (number === -1 && (prefix === "$" || prefix === "*")) return null;
    if (number < 0 || number > MAX_RESPONSE)
      throw new StorageError(
        "REDIS_RESPONSE_LIMIT",
        "Redis 响应超过容量限制",
        413,
      );
    if (prefix === "$") {
      const data = await this.bytes(number),
        end = await this.bytes(2);
      if (end[0] !== 13 || end[1] !== 10)
        throw new StorageError("REDIS_PROTOCOL_ERROR", "Redis 响应格式无效");
      return decoder.decode(data);
    }
    if (prefix === "*" && number <= 200000) {
      const items: Reply[] = [];
      for (let i = 0; i < number; i++) items.push(await this.read(depth + 1));
      return items;
    }
    throw new StorageError("REDIS_PROTOCOL_ERROR", "Redis 响应格式无效");
  }
}

export class WorkerRedis implements RedisCommands {
  constructor(private connection: string) {}
  async command(...args: (string | number)[]): Promise<Reply> {
    const { url, database } = redisConnection(this.connection);
    const { connect } = await import("cloudflare:sockets");
    const socket = connect(
      { hostname: url.hostname, port: Number(url.port) || 6379 },
      {
        secureTransport: url.protocol === "rediss:" ? "on" : "off",
        allowHalfOpen: false,
      },
    );
    void socket.closed.catch(() => undefined);
    const writer = socket.writable.getWriter(),
      reader = socket.readable.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          await socket.opened;
          const commands: (string | number)[][] = [
            [
              "AUTH",
              decodeURIComponent(url.username || "default"),
              decodeURIComponent(url.password),
            ],
          ];
          if (database) commands.push(["SELECT", database]);
          commands.push(args);
          for (const command of commands)
            await writer.write(encodeRedis(command));
          const replies = new RedisReader(reader);
          for (let i = 0; i < commands.length - 1; i++) await replies.read();
          return replies.read();
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new StorageError("REDIS_TIMEOUT", "Redis 连接超时，请稍后重试"),
              ),
            12000,
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(
        "REDIS_UNREACHABLE",
        "无法连接 Redis，请检查地址、TLS、密码和网络访问规则",
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await reader.cancel().catch(() => undefined);
      writer.releaseLock();
      reader.releaseLock();
      await socket.close().catch(() => undefined);
    }
  }
  async hget(key: string, field: string) {
    return (await this.command("HGET", key, field)) as string | null;
  }
  async hsetnx(key: string, field: string, value: string) {
    return (await this.command("HSETNX", key, field, value)) as number;
  }
  async hscan(
    key: string,
    cursor: string,
    match: "MATCH",
    pattern: string,
    count: "COUNT",
    size: number,
  ) {
    return (await this.command(
      "HSCAN",
      key,
      cursor,
      match,
      pattern,
      count,
      size,
    )) as [string, string[]];
  }
  eval(script: string, keys: number, ...args: string[]) {
    return this.command("EVAL", script, keys, ...args);
  }
}

export function directRedisPort(
  connection: string,
  prefix: string,
  generation: string,
  owner: string,
  replica: boolean,
) {
  const client = new WorkerRedis(connection);
  return new RedisPort(
    client,
    `${prefix}:{${generation}}:`,
    owner,
    async () => {
      await client.command("PING");
      if (replica) return;
      const result = (await client.command(
        "CONFIG",
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
          "该 Redis 未通过主库存储检查，请以“数据副本”接入；主库要求 AOF、always fsync 和 noeviction",
          400,
        );
    },
  );
}
