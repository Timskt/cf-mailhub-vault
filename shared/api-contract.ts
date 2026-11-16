/** Public contract: imported by the Worker and documentation generator. No credentials or environment values. */
export type Schema = Record<string, unknown>;
export type ApiParameter = {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  description: string;
  schema: Schema;
  example?: unknown;
};
export type ApiOperation = {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  operationId: string;
  summary: string;
  tag: string;
  description: string;
  auth: "public" | "key" | "admin" | "cookie";
  grants: ApiGrant[];
  conditionalGrants?: { condition: string; grants: ApiGrant[] }[];
  effects: string;
  credentials?: boolean;
  parameters: ApiParameter[];
  body?: Schema;
  example?: unknown;
  response: Schema;
  responseStatus: 200 | 201 | 202;
  responseExample?: unknown;
  media?: string;
};
export type ApiGrant =
  "verify:read" | "mailbox:write" | "vault:read" | "vault:write" | "admin";
export const API_VERSION = "2.3.0";
export const s = (maxLength?: number): Schema => ({
  type: "string",
  ...(maxLength ? { maxLength } : {}),
});
const n = (minimum = 0, maximum?: number): Schema => ({
  type: "integer",
  minimum,
  ...(maximum === undefined ? {} : { maximum }),
});
const bool: Schema = { type: "boolean" };
const flag: Schema = { type: "integer", enum: [0, 1] };
const strEnum = (...values: string[]): Schema => ({
  type: "string",
  enum: values,
});
const date: Schema = {
  type: "string",
  description:
    "UTC 时间，可能为 ISO 8601 或 SQLite UTC（YYYY-MM-DD HH:mm:ss）；未发生时为空字符串。",
};
const id = n(1, Number.MAX_SAFE_INTEGER);
const address: Schema = { ...s(254), format: "email" };
export const obj = (
  properties: Record<string, Schema>,
  required: string[] = [],
  extra = true,
): Schema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: extra,
});
export const arr = (items: Schema, maxItems?: number): Schema => ({
  type: "array",
  items,
  ...(maxItems ? { maxItems } : {}),
});
const ref = (name: string): Schema => ({
  $ref: `#/components/schemas/${name}`,
});
const success = (data?: Schema): Schema =>
  obj(
    {
      success: { const: true, type: "boolean" },
      ...(data ? { data } : {}),
      message: s(),
    },
    data ? ["success", "data"] : ["success"],
  );
const paged = (data: Schema): Schema =>
  obj(
    {
      success: { const: true, type: "boolean" },
      data: arr(data),
      page: n(1),
      limit: n(1, 100),
      total: n(),
      summary: obj({}),
    },
    ["success", "data", "page", "limit", "total"],
  );
const timestamps = { created_at: date, updated_at: date };
const sources = strEnum("cf_domain", "outlook", "gptmail", "external");
const statuses = strEnum("active", "pending", "banned", "deprecated");
const categories = strEnum(
  "general",
  "verification",
  "billing",
  "newsletter",
  "notification",
);
const targetProperties = {
  email: address,
  vault_id: id,
  platform: s(100),
  source: strEnum("cf_domain", "outlook"),
};
const targetRules = [
  obj({ ...targetProperties, vault_id: { not: {} }, platform: { not: {} } }, [
    "email",
  ]),
  obj(
    {
      ...targetProperties,
      email: { not: {} },
      platform: { not: {} },
      source: { not: {} },
    },
    ["vault_id"],
  ),
  obj(
    {
      ...targetProperties,
      email: { not: {} },
      vault_id: { not: {} },
      source: { not: {} },
    },
    ["platform"],
  ),
];
const codeFilters = {
  since: {
    ...s(40),
    format: "date-time",
    description: "含时区的 ISO 8601。记录操作开始时刻并在所有轮询中保持不变。",
  },
  sender: s(254),
  q: s(200),
};
const vaultInput = {
  platform_name: { ...s(100), minLength: 1 },
  platform_url: s(2048),
  account_email: address,
  email_source: sources,
  username: s(254),
  password: s(1000),
  totp_secret: s(1000),
  status: statuses,
  category: s(100),
  proxy_node: s(300),
  remark: s(4000),
};
const platformInput = {
  name: { ...s(100), minLength: 1 },
  url: {
    ...s(2048),
    description: "空字符串或不含用户名/密码的 HTTP(S) 网址。",
  },
  category: s(100),
  remark: s(4000),
  is_pinned: bool,
};
const vaultRawText = {
  ...s(1048576),
  minLength: 1,
  description:
    "UTF-8 最多 1 MiB、1–200 条账号；支持带表头文本/CSV、固定顺序 ---- 文本及 JSON。包含分隔符、引号或换行的字段用双引号包裹，内部引号写成两个引号。",
};
const vaultTextExample = {
  raw_text:
    "platform_name----account_email----password----email_source\nExample----user@example.com----Example-password-42----external",
};
const mailboxFields = {
  id,
  address,
  prefix: s(64),
  domain: s(253),
  expires_at: date,
  is_permanent: flag,
  associated_platform: s(),
  associated_vault_id: { type: ["integer", "null"] },
  remark: s(),
  is_pinned: flag,
  ...timestamps,
};
const mailFields = {
  id,
  recipient: address,
  sender: s(),
  sender_name: s(),
  subject: s(),
  verification_code: s(),
  verification_link: s(),
  is_read: flag,
  is_pinned: flag,
  is_protected: flag,
  is_archived: flag,
  category: categories,
  rule_name: s(),
  dkim_status: s(),
  spf_status: s(),
  created_at: date,
};
const outlookInput = {
  email: address,
  password: s(1000),
  client_id: s(100),
  refresh_token: { ...s(16384), minLength: 20, pattern: "^\\S+$" },
  remark: s(1000),
  group_id: n(1, 1000000),
  status: strEnum("active", "disabled"),
};
const outlookFields = {
  id,
  email: address,
  client_id: s(),
  group_id: id,
  remark: s(),
  status: strEnum("active", "disabled"),
  auth_status: strEnum("unchecked", "healthy", "reauth_required", "error"),
  last_checked_at: date,
  last_error: s(),
  last_error_code: s(),
  last_token_refresh_at: date,
  last_token_attempt_at: date,
  next_token_refresh_at: date,
  token_refresh_failures: n(),
  token_refresh_status: strEnum(
    "pending",
    "healthy",
    "retrying",
    "reauth_required",
  ),
  token_refresh_error: s(),
  ...timestamps,
};
const ruleInput = {
  name: s(80),
  enabled: bool,
  priority: n(1, 999),
  sender_contains: s(254),
  recipient: address,
  domain: s(253),
  subject_contains: s(200),
  verification_only: bool,
  action_category: strEnum(
    "",
    "general",
    "verification",
    "billing",
    "newsletter",
    "notification",
  ),
  mark_read: bool,
  archive: bool,
  pin: bool,
};
const mailPatch = obj(
  { is_read: bool, is_pinned: bool, is_archived: bool, category: categories },
  [],
  false,
);
const batchIds = { ...arr(id, 100), minItems: 1 };
const endpointSample = {
  email: "user@example.com",
  since: "2026-11-15T00:00:00Z",
  sender: "auth",
};
const apiGrants = strEnum(
  "verify:read",
  "mailbox:write",
  "vault:read",
  "vault:write",
  "admin",
);
const credentialTables = strEnum(
  "accounts",
  "platform_vault",
  "oauth_sessions",
  "webhooks",
);
const webhookEvents = strEnum(
  "mail.received",
  "code.extracted",
  "token.renew_failed",
  "storage.sync_interrupted",
);
const deliveryStates = strEnum(
  "pending",
  "delivering",
  "delivered",
  "dead",
  "cancelled",
);
const hash = { ...s(64), pattern: "^[a-f0-9]{64}$" };
const uuid = { ...s(36), pattern: "^[a-f0-9-]{36}$" };
const isoTime = { ...s(40), format: "date-time" };
const outboundAttachmentTypes = [
  "text/plain",
  "text/csv",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];
const backupTables = [
  "settings",
  "groups",
  "tags",
  "accounts",
  "account_tags",
  "cf_inbox_mails",
  "mail_rules",
  "platforms",
  "platform_vault",
  "temp_emails",
  "temp_mailboxes",
  "domains",
];
const legacyBackupTables = backupTables.filter(
  (table) => table !== "platforms",
);
const countsFor = (tables: string[]) =>
  obj(
    Object.fromEntries(tables.map((table) => [table, n(0, 1000)])),
    tables,
    false,
  );
const backupCounts = countsFor(backupTables);
const backupManifest = (version: 10 | 11, tables: string[]) =>
  obj(
    {
      format: { type: "string", const: "mailhub-backup" },
      version: { type: "integer", const: 1 },
      schema_version: { type: "integer", const: version },
      schema_hash: hash,
      created_at: isoTime,
      redacted: bool,
      restorable: bool,
      consistency: { type: "string", const: "revision_checked" },
      table_counts: countsFor(tables),
      table_hashes: obj(
        Object.fromEntries(tables.map((table) => [table, hash])),
        tables,
        false,
      ),
      data_hash: hash,
      excluded: arr(s()),
      external_dependencies: arr(s()),
    },
    [
      "format",
      "version",
      "schema_version",
      "schema_hash",
      "created_at",
      "redacted",
      "restorable",
      "consistency",
      "table_counts",
      "table_hashes",
      "data_hash",
      "excluded",
      "external_dependencies",
    ],
    false,
  );
const backupDocument = (manifest: string, tables: string[]) =>
  obj(
    {
      manifest: ref(manifest),
      tables: obj(
        Object.fromEntries(
          tables.map((table) => [
            table,
            arr(
              {
                type: "object",
                additionalProperties: { type: ["string", "number", "null"] },
              },
              1000,
            ),
          ]),
        ),
        tables,
        false,
      ),
    },
    ["manifest", "tables"],
    false,
  );
const dataset = obj({ sourceId: s(), generation: s() }, [
  "sourceId",
  "generation",
]);
export const schemas: Record<string, Schema> = {
  Error: obj(
    {
      success: { type: "boolean", const: false },
      error: s(),
      message: s(),
      retryable: bool,
      retry_after: n(1),
      status: n(400, 599),
      required_scopes: arr(s()),
      draft_id: s(2048),
      delivery_unknown: bool,
    },
    ["message"],
  ),
  Target: { ...obj(targetProperties), oneOf: targetRules },
  VerificationRequest: {
    ...obj({ ...targetProperties, ...codeFilters }),
    oneOf: targetRules,
  },
  Code: obj(
    {
      has_mail: bool,
      code: s(),
      link: s(),
      subject: s(),
      sender: s(),
      received_at: date,
      mail_id: s(),
      scanned: n(),
      checked_at: date,
      limited: bool,
      message: s(),
    },
    ["has_mail", "code", "link", "message"],
  ),
  Verification: {
    allOf: [
      ref("Code"),
      obj(
        {
          email: address,
          source: sources,
          vault_id: id,
          outcome: strEnum("found", "empty"),
          poll_after_seconds: n(1),
        },
        ["email", "source", "outcome", "poll_after_seconds"],
      ),
    ],
  },
  Health: obj(
    {
      state: strEnum(
        "missing",
        "disabled",
        "reauth_required",
        "error",
        "unchecked",
        "stale",
        "connected",
        "configured",
        "external",
      ),
      label: s(),
      message: s(),
      needs_attention: bool,
      can_lookup: bool,
      action: {
        type: ["string", "null"],
        enum: [
          "connect_outlook",
          "manage_outlook",
          "check_outlook",
          "manage_domains",
          null,
        ],
      },
      account_id: id,
      checked_at: date,
    },
    ["state", "label", "message", "needs_attention", "can_lookup", "action"],
  ),
  MailboxInspection: obj(
    {
      email: address,
      source: sources,
      vault_id: id,
      health: ref("Health"),
      mailbox: {
        anyOf: [
          obj({ id, is_permanent: bool, expires_at: date, is_expired: bool }, [
            "id",
            "is_permanent",
            "expires_at",
            "is_expired",
          ]),
          { type: "null" },
        ],
      },
      observed_at: date,
      live_check: { type: "boolean", const: false },
    },
    ["email", "source", "health", "mailbox", "observed_at", "live_check"],
  ),
  BatchVerification: obj(
    {
      results: arr(
        {
          oneOf: [
            obj(
              {
                index: n(),
                success: { type: "boolean", const: true },
                data: ref("Verification"),
              },
              ["index", "success", "data"],
            ),
            obj(
              {
                index: n(),
                success: { type: "boolean", const: false },
                error: s(),
                message: s(),
                status: n(400, 599),
                retryable: bool,
                retry_after: n(1),
              },
              ["index", "success", "error", "message", "status", "retryable"],
            ),
          ],
        },
        5,
      ),
      summary: obj({ total: n(1, 5), succeeded: n(), failed: n() }, [
        "total",
        "succeeded",
        "failed",
      ]),
      completed_at: date,
    },
    ["results", "summary", "completed_at"],
  ),
  VaultInput: obj(vaultInput, ["platform_name", "account_email"]),
  VaultImport: {
    ...obj({
      accounts: { ...arr(ref("VaultInput"), 200), minItems: 1 },
      raw_text: vaultRawText,
      platform_name: s(100),
      duplicate_mode: { ...strEnum("skip", "update"), default: "skip" },
    }),
    oneOf: [
      { required: ["accounts"], not: { required: ["raw_text"] } },
      { required: ["raw_text"], not: { required: ["accounts"] } },
    ],
  },
  VaultImportPreview: obj(
    {
      success: { type: "boolean", const: true },
      valid_count: n(0, 200),
      error_count: n(0, 200),
      duplicate_count: n(0, 200),
      rows: arr(
        obj(
          {
            line: n(1),
            platform_name: s(100),
            account_email: address,
            username: s(254),
            duplicate: bool,
            error: s(),
          },
          ["line"],
          false,
        ),
        200,
      ),
    },
    ["success", "valid_count", "error_count", "duplicate_count", "rows"],
    false,
  ),
  VaultImportResult: obj(
    {
      success: { type: "boolean", const: true },
      message: s(),
      created: n(0, 200),
      updated: n(0, 200),
      skipped: n(0, 200),
      duplicate_count: n(0, 200),
    },
    ["success", "message", "created", "updated", "skipped", "duplicate_count"],
  ),
  Vault: obj(
    {
      ...vaultInput,
      id,
      is_pinned: flag,
      last_code: s(),
      last_code_at: date,
      ...timestamps,
    },
    ["id", "platform_name", "account_email", "email_source"],
  ),
  VaultSummary: obj(
    {
      ...Object.fromEntries(
        Object.entries(vaultInput).filter(
          ([k]) => !["password", "totp_secret"].includes(k),
        ),
      ),
      id,
      has_password: flag,
      has_totp: {
        ...flag,
        description: "仅标记是否配置 TOTP；密钥只在显式读取详情或导出时返回。",
      },
      is_pinned: flag,
      last_code: s(),
      last_code_at: date,
      mailbox: ref("Health"),
      needs_attention: bool,
      ...timestamps,
    },
    ["id", "platform_name", "account_email", "mailbox", "needs_attention"],
  ),
  VaultPatch: {
    ...obj(
      { status: statuses, category: s(100), remark: s(4000), is_pinned: bool },
      [],
      false,
    ),
    minProperties: 1,
  },
  Platform: obj(
    {
      platform_name: s(),
      count: n(),
      attention_count: n(),
      unchecked_count: n(),
      connected_count: n(),
      pinned_count: n(),
      sources: arr(sources),
      categories: arr(s()),
      updated_at: date,
      definition: ref("PlatformDefinition"),
    },
    ["platform_name", "count", "attention_count"],
  ),
  PlatformInput: obj(platformInput, ["name"]),
  PlatformDefinition: obj(
    {
      ...platformInput,
      name_key: s(100),
      is_pinned: flag,
      ...timestamps,
      account_count: n(),
      managed: {
        ...bool,
        description:
          "true 表示已保存到独立目录；false 是旧账号名推导出的待接管平台。",
      },
    },
    [
      "name_key",
      "name",
      "url",
      "category",
      "remark",
      "is_pinned",
      "created_at",
      "updated_at",
      "account_count",
      "managed",
    ],
  ),
  Mailbox: obj(
    {
      ...mailboxFields,
      mail_count: n(),
      unread_count: n(),
      last_received_at: date,
      is_expired: bool,
      remaining_seconds: n(),
    },
    ["id", "address", "domain", "is_permanent"],
  ),
  MailboxPlan: obj(
    {
      domain: s(253),
      prefix: s(64),
      duration_minutes: n(1, 525600),
      is_permanent: bool,
      remark: s(500),
    },
    ["domain", "prefix"],
  ),
  MailSummary: obj(mailFields, ["id", "recipient", "subject", "is_read"]),
  Mail: obj(
    {
      ...mailFields,
      message_id: s(),
      text_content: s(),
      html_content: s(),
      raw_size: n(),
      expires_at: date,
      has_raw: bool,
      attachments: arr(ref("StoredAttachment")),
    },
    ["id", "recipient", "subject", "text_content", "html_content", "is_read"],
  ),
  MailPatch: { ...mailPatch, minProperties: 1 },
  RuleInput: {
    ...obj(ruleInput, ["name"]),
    description: "至少一个匹配条件及一个处理动作；规则采用全部条件同时满足。",
  },
  Rule: obj(
    {
      ...ruleInput,
      enabled: flag,
      verification_only: flag,
      mark_read: flag,
      archive: flag,
      pin: flag,
      id,
      ...timestamps,
    },
    ["id", "name"],
  ),
  RulePreview: obj(
    {
      mails: arr(
        obj({
          id,
          sender: s(),
          recipient: address,
          subject: s(),
          created_at: date,
          category: categories,
          is_read: flag,
          is_archived: flag,
          is_pinned: flag,
        }),
      ),
      total: n(),
      limited: bool,
      revision: s(64),
      changes: obj({
        rule_name: s(),
        category: categories,
        is_read: flag,
        is_archived: flag,
        is_pinned: flag,
      }),
    },
    ["mails", "total", "limited", "revision", "changes"],
  ),
  OutlookInput: obj(outlookInput, ["email", "refresh_token"]),
  Outlook: obj({ ...outlookFields, password: s(), refresh_token: s() }, [
    "id",
    "email",
    "client_id",
    "refresh_token",
  ]),
  OutlookSummary: obj(
    {
      ...outlookFields,
      has_password: flag,
      group_name: s(),
      group_color: s(),
      platform_count: n(),
      tags: arr(ref("Tag")),
    },
    ["id", "email", "auth_status"],
  ),
  Tag: obj(
    {
      id,
      name: s(),
      color: s(),
      description: s(),
      account_count: n(),
      ...timestamps,
    },
    ["id", "name", "color"],
  ),
  GraphMail: obj(
    {
      id: s(),
      subject: s(),
      bodyPreview: s(),
      body: obj({ contentType: s(), content: s() }),
      from: obj({ emailAddress: obj({ address, name: s() }) }),
      receivedDateTime: date,
      isRead: bool,
      hasAttachments: bool,
      verification_code: s(),
      verification_link: s(),
      attachments: arr(
        obj({
          id: s(),
          name: s(),
          size: n(),
          contentType: s(),
          isInline: bool,
        }),
      ),
      attachment_error: s(),
    },
    ["id"],
  ),
  Domain: obj(
    {
      domain: s(),
      enabled: flag,
      remark: s(),
      source: strEnum("environment", "database"),
      is_default: bool,
      dns_status: s(),
      last_checked_at: date,
      last_received_at: date,
    },
    ["domain", "enabled", "source", "is_default"],
  ),
  StoredAttachment: obj(
    {
      id: {
        ...s(3),
        pattern: "^\\d{1,3}$",
        description: "附件在原始邮件中的零基序号，按字符串传入下载路径。",
      },
      name: s(200),
      size: n(),
      contentType: s(),
    },
    ["id", "name", "size", "contentType"],
  ),
  OutgoingAttachment: obj(
    {
      name: {
        ...s(255),
        minLength: 1,
        description:
          "无路径/控制字符的文件名，UTF-8 也须 ≤255 字节；扩展名须匹配 MIME。支持 txt/csv/pdf/png/jpg/jpeg/gif/webp/docx/xlsx/pptx/zip。",
      },
      content_type: strEnum(...outboundAttachmentTypes),
      content_base64: {
        ...s(4194304),
        minLength: 4,
        contentEncoding: "base64",
        description: "完整、规范的标准 Base64；全部附件解码后合计 ≤3 MiB。",
      },
    },
    ["name", "content_type", "content_base64"],
    false,
  ),
  OutlookSend: obj(
    {
      to: { ...arr(address, 100), minItems: 1 },
      cc: arr(address, 100),
      bcc: arr(address, 100),
      subject: {
        ...s(255),
        minLength: 1,
        description: "非空单行主题，不接受控制字符。",
      },
      body: {
        ...s(100000),
        minLength: 1,
        description: "非空纯文本，不接受 HTML 模式。",
      },
      attachments: arr(ref("OutgoingAttachment"), 10),
    },
    ["to", "subject", "body"],
    false,
  ),
  OutlookReply: obj(
    {
      body: { ...s(100000), minLength: 1 },
      attachments: arr(ref("OutgoingAttachment"), 10),
    },
    ["body"],
    false,
  ),
  MailAccepted: obj(
    { accepted: { type: "boolean", const: true } },
    ["accepted"],
    false,
  ),
  ApiKeyRestrictions: obj(
    {
      emails: { ...arr(address, 100), minItems: 1 },
      platforms: { ...arr({ ...s(100), minLength: 1 }, 100), minItems: 1 },
    },
    [],
    false,
  ),
  ApiKeyInput: obj(
    {
      name: { ...s(80), minLength: 1 },
      scopes: { ...arr(apiGrants, 5), minItems: 1 },
      restrictions: ref("ApiKeyRestrictions"),
      expires_at: {
        ...isoTime,
        description:
          "未来 365 天以内，必须包含时区；省略时为当前时间后 30 天。",
      },
    },
    ["name", "scopes"],
    false,
  ),
  ApiKeyMetadata: obj(
    {
      id: uuid,
      prefix: s(12),
      name: s(80),
      scopes: arr(apiGrants, 5),
      restrictions: ref("ApiKeyRestrictions"),
      expires_at: isoTime,
      revoked_at: date,
      last_used_at: date,
      ...timestamps,
    },
    [
      "id",
      "prefix",
      "name",
      "scopes",
      "restrictions",
      "expires_at",
      "revoked_at",
      "last_used_at",
      "created_at",
      "updated_at",
    ],
  ),
  AuditEntry: obj(
    {
      id,
      actor_type: strEnum(
        "admin_session",
        "api_key",
        "master_key",
        "anonymous",
        "system",
      ),
      actor_id: s(),
      api_key_prefix: s(),
      request_id: s(),
      action: s(),
      resource: s(),
      method: s(),
      route: s(),
      status: n(0, 599),
      metadata: obj({}),
      created_at: date,
    },
    ["id", "actor_type", "action", "status", "metadata", "created_at"],
  ),
  CredentialStatus: obj(
    {
      enabled: bool,
      previous_key_available: bool,
      tables: arr(
        obj({ table: credentialTables, plaintext_records: n() }, [
          "table",
          "plaintext_records",
        ]),
        4,
      ),
    },
    ["enabled", "previous_key_available", "tables"],
  ),
  RekeyResult: obj(
    {
      table: credentialTables,
      scanned: n(0, 50),
      changed: n(0, 50),
      skipped: n(0, 50),
      cursor: { oneOf: [n(), s(200)] },
      complete: bool,
    },
    ["table", "scanned", "changed", "skipped", "cursor", "complete"],
  ),
  WebhookInput: obj(
    {
      name: { ...s(100), minLength: 1 },
      url: {
        ...s(2000),
        format: "uri",
        pattern: "^https://",
        description:
          "公网 HTTPS 域名，仅 443；不能含凭据或 fragment；投递不跟随重定向。",
      },
      events: { ...arr(webhookEvents), minItems: 1 },
      include_code: {
        ...bool,
        default: false,
        description: "显式允许发送 subject/code/link；默认仅白名单元数据。",
      },
    },
    ["name", "url", "events"],
  ),
  Webhook: obj(
    {
      id,
      name: s(100),
      destination: s(),
      events: arr(webhookEvents),
      include_code: flag,
      enabled: flag,
      ...timestamps,
    },
    [
      "id",
      "name",
      "destination",
      "events",
      "include_code",
      "enabled",
      "created_at",
      "updated_at",
    ],
    false,
  ),
  WebhookDelivery: obj(
    {
      id: hash,
      webhook_id: id,
      event: webhookEvents,
      status: deliveryStates,
      attempts: n(0, 8),
      next_attempt: n(),
      lease_until: n(),
      http_status: n(0, 599),
      error: s(),
      ...timestamps,
    },
    [
      "id",
      "webhook_id",
      "event",
      "status",
      "attempts",
      "next_attempt",
      "http_status",
    ],
    false,
  ),
  WebhookEvent: obj(
    {
      id: s(),
      event: webhookEvents,
      created_at: date,
      data: obj(
        {
          mail_id: { type: ["string", "number"] },
          account_id: { type: ["string", "number"] },
          recipient: s(500),
          sender: s(500),
          received_at: s(500),
          error_code: s(500),
          job_id: s(500),
          source_id: s(500),
          target_id: s(500),
          subject: {
            ...s(500),
            description: "仅 include_code=true 且事件包含该字段时。",
          },
          code: {
            ...s(32),
            description: "仅 include_code=true 且事件包含该字段时。",
          },
          link: {
            ...s(2000),
            description:
              "仅 include_code=true 且事件包含该字段时；接收方不得自动打开。",
          },
        },
        [],
        false,
      ),
    },
    ["id", "event", "created_at", "data"],
    false,
  ),
  BackupManifest: backupManifest(11, backupTables),
  BackupDocument: backupDocument("BackupManifest", backupTables),
  LegacyBackupManifest: backupManifest(10, legacyBackupTables),
  LegacyBackupDocument: {
    ...backupDocument("LegacyBackupManifest", legacyBackupTables),
    description:
      "仅兼容已发布的 schema 10：先严格校验原始 schema hash、字段及内容，再在内存中补出 platforms 并转为 schema 11。明文仅限脱敏预览。",
  },
  EncryptedBackup: obj(
    {
      format: { type: "string", const: "mailhub-backup-encrypted" },
      version: { type: "integer", const: 1 },
      encryption: obj(
        {
          algorithm: { type: "string", const: "AES-256-GCM" },
          kdf: { type: "string", const: "PBKDF2-SHA256" },
          iterations: { type: "integer", const: 100000 },
          salt: { ...s(24), contentEncoding: "base64" },
          iv: { ...s(16), contentEncoding: "base64" },
        },
        ["algorithm", "kdf", "iterations", "salt", "iv"],
        false,
      ),
      ciphertext: {
        ...s(1398124),
        contentEncoding: "base64",
        description:
          "原样使用 export 返回的完整密文；包含 GCM 认证标签。不可手工构造或修改。",
      },
    },
    ["format", "version", "encryption", "ciphertext"],
    false,
  ),
  BackupCapabilities: obj(
    {
      format: { type: "string", const: "mailhub-backup" },
      version: { type: "integer", const: 1 },
      schema_version: { type: "integer", const: 11 },
      name: { type: "string", const: "便携业务备份" },
      limits: obj(
        {
          max_plaintext_bytes: { type: "integer", const: 1048576 },
          max_rows: { type: "integer", const: 1000 },
        },
        ["max_plaintext_bytes", "max_rows"],
      ),
      tables: arr(strEnum(...backupTables)),
      schema: obj(
        Object.fromEntries(
          backupTables.map((table) => [
            table,
            obj({ key: arr(s()), fields: arr(s()) }, ["key", "fields"]),
          ]),
        ),
      ),
      schema_hash: hash,
      excluded: arr(s()),
      external_dependencies: arr(s()),
      restore_available: bool,
      full_export: obj(
        {
          confirmation: { type: "string", const: "EXPORT_CREDENTIALS" },
          min_passphrase_length: { type: "integer", const: 12 },
          algorithm: { type: "string", const: "AES-256-GCM" },
          kdf: { type: "string", const: "PBKDF2-SHA256" },
          iterations: { type: "integer", const: 100000 },
        },
        [
          "confirmation",
          "min_passphrase_length",
          "algorithm",
          "kdf",
          "iterations",
        ],
      ),
    },
    [
      "format",
      "version",
      "schema_version",
      "name",
      "limits",
      "tables",
      "schema",
      "schema_hash",
      "excluded",
      "external_dependencies",
      "restore_available",
      "full_export",
    ],
  ),
  BackupPreview: obj(
    {
      valid: { type: "boolean", const: true },
      restorable: bool,
      table_counts: backupCounts,
      backup_hash: hash,
      writes_performed: { type: "boolean", const: false },
      external_dependencies: arr(s()),
      confirmation_token: s(4096),
      expires_at: isoTime,
    },
    [
      "valid",
      "restorable",
      "table_counts",
      "backup_hash",
      "writes_performed",
      "external_dependencies",
    ],
  ),
  BackupRestoreResult: obj(
    { active: dataset, previous: dataset, restored_rows: n(0, 1000) },
    ["active", "previous", "restored_rows"],
  ),
};

const q = (
  name: string,
  schema: Schema = s(),
  description = name,
  example?: unknown,
): ApiParameter => ({
  name,
  in: "query",
  schema,
  description,
  ...(example === undefined ? {} : { example }),
});
const pages = [
  q("page", { ...n(1, 100000), default: 1 }, "页码，从 1 开始"),
  q("limit", { ...n(1, 100), default: 30 }, "每页条数"),
];
const filters = [
  q("q", s(200), "搜索关键词"),
  q(
    "mailbox",
    address,
    "精确匹配账号邮箱，不区分大小写；用于邮件阅读器关联账号分页",
  ),
  q("platform", s(100), "精确平台名，不区分大小写"),
  q("category", s(100), "分类"),
  q("status", statuses, "手动登记状态"),
  q("email_source", sources, "邮箱来源"),
  q("domain", s(253), "收件域名"),
  q("has_code", strEnum("true", "false"), "仅含历史验证码"),
  q(
    "triage",
    strEnum("attention", "unchecked", "connected"),
    "需处理 / 待检查 / 已连接",
  ),
];
const codeParams = Object.entries(codeFilters).map(([key, value]) =>
  q(
    key,
    value,
    key === "since"
      ? "操作开始时刻（含时区）"
      : key === "sender"
        ? "发件人包含文本"
        : "邮件关键词",
  ),
);
export const operations: ApiOperation[] = [];
// Public documentation stays independent of Worker code. Contract tests exercise these grants
// against the real security middleware so policy changes cannot silently broaden the catalog.
function grantsFor(method: ApiOperation["method"], path: string): ApiGrant[] {
  const read = method === "get";
  if (path === "/api/capabilities") return [];
  if (path.startsWith("/api/automation/") || path.endsWith("/code"))
    return ["verify:read"];
  if (path === "/api/external/register")
    return ["mailbox:write", "vault:write"];
  if (/^\/api\/vault(?:\/|$)/.test(path))
    return [read ? "vault:read" : "vault:write"];
  if (/^\/api\/mailbox(?:es)?(?:\/|$)/.test(path))
    return [read ? "verify:read" : "mailbox:write"];
  if (path.startsWith("/api/cf-mails"))
    return [read ? "admin" : "mailbox:write"];
  if (/^\/api\/outlook\/accounts\/\{id\}(?:\/|$)/.test(path))
    return [
      read || path.endsWith("/send") || path.endsWith("/reply")
        ? "admin"
        : "mailbox:write",
    ];
  return ["admin"];
}
const idempotencyParameter: ApiParameter = {
  name: "Idempotency-Key",
  in: "header",
  description:
    "可选持久化去重键，作用域为已认证身份 + 方法 + 路径。重试须保持原始正文、查询串及 Content-Type 完全一致；409 IDEMPOTENCY_UNKNOWN 时先核对资源，绝不更换键自动重执。不要对轮询重复使用同一个键。",
  schema: {
    ...s(128),
    minLength: 1,
    pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$",
  },
};
function op(
  method: ApiOperation["method"],
  path: string,
  operationId: string,
  summary: string,
  tag: string,
  options: Partial<
    Omit<ApiOperation, "method" | "path" | "operationId" | "summary" | "tag">
  > = {},
) {
  const auth = options.auth ?? "admin";
  const canDeduplicate = method !== "get" && auth !== "public";
  const pathParams: ApiParameter[] = [...path.matchAll(/\{(\w+)\}/g)].map(
    (match) => ({
      name: match[1],
      in: "path",
      required: true,
      description:
        match[1] === "id" ? "记录 ID" : `${match[1]}，作为路径段时 URL 编码`,
      schema:
        match[1] === "id"
          ? path.startsWith("/api/api-keys")
            ? uuid
            : path.includes("/deliveries/")
              ? hash
              : path.includes("storage")
                ? s()
                : id
          : s(),
    }),
  );
  operations.push({
    method,
    path,
    operationId,
    summary,
    tag,
    auth,
    grants:
      auth === "public" || auth === "cookie" ? [] : grantsFor(method, path),
    description: summary,
    effects: method === "get" ? "无业务写入" : "修改业务数据",
    response: success(),
    responseStatus: 200,
    ...options,
    parameters: [
      ...pathParams,
      ...(options.parameters || []),
      ...(canDeduplicate &&
      !options.parameters?.some((p) => p.name === "Idempotency-Key")
        ? [idempotencyParameter]
        : []),
    ],
  });
}

op("get", "/healthz", "health", "服务存活检查", "发现", {
  auth: "public",
  response: s(),
  media: "text/plain",
  description: "仅进程健康，不代表数据库、域名路由或微软授权健康。",
});
op("get", "/api/domains", "listEnabledDomains", "可用邮件域名", "发现", {
  auth: "public",
  response: obj({ domains: arr(s()) }, ["domains"]),
});
op(
  "get",
  "/api/capabilities",
  "getCapabilities",
  "自动化能力与调用限制",
  "发现",
  {
    response: success(
      obj({
        version: s(),
        documents: obj({
          openapi: s(),
          markdown: s(),
          llms: s(),
          postman: s(),
        }),
        limits: obj({
          verification_batch: n(),
          verification_concurrency: n(),
          vault_batch: n(),
          poll_interval_seconds: n(),
          poll_deadline_seconds: n(),
        }),
        authentication: obj({
          business: arr(s()),
          infrastructure: s(),
          scoped_keys: bool,
        }),
        workflows: arr(
          obj({ id: s(), operations: arr(s()), description: s() }),
        ),
      }),
    ),
  },
);
op(
  "post",
  "/api/automation/mailbox",
  "inspectMailbox",
  "诊断邮箱接入状态",
  "自动化",
  {
    body: ref("Target"),
    example: { email: "user@outlook.com" },
    response: success(ref("MailboxInspection")),
    effects: "只读；不访问微软",
    description:
      "按 email、vault_id 或唯一 platform 定位。返回已记录的状态，不承诺实时可达；live_check 恒为 false。过期自建邮箱仍可读取历史邮件。",
  },
);
op(
  "post",
  "/api/automation/verification",
  "lookupVerification",
  "统一查收验证码与验证链接",
  "自动化",
  {
    body: ref("VerificationRequest"),
    example: endpointSample,
    response: success(ref("Verification")),
    effects: "Outlook 会刷新并保存令牌及连接状态；不标已读、不打开链接",
    description:
      "CF 与 Outlook 统一返回 data；outcome=found 或 empty。失败返回 HTTP 错误码、error、retryable、retry_after。每轮建议间隔 10 秒、最多 3 分钟；固定 since 避免拿到旧邮件。",
    responseExample: {
      success: true,
      data: {
        email: "user@example.com",
        source: "cf_domain",
        has_mail: true,
        code: "246810",
        link: "",
        scanned: 1,
        message: "已找到最新匹配的验证码或验证链接",
        outcome: "found",
        poll_after_seconds: 10,
        checked_at: "2026-11-15T00:01:00Z",
      },
    },
  },
);
op(
  "post",
  "/api/automation/verification/batch",
  "batchLookupVerification",
  "批量查收，逐项报告结果",
  "自动化",
  {
    body: obj(
      { items: { ...arr(ref("VerificationRequest"), 5), minItems: 1 } },
      ["items"],
    ),
    example: {
      items: [endpointSample, { vault_id: 1, since: endpointSample.since }],
    },
    response: success(ref("BatchVerification")),
    effects: "最多并行 2 个；同一邮箱串行；Outlook 刷新令牌和状态",
    description:
      "每批 1–5 项。HTTP 200 仅表示批次处理完成，必须检查每项 success。index 为原数组的零基下标；失败不会伪装为空邮箱。仅重试 retryable=true 的失败项。",
  },
);
op("get", "/api/external/code", "lookupCodeLegacy", "兼容取码接口", "自动化", {
  auth: "admin",
  parameters: [
    q("email", address, "邮箱地址", "user@example.com"),
    q("platform", s(100), "唯一平台名称，email 优先"),
    ...codeParams,
  ],
  response: { allOf: [ref("Code"), success()] },
  effects: "Outlook 刷新令牌及连接状态",
  description:
    "保留原有平铺响应 success/code/link；新接入推荐 lookupVerification。没有匹配时 code/link 为空。微软失败历史上使用 HTTP 400。",
});
op(
  "post",
  "/api/external/register",
  "registerPlatformMailbox",
  "原子分配邮箱并登记平台",
  "自动化",
  {
    auth: "admin",
    body: obj(
      {
        platform_name: s(100),
        domain: s(253),
        prefix: s(64),
        username: s(254),
        password: s(1000),
        category: s(100),
        remark: s(4000),
      },
      ["platform_name"],
    ),
    example: {
      platform_name: "Example",
      domain: "example.com",
      category: "开发服务",
    },
    response: success(
      obj({ id, email: address, platform_name: s() }, [
        "id",
        "email",
        "platform_name",
      ]),
    ),
    description:
      "先验证全部字段，再一次提交邮箱及账号；绑定邮箱永久保留。可指定 prefix；冲突时不新增任何记录。支持持久化 Idempotency-Key；网络超时后使用相同键及相同请求核对，若结果未知则查询台账，不得换键自动重执。需要 mailbox:write 和 vault:write 两项权限。",
  },
);
op(
  "get",
  "/api/platforms",
  "listPlatformDefinitions",
  "查看独立平台目录",
  "平台管理",
  {
    response: obj(
      {
        success: { type: "boolean", const: true },
        data: arr(ref("PlatformDefinition")),
        total: n(),
      },
      ["success", "data", "total"],
    ),
    description:
      "返回含空平台的完整目录及账号数量。managed=false 表示从旧账号名推导、尚未接管的记录；可通过编辑保存。需要 admin grant 或管理员会话，不接受附带邮箱/平台资源限制的 Key。",
  },
);
op(
  "post",
  "/api/platforms",
  "createPlatformDefinition",
  "创建平台，可暂不添加账号",
  "平台管理",
  {
    body: ref("PlatformInput"),
    example: {
      name: "Example",
      url: "https://example.com/",
      category: "开发服务",
      remark: "平台级说明",
      is_pinned: true,
    },
    response: success(ref("PlatformDefinition")),
    description:
      "创建独立平台目录，不分配邮箱。名称去除两端空格后不区分大小写；已有目录或旧账号使用相同名称时 409 CONFLICT。仅 admin grant 或管理员会话，资源受限 Key 不可用。",
  },
);
op(
  "put",
  "/api/platforms/{name}",
  "updatePlatformDefinition",
  "编辑或重命名平台",
  "平台管理",
  {
    body: obj(platformInput),
    example: {
      name: "Example renamed",
      url: "https://example.com/",
      category: "开发服务",
      remark: "已更新的平台说明",
      is_pinned: false,
    },
    response: success(ref("PlatformDefinition")),
    effects: "保存完整平台定义；重命名原子更新全部关联账号与邮箱的平台名称。",
    description:
      "name 路径段须 URL 编码。正文 name 省略时沿用路径名称；其余省略字段恢复默认值（url/remark 为空、category=其他、is_pinned=false），请提交希望保留的完整元数据。撞名返回 409 CONFLICT，须由使用者选择显式 merge；不隐式合并。仅 admin grant 或管理员会话，资源受限 Key 不可用。",
  },
);
op(
  "post",
  "/api/platforms/{name}/merge",
  "mergePlatformDefinitions",
  "将平台合并到已有目标",
  "平台管理",
  {
    body: obj({ target: { ...s(100), minLength: 1 } }, ["target"]),
    example: { target: "Example" },
    response: success(ref("PlatformDefinition")),
    effects:
      "源平台全部账号及邮箱关联移至目标；移除源目录，保留目标元数据及所有账号。",
    description:
      "目标必须已存在（目录或旧账号可推导平台），否则 404；源与目标同名（不区分大小写）返回 400。逻辑重复账号也全部保留，不覆盖密码或删除账号。仅 admin grant 或管理员会话，资源受限 Key 不可用。",
  },
);
op(
  "delete",
  "/api/platforms/{name}",
  "deletePlatformDefinition",
  "删除没有账号的平台",
  "平台管理",
  {
    description:
      "平台仍被账号引用时原子拒绝并返回 409 REFERENCE_EXISTS，请先迁移账号或明确合并到其他平台。仅 admin grant 或管理员会话，资源受限 Key 不可用。",
  },
);
op("get", "/api/vault", "listVaultAccounts", "分页筛选平台账号", "平台账号", {
  parameters: [...pages, ...filters],
  response: paged(ref("VaultSummary")),
  description:
    "隐藏 password/totp_secret，以 has_password/has_totp（0/1）表示是否配置。mailbox 查询参数精确匹配邮箱且不区分大小写；响应 mailbox 对象是记录的邮箱状态，status 仅是手工登记状态，勿将 active 解释为授权正常。",
});
op("post", "/api/vault", "createVaultAccount", "登记平台账号", "平台账号", {
  conditionalGrants: [
    {
      condition: "generate_email=true 或未提供非空 account_email 时",
      grants: ["mailbox:write"],
    },
  ],
  body: obj({ ...vaultInput, generate_email: bool, domain: s(253) }, [
    "platform_name",
  ]),
  example: {
    platform_name: "Example",
    account_email: "user@example.com",
    email_source: "cf_domain",
  },
  response: success(
    obj({ id, account_email: address }, ["id", "account_email"]),
  ),
  description:
    "generate_email=true 或省略 account_email 会分配永久邮箱；自动分配及登记原子提交。现有 CF 邮箱会被关联保护。",
});
op(
  "post",
  "/api/vault/batch",
  "batchUpdateVaultAccounts",
  "批量整理平台账号",
  "平台账号",
  {
    body: obj({ ids: batchIds, patch: ref("VaultPatch") }, ["ids", "patch"]),
    example: { ids: [1, 2], patch: { category: "开发服务", is_pinned: true } },
    response: success(obj({ ids: arr(id), changed: n() }, ["ids", "changed"])),
    description:
      "每批最多 100 项，ID 自动去重；任一账号不存在则整批 409，零修改。只设置明确字段，重复提交不会反向切换置顶。不能批量改邮箱或密码。",
  },
);
op(
  "get",
  "/api/vault/platforms",
  "listPlatforms",
  "按平台汇总账号和待处理数",
  "平台账号",
  {
    parameters: [
      ...pages.map((p) =>
        p.name === "limit" ? { ...p, schema: { ...p.schema, default: 24 } } : p,
      ),
      ...filters,
      q("sort", strEnum("name", "count", "attention", "pinned"), "排序"),
    ],
    response: obj(
      {
        success: { type: "boolean", const: true },
        data: arr(ref("Platform")),
        total: n(),
        page: n(1),
        limit: n(1, 100),
        summary: obj({
          accounts: n(),
          platforms: n(),
          attention: n(),
          unchecked: n(),
        }),
      },
      ["success", "data", "total", "summary"],
    ),
    description:
      "只有传 page 或 limit 时分页；未传则返回全部分组。统计基于当前筛选；没有邮箱/来源/状态/域名/triage/验证码等账号条件时包含匹配的空平台。definition 为可选平台目录元数据；count 是当前筛选账号数，definition.account_count 为平台全部账号数。",
  },
);
op("get", "/api/vault/stats", "getVaultStats", "工作区业务统计", "平台账号", {
  description:
    "total_platforms 包括独立目录中的空平台及由旧账号名推导的平台；账号统计不把空平台当作账号。",
  response: success(
    obj({
      total_vault_accounts: n(),
      active_vault_accounts: n(),
      total_platforms: n(),
      attention_accounts: n(),
      unchecked_accounts: n(),
      total_cf_mails: n(),
      total_outlook_accounts: n(),
      categories: arr(obj({ category: s(), count: n() })),
    }),
  ),
});
op(
  "get",
  "/api/vault/{id}",
  "getVaultAccount",
  "读取完整平台账号",
  "平台账号",
  {
    response: success(ref("Vault")),
    credentials: true,
    description:
      "包括 password 与 totp_secret。自动化发现账号请优先使用分页列表。",
  },
);
op("put", "/api/vault/{id}", "updateVaultAccount", "编辑平台账号", "平台账号", {
  body: obj(vaultInput),
  example: { remark: "由自动化更新" },
  description: "沿用现有行为，未提供字段保留原值。更新 CF 关联邮箱保护状态。",
});
op(
  "delete",
  "/api/vault/{id}",
  "deleteVaultAccount",
  "删除平台台账记录",
  "平台账号",
  { description: "删除登记记录并调整邮箱关联；不会删除 Outlook 池账号。" },
);
op(
  "post",
  "/api/vault/{id}/pin",
  "toggleVaultPin",
  "切换账号置顶",
  "平台账号",
  {
    description:
      "每次调用反转状态；重试可能再次反转。自动化推荐 batchUpdateVaultAccounts 设置 is_pinned。",
  },
);
op(
  "get",
  "/api/vault/{id}/code",
  "lookupVaultCode",
  "查收台账账号验证码",
  "平台账号",
  {
    parameters: codeParams,
    response: success(ref("Code")),
    effects: "保存最近验证码；Outlook 刷新令牌及状态",
  },
);
op("get", "/api/vault/export", "exportVault", "导出完整平台台账", "平台账号", {
  parameters: [
    q(
      "ids",
      { ...s(1700), pattern: "^[1-9][0-9]*(,[1-9][0-9]*){0,99}$" },
      "可选，逗号分隔的 1–100 个账号 ID；与筛选条件取交集",
      "1,2",
    ),
    ...filters,
  ],
  response: obj(
    { version: n(), exported_at: date, accounts: arr(ref("Vault")) },
    ["version", "exported_at", "accounts"],
  ),
  credentials: true,
  description:
    "支持全部、当前筛选或明确 ID 导出，上限一万条，包含密码及 TOTP。提供 ids 时任一所选账号不存在或不符合筛选则返回 409。响应始终为 version/exported_at/accounts JSON；文本/CSV 转换在客户端完成，不支持 format 查询参数。",
});
op(
  "post",
  "/api/vault/import-preview",
  "previewVaultImport",
  "脱敏预览平台账号文本导入",
  "平台账号",
  {
    body: obj({ raw_text: vaultRawText, platform_name: s(100) }, ["raw_text"]),
    example: vaultTextExample,
    response: ref("VaultImportPreview"),
    effects: "只读解析，不写账号或平台；认证、审计及可选幂等记录仍会更新。",
    description:
      "最多 200 条/1 MiB。返回原始物理行号、平台/邮箱/用户名和格式错误，不返回密码、TOTP 或原始行。valid_count 为文件内去重后的有效条数，duplicate_count/rows[].duplicate 仅表示文件内重复，不检查库中已有账号。platform_name 用于补全缺失的平台名。",
  },
);
op("post", "/api/vault/import", "importVault", "导入平台台账", "平台账号", {
  body: ref("VaultImport"),
  example: {
    accounts: [
      {
        platform_name: "Example",
        account_email: "user@example.com",
        email_source: "cf_domain",
      },
    ],
  },
  response: ref("VaultImportResult"),
  description:
    "accounts[] 与 raw_text 必须只提供一种；raw_text 可同时提供默认 platform_name。每批 1–200 条，文本最多 1 MiB；任意行无效时整批不写入。按不区分大小写的平台名、规范化邮箱及原样用户名识别重复，文件内同身份最后一条生效。duplicate_mode 默认 skip；显式 update 会使用导入记录完整更新已有账号，未提供的可选字段使用默认值。返回 created/updated/skipped 与文件内 duplicate_count；CF 地址自动保护。",
});

op(
  "get",
  "/api/mailboxes",
  "listMailboxes",
  "分页查询邮箱与使用情况",
  "自建邮箱",
  {
    parameters: [
      ...pages,
      q("q", s(200), "地址、用途或平台"),
      q("status", strEnum("all", "active", "permanent", "expired"), "保留状态"),
      q("domain", s(253), "域名"),
    ],
    response: paged(ref("Mailbox")),
  },
);
op(
  "post",
  "/api/mailboxes/generate",
  "generateMailbox",
  "分配单个邮箱",
  "自建邮箱",
  {
    body: obj({
      domain: s(253),
      prefix: s(64),
      duration_minutes: { ...n(-1, 525600), default: 60 },
      is_permanent: bool,
      remark: s(1000),
    }),
    example: {
      domain: "example.com",
      duration_minutes: 60,
      remark: "开发测试",
    },
    response: success(ref("Mailbox")),
    description:
      "duration_minutes=0 或 -1、或 is_permanent=true 表示永久；否则 1–525600 分钟。",
  },
);
op(
  "post",
  "/api/mailboxes/batch-preview",
  "previewMailboxBatch",
  "预览跨域名批量邮箱",
  "自建邮箱",
  {
    body: obj(
      {
        domains: { ...arr(s(253), 20), minItems: 1 },
        count: { ...n(1, 100), default: 10 },
        prefix: s(40),
        duration_minutes: n(1, 525600),
        is_permanent: bool,
        remark: s(500),
      },
      ["domains"],
    ),
    example: {
      domains: ["example.com", "mail.example.com"],
      count: 10,
      prefix: "signup",
      duration_minutes: 60,
    },
    response: success(arr(ref("MailboxPlan"), 100)),
    effects: "只读预览，不保留地址",
    description:
      "按域名轮流分配，每批最多 100。返回计划应原样传给 createMailboxBatch。预览不预占地址。",
  },
);
op(
  "post",
  "/api/mailboxes/batch",
  "createMailboxBatch",
  "原子创建邮箱预览计划",
  "自建邮箱",
  {
    body: obj({ mailboxes: { ...arr(ref("MailboxPlan"), 100), minItems: 1 } }, [
      "mailboxes",
    ]),
    example: {
      mailboxes: [
        {
          domain: "example.com",
          prefix: "signup-01-a1b2c3d4",
          duration_minutes: 60,
          is_permanent: false,
          remark: "开发测试",
        },
      ],
    },
    response: success(arr(ref("Mailbox"))),
    description:
      "任一地址冲突整批失败；超时后按地址查询再决定是否重试，不能直接重新生成预览。",
  },
);
op("get", "/api/mailboxes/{id}", "getMailbox", "读取邮箱保留配置", "自建邮箱", {
  response: success(ref("Mailbox")),
});
op(
  "patch",
  "/api/mailboxes/{id}",
  "updateMailboxRemark",
  "更新邮箱用途",
  "自建邮箱",
  { body: obj({ remark: s(500) }), example: { remark: "自动化任务 A" } },
);
op(
  "get",
  "/api/mailboxes/{id}/code",
  "lookupMailboxCode",
  "查收自建邮箱验证码",
  "自建邮箱",
  { parameters: codeParams, response: success(ref("Code")) },
);
op(
  "post",
  "/api/mailboxes/{id}/extend",
  "extendMailbox",
  "延长邮箱有效期",
  "自建邮箱",
  {
    body: obj({ minutes: { ...n(1, 525600), default: 60 } }),
    example: { minutes: 60 },
    response: obj(
      {
        success: { type: "boolean", const: true },
        message: s(),
        expires_at: date,
      },
      ["success", "expires_at"],
    ),
    description:
      "从当前有效期与当前时间较晚者延长；重复请求会重复加时。永久邮箱返回 400。",
  },
);
op(
  "post",
  "/api/mailboxes/{id}/toggle-permanent",
  "toggleMailboxPermanent",
  "切换永久保留",
  "自建邮箱",
  {
    description: "绑定台账的邮箱不可取消永久保护；每次调用反转，不可盲目重试。",
  },
);
op(
  "post",
  "/api/mailboxes/{id}/link-vault",
  "linkMailboxVault",
  "关联匹配的平台账号",
  "自建邮箱",
  {
    body: obj({ vault_id: id }, ["vault_id"]),
    example: { vault_id: 1 },
    description: "台账必须已经使用同一 CF 地址；关联后永久保护。",
  },
);
op(
  "delete",
  "/api/mailboxes/{id}",
  "disableMailbox",
  "停用邮箱并清理未置顶邮件",
  "自建邮箱",
  { description: "保留过期地址记录以拒收后续投递；绑定台账时禁止操作。" },
);

op("get", "/api/cf-mails", "listDomainMail", "分页搜索域名邮件", "域名邮件", {
  parameters: [
    ...pages,
    q("recipient", address, "收件地址"),
    q("domain", s(253), "收件域名"),
    q("q", s(200), "主题、发件人、正文、验证码"),
    q("since", codeFilters.since, "只返回指定时间之后的邮件"),
    q("unread", strEnum("true", "false"), "仅未读"),
    q("verification", strEnum("true", "false"), "仅已识别验证内容"),
    q("folder", strEnum("all", "inbox", "archived"), "默认 all"),
    q("category", categories, "邮件分类"),
  ],
  response: paged(ref("MailSummary")),
});
op("get", "/api/cf-mails/{id}", "getDomainMail", "读取邮件正文", "域名邮件", {
  parameters: [
    q(
      "mark_read",
      { ...strEnum("true", "false"), default: "true" },
      "false 时只读，不修改已读状态",
      "false",
    ),
  ],
  response: success(ref("Mail")),
  effects: "默认标为已读；mark_read=false 不写入",
  description:
    "保持旧默认行为；AI 摘要/数据同步建议显式 mark_read=false。HTML 为不可信邮件内容，须隔离渲染。",
});
op(
  "get",
  "/api/cf-mails/{id}/raw",
  "downloadDomainMailRaw",
  "下载 CF 原始邮件",
  "域名邮件",
  {
    media: "application/octet-stream",
    response: { type: "string", format: "binary" },
    description:
      "下载原始 .eml 文件，强制附件下载、nosniff、no-store，不标记已读。需配置 MAIL_OBJECTS 且该邮件已保存原文；历史邮件或未配置时 404 MAIL_OBJECT_UNAVAILABLE，存在引用但对象丢失时 503 MAIL_OBJECT_MISSING。",
  },
);
op(
  "get",
  "/api/cf-mails/{id}/attachments/{attachment}",
  "downloadDomainMailAttachment",
  "下载 CF 邮件附件",
  "域名邮件",
  {
    media: "application/octet-stream",
    response: { type: "string", format: "binary" },
    description:
      "attachment 使用邮件详情 attachments[].id（零基序号字符串）。从 R2 原始邮件解析附件，强制二进制附件下载，不标记已读。没有原文/附件返回 404；对象引用丢失返回 503。不要把附件作为可信 HTML 执行。",
  },
);
op(
  "patch",
  "/api/cf-mails/{id}",
  "updateDomainMail",
  "整理邮件状态或分类",
  "域名邮件",
  { body: ref("MailPatch"), example: { is_read: true, is_archived: true } },
);
op("delete", "/api/cf-mails/{id}", "deleteDomainMail", "删除邮件", "域名邮件", {
  description: "删除本系统保存的邮件记录；不可恢复。",
});
op(
  "post",
  "/api/cf-mails/batch",
  "batchUpdateMail",
  "批量整理邮件",
  "域名邮件",
  {
    body: obj({ ids: batchIds, patch: ref("MailPatch") }, ["ids", "patch"]),
    example: { ids: [1, 2], patch: { is_archived: true } },
    response: success(obj({ changed: n() }, ["changed"])),
    description:
      "每批最多 100 个 ID；不存在的 ID 跳过，changed 返回实际匹配数；不删除邮件。",
  },
);
op(
  "get",
  "/api/cf-mails/recipients",
  "listMailRecipients",
  "按收件人聚合邮件",
  "域名邮件",
  {
    parameters: [q("q", s(200), "地址搜索"), q("domain", s(253), "域名")],
    response: success(
      arr(
        obj({
          recipient: address,
          mail_count: n(),
          unread_count: n(),
          is_protected: flag,
          last_received_at: date,
        }),
      ),
    ),
    description:
      "最多 300 个收件人，按未读数与最近来信排序；不是分页全量导出。",
  },
);
op(
  "post",
  "/api/cf-mails/clean",
  "cleanExpiredMail",
  "清理到期临时邮件",
  "域名邮件",
  {
    description:
      "保护置顶、永久邮箱及 CF 台账绑定地址，清理符合保留策略的邮件。",
  },
);
op("get", "/api/mail-rules", "listMailRules", "读取收件规则", "规则", {
  response: success(arr(ref("Rule"))),
  description:
    "最多 50 条，按 priority、id 升序；只执行首条启用且匹配全部条件的规则。",
});
op("post", "/api/mail-rules", "createMailRule", "新增收件规则", "规则", {
  body: ref("RuleInput"),
  example: {
    name: "简报归档",
    sender_contains: "newsletter@",
    archive: true,
    action_category: "newsletter",
  },
  response: success(ref("Rule")),
});
op(
  "put",
  "/api/mail-rules/{id}",
  "updateMailRule",
  "完整编辑收件规则",
  "规则",
  {
    body: ref("RuleInput"),
    example: {
      name: "简报归档",
      sender_contains: "newsletter@",
      archive: true,
      enabled: true,
    },
    response: success(ref("Rule")),
    description: "完整替换规则字段；未传字段恢复默认。",
  },
);
op("delete", "/api/mail-rules/{id}", "deleteMailRule", "删除收件规则", "规则", {
  description: "历史邮件已执行的动作保持不变。",
});
op(
  "post",
  "/api/mail-rules/preview",
  "previewDraftRule",
  "预览草稿规则",
  "规则",
  {
    body: ref("RuleInput"),
    example: {
      name: "简报归档",
      sender_contains: "newsletter@",
      archive: true,
    },
    response: success(ref("RulePreview")),
    effects: "只读预览",
  },
);
op(
  "post",
  "/api/mail-rules/{id}/preview",
  "previewSavedRule",
  "预览已保存规则",
  "规则",
  {
    response: success(ref("RulePreview")),
    effects: "只读预览",
    description: "最多最新 100 封，返回 total、limited、revision。",
  },
);
op(
  "post",
  "/api/mail-rules/{id}/apply",
  "applyMailRule",
  "应用已预览的规则",
  "规则",
  {
    body: obj({ ids: batchIds, revision: s(64) }, ["ids", "revision"]),
    example: { ids: [1], revision: "REPLACE_WITH_PREVIEW_REVISION" },
    response: success(obj({ changed: n() }, ["changed"])),
    description:
      "仅处理 ids 中仍匹配的邮件；规则内容变更返回 409，必须重新预览。",
  },
);

op(
  "get",
  "/api/outlook/accounts",
  "listOutlookAccounts",
  "分页查询 Outlook 池",
  "Outlook",
  {
    parameters: [
      ...pages,
      q("q", s(200), "邮箱、备注、分组或平台"),
      q("group_id", n(1, 1000000), "分组 ID"),
      q("tag_id", n(1, 1000000), "标签 ID"),
      q("status", strEnum("active", "disabled"), "管理状态"),
      q(
        "auth_status",
        strEnum("unchecked", "healthy", "reauth_required", "error"),
        "上次收件检查状态",
      ),
    ],
    response: paged(ref("OutlookSummary")),
    description:
      "列表不含密码/Refresh Token。检查续期时还需 token_refresh_status，不能只看 active。",
  },
);
op(
  "post",
  "/api/outlook/accounts",
  "saveOutlookAccount",
  "保存 Outlook 凭据",
  "Outlook",
  {
    body: ref("OutlookInput"),
    example: {
      email: "user@outlook.com",
      client_id: "11111111-2222-4333-8444-555555555555",
      refresh_token: "REPLACE_WITH_REFRESH_TOKEN",
      group_id: 1,
    },
    response: success(obj({ id, email: address })),
    description:
      "同邮箱更新；Client ID 须属于该 Refresh Token。保存后需要检查连接。",
  },
);
op(
  "get",
  "/api/outlook/accounts/{id}",
  "getOutlookAccount",
  "读取完整 Outlook 配置",
  "Outlook",
  { response: success(ref("Outlook")), credentials: true },
);
op(
  "put",
  "/api/outlook/accounts/{id}",
  "updateOutlookAccount",
  "编辑 Outlook 配置",
  "Outlook",
  {
    body: obj(outlookInput),
    example: { remark: "自动化任务专用" },
    description:
      "邮箱不可修改；省略字段保留原值。更新授权凭据会重置检查和续期状态。",
  },
);
op(
  "delete",
  "/api/outlook/accounts/{id}",
  "deleteOutlookAccount",
  "删除托管 Outlook 配置",
  "Outlook",
  { description: "保留平台台账和真实微软邮箱，台账随后显示邮箱未接入。" },
);
op(
  "get",
  "/api/outlook/accounts/export",
  "exportOutlookAccounts",
  "按范围导出 Outlook 凭据",
  "Outlook",
  {
    parameters: [
      q(
        "ids",
        { ...s(1700), pattern: "^[1-9][0-9]*(,[1-9][0-9]*){0,99}$" },
        "可选，1–100 个逗号分隔 ID；省略时导出全部或当前筛选",
        "1,2",
      ),
      q("q", s(200), "邮箱、备注、分组或平台"),
      q("group_id", n(1, 1000000), "分组 ID"),
      q("tag_id", n(1, 1000000), "标签 ID"),
      q("status", strEnum("active", "disabled"), "管理状态"),
      q(
        "auth_status",
        strEnum("unchecked", "healthy", "reauth_required", "error"),
        "上次收件检查状态",
      ),
    ],
    response: obj(
      { version: n(), exported_at: date, accounts: arr(obj(outlookInput)) },
      ["version", "exported_at", "accounts"],
    ),
    credentials: true,
    description:
      "ids 省略时按列表筛选条件导出，最多一万条；提供 ids 时保持 1–100 条的所选导出规则。响应始终为 version/exported_at/accounts JSON，包含密码、client_id 与 refresh_token。客户端可转为固定四段文本或 CSV，无 format 查询参数。",
  },
);
op(
  "post",
  "/api/outlook/parse-preview",
  "previewOutlookImport",
  "脱敏预览 Outlook 导入",
  "Outlook",
  {
    body: obj({ raw_text: s(1048576) }, ["raw_text"]),
    example: {
      raw_text:
        "user@outlook.com----password----11111111-2222-4333-8444-555555555555----REPLACE_WITH_REFRESH_TOKEN",
    },
    response: obj(
      {
        success: { type: "boolean", const: true },
        total: n(),
        valid_count: n(),
        error_count: n(),
        duplicate_count: n(),
        rows: arr(
          obj({
            line: n(),
            email: s(),
            client_id: s(),
            error: s(),
            warning: s(),
          }),
        ),
      },
      ["success"],
    ),
    effects: "只读；隐藏密码及令牌",
  },
);
op(
  "post",
  "/api/outlook/batch-import",
  "importOutlookAccounts",
  "批量导入 Outlook",
  "Outlook",
  {
    body: {
      ...obj({
        raw_text: s(1048576),
        accounts: arr(ref("OutlookInput"), 200),
        group_id: n(1, 1000000),
        duplicate_mode: strEnum("skip", "update"),
        sync_to_vault: bool,
      }),
      oneOf: [
        obj({ raw_text: s(1048576), accounts: { not: {} } }, ["raw_text"]),
        obj(
          { accounts: arr(ref("OutlookInput"), 200), raw_text: { not: {} } },
          ["accounts"],
        ),
      ],
    },
    example: {
      raw_text:
        "user@outlook.com----password----11111111-2222-4333-8444-555555555555----REPLACE_WITH_REFRESH_TOKEN",
      duplicate_mode: "skip",
      sync_to_vault: true,
    },
    response: obj(
      {
        success: { type: "boolean", const: true },
        created: n(),
        updated: n(),
        count: n(),
        skipped: n(),
        duplicate_count: n(),
        invalid_count: n(),
        errors: arr(obj({ line: n(), error: s() })),
        message: s(),
      },
      ["success", "created", "updated", "skipped", "invalid_count"],
    ),
    description:
      "四段文本、CSV、JSON、逐行 JSON；每批 200 条/1 MiB。默认 skip，sync_to_vault 默认 true。逐批提交，可能部分成功；失败后先核对并以 skip 重试。",
  },
);
op(
  "post",
  "/api/outlook/accounts/batch",
  "batchOutlookAccounts",
  "批量操作 Outlook",
  "Outlook",
  {
    body: obj(
      {
        action: strEnum(
          "check",
          "move",
          "tag",
          "untag",
          "enable",
          "disable",
          "delete",
        ),
        ids: { ...arr(id, 50), minItems: 1 },
        group_id: id,
        tag_id: id,
      },
      ["action", "ids"],
    ),
    example: { action: "check", ids: [1] },
    response: obj(
      {
        success: { type: "boolean", const: true },
        message: s(),
        data: arr(obj({ id, success: bool, message: s() })),
      },
      ["success"],
    ),
    description:
      "check 最多 10 个且逐项报告；其他动作最多 50 个。move 需 group_id，tag/untag 需 tag_id。不存在的 ID 跳过。delete 只删除托管配置。",
  },
);
op(
  "post",
  "/api/outlook/accounts/{id}/check",
  "checkOutlookConnection",
  "实际检查微软邮件权限",
  "Outlook",
  {
    effects: "访问微软并保存令牌与健康状态",
    description:
      "读取邮件以验证连接；授权撤销需重新授权，自动续期不能绕过微软撤销。",
  },
);
op(
  "get",
  "/api/outlook/accounts/{id}/code",
  "lookupOutlookCode",
  "查收 Outlook 验证内容",
  "Outlook",
  {
    parameters: codeParams,
    response: success(ref("Code")),
    effects: "刷新令牌及连接状态",
    description:
      "收件箱/垃圾箱先各读取 10 封，必要时扩大到各 25 封；不标记已读。",
  },
);
op(
  "get",
  "/api/outlook/accounts/{id}/emails",
  "listOutlookMail",
  "按文件夹查询 Outlook 邮件",
  "Outlook",
  {
    parameters: [
      q(
        "folder",
        strEnum(
          "inbox",
          "junkemail",
          "deleteditems",
          "sentitems",
          "archive",
          "all",
        ),
        "默认 inbox",
      ),
      q("top", { ...n(1, 50), default: 20 }, "每页数量"),
      q("q", s(200), "关键词"),
      q("cursor", s(16000), "将 next_cursor 原样传回，文件夹保持一致"),
    ],
    response: obj(
      {
        success: { type: "boolean", const: true },
        data: arr(ref("GraphMail")),
        next_cursor: s(),
      },
      ["success", "data", "next_cursor"],
    ),
    effects: "刷新令牌及连接状态；不标已读",
  },
);
op(
  "post",
  "/api/outlook/accounts/{id}/send",
  "sendOutlookMail",
  "发送 Outlook 邮件",
  "Outlook",
  {
    body: ref("OutlookSend"),
    example: {
      to: ["recipient@example.com"],
      subject: "已确认的通知",
      body: "这是一封经使用者确认发送的纯文本邮件。",
    },
    responseStatus: 202,
    response: success(ref("MailAccepted")),
    responseExample: { success: true, data: { accepted: true } },
    effects:
      "向真实收件人发送邮件；刷新令牌；计入账号发送尝试限额。须先取得使用者发信授权。",
    description:
      "需 API admin 权限及微软 Mail.Send；202 仅表示微软受理，不保证投递。to/cc/bcc 合计 ≤100，纯文本正文 ≤100000 字符，附件 ≤10、解码后合计 ≤3 MiB，整包 ≤5 MiB。与 reply 共用每账号 60 秒 10 次/900 秒 60 次固定窗口（首次尝试起算）；校验通过后计数，失败也占用，成功幂等回放不占。超限为 429 SEND_RATE_LIMITED，读取 retry_after/Retry-After。无自动重发；delivery_unknown=true 时先查已发送邮件，PERMISSION_REQUIRED 时重新授权 send_mail=true。",
  },
);
op(
  "post",
  "/api/outlook/accounts/{id}/messages/{messageId}/reply",
  "replyOutlookMail",
  "回复 Outlook 邮件",
  "Outlook",
  {
    body: ref("OutlookReply"),
    example: { body: "已收到，谢谢。" },
    responseStatus: 202,
    response: success(ref("MailAccepted")),
    responseExample: { success: true, data: { accepted: true } },
    effects:
      "回复真实邮件；有附件时先创建回复草稿再发送；刷新令牌并计入与 send 共享的账号限额。",
    description:
      "直接回复原消息，不支持另设收件人或 reply-all。无附件需 Mail.Send；有附件需 Mail.ReadWrite 和 Mail.Send，失败可能返回 draft_id，草稿保留供核对。202 仅表示受理；正文/附件/5 MiB 请求上限与 send 相同。send+reply 每账号共用 60 秒 10 次、900 秒 60 次固定窗口；超限返回 429 SEND_RATE_LIMITED 及 Retry-After。delivery_unknown 时不自动重发或删除草稿。messageId 须 URL 编码。",
  },
);
op(
  "get",
  "/api/outlook/accounts/{id}/messages/{message}",
  "getOutlookMail",
  "读取 Outlook 正文和附件目录",
  "Outlook",
  {
    response: success(ref("GraphMail")),
    effects: "刷新令牌及连接状态；不标已读",
  },
);
op(
  "delete",
  "/api/outlook/accounts/{id}/messages/{message}",
  "deleteOutlookMail",
  "删除真实微软邮件",
  "Outlook",
  { description: "操作真实微软邮箱；已删除文件夹中的删除可能进一步移除邮件。" },
);
op(
  "get",
  "/api/outlook/accounts/{id}/messages/{message}/attachments/{attachment}",
  "downloadOutlookAttachment",
  "下载 Outlook 附件",
  "Outlook",
  {
    media: "application/octet-stream",
    response: { type: "string", format: "binary" },
    effects: "刷新令牌及连接状态",
    description:
      "流式二进制下载；Content-Type 由附件类型决定，正文不是 JSON，附件不写入 D1。",
  },
);
op(
  "get",
  "/api/outlook/renewal",
  "getOutlookRenewal",
  "查询自动续期执行与待处理数",
  "Outlook",
  {
    response: success(
      obj(
        {
          last_run: { type: ["object", "null"], additionalProperties: true },
          due: n(),
          attention: n(),
          active: n(),
        },
        ["last_run", "due", "attention", "active"],
      ),
    ),
  },
);
op(
  "post",
  "/api/outlook/renewal/run",
  "runOutlookRenewal",
  "执行一轮到期账号续期",
  "Outlook",
  {
    description:
      "受设置中的批次数限制，只处理到期账号；完成后读取 getOutlookRenewal 核对结果。",
  },
);
for (const [plural, name] of [
  ["groups", "Group"],
  ["tags", "Tag"],
] as const) {
  const title = plural === "groups" ? "分组" : "标签";
  op(
    "get",
    `/api/outlook/${plural}`,
    `listOutlook${name}s`,
    `读取 Outlook ${title}`,
    "Outlook 分组",
    { response: success(arr(ref("Tag"))) },
  );
  op(
    "post",
    `/api/outlook/${plural}`,
    `createOutlook${name}`,
    `新增${title}`,
    "Outlook 分组",
    {
      body: obj(
        { name: s(40), color: { ...s(7), pattern: "^#[0-9a-fA-F]{6}$" } },
        ["name"],
      ),
      example: { name: "开发", color: "#2563eb" },
      response: success(ref("Tag")),
    },
  );
  op(
    "put",
    `/api/outlook/${plural}/{id}`,
    `updateOutlook${name}`,
    `编辑${title}`,
    "Outlook 分组",
    {
      body: obj({ name: s(40), color: s(7) }, ["name"]),
      example: { name: "生产", color: "#2563eb" },
    },
  );
  op(
    "delete",
    `/api/outlook/${plural}/{id}`,
    `deleteOutlook${name}`,
    `删除${title}`,
    "Outlook 分组",
    {
      description:
        plural === "groups"
          ? "默认分组 1 不可删除；账号移回默认分组。"
          : "删除标签及其关联，账号保留。",
    },
  );
}
op(
  "get",
  "/api/settings/domains",
  "listDomainSettings",
  "查询域名与投递配置",
  "域名设置",
  { response: success(arr(ref("Domain"))) },
);
op(
  "post",
  "/api/settings/domains",
  "addDomain",
  "接入新的邮件域名",
  "域名设置",
  {
    body: obj({ domain: s(253), remark: s(300) }, ["domain"]),
    example: { domain: "mail.example.com", remark: "开发邮箱" },
    response: success(arr(ref("Domain"))),
    description:
      "最多 100 个，规范化大小写和国际化域名；仍需在 Cloudflare 配置 DNS 与 Email Routing。",
  },
);
op(
  "put",
  "/api/settings/domains/{domain}",
  "updateDomain",
  "启停域名、设置默认域名",
  "域名设置",
  {
    body: obj({ enabled: bool, is_default: bool, remark: s(300) }),
    example: { enabled: true, is_default: true },
    response: success(arr(ref("Domain"))),
  },
);
op(
  "post",
  "/api/settings/domains/{domain}/check",
  "checkDomainDns",
  "检查邮件 DNS",
  "域名设置",
  {
    response: success(
      obj({
        domain: s(),
        mx: arr(s()),
        txt: arr(s()),
        mx_ready: bool,
        spf_ready: bool,
        status: strEnum("ready", "incomplete"),
      }),
    ),
    effects: "查询 DNS 并保存诊断状态",
    description: "不会修改 DNS 或 Cloudflare 路由；DNS 正常仍需实际投递验证。",
  },
);
op(
  "get",
  "/api/search",
  "searchWorkspace",
  "跨平台、Outlook 和邮件搜索",
  "发现",
  {
    parameters: [q("q", s(200), "关键词")],
    response: success(
      obj({
        vault: arr(
          obj({
            id,
            platform_name: s(),
            account_email: address,
            username: s(),
            last_code: s(),
          }),
        ),
        mails: arr(obj({ id, subject: s(), recipient: address, sender: s() })),
        outlook: arr(
          obj({ id, email: address, remark: s(), auth_status: s() }),
        ),
      }),
    ),
    description: "分别最多返回 12/8/8 项；完整数据请使用对应分页列表。",
  },
);
op("get", "/api/settings", "getSettings", "读取工作区偏好", "设置", {
  response: success(
    obj({
      default_prefix: s(),
      mail_retention_days: s(),
      token_refresh_batch: s(),
      token_refresh_last_run: s(),
      domains: arr(ref("Domain")),
      env_cf_domains: s(),
      has_api_key: bool,
      oauth_configured: bool,
      oauth_redirect_uri: s(),
    }),
  ),
});
op("put", "/api/settings", "updateSettings", "更新工作区偏好", "设置", {
  body: obj({
    default_prefix: s(30),
    mail_retention_days: n(1, 365),
    token_refresh_batch: n(1, 8),
  }),
  example: {
    default_prefix: "tmp",
    mail_retention_days: 15,
    token_refresh_batch: 5,
  },
  description: "完整更新偏好；省略字段恢复默认（前缀空、15 天、每轮 5）。",
});
op("get", "/api/settings/api-key", "getApiKey", "读取当前主 API Key", "设置", {
  auth: "cookie",
  response: success(obj({ api_key: s() }, ["api_key"])),
  credentials: true,
  description: "当前主密钥具有全部业务管理权限；未配置时返回空字符串。",
});
op(
  "post",
  "/api/settings/password",
  "changeAdminPassword",
  "修改管理员密码",
  "设置",
  {
    auth: "cookie",
    body: obj({ new_password: { ...s(1000), minLength: 10 } }, [
      "new_password",
    ]),
    example: { new_password: "REPLACE_WITH_NEW_PASSWORD" },
    description: "更换密码并使其他 Cookie 会话失效；当前会话重新签发。",
  },
);
op("post", "/api/auth/login", "loginAdmin", "管理员登录", "会话", {
  auth: "public",
  body: obj({ password: s(1000) }, ["password"]),
  example: { password: "REPLACE_WITH_ADMIN_PASSWORD" },
  effects: "签发 HttpOnly 会话 Cookie",
  description:
    "每 IP 15 分钟最多 10 次尝试；成功通过 Set-Cookie 返回会话。脚本推荐使用 API Key。",
});
op("post", "/api/auth/logout", "logoutAdmin", "退出当前会话", "会话", {
  auth: "public",
  effects: "清除请求方会话 Cookie",
});
op("get", "/api/auth/me", "getSession", "查询当前 Cookie 会话", "会话", {
  auth: "public",
  response: obj(
    {
      success: { type: "boolean", const: true },
      authenticated: bool,
      configured: bool,
    },
    ["success", "authenticated", "configured"],
  ),
  description: "只识别 Cookie；API Key 不会使 authenticated 变为 true。",
});
op(
  "post",
  "/api/outlook/oauth/start",
  "startOutlookOAuth",
  "发起微软浏览器授权",
  "会话",
  {
    auth: "cookie",
    body: obj({
      group_id: n(1, 1000000),
      send_mail: { ...bool, default: false },
    }),
    example: { group_id: 1, send_mail: true },
    response: obj({ success: { type: "boolean", const: true }, url: s() }, [
      "success",
      "url",
    ]),
    description:
      "需要有效管理员 Cookie 和自有微软应用；在浏览器打开返回的 url，由用户完成微软授权。默认申请 offline_access/Mail.ReadWrite/User.Read；send_mail=true 额外申请 Mail.Send。旧令牌不会自动获得发信权限，需要重新授权。",
  },
);
op(
  "get",
  "/api/outlook/oauth/callback",
  "finishOutlookOAuth",
  "微软 OAuth 回调",
  "会话",
  {
    auth: "cookie",
    parameters: [
      q("state", s(200), "OAuth state"),
      q("code", s(), "微软授权码"),
      q("error", s(), "微软取消/错误"),
    ],
    response: s(),
    media: "text/html",
    effects: "消费一次性状态并保存授权",
    description: "由微软回调，不要手工调用；需要原始管理员会话 Cookie。",
  },
);

op(
  "get",
  "/api/api-keys",
  "listScopedApiKeys",
  "分页读取 API Key 元数据",
  "权限与审计",
  {
    auth: "cookie",
    parameters: pages,
    response: paged(ref("ApiKeyMetadata")),
    description:
      "仅管理员登录会话；包含已撤销记录，绝不返回完整 key 或哈希。最近使用时间最多每五分钟更新一次。",
  },
);
op(
  "post",
  "/api/api-keys",
  "createScopedApiKey",
  "创建细分权限 API Key",
  "权限与审计",
  {
    auth: "cookie",
    body: ref("ApiKeyInput"),
    example: {
      name: "验证码自动化",
      scopes: ["verify:read"],
      restrictions: { emails: ["user@example.com"] },
    },
    responseStatus: 201,
    credentials: true,
    response: success({
      allOf: [
        ref("ApiKeyMetadata"),
        obj({ key: { ...s(68), pattern: "^mhk_[a-f0-9]{64}$" } }, ["key"]),
      ],
    }),
    description:
      "密钥明文仅在创建响应中提供（有效期内相同幂等请求可回放该响应）；列表仅元数据，数据库仅存哈希。默认 30 天到期、最多 365 天。最多 1000 条记录（含已撤销）。emails/platforms 精确匹配且都设置时须同时满足；不支持通配符。admin scope 仍受资源限制，不能访问会话专属路由。",
  },
);
op(
  "delete",
  "/api/api-keys/{id}",
  "revokeScopedApiKey",
  "撤销 API Key",
  "权限与审计",
  {
    auth: "cookie",
    description:
      "立即失效，记录仍保留供审计；重复撤销已存在记录成功，不存在返回 404。",
  },
);
op("get", "/api/audit", "listAuditLog", "分页查询审计记录", "权限与审计", {
  auth: "cookie",
  parameters: [
    ...pages,
    q("action", s(80), "精确操作名"),
    q(
      "actor_type",
      strEnum("admin_session", "api_key", "master_key", "anonymous", "system"),
    ),
    q("before", isoTime, "不包含此时刻"),
    q("after", isoTime, "包含此时刻"),
  ],
  response: paged(ref("AuditEntry")),
  description:
    "仅返回白名单元数据；不记录密码、令牌和邮件正文。status=0 表示写入前的操作意图，不能据此认定业务成功。",
});
op(
  "delete",
  "/api/audit",
  "purgeAuditLog",
  "分批清理历史审计记录",
  "权限与审计",
  {
    auth: "cookie",
    body: obj({ before: isoTime }, ["before"]),
    example: { before: "2026-01-01T00:00:00Z" },
    response: success(
      obj({ deleted: n(0, 1000), has_more: bool }, ["deleted", "has_more"]),
    ),
    description:
      "before 必须早于当前时间；每次最多清理 1000 条，清理行为自身会被审计。has_more 表示本轮已到上限；下一批是新的显式操作，不能用相同幂等键反复回放同一批结果。",
  },
);
op(
  "get",
  "/api/settings/credentials",
  "getCredentialProtection",
  "查询凭据加密与明文迁移状态",
  "凭据保护",
  {
    auth: "cookie",
    response: success(ref("CredentialStatus")),
    description:
      "enabled 表示当前 CREDENTIAL_ENCRYPTION_KEY（或 STORAGE_ENCRYPTION_KEY 回退）至少 32 字符；不代表所有旧行已经加密。plaintext_records 按记录计数；不会暴露密钥或明文。",
  },
);
op(
  "post",
  "/api/settings/credentials/rekey",
  "rekeyCredentials",
  "分批迁移或轮换凭据加密",
  "凭据保护",
  {
    auth: "cookie",
    body: {
      oneOf: [
        obj(
          {
            table: { type: "string", const: "oauth_sessions" },
            cursor: s(200),
          },
          ["table"],
        ),
        obj(
          {
            table: strEnum("accounts", "platform_vault", "webhooks"),
            cursor: n(0, Number.MAX_SAFE_INTEGER),
          },
          ["table"],
        ),
      ],
    },
    example: { table: "accounts", cursor: 0 },
    response: success(ref("RekeyResult")),
    description:
      "每页最多 50 条；oauth_sessions 使用字符串游标，其他表使用整数，原样续传 data.cursor 直至 complete=true。并发变更的行计入 skipped，应核查后从头重扫。需先配置当前密钥及可选 CREDENTIAL_ENCRYPTION_KEY_PREVIOUS；此 API 不修改环境密钥。跨全部表完成并核实后再移除旧密钥。",
  },
);
op(
  "get",
  "/api/settings/webhooks",
  "listWebhooks",
  "读取事件订阅",
  "事件通知",
  {
    auth: "cookie",
    response: {
      ...success(arr(ref("Webhook"), 50)),
      properties: {
        ...(success(arr(ref("Webhook"), 50)).properties as Record<
          string,
          Schema
        >),
        encryption_ready: bool,
      },
      required: ["success", "data", "encryption_ready"],
    },
    description:
      "最多 50 条；destination 仅为源站，不返回完整路径、查询串或签名密钥。",
  },
);
op(
  "post",
  "/api/settings/webhooks",
  "createWebhook",
  "创建签名事件订阅",
  "事件通知",
  {
    auth: "cookie",
    body: ref("WebhookInput"),
    example: {
      name: "收件通知",
      url: "https://hooks.example.org/mailhub",
      events: ["mail.received", "code.extracted"],
      include_code: false,
    },
    responseStatus: 201,
    credentials: true,
    response: success(obj({ id, secret: hash }, ["id", "secret"])),
    description:
      "需要已配置至少 32 字符的凭据加密密钥；最多 50 条。签名 secret 仅创建时返回（相同有效幂等请求可回放）。include_code 默认 false，通知仅白名单元数据，主题/验证码/链接仅在显式开启后发送。详见开发者指南的原始字节验签和持久化去重示例。",
  },
);
op(
  "patch",
  "/api/settings/webhooks/{id}",
  "setWebhookEnabled",
  "启停事件订阅",
  "事件通知",
  {
    auth: "cookie",
    body: obj({ enabled: { ...bool, default: false } }),
    example: { enabled: false },
    description:
      "仅修改 enabled，省略时为 false；暂停后调度器逐批取消尚未完成的投递，已开始的 HTTP 请求无法撤回。",
  },
);
op(
  "delete",
  "/api/settings/webhooks/{id}",
  "deleteWebhook",
  "删除事件订阅",
  "事件通知",
  {
    auth: "cookie",
    description:
      "删除配置，调度器随后分批取消待投递记录；历史保留，已发出的请求无法撤回。",
  },
);
op(
  "get",
  "/api/settings/webhooks/deliveries",
  "listWebhookDeliveries",
  "分页查询事件投递记录",
  "事件通知",
  {
    auth: "cookie",
    parameters: [
      pages[0],
      q("webhook_id", id, "订阅 ID"),
      q("status", deliveryStates),
    ],
    response: paged(ref("WebhookDelivery")),
    description:
      "固定每页 30 条，不接受自定义 limit；不含 payload 或 lease_token。next_attempt/lease_until 为 Unix 毫秒。自动投递最多 8 次，每轮最多 10 条、并发 2。delivered/dead/cancelled 终态保留 30 天，六小时清理任务每轮最多删除 500 条。",
  },
);
op(
  "post",
  "/api/settings/webhooks/deliveries/{id}/retry",
  "retryWebhookDelivery",
  "手动重排失败事件",
  "事件通知",
  {
    auth: "cookie",
    description:
      "仅 dead/cancelled 且订阅仍启用时允许；重置 attempts=0 并复用 delivery ID。已成功或正在投递时返回 409；接收端必须按 delivery ID 持久化去重。",
  },
);

const backupPassphrase = {
  ...s(1024),
  minLength: 12,
  description:
    "独立备份口令；空格和 Unicode 不会被裁剪或规范化，必须原样保管。",
};
const encryptedBackupExample = {
  format: "mailhub-backup-encrypted",
  version: 1,
  encryption: {
    algorithm: "AES-256-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: 100000,
    salt: "AAAAAAAAAAAAAAAAAAAAAA==",
    iv: "AAAAAAAAAAAAAAAA",
  },
  ciphertext: "UkVQTEFDRV9XSVRIX0VYUE9SVEVEX0NJUEhFUlRFWFQ=",
};
op(
  "get",
  "/api/backups/manifest",
  "getBackupManifest",
  "查询便携业务备份范围与限制",
  "便携业务备份",
  {
    auth: "cookie",
    response: success(ref("BackupCapabilities")),
    description:
      "schema 11 共 12 张业务表，包括独立 platforms（空平台也保留）。全部表合计 ≤1000 行、明文 JSON ≤1 MiB（含清单，导出预留清单开销）；含 R2 引用但不包含对象内容。控制态、管理员会话、API Key、OAuth、审计、幂等、Webhook、连接/协调器与 Worker 配置均排除。restore_available 需 STORAGE 协调器及至少 32 字符凭据加密密钥。兼容严格校验后的 schema 10 文件。",
  },
);
op(
  "get",
  "/api/backups/export",
  "exportRedactedBackup",
  "下载脱敏业务清单",
  "便携业务备份",
  {
    auth: "cookie",
    response: ref("BackupDocument"),
    description:
      "默认正向白名单脱敏，不包含密码、TOTP、令牌、主题、正文或验证码；manifest.redacted=true、restorable=false，只用于检查和统计，不能恢复。响应为下载 JSON，没有 success/data 包装。导出前后业务 revision 不一致返回 409 BACKUP_CHANGED。",
  },
);
op(
  "post",
  "/api/backups/export",
  "exportEncryptedBackup",
  "下载含凭据的加密业务备份",
  "便携业务备份",
  {
    auth: "cookie",
    credentials: true,
    body: obj(
      {
        include_credentials: { type: "boolean", const: true },
        confirm: { type: "string", const: "EXPORT_CREDENTIALS" },
        passphrase: backupPassphrase,
      },
      ["include_credentials", "confirm", "passphrase"],
      false,
    ),
    example: {
      include_credentials: true,
      confirm: "EXPORT_CREDENTIALS",
      passphrase: "REPLACE_WITH_BACKUP_PASSPHRASE",
    },
    response: ref("EncryptedBackup"),
    effects: "读取全部范围内的业务及凭据并生成加密下载；记录审计。",
    description:
      "显式确认后以 PBKDF2-SHA256（100000 次、随机 16 字节 salt）派生 AES-256-GCM 密钥，随机 12 字节 IV，规范化 envelope header 作为 AAD。明文 ≤1 MiB/1000 行，Base64 封装会增大文件。响应是加密 envelope，没有 success/data 包装。大于 256 KiB 的响应不能缓存幂等回放，重复相同键会返回 IDEMPOTENCY_UNKNOWN。",
  },
);
for (const name of ["dry-run", "preview"] as const) {
  op(
    "post",
    `/api/backups/${name}`,
    name === "dry-run" ? "dryRunBackup" : "previewBackupRestore",
    "校验备份并预览恢复",
    "便携业务备份",
    {
      auth: "cookie",
      body: {
        oneOf: [
          obj(
            { backup: ref("EncryptedBackup"), passphrase: backupPassphrase },
            ["backup", "passphrase"],
            false,
          ),
          obj(
            {
              backup: {
                oneOf: [ref("BackupDocument"), ref("LegacyBackupDocument")],
              },
              passphrase: s(1024),
            },
            ["backup"],
            false,
          ),
        ],
      },
      example: {
        backup: encryptedBackupExample,
        passphrase: "REPLACE_WITH_BACKUP_PASSPHRASE",
      },
      response: success(ref("BackupPreview")),
      effects: "不修改业务数据；认证、审计及可选幂等记录仍会更新。",
      description:
        "dry-run 与 preview 为同一处理器。支持 schema 11 和已发布的 schema 10；旧文件先验证原 schema hash、完整字段、逐表/整体 hash 及业务关联，再确定性补出 platforms 并计算 schema 11 摘要。拒绝未知版本/字段，不能自行改版本号绕过。明文只接受不可恢复的脱敏文件。加密可恢复文件在配置 STORAGE、凭据密钥且 R2 引用齐全时返回绑定当前会话、转换后备份哈希、当前业务哈希和数据源的 10 分钟 confirmation_token。table_counts 使用转换后的 12 表范围，仍受合计 1000 行/1 MiB 限制。restorable=true 仅表示文件可恢复，应检查 confirmation_token 和 manifest.restore_available。backup 必须整体使用真实导出文件。",
    },
  );
}
op(
  "post",
  "/api/backups/restore",
  "restoreBackup",
  "确认并恢复便携业务备份",
  "便携业务备份",
  {
    auth: "cookie",
    parameters: [{ ...idempotencyParameter, required: true }],
    body: obj(
      {
        backup: ref("EncryptedBackup"),
        passphrase: backupPassphrase,
        confirmation_token: { ...s(4096), minLength: 1 },
        confirm: { type: "string", const: "RESTORE_BACKUP" },
      },
      ["backup", "passphrase", "confirmation_token", "confirm"],
      false,
    ),
    example: {
      backup: encryptedBackupExample,
      passphrase: "REPLACE_WITH_BACKUP_PASSPHRASE",
      confirmation_token: "REPLACE_WITH_PREVIEW_TOKEN",
      confirm: "RESTORE_BACKUP",
    },
    response: success(ref("BackupRestoreResult")),
    effects:
      "替换 12 张业务表（含 platforms）及指定偏好，在隔离 D1 数据集中校验后原子切换活动数据集；以当前实例密钥重新加密凭据。",
    description:
      "必须提供 Idempotency-Key、加密导出、原始口令、当前会话的有效预览令牌及 RESTORE_BACKUP 确认。目标需 STORAGE 协调器和凭据密钥；预览后业务/数据源变化、备份变化或令牌过期均拒绝恢复。R2 对象须先在目标桶恢复，控制态从目标实例保留。当前实现恢复到隔离的 D1 数据集；不是向现有活动表直接合并。结果未知时先读取活动数据源核对，绝不更换幂等键自动重执。",
  },
);

const storageStatus = obj({
  enabled: bool,
  encryption_ready: bool,
  sources: arr(
    obj({
      id: s(),
      name: s(),
      kind: s(),
      source: s(),
      endpoint: s(),
      transport: s(),
      purpose: s(),
    }),
  ),
  active: obj({ sourceId: s(), generation: s() }),
  job: { type: ["object", "null"], additionalProperties: true },
});
op(
  "get",
  "/api/settings/storage",
  "getStorageStatus",
  "查询数据源与同步任务",
  "存储管理",
  {
    auth: "cookie",
    response: success(storageStatus),
    description:
      "仅管理员 Cookie；连接密钥脱敏。job 为存储协调器状态，不同阶段字段不同，详见 DATABASES.md。",
  },
);
op(
  "post",
  "/api/settings/storage/sources",
  "addStorageSource",
  "验证并添加外部数据源",
  "存储管理",
  {
    auth: "cookie",
    body: obj(
      {
        name: s(80),
        kind: strEnum("mysql", "mongodb", "redis"),
        source: s(64),
        transport: strEnum("http", "redis"),
        endpoint: s(1000),
        token: s(1000),
        redis_url: s(2048),
        purpose: strEnum("primary", "replica"),
      },
      ["name", "kind", "source"],
    ),
    example: {
      name: "MySQL",
      kind: "mysql",
      source: "mysql-main",
      endpoint: "https://connector.example.com",
      token: "REPLACE_WITH_CONNECTOR_TOKEN_32_CHARS",
    },
    response: success(obj({})),
    description:
      "http 方式需要 endpoint/token；Redis 直连 transport=redis 需要 redis_url。测试连接后加密保存。",
  },
);
op(
  "patch",
  "/api/settings/storage/sources/{id}",
  "updateStorageSource",
  "更新数据源名称和凭据",
  "存储管理",
  {
    auth: "cookie",
    body: obj({ name: s(80), token: s(1000), redis_url: s(2048) }, ["name"]),
    example: { name: "生产副本" },
    description: "更换服务器应添加新数据源后同步。空 token 保留原密钥。",
  },
);
op(
  "delete",
  "/api/settings/storage/sources/{id}",
  "removeStorageSource",
  "移除闲置连接",
  "存储管理",
  {
    auth: "cookie",
    description: "移除配置不删除远程数据；活动数据源和进行中的任务受保护。",
  },
);
op(
  "post",
  "/api/settings/storage/sources/{id}/health",
  "checkStorageSource",
  "测试数据源连接",
  "存储管理",
  {
    auth: "cookie",
    response: success(obj({})),
    effects: "执行适配器连接与能力检查",
  },
);
op(
  "post",
  "/api/settings/storage/sync",
  "startStorageSync",
  "后台同步或切换数据库",
  "存储管理",
  {
    auth: "cookie",
    body: obj(
      {
        source_id: s(100),
        auto_switch: bool,
        mode: strEnum("switch", "snapshot"),
      },
      ["source_id"],
    ),
    example: {
      source_id: "REPLACE_WITH_SOURCE_ID",
      mode: "snapshot",
      auto_switch: false,
    },
    response: success(obj({})),
    description:
      "默认 mode=switch、auto_switch=true。snapshot 是该时刻副本，不是持续双写；调用后轮询 getStorageStatus 核对完成或失败。",
  },
);
op(
  "post",
  "/api/settings/storage/sync/retry",
  "retryStorageSync",
  "恢复中断同步",
  "存储管理",
  { auth: "cookie" },
);
op(
  "post",
  "/api/settings/storage/sync/cancel",
  "cancelStorageSync",
  "取消同步并继续原数据源",
  "存储管理",
  { auth: "cookie" },
);
for (const name of ["generate", "custom"] as const)
  op(
    "post",
    `/api/mailbox/${name}`,
    name === "generate" ? "generateMailboxLegacy" : "customMailboxLegacy",
    name === "generate" ? "兼容随机邮箱" : "兼容自定义邮箱",
    "兼容接口",
    {
      body: obj(
        { domain: s(), prefix: s(64), expiration: s(20) },
        name === "custom" ? ["prefix"] : [],
      ),
      example: {
        domain: "example.com",
        ...(name === "custom" ? { prefix: "signup" } : {}),
        expiration: "1h",
      },
      response: { allOf: [ref("Mailbox"), obj({ expiration: s() })] },
      description:
        "兼容平铺响应，无 success/data 包装。expiration 支持 60m、1h、1d、permanent。",
    },
  );
op("get", "/api/emails/list", "listMailLegacy", "兼容邮件列表", "兼容接口", {
  parameters: [
    q("address", address, "必填，或使用 mailbox 别名"),
    q("mailbox", address, "address 的别名"),
    q("q", s(200), "关键词"),
  ],
  response: obj(
    {
      emails: arr(
        obj({
          id,
          from: s(),
          to: s(),
          subject: s(),
          received_at: date,
          read: bool,
          verify_code: s(),
        }),
      ),
    },
    ["emails"],
  ),
  description: "最多最近 50 封；无 success/data 包装。",
});
op(
  "get",
  "/api/emails/view/{id}",
  "getMailLegacy",
  "兼容邮件正文",
  "兼容接口",
  {
    response: obj(
      {
        id,
        from: s(),
        to: s(),
        subject: s(),
        body: s(),
        html_body: s(),
        received_at: date,
        verify_code: s(),
      },
      ["id"],
    ),
    effects: "标记邮件已读",
    description: "无 success/data 包装；新接入推荐 getDomainMail。",
  },
);

export function openApi(origin = "http://localhost:8787") {
  const security = {
    public: [],
    key: [{ ApiKey: [] }, { BearerAuth: [] }],
    admin: [{ ApiKey: [] }, { BearerAuth: [] }, { AdminSession: [] }],
    cookie: [{ AdminSession: [] }],
  };
  const paths: Record<string, Record<string, unknown>> = {};
  for (const entry of operations) {
    const idempotent = entry.parameters.some(
      (p) => p.name === "Idempotency-Key",
    );
    const responseHeaders = {
      "X-Request-ID": {
        description:
          "服务器生成的请求追踪 ID；反馈问题时可提供此值，无需提供密钥。",
        schema: s(),
      },
      ...(idempotent
        ? {
            "Idempotency-Replayed": {
              description: "只有成功回放时为 true；仍执行当前权限校验。",
              schema: { type: "string", const: "true" },
            },
            "Idempotency-Key-Expires-At": {
              description:
                "首次预留起 7 天的成功结果回放截止时间；不表示未知结果可到期重执。",
              schema: isoTime,
            },
          }
        : {}),
      ...(entry.media === "application/octet-stream" ||
      ["exportRedactedBackup", "exportEncryptedBackup"].includes(
        entry.operationId,
      )
        ? {
            "Content-Disposition": {
              description: "attachment；文件名由服务器提供。",
              schema: s(),
            },
          }
        : {}),
    };
    (paths[entry.path] ||= {})[entry.method] = {
      operationId: entry.operationId,
      summary: entry.summary,
      description: entry.description,
      tags: [entry.tag],
      security: security[entry.auth],
      parameters: entry.parameters,
      "x-auth-mode": entry.auth,
      "x-authorization": {
        admin_session_only: entry.auth === "cookie",
        required_grants: entry.grants,
        grant_operator: "all",
        admin_scope_override: entry.auth === "admin" || entry.auth === "key",
        resource_restrictions_apply:
          entry.auth === "admin" || entry.auth === "key",
        ...(entry.conditionalGrants
          ? { additional_grants: entry.conditionalGrants }
          : {}),
        description:
          entry.auth === "cookie"
            ? "仅有效管理员会话；主密钥和 admin scope 均不能代替。不要同时携带 API Key。"
            : entry.auth === "public"
              ? "无需认证。"
              : "所列 grants 必须全部满足，admin 可替代 scope 检查但不能绕过资源限制。受限密钥不能使用未限定资源的聚合/台账列表；具体限制见指南。",
      },
      "x-idempotency": idempotent
        ? {
            supported: true,
            required: entry.operationId === "restoreBackup",
            scope: ["authenticated_actor", "method", "path"],
            request_identity: ["raw_body", "raw_query", "content_type"],
            completed_retention_seconds: 604800,
            max_response_bytes: 262144,
            max_records_per_actor: 1000,
            unknown_outcome: "never_automatically_reexecute",
            expired_complete: "may_be_removed_no_deduplication_guarantee",
          }
        : { supported: false },
      "x-side-effects": entry.effects,
      "x-credential-response": !!entry.credentials,
      ...(entry.method !== "get" && entry.path.startsWith("/api/")
        ? {
            "x-request-body-max-bytes": [
              "sendOutlookMail",
              "replyOutlookMail",
            ].includes(entry.operationId)
              ? 5242880
              : 2097152,
          }
        : {}),
      ...(["sendOutlookMail", "replyOutlookMail"].includes(entry.operationId)
        ? {
            "x-rate-limit": {
              scope: "outlook_account",
              shared_operations: ["sendOutlookMail", "replyOutlookMail"],
              algorithm: "fixed_window_from_first_attempt",
              windows: [
                { seconds: 60, attempts: 10 },
                { seconds: 900, attempts: 60 },
              ],
              failures_consume_attempts: true,
              successful_idempotency_replays_consume_attempts: false,
              error: "SEND_RATE_LIMITED",
            },
          }
        : {}),
      ...(entry.body
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: entry.body,
                  ...(entry.example === undefined
                    ? {}
                    : { example: entry.example }),
                },
              },
            },
          }
        : {}),
      responses: {
        [String(entry.responseStatus)]: {
          description:
            entry.responseStatus === 202
              ? "微软已受理；不保证收件方已收到，不返回新邮件 ID。"
              : entry.responseStatus === 201
                ? "已创建；凭据仅在本次创建结果及有效幂等回放中提供。"
                : "请求完成。批量查收还须检查每项 success。",
          headers: responseHeaders,
          content: {
            [entry.media || "application/json"]: {
              schema: entry.response,
              ...(entry.responseExample
                ? { example: entry.responseExample }
                : {}),
            },
          },
        },
        "400": { $ref: "#/components/responses/Failure" },
        ...(entry.auth !== "public"
          ? { "401": { $ref: "#/components/responses/Failure" } }
          : {}),
        "403": { $ref: "#/components/responses/Failure" },
        "404": { $ref: "#/components/responses/Failure" },
        "409": { $ref: "#/components/responses/Failure" },
        "413": { $ref: "#/components/responses/Failure" },
        "429": { $ref: "#/components/responses/Failure" },
        "500": { $ref: "#/components/responses/Failure" },
        "502": { $ref: "#/components/responses/Failure" },
        "503": { $ref: "#/components/responses/Failure" },
      },
    };
  }
  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "MailHub & Vault API",
      version: API_VERSION,
      description: `自建多域名邮箱、Outlook 托管/发信、平台账号、事件通知及便携业务备份。现有 /api 路径保持兼容，${API_VERSION} 为契约版本。支持细分 scope 和资源限制密钥；主密钥具有业务管理员权限，会话专属接口仍须 Cookie。权限见 x-authorization，副作用见 x-side-effects，成功状态包括 200/201/202。`,
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: origin, description: "当前部署；可替换为你的实例地址" }],
    tags: [...new Set(operations.map((o) => o.tag))].map((name) => ({
      name,
      description: `${name}接口与工作流`,
    })),
    paths,
    webhooks: {
      mailhubEvent: {
        post: {
          operationId: "receiveMailHubEvent",
          summary: "接收签名事件通知",
          tags: ["事件通知"],
          description:
            "MailHub 向配置的公网 HTTPS 接收端投递，非本服务 API 路由。使用原始正文校验 HMAC-SHA256(secret, timestamp + '.' + raw_body)，常量时间比较，拒绝与当前时间相差超过 5 分钟的 timestamp。delivery ID 头不在签名内，推荐重算 SHA256(canonical([body.id, subscriptionId])) 后再持久化去重。正文及链接不可信，禁止自动打开链接。",
          security: [],
          parameters: [
            {
              name: "X-MailHub-Event",
              in: "header",
              required: true,
              schema: webhookEvents,
              description: "应与已验签正文 event 一致。",
            },
            {
              name: "X-MailHub-Delivery",
              in: "header",
              required: true,
              schema: hash,
              description: "同订阅同事件的稳定投递 ID，重试保持不变。",
            },
            {
              name: "X-MailHub-Timestamp",
              in: "header",
              required: true,
              schema: { ...s(), pattern: "^\\d+$" },
              description: "Unix 秒；每次重试重新签名。",
            },
            {
              name: "X-MailHub-Signature",
              in: "header",
              required: true,
              schema: { ...s(71), pattern: "^sha256=[a-f0-9]{64}$" },
              description:
                "签名 secret 按 UTF-8 原字符串使用，不要先做 hex 解码。",
            },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("WebhookEvent") } },
          },
          responses: {
            "204": {
              description:
                "已持久化接收或确认是已接收过的投递；接收端可返回任意 2xx。",
            },
            "400": { description: "无效数据或签名；不可重试的 4xx 终止投递。" },
            "429": {
              description: "暂时限流；使用 Retry-After（秒或 HTTP 日期）。",
            },
            "500": {
              description: "临时处理失败；最多自动尝试 8 次（含首次）。",
            },
          },
          "x-delivery-policy": {
            max_attempts: 8,
            batch_size: 10,
            concurrency: 2,
            request_timeout_seconds: 8,
            retry_statuses: [408, 425, 429, "5xx", "network_error"],
            follows_redirects: false,
            metadata_only_by_default: true,
            terminal_retention_days: 30,
            cleanup_interval_hours: 6,
            cleanup_max_records: 500,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        ApiKey: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
          description:
            "主密钥或 mhk_ scoped key；仅可信服务端保存，不接受 URL 密钥。scope 见每个操作的 x-authorization。",
        },
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "与 X-API-Key 等价。若同时提供，两者必须相同；显式无效密钥不会回退到 Cookie。",
        },
        AdminSession: {
          type: "apiKey",
          in: "cookie",
          name: "mailhub_session",
          description:
            "管理员登录签发的 HttpOnly Cookie；API Key 管理、审计、备份、数据源、凭据保护、Webhook、主密钥读取、密码及 OAuth 必需。不要同时提供 API Key。",
        },
      },
      schemas,
      responses: {
        Failure: {
          description:
            "失败；读取 error/message。Retry-After 是最早等待时间，不代表可以自动重执写入。IDEMPOTENCY_UNKNOWN 或 delivery_unknown 要先核对业务状态。历史接口部分响应只有 message；自动化接口有 retryable。",
          headers: {
            "X-Request-ID": { schema: s() },
            "Retry-After": {
              schema: s(),
              description: "可重试错误的建议等待秒数",
            },
          },
          content: {
            "application/json": {
              schema: ref("Error"),
              example: {
                success: false,
                error: "INVALID_REQUEST",
                message: "请求参数无效",
                retryable: false,
              },
            },
          },
        },
      },
    },
    externalDocs: {
      url: `${origin}/api-doc.md`,
      description: "接入指南、工作流和错误恢复",
    },
  };
}
