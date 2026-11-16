import {
  and,
  db,
  digest,
  eq,
  insert,
  now,
  oneOf,
  or,
  update,
  type Mutation,
  type Row,
} from "./storage/client";
import { StorageError } from "./storage/model";
import type { Env } from "./types";

export const WEBHOOK_EVENTS = [
  "mail.received",
  "code.extracted",
  "token.renew_failed",
  "storage.sync_interrupted",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const WEBHOOK_MAX_ATTEMPTS = 8;
export function webhookUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StorageError(
      "INVALID_WEBHOOK_URL",
      "请输入有效的 HTTPS 通知地址",
      400,
    );
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password ||
    url.hash ||
    value.length > 2000 ||
    !host.includes(".") ||
    !/^[a-z0-9.-]+$/.test(host) ||
    /^\d+(\.\d+){3}$/.test(host) ||
    /(^|\.)(localhost|local|internal|test|invalid|example|home|lan)$/.test(host)
  )
    throw new StorageError(
      "INVALID_WEBHOOK_URL",
      "通知地址必须是公网 HTTPS 域名，不接受 IP、内网地址、凭据或重定向",
      400,
    );
  return url.toString();
}
function publicIp(value: string) {
  if (value.includes(":")) {
    const compressed = value.split("::");
    if (compressed.length > 2) return false;
    const left = compressed[0] ? compressed[0].split(":") : [];
    const right = compressed[1] ? compressed[1].split(":") : [];
    if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/i.test(part)))
      return false;
    const missing = 8 - left.length - right.length;
    if (compressed.length === 1 ? missing !== 0 : missing < 1) return false;
    const groups = [
      ...left,
      ...Array.from({ length: missing }, () => "0"),
      ...right,
    ].map((part) => parseInt(part, 16));
    return (
      groups[0] >= 0x2000 &&
      groups[0] <= 0x3fff &&
      !(groups[0] === 0x2001 && (groups[1] < 0x0200 || groups[1] === 0x0db8)) &&
      groups[0] !== 0x2002 &&
      groups[0] !== 0x3fff
    );
  }
  const a = value.split(".").map(Number);
  return (
    a.length === 4 &&
    a.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    ![0, 10, 127].includes(a[0]) &&
    a[0] < 224 &&
    !(a[0] === 169 && a[1] === 254) &&
    !(a[0] === 172 && a[1] >= 16 && a[1] <= 31) &&
    !(a[0] === 192 && (a[1] === 168 || a[1] === 0)) &&
    !(a[0] === 100 && a[1] >= 64 && a[1] <= 127) &&
    !(a[0] === 198 && [18, 19, 51].includes(a[1])) &&
    !(a[0] === 203 && a[1] === 0 && a[2] === 113)
  );
}
export async function verifyWebhookDestination(value: string) {
  const url = new URL(webhookUrl(value));
  const results = await Promise.all(
    ["A", "AAAA"].map(async (type) => {
      const response = await fetch(
        `https://cloudflare-dns.com/dns-query?${new URLSearchParams({ name: url.hostname, type })}`,
        {
          headers: { Accept: "application/dns-json" },
          redirect: "manual",
          signal: AbortSignal.timeout(4000),
        },
      );
      if (!response.ok) throw new Error("DNS unavailable");
      const data = (await response.json()) as {
        Status?: number;
        Answer?: { type: number; data: string }[];
      };
      if (data.Status !== 0) throw new Error("DNS lookup failed");
      return (data.Answer || [])
        .filter((a) => [1, 28].includes(a.type))
        .map((a) => a.data);
    }),
  );
  const addresses = results.flat();
  if (!addresses.length || addresses.some((ip) => !publicIp(ip)))
    throw new StorageError(
      "WEBHOOK_DESTINATION_BLOCKED",
      "通知域名没有可用的公网地址",
      400,
    );
  return url.toString();
}
export async function webhookSignature(
  secret: string,
  timestamp: string,
  payload: string,
) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${timestamp}.${payload}`),
    ),
  );
  return `sha256=${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
// Returning mutations lets the mail receiver persist the event with the mail.
export async function webhookMutations(
  env: Env,
  event: WebhookEvent,
  payload: Record<string, unknown>,
  eventId: string,
): Promise<Mutation[]> {
  const hooks = await db(env).select("webhooks", {
    where: eq("enabled", 1),
    limit: 50,
  });
  const mutations: Mutation[] = [];
  for (const hook of hooks) {
    if (!(JSON.parse(String(hook.events)) as string[]).includes(event))
      continue;
    const data: Record<string, unknown> = {};
    for (const key of [
      "mail_id",
      "account_id",
      "recipient",
      "sender",
      "received_at",
      "error_code",
      "job_id",
      "source_id",
      "target_id",
    ])
      if (typeof payload[key] === "string" || typeof payload[key] === "number")
        data[key] =
          typeof payload[key] === "string"
            ? String(payload[key]).slice(0, 500)
            : payload[key];
    if (hook.include_code) {
      if (typeof payload.subject === "string")
        data.subject = payload.subject.slice(0, 500);
      if (typeof payload.code === "string")
        data.code = payload.code.slice(0, 32);
      if (typeof payload.link === "string")
        data.link = payload.link.slice(0, 2000);
    }
    const id = await digest([eventId, hook.id]);
    const body = JSON.stringify({
      id: eventId,
      event,
      created_at: now(),
      data,
    });
    mutations.push(
      insert(
        "webhook_deliveries",
        {
          id,
          webhook_id: hook.id,
          event,
          payload: body,
          next_attempt: Date.now(),
        },
        { conflict: "ignore" },
      ),
    );
  }
  return mutations;
}
export async function enqueueEvent(
  env: Env,
  event: WebhookEvent,
  payload: Record<string, unknown>,
  eventId: string,
) {
  const mutations = await webhookMutations(env, event, payload, eventId);
  if (mutations.length) await db(env).mutate(mutations);
}
export async function runWebhookDeliveries(env: Env) {
  const time = Date.now();
  const rows = await db(env).select("webhook_deliveries", {
    where: and(
      oneOf("status", ["pending", "delivering"]),
      { field: "next_attempt", op: "lte", value: time },
      { field: "lease_until", op: "lte", value: time },
    ),
    order: [["next_attempt", "asc"]],
    limit: 10,
  });
  let processed = 0;
  for (let i = 0; i < rows.length; i += 2) {
    await Promise.all(
      rows.slice(i, i + 2).map(async (row) => {
        if (Number(row.attempts) >= WEBHOOK_MAX_ATTEMPTS) {
          await db(env).mutate([
            update(
              "webhook_deliveries",
              and(
                eq("id", row.id),
                eq("lease_token", row.lease_token),
                eq("status", row.status),
                eq("attempts", row.attempts),
              ),
              {
                status: "dead",
                error:
                  "已达到最大投递次数；最后一次结果可能未知，请先核对接收方",
                lease_token: "",
                lease_until: 0,
                updated_at: now(),
              },
            ),
          ]);
          return;
        }
        const lease = crypto.randomUUID();
        const [claimed] = await db(env).mutate([
          {
            op: "update",
            table: "webhook_deliveries",
            where: and(
              eq("id", row.id),
              eq("lease_token", row.lease_token),
              eq("status", row.status),
              eq("attempts", row.attempts),
            ),
            set: {
              status: "delivering",
              lease_token: lease,
              lease_until: Date.now() + 60000,
              updated_at: now(),
            },
            increment: { attempts: 1 },
          },
        ]);
        if (!claimed.changes) return;
        const hook = await db(env).first("webhooks", eq("id", row.webhook_id));
        let patch: Row = {};
        const attempt = Number(row.attempts) + 1;
        if (!hook || !hook.enabled)
          patch = { status: "cancelled", error: "订阅已停用或删除" };
        else {
          let status = 0,
            retryAfter = 0;
          try {
            const url = await verifyWebhookDestination(String(hook.url));
            const timestamp = String(Math.floor(Date.now() / 1000));
            const payload = String(row.payload);
            const response = await fetch(url, {
              method: "POST",
              redirect: "manual",
              signal: AbortSignal.timeout(8000),
              headers: {
                "Content-Type": "application/json",
                "X-MailHub-Event": String(row.event),
                "X-MailHub-Delivery": String(row.id),
                "X-MailHub-Timestamp": timestamp,
                "X-MailHub-Signature": await webhookSignature(
                  String(hook.secret),
                  timestamp,
                  payload,
                ),
              },
              body: payload,
            });
            status = response.status;
            const retryHeader = response.headers.get("Retry-After") || "";
            retryAfter = /^\d+$/.test(retryHeader)
              ? Number(retryHeader) * 1000
              : Math.max(0, Date.parse(retryHeader) - Date.now()) || 0;
            await response.body?.cancel();
            patch = response.ok
              ? { status: "delivered", error: "" }
              : { error: `接收方返回 HTTP ${status}` };
          } catch {
            patch = { error: "通知投递失败：网络、TLS 或公网地址检查未通过" };
          }
          patch.http_status = status;
          if (patch.status !== "delivered") {
            const retryable =
              status === 0 || [408, 425, 429].includes(status) || status >= 500;
            patch.status =
              retryable && attempt < WEBHOOK_MAX_ATTEMPTS ? "pending" : "dead";
            patch.next_attempt =
              Date.now() +
              Math.min(
                86400000,
                Math.max(
                  retryAfter,
                  Math.min(3600000, 30000 * 2 ** Math.min(attempt - 1, 7)),
                ) + Math.floor(Math.random() * 5000),
              );
          }
        }
        await db(env).mutate([
          update(
            "webhook_deliveries",
            and(eq("id", row.id), eq("lease_token", lease)),
            {
              ...patch,
              lease_until: 0,
              lease_token: "",
              updated_at: now(),
            },
          ),
        ]);
        processed++;
      }),
    );
  }
  return { processed };
}
