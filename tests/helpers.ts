import { Miniflare } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { app } from "../src/index";
import type { Env } from "../src/types";

export const APP_ID = "11111111-2222-4333-8444-555555555555";
export const TOKEN = "M.FICTIONAL_TEST_REFRESH_TOKEN_0123456789";
export const ACCOUNT = {
  email: "sample@outlook.com",
  password: "M.'<test>password",
  client_id: APP_ID,
  refresh_token: TOKEN,
  remark: "test account",
};
export async function database(migrate = true) {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "mailhub-tests",
          compatibilityDate: "2026-11-01",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents:
                  'export default { fetch() { return new Response("local"); } }',
              },
            },
          },
          env: { DB: { type: "d1", id: "test-db" } },
        },
      },
    ],
  });
  const DB = (await runtime.getD1Database("DB")) as unknown as D1Database;
  const files = (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  async function apply(file: string) {
    const sql = await readFile(
      new URL(`../migrations/${file}`, import.meta.url),
      "utf8",
    );
    const statements = sql
      .replace(/--[^\n]*/g, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    await DB.batch(statements.map((statement) => DB.prepare(statement)));
  }
  if (migrate) for (const file of files) await apply(file);
  const env: Env = {
    DB,
    CF_DOMAINS: "example.test,mail.example.test",
    ADMIN_PASSWORD: "test-admin-password",
    COOKIE_SECRET: "test-cookie-secret",
    API_KEY: "test-api-key",
  };
  async function request(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    headers: Record<string, string> = { "X-API-Key": env.API_KEY! },
  ) {
    const response = await app.request(
      `https://mailhub.test${path}`,
      {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
    return { response, data: (await response.json()) as any };
  }
  return { env, DB, request, apply, files, dispose: () => runtime.dispose() };
}

export async function microsoft<T>(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
  action: () => Promise<T>,
) {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (
      ["login.microsoftonline.com", "graph.microsoft.com"].includes(
        url.hostname,
      )
    )
      return handler(url, init);
    return previous(input, init);
  }) as typeof fetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = previous;
  }
}
export const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
export const mail = (
  id: string,
  subject = "Your verification code is 246810",
  receivedDateTime = "2026-11-14T08:00:00.000Z",
) => ({
  id,
  subject,
  receivedDateTime,
  bodyPreview: subject,
  from: {
    emailAddress: { address: "auth@example.test", name: "Authentication" },
  },
});
