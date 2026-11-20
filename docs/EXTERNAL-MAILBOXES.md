# 外部临时邮箱接入

MailHub 支持 [Mail.tm](https://docs.mail.tm/)、[Mail.gw](https://docs.mail.gw/)、[MailSlurp](https://www.mailslurp.com/docs/api/) 和 [Mailinator](https://www.mailinator.com/documentation/docs/quickstart/) 官方 API。Mail.tm / Mail.gw 使用邮箱地址和密码；MailSlurp 接入已创建的 Inbox；Mailinator 只接入当前团队已验证的私有域地址。前端入口为「外部邮箱」，使用现有管理员登录；凭据加密保存在服务器。

## 来源选择

- **Mail.tm / Mail.gw**：免费共享临时邮箱，只建议短期测试。官方文档标注每个 IP 通用额度为 8 QPS；邮箱、域名和保留时间由服务商控制，可能被限流或回收。两者兼容同一 API 家族，但账号、邮件和可用性互不共享。MailHub 的 2026-11-17 生产检查曾观察到 Mail.tm 返回 429、Mail.gw 返回上游错误，见[发布验收](PRODUCTION-RELEASE-2026-11-17-PROVIDERS.md)。
- **MailSlurp**：邮件测试 API，可接入已有 Inbox。官方免费计划的 Inbox 仅临时保留；付费计划才包含固定数量的长期 Inbox，邮件量和自定义域另受计划限制。适合需要隔离测试收件箱的场景，不应当作免费的长期个人邮箱。
- **Mailinator Private**：QA/CI 邮件测试服务，使用自己的 Team API Token 和已验证私有域。官方 Verified Pro 页面列出 1 个私有域、每月 2,000 封、每天 60 封和 10 MB 存储；超出额度或存储上限会影响后续邮件。该服务并不提供个人邮箱式的无限收件保证。
- **自有域名 / Outlook**：长期管理平台注册账号时优先选择自己控制的收件域名或 Outlook 授权邮箱。外部临时邮箱服务无法保证第三方网站接受该域名，也无法恢复被服务商回收的地址。

MailSlurp 与 Mailinator 都是邮件测试产品，不适合作为 MailHub 的主力邮箱来源；目前仅保留为可选 QA 来源，不与自有域名或 Outlook 并列推荐。Mail.tm / Mail.gw 同样不是稳定邮箱，生产已观察到限流和上游错误。没有证据支持把另一个免费的公共临时邮箱称为稳定替代品；反复报错或回收地址时，应迁移至自己控制的收件域名或已授权 Outlook。

### 更稳定的替代路径

- **自有域名 + MailHub Email Worker（优先）**：使用 Cloudflare 管理 DNS 的域名创建地址，MailHub 通过 Email Worker 收件并保存邮件。Cloudflare Email Routing 要求 Cloudflare 作为权威 DNS；Cloudflare 默认路由本身是转发能力，MailHub 的收件归档依赖项目的 Worker 路由配置。适合需要长期保留地址、批量创建和掌控域名的场景。参考 [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/) 与 [Email Workers](https://developers.cloudflare.com/email-routing/email-workers/)。
- **EmailEngine（自托管，尚未接入）**：统一读取已有 IMAP、Gmail API 和 Microsoft Graph 邮箱，并负责重连与 OAuth 令牌刷新；可用于接入自己控制的邮箱，不负责创建新的公共临时邮箱。生产运行需要自托管服务、Redis 与加密配置，且需要订阅许可；费用以[当前官方计划](https://learn.emailengine.app/docs/licensing)为准。参考[账号 API](https://learn.emailengine.app/docs/api-reference/accounts-api)及[通用 IMAP](https://learn.emailengine.app/docs/accounts/imap-smtp)。
- **Nylas（托管式，尚未接入）**：适合少量已有邮箱的统一 API 接入，代价是授权与邮件数据交给第三方。官方当前免费层含 5 个连接账号，Essentials 含 10 个、额外账号按量计费；IMAP 邮件缓存为 90 天滚动窗口。价格会变化，部署前查看[官方价格](https://www.nylas.com/pricing/)和[Email API](https://developer.nylas.com/docs/v3/email/)。

EmailEngine 和 Nylas 都是已有邮箱聚合器，不是 Mail.tm / Mail.gw 的无缝替换：接入前需要为新来源设计独立凭据、授权、健康状态和邮件同步接口。目前 MailHub 尚未连接它们，也没有用真实账号验证其适配。

## 接入与管理

- **接入 Mail.tm / Mail.gw**：填写地址和现有密码。平台请求 `/token`，再以 `/me` 校验邮箱与服务商账号 ID，身份一致才保存。服务商之间的账号不互通，即使邮箱地址相同，也不能混用令牌。
- **创建 Mail.tm / Mail.gw 邮箱**：读取服务商当前公开且启用的域名，选择地址前缀，使用自动生成或自己填写的密码。创建操作先保留本地凭据，再创建服务商账号；成功后自动登录。域名不可达时显示重试并禁用创建。
- **接入 MailSlurp**：先在 MailSlurp 账户中创建 Inbox，再选择 MailSlurp、填写该 Inbox 地址和 API Key。平台按地址查找 Inbox 并验证身份；不会自动创建或删除 MailSlurp 资源。免费计划 Inbox 会过期；付费计划按保留 Inbox 数、收件量和自定义域收费，读取完整正文会按服务商 API 行为标记为已读。价格与限额以[官方计划页](https://app.mailslurp.com/pricing/)为准。
- **接入 Mailinator Private**：选择 Mailinator Private，填写私有域上的邮箱地址和 Team API Token。平台先读取 Token 所属团队的私有域列表，确认该地址域名属于团队且已验证，再按地址本地部分读取邮件。公共 Inbox 不会被接入；Token 使用 `Authorization` 请求头，不放入 URL。平台不创建或删除 Mailinator 资源。额度和永久存储会按团队计划限制，详见[官方价格](https://www.mailinator.com/pricing/)与[私有邮箱说明](https://www.mailinator.com/documentation/docs/core/privatemailbox/)。
- **请求失败**：创建有可能已经在服务商完成，因此不自动重试。已保存的本地账号会显示需处理和错误原因；返回列表「测试连接」，或在「编辑账号 / 查看密码」修正密码。若服务商明确拒绝了地址，可移除本地接入后改用其他地址。
- **测试连接**：检查服务商身份及第一页收件，成功才标为已连接。只保存登录凭据时显示待检查，停用、密码失效、服务不可达和限流分别反馈。超过一天未检查的关联平台显示需复查。
- **编辑账号**：直接回显保存的密码，可复制或隐藏。修改密码只更新本地登录凭据，不会修改服务商网站的密码；更新后清除缓存令牌，下一次查收重新登录。邮箱地址与服务商不可变。
- **移除接入**：只移除本地记录，不调用服务商删除邮箱。仍绑定平台账号时拒绝移除，先调整关联。

Outlook 修复和凭据编辑、平台账号编辑也直接显示已有密码。凭据通过受认证的单账号详情读取；列表、服务商统计和诊断汇总不返回密码或令牌。空密码明确表示尚未保存，无法从 Microsoft 授权恢复邮箱的登录密码。

## 收件与平台关联

「收件」打开分页收件箱，每页最多 30 封，可手动刷新或开启现有的 5/10/15 秒退避自动查收。阅读邮件支持纯文本和隔离 HTML：脚本、表单和外部图片禁用。Mail.tm / Mail.gw 和 Mailinator 的读取不会删除邮件；MailSlurp 的完整正文接口会按其 API 行为标记已读。附件目前在服务商网站查看。

「取码 / 链接」先获取最新一页最多 30 封摘要，按时间与发件人筛选，再读取最多 10 封完整正文，识别摘要中未显示的验证码和验证链接。关键词匹配完整正文。返回 `limited=true` 表示扫描窗口有限，可以缩小 `since/sender/q` 或打开收件箱翻页查看。平台不会自动访问提取的链接。

「登记平台账号」带入邮箱地址和当前服务商来源。平台账号的密码是所登记平台的登录密码；邮箱密码或 API Key 保存在外部邮箱账号中。关联后可从平台账号查看邮箱健康状态、打开外部邮箱、查收验证码。平台的手动账号状态与邮箱实时连接状态分别显示。

## API 与自动化

API 2.5.0 新增外部邮箱操作并支持 Mailinator Private 来源。完整字段、错误、授权与示例见 [OpenAPI](openapi.json) 和 [API 文档](API.md)，在线开发者中心可以搜索「外部邮箱」。

| 方法   | 路径                                                | 用途                                                         | API Key 权限    |
| ------ | --------------------------------------------------- | ------------------------------------------------------------ | --------------- |
| GET    | `/api/providers`                                    | 服务商与账号计数                                             | `admin`         |
| GET    | `/api/providers/{provider}/domains`                 | Mail.tm / Mail.gw 当前可用域名；其他服务商返回不支持创建邮箱 | `admin`         |
| GET    | `/api/providers/accounts`                           | 账号列表和筛选                                               | `admin`         |
| POST   | `/api/providers/accounts`                           | 接入或创建                                                   | `mailbox:write` |
| GET    | `/api/providers/accounts/{id}`                      | 详情与已保存密码                                             | `admin`         |
| PUT    | `/api/providers/accounts/{id}`                      | 更新本地凭据、备注和状态                                     | `mailbox:write` |
| DELETE | `/api/providers/accounts/{id}`                      | 移除本地接入                                                 | `mailbox:write` |
| POST   | `/api/providers/accounts/{id}/check`                | 校验身份与收件                                               | `mailbox:write` |
| GET    | `/api/providers/accounts/{id}/messages`             | 邮件分页                                                     | `admin`         |
| GET    | `/api/providers/accounts/{id}/messages/{messageId}` | 完整正文                                                     | `admin`         |
| GET    | `/api/providers/accounts/{id}/code`                 | 验证码与链接                                                 | `verify:read`   |

`admin` 范围包含其他操作权限，但仍执行邮箱/平台资源限制。受限密钥不能读取全局账号清单或创建无法预先限定的服务商账号，建议按账号 ID 调用。现有 `/api/automation/mailbox`、`/api/automation/verification`、批量验证、`/api/vault/{id}/code` 也支持外部来源。TypeScript/Python SDK 的验证目标支持 `source: "mailtm" | "mailgw" | "mailslurp" | "mailinator"`。同一地址关联多个来源时使用明确来源或 `vault_id`。

创建请求示例（所有值均为占位符，真实域名从域名接口取得）：

```json
{
  "provider": "mailtm",
  "mode": "connect",
  "address": "your-address@provider-domain.example",
  "password": "REPLACE_WITH_EXISTING_MAILBOX_PASSWORD",
  "remark": "开发测试"
}
```

写入推荐携带稳定的 `Idempotency-Key`。更新时提交详情中的 `credential_version` 防止覆盖并发编辑；后台请求写入令牌与健康状态也复查凭据版本、启停状态和账号是否仍存在。服务商返回 401 会转为业务凭据错误，不会把本平台管理员踢下线。

## 存储、续登与服务边界

新增 `0013_provider_accounts.sql`。`provider_accounts` 在统一存储模型末尾追加，D1、MySQL、MongoDB、Redis 都通过原有协调器访问和迁移。密码与缓存令牌加入既有凭据加密、轮换和便携备份；生产环境沿用已有加密密钥。

便携业务备份升级为 schema 12，共 13 张业务表。schema 10 和 11 文件先验证冻结的原结构与哈希，再确定性补齐新表。备份只保存邮箱身份和登录凭据，不下载服务商上的邮件，也不能恢复已被服务商删除的邮箱。详见 [备份与恢复](BACKUP-RECOVERY.md)。

令牌最多缓存 30 分钟；到期后用已存密码登录，若服务商提前拒绝缓存令牌则重新登录一次。请求按服务商在单 Worker 实例内间隔至少 160ms，跨实例限流以服务商 429 为准，不承诺跨出口统一 QPS。429、连接错误会停止自动查收，用户可稍后重试。

此集成不承诺邮箱永久存在，也不自动延长服务商保留期限。Mail.tm 和 Mail.gw 使用兼容 API，但账号和邮件不互通；当前没有自动同步或故障转移，不能把两个服务商账号当作冗余副本。请求在 Worker 实例内按 API 家族排队，并遵循上游 `Retry-After`；跨实例总 QPS 仍由服务商控制。MailSlurp 和 Mailinator 使用独立 API 与用户账户，但计划、额度和保留策略由对应账户决定。Mailinator 仅能验证并读取团队私有域；本平台不会接触公共收件箱。2026-11-17 的生产检查记录见 [发布验收](PRODUCTION-RELEASE-2026-11-17-PROVIDERS.md)。新 Mailinator 适配器使用虚构数据与模拟官方响应验证，没有使用真实 API Token 或真实邮箱，因此不宣称已验证生产可用率。真实服务遇到超时、429 或上游错误时会保留“连接异常”并展示重试时间，不会误报为凭据过期。
