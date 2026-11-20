/** API 2.5.0: wire fields retain the server's snake_case names. */
export type Target =
  | {
      email: string;
      source?:
        | "cf_domain"
        | "outlook"
        | "mailtm"
        | "mailgw"
        | "mailslurp"
        | "mailinator";
      vault_id?: never;
      platform?: never;
    }
  | { vault_id: number; email?: never; platform?: never; source?: never }
  | { platform: string; email?: never; vault_id?: never; source?: never };
/** Default match is mailbox; platform scope requires a registration target and a sender/keyword rule. */
export type VerificationRequest = (
  | (Extract<Target, { email: string }> & { match?: "mailbox" })
  | (Exclude<Target, { email: string }> & { match?: "mailbox" | "platform" })
) & {
  since?: string;
  sender?: string;
  q?: string;
};
export interface Verification {
  email: string;
  source:
    | "cf_domain"
    | "outlook"
    | "mailtm"
    | "mailgw"
    | "mailslurp"
    | "mailinator"
    | "gptmail"
    | "external";
  vault_id?: number;
  outcome: "found" | "empty";
  has_mail: boolean;
  code: string;
  link: string;
  message: string;
  poll_after_seconds: number;
  subject?: string;
  sender?: string;
  received_at?: string;
  mail_id?: string;
  scanned?: number;
  checked_at?: string;
  limited?: boolean;
  /** Present for registration targets; mailbox results do not establish platform ownership. */
  match_scope?: "mailbox" | "platform";
  match_reason?: string;
}
export interface MailboxInspection {
  email: string;
  source: Verification["source"];
  vault_id?: number;
  health: {
    state:
      | "missing"
      | "disabled"
      | "reauth_required"
      | "error"
      | "unchecked"
      | "stale"
      | "connected"
      | "configured"
      | "external";
    label: string;
    message: string;
    needs_attention: boolean;
    can_lookup: boolean;
    action:
      | "connect_outlook"
      | "manage_outlook"
      | "check_outlook"
      | "manage_domains"
      | "manage_provider"
      | null;
    account_id?: number;
    checked_at?: string;
  };
  mailbox: {
    id: number;
    is_permanent: boolean;
    expires_at: string;
    is_expired: boolean;
  } | null;
  observed_at: string;
  live_check: false;
}
export interface Registration {
  platform_name: string;
  domain?: string;
  prefix?: string;
  username?: string;
  password?: string;
  category?: string;
  remark?: string;
}
export interface RegisteredMailbox {
  id: number;
  email: string;
  platform_name: string;
}
export interface Attachment {
  name: string;
  content_type: string;
  content_base64: string;
}
export interface Reply {
  body: string;
  attachments?: Attachment[];
}
export interface OutboundMail extends Reply {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
}
export interface Accepted {
  accepted: true;
}
export interface ApiResponse<T> {
  data: T;
  status: number;
  request_id: string;
  retry_after: number | null;
  idempotency_replayed: boolean;
  idempotency_key_expires_at: string | null;
}
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Explicit logical-operation key. The SDK never generates or retries it. */
  idempotencyKey?: string;
}
export interface JsonRequestOptions extends RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}
export interface PollOptions {
  signal?: AbortSignal;
  /** Values above 180 are capped. Zero performs no request. */
  timeoutSeconds?: number;
  intervalSeconds?: number;
}
export interface PollRuntime {
  monotonicMs(): number;
  wallTimeMs(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  /** Optional deterministic clock/scheduler for testing. */
  runtime?: PollRuntime;
}
export type WaitResult = {
  since: string;
  attempts: number;
  elapsed_seconds: number;
  request_id: string;
  last_error?: import("./client.js").MailHubError;
} & (
  { outcome: "found"; data: Verification } | { outcome: "timeout"; data: null }
);
