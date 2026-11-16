# MailHub & Vault

自托管的多域名收件箱、Outlook 工作区与平台账号台账。一个 Cloudflare Worker 提供前端、API、邮件接收和定时任务，默认使用 D1，支持切换到自托管 MySQL、MongoDB、Redis，并自动同步数据。前端采用 React、Tailwind CSS 与 shadcn/ui。

## 可以做什么

- **数据源热切换**：同类型多个实例、不同数据库类型、不同服务器，后台全量复制与增量追平，逐页校验后切换；中断恢复、保留原数据集。支持 D1 → MySQL → MongoDB → Redis → D1。[接入与迁移文档](docs/DATABASES.md)。

- **外部临时邮箱**：接入已有 Mail.tm / Mail.gw 账号或创建新邮箱，保存密码、令牌自动重登、分页收件、隔离阅读、提取验证码/验证链接，并关联平台账号；提供来源计数和异常修复入口。[接入说明](docs/EXTERNAL-MAILBOXES.md)。
- **账号密码回显**：Outlook 修复、Outlook 编辑、平台账号编辑和外部邮箱编辑弹窗直接显示已保存密码，支持隐藏与复制；账号列表仍只返回是否已存密码。
- **多邮件域名**：面板添加、停用、设置默认域名、备注用途，检查 MX/SPF，查看最近实际收件时间；生成邮箱时选择域名。兼容已有 `CF_DOMAINS` 配置。
- **Outlook 工作区**：自有微软应用自动回调、公共客户端手动授权码提取、绑定邮箱的授权修复、文本/CSV/JSON 批量导入、完整 JSON 导出、编辑凭据、连接测试、真实授权状态、分组和标签，以及批量移组、加/移除标签、启停和删除托管配置。
- **微软邮件阅读**：收件箱、垃圾箱、已删除、存档、已发送和全邮箱，搜索、分页、HTML/纯文本正文、附件下载、删除邮件。HTML 使用隔离 iframe，脚本和表单禁用，外部图片默认阻止。
- **Outlook 发信与回复**：明确授权 `Mail.Send` 后发送纯文本邮件、回复与小附件；失败保留草稿，持久幂等保护重试，同一账号共享发送频率限制。HTTP 202 表示微软接受请求，不表示已送达。
- **取码**：平台台账直接查收绑定的 CF 或 Outlook 邮箱；Outlook 检查最近 25 封收件箱和 25 封垃圾邮件，支持时间、发件人和关键词筛选，保存刷新后的令牌。授权失败与没有邮件分别反馈。
- **临时邮箱生命周期**：随机或自定义前缀、有效期延长、永久保留、平台绑定保护。过期/停用邮箱拒收后续邮件；保留地址记录，避免 Catch-all 自动复活已停用地址。
- **平台与账号管理**：独立创建零账号平台，管理官网、分类、备注与置顶，原子重命名和合并；账号按平台归档，服务端分页、来源与域名筛选。列表不返回密码、2FA 或 Outlook 令牌。
- **可复制的导入导出**：平台台账和 Outlook 支持固定文本、CSV、JSON，弹窗展示字段规则、示例、预览、复制与下载。单账号、已选账号、整个平台及当前筛选均可导出；导入先预览，有错误整批不写入。详见[账号交换规则](docs/ACCOUNT-TRANSFER.md)。
- **批量管理与动态口令**：平台抽屉支持卡片/紧凑表格、跨页选择、批量分类/状态/备注/置顶和选中项导出；本地计算 TOTP、生成随机密码，邮件详情可反查关联账号。
- **搜索与体验**：独立搜索防抖和请求顺序控制、数据库范围的全局搜索、桌面/手机布局、系统/浅色/深色主题、弹窗焦点管理与操作反馈。
- **自动等待与夜间阅读**：前台按 5/10/15 秒退避轮询，后台暂停，验证码等待最多三分钟；HTML 邮件独立夜间显示，保留隔离和外部图片控制。
- **自动化与运维**：带权限范围和有效期的 API Key、持久幂等请求、操作审计、签名 Webhook 与失败重试、定时 Outlook 续期、受保护邮件清理、可选 Telegram 通知，以及可重复浏览器 CI。
- **凭据与备份**：账号密码、Outlook 令牌、TOTP 和 Webhook 连接字段加密写入，支持旧密钥过渡与分批重加密；提供加密业务便携备份、预览和隔离数据集恢复。[恢复范围与运维步骤](docs/BACKUP-RECOVERY.md)。
- **原始邮件与附件**：可选私有 R2 绑定保存新到 CF 邮件的原始 EML，支持原文/附件下载与延迟回收；未配置 R2 时沿用原来的正文存储。

Mail.tm / Mail.gw 已通过官方 API 接入；GPTMail 和通用 external 仍是手动查收来源标记。当前不提供 IMAP/POP3 服务或多用户隔离。Cloudflare 与微软的配额、权限和服务条款仍然适用，运行费用取决于实际用量。

## 本地开发

需要 Node.js 22+、pnpm 11。使用独立本地配置，不读取你的生产 `wrangler.toml`：

```bash
pnpm install --frozen-lockfile
pnpm db:migrate:local
pnpm dev:seed                 # 可选：仅向本地数据库写入虚构示例数据
pnpm dev
```

打开 `http://localhost:8787`，本地管理员密码为 `local-mailhub-password`，本地 API Key 为 `local-mailhub-api-key`。这些值仅存在于 `wrangler.local.jsonc` 的开发配置。`.test` 域名不接收真实互联网邮件；示例微软令牌不能用于连接微软。

```bash
pnpm typecheck
pnpm test                    # 实际本地 D1 + 模拟微软响应，不使用真实邮箱凭据
pnpm build                   # 独立本地配置的 Worker dry-run，不发布
pnpm exec playwright install chromium
pnpm test:e2e                # 独立临时 D1、虚构数据；微软发送请求被模拟
pnpm audit --prod --registry=https://registry.npmjs.org
```

## 首次部署

自动方式：

```bash
pnpm install --frozen-lockfile
pnpm exec wrangler login
bash deploy.sh 'example.com,mail.example.net' 'vault.example.com'
```

脚本会运行检查，首次创建/复用 `mailhub-vault-db`，生成配置，通过 Workers Secrets 上传初始化凭据，执行**全部**数据库迁移，然后部署。密码使用隐藏输入；留空自动生成。首次凭据保存在权限为 `0600` 的 `.mailhub-initial-credentials.json`，不会打印到部署日志；保存到密码管理器后删除该文件。如果初次上传 Secrets 失败，`.mailhub-bootstrap.json` 会保留供重试。两个文件均被 Git 忽略。

已有 `wrangler.toml` 时，脚本保留配置和 Secrets。若存在尚未完成的 `.mailhub-bootstrap.json`，会先恢复该次初始化上传。脚本只在你主动执行时修改生产资源。

也可手动部署：

```bash
cp wrangler.toml.example wrangler.toml
pnpm exec wrangler d1 create mailhub-vault-db
# 将数据库 ID 写入 wrangler.toml；设置邮件域名和可选面板访问域名。
pnpm exec wrangler secret put ADMIN_PASSWORD
pnpm exec wrangler secret put COOKIE_SECRET
pnpm exec wrangler secret put STORAGE_ENCRYPTION_KEY # 至少 32 位随机字符
pnpm exec wrangler secret put API_KEY             # 可选：供自动化脚本使用
pnpm exec wrangler d1 migrations apply DB --remote
pnpm deploy
```

密码建议至少 10 位，COOKIE_SECRET 使用随机值。不要把 Secrets 写入 `[vars]`。`routes` 是 TOML 根级配置，需放在 `[assets]` 等表配置之前。面板访问域名和邮件接收域名是两个独立配置。

## 接入多个邮件域名

1. 在「域名管理」添加 `example.com`、`mail.example.net` 等域名，也可在部署变量 `CF_DOMAINS` 中用逗号列出初始域名。
2. **对每个域名分别**在 Cloudflare 启用 Email Routing，按控制台要求添加 MX/TXT 等记录。
3. 设置每个域名的 Catch-all 为「发送到 Worker」，目标选**同一个** `cf-mailhub-vault`。
4. 回到面板检查 DNS，从其他邮箱发送测试邮件，确认显示实际收件时间。
5. 选择默认域名；创建临时邮箱、在台账生成邮箱或自动化注册时，可以指定任一已启用域名。

面板保存配置和 DNS 检查不会代替 Cloudflare 路由配置。DNS 就绪只代表查询到的 MX/SPF 满足检查条件；Catch-all 必须正确指向 Worker。停用域名后停止分配并拒绝新投递，已有邮件保留，仍可筛选查看。子域的 Email Routing 支持取决于 Cloudflare 控制台中对应的邮件路由配置。

## Outlook 接入

**已有 Refresh Token**：在 Outlook 工作区导入，Client ID 必须对应令牌的签发应用。标准文本格式：

```text
user@outlook.com----密码可空----Client ID UUID----完整 Refresh Token----可选备注
```

支持空密码、CSV 表头、制表符、TXT、JSON 数组和本系统导出的 JSON。每批最多 200 条 / 1 MiB，复杂密码/备注优先使用 JSON。预览只校验格式，不代表授权有效；导入后可批量测试连接。重复处理默认“跳过已有”，可选择“更新凭据与分组”。系统兼容旧版省略 Client ID 的数据，但兼容值不能保证适用于你的令牌，应优先明确填写原始 Client ID。

**微软登录授权**：注册自己的 Microsoft Entra **Web 应用**，支持个人及组织账号；配置委派权限 `User.Read`、`Mail.ReadWrite` 与 `offline_access`，然后设置：

```bash
pnpm exec wrangler secret put MICROSOFT_CLIENT_ID
pnpm exec wrangler secret put MICROSOFT_CLIENT_SECRET
```

将「设置 → Microsoft 连接」显示的地址加入该应用的 Web 重定向 URI，例如：`https://vault.example.com/api/outlook/oauth/callback`。在 Outlook 工作区点击「连接微软账号」，打开「连接 Outlook 邮箱」弹窗并选择自动回调；实际访问的面板域名必须与回调域名匹配。授权使用 PKCE，state 只可使用一次并绑定当前管理员会话，回调页通知原面板后自行关闭窗口。组织可能要求管理员同意；应用 Secret 过期需要更新。

**手动授权与修复**：连接/修复面板也支持公共客户端授权码提取，默认使用 Thunderbird 公共 Client ID。回调固定为 `https://localhost`，必须已在所选应用注册；授权后立即复制完整回调网址，手动关闭授权页，再回原面板粘贴兑换。不使用 Client Secret，也不能复用本实例配置的 Web Client ID。state 有效 10 分钟，微软 code 通常约 1 分钟；兑换失败后需重新发起。公共应用可能受同意策略限制，推荐自有应用作为替代。

修复会核验 Graph 返回的邮箱，保留原账号的密码、备注、分组、标签、平台关联和启停状态。成功保存后先测试收件；需要复制凭据时单独「查看 / 复制配置」。仅有 IMAP 权限不保证可读 Graph 邮件，发信需要单独勾选 `Mail.Send`，默认不申请。完整步骤、选错邮箱与过期处理见 [Outlook 授权与修复](docs/OUTLOOK-AUTHORIZATION.md)。

每 15 分钟处理 1–8 个最早到期的账号。成功续期后安排约 6 小时再次刷新；队列积压时依次处理，临时故障按 15 分钟至 6 小时退避重试。请求包含 `offline_access`，微软返回的新 Refresh Token 会在继续操作前保存，并防止覆盖并发导入的新凭据。后台续期只刷新令牌，不读取邮件；页面分别显示连接状态、最近续期、下次尝试及失败原因。停用和明确要求重新授权的账号跳过；微软主动撤销授权或 SPA 令牌的固定期限不能靠定时任务无限延长。详见 [Outlook 续期说明](docs/OUTLOOK-RENEWAL.md)。

删除托管配置不会删除微软账号，也保留平台台账。**邮件阅读器中的“删除邮件”会操作真实微软邮箱**；已删除文件夹内的邮件可能进一步移除。只有 Mail.Read 权限的历史令牌可以阅读，但删除会报告权限不足。

## 自动化 API

开发者中心包含 138 个 HTTP 操作的搜索目录、接口详情抽屉、cURL / JavaScript / Python 示例、工作流与邮箱接入诊断，契约版本 2.5.0 新增手动授权兑换及安全修复诊断。设置中可创建有有效期、权限范围以及邮箱/平台限制的自动化密钥，按最小权限选择 `verify:read`、`mailbox:write`、`vault:read`、`vault:write` 或 `admin`。密钥、审计、备份、数据源、凭据和 Webhook 管理及微软 OAuth 要求有效管理员会话，`admin` 子密钥也不能代替会话。请求头支持 `X-API-Key` 或 `Authorization: Bearer`，不接受 URL 密钥；显式密钥鉴权优先于 Cookie。

完整接入步骤见 [开发者指南](docs/API.md)。部署后提供 `/openapi.json`（OpenAPI 3.1）、`/postman.json`、`/llms.txt`、`/llms-full.txt`、`/api-doc.md`；保留 `/api-doc.json` 目录兼容。接口定义位于 `shared/api-contract.ts`，运行 `pnpm docs:generate` 更新仓库文档，`pnpm docs:check` 防止文档过期。

[TypeScript 与 Python SDK](docs/SDK.md)提供接入诊断、查收/等待、登记、发送/回复及 Webhook 验签；源码分发、无第三方运行依赖。等待最多 180 秒，写入不自动重试，便于脚本和 AI 工具正确处理未知结果。

新增统一查收 `POST /api/automation/verification`、批量查收 `/api/automation/verification/batch`（每批 5 项、逐项错误及重试建议）、邮箱诊断 `/api/automation/mailbox`、能力发现 `GET /api/capabilities`、原子批量整理 `POST /api/vault/batch`（最多 100 项）。域名邮件支持 `since` 增量查询及 `mark_read=false` 只读正文；响应携带 `X-Request-ID`。

```bash
curl 'https://vault.example.com/api/automation/verification' \
  -H 'X-API-Key: YOUR_API_KEY' -H 'Content-Type: application/json' \
  -d '{"email":"user@outlook.com","since":"2026-11-15T00:00:00Z","sender":"auth"}'

curl 'https://vault.example.com/api/external/register' \
  -H 'X-API-Key: YOUR_API_KEY' -H 'Content-Type: application/json' \
  -d '{"platform_name":"Example","domain":"mail.example.net","remark":"开发测试"}'
```

统一查收在 JSON 中提供 `email`、`vault_id`、唯一的 `platform` 三者之一，可用 `since`（带时区的 ISO 8601）、`sender`、`q` 筛选。无结果返回 `data.outcome=empty`；授权或网络失败返回错误，不等同“暂无邮件”。建议固定操作开始时刻作为 since，每 10 秒轮询，最多 3 分钟。批次 HTTP 200 还须检查每项 success。自动登记、发送和恢复等写入支持持久化 `Idempotency-Key`；同一 Key 必须使用相同身份、路径和请求体。收到 `IDEMPOTENCY_UNKNOWN` 后先核对结果，不要自动换 Key 重做。具体支持范围见接口契约。

旧版 `/api/mailbox/*`、`/api/emails/*` 保留响应形状，**现在也要求管理员 Cookie 或 API Key**，旧的无鉴权脚本需要补上请求头。台账、Outlook 账号、临时邮箱和 CF 邮件列表现在返回 `data/page/limit/total`，默认每页 30 条。

## 从旧版升级与备份

先保留现有 `wrangler.toml` 和 Secrets，备份 D1：

```bash
pnpm exec wrangler d1 export DB --remote --output=output/backup-before-upgrade.sql
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm exec wrangler d1 migrations apply DB --remote
pnpm deploy
```

请先创建本地 `output/` 目录。0001/0002 使用 `IF NOT EXISTS`，兼容旧版直接用 `d1 execute` 初始化但没有迁移记录的部署。0003 添加授权健康状态、多域名、OAuth 和登录限流表，并为已有平台绑定邮箱补齐永久保护，不删除账号或邮件。0004 增加可切换数据集的元数据与行存储。要启用多数据源，还需按 [数据库部署文档](docs/DATABASES.md) 加入 STORAGE 绑定及加密 Secret；现有生产配置不会被脚本覆盖。后续使用 migrations apply，避免手工重复执行含 ALTER TABLE 的 0003。

平台台账与 Outlook 可分别导入导出 TXT、CSV、JSON；这些文件包含凭据，请妥善保存。独立平台目录使用增量迁移 0011，保留已有账号与邮件。设置中的加密业务便携备份包含 12 张业务表及有限偏好，最多 1,000 行/1 MiB 明文，恢复需先预览，再写入新 D1 数据集、校验并切换，保留原数据集。它不含 R2 文件、完整协调器控制态、环境 Secrets 或认证/审计/事件记录；全站灾备还需要数据库原生备份与配套文件和密钥。[备份与恢复文档](docs/BACKUP-RECOVERY.md)列出具体步骤和边界。回退旧代码前先确认旧版接口鉴权与数据库兼容性，不要通过删除数据表来回退。

## 数据与边界

- 管理员 Cookie 有效期 7 天，HttpOnly / SameSite=Lax，HTTPS 下 Secure；修改密码使其他会话失效。历史 SHA-256 密码在成功登录时迁移至加盐 PBKDF2。未配置密码时关闭管理员访问，不提供默认生产密码。
- 配置凭据加密密钥后，敏感字段加密入库；服务端仍需解密供授权用户使用，因此不是零知识密码管理器。原生备份与历史明文也需受控保管。密钥轮换和恢复依赖见备份文档。
- 无 R2 时 CF 来信上限 2 MiB；配置私有 `MAIL_OBJECTS` R2 绑定后为 20 MiB，保存原始 EML 并按需解析附件。正文分别最多保存 500,000 字符。旧邮件不会补出未保存的原文。Outlook 附件通过微软读取，不存入应用数据库。
- 永久邮箱、绑定平台的 CF 邮件、置顶邮件受自动/批量清理保护。显式删除单封邮件仍会删除该邮件。解除平台绑定后邮箱继续保持永久，若需清理，再手动取消永久状态。
- SPF/DKIM 显示来自邮件头的报告，本程序不自行完成签名验证，不据此保证邮件真实。
- Telegram Secrets 为 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`，仅在你配置后推送 CF 新邮件提示。

前端源码在 `web/`，`public/` 是 Vite 构建产物，不入库；所有预览与部署命令会先构建前端。数据库连接服务在 `connector/`，数据库接口和迁移协调器在 `src/storage/`。

设计借鉴、功能差异与验证说明见 [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md)。所有新功能独立实现；项目许可证为 MIT。

## 收件工作流

支持域名来信自动分类、可预览的收件规则、邮件归档与批量处理，以及跨域名批量分配邮箱和用途记录。使用步骤、API 与数据兼容范围见 [收件规则与邮箱分配](docs/MAIL-WORKFLOWS.md)。

## 平台账号概览

按平台汇总账号、问题和待检查数量，用详情抽屉管理同平台的多账号。登记状态与邮箱连接状态分别显示；未接入 Outlook 账号池、停用、授权失效及续期失败提供对应的处理入口。详见 [平台账号与连接状态](docs/PLATFORM-ACCOUNTS.md)。
