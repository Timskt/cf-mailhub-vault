import { isMailProvider } from "../../shared/mail-providers";
import { registrationDefaults } from "../../shared/registrations";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  adminSessionMiddleware,
  getSessionSecret,
  securityMiddleware,
  sha256,
} from "../auth";
import { auditIdentity, recordAudit } from "../audit";
import { normalizeDomain } from "../domains";
import { validateRule } from "../mail-workflows";
import { platformKey } from "../platforms";
import {
  canonical,
  db,
  digest,
  oneOf,
  schema,
  rowKey,
  storageCall,
  StorageError,
  validateRow,
  type Row,
} from "../storage/client";
import { D1Port } from "../storage/d1";
import {
  BACKUP_PREFERENCES,
  PORTABLE_BACKUP_TABLES,
  type BackupRestoreResult,
} from "../storage/coordinator";
import { encryptCredentialRows } from "../storage/secure";
import type { Env } from "../types";
import { validateVaultAccount } from "../vault-import";
import { email, httpUrl, integer, invalid, object, text } from "../validation";

export const BACKUP_MAX_BYTES = 1024 * 1024;
export const BACKUP_MAX_ROWS = 1000;
export const BACKUP_PBKDF2_ITERATIONS = 100000; // Workers WebCrypto's supported PBKDF2 limit.
const FORMAT = "mailhub-backup";
const VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
// Authorization and infrastructure state must come from the current dataset, not an upload.
export const BACKUP_TABLES = PORTABLE_BACKUP_TABLES;
type BackupTable = (typeof BACKUP_TABLES)[number];
type LegacyBackupTable = Exclude<
  BackupTable,
  "platforms" | "provider_accounts"
>;
// Frozen schema 10 projection. Never derive legacy fields from the current model:
// adding a field in a future release must not make it admissible in an old file.
const LEGACY_BACKUP_SCHEMA: Record<
  LegacyBackupTable,
  { key: string[]; fields: string[] }
> = {
  settings: {
    key: ["key"],
    fields: "created_at key updated_at value".split(" "),
  },
  groups: {
    key: ["id"],
    fields: "color created_at description id name updated_at".split(" "),
  },
  tags: { key: ["id"], fields: "color created_at id name".split(" ") },
  accounts: {
    key: ["id"],
    fields:
      "auth_status client_id created_at email group_id id last_checked_at last_error last_error_code last_token_attempt_at last_token_refresh_at next_token_refresh_at password refresh_token remark status token_refresh_error token_refresh_failures token_refresh_status updated_at".split(
        " ",
      ),
  },
  account_tags: {
    key: ["account_id", "tag_id"],
    fields: ["account_id", "tag_id"],
  },
  cf_inbox_mails: {
    key: ["id"],
    fields:
      "attachment_manifest category created_at dkim_status expires_at html_content id is_archived is_pinned is_protected is_read message_id raw_object_key raw_size recipient rule_name sender sender_name spf_status subject text_content verification_code verification_link".split(
        " ",
      ),
  },
  mail_rules: {
    key: ["id"],
    fields:
      "action_category archive created_at domain enabled id mark_read name pin priority recipient sender_contains subject_contains updated_at verification_only".split(
        " ",
      ),
  },
  platform_vault: {
    key: ["id"],
    fields:
      "account_email category created_at email_source id is_pinned last_code last_code_at password platform_name platform_url proxy_node remark status totp_secret updated_at username".split(
        " ",
      ),
  },
  temp_emails: {
    key: ["id"],
    fields: "created_at email id remark source updated_at".split(" "),
  },
  temp_mailboxes: {
    key: ["id"],
    fields:
      "address associated_platform associated_vault_id created_at domain expires_at id is_permanent is_pinned prefix remark updated_at".split(
        " ",
      ),
  },
  domains: {
    key: ["domain"],
    fields:
      "created_at dns_status domain enabled last_checked_at last_received_at remark updated_at".split(
        " ",
      ),
  },
};
const SCHEMA_11 = {
  ...LEGACY_BACKUP_SCHEMA,
  platforms: {
    key: ["name_key"],
    fields:
      "category created_at is_pinned name name_key remark updated_at url".split(
        " ",
      ),
  },
};
// Frozen schema 12 is the released schema 10 projection plus platforms and
// provider accounts. Registration metadata belongs to schema 13 only.
const SCHEMA_12 = {
  ...SCHEMA_11,
  provider_accounts: {
    key: ["id"],
    fields:
      "address auth_status created_at credential_version id last_checked_at last_error last_error_code password provider remark remote_id status token token_expires_at updated_at".split(
        " ",
      ),
  },
};
const PREFERENCES = BACKUP_PREFERENCES;
const EXCLUDED = [
  "administrator/session secrets",
  "API keys",
  "OAuth sessions",
  "idempotency records",
  "audit logs",
  "webhook configuration and delivery queue",
  "storage connections/coordinator state",
  "Worker secrets/configuration",
  "R2 object contents",
];
const EXTERNAL_DEPENDENCIES = [
  "R2 objects referenced by raw_object_key/attachment_manifest must be retained in the destination bucket",
  "Domain routing, provider access and Worker environment configuration must be configured separately",
];
// Positive field lists keep newly added credential/body fields out of redacted exports.
const REDACTED: Record<BackupTable, readonly string[]> = {
  provider_accounts: [
    "id",
    "provider",
    "address",
    "remote_id",
    "status",
    "auth_status",
    "last_checked_at",
    "created_at",
    "updated_at",
  ],
  settings: ["key", "value"],
  groups: ["id", "name", "color", "created_at", "updated_at"],
  tags: ["id", "name", "color", "created_at"],
  accounts: [
    "id",
    "email",
    "group_id",
    "status",
    "auth_status",
    "created_at",
    "updated_at",
  ],
  account_tags: ["account_id", "tag_id"],
  cf_inbox_mails: [
    "id",
    "recipient",
    "sender",
    "raw_size",
    "is_read",
    "is_pinned",
    "is_protected",
    "is_archived",
    "category",
    "expires_at",
    "created_at",
  ],
  mail_rules: [
    "id",
    "name",
    "enabled",
    "priority",
    "verification_only",
    "action_category",
    "mark_read",
    "archive",
    "pin",
    "created_at",
    "updated_at",
  ],
  platforms: [
    "name_key",
    "name",
    "category",
    "is_pinned",
    "created_at",
    "updated_at",
  ],
  platform_vault: [
    "id",
    "platform_name",
    "account_email",
    "email_source",
    "status",
    "category",
    "is_pinned",
    "created_at",
    "updated_at",
  ],
  temp_emails: ["id", "email", "source", "created_at", "updated_at"],
  temp_mailboxes: [
    "id",
    "address",
    "prefix",
    "domain",
    "expires_at",
    "is_permanent",
    "associated_vault_id",
    "is_pinned",
    "created_at",
    "updated_at",
  ],
  domains: [
    "domain",
    "enabled",
    "dns_status",
    "last_checked_at",
    "last_received_at",
    "created_at",
    "updated_at",
  ],
};
// Schema 10/11/12 redacted files retain their original platform projection.
const REDACTED_SCHEMA_13: Record<BackupTable, readonly string[]> = {
  ...REDACTED,
  platform_vault: [
    ...REDACTED.platform_vault,
    "workspace",
    "account_identifier",
    "login_methods",
    "mailbox_address",
    "mailbox_link_state",
    "verification_sender",
    "verification_keyword",
    "registered_at",
    "last_verified_at",
    "expires_at",
  ],
};
export interface BackupManifest {
  format: typeof FORMAT;
  version: 1;
  schema_version: 13;
  schema_hash: string;
  created_at: string;
  redacted: boolean;
  restorable: boolean;
  consistency: "revision_checked";
  table_counts: Record<string, number>;
  table_hashes: Record<string, string>;
  data_hash: string;
  excluded: string[];
  external_dependencies: string[];
}
export interface BackupDocument {
  manifest: BackupManifest;
  tables: Record<BackupTable, Row[]>;
}
export interface LegacyBackupDocument {
  manifest: Omit<BackupManifest, "schema_version"> & { schema_version: 10 };
  tables: Record<LegacyBackupTable, Row[]>;
}
export interface Schema11BackupDocument {
  manifest: Omit<BackupManifest, "schema_version"> & { schema_version: 11 };
  tables: Omit<BackupDocument["tables"], "provider_accounts">;
}
export interface Schema12BackupDocument {
  manifest: Omit<BackupManifest, "schema_version"> & { schema_version: 12 };
  tables: BackupDocument["tables"];
}
export interface EncryptedBackup {
  format: "mailhub-backup-encrypted";
  version: 1;
  encryption: {
    algorithm: "AES-256-GCM";
    kdf: "PBKDF2-SHA256";
    iterations: number;
    salt: string;
    iv: string;
  };
  ciphertext: string;
}
type ActiveDataset = { sourceId: string; generation: string };
type Revision = { active: ActiveDataset; revision: number };
function b64(value: Uint8Array | ArrayBuffer) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
function unb64(value: unknown, max: number) {
  const input = text(value, "base64", Math.ceil(max / 3) * 4 + 4);
  if (!input || input.length % 4 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(input))
    invalid("备份编码无效");
  const result = Uint8Array.from(atob(input), (c) => c.charCodeAt(0));
  if (result.byteLength > max || b64(result) !== input)
    invalid("备份编码或大小无效");
  return result;
}
function byteSize(value: unknown) {
  return encoder.encode(JSON.stringify(value)).byteLength;
}
function bounded(value: unknown) {
  if (byteSize(value) > BACKUP_MAX_BYTES)
    throw new StorageError(
      "BACKUP_TOO_LARGE",
      "备份超过 1 MiB 限制，请使用数据源迁移或原生备份",
      413,
    );
}
function passphrase(value: unknown) {
  const result = text(value, "备份口令", 1024);
  if (result.length < 12) invalid("备份口令至少需要 12 个字符");
  return result; // Do not trim passwords or normalize Unicode.
}
async function encryptionKey(secret: string, salt: Uint8Array<ArrayBuffer>) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: BACKUP_PBKDF2_ITERATIONS,
    },
    key,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
async function backupSchema(version: 10 | 11 | 12 | 13 = 13): Promise<
  Record<
    string,
    {
      key: string[];
      fields: string[];
    }
  >
> {
  if (version === 10) return LEGACY_BACKUP_SCHEMA;
  if (version === 11) return SCHEMA_11;
  if (version === 12) return SCHEMA_12;
  return Object.fromEntries(
    BACKUP_TABLES.map((table) => [
      table,
      {
        key: schema[table].key,
        fields: Object.keys(schema[table].fields)
          .filter((field) => field !== "refresh_token_fingerprint")
          .sort(),
      },
    ]),
  );
}
async function revision(env: Env): Promise<Revision> {
  if (env.STORAGE) {
    const status = await storageCall<
      Revision & { pending_write: boolean; write_paused: boolean }
    >(env, "/status");
    if (status.pending_write || status.write_paused)
      throw new StorageError(
        "BACKUP_BUSY",
        "存储正在提交或切换，请稍后重新导出或预览",
        409,
      );
    return { active: status.active, revision: status.revision };
  }
  return {
    active: { sourceId: "d1", generation: "legacy" },
    revision: (await new D1Port(env.DB).info()).version,
  };
}
async function snapshot(env: Env, redacted: boolean) {
  const start = await revision(env),
    store = db(env);
  const tables = {} as Record<BackupTable, Row[]>;
  let count = 0,
    size = 0;
  for (const table of BACKUP_TABLES) {
    const rows: Row[] = [];
    for (let offset = 0; ; offset += 25) {
      const page = await store.select(table, {
        ...(table === "settings" ? { where: oneOf("key", PREFERENCES) } : {}),
        ...(redacted ? { columns: [...REDACTED_SCHEMA_13[table]] } : {}),
        order: schema[table].key.map((field) => [field, "asc"]),
        limit: 25,
        offset,
      });
      for (const row of page) {
        delete row.refresh_token_fingerprint;
        const output = Object.fromEntries(
          Object.entries(row).filter(([, value]) => value !== undefined),
        ) as Row;
        count++;
        size += byteSize(output);
        if (count > BACKUP_MAX_ROWS || size > BACKUP_MAX_BYTES - 12000)
          throw new StorageError(
            "BACKUP_TOO_LARGE",
            "便携备份最多 1000 条、1 MiB，请使用数据源迁移或原生备份",
            413,
          );
        rows.push(output);
      }
      if (page.length < 25) break;
    }
    tables[table] = rows;
  }
  const end = await revision(env);
  if (canonical(start) !== canonical(end))
    throw new StorageError(
      "BACKUP_CHANGED",
      "导出期间数据发生变化，请重新导出",
      409,
    );
  const tableCounts: Record<string, number> = {},
    tableHashes: Record<string, string> = {};
  for (const table of BACKUP_TABLES) {
    tableCounts[table] = tables[table].length;
    tableHashes[table] = await digest(tables[table]);
  }
  const document: BackupDocument = {
    manifest: {
      format: FORMAT,
      version: VERSION,
      schema_version: 13,
      schema_hash: await digest(await backupSchema()),
      created_at: new Date().toISOString(),
      redacted,
      restorable: !redacted,
      consistency: "revision_checked",
      table_counts: tableCounts,
      table_hashes: tableHashes,
      data_hash: await digest(tables),
      excluded: EXCLUDED,
      external_dependencies: EXTERNAL_DEPENDENCIES,
    },
    tables,
  };
  bounded(document);
  return { document, revision: end };
}
export async function sealBackup(
  document:
    | BackupDocument
    | LegacyBackupDocument
    | Schema11BackupDocument
    | Schema12BackupDocument,
  secret: string,
): Promise<EncryptedBackup> {
  bounded(document);
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const header = {
    format: "mailhub-backup-encrypted" as const,
    version: 1 as const,
    encryption: {
      algorithm: "AES-256-GCM" as const,
      kdf: "PBKDF2-SHA256" as const,
      iterations: BACKUP_PBKDF2_ITERATIONS,
      salt: b64(salt),
      iv: b64(iv),
    },
  };
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(canonical(header)) },
    await encryptionKey(passphrase(secret), salt),
    encoder.encode(JSON.stringify(document)),
  );
  return { ...header, ciphertext: b64(ciphertext) };
}
/** Exported for recovery tooling. Wrong passphrases and tampering share one generic error. */
export async function openBackup(
  value: unknown,
  supplied: string,
): Promise<BackupDocument> {
  const body = object(value),
    encryption = object(body.encryption);
  if (
    Object.keys(body).some(
      (k) => !["format", "version", "encryption", "ciphertext"].includes(k),
    ) ||
    body.format !== "mailhub-backup-encrypted" ||
    body.version !== 1 ||
    encryption.algorithm !== "AES-256-GCM" ||
    encryption.kdf !== "PBKDF2-SHA256" ||
    encryption.iterations !== BACKUP_PBKDF2_ITERATIONS ||
    Object.keys(encryption).some(
      (k) => !["algorithm", "kdf", "iterations", "salt", "iv"].includes(k),
    )
  )
    invalid("加密备份格式或加密参数无效");
  const salt = unb64(encryption.salt, 16),
    iv = unb64(encryption.iv, 12),
    ciphertext = unb64(body.ciphertext, BACKUP_MAX_BYTES + 16);
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16)
    invalid("加密备份格式无效");
  const secret = passphrase(supplied),
    header = { format: body.format, version: body.version, encryption };
  let plaintext: unknown;
  try {
    const bytes = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encoder.encode(canonical(header)),
      },
      await encryptionKey(secret, salt),
      ciphertext,
    );
    plaintext = JSON.parse(decoder.decode(bytes));
  } catch {
    return invalid("备份口令不正确或文件已损坏");
  }
  return validateBackup(plaintext);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  if (canonical(Object.keys(value).sort()) !== canonical([...keys].sort()))
    invalid("备份字段缺失或包含未知字段");
}
const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const lower = (value: unknown) => String(value || "").toLowerCase();
const positiveId = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const flagFields = new Set([
  "enabled",
  "is_read",
  "is_pinned",
  "is_protected",
  "is_archived",
  "is_permanent",
  "verification_only",
  "mark_read",
  "archive",
  "pin",
]);

function validateBusinessRow(
  table: BackupTable,
  row: Row,
  redacted: boolean,
  version: 10 | 11 | 12 | 13,
) {
  validateRow(table, row);
  for (const [field, value] of Object.entries(row)) {
    const expected = (schema[table].fields as Row)[field];
    if (value === null && !schema[table].key.includes(field)) continue; // Historical nullable columns.
    if (field === "associated_vault_id") {
      if (!positiveId(value)) invalid("关联台账 ID 无效");
    } else if (typeof value !== typeof expected)
      invalid("备份字段类型与表结构不符");
    if (
      (field === "id" ||
        (field.endsWith("_id") &&
          ["account_id", "tag_id", "group_id"].includes(field))) &&
      !positiveId(value)
    )
      invalid("备份记录 ID 无效");
    if (flagFields.has(field) && value !== 0 && value !== 1)
      invalid("备份状态须为 0 或 1");
  }
  const required: Partial<Record<BackupTable, string[]>> = {
    settings: ["key", "value"],
    groups: ["name"],
    tags: ["name"],
    accounts: ["email"],
    cf_inbox_mails: ["recipient", "sender"],
    platform_vault: ["platform_name", "account_email"],
    platforms: ["name_key", "name", "category"],
    temp_emails: ["email"],
    temp_mailboxes: ["address"],
    domains: ["domain"],
    provider_accounts: ["provider", "address"],
    mail_rules: ["name"],
  };
  for (const field of required[table] || [])
    if (
      typeof row[field] !== "string" ||
      (field !== "value" && !String(row[field]).trim())
    )
      invalid("备份缺少必要业务字段");
  const addressField =
    table === "accounts" || table === "temp_emails"
      ? "email"
      : table === "platform_vault"
        ? "account_email"
        : table === "provider_accounts"
          ? "address"
          : table === "temp_mailboxes"
            ? "address"
            : table === "cf_inbox_mails"
              ? "recipient"
              : "";
  if (addressField) email(row[addressField]);
  if (table === "settings") {
    if (!PREFERENCES.includes(String(row.key)))
      invalid("备份不能覆盖认证或基础设施设置");
    if (row.key === "default_prefix") text(row.value, "默认前缀", 30);
    if (row.key === "default_mail_domain" && row.value)
      normalizeDomain(row.value);
    if (row.key === "mail_retention_days")
      integer(row.value, "保留天数", 1, 365);
    if (row.key === "token_refresh_batch") integer(row.value, "刷新批量", 1, 8);
  }
  if (table === "domains") {
    if (normalizeDomain(row.domain) !== row.domain)
      invalid("备份域名须为规范格式");
  }
  if (table === "temp_mailboxes") {
    if (
      normalizeDomain(row.domain) !== row.domain ||
      lower(row.address) !== `${lower(row.prefix)}@${row.domain}`
    )
      invalid("备份邮箱地址与前缀或域名不一致");
  }
  if (table === "platforms") {
    const name = text(row.name, "平台名称", 100);
    if (name !== name.trim() || row.name_key !== platformKey(name))
      invalid("备份平台名称与规范主键不一致");
    text(row.category, "平台分类", 100);
    if (!redacted) {
      httpUrl(row.url);
      text(row.remark, "平台备注", 4000);
    }
  }
  if (table === "platform_vault" && version === 13) {
    // Reuse only the registration validators. Historical credentials, URLs,
    // manual states and nullable 2FA fields keep their existing backup rules.
    validateVaultAccount({
      platform_name: "Backup metadata",
      account_email: "backup@example.test",
      ...Object.fromEntries(
        Object.keys(registrationDefaults).map((field) => [field, row[field]]),
      ),
    });
  }
  if (table === "provider_accounts") {
    if (
      !isMailProvider(String(row.provider)) ||
      !["active", "disabled"].includes(String(row.status)) ||
      !["unchecked", "healthy", "error", "reauth_required"].includes(
        String(row.auth_status),
      )
    )
      invalid("外部邮箱服务商或状态无效");
    if (row.remote_id && !/^[a-zA-Z0-9_-]{1,200}$/.test(String(row.remote_id)))
      invalid("外部邮箱身份无效");
    if (!redacted) {
      if (!text(row.password, "邮箱密码", 1000)) invalid("外部邮箱缺少密码");
      text(row.token, "邮箱令牌", 16384);
      text(row.remark, "邮箱备注", 1000);
      text(row.credential_version, "凭据版本", 100);
    }
  }
  if (redacted) return;
  if (
    table === "accounts" &&
    (typeof row.refresh_token !== "string" || typeof row.client_id !== "string")
  )
    invalid("Outlook 凭据字段无效");
  if (table === "mail_rules")
    validateRule({
      ...row,
      ...Object.fromEntries(
        [...flagFields].filter((f) => f in row).map((f) => [f, row[f] === 1]),
      ),
    });
  if (table === "cf_inbox_mails") {
    if (
      row.raw_object_key &&
      !/^mail\/[0-9a-f-]{36}\/raw\.eml$/.test(String(row.raw_object_key))
    )
      invalid("原始邮件对象引用无效");
    let attachments: unknown;
    try {
      attachments = JSON.parse(String(row.attachment_manifest));
    } catch {
      return invalid("附件清单无效");
    }
    if (
      !Array.isArray(attachments) ||
      attachments.length > 200 ||
      (attachments.length && !row.raw_object_key)
    )
      invalid("附件清单无效");
    const ids = new Set<string>();
    for (const item of attachments) {
      const attachment = object(item);
      exactKeys(attachment, ["id", "name", "size", "contentType"]);
      if (
        typeof attachment.id !== "string" ||
        !/^\d{1,3}$/.test(attachment.id) ||
        ids.has(attachment.id)
      )
        invalid("附件 ID 无效");
      ids.add(attachment.id);
      if (
        typeof attachment.size !== "number" ||
        !Number.isSafeInteger(attachment.size) ||
        attachment.size < 0
      )
        invalid("附件大小无效");
      text(attachment.name, "附件名称", 200);
      text(attachment.contentType, "附件类型", 254);
    }
  }
}

/** Validates content even after authenticated decryption: encryption authenticates the
 * file's passphrase holder, not the business model or the destination's authority. */
export async function validateBackup(value: unknown): Promise<BackupDocument> {
  bounded(value);
  const document = object(value);
  exactKeys(document, ["manifest", "tables"]);
  const manifest = object(document.manifest),
    data = object(document.tables);
  exactKeys(manifest, [
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
  ]);
  const version = manifest.schema_version;
  if (version !== 10 && version !== 11 && version !== 12 && version !== 13)
    invalid("备份格式或 schema 版本不兼容");
  const model = await backupSchema(version);
  const included = Object.keys(model) as BackupTable[];
  if (
    manifest.format !== FORMAT ||
    manifest.version !== VERSION ||
    manifest.schema_hash !== (await digest(model)) ||
    manifest.consistency !== "revision_checked"
  )
    invalid("备份格式或 schema 版本不兼容");
  if (
    typeof manifest.redacted !== "boolean" ||
    manifest.restorable !== !manifest.redacted ||
    typeof manifest.created_at !== "string" ||
    !Number.isFinite(Date.parse(manifest.created_at))
  )
    invalid("备份清单无效");
  if (
    canonical(manifest.excluded) !== canonical(EXCLUDED) ||
    canonical(manifest.external_dependencies) !==
      canonical(EXTERNAL_DEPENDENCIES)
  )
    invalid("备份范围说明无效");
  exactKeys(data, included);
  const counts = object(manifest.table_counts),
    hashes = object(manifest.table_hashes);
  exactKeys(counts, included);
  exactKeys(hashes, included);
  let total = 0;
  for (const table of included) {
    const rows = data[table];
    if (!Array.isArray(rows) || counts[table] !== rows.length)
      invalid("备份记录数不符");
    total += rows.length;
    if (total > BACKUP_MAX_ROWS)
      throw new StorageError(
        "BACKUP_TOO_LARGE",
        "备份最多支持 1000 条记录",
        413,
      );
    const keys = new Set<string>(),
      unique = schema[table].unique.map(() => new Set<string>());
    const fields = manifest.redacted
      ? version === 13
        ? REDACTED_SCHEMA_13[table]
        : REDACTED[table]
      : model[table].fields;
    for (const item of rows) {
      const row = object(item) as Row;
      exactKeys(row, fields);
      validateBusinessRow(table, row, manifest.redacted, version);
      const key = rowKey(table, row);
      if (keys.has(key)) invalid("备份包含重复主键");
      keys.add(key);
      schema[table].unique.forEach((columns, index) => {
        if (columns.some((f) => row[f] === null || row[f] === undefined))
          return;
        const values = columns.map((f) =>
          ["email", "address"].includes(f) ? lower(row[f]) : row[f],
        );
        const key = canonical(values);
        if (unique[index].has(key)) invalid("备份违反唯一约束");
        unique[index].add(key);
      });
    }
    if (!isHash(hashes[table]) || hashes[table] !== (await digest(rows)))
      invalid("备份表哈希不匹配");
  }
  if (
    !isHash(manifest.data_hash) ||
    manifest.data_hash !== (await digest(data))
  )
    invalid("备份整体哈希不匹配");
  const typed = document as unknown as
      | BackupDocument
      | LegacyBackupDocument
      | Schema11BackupDocument
      | Schema12BackupDocument,
    t = typed.tables;
  const has = (table: LegacyBackupTable, id: unknown) =>
    t[table].some((row) => row.id === id);
  for (const row of t.accounts)
    if (row.group_id !== null && !has("groups", row.group_id))
      invalid("账号引用的分组不存在");
  for (const row of t.account_tags)
    if (!has("accounts", row.account_id) || !has("tags", row.tag_id))
      invalid("账号标签关联不存在");
  for (const row of t.temp_mailboxes)
    if (row.associated_vault_id !== null) {
      const vault = t.platform_vault.find(
        (v) => v.id === row.associated_vault_id,
      );
      if (
        !vault ||
        vault.email_source !== "cf_domain" ||
        lower(vault.mailbox_address || vault.account_email) !==
          lower(row.address)
      )
        invalid("邮箱关联的台账不存在或地址不一致");
    }
  if (typed.manifest.schema_version === 10)
    return upgradeLegacyBackup(typed as LegacyBackupDocument);
  if (typed.manifest.schema_version === 11)
    return upgradeSchema11Backup(typed as Schema11BackupDocument);
  if (typed.manifest.schema_version === 12)
    return upgradeSchema12Backup(typed as Schema12BackupDocument);
  return typed as BackupDocument;
}

type OlderBackupManifest = Omit<BackupManifest, "schema_version"> & {
  schema_version: 10 | 11 | 12;
};

async function upgradeToSchema13(
  manifest: OlderBackupManifest,
  tables: BackupDocument["tables"],
): Promise<BackupDocument> {
  const upgraded: BackupDocument = {
    manifest: {
      ...manifest,
      schema_version: 13,
      schema_hash: await digest(await backupSchema(13)),
      table_counts: Object.fromEntries(
        BACKUP_TABLES.map((table) => [table, tables[table].length]),
      ),
      table_hashes: Object.fromEntries(
        await Promise.all(
          BACKUP_TABLES.map(async (table) => [
            table,
            await digest(tables[table]),
          ]),
        ),
      ),
      data_hash: await digest(tables),
    },
    tables,
  };
  return validateBackup(upgraded);
}

function addRegistrationDefaults(rows: Row[]): Row[] {
  return rows.map((row) => ({ ...registrationDefaults, ...row }));
}

async function upgradeSchema11Backup(
  legacy: Schema11BackupDocument,
): Promise<BackupDocument> {
  return upgradeToSchema13(legacy.manifest, {
    ...legacy.tables,
    platform_vault: addRegistrationDefaults(legacy.tables.platform_vault),
    provider_accounts: [],
  } as BackupDocument["tables"]);
}

async function upgradeSchema12Backup(
  legacy: Schema12BackupDocument,
): Promise<BackupDocument> {
  return upgradeToSchema13(legacy.manifest, {
    ...legacy.tables,
    platform_vault: addRegistrationDefaults(legacy.tables.platform_vault),
  });
}

/** Only called after every original schema, content hash and business invariant
 * passes. No current rows or wall clock are consulted, so preview/restore hashes
 * stay identical. Original account rows, including case variants, are preserved. */
async function upgradeLegacyBackup(
  legacy: LegacyBackupDocument,
): Promise<BackupDocument> {
  const catalog = new Map<string, Row>();
  for (const account of [...legacy.tables.platform_vault].sort(
    (a, b) => Number(a.id) - Number(b.id),
  )) {
    const name = String(account.platform_name).trim(),
      key = platformKey(name);
    if (catalog.has(key)) continue;
    let url = "";
    if (!legacy.manifest.redacted) {
      // Hand-created historical rows may contain an invalid URL. Keep that value
      // on the untouched account; do not promote it to a clickable platform URL.
      try {
        url = httpUrl(account.platform_url ?? "");
      } catch {
        /* no safe URL */
      }
    }
    const row: Row = {
      name_key: key,
      name,
      url,
      category: account.category || "其他",
      remark: "",
      is_pinned: 0,
      created_at: account.created_at || legacy.manifest.created_at,
      updated_at: account.updated_at || legacy.manifest.created_at,
    };
    catalog.set(
      key,
      legacy.manifest.redacted
        ? Object.fromEntries(
            REDACTED.platforms.map((field) => [field, row[field]]),
          )
        : row,
    );
  }
  const tables = Object.fromEntries(
    BACKUP_TABLES.map((table) => [
      table,
      table === "platforms"
        ? [...catalog.values()]
        : table === "provider_accounts"
          ? []
          : legacy.tables[table],
    ]),
  ) as Record<BackupTable, Row[]>;
  tables.platform_vault = addRegistrationDefaults(tables.platform_vault);
  // The derived rows also count toward the existing restoration limits.
  return upgradeToSchema13(legacy.manifest, tables);
}

interface Confirmation {
  version: 1;
  actor: string;
  backup_hash: string;
  current_hash: string;
  active: ActiveDataset;
  expires: number;
  nonce: string;
}
async function confirmationKey(env: Env) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(
      `mailhub:backup-confirmation:v1:${await getSessionSecret(env)}`,
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
async function signConfirmation(env: Env, value: Confirmation) {
  const payload = encoder.encode(JSON.stringify(value));
  return `${b64(payload)}.${b64(await crypto.subtle.sign("HMAC", await confirmationKey(env), payload))}`;
}
async function readConfirmation(
  env: Env,
  value: unknown,
  actor: string,
): Promise<Confirmation> {
  const token = text(value, "预览凭据", 4096),
    [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) invalid("预览凭据无效，请重新预览");
  const bytes = unb64(payload, 2048),
    sig = unb64(signature, 32);
  if (
    sig.length !== 32 ||
    !(await crypto.subtle.verify(
      "HMAC",
      await confirmationKey(env),
      sig,
      bytes,
    ))
  )
    invalid("预览凭据无效，请重新预览");
  let result: Confirmation;
  try {
    result = JSON.parse(decoder.decode(bytes));
  } catch {
    return invalid("预览凭据无效");
  }
  if (
    !result ||
    result.version !== 1 ||
    result.actor !== actor ||
    !isHash(result.backup_hash) ||
    !isHash(result.current_hash)
  )
    invalid("预览凭据与当前会话不符");
  if (!Number.isSafeInteger(result.expires) || result.expires <= Date.now())
    throw new StorageError(
      "BACKUP_PREVIEW_EXPIRED",
      "预览已过期，请重新预览",
      409,
    );
  return result;
}
function credentialKey(env: Env) {
  const current =
    env.CREDENTIAL_ENCRYPTION_KEY || env.STORAGE_ENCRYPTION_KEY || "";
  if (current.length < 32)
    throw new StorageError(
      "CREDENTIAL_KEY_REQUIRED",
      "恢复前请配置至少 32 位的凭据加密密钥",
      503,
    );
  return current;
}
async function readUpload(body: Record<string, unknown>) {
  const backup = object(body.backup);
  const encrypted = backup.format === "mailhub-backup-encrypted";
  const document = encrypted
    ? await openBackup(backup, passphrase(body.passphrase))
    : await validateBackup(backup);
  // Plaintext uploads cannot opt into restoration merely by claiming to be unredacted.
  if (!encrypted && document.manifest.restorable)
    invalid("包含凭据的备份必须使用加密文件");
  return { document, encrypted };
}
async function verifyExternalObjects(env: Env, document: BackupDocument) {
  const keys = [
    ...new Set(
      document.tables.cf_inbox_mails
        .map((r) => String(r.raw_object_key || ""))
        .filter(Boolean),
    ),
  ];
  if (keys.length && !env.MAIL_OBJECTS)
    throw new StorageError(
      "BACKUP_EXTERNAL_MISSING",
      "备份引用原始邮件文件，请先配置并恢复对应的 R2 存储桶",
      503,
    );
  for (let offset = 0; offset < keys.length; offset += 5) {
    const objects = await Promise.all(
      keys.slice(offset, offset + 5).map((key) => env.MAIL_OBJECTS!.head(key)),
    );
    if (objects.some((item) => !item))
      throw new StorageError(
        "BACKUP_EXTERNAL_MISSING",
        "备份引用的 R2 文件缺失，请先恢复对象文件",
        409,
      );
  }
}

/** Mount /api/backups. This is a bounded business backup, not a disaster-recovery
 * snapshot. Controls and secrets come only from the destination's current dataset. */
const app = new Hono<{ Bindings: Env }>();
const uploadLimit = bodyLimit({
  maxSize: 2 * 1024 * 1024,
  onError: (c) =>
    c.json(
      {
        success: false,
        error: "BACKUP_TOO_LARGE",
        message: "备份上传超过 2 MiB",
      },
      413,
    ),
});
app.use("*", async (c, next) => {
  // Global security may already have hashed and cached this request body. Reading
  // the consumed raw stream again throws in workerd; validate the cached bytes.
  if (c.req.raw.bodyUsed) {
    if (encoder.encode(await c.req.text()).byteLength > 2 * 1024 * 1024)
      return c.json(
        {
          success: false,
          error: "BACKUP_TOO_LARGE",
          message: "备份上传超过 2 MiB",
        },
        413,
      );
    return next();
  }
  return uploadLimit(c, next);
});
app.use("*", securityMiddleware());
app.use("*", adminSessionMiddleware());
app.get("/manifest", async (c) => {
  const model = await backupSchema();
  return c.json({
    success: true,
    data: {
      format: FORMAT,
      version: VERSION,
      schema_version: 13,
      name: "便携业务备份",
      limits: {
        max_plaintext_bytes: BACKUP_MAX_BYTES,
        max_rows: BACKUP_MAX_ROWS,
      },
      tables: BACKUP_TABLES,
      schema: model,
      schema_hash: await digest(model),
      excluded: EXCLUDED,
      external_dependencies: EXTERNAL_DEPENDENCIES,
      restore_available: Boolean(
        c.env.STORAGE &&
        (c.env.CREDENTIAL_ENCRYPTION_KEY || c.env.STORAGE_ENCRYPTION_KEY || "")
          .length >= 32,
      ),
      full_export: {
        confirmation: "EXPORT_CREDENTIALS",
        min_passphrase_length: 12,
        algorithm: "AES-256-GCM",
        kdf: "PBKDF2-SHA256",
        iterations: BACKUP_PBKDF2_ITERATIONS,
      },
    },
  });
});
app.get("/export", async (c) => {
  const { document } = await snapshot(c.env, true);
  c.header(
    "Content-Disposition",
    'attachment; filename="mailhub-business-redacted.json"',
  );
  return c.json(document);
});
app.post("/export", async (c) => {
  const body = object(await c.req.json());
  exactKeys(body, ["include_credentials", "confirm", "passphrase"]);
  if (
    body.include_credentials !== true ||
    body.confirm !== "EXPORT_CREDENTIALS"
  )
    invalid("包含凭据的导出须明确确认 EXPORT_CREDENTIALS");
  const secret = passphrase(body.passphrase);
  await recordAudit(c.env, {
    ...auditIdentity(c.get("auth")!),
    request_id: c.res.headers.get("X-Request-ID") || "",
    action: "backup.export_credentials",
    resource: "backup",
    status: 0,
    metadata: { include_credentials: true },
  });
  const { document } = await snapshot(c.env, false);
  await validateBackup(document);
  const encrypted = await sealBackup(document, secret);
  c.header(
    "Content-Disposition",
    'attachment; filename="mailhub-business-encrypted.json"',
  );
  return c.json(encrypted);
});
app.post("/dry-run", preview);
app.post("/preview", preview);
async function preview(c: import("hono").Context<{ Bindings: Env }>) {
  const body = object(await c.req.json());
  if (Object.keys(body).some((k) => !["backup", "passphrase"].includes(k)))
    invalid("预览参数无效");
  const { document, encrypted } = await readUpload(body),
    backupHash = await digest(document);
  let confirmation:
    { confirmation_token: string; expires_at: string } | undefined;
  if (encrypted && document.manifest.restorable && c.env.STORAGE) {
    credentialKey(c.env);
    await verifyExternalObjects(c.env, document);
    const current = await snapshot(c.env, false),
      expires = Date.now() + 10 * 60000;
    confirmation = {
      confirmation_token: await signConfirmation(c.env, {
        version: 1,
        actor: c.get("auth")!.actor,
        backup_hash: backupHash,
        current_hash: current.document.manifest.data_hash,
        active: current.revision.active,
        expires,
        nonce: crypto.randomUUID(),
      }),
      expires_at: new Date(expires).toISOString(),
    };
  }
  return c.json({
    success: true,
    data: {
      valid: true,
      restorable: document.manifest.restorable,
      table_counts: document.manifest.table_counts,
      backup_hash: backupHash,
      writes_performed: false,
      external_dependencies: document.manifest.external_dependencies,
      ...confirmation,
    },
  });
}
app.post("/restore", async (c) => {
  if (!c.req.header("Idempotency-Key"))
    invalid("恢复操作必须提供 Idempotency-Key");
  if (!c.env.STORAGE)
    throw new StorageError(
      "BACKUP_RESTORE_UNAVAILABLE",
      "恢复需要 STORAGE 协调器，以保证隔离数据集与原子切换",
      503,
    );
  const body = object(await c.req.json());
  exactKeys(body, ["backup", "passphrase", "confirmation_token", "confirm"]);
  if (body.confirm !== "RESTORE_BACKUP") invalid("请明确确认 RESTORE_BACKUP");
  const currentKey = credentialKey(c.env),
    confirmation = await readConfirmation(
      c.env,
      body.confirmation_token,
      c.get("auth")!.actor,
    );
  const { document, encrypted } = await readUpload(body),
    backupHash = await digest(document);
  if (!encrypted || !document.manifest.restorable) invalid("脱敏清单不可恢复");
  if (backupHash !== confirmation.backup_hash)
    throw new StorageError(
      "BACKUP_CHANGED",
      "恢复文件与预览不一致，请重新预览",
      409,
    );
  const current = await snapshot(c.env, false);
  if (
    current.document.manifest.data_hash !== confirmation.current_hash ||
    canonical(current.revision.active) !== canonical(confirmation.active)
  )
    throw new StorageError(
      "BACKUP_CHANGED",
      "预览后业务数据已变化，请重新预览",
      409,
    );
  // Capture expected revision BEFORE checking R2. A GC claim/removal between the
  // HEAD check and the exclusive restore must invalidate this exact revision,
  // even when the deletion marker has already disappeared by the time we lock.
  await verifyExternalObjects(c.env, document);
  const encryptedTables: Record<string, Row[]> = {};
  for (const table of BACKUP_TABLES) {
    // Legacy nullable passwords represent an empty credential, not an encryption bypass.
    const rows = document.tables[table].map((row) => ({
      ...row,
      ...Object.fromEntries(
        (table === "accounts"
          ? ["password"]
          : table === "platform_vault"
            ? ["password", "totp_secret"]
            : []
        )
          .filter((f) => row[f] === null)
          .map((f) => [f, ""]),
      ),
    }));
    encryptedTables[table] = await encryptCredentialRows(
      table,
      rows,
      currentKey,
    );
  }
  const result = await storageCall<BackupRestoreResult>(
    c.env,
    "/backup/restore",
    {
      tables: encryptedTables,
      expected: current.revision,
      backup_hash: backupHash,
      restore_id: await sha256(String(body.confirmation_token)),
    },
  );
  return c.json({ success: true, data: result });
});
export default app;
