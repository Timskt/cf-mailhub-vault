import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  and,
  db,
  digest,
  eq,
  insert,
  now,
  oneOf,
  remove,
  storageCall,
  update,
  type Row,
} from "./storage/client";
import {
  authenticateApiKey,
  AuthorizationError,
  authorizeApiRequest,
  touchApiKey,
  type AuthContext,
} from "./api-keys";
import { auditIdentity, auditResource, auditRoute, recordAudit } from "./audit";
import type { Env } from "./types";
import { invalid } from "./validation";

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext | undefined;
  }
}
export type { AuthContext } from "./api-keys";
const COOKIE_NAME = "mailhub_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) || [], (n) => parseInt(n, 16));
const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
export async function sha256(value: string): Promise<string> {
  return hex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}
async function key(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function getSessionSecret(env: Env): Promise<string> {
  const settings = env.STORAGE
    ? await storageCall<Record<string, string>>(env, "/auth/settings")
    : Object.fromEntries(
        (
          await db(env).select<{ key: string; value: string }>("settings", {
            where: oneOf("key", ["session_secret", "session_epoch"]),
          })
        ).map((r) => [r.key, r.value]),
      );
  let secret = env.COOKIE_SECRET || settings.session_secret;
  if (!secret) {
    const generated = crypto.randomUUID() + crypto.randomUUID();
    await db(env).mutate([
      insert(
        "settings",
        { key: "session_secret", value: generated },
        { conflict: "ignore" },
      ),
    ]);
    secret = (await db(env).first<{ value: string }>(
      "settings",
      eq("key", "session_secret"),
    ))!.value;
  }
  return `${secret}:${settings.session_epoch || "0"}`;
}
export async function createSessionToken(
  username: string,
  secret: string,
): Promise<string> {
  const payload = `${username}:${Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS}:${crypto.randomUUID()}`;
  return `${btoa(payload)}.${hex(await crypto.subtle.sign("HMAC", await key(secret), new TextEncoder().encode(payload)))}`;
}
export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<boolean> {
  try {
    const pieces = token.split(".");
    if (pieces.length !== 2 || !/^[a-f0-9]{64}$/.test(pieces[1])) return false;
    const payload = atob(pieces[0]);
    const parts = payload.split(":");
    const [username, expiry] = parts;
    if (
      (parts.length !== 2 && parts.length !== 3) ||
      (parts.length === 3 && !/^[a-f0-9-]{36}$/.test(parts[2])) ||
      username !== "admin" ||
      !/^\d+$/.test(expiry) ||
      Number(expiry) <= Date.now() / 1000
    )
      return false;
    return crypto.subtle.verify(
      "HMAC",
      await key(secret),
      bytes(pieces[1]),
      new TextEncoder().encode(payload),
    );
  } catch {
    return false;
  }
}
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const imported = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    imported,
    256,
  );
  return `pbkdf2:100000:${hex(salt.buffer)}:${hex(hash)}`;
}
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  if (!stored.startsWith("pbkdf2:"))
    return /^[a-f0-9]{64}$/.test(stored) && (await sha256(password)) === stored;
  const [scheme, iterations, salt, expected] = stored.split(":");
  if (
    scheme !== "pbkdf2" ||
    iterations !== "100000" ||
    !/^[a-f0-9]{32}$/.test(salt) ||
    !/^[a-f0-9]{64}$/.test(expected)
  )
    return false;
  const imported = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: bytes(salt), iterations: 100000, hash: "SHA-256" },
    imported,
    256,
  );
  const a = bytes(hex(hash)),
    b = bytes(expected);
  return a.every((value, index) => value === b[index]);
}
export async function authConfigured(env: Env) {
  return Boolean(
    env.ADMIN_PASSWORD ||
    (env.STORAGE
      ? (await storageCall<Record<string, string>>(env, "/auth/settings"))
          .admin_password
      : (
          await db(env).first<{ value: string }>(
            "settings",
            eq("key", "admin_password"),
          )
        )?.value),
  );
}
type SecurityContext = Context<{ Bindings: Env }>;
const processed = new WeakSet<object>();
export const IDEMPOTENCY_RETENTION_SECONDS = 7 * 86400;
export const IDEMPOTENCY_RESPONSE_LIMIT = 256 * 1024;
const MAX_IDEMPOTENCY_PER_ACTOR = 1000;
function sensitiveRead(path: string) {
  return (
    /^\/api\/vault\/(?:\d+|export)\/?$/.test(path) ||
    /^\/api\/outlook\/accounts\/(?:export|\d+(?:\/(?:emails|raw|messages(?:\/.*)?))?)\/?$/.test(
      path,
    ) ||
    /^\/api\/cf-mails\/\d+(?:\/(?:raw|attachments\/[^/]+))?\/?$/.test(path) ||
    /^\/api\/emails\/view\/\d+\/?$/.test(path) ||
    /^\/api\/(?:settings\/api-key|backups\/export)\/?$/.test(path)
  );
}
function failure(
  c: SecurityContext,
  error: string,
  message: string,
  status: 400 | 401 | 403 | 409 | 413 | 429 | 503 = 401,
) {
  return c.json({ success: false, error, message }, status);
}
/** Never use untrusted request headers to create an auth context. An explicitly supplied
 * invalid key does not fall back to the browser cookie, even when that cookie is valid.
 */
async function identify(c: SecurityContext): Promise<AuthContext | Response> {
  const xKey = c.req.header("X-API-Key"),
    authorization = c.req.header("Authorization");
  if (xKey !== undefined || authorization !== undefined) {
    const bearer = authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1];
    if (
      (authorization !== undefined && !bearer) ||
      (xKey !== undefined && (!xKey || /[\s,]/.test(xKey))) ||
      (xKey && bearer && xKey !== bearer)
    )
      return failure(c, "INVALID_API_KEY", "请提供单个有效的 API Key");
    const token = xKey || bearer!;
    if (token.length > 256)
      return failure(c, "INVALID_API_KEY", "API Key 无效或已到期");
    if (
      c.env.API_KEY &&
      (await sha256(token)) === (await sha256(c.env.API_KEY))
    )
      return Object.freeze({
        kind: "master_key",
        actor: `master:${await sha256(token)}`,
        keyPrefix: "master",
        scopes: Object.freeze(["admin"] as const),
        restrictions: Object.freeze({}),
      });
    const auth = await authenticateApiKey(c.env, token);
    return (
      auth || failure(c, "INVALID_API_KEY", "API Key 无效、已撤销或已到期")
    );
  }
  if (!(await authConfigured(c.env)))
    return failure(c, "AUTH_NOT_CONFIGURED", "请先配置管理员密码", 503);
  const token = getCookie(c, COOKIE_NAME);
  if (token && (await verifySessionToken(token, await getSessionSecret(c.env))))
    return Object.freeze({
      kind: "admin_session",
      actor: `session:${await sha256(token)}`,
      keyPrefix: "",
      scopes: Object.freeze(["admin"] as const),
      restrictions: Object.freeze({}),
    });
  return failure(c, "UNAUTHORIZED", "登录已过期，请重新登录");
}
export function adminSessionMiddleware() {
  return async (c: SecurityContext, next: Next) => {
    // This guard verifies the cookie independently when composed without global auth.
    const attached = c.get("auth");
    if (
      attached
        ? attached.kind !== "admin_session"
        : c.req.header("X-API-Key") !== undefined ||
          c.req.header("Authorization") !== undefined
    )
      return failure(
        c,
        "ADMIN_SESSION_REQUIRED",
        "此操作需要管理员登录会话",
        401,
      );
    const token = getCookie(c, COOKIE_NAME);
    if (
      !token ||
      !(await authConfigured(c.env)) ||
      !(await verifySessionToken(token, await getSessionSecret(c.env)))
    )
      return failure(
        c,
        "ADMIN_SESSION_REQUIRED",
        "此操作需要管理员登录会话",
        401,
      );
    return next();
  };
}
async function responseKey(env: Env) {
  // A dedicated purpose label prevents cross-protocol use of the session signing secret.
  // Rotating the session secret/epoch makes old results unreadable; those requests stay
  // uncertain and must be read back, never re-executed automatically.
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `mailhub:idempotency:v1:${await getSessionSecret(env)}`,
    ),
  );
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}
function encode64(value: ArrayBuffer | Uint8Array) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
function decode64(value: string) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
async function sealResponse(env: Env, id: string, body: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) },
    await responseKey(env),
    new TextEncoder().encode(body),
  );
  return `v1.${encode64(iv)}.${encode64(sealed)}`;
}
async function openResponse(env: Env, id: string, value: string) {
  const [version, iv, ciphertext, extra] = value.split(".");
  if (version !== "v1" || !iv || !ciphertext || extra)
    throw new Error("Invalid response envelope");
  const body = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decode64(iv),
      additionalData: new TextEncoder().encode(id),
    },
    await responseKey(env),
    decode64(ciphertext),
  );
  return new TextDecoder().decode(body);
}
function unknownOutcome(c: SecurityContext) {
  return failure(
    c,
    "IDEMPOTENCY_UNKNOWN",
    "该请求正在处理或结果无法确认。请查询资源状态，不要更换 Key 自动重复写入",
    409,
  );
}
interface Reservation {
  id: string;
  request_hash: string;
}
async function reserve(
  c: SecurityContext,
  auth: AuthContext,
): Promise<Reservation | Response | undefined> {
  const supplied = c.req.header("Idempotency-Key");
  if (
    supplied === undefined ||
    ["GET", "HEAD", "OPTIONS"].includes(c.req.method)
  )
    return;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(supplied))
    invalid("Idempotency-Key 须为 1–128 位字母、数字或 . _ : -");
  const rawBody = await c.req.text();
  const largeMail =
    c.req.method === "POST" &&
    /^\/api\/outlook\/accounts\/\d+\/(?:send|messages\/[^/]+\/reply)$/.test(
      c.req.path,
    );
  const maxBytes = (largeMail ? 5 : 2) * 1024 * 1024;
  if (new TextEncoder().encode(rawBody).byteLength > maxBytes)
    return failure(
      c,
      "REQUEST_TOO_LARGE",
      `幂等请求超过 ${largeMail ? 5 : 2} MiB 限制`,
      413,
    );
  const route = `${c.req.method} ${c.req.path}`;
  const keyHash = await sha256(supplied),
    id = await digest([auth.actor, route, keyHash]);
  const requestHash = await digest({
    body: await sha256(rawBody),
    query: new URL(c.req.url).search,
    content_type: c.req.header("Content-Type") || "",
  });
  const store = db(c.env);
  async function replay(row: Row) {
    if (row.request_hash !== requestHash)
      return failure(
        c,
        "IDEMPOTENCY_CONFLICT",
        "此 Idempotency-Key 已用于不同的请求内容",
        409,
      );
    if (
      row.state !== "complete" ||
      Date.parse(String(row.expires_at)) <= Date.now()
    )
      return unknownOutcome(c);
    try {
      const status = Number(row.response_status);
      if (status < 200 || status >= 300 || !Number.isInteger(status))
        return unknownOutcome(c);
      const body = await openResponse(
        c.env,
        id,
        String(row.response_ciphertext),
      );
      const headers = JSON.parse(String(row.response_headers));
      c.header("Idempotency-Replayed", "true");
      c.header("Idempotency-Key-Expires-At", String(row.expires_at));
      // Never replay cookies, authorization headers, old request IDs or Location URLs.
      if (typeof headers["Content-Type"] === "string")
        c.header("Content-Type", headers["Content-Type"]);
      return c.newResponse(
        status === 204 || status === 205 ? null : body,
        status as 200,
      );
    } catch {
      return unknownOutcome(c);
    }
  }
  const prior = await store.first("idempotency_requests", eq("id", id));
  if (prior) return replay(prior);
  // Only confirmed successes expire. Pending/unknown outcomes are durable tombstones:
  // elapsed time is not evidence that a write failed. Recheck state in the mutation.
  const expiredWhere = and(eq("state", "complete"), {
    field: "expires_at",
    op: "lt",
    value: now(),
  });
  const expired = await store.select<{ id: string }>("idempotency_requests", {
    where: expiredWhere,
    columns: ["id"],
    limit: 100,
  });
  if (expired.length)
    await store.mutate([
      remove(
        "idempotency_requests",
        and(
          oneOf(
            "id",
            expired.map((r) => r.id),
          ),
          expiredWhere,
        ),
      ),
    ]);
  if (
    (await store.count("idempotency_requests", eq("actor", auth.actor))) >=
    MAX_IDEMPOTENCY_PER_ACTOR
  )
    return failure(
      c,
      "IDEMPOTENCY_LIMIT",
      "该身份的幂等记录已达到上限；不确定记录需人工核对后管理，不会自动清除",
      429,
    );
  const expiresAt = new Date(
    Date.now() + IDEMPOTENCY_RETENTION_SECONDS * 1000,
  ).toISOString();
  try {
    await store.mutate([
      insert("idempotency_requests", {
        id,
        actor: auth.actor,
        key_hash: keyHash,
        request_hash: requestHash,
        route,
        state: "in_progress",
        response_status: 0,
        response_headers: "{}",
        response_ciphertext: "",
        expires_at: expiresAt,
        created_at: now(),
        updated_at: now(),
      }),
    ]);
  } catch (error) {
    // Uniqueness is enforced by the storage transaction, not an isolate-local lock.
    // If the reservation commit itself lost its acknowledgement, do not run the mutation.
    const concurrent = await store.first("idempotency_requests", eq("id", id));
    if (concurrent) return replay(concurrent);
    throw error;
  }
  c.header("Idempotency-Key-Expires-At", expiresAt);
  return { id, request_hash: requestHash };
}
async function finishReservation(c: SecurityContext, reservation: Reservation) {
  const response = c.res;
  let state = "unknown",
    ciphertext = "",
    headers = "{}";
  if (response.ok && !response.headers.has("Set-Cookie")) {
    const declared = Number(response.headers.get("Content-Length"));
    if (!declared || declared <= IDEMPOTENCY_RESPONSE_LIMIT) {
      // JSON API handlers already materialize their bounded response. Large exports are
      // intentionally left unknown so an oversized response never enters the replay store.
      const body = await response.clone().text();
      if (
        new TextEncoder().encode(body).byteLength <= IDEMPOTENCY_RESPONSE_LIMIT
      ) {
        ciphertext = await sealResponse(c.env, reservation.id, body);
        state = "complete";
        headers = JSON.stringify({
          "Content-Type":
            response.headers.get("Content-Type") || "application/json",
        });
      }
    }
  }
  await db(c.env).mutate([
    update(
      "idempotency_requests",
      and(
        eq("id", reservation.id),
        eq("request_hash", reservation.request_hash),
        eq("state", "in_progress"),
      ),
      {
        state,
        response_status: response.status,
        response_headers: headers,
        response_ciphertext: ciphertext,
        updated_at: now(),
      },
    ),
  ]);
}
/** Mount before every API route, including /api/external. authMiddleware is the legacy
 * alias so existing mounts gain authorization/audit/idempotency without changing index.ts.
 * New modules may also use it locally; nested execution is de-duplicated per Context.
 */
export function securityMiddleware() {
  return async (c: SecurityContext, next: Next) => {
    if (processed.has(c)) return next();
    const requestId = c.res.headers.get("X-Request-ID") || crypto.randomUUID();
    c.header("X-Request-ID", requestId);
    c.header("Cache-Control", "no-store");
    const write = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    if (
      write &&
      (c.req.header("Sec-Fetch-Site") === "cross-site" ||
        (c.req.header("Origin") &&
          c.req.header("Origin") !== new URL(c.req.url).origin))
    )
      return failure(c, "CROSS_SITE_REQUEST", "拒绝跨站写入请求", 403);
    const auth = await identify(c);
    if (auth instanceof Response) return auth;
    c.set("auth", auth);
    const log = (status: number, replayed = false) =>
      recordAudit(c.env, {
        ...auditIdentity(auth),
        request_id: requestId,
        action: `${c.req.method.toLowerCase()}.${auditResource(c.req.path)}`,
        resource: auditResource(c.req.path),
        method: c.req.method,
        route: auditRoute(c.req.path),
        status,
        metadata: { replayed },
      });
    try {
      await authorizeApiRequest(c, auth);
    } catch (error) {
      if (!(error instanceof AuthorizationError)) throw error;
      const status = error.code === "ADMIN_SESSION_REQUIRED" ? 401 : 403;
      await log(status);
      return failure(c, error.code, error.message, status);
    }
    const reservation = await reserve(c, auth);
    if (reservation instanceof Response) {
      await log(
        reservation.status,
        c.res.headers.get("Idempotency-Replayed") === "true",
      );
      return reservation;
    }
    // Write the intent before any mutation, so an audit-storage failure fails closed.
    if (write) await log(0);
    processed.add(c);
    try {
      await next();
      if (reservation) await finishReservation(c, reservation);
      // Post-action telemetry must not turn a known success into an ambiguous 500.
      try {
        // Listing audit events or polling inventories must not create an endless
        // stream of writes and invalidate otherwise consistent backup snapshots.
        if (write || c.res.status === 403 || sensitiveRead(c.req.path))
          await log(c.res.status);
        await touchApiKey(c.env, auth);
      } catch {
        console.error("Security metadata update failed", {
          request_id: requestId,
        });
      }
    } catch (error) {
      // An interrupted or uncertain request retains its durable reservation. There is no
      // automatic lease takeover: the next matching call must perform a read-back instead.
      throw error;
    }
  };
}
export const authMiddleware = securityMiddleware;
export function setSessionCookie(c: Context<{ Bindings: Env }>, token: string) {
  setCookie(c, COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    maxAge: SESSION_TTL_SECONDS,
  });
}
export function clearSessionCookie(c: Context<{ Bindings: Env }>) {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}
