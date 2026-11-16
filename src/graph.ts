const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const FOLDERS = [
  "inbox",
  "junkemail",
  "deleteditems",
  "sentitems",
  "archive",
  "all",
] as const;
export type MailFolder = (typeof FOLDERS)[number];
export interface GraphError {
  code: string;
  message: string;
  status?: number;
  retry_after?: number;
  required_scopes?: string[];
  draft_id?: string;
  delivery_unknown?: boolean;
}
export type GraphResult<T> =
  { data: T; error?: never } | { data?: never; error: GraphError };
export interface GraphMailMessage {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType: string; content: string };
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  receivedDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
}
export interface MailPage {
  items: GraphMailMessage[];
  nextLink?: string;
}
export interface MailOptions {
  folder?: MailFolder;
  top?: number;
  keyword?: string;
  includeBody?: boolean;
  nextLink?: string;
  since?: string;
}
export interface GraphAttachment {
  id: string;
  name: string;
  size: number;
  contentType?: string;
  isInline?: boolean;
}
export interface OutgoingAttachment {
  name: string;
  content_type: string;
  content_base64: string;
}
export interface SendMailInput {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  attachments?: OutgoingAttachment[];
}
export interface ReplyMailInput {
  body: string;
  attachments?: OutgoingAttachment[];
}
export interface MailAccepted {
  accepted: true;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function address(value: unknown): GraphMailMessage["from"] {
  const data = record(record(value).emailAddress);
  if (typeof data.address !== "string") return undefined;
  return {
    emailAddress: {
      address: data.address,
      name: typeof data.name === "string" ? data.name : "",
    },
  };
}
function message(value: unknown): GraphMailMessage {
  const data = record(value),
    body = record(data.body);
  if (typeof data.id !== "string" || !data.id)
    throw new Error("Invalid message ID");
  return {
    id: data.id,
    subject: typeof data.subject === "string" ? data.subject : "",
    bodyPreview: typeof data.bodyPreview === "string" ? data.bodyPreview : "",
    body:
      typeof body.content === "string"
        ? {
            content: body.content,
            contentType:
              typeof body.contentType === "string" ? body.contentType : "text",
          }
        : undefined,
    from: address(data.from),
    toRecipients: Array.isArray(data.toRecipients)
      ? data.toRecipients
          .map(address)
          .filter((a): a is NonNullable<typeof a> => Boolean(a))
      : [],
    receivedDateTime:
      typeof data.receivedDateTime === "string" &&
      Number.isFinite(Date.parse(data.receivedDateTime))
        ? data.receivedDateTime
        : "",
    isRead: data.isRead === true,
    hasAttachments: data.hasAttachments === true,
  };
}
async function upstreamError(response: Response): Promise<GraphError> {
  if (response.status >= 300 && response.status < 400)
    return {
      code: "UNEXPECTED_REDIRECT",
      message: "微软接口返回了意外跳转，已停止请求以保护授权信息，请稍后重试",
      status: 502,
    };
  const data = record(await response.json().catch(() => ({})));
  const raw =
    typeof data.error === "string" ? data.error : record(data.error).code;
  const code =
    typeof raw === "string" && /^[\w.-]{1,100}$/.test(raw)
      ? raw
      : `HTTP_${response.status}`;
  let message = "微软服务请求失败，请稍后重试";
  if (
    [
      "invalid_grant",
      "interaction_required",
      "consent_required",
      "login_required",
    ].includes(code)
  )
    message =
      "授权已失效或需要确认，请重新授权，或更新 Refresh Token 与其原始 Client ID";
  else if (["invalid_client", "unauthorized_client"].includes(code))
    message = "应用配置无效，请确认 Client ID、应用密钥及令牌所属应用一致";
  else if (code === "invalid_scope" || response.status === 403)
    message =
      "缺少所需的微软邮件权限，请重新授权 Mail.Read；删除邮件需要 Mail.ReadWrite";
  else if (response.status === 401)
    message = "微软未接受此授权，请重新授权该账号";
  else if (response.status === 404)
    message = "微软邮箱、邮件或附件不存在，可能已被移动或删除";
  else if (response.status === 429) message = "微软服务限流，请稍后再试";
  const retry = Number(response.headers.get("Retry-After"));
  return {
    code,
    message,
    status: response.status,
    ...(retry > 0 && Number.isFinite(retry)
      ? { retry_after: Math.ceil(retry) }
      : {}),
  };
}
function networkError(error: unknown): GraphError {
  const timedOut =
    error instanceof Error &&
    ["TimeoutError", "AbortError"].includes(error.name);
  return {
    code: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
    message: timedOut
      ? "连接微软服务超时，请稍后重试"
      : "暂时无法连接微软服务，请稍后重试",
    status: 502,
  };
}

export async function tokenRequest(params: URLSearchParams): Promise<{
  token?: string;
  newRefreshToken?: string;
  scopes?: string[];
  error?: GraphError;
}> {
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: AbortSignal.timeout(15000),
      redirect: "manual",
    });
    if (!response.ok) return { error: await upstreamError(response) };
    const data = record(await response.json());
    if (typeof data.access_token !== "string" || !data.access_token)
      return {
        error: {
          code: "INVALID_RESPONSE",
          message: "微软服务未返回有效访问令牌",
        },
      };
    return {
      token: data.access_token,
      newRefreshToken:
        typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      // Graph tokens can be opaque. Only use the token endpoint's scope metadata,
      // never decode an unverified JWT or assume .default means Mail.Send.
      ...(typeof data.scope === "string"
        ? { scopes: data.scope.split(/\s+/).filter(Boolean) }
        : {}),
    };
  } catch (error) {
    return { error: networkError(error) };
  }
}
export async function getAccessToken(
  clientId: string,
  refreshToken: string,
  clientSecret?: string,
) {
  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: "https://graph.microsoft.com/.default offline_access",
  });
  if (clientSecret) params.set("client_secret", clientSecret);
  return tokenRequest(params);
}
async function graphResponse(
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<GraphResult<Response>> {
  try {
    const response = await fetch(
      path.startsWith("https:") ? path : `${GRAPH_BASE}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000),
        redirect: "manual",
      },
    );
    return response.ok
      ? { data: response }
      : { error: await upstreamError(response) };
  } catch (error) {
    return { error: networkError(error) };
  }
}
export function validNextLink(link: string, folder: MailFolder): boolean {
  try {
    const url = new URL(link);
    const paths =
      folder === "all"
        ? ["/v1.0/me/messages"]
        : [
            `/v1.0/me/mailFolders/${folder}/messages`,
            `/v1.0/me/mailFolders('${folder}')/messages`,
          ];
    return (
      link.length <= 16000 &&
      url.origin === "https://graph.microsoft.com" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      paths.includes(url.pathname)
    );
  } catch {
    return false;
  }
}
export async function fetchEmails(
  token: string,
  options: MailOptions = {},
): Promise<GraphResult<MailPage>> {
  const {
    folder = "inbox",
    top = 20,
    keyword = "",
    includeBody = false,
    nextLink,
    since,
  } = options;
  if (
    !FOLDERS.includes(folder) ||
    !Number.isInteger(top) ||
    top < 1 ||
    top > 50 ||
    keyword.length > 200 ||
    (since && !Number.isFinite(Date.parse(since))) ||
    (nextLink && !validNextLink(nextLink, folder))
  ) {
    return {
      error: {
        code: "INVALID_QUERY",
        message: "邮件查询参数或分页链接无效",
        status: 400,
      },
    };
  }
  const fields =
    "id,subject,bodyPreview,from,receivedDateTime,isRead,hasAttachments";
  const params = new URLSearchParams({
    $top: String(top),
    $select: fields + (includeBody ? ",body" : ""),
  });
  // Outlook search already sorts results; combining search with orderby fails for many mailboxes.
  if (keyword) params.set("$search", JSON.stringify(keyword));
  else {
    params.set("$orderby", "receivedDateTime desc");
    if (since)
      params.set(
        "$filter",
        `receivedDateTime ge ${new Date(since).toISOString()}`,
      );
  }
  const path =
    folder === "all" ? "/me/messages" : `/me/mailFolders/${folder}/messages`;
  const result = await graphResponse(token, nextLink || `${path}?${params}`);
  if (result.error) return result;
  try {
    const data = record(await result.data.json());
    if (!Array.isArray(data.value)) throw new Error("Invalid messages");
    const next =
      typeof data["@odata.nextLink"] === "string"
        ? data["@odata.nextLink"]
        : undefined;
    if (next && !validNextLink(next, folder))
      throw new Error("Invalid nextLink");
    return { data: { items: data.value.map(message), nextLink: next } };
  } catch {
    return {
      error: {
        code: "INVALID_RESPONSE",
        message: "微软服务返回的邮件列表无效",
        status: 502,
      },
    };
  }
}
export async function fetchMessage(
  token: string,
  id: string,
): Promise<GraphResult<GraphMailMessage>> {
  const result = await graphResponse(
    token,
    `/me/messages/${encodeURIComponent(id)}?$select=id,subject,body,bodyPreview,from,toRecipients,receivedDateTime,isRead,hasAttachments`,
  );
  if (result.error) return result;
  try {
    return { data: message(await result.data.json()) };
  } catch {
    return {
      error: {
        code: "INVALID_RESPONSE",
        message: "微软服务返回的邮件无效",
        status: 502,
      },
    };
  }
}
export async function fetchAttachments(
  token: string,
  id: string,
): Promise<GraphResult<GraphAttachment[]>> {
  const result = await graphResponse(
    token,
    `/me/messages/${encodeURIComponent(id)}/attachments?$select=id,name,size,contentType,isInline&$top=50`,
  );
  if (result.error) return result;
  const data = record(await result.data.json().catch(() => ({})));
  if (
    !Array.isArray(data.value) ||
    data.value.some(
      (a) =>
        typeof record(a).id !== "string" ||
        typeof record(a).name !== "string" ||
        !Number.isFinite(record(a).size),
    )
  )
    return {
      error: { code: "INVALID_RESPONSE", message: "附件列表无效", status: 502 },
    };
  return {
    data: data.value.map((value) => {
      const a = record(value);
      return {
        id: a.id as string,
        name: a.name as string,
        size: Math.max(0, a.size as number),
        contentType:
          typeof a.contentType === "string" ? a.contentType : undefined,
        isInline: a.isInline === true,
      };
    }),
  };
}
export const downloadAttachment = (
  token: string,
  message: string,
  attachment: string,
) =>
  graphResponse(
    token,
    `/me/messages/${encodeURIComponent(message)}/attachments/${encodeURIComponent(attachment)}/$value`,
  );
export const deleteMessage = (token: string, id: string) =>
  graphResponse(token, `/me/messages/${encodeURIComponent(id)}`, "DELETE");

export function validMessageId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[\x21-\x7e]{1,2048}$/.test(value) &&
    value !== "." &&
    value !== ".."
  );
}
function permissionRequired(required: readonly string[]): GraphError {
  return {
    code: "PERMISSION_REQUIRED",
    message: `此操作需要 ${required.join(" 和 ")} 权限，请为该账号重新授权并启用发信；如已授权，请检查微软组织的邮件策略`,
    status: 403,
    required_scopes: [...required],
  };
}
function missingPermission(
  scopes: readonly string[] | undefined,
  required: readonly string[],
) {
  // Unknown scopes are resolved by Graph itself; explicit empty scopes are not unknown.
  if (scopes === undefined) return undefined;
  const granted = new Set(
    scopes.map((scope) =>
      scope.replace(/^https:\/\/graph\.microsoft\.com\//, ""),
    ),
  );
  return required.some((scope) => !granted.has(scope))
    ? permissionRequired(required)
    : undefined;
}
function outboundError(
  error: GraphError,
  required: readonly string[],
  sending: boolean,
): GraphError {
  if (error.status === 403 || error.code === "invalid_scope")
    return permissionRequired(required);
  if (sending && (!error.status || error.status === 408 || error.status >= 500))
    return {
      ...error,
      status: 502,
      delivery_unknown: true,
      message:
        "未能确认微软是否已受理邮件，请先检查已发送邮件，避免直接重试造成重复发送",
    };
  return error;
}
function invalidOutboundResponse(): GraphError {
  return {
    code: "INVALID_RESPONSE",
    message: "微软服务返回的操作结果无效",
    status: 502,
  };
}
async function submitMail(
  token: string,
  path: string,
  body: unknown,
  scopes?: readonly string[],
): Promise<GraphResult<MailAccepted>> {
  const required = ["Mail.Send"];
  const permission = missingPermission(scopes, required);
  if (permission) return { error: permission };
  // Sending is not idempotent. Never retry here, even after timeouts or 5xx responses.
  const result = await graphResponse(token, path, "POST", body);
  if (result.error)
    return { error: outboundError(result.error, required, true) };
  if (result.data.status !== 202)
    return { error: outboundError(invalidOutboundResponse(), required, true) };
  return { data: { accepted: true } };
}
function fileAttachment(file: OutgoingAttachment) {
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: file.name,
    contentType: file.content_type,
    contentBytes: file.content_base64,
  };
}
/** Input must first pass validateOutlookSend at the application boundary. */
export async function sendMail(
  token: string,
  input: SendMailInput,
  scopes?: readonly string[],
): Promise<GraphResult<MailAccepted>> {
  const recipients = (values: string[]) =>
    values.map((address) => ({ emailAddress: { address } }));
  return submitMail(
    token,
    "/me/sendMail",
    {
      message: {
        subject: input.subject,
        body: { contentType: "Text", content: input.body },
        toRecipients: recipients(input.to),
        ...(input.cc?.length ? { ccRecipients: recipients(input.cc) } : {}),
        ...(input.bcc?.length ? { bccRecipients: recipients(input.bcc) } : {}),
        ...(input.attachments?.length
          ? { attachments: input.attachments.map(fileAttachment) }
          : {}),
      },
      // Omit saveToSentItems: Graph defaults to true and Mail.Send alone suffices.
    },
    scopes,
  );
}
/** createReply requires Mail.ReadWrite; Mail.Send alone cannot create a draft. */
export async function createReply(
  token: string,
  messageId: string,
  body: string,
  scopes?: readonly string[],
): Promise<GraphResult<{ id: string }>> {
  if (!validMessageId(messageId))
    return {
      error: { code: "INVALID_QUERY", message: "邮件 ID 无效", status: 400 },
    };
  const required = ["Mail.ReadWrite"];
  const permission = missingPermission(scopes, required);
  if (permission) return { error: permission };
  const result = await graphResponse(
    token,
    `/me/messages/${encodeURIComponent(messageId)}/createReply`,
    "POST",
    {
      message: { body: { contentType: "Text", content: body } },
    },
  );
  if (result.error)
    return { error: outboundError(result.error, required, false) };
  const draft = record(await result.data.json().catch(() => ({})));
  if (
    ![200, 201].includes(result.data.status) ||
    !validMessageId(draft.id) ||
    draft.isDraft !== true
  )
    return { error: invalidOutboundResponse() };
  return { data: { id: draft.id } };
}
/** Input must first pass validateOutlookReply at the application boundary. */
export async function replyMessage(
  token: string,
  messageId: string,
  input: ReplyMailInput,
  scopes?: readonly string[],
): Promise<GraphResult<MailAccepted>> {
  if (!validMessageId(messageId))
    return {
      error: { code: "INVALID_QUERY", message: "邮件 ID 无效", status: 400 },
    };
  if (!input.attachments?.length)
    return submitMail(
      token,
      `/me/messages/${encodeURIComponent(messageId)}/reply`,
      {
        message: { body: { contentType: "Text", content: input.body } },
      },
      scopes,
    );
  // Preflight both permissions before creating a draft with any side effects.
  const required = ["Mail.ReadWrite", "Mail.Send"];
  const permission = missingPermission(scopes, required);
  if (permission) return { error: permission };
  const draft = await createReply(token, messageId, input.body, scopes);
  if (draft.error) return draft;
  const draftPath = `/me/messages/${encodeURIComponent(draft.data.id)}`;
  for (const file of input.attachments) {
    const result = await graphResponse(
      token,
      `${draftPath}/attachments`,
      "POST",
      fileAttachment(file),
    );
    const failure =
      result.error ||
      (result.data.status !== 201 ? invalidOutboundResponse() : undefined);
    if (failure)
      return {
        error: {
          ...outboundError(failure, ["Mail.ReadWrite"], false),
          draft_id: draft.data.id,
        },
      };
  }
  const sent = await submitMail(token, `${draftPath}/send`, undefined, scopes);
  // Keep failed drafts for inspection. Deleting after an ambiguous send could delete sent mail.
  return sent.error
    ? { error: { ...sent.error, draft_id: draft.data.id } }
    : sent;
}
export async function fetchProfile(
  token: string,
): Promise<GraphResult<{ email: string }>> {
  const result = await graphResponse(
    token,
    "/me?$select=mail,userPrincipalName",
  );
  if (result.error) return result;
  const data = record(await result.data.json().catch(() => ({})));
  const address = data.mail || data.userPrincipalName;
  if (typeof address !== "string" || !address.includes("@"))
    return {
      error: { code: "INVALID_PROFILE", message: "无法读取微软账号的邮箱地址" },
    };
  return { data: { email: address.toLowerCase() } };
}
