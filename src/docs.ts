import { API_VERSION, operations } from "../shared/api-contract";
import { developerGuide } from "../shared/api-guides";

// Preserve the legacy JSON catalog shape while deriving every operation from the contract.
export const API_DOC_JSON = {
  version: API_VERSION,
  title: "MailHub & Vault API",
  content_type: "application/json; charset=utf-8",
  authentication: {
    header: "X-API-Key: YOUR_API_KEY",
    alternative: "Authorization: Bearer YOUR_API_KEY",
    note: "主密钥具有业务管理员权限；数据源和 OAuth 要求管理员 Cookie。",
  },
  pagination: {
    query: ["page", "limit"],
    response: ["data", "page", "limit", "total"],
    default_limit: 30,
    max_limit: 100,
  },
  code_filters: {
    email: "精确邮箱",
    platform: "唯一平台名",
    since: "带时区的 ISO 8601",
    sender: "发件人关键词",
    q: "邮件关键词",
  },
  limits: {
    outlook_import_accounts: 200,
    outlook_import_bytes: 1048576,
    bulk_check_accounts: 10,
    bulk_action_accounts: 50,
    graph_page_size: 50,
    max_incoming_mail_bytes: 2097152,
    verification_batch: 5,
    vault_batch: 100,
  },
  folders: [
    "inbox",
    "junkemail",
    "deleteditems",
    "sentitems",
    "archive",
    "all",
  ],
  documents: {
    openapi: "/openapi.json",
    guide: "/api-doc.md",
    llms: "/llms.txt",
    postman: "/postman.json",
  },
  endpoints: operations.map((o) => ({
    method: o.method.toUpperCase(),
    path: o.path.replace(/\{(\w+)\}/g, ":$1"),
    description: o.description,
    auth: {
      public: "无",
      key: "X-API-Key / Bearer",
      admin: "管理员 Cookie 或 X-API-Key / Bearer",
      cookie: "管理员 Cookie",
    }[o.auth],
    operation_id: o.operationId,
    effects: o.effects,
  })),
};
export const API_DOC_MD = developerGuide("http://localhost:8787");
