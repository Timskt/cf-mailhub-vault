export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  ADMIN_PASSWORD?: string;
  COOKIE_SECRET?: string;
  CF_DOMAINS?: string;
  DEFAULT_PREFIX?: string;
  API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export interface PlatformAccount {
  id: number;
  platform_name: string;
  platform_url: string;
  account_email: string;
  email_source: 'cf_domain' | 'outlook' | 'gptmail' | 'external';
  username: string;
  password: string;
  totp_secret: string;
  status: 'active' | 'pending' | 'banned' | 'deprecated';
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
  verification_code: string;
  verification_link: string;
  dkim_status: 'pass' | 'fail' | 'none' | 'unknown';
  spf_status: 'pass' | 'fail' | 'none' | 'unknown';
  is_read: number;
  is_pinned: number;
  is_protected: number;
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
