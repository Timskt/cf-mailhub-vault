export const PUBLIC_CLIENT_ID = "9e5f94bc-e8a4-4e73-b8be-63364c29d753";
export const MANUAL_REDIRECT_URI = "https://localhost";

/** Parse locally; never follow a pasted URL or accept a response for another flow. */
export function parseAuthorizationResponse(
  input: string,
  expectedState: string,
  redirectUri = MANUAL_REDIRECT_URI,
): { code: string; state?: string; fromUrl: boolean } {
  const value = input.trim();
  if (!value || value.length > 16384)
    throw new Error(
      "请粘贴本次授权后的完整回调网址或授权码，长度不能超过 16,384 字符",
    );
  let code = value;
  let state: string | undefined;
  const fromUrl = /^[a-z][a-z\d+.-]*:/i.test(value);
  if (fromUrl) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("回调网址格式无效，请从微软授权完成后的地址栏完整复制");
    }
    const expected = new URL(redirectUri);
    if (
      url.origin !== expected.origin ||
      url.pathname !== expected.pathname ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error(
        `请粘贴回调到 ${expected.origin}${expected.pathname} 的网址`,
      );
    const params = url.searchParams;
    if (["code", "state", "error"].some((key) => params.getAll(key).length > 1))
      throw new Error("回调包含重复参数，请重新复制完整网址");
    state = params.get("state") || "";
    if (!state || state !== expectedState)
      throw new Error(
        "回调不属于本次授权，请使用当前面板打开的微软授权页重新授权",
      );
    if (params.has("error"))
      throw new Error("微软授权未完成或已取消，请重新打开授权页并同意所需权限");
    code = params.get("code") || "";
  } else {
    try {
      code = decodeURIComponent(code);
    } catch {
      throw new Error("授权码编码无效，请重新复制");
    }
  }
  if (!code || code.length > 8192 || !/^[A-Za-z0-9._~+\/\-=!*$]+$/.test(code))
    throw new Error("未识别到有效授权码；请粘贴完整回调网址或仅粘贴 code 的值");
  return { code, state, fromUrl };
}

export interface RecoveryAccount {
  status?: string;
  auth_status?: string;
  last_error_code?: string;
  token_refresh_status?: string;
  token_refresh_error?: string;
}
export interface RecoveryDiagnosis {
  kind: string;
  title: string;
  description: string;
  action: "authorize" | "retry" | "enable" | "configure" | "check";
}
export function outlookDiagnosis(account: RecoveryAccount): RecoveryDiagnosis {
  if (account.status === "disabled")
    return {
      kind: "disabled",
      title: "账号已停用",
      description:
        "停用期间不会收件或自动续期。可先启用并测试连接，重新授权会保留停用状态。",
      action: "enable",
    };
  const renewalFailure = ["retrying", "reauth_required"].includes(
    account.token_refresh_status || "",
  )
    ? account.token_refresh_error?.split(":")[0]
    : "";
  const code = (renewalFailure || account.last_error_code || "").toLowerCase();
  if (["invalid_client", "unauthorized_client"].includes(code))
    return {
      kind: "application",
      title: "应用配置需要修复",
      description:
        "Client ID 必须与签发 Refresh Token 的应用一致。检查应用密钥，或使用此面板重新授权并成对更新凭据。",
      action: "configure",
    };
  if (
    [
      "invalid_scope",
      "erroraccessdenied",
      "authorization_requestdenied",
      "insufficient_scope",
      "mail_send_permission_required",
      "http_403",
    ].includes(code)
  )
    return {
      kind: "permissions",
      title: "微软邮件权限不足",
      description:
        "仅有 IMAP 权限的令牌无法读取 Graph 邮件。请重新授权邮件读写权限；需要发信时再勾选发信权限。",
      action: "authorize",
    };
  if (
    account.auth_status === "reauth_required" ||
    account.token_refresh_status === "reauth_required" ||
    [
      "invalid_grant",
      "interaction_required",
      "consent_required",
      "login_required",
      "invalidauthenticationtoken",
      "http_401",
    ].includes(code)
  )
    return {
      kind: "authorization",
      title: "需要重新授权",
      description:
        "微软已撤销或拒绝当前授权，自动续期无法恢复。登录此邮箱并重新同意权限后可更新凭据。",
      action: "authorize",
    };
  if (
    [
      "network_error",
      "timeout",
      "http_429",
      "toomanyrequests",
      "activitylimitreached",
      "serviceunavailable",
    ].includes(code) ||
    account.token_refresh_status === "retrying"
  )
    return {
      kind: "temporary",
      title: "连接暂时不可用",
      description:
        "网络、微软限流或服务故障可能暂时影响收件。请稍后测试连接，后台也会按退避计划重试续期。",
      action: "retry",
    };
  if (account.auth_status === "error")
    return {
      kind: "connection",
      title: "收件连接需要检查",
      description:
        "请先测试连接确认当前错误。持续出现权限或授权问题时，可在此重新授权。",
      action: "check",
    };
  return {
    kind: account.auth_status === "healthy" ? "healthy" : "unchecked",
    title:
      account.auth_status === "healthy" ? "最近收件检查正常" : "等待收件验证",
    description:
      "授权成功后需要测试实际收件权限。也可在此重新授权或补充发信权限。",
    action: "check",
  };
}
