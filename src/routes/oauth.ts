import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import {
  MANUAL_REDIRECT_URI,
  PUBLIC_CLIENT_ID,
  parseAuthorizationResponse,
} from "../../shared/outlook-recovery";
import { getSessionSecret, sha256, verifySessionToken } from "../auth";
import { fetchProfile, tokenRequest } from "../graph";
import { assertGroup, getAccount } from "../outlook-store";
import {
  and,
  db,
  eq,
  insert,
  now,
  remove,
  update,
  StorageError,
  type Filter,
} from "../storage/client";
import type { Env, OutlookAccount } from "../types";
import {
  boolean,
  choice,
  email,
  integer,
  invalid,
  object,
  text,
} from "../validation";

const app = new Hono<{ Bindings: Env }>();
type OAuthMode = "web" | "manual";
type Target = Pick<
  OutlookAccount,
  "id" | "email" | "client_id" | "created_at" | "updated_at"
>;
type OAuthContext = {
  version: 1;
  mode: OAuthMode;
  client_id: string;
  email: string;
  target?: Target;
};
type OAuthSession = {
  state_hash: string;
  session_hash: string;
  verifier: string;
  redirect_uri: string;
  group_id: number;
  expires_at: number;
  context: string;
};
type SavedAccount = Pick<
  OutlookAccount,
  "id" | "email" | "status" | "auth_status"
>;
const seconds = () => Math.floor(Date.now() / 1000);
function conflict(message = "授权已过期或已使用，请重新发起授权"): never {
  throw new StorageError("OAUTH_RESTART_REQUIRED", message, 409);
}
async function adminSession(c: Context<{ Bindings: Env }>) {
  const session = getCookie(c, "mailhub_session") || "";
  if (
    !session ||
    !(await verifySessionToken(session, await getSessionSecret(c.env)))
  )
    throw new HTTPException(401, {
      message: "请使用浏览器管理员登录后进行授权",
    });
  return session;
}
function targetOf(account: OutlookAccount): Target {
  const { id, email, client_id, created_at, updated_at } = account;
  return { id, email, client_id, created_at, updated_at };
}
function targetFilter(target: Target) {
  return and(...Object.entries(target).map(([key, value]) => eq(key, value)));
}
app.post("/start", async (c) => {
  const session = await adminSession(c);
  const body = object(await c.req.json());
  const mode = choice(body.mode, "授权方式", ["web", "manual"], "web");
  if (
    mode === "web" &&
    (!c.env.MICROSOFT_CLIENT_ID || !c.env.MICROSOFT_CLIENT_SECRET)
  )
    invalid("请先配置自己的微软 Web 应用，或选择授权码提取方式连接");
  const client =
    mode === "web"
      ? c.env.MICROSOFT_CLIENT_ID!
      : text(body.client_id, "Client ID", 36, PUBLIC_CLIENT_ID).trim();
  if (!/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(client))
    invalid("Client ID 必须是微软应用的 UUID");
  if (
    mode === "manual" &&
    client.toLowerCase() === c.env.MICROSOFT_CLIENT_ID?.toLowerCase()
  )
    invalid(
      "此 Client ID 已配置为 Web 应用，请使用自动回调方式，或填写另一个注册了 https://localhost 回调的公共客户端",
    );
  const sendMail = boolean(body.send_mail, "发信权限");
  let expectedEmail = body.email ? email(body.email) : "";
  const requestedId =
    body.account_id === undefined
      ? undefined
      : integer(body.account_id, "账号 ID", 1, Number.MAX_SAFE_INTEGER);
  const existing = requestedId
    ? await getAccount(c.env, requestedId)
    : expectedEmail
      ? await db(c.env).first<OutlookAccount>(
          "accounts",
          eq("email", expectedEmail),
        )
      : null;
  if (requestedId && !existing) conflict("该账号已不存在，请刷新账号列表");
  if (existing) {
    if (expectedEmail && expectedEmail !== existing.email)
      invalid("目标邮箱与当前账号不匹配");
    expectedEmail = existing.email;
  }
  const group =
    existing?.group_id || integer(body.group_id, "分组", 1, 1000000, 1);
  await assertGroup(c.env, group);
  const state = crypto.randomUUID() + crypto.randomUUID();
  const verifier = (crypto.randomUUID() + crypto.randomUUID()).replaceAll(
    "-",
    "",
  );
  const challenge = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      ),
    ),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const redirect =
    mode === "manual"
      ? MANUAL_REDIRECT_URI
      : `${new URL(c.req.url).origin}/api/outlook/oauth/callback`;
  const context: OAuthContext = {
    version: 1,
    mode,
    client_id: client,
    email: expectedEmail,
    ...(existing ? { target: targetOf(existing) } : {}),
  };
  const expires = seconds() + 600;
  await db(c.env).mutate([
    remove("oauth_sessions", {
      field: "expires_at",
      op: "lte",
      value: seconds(),
    }),
    insert("oauth_sessions", {
      state_hash: await sha256(state),
      verifier,
      session_hash: await sha256(session),
      redirect_uri: redirect,
      group_id: group,
      expires_at: expires,
      context: JSON.stringify(context),
    }),
  ]);
  const params = new URLSearchParams({
    client_id: client,
    response_type: "code",
    redirect_uri: redirect,
    scope:
      "offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/User.Read" +
      (sendMail ? " https://graph.microsoft.com/Mail.Send" : ""),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
    response_mode: "query",
    ...(expectedEmail ? { login_hint: expectedEmail } : {}),
  });
  return c.json({
    success: true,
    url: `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`,
    data: {
      state,
      mode,
      expires_at: expires,
      redirect_uri: redirect,
      client_id: client,
    },
  });
});

async function authorization(
  env: Env,
  state: string,
  session: string,
  mode: OAuthMode,
) {
  if (!state || state.length > 200) conflict();
  const where = and(
    eq("state_hash", await sha256(state)),
    eq("session_hash", await sha256(session)),
    { field: "expires_at", op: "gt", value: seconds() },
  );
  const saved = await db(env).first<OAuthSession>("oauth_sessions", where);
  if (!saved) conflict();
  let context: OAuthContext;
  try {
    context = JSON.parse(saved.context);
  } catch {
    conflict();
  }
  if (context.version !== 1 || context.mode !== mode || !context.client_id)
    conflict();
  if (
    mode === "web" &&
    (context.client_id !== env.MICROSOFT_CLIENT_ID ||
      !env.MICROSOFT_CLIENT_SECRET)
  )
    conflict("微软应用配置已变更，请重新发起授权");
  return { saved, context, where };
}
async function consume(env: Env, where: Filter) {
  // Keep a unique tombstone until the original expiry. Two independent direct-D1
  // stores must not mistake identical deletions for a replay of the same commit.
  const claim = JSON.stringify({ consumed: crypto.randomUUID() });
  const [result] = await db(env).mutate([
    update(
      "oauth_sessions",
      and(where, { field: "expires_at", op: "gt", value: seconds() }),
      { context: claim, verifier: "" },
    ),
  ]);
  if (!result.changes) conflict();
}
async function redeem(
  env: Env,
  flow: Awaited<ReturnType<typeof authorization>>,
  code: string,
): Promise<SavedAccount> {
  // Claim before contacting Microsoft: a code must never be exchanged twice, even on timeout.
  const claimFilter = and(flow.where, eq("context", flow.saved.context));
  try {
    await consume(env, claimFilter);
  } catch (error) {
    // A competing direct-D1 commit can fail its revision guard. Do not retry
    // token exchange or expose storage internals when another request owns it.
    if (!(await db(env).first("oauth_sessions", claimFilter))) conflict();
    throw error;
  }
  const { context, saved } = flow;
  // A queued storage write may have crossed expiry after validation.
  if (saved.expires_at <= seconds()) conflict();
  if (
    context.target &&
    !(await db(env).first("accounts", targetFilter(context.target)))
  )
    conflict("账号在授权期间已变更或被删除，请刷新后重新授权");
  const token = await tokenRequest(
    new URLSearchParams({
      client_id: context.client_id,
      ...(context.mode === "web"
        ? { client_secret: env.MICROSOFT_CLIENT_SECRET! }
        : {}),
      grant_type: "authorization_code",
      code,
      code_verifier: saved.verifier,
      redirect_uri: saved.redirect_uri,
    }),
  );
  if (!token.token || !token.newRefreshToken)
    throw new StorageError(
      "OAUTH_EXCHANGE_FAILED",
      token.error?.message ||
        "微软未返回 Refresh Token，请确认已同意 offline_access，并重新发起授权",
      502,
    );
  const profile = await fetchProfile(token.token);
  if (!profile.data)
    throw new StorageError(
      "OAUTH_PROFILE_FAILED",
      profile.error?.message || "无法验证微软邮箱身份，请重新授权 User.Read",
      502,
    );
  const verifiedEmail = email(profile.data.email);
  if (context.email && context.email !== verifiedEmail)
    conflict(
      "登录的微软邮箱与目标账号不匹配，本次未保存。请重新授权并选择目标邮箱",
    );
  const current = context.target
    ? await getAccount(env, context.target.id)
    : await db(env).first<OutlookAccount>(
        "accounts",
        eq("email", verifiedEmail),
      );
  if (context.target && !current)
    conflict("账号已删除，本次授权未保存，请刷新后重试");
  // An explicitly new address cannot overwrite an account created while consent was pending.
  if (!context.target && context.email && current)
    conflict("该邮箱在授权期间已加入账号池，请从已有账号重新发起修复");
  const timestamp = now();
  const credentials = {
    client_id: context.client_id,
    refresh_token: token.newRefreshToken,
    auth_status: "unchecked",
    last_error: "",
    last_error_code: "",
    last_checked_at: "",
    last_token_refresh_at: timestamp,
    last_token_attempt_at: timestamp,
    next_token_refresh_at: new Date(
      Date.now() + 6 * 60 * 60 * 1000,
    ).toISOString(),
    token_refresh_failures: 0,
    token_refresh_status: "healthy",
    token_refresh_error: "",
    updated_at: timestamp,
  };
  let result;
  try {
    if (current) {
      const where = targetFilter(context.target || targetOf(current));
      result = await db(env).mutate([
        {
          op: "assertExists",
          table: "accounts",
          where,
          message: "账号在授权期间已变更，请刷新后重新授权",
        },
        update("accounts", where, credentials),
      ]);
    } else {
      result = await db(env).mutate([
        {
          op: "assertExists",
          table: "groups",
          where: eq("id", saved.group_id),
          message: "目标分组已变更，请重新选择分组并授权",
        },
        {
          op: "assertAbsent",
          table: "accounts",
          where: eq("email", verifiedEmail),
          message: "此邮箱已加入账号池，请从已有账号重新发起修复",
        },
        insert("accounts", {
          email: verifiedEmail,
          group_id: saved.group_id,
          ...credentials,
        }),
      ]);
    }
  } catch (error) {
    if (error instanceof StorageError && error.code === "STALE_PREVIEW")
      conflict("账号或分组在授权期间已变更，本次未保存，请刷新后重新授权");
    throw error;
  }
  const row = result.at(-1)!.rows[0];
  if (!row) conflict("保存授权时账号已变更，请刷新后重新授权");
  return {
    id: Number(row.id),
    email: String(row.email),
    status: row.status as OutlookAccount["status"],
    auth_status: "unchecked",
  };
}
app.post("/exchange", async (c) => {
  const session = await adminSession(c);
  const body = object(await c.req.json());
  const state = text(body.state, "授权会话", 200);
  const flow = await authorization(c.env, state, session, "manual");
  let code: string;
  try {
    code = parseAuthorizationResponse(
      text(body.response, "回调网址或授权码", 16384),
      state,
      flow.saved.redirect_uri,
    ).code;
  } catch (error) {
    invalid(error instanceof Error ? error.message : "授权码无效");
  }
  const account = await redeem(c.env, flow, code);
  return c.json({
    success: true,
    data: account,
    message: "微软账号已授权并保存，请测试收件连接",
  });
});
function htmlText(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}
app.get("/callback", async (c) => {
  let success = false,
    message = "授权未完成，请关闭窗口并重试";
  let account: SavedAccount | undefined;
  const state = c.req.query("state") || "";
  try {
    const session = await adminSession(c);
    const flow = await authorization(c.env, state, session, "web");
    if (c.req.query("error")) {
      await consume(c.env, and(flow.where, eq("context", flow.saved.context)));
      message = "你已取消微软授权，可关闭此窗口并重新发起";
    } else {
      let code: string;
      try {
        code = parseAuthorizationResponse(
          c.req.url,
          state,
          flow.saved.redirect_uri,
        ).code;
      } catch {
        invalid("授权回调参数无效，请关闭窗口并重新授权");
      }
      account = await redeem(c.env, flow, code);
      success = true;
      message = "微软账号已授权并保存，请返回工作区测试收件连接";
    }
  } catch (error) {
    message =
      error instanceof StorageError || error instanceof HTTPException
        ? error.message
        : "保存授权暂时失败，请返回工作区检查账号后重新授权";
  }
  const nonce = crypto.randomUUID();
  c.header(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`,
  );
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
  const payload = JSON.stringify({
    type: "mailhub-outlook-oauth",
    success,
    message,
    state,
    ...(account ? { account } : {}),
  }).replaceAll("<", "\\u003c");
  return c.html(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>微软授权</title><body style="font:16px system-ui;max-width:36rem;margin:4rem auto;padding:1.5rem;line-height:1.7"><h1>${success ? "授权已保存" : "授权未完成"}</h1><p>${htmlText(message)}</p><a href="/#outlook" rel="noreferrer">返回 Outlook 工作区</a><script nonce="${nonce}">history.replaceState(null,'',location.pathname);if(window.opener){window.opener.postMessage(${payload},location.origin);window.close();}</script></body></html>`,
  );
});
export default app;
