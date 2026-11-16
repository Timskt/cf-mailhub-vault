import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { getSessionSecret, verifySessionToken } from "../auth";
import { storageCall } from "../storage/client";
import { connectionUrl, sealSecret } from "../storage/http";
import { redisConnection } from "../storage/redis-direct";
import type { Source } from "../storage/coordinator";
import type { Env } from "../types";
import { boolean, choice, invalid, object, text } from "../validation";
const app = new Hono<{ Bindings: Env }>();
// Infrastructure administration requires an interactive admin session, not the automation API key.
app.use("*", async (c, next) => {
  const token = getCookie(c, "mailhub_session");
  if (
    !token ||
    !(await verifySessionToken(token, await getSessionSecret(c.env)))
  )
    return c.json(
      { success: false, message: "请使用管理员账号登录后管理数据源" },
      401,
    );
  return next();
});
app.get("/", async (c) =>
  c.json({
    success: true,
    data: c.env.STORAGE
      ? {
          enabled: true,
          encryption_ready: Boolean(
            c.env.STORAGE_ENCRYPTION_KEY &&
            c.env.STORAGE_ENCRYPTION_KEY.length >= 32,
          ),
          ...(await storageCall<Record<string, unknown>>(c.env, "/status")),
        }
      : { enabled: false, encryption_ready: false, sources: [], job: null },
  }),
);
app.post("/sources", async (c) => {
  const body = object(await c.req.json());
  const name = text(body.name, "数据源名称", 80).trim(),
    source = text(body.source, "连接服务中的数据源 ID", 64).trim();
  if (!name || !/^[a-z0-9_-]{1,64}$/.test(source))
    invalid("请填写名称与有效的数据源 ID");
  const kind = choice(body.kind, "数据库类型", ["mysql", "mongodb", "redis"]);
  const transport = choice(
    body.transport,
    "连接方式",
    ["http", "redis"],
    "http",
  );
  if (transport === "redis") {
    if (kind !== "redis") invalid("Redis 直连仅适用于 Redis 数据源");
    const connection = text(body.redis_url, "Redis 连接地址", 2048).trim();
    const { endpoint } = redisConnection(connection);
    const data = await storageCall(c.env, "/sources/add", {
      id: crypto.randomUUID(),
      name,
      kind,
      source,
      endpoint,
      transport,
      purpose: choice(
        body.purpose,
        "数据源用途",
        ["primary", "replica"],
        "replica",
      ),
      secret: await sealSecret(connection, c.env.STORAGE_ENCRYPTION_KEY || ""),
      created: new Date().toISOString(),
    });
    return c.json({
      success: true,
      data,
      message: "Redis 连接已验证，数据源已添加",
    });
  }
  const token = text(body.token, "连接令牌", 1000);
  if (token.length < 32) invalid("连接令牌至少 32 位");
  const data = await storageCall(c.env, "/sources/add", {
    id: crypto.randomUUID(),
    name,
    source,
    kind,
    endpoint: connectionUrl(
      text(body.endpoint, "连接服务地址", 1000),
      c.env.STORAGE_ALLOW_HTTP_LOCAL === "true",
    ),
    secret: await sealSecret(token, c.env.STORAGE_ENCRYPTION_KEY || ""),
    created: new Date().toISOString(),
  });
  return c.json({ success: true, data, message: "连接已验证，数据源已添加" });
});
app.patch("/sources/:id", async (c) => {
  const body = object(await c.req.json()),
    name = text(body.name, "数据源名称", 80).trim(),
    token = text(body.token, "连接令牌", 1000);
  if (!name || (token && token.length < 32))
    invalid("名称不能为空；连接令牌至少 32 位");
  let secret: string | undefined;
  const status = await storageCall<{ sources: Source[] }>(c.env, "/status");
  const source = status.sources.find((s) => s.id === c.req.param("id"));
  if (source?.transport === "redis") {
    if (token) invalid("Redis 直连请使用 Redis 连接地址更新凭据");
    const connection = text(body.redis_url, "Redis 连接地址", 2048).trim();
    if (connection) {
      if (redisConnection(connection).endpoint !== source.endpoint)
        invalid("更换 Redis 服务器或数据库请添加新数据源后同步");
      secret = await sealSecret(connection, c.env.STORAGE_ENCRYPTION_KEY || "");
    }
  } else if (token)
    secret = await sealSecret(token, c.env.STORAGE_ENCRYPTION_KEY || "");
  await storageCall(c.env, "/sources/update", {
    id: c.req.param("id"),
    patch: {
      name,
      ...(secret ? { secret } : {}),
    },
  });
  return c.json({ success: true, message: "连接配置已更新" });
});
app.delete("/sources/:id", async (c) => {
  await storageCall(c.env, "/sources/delete", { id: c.req.param("id") });
  return c.json({ success: true, message: "连接配置已移除，远程数据仍保留" });
});
app.post("/sources/:id/health", async (c) =>
  c.json({
    success: true,
    data: await storageCall(c.env, "/sources/health", {
      id: c.req.param("id"),
    }),
  }),
);
app.post("/sync", async (c) => {
  const body = object(await c.req.json());
  return c.json({
    success: true,
    data: await storageCall(c.env, "/sync/start", {
      id: text(body.source_id, "数据源 ID", 100),
      autoSwitch: boolean(body.auto_switch, "自动切换", true),
      mode: choice(body.mode, "同步方式", ["switch", "snapshot"], "switch"),
    }),
    message: "后台同步已开始，关闭页面后仍会继续",
  });
});
app.post("/sync/retry", async (c) => {
  await storageCall(c.env, "/sync/retry");
  return c.json({ success: true, message: "同步将从断点继续" });
});
app.post("/sync/cancel", async (c) => {
  await storageCall(c.env, "/sync/cancel");
  return c.json({ success: true, message: "同步已取消，继续使用原数据源" });
});
export default app;
