import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { getSessionSecret, sha256, verifySessionToken } from "../auth";
import { fetchProfile, tokenRequest } from "../graph";
import { accountMutation, assertGroup } from "../outlook-store";
import { and, db, eq, insert, remove } from "../storage/client";
import type { Env } from "../types";
import { boolean, email, integer, invalid, object } from "../validation";
const app = new Hono<{ Bindings: Env }>();
app.post("/start", async (c) => {
  if (!c.env.MICROSOFT_CLIENT_ID || !c.env.MICROSOFT_CLIENT_SECRET)
    invalid(
      "请先配置自己的微软 Web 应用 MICROSOFT_CLIENT_ID 与 MICROSOFT_CLIENT_SECRET",
    );
  const session = getCookie(c, "mailhub_session");
  if (
    !session ||
    !(await verifySessionToken(session, await getSessionSecret(c.env)))
  )
    return c.json(
      {
        success: false,
        error: "UNAUTHORIZED",
        message: "请使用浏览器管理员登录后进行授权",
      },
      401,
    );
  const body = object(await c.req.json());
  const sendMail = boolean(body.send_mail, "发信权限");
  const group = integer(body.group_id, "分组", 1, 1000000, 1);
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
  const redirect = `${new URL(c.req.url).origin}/api/outlook/oauth/callback`;
  await db(c.env).mutate([
    insert("oauth_sessions", {
      state_hash: await sha256(state),
      verifier,
      session_hash: await sha256(session),
      redirect_uri: redirect,
      group_id: group,
      expires_at: Math.floor(Date.now() / 1000) + 600,
    }),
  ]);
  const params = new URLSearchParams({
    client_id: c.env.MICROSOFT_CLIENT_ID,
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
  });
  return c.json({
    success: true,
    url: `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`,
  });
});
app.get("/callback", async (c) => {
  let success = false,
    message = "授权未完成，请关闭窗口并重试";
  const state = c.req.query("state") || "";
  const session = getCookie(c, "mailhub_session") || "";
  if (
    state.length <= 200 &&
    state &&
    session &&
    c.env.MICROSOFT_CLIENT_ID &&
    c.env.MICROSOFT_CLIENT_SECRET
  ) {
    const [consumed] = await db(c.env).mutate([
      remove(
        "oauth_sessions",
        and(
          eq("state_hash", await sha256(state)),
          eq("session_hash", await sha256(session)),
          {
            field: "expires_at",
            op: "gt",
            value: Math.floor(Date.now() / 1000),
          },
        ),
      ),
    ]);
    const saved = consumed.rows[0] as
      { verifier: string; redirect_uri: string; group_id: number } | undefined;
    if (saved && c.req.query("code")) {
      const token = await tokenRequest(
        new URLSearchParams({
          client_id: c.env.MICROSOFT_CLIENT_ID,
          client_secret: c.env.MICROSOFT_CLIENT_SECRET,
          grant_type: "authorization_code",
          code: c.req.query("code")!,
          code_verifier: saved.verifier,
          redirect_uri: saved.redirect_uri,
        }),
      );
      if (token.token && token.newRefreshToken) {
        const profile = await fetchProfile(token.token);
        if (profile.data) {
          await assertGroup(c.env, saved.group_id);
          await db(c.env).mutate([
            accountMutation(
              {
                email: email(profile.data.email),
                password: "",
                client_id: c.env.MICROSOFT_CLIENT_ID,
                refresh_token: token.newRefreshToken,
                remark: "",
              },
              saved.group_id,
            ),
          ]);
          success = true;
          message = "微软账号已授权并保存，可以关闭此窗口";
        } else message = profile.error?.message || message;
      } else
        message =
          token.error?.message ||
          "微软未返回 Refresh Token，请确认应用允许 offline_access";
    } else if (saved) message = "你已取消微软授权，可关闭此窗口";
    else message = "授权已过期或已使用，请重新发起授权";
  }
  const nonce = crypto.randomUUID();
  c.header(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`,
  );
  // Only fixed local messages reach this page; no provider error descriptions or tokens.
  return c.html(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>微软授权</title><body><p>${message}</p><script nonce="${nonce}">if(window.opener){window.opener.postMessage(${JSON.stringify({ type: "mailhub-outlook-oauth", success, message })},location.origin);window.close();}</script></body></html>`,
  );
});
export default app;
