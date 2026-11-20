export interface Env {
  DB: D1Database;
  STORAGE?: DurableObjectNamespace;
  STORAGE_ENCRYPTION_KEY?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS?: string;
  MAIL_OBJECTS?: R2Bucket;
  STORAGE_ALLOW_HTTP_LOCAL?: string;
  ASSETS?: Fetcher;
  ADMIN_PASSWORD?: string;
  COOKIE_SECRET?: string;
  CF_DOMAINS?: string;
  DEFAULT_PREFIX?: string;
  API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
}

export interface PlatformAccount {
  workspace?: string;
  account_identifier?: string;
  login_methods?: string;
  mailbox_address?: string;
  mailbox_link_state?: string;
  verification_sender?: string;
  verification_keyword?: string;
  registered_at?: string;
  last_verified_at?: string;
  expires_at?: string;
  id: number;
  platform_name: string;
  platform_url: string;
  account_email: string;
  email_source:
    | "cf_domain"
    | "outlook"
    | "gptmail"
    | "external"
    | "mailtm"
    | "mailgw"
    | "mailslurp"
    | "mailinator";
  username: string;
  password: string;
  totp_secret: string;
  status: "active" | "pending" | "banned" | "deprecated";
  category: string;
  proxy_node: string;
  remark: string;
  last_code: string;
  last_code_at: string;
  is_pinned?: number;
  created_at: string;
  updated_at: string;
}

export interface CfInboxMail {
  id: number;
  message_id: string;
  recipient: string;
  sender: string;
  sender_name: string;
  subject: string;
  text_content: string;
  html_content: string;
  raw_size: number;
  raw_object_key?: string;
  attachment_manifest?: string;
  verification_code: string;
  verification_link: string;
  dkim_status: "pass" | "fail" | "none" | "unknown";
  spf_status: "pass" | "fail" | "none" | "unknown";
  is_read: number;
  is_pinned: number;
  is_protected: number;
  is_archived: number;
  category: string;
  rule_name: string;
  expires_at: string;
  created_at: string;
}

export interface OutlookAccount {
  id: number;
  email: string;
  client_id: string;
  refresh_token: string;
  password?: string;
  group_id: number;
  remark: string;
  status: string;
  auth_status: "unchecked" | "healthy" | "reauth_required" | "error";
  last_checked_at: string;
  last_error: string;
  last_error_code: string;
  last_token_refresh_at: string;
  last_token_attempt_at: string;
  next_token_refresh_at: string;
  token_refresh_failures: number;
  token_refresh_status: "pending" | "healthy" | "retrying" | "reauth_required";
  token_refresh_error: string;
  created_at: string;
  updated_at: string;
}

export interface Group {
  id: number;
  name: string;
  description: string;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface Tag {
  id: number;
  name: string;
  color: string;
  created_at: string;
}

export interface TempMailbox {
  id: number;
  address: string;
  prefix: string;
  domain: string;
  expires_at: string;
  is_permanent: number;
  associated_platform: string;
  associated_vault_id?: number | null;
  remark: string;
  is_pinned?: number;
  mail_count?: number;
  created_at: string;
  updated_at: string;
}
