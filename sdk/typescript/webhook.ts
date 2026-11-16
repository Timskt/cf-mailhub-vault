import { MailHubError, invalid } from "./client.js";

export const WEBHOOK_EVENTS = [
  "mail.received",
  "code.extracted",
  "token.renew_failed",
  "storage.sync_interrupted",
] as const;
export interface WebhookPayload {
  id: string;
  event: (typeof WEBHOOK_EVENTS)[number];
  created_at: string;
  data: Record<string, unknown>;
}
export interface WebhookOptions {
  secret: string;
  /** From trusted local subscription configuration, never a request header. */
  subscriptionId: number;
  nowSeconds?: number;
  toleranceSeconds?: number;
}
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
function fail(code: string): never {
  throw new MailHubError(code, "Webhook authentication failed");
}
function equalHash(a: string, b: string) {
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
/** Verify raw bytes before JSON parsing. This authenticates a delivery; the receiver
 * must still persist delivery + hash with a unique constraint before acknowledging. */
export async function verifyWebhook(
  rawBody: Uint8Array,
  headers: Headers | Record<string, string>,
  options: WebhookOptions,
) {
  const tolerance = options.toleranceSeconds ?? 300,
    now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (
    typeof options.secret !== "string" ||
    !options.secret ||
    !Number.isSafeInteger(options.subscriptionId) ||
    options.subscriptionId < 1 ||
    !Number.isFinite(now) ||
    !Number.isFinite(tolerance) ||
    tolerance < 0 ||
    tolerance > 300
  )
    invalid("Invalid webhook receiver configuration");
  if (!(rawBody instanceof Uint8Array) || rawBody.length > 65536)
    fail("INVALID_BODY");
  // Own the bytes/configuration across crypto awaits. The caller may reuse its buffer.
  const bytes = new Uint8Array(rawBody),
    secret = options.secret,
    subscriptionId = options.subscriptionId;
  const incoming = new Headers(headers),
    timestamp = incoming.get("X-MailHub-Timestamp") || "",
    signature = incoming.get("X-MailHub-Signature") || "";
  if (
    !/^\d{1,12}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > tolerance
  )
    fail("STALE_TIMESTAMP");
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) fail("INVALID_SIGNATURE");
  const prefix = encoder.encode(`${timestamp}.`),
    message = new Uint8Array(prefix.length + bytes.length);
  message.set(prefix);
  message.set(bytes, prefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const supplied = Uint8Array.from(signature.slice(7).match(/../g)!, (p) =>
    parseInt(p, 16),
  );
  // Native WebCrypto performs cryptographic signature comparison; never compare HMAC strings.
  if (!(await crypto.subtle.verify("HMAC", key, supplied, message)))
    fail("INVALID_SIGNATURE");
  let payload: WebhookPayload;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return fail("INVALID_EVENT");
  }
  if (
    !payload ||
    typeof payload.id !== "string" ||
    !payload.id ||
    !WEBHOOK_EVENTS.includes(payload.event) ||
    !payload.data ||
    typeof payload.data !== "object" ||
    Array.isArray(payload.data) ||
    typeof payload.created_at !== "string" ||
    !Number.isFinite(Date.parse(payload.created_at))
  )
    fail("INVALID_EVENT");
  if (incoming.get("X-MailHub-Event") !== payload.event) fail("EVENT_MISMATCH");
  const delivery = incoming.get("X-MailHub-Delivery") || "";
  const expectedDelivery = hex(
    await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(JSON.stringify([payload.id, subscriptionId])),
    ),
  );
  if (!equalHash(delivery, expectedDelivery)) fail("DELIVERY_MISMATCH");
  return {
    delivery,
    payload,
    hash: hex(await crypto.subtle.digest("SHA-256", bytes)),
  };
}
