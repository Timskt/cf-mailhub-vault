export const API_DOC_MD = `# MailHub & Vault 系统 API 接口文档

- 文档版本：1.0
- 运行环境：Cloudflare Workers Serverless
- 数据存储：Cloudflare D1 SQLite
- 基础地址：部署域名前缀，如 \`https://vault.yourdomain.com\`
- 内容类型：\`application/json; charset=utf-8\`
- 字符编码：UTF-8

本文件由服务端直接暴露，供开发者或 AI Agent（Cursor、Claude Code、自动化脚本）一键解析调用。

---

## 接口总览

| 模块 | 方法 | 路径 | 用途 | 鉴权 |
| :--- | :--- | :--- | :--- | :--- |
| **基础** | \`GET\` | \`/healthz\` | 健康检查，返回纯文本 \`ok\` | 无 |
| **基础** | \`GET\` | \`/api-doc.md\` | 获取本文档 Markdown 原文 (AI/人类阅读) | 无 |
| **基础** | \`GET\` | \`/api-doc.json\` | 获取本文档结构化 JSON 定义 | 无 |
| **邮箱** | \`GET\` | \`/api/domains\` | 获取系统绑定的所有可用域名列表 | 无 |
| **邮箱** | \`POST\` | \`/api/mailbox/generate\` | 创建随机地址的临时邮箱 | 无 |
| **邮箱** | \`POST\` | \`/api/mailbox/custom\` | 创建指定前缀的自建域名邮箱 | 无 |
| **邮件** | \`GET\` | \`/api/emails/list\` | 获取某邮箱邮件列表（含自动提取的 verify_code） | 无 |
| **邮件** | \`GET\` | \`/api/emails/view/:id\` | 读取单封邮件正文（文本/HTML）并标为已读 | 无 |
| **极速** | \`GET\` | \`/api/external/code\` | 自动化极速获取最新验证码（通过 email 或 platform） | \`X-API-Key\` |
| **自动化**| \`POST\` | \`/api/external/register\` | 一键分配自建邮箱并直接写入平台台账 | \`X-API-Key\` |
| **台账** | \`GET\` | \`/api/vault\` | 获取所有平台账号注册资产台账 | 管理员 Cookie 或 API Key |
| **台账** | \`POST\` | \`/api/vault\` | 登记新平台账号（可联动生成新邮箱） | 管理员 Cookie 或 API Key |
| **台账** | \`GET\` | \`/api/vault/:id/code\` | ⚡ 一键提取该平台绑定的邮箱最新验证码 | 管理员 Cookie 或 API Key |
| **Outlook**| \`GET\`| \`/api/outlook/accounts\` | 列出所有托管的微软 Outlook 账号 | 管理员 Cookie 或 API Key |

---

## 核心接口调用示例

### 1. 自动化极速获取验证码
\`\`\`bash
# 直接获取某个平台最新验证码（优先读取台账绑定邮箱，再读最新邮件提取）
curl -H "X-API-Key: YOUR_API_KEY" "https://YOUR_DOMAIN/api/external/code?platform=OpenAI"

# 响应
{
  "success": true,
  "code": "849201",
  "link": "https://auth.openai.com/verify?token=xxx",
  "subject": "Your OpenAI verification code",
  "sender": "noreply@tm.openai.com",
  "received_at": "2026-11-11 14:30:00"
}
\`\`\`

### 2. 获取指定邮箱邮件列表（完全兼容 tempmail.jdyun.fun 规范）
\`\`\`bash
curl "https://YOUR_DOMAIN/api/emails/list?address=test_user@yourdomain.com"

# 响应
{
  "emails": [
    {
      "id": 12,
      "from": "verify@cursor.com",
      "to": "test_user@yourdomain.com",
      "subject": "Cursor Login Code",
      "received_at": "2026-11-11 14:35:00",
      "read": false,
      "dkim_verified": "通过",
      "verify_code": "589231"
    }
  ]
}
\`\`\`
`;

export const API_DOC_JSON = {
  version: "1.0",
  title: "MailHub & Vault API Documentation",
  base_url: "https://yourdomain.com",
  content_type: "application/json; charset=utf-8",
  endpoints: [
    { method: "GET", path: "/healthz", description: "Health check" },
    { method: "GET", path: "/api-doc.md", description: "Markdown API documentation for AI & Humans" },
    { method: "GET", path: "/api-doc.json", description: "Structured JSON API specification" },
    { method: "GET", path: "/api/domains", description: "List available Cloudflare domains" },
    { method: "POST", path: "/api/mailbox/generate", description: "Generate random mailbox" },
    { method: "POST", path: "/api/mailbox/custom", description: "Create custom prefix mailbox" },
    { method: "GET", path: "/api/emails/list", description: "List emails for address with verify_code" },
    { method: "GET", path: "/api/emails/view/:id", description: "View email body and HTML" },
    { method: "GET", path: "/api/external/code", description: "Extract OTP code by email or platform" },
    { method: "POST", path: "/api/external/register", description: "Allocate mailbox and register in vault" },
    { method: "GET", path: "/api/vault", description: "List platform account vault" },
    { method: "GET", path: "/api/vault/:id/code", description: "One-click fetch latest code for platform" }
  ]
};
