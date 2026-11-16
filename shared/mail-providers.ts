/** Fixed endpoints: an account cannot redirect credentials to a supplied URL. */
export const mailProviders = [
  {
    id: "mailtm",
    name: "Mail.tm",
    url: "https://mail.tm",
    docs: "https://docs.mail.tm/",
    api: "https://api.mail.tm",
  },
  {
    id: "mailgw",
    name: "Mail.gw",
    url: "https://mail.gw",
    docs: "https://docs.mail.gw/",
    api: "https://api.mail.gw",
  },
] as const;
export type MailProviderId = (typeof mailProviders)[number]["id"];
export const isMailProvider = (value: string): value is MailProviderId =>
  mailProviders.some((provider) => provider.id === value);
export interface ProviderAccount {
  id: number;
  provider: MailProviderId;
  address: string;
  remote_id: string;
  password: string;
  token: string;
  token_expires_at: string;
  credential_version: string;
  status: "active" | "disabled";
  auth_status: "unchecked" | "healthy" | "error" | "reauth_required";
  remark: string;
  last_checked_at: string;
  last_error: string;
  last_error_code: string;
  created_at: string;
  updated_at: string;
}
export type ProviderAccountSummary = Omit<
  ProviderAccount,
  "password" | "token" | "token_expires_at" | "credential_version"
> & { has_password: boolean };
export interface ProviderMail {
  id: string;
  subject: string;
  sender: string;
  sender_name: string;
  created_at: string;
  is_read: number;
  text_content: string;
  html_content: string;
  verification_code: string;
  verification_link: string;
  has_attachments: boolean;
}
