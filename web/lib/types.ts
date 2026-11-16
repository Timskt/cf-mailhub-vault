export interface Reply<T> {
  success?: boolean;
  data: T;
  message?: string;
  total?: number;
  page?: number;
  limit?: number;
  summary?: Record<string, number>;
  next_cursor?: string;
  url?: string;
}
export interface Domain {
  domain: string;
  enabled: boolean | number;
  is_default: boolean;
  remark: string;
  source: string;
  dns_status: string;
  last_received_at?: string;
  last_checked_at?: string;
}
export interface Settings {
  default_prefix: string;
  mail_retention_days: string;
  token_refresh_batch: string;
  token_refresh_last_run?: string;
  has_api_key: boolean;
  domains: Domain[];
  oauth_configured: boolean;
  oauth_redirect_uri: string;
}
export interface Vault {
  id: number;
  platform_name: string;
  platform_url: string;
  account_email: string;
  email_source: string;
  username: string;
  password?: string;
  totp_secret?: string;
  has_password?: boolean;
  has_totp?: boolean;
  status: string;
  category: string;
  proxy_node: string;
  remark: string;
  last_code: string;
  last_code_at?: string;
  is_pinned: number;
  mailbox?: MailboxHealth;
  needs_attention?: boolean;
}
export interface MailboxHealth {
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
}
export interface VaultPlatform {
  definition?: PlatformDefinition;
  platform_name: string;
  count: number;
  attention_count: number;
  unchecked_count: number;
  connected_count: number;
  pinned_count: number;
  sources: string[];
  categories: string[];
}
export interface PlatformDefinition {
  name_key: string;
  name: string;
  url: string;
  category: string;
  remark: string;
  is_pinned: number;
  created_at: string;
  updated_at: string;
  account_count: number;
  managed: boolean;
}
export interface Organization {
  id: number;
  name: string;
  color: string;
  account_count: number;
}
export interface Outlook {
  id: number;
  email: string;
  client_id: string;
  refresh_token?: string;
  password?: string;
  group_id: number;
  group_name: string;
  tags: Organization[];
  auth_status: string;
  status: string;
  remark: string;
  platform_count: number;
  last_error: string;
  last_error_code?: string;
  last_checked_at?: string;
  last_token_refresh_at?: string;
  next_token_refresh_at?: string;
  token_refresh_status?: "pending" | "healthy" | "retrying" | "reauth_required";
  token_refresh_error?: string;
}
export interface Mailbox {
  id: number;
  address: string;
  domain: string;
  remark: string;
  is_permanent: number;
  expires_at: string;
  is_expired: boolean;
  associated_platform: string;
  mail_count: number;
  unread_count?: number;
  last_received_at?: string;
  created_at: string;
}
export interface Mail {
  id: string | number;
  subject: string;
  sender?: string;
  sender_name?: string;
  recipient?: string;
  created_at?: string;
  is_read?: number;
  is_pinned?: number;
  is_protected?: number;
  is_archived?: number;
  category?: string;
  rule_name?: string;
  text_content?: string;
  html_content?: string;
  spf_status?: string;
  dkim_status?: string;
  message_id?: string;
  raw_size?: number;
  raw_email?: string;
  has_raw?: boolean;
  verification_code?: string;
  verification_link?: string;
  auth_results?: string;
  from?: { emailAddress: { name: string; address: string } };
  body?: { contentType: string; content: string };
  bodyPreview?: string;
  receivedDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  attachments?: { id: string; name: string; size: number }[];
  attachment_error?: string;
}
export interface Code {
  scanned?: number;
  checked_at?: string;
  limited?: boolean;
  code?: string;
  link?: string;
  subject?: string;
  sender?: string;
  received_at?: string;
  message?: string;
}
export interface Preview {
  rows: {
    line: number;
    email: string;
    client_id: string;
    has_password: boolean;
    has_refresh_token: boolean;
    error?: string;
    warning?: string;
    duplicate?: boolean;
  }[];
  valid_count: number;
  error_count: number;
  duplicate_count: number;
}
export type PageName =
  | "vault"
  | "outlook"
  | "providers"
  | "mailboxes"
  | "inbox"
  | "rules"
  | "domains"
  | "api"
  | "settings"
  | "storage";
