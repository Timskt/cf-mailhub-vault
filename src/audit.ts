import {
  db,
  insert,
  now,
  oneOf,
  remove,
  type Mutation,
} from "./storage/client";
import type { Env } from "./types";
import type { AuthContext } from "./api-keys";

export const AUDIT_RETENTION_DAYS = 90;
export interface AuditEvent {
  actor_type: string;
  actor_id: string;
  api_key_prefix?: string;
  request_id?: string;
  action: string;
  resource?: string;
  method?: string;
  route?: string;
  status?: number;
  metadata?: Record<string, unknown>;
}
/** Only values with a defined, non-content meaning can enter audit metadata.
 * No request/response body, URL, provider exception, arbitrary note or nested object is logged.
 */
export function redactAuditMetadata(value: Record<string, unknown> = {}) {
  const safe: Record<string, number | boolean | string[]> = {};
  for (const field of [
    "count",
    "deleted",
    "changed",
    "rows",
    "bytes",
    "retention_days",
  ]) {
    const number = value[field];
    if (
      typeof number === "number" &&
      Number.isSafeInteger(number) &&
      number >= 0
    )
      safe[field] = number;
  }
  for (const field of [
    "replayed",
    "include_credentials",
    "dry_run",
    "revoked",
    "writes_performed",
  ])
    if (typeof value[field] === "boolean") safe[field] = value[field];
  if (Array.isArray(value.scopes))
    safe.scopes = value.scopes.filter((s) =>
      [
        "verify:read",
        "mailbox:write",
        "vault:read",
        "vault:write",
        "admin",
      ].includes(s),
    );
  return safe;
}
const segments = new Set([
  "api",
  "auth",
  "login",
  "logout",
  "me",
  "api-keys",
  "audit",
  "backups",
  "manifest",
  "export",
  "dry-run",
  "restore",
  "settings",
  "credentials",
  "rekey",
  "password",
  "api-key",
  "storage",
  "sources",
  "sync",
  "retry",
  "cancel",
  "health",
  "domains",
  "check",
  "automation",
  "verification",
  "mailbox",
  "batch",
  "vault",
  "platforms",
  "stats",
  "import",
  "pin",
  "code",
  "outlook",
  "oauth",
  "start",
  "callback",
  "accounts",
  "messages",
  "attachments",
  "emails",
  "groups",
  "tags",
  "renewal",
  "run",
  "parse-preview",
  "batch-import",
  "mailboxes",
  "generate",
  "custom",
  "batch-preview",
  "extend",
  "toggle-permanent",
  "link-vault",
  "cf-mails",
  "recipients",
  "clean",
  "mail-rules",
  "preview",
  "apply",
  "list",
  "view",
  "external",
  "register",
  "search",
  "capabilities",
]);
export function auditRoute(path: string) {
  return path
    .split("?")[0]
    .split("/")
    .slice(0, 12)
    .map((part) =>
      !part || segments.has(part)
        ? part
        : /^\d+$/.test(part)
          ? ":id"
          : ":resource",
    )
    .join("/")
    .slice(0, 300);
}
export function auditResource(path: string) {
  if (path.includes("/api-keys")) return "api_keys";
  if (path.includes("/backups")) return "backup";
  if (path.includes("/audit")) return "audit";
  if (path.startsWith("/api/vault")) return "vault";
  if (path.startsWith("/api/outlook")) return "outlook";
  if (path.startsWith("/api/mailbox")) return "mailbox";
  if (/^\/api\/(cf-mails|emails|mail-rules)/.test(path)) return "mail";
  if (path.startsWith("/api/settings")) return "settings";
  if (path.startsWith("/api/auth")) return "auth";
  if (/^\/api\/(automation|external)/.test(path)) return "automation";
  return "api";
}
const safeIdentifier = (value: string, max: number) =>
  /^[a-zA-Z0-9_.:-]+$/.test(value) ? value.slice(0, max) : "";
export async function recordAudit(env: Env, event: AuditEvent) {
  const store = db(env);
  const expired = await store.select<{ id: number }>("audit_logs", {
    where: {
      field: "created_at",
      op: "lt",
      value: new Date(
        Date.now() - AUDIT_RETENTION_DAYS * 86400000,
      ).toISOString(),
    },
    columns: ["id"],
    limit: 100,
    order: [["id", "asc"]],
  });
  const mutations: Mutation[] = [];
  if (expired.length)
    mutations.push(
      remove(
        "audit_logs",
        oneOf(
          "id",
          expired.map((r) => r.id),
        ),
      ),
    );
  mutations.push(
    insert("audit_logs", {
      actor_type: [
        "admin_session",
        "api_key",
        "master_key",
        "anonymous",
        "system",
      ].includes(event.actor_type)
        ? event.actor_type
        : "system",
      actor_id: safeIdentifier(event.actor_id, 120),
      api_key_prefix: safeIdentifier(event.api_key_prefix || "", 16),
      request_id: safeIdentifier(event.request_id || "", 80),
      action: safeIdentifier(event.action, 80),
      resource: safeIdentifier(event.resource || "", 40),
      method: [
        "GET",
        "HEAD",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS",
      ].includes(event.method || "")
        ? event.method!
        : "",
      route: auditRoute(event.route || ""),
      status:
        Number.isInteger(event.status) &&
        event.status! >= 100 &&
        event.status! <= 599
          ? event.status!
          : 0,
      metadata: JSON.stringify(redactAuditMetadata(event.metadata)),
      created_at: now(),
    }),
  );
  await store.mutate(mutations);
}
export function auditIdentity(auth: AuthContext) {
  return {
    actor_type: auth.kind,
    actor_id: auth.actor,
    api_key_prefix: auth.keyPrefix,
  };
}
