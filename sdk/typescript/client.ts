import type {
  Accepted,
  ApiResponse,
  ClientOptions,
  JsonRequestOptions,
  MailboxInspection,
  OutboundMail,
  PollOptions,
  PollRuntime,
  RegisteredMailbox,
  Registration,
  Reply,
  RequestOptions,
  Target,
  Verification,
  VerificationRequest,
  WaitResult,
} from "./types.js";

export class MailHubError extends Error {
  readonly code: string;
  readonly status: number;
  readonly request_id: string;
  readonly retry_after: number | null;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(
    code: string,
    message: string,
    options: {
      status?: number;
      request_id?: string;
      retry_after?: number | null;
      retryable?: boolean;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "MailHubError";
    this.code = code;
    this.status = options.status ?? 0;
    this.request_id = options.request_id ?? "";
    this.retry_after = options.retry_after ?? null;
    this.retryable = options.retryable === true;
    this.details = Object.freeze({ ...options.details });
  }
}
export function invalid(message: string): never {
  throw new MailHubError("INVALID_ARGUMENT", message);
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function finite(
  value: number,
  name: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
) {
  if (!Number.isFinite(value) || value < min || value > max)
    invalid(`${name} is outside its supported range`);
  return value;
}
function timeoutMs(value: number) {
  return finite(value, "timeoutMs", 1, 180000);
}
function id(value: number) {
  if (!Number.isSafeInteger(value) || value < 1)
    invalid("account/vault ID must be a positive safe integer");
  return value;
}
function iso(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !/^\d{4}-\d\d-\d\dT/.test(value) ||
    !/(?:Z|[+-]\d\d:\d\d)$/i.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    invalid("since must be an ISO 8601 timestamp with timezone");
  return value;
}
function target(value: Target) {
  if (
    !object(value) ||
    [value.email, value.vault_id, value.platform].filter((v) => v !== undefined)
      .length !== 1
  )
    invalid("Provide exactly one of email, vault_id or platform");
  if (value.vault_id !== undefined) id(value.vault_id);
  if (
    value.email !== undefined &&
    (typeof value.email !== "string" ||
      value.email.length > 254 ||
      !/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(value.email))
  )
    invalid("email is invalid");
  if (
    value.platform !== undefined &&
    (typeof value.platform !== "string" ||
      !value.platform.trim() ||
      value.platform.length > 100)
  )
    invalid("platform is invalid");
  if (
    value.source !== undefined &&
    (value.email === undefined ||
      ![
        "outlook",
        "cf_domain",
        "mailtm",
        "mailgw",
        "mailslurp",
        "mailinator",
      ].includes(value.source))
  )
    invalid(
      "source requires an email target and must be outlook, cf_domain, mailtm, mailgw, mailslurp or mailinator",
    );
}
function verificationInput(value: VerificationRequest) {
  target(value);
  if (
    value.match !== undefined &&
    !["mailbox", "platform"].includes(value.match)
  )
    invalid("match must be mailbox or platform");
  if (value.match === "platform" && value.email !== undefined)
    invalid("match=platform requires vault_id or platform");
  if (value.since !== undefined) iso(value.since);
  for (const [field, max] of [
    ["sender", 254],
    ["q", 200],
  ] as const)
    if (
      value[field] !== undefined &&
      (typeof value[field] !== "string" || value[field]!.length > max)
    )
      invalid(`${field} is invalid`);
}
function abortError(request_id = "") {
  return new MailHubError(
    "ABORTED",
    "Request cancelled; a submitted mutation may still complete",
    { request_id },
  );
}
function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
function retryAfter(header: string | null, body: unknown, now: number) {
  const values: number[] = [];
  if (typeof body === "number" && Number.isFinite(body) && body >= 0)
    values.push(body);
  if (header) {
    if (/^\d+(?:\.\d+)?$/.test(header.trim())) values.push(Number(header));
    else {
      const date = Date.parse(header);
      if (Number.isFinite(date)) values.push(Math.max(0, (date - now) / 1000));
    }
  }
  const valid = values.filter(Number.isFinite);
  return valid.length ? Math.max(...valid) : null;
}

/** Server-side, zero-dependency API-key client. Every request makes one attempt. */
export class MailHubClient {
  readonly #base: string;
  readonly #apiKey: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeout: number;
  readonly #runtime: PollRuntime;
  constructor(options: ClientOptions) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      invalid("baseUrl must be an HTTP(S) origin");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      /[\u0000-\u0020\\]/.test(options.baseUrl) ||
      (url.protocol === "http:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      invalid(
        "baseUrl must be an HTTPS origin (HTTP is allowed only on loopback)",
      );
    if (
      typeof options.apiKey !== "string" ||
      !/^[!-~]+$/.test(options.apiKey) ||
      options.apiKey.includes(",")
    )
      invalid("apiKey must be a nonempty header-safe ASCII string");
    this.#base = url.origin;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeout = timeoutMs(options.timeoutMs ?? 30000);
    this.#runtime = options.runtime ?? {
      monotonicMs: () => performance.now(),
      wallTimeMs: () => Date.now(),
      sleep,
    };
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD",
    path: string,
    options: JsonRequestOptions = {},
  ): Promise<ApiResponse<T>> {
    if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method))
      invalid("Unsupported HTTP method");
    if (
      typeof path !== "string" ||
      !path.startsWith("/api/") ||
      /[?#\\\u0000-\u0020]/.test(path)
    )
      invalid(
        "path must be a local /api/ path; use query for query parameters",
      );
    for (const part of path.split("/")) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(part);
      } catch {
        return invalid("Invalid encoded path");
      }
      if (decoded === "." || decoded === "..")
        invalid("Dot path segments are not supported");
    }
    const url = new URL(this.#base + path);
    if (url.origin !== this.#base || url.pathname !== path)
      invalid("Noncanonical request path");
    for (const [name, value] of Object.entries(options.query ?? {}))
      if (value !== undefined) url.searchParams.set(name, String(value));
    const headers = new Headers({
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: "application/json",
    });
    if (options.idempotencyKey !== undefined) {
      if (
        typeof options.idempotencyKey !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(options.idempotencyKey)
      )
        invalid("Invalid Idempotency-Key");
      if (method === "GET" || method === "HEAD")
        invalid("Idempotency-Key is supported only for mutations");
      headers.set("Idempotency-Key", options.idempotencyKey);
    }
    let body: string | undefined;
    if (options.body !== undefined) {
      if (method === "GET" || method === "HEAD")
        invalid("GET/HEAD requests cannot have a JSON body");
      try {
        body = JSON.stringify(options.body);
      } catch {
        return invalid("Request body must be JSON serializable");
      }
      if (body === undefined) invalid("Request body must be JSON serializable");
      headers.set("Content-Type", "application/json");
    }
    const ms = timeoutMs(options.timeoutMs ?? this.#timeout);
    checkAbort(options.signal);
    const controller = new AbortController();
    let requestId = "",
      responseStatus = 0,
      responseDelay: number | null = null;
    let cancelBody: (() => void) | undefined;
    let rejectStop!: (error: MailHubError) => void;
    const stopped = new Promise<never>((_, reject) => {
      rejectStop = reject;
    });
    const abort = () => {
      controller.abort();
      cancelBody?.();
      rejectStop(
        new MailHubError(
          "ABORTED",
          "Request cancelled; a submitted mutation may still complete",
          {
            status: responseStatus,
            request_id: requestId,
            retry_after: responseDelay,
          },
        ),
      );
    };
    const timer = setTimeout(() => {
      controller.abort();
      cancelBody?.();
      rejectStop(
        new MailHubError(
          "TIMEOUT",
          "Request deadline exceeded; a submitted mutation may still complete",
          {
            status: responseStatus,
            request_id: requestId,
            retry_after: responseDelay,
          },
        ),
      );
    }, ms);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const run = async (): Promise<ApiResponse<T>> => {
      if (controller.signal.aborted) throw abortError(requestId);
      const response = await this.#fetch(url.href, {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
      });
      responseStatus = response.status;
      requestId = response.headers.get("X-Request-ID") || "";
      responseDelay = retryAfter(
        response.headers.get("Retry-After"),
        undefined,
        this.#runtime.wallTimeMs(),
      );
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw abortError(requestId);
      }
      let text = "";
      const reader = response.body?.getReader();
      if (reader) {
        cancelBody = () => {
          void reader.cancel().catch(() => {});
        };
        const decoder = new TextDecoder();
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 8 * 1024 * 1024) {
              cancelBody();
              throw new MailHubError(
                "RESPONSE_TOO_LARGE",
                "JSON response exceeds 8 MiB",
                { status: response.status, request_id: requestId },
              );
            }
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          cancelBody = undefined;
          reader.releaseLock();
        }
      }
      let payload: unknown;
      try {
        payload =
          !text &&
          response.ok &&
          (method === "HEAD" || [204, 205].includes(response.status))
            ? { success: true }
            : JSON.parse(text);
      } catch {
        throw new MailHubError(
          response.ok ? "INVALID_RESPONSE" : `HTTP_${response.status}`,
          "The server returned a non-JSON response",
          {
            status: response.status,
            request_id: requestId,
            retry_after: retryAfter(
              response.headers.get("Retry-After"),
              undefined,
              this.#runtime.wallTimeMs(),
            ),
          },
        );
      }
      const record = object(payload) ? payload : {};
      if (!requestId && typeof record.request_id === "string")
        requestId = record.request_id;
      const delay = retryAfter(
        response.headers.get("Retry-After"),
        record.retry_after,
        this.#runtime.wallTimeMs(),
      );
      if (!response.ok || record.success === false)
        throw new MailHubError(
          typeof record.error === "string"
            ? record.error
            : `HTTP_${response.status}`,
          typeof record.message === "string"
            ? record.message
            : "MailHub request failed",
          {
            status: response.status,
            request_id: requestId,
            retry_after: delay,
            retryable: record.retryable === true,
            details: record,
          },
        );
      if (record.success !== true)
        throw new MailHubError(
          "INVALID_RESPONSE",
          "Expected a success JSON envelope",
          { status: response.status, request_id: requestId },
        );
      return {
        data: record.data as T,
        status: response.status,
        request_id: requestId,
        retry_after: delay,
        idempotency_replayed:
          response.headers.get("Idempotency-Replayed") === "true",
        idempotency_key_expires_at: response.headers.get(
          "Idempotency-Key-Expires-At",
        ),
      };
    };
    try {
      return await Promise.race([stopped, run()]);
    } catch (error) {
      if (error instanceof MailHubError) throw error;
      if (options.signal?.aborted) throw abortError(requestId);
      // Do not leak URLs, credentials or request bodies through transport exception text.
      throw new MailHubError(
        "NETWORK_ERROR",
        "Transport failed; a submitted mutation may still complete",
        {
          status: responseStatus,
          request_id: requestId,
          retry_after: responseDelay,
        },
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async inspectMailbox(input: Target, options: RequestOptions = {}) {
    target(input);
    return this.request<MailboxInspection>("POST", "/api/automation/mailbox", {
      ...options,
      body: input,
    });
  }
  async lookupVerification(
    input: VerificationRequest,
    options: RequestOptions = {},
  ) {
    verificationInput(input);
    return this.request<Verification>("POST", "/api/automation/verification", {
      ...options,
      body: input,
    });
  }
  async register(input: Registration, options: RequestOptions = {}) {
    return this.request<RegisteredMailbox>("POST", "/api/external/register", {
      ...options,
      body: input,
    });
  }
  async sendMail(
    accountId: number,
    input: OutboundMail,
    options: RequestOptions = {},
  ) {
    return this.request<Accepted>(
      "POST",
      `/api/outlook/accounts/${id(accountId)}/send`,
      { ...options, body: input },
    );
  }
  async reply(
    accountId: number,
    messageId: string,
    input: Reply,
    options: RequestOptions = {},
  ) {
    if (
      typeof messageId !== "string" ||
      !messageId ||
      messageId.length > 2048 ||
      [".", ".."].includes(messageId) ||
      /[\u0000-\u001f\u007f]/.test(messageId)
    )
      invalid("messageId must be a nonempty opaque message ID");
    let encoded: string;
    try {
      encoded = encodeURIComponent(messageId);
    } catch {
      return invalid("messageId must be valid UTF-8");
    }
    return this.request<Accepted>(
      "POST",
      `/api/outlook/accounts/${id(accountId)}/messages/${encoded}/reply`,
      { ...options, body: input },
    );
  }

  async waitForVerification(
    input: VerificationRequest,
    options: PollOptions = {},
  ): Promise<WaitResult> {
    verificationInput(input);
    checkAbort(options.signal);
    if ("idempotencyKey" in options)
      invalid("Polling must not reuse an Idempotency-Key");
    const seconds = Math.min(
      180,
      finite(options.timeoutSeconds ?? 180, "timeoutSeconds", 0),
    );
    const interval = finite(
      options.intervalSeconds ?? 10,
      "intervalSeconds",
      1,
      180,
    );
    const started = this.#runtime.monotonicMs(),
      deadline = started + seconds * 1000;
    const since =
      input.since ?? new Date(this.#runtime.wallTimeMs()).toISOString();
    // Copy once: callers cannot move the target or since while a request awaits I/O.
    const query = { ...input, since } as VerificationRequest;
    let attempts = 0,
      request_id = "",
      last_error: MailHubError | undefined;
    const result = () => ({
      since,
      attempts,
      elapsed_seconds: Math.max(
        0,
        (this.#runtime.monotonicMs() - started) / 1000,
      ),
      request_id,
      ...(last_error ? { last_error } : {}),
    });
    while (this.#runtime.monotonicMs() < deadline) {
      checkAbort(options.signal);
      const remaining = deadline - this.#runtime.monotonicMs();
      if (remaining < 1) break;
      let delay = interval;
      try {
        attempts++;
        const response = await this.lookupVerification(query, {
          signal: options.signal,
          timeoutMs: Math.min(this.#timeout, remaining),
        });
        request_id = response.request_id;
        const data = response.data;
        if (
          !object(data) ||
          !["found", "empty"].includes(data.outcome) ||
          typeof data.code !== "string" ||
          typeof data.link !== "string" ||
          (data.outcome === "found" && !data.code && !data.link)
        )
          throw new MailHubError(
            "INVALID_RESPONSE",
            "Invalid verification result",
            { status: response.status, request_id },
          );
        if (this.#runtime.monotonicMs() >= deadline) break;
        last_error = undefined;
        if (data.outcome === "found")
          return { ...result(), outcome: "found", data };
        if (
          typeof data.poll_after_seconds === "number" &&
          Number.isFinite(data.poll_after_seconds) &&
          data.poll_after_seconds >= 0
        )
          delay = Math.max(delay, data.poll_after_seconds);
        delay = Math.max(delay, response.retry_after ?? 0);
      } catch (error) {
        if (!(error instanceof MailHubError)) throw error;
        last_error = error;
        request_id = error.request_id;
        if (error.code === "TIMEOUT") break;
        if (!(
          error.status === 429 ||
          (error.retryable &&
            ([408, 425].includes(error.status) || error.status >= 500))
        ))
          throw error;
        delay = Math.max(delay, error.retry_after ?? 0);
      }
      checkAbort(options.signal);
      if (delay * 1000 >= deadline - this.#runtime.monotonicMs()) break;
      await this.#runtime.sleep(delay * 1000, options.signal);
    }
    checkAbort(options.signal);
    return { ...result(), outcome: "timeout", data: null };
  }
}
