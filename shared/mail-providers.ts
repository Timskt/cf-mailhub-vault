/** Fixed endpoints: an account cannot redirect credentials to a supplied URL. */
export const mailProviders = [
  {
    id: "mailtm",
    name: "Mail.tm",
    url: "https://mail.tm",
    docs: "https://docs.mail.tm/",
    api: "https://api.mail.tm",
    credentialLabel: "邮箱密码",
    description: "免费共享临时邮箱 API · 账号密码登录",
    integrationHint:
      "免费且无需 API Key；邮箱可能被服务商回收。与 Mail.gw 使用兼容 API，但账号和邮件互不共享，不能互作备份。",
    family: "mailtm-api",
    canCreate: true,
  },
  {
    id: "mailgw",
    name: "Mail.gw",
    url: "https://mail.gw",
    docs: "https://docs.mail.gw/",
    api: "https://api.mail.gw",
    credentialLabel: "邮箱密码",
    description: "免费共享临时邮箱 API · 账号密码登录",
    integrationHint:
      "免费且无需 API Key；邮箱可能被服务商回收。与 Mail.tm 使用兼容 API，但账号和邮件互不共享，不能互作备份。",
    family: "mailtm-api",
    canCreate: true,
  },
  {
    id: "mailslurp",
    name: "MailSlurp",
    url: "https://www.mailslurp.com",
    docs: "https://www.mailslurp.com/docs/api/",
    api: "https://api.mailslurp.com",
    credentialLabel: "MailSlurp API Key",
    description: "邮件测试平台 API · 需使用自己的 MailSlurp 账户",
    integrationHint:
      "面向自动化邮件测试。免费计划的 Inbox 为临时邮箱；保留额度、自定义域和邮件数量取决于账户计划。",
    family: "mailslurp",
    canCreate: false,
  },
  {
    id: "mailinator",
    name: "Mailinator Private",
    url: "https://www.mailinator.com",
    docs: "https://www.mailinator.com/documentation/docs/quickstart/",
    api: "https://api.mailinator.com",
    credentialLabel: "Mailinator API Token",
    description: "团队邮件测试 API · 私有域按地址读取",
    integrationHint:
      "面向 QA 与 CI 测试；私有域按团队计划和邮件额度运行。公共收件箱对所有人开放，平台会拒绝接入公共域。",
    family: "mailinator",
    canCreate: false,
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
