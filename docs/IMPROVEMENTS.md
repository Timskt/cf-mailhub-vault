# 本轮改进记录

本次先读取 Antigravity 会话 `f7232b8c-9ed7-4a45-af5c-586ef0497e7e` 的本地记录，再检查当前工作区代码。实现以仓库最新代码为准，历史会话中的密码、密钥及真实邮箱凭据未写入新增代码或测试。

## 2.2 增量实现

在 `PRODUCT-INNOVATION-PROPOSAL.md` 的建议基础上，已补齐平台批量整理、紧凑表格、TOTP/密码生成、邮件与账号关联、可停止的前台轮询和 HTML 夜间阅读。Outlook 增加纯文本发送/回复、小附件、显式发信授权、账号频控和失败草稿保留；不会自动发送或将微软接受请求误报为送达。

设置页增加权限密钥、凭据加密/重加密、审计、签名 Webhook、投递历史/重试及加密业务备份恢复。业务写入的幂等结果持久化；未知结果阻止盲目重做。原始 CF 邮件及附件通过可选私有 R2 保存，垃圾回收以数据库中的引用认领保护并发。119 个 HTTP 操作及事件接收契约统一生成开发者文档。

备份恢复采用预览、确认、写入独立 D1 数据集、校验后切换的流程；容量为 1,000 行/1 MiB 明文。完整 DO 控制态、R2 文件及环境 Secrets 仍需配套原生备份，具体限制见 [BACKUP-RECOVERY.md](BACKUP-RECOVERY.md)。设计建议书属于需求探索，里面的“零停机”“零成本”“消除所有漏识别”等表述不是已实现能力或服务保证。

浏览器核心流程已放入 `tests/e2e/workspace.spec.ts` 并接入 CI；通过独立临时数据库验证，不操作真实用户邮箱。Microsoft 发信、权限错误及故障恢复在测试中使用模拟响应。

## 需求探索及取舍

| 来源 / 用户需求                                      | 吸收的能力                             | 本项目中的实现                                                                         |
| ---------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------- |
| cf-outlook-email：账号导入、分组、标签与批量管理     | 将账号管理从简单列表变成可运营的工作区 | 服务端统一解析、预览脱敏、重复策略、批量测试/移组/标签/启停/删除、真实连接状态         |
| cf-outlook-email：微软授权、文件夹、分页、正文、附件 | 完整的邮件阅读路径                     | 自有 Web 应用 OAuth+PKCE、Graph 文件夹与游标、HTML 隔离阅读、附件流式下载与邮件删除    |
| SimpleLogin：自定义域名、随机/自定义别名和用途记录   | 一个部署承载多个使用场景               | DB 与现有环境配置兼容，默认/停用/用途备注、选择域名生成、DNS 诊断与实际投递时间        |
| addy.io：标签、过滤与批量组织                        | 管理大量邮箱时减少重复操作             | Outlook 分组标签与批量操作，平台台账的来源/域名筛选、跨库搜索                          |
| 原项目的平台资产台账                                 | 将邮箱与账号用途关联                   | Outlook 显示绑定数量并跳至平台记录、台账直接取码、绑定 CF 地址永久保护                 |
| 用户报告搜索框自动出现 sky                           | 减少凭据自动填充误识别与异步查询混乱   | 独立登录用户名字段、search 输入/密码管理器提示、独立防抖和请求序号、启动清空搜索默认值 |

参考仓库的公开 README 和功能结构用于比较需求，未复制其 GPL 实现代码。搜索自动出现 sky 未发现硬编码根因；浏览器/扩展自动填充是推断。已在本地浏览器确认空搜索初始值、用户输入和切换模块时行为正常；仍需在原来安装了相同扩展的浏览器中确认是否完全消失。

## 关键修复

- 兼容邮箱接口加入管理员/API Key 鉴权；拒绝跨站写入；移除生产默认密码和可预测签名 Secret；拒绝用密码哈希直接登录；增加登录失败限流。
- Outlook 列表/导入预览不返回密码或令牌；台账列表不返回密码/2FA；API Key 仅在明确复制时读取。
- Token 刷新逻辑复用，台账、外部 API、阅读、检查、定时任务均保存轮换值。CAS 避免旧请求覆盖手工导入的新令牌。健康状态反映实际结果，失败不伪装成空收件箱。
- 取码检查近期多封邮件和垃圾箱，支持 since/sender/q；Graph 搜索避免不兼容的 orderby；nextLink 验证微软源站和目标邮件集合，保持不透明分页参数。
- 生成邮箱的所有入口使用同一域名验证与生命周期记录。过期/停用地址拒收，手动销毁保留过期记录，阻止 Catch-all 自动复活。
- 自动/手动批量清理尊重永久、平台绑定、置顶状态；接收失败不静默吞掉；邮件去重同时支持没有 Message-ID 的重试。
- 前端重写为 React 19、Tailwind 4 和 shadcn/ui（Radix nova）：Sidebar、Dialog、Command、表单、表格、卡片、通知统一组件；HTML 邮件清理与隔离，退出登录中止请求并清理私人内容。
- 使用灰白/青绿与深色主题重新设计页面；桌面表格、移动端卡片与折叠导航，统一间距与字体。列表服务端分页，搜索覆盖数据库；支持中文输入法、键盘导航和减少动画。
- 部署执行全部迁移、保留现有配置、Secrets 不写入 TOML，提供独立本地配置、示例数据和 CI。

## 弹窗专项修复

根据收件与验证码弹窗的实际复现，修正 shadcn 默认工具类覆盖业务布局的问题。所有业务弹窗统一使用固定标题、滚动正文和独立操作区；修复双列表单、数据源按钮间距、移动端阅读器返回栏、长文本/附件、全局搜索双重滚动和手机导航初始焦点。详细组件约定与检查范围见 [DIALOGS.md](DIALOGS.md)。

再次逐按钮检查后，补上收件错误卡片内边距和重试按钮分行、全部表单内联错误、复制就地反馈、附件失败重试。修复批量操作失败丢失勾选、取消同步失败仍关闭确认框、连接状态残留、Connector 401 误触发退出登录、搜索重试丢失焦点、末页删除后页码无效等交互问题。实际操作与模拟边界记录在 [UI-AUDIT.md](UI-AUDIT.md)。

## 多数据库与热切换

- 全部业务模块改用统一结构化查询与事务接口，SQLite SQL 集中到 D1 adapter。
- 自托管 HTTP Connector 接入真实 MySQL、MongoDB 与 Redis；数据库原生凭据仅放在连接服务器。
- 每个数据源有独立 ID，支持同类多个实例、异构数据库和服务器迁移。
- Durable Object 作为唯一写入协调器，持久化提交意图、复制游标和增量日志。复制期间允许正常业务写入，最终校验阶段短暂停写。
- 新数据集隔离写入，保留源数据；版本 CAS、幂等提交、主键序列迁移、删除重放、逐页内容摘要校验、失败暂停与恢复。
- 管理面板显示真实进度，关闭浏览器不影响 alarm 任务。连接令牌 AES-GCM 加密，数据源管理仅接受管理员 Cookie。
- 已执行真实链路 D1 → MySQL → MongoDB → Redis 服务器 A → Redis 服务器 B → D1；测试包括迁移期间增删改、完整内容及版本比较。详见 [DATABASES.md](DATABASES.md) 与 [架构决策](STORAGE-ARCHITECTURE.md)。

## 验证方法

`pnpm test` 使用 Miniflare 的真实本地 D1 执行当前迁移及路由测试。Microsoft Token/Graph 使用可控模拟响应，验证令牌轮换、垃圾箱取码、附件、分页、权限错误和 OAuth state。测试不发送真实邮件；此前用户授权的生产续期与收件验证单独记录在发布文档中。

`pnpm typecheck`、`pnpm format:check`、`pnpm build` 的 Worker dry-run 以及依赖审计组成可重复的检查。浏览器检查使用本地虚构数据，重点检查登录、搜索、分页、域名切换、批量导入、邮件阅读、弹窗叠放和手机布局。Outlook 阅读器的浏览器邮件数据为模拟响应；真实微软联调需要部署后配置自有应用及有效账号。

## 边界与后续方向

当前覆盖账号、邮件、域名、台账、发送/回复与部署的核心流程。尚未实现 IMAP、第三方公共邮箱适配器、多用户权限隔离、Outlook 邮件推送订阅或全站国际化。平台 JSON 与 Outlook JSON 不代替当前数据库与协调器的完整备份。大量账号的持续同步可进一步引入 Queues 与单独的任务状态，避免扩大单次 Worker 的网络请求预算。

## 资料

- [shadcn/ui](https://ui.shadcn.com/docs)
- [cf-outlook-email](https://github.com/roseforyou/cf-outlook-email)
- [SimpleLogin 创建别名](https://simplelogin.io/docs/getting-started/create-alias/)
- [addy.io 标签管理](https://addy.io/help/creating-and-managing-alias-labels/)
- [Cloudflare Email Workers 配置](https://developers.cloudflare.com/email-routing/email-workers/enable-email-workers/)
- [Cloudflare 邮件路由地址](https://developers.cloudflare.com/email-routing/setup/email-routing-addresses/)
- [Cloudflare Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Microsoft Graph 邮件列表](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0)
- [Microsoft Graph 分页](https://learn.microsoft.com/en-us/graph/paging)
- [Microsoft Graph 搜索](https://learn.microsoft.com/en-us/graph/search-query-parameter)
- [Microsoft 授权码流程](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Microsoft Refresh Token](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)
