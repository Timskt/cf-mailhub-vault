# Outlook 授权、连接与修复

在 Outlook 工作区点击「连接微软账号」，打开「连接 Outlook 邮箱」弹窗；修复已有账号时，从该账号打开「修复 Outlook 授权」。也可从「设置 → Microsoft 连接」点击「打开 Outlook 授权工具」。两种授权方式都由你在 Microsoft 登录页选择邮箱并同意权限；MailHub 使用 PKCE 保存授权，随后需要测试实际收件连接。

修复已有账号时，应从该账号的修复入口开始。服务端会绑定账号 ID 与邮箱，并核验 Microsoft Graph profile 返回的邮箱。成功后成对更新 Client ID 和 Refresh Token，保留原密码、备注、分组、标签、平台关联以及启用/停用状态。授权成功的 `auth_status` 为 `unchecked`；停用账号还需要单独启用。

## 选择授权方式

| | Web 自动回调 | 手动授权码提取 |
| --- | --- | --- |
| API mode | `web`，省略时默认 | `manual` |
| 微软应用 | 你自己的 Microsoft Entra Web 应用 | 公共客户端，可选自己的应用 |
| Client ID | 服务端 `MICROSOFT_CLIENT_ID` | 面板中填写；默认 Thunderbird 公共客户端 ID |
| Client Secret | 配置在服务端 | 不使用、不提交 |
| 重定向 URI | 当前面板域名的 `/api/outlook/oauth/callback` | 固定 `https://localhost`，必须已在所选公共应用注册 |
| 完成方式 | 服务器保存后，回调页通知原面板并自行关闭窗口 | 复制最后的回调网址后手动关闭授权页，回到原面板粘贴并兑换 |

手动方式默认 Client ID 为 `9e5f94bc-e8a4-4e73-b8be-63364c29d753`。这是应用标识，不是客户端密钥，也不保证每个邮箱或租户都能同意本应用请求的权限。微软、应用配置或组织策略可能拒绝公共客户端授权；**推荐使用自己的应用作为替代**，配置合适的账号类型、委派权限和重定向 URI。可以使用自己的公共客户端，也可以切换到自己的 Web 应用。

本实例已配置为 `MICROSOFT_CLIENT_ID` 的 Web 应用不能用于 `manual`；请选择自动回调，或另一个正确注册的公共客户端。不要把 Web 应用的 Secret 填到手动面板，也不要假设任意公共 Client ID 都支持 `https://localhost`。

## Web 自动回调操作

1. 在 Microsoft Entra 注册自己的应用，按需要支持个人 Microsoft 账号及组织账号。配置 Microsoft Graph 委派权限 `User.Read`、`Mail.ReadWrite`，并允许请求 `offline_access`。仅在需要发信时增加 `Mail.Send`。
2. 注册 **Web** 重定向 URI，例如 `https://vault.example.com/api/outlook/oauth/callback`。应与实际打开面板的域名一致，可核对「设置 → Microsoft 连接」显示的地址。
3. 配置服务端 Secrets：

   ```bash
   pnpm exec wrangler secret put MICROSOFT_CLIENT_ID
   pnpm exec wrangler secret put MICROSOFT_CLIENT_SECRET
   ```

4. 登录面板管理员账号，打开连接/修复面板并选择自动回调。需要发信时再勾选发信权限。
5. 打开 Microsoft 授权窗口，核对并选择目标邮箱，完成登录与同意。允许本站弹出授权窗口，保留原管理员会话；回调页向原面板发送结果后会自行关闭授权窗口。
6. 返回面板看到「授权凭据已保存」后，点击「测试连接」。需要时打开邮箱；需要复制凭据时再选择「查看 / 复制配置」。

Secret 只保存在服务端；过期后需要由应用管理员更新。组织账号可能要求管理员同意或额外验证。自动回调使用 PKCE 和一次性 state，并在服务器核验邮箱；不会把 Access Token 或 Refresh Token 发给弹窗父页面。

## 手动授权码提取操作

1. 使用浏览器管理员会话打开连接/修复面板，选择手动授权。核对目标邮箱和公共客户端 ID；若使用自己的应用，先在应用中注册固定回调 `https://localhost`。
2. 只在需要发送或回复邮件时勾选发信权限，再打开 Microsoft 授权页。不要自行替换授权链接中的 state、redirect_uri 或 PKCE 参数。
3. 在 Microsoft 页面选择目标邮箱并同意权限。完成后地址栏会跳到类似下面的网址：

   ```text
   https://localhost/?code=本次授权码&state=本次会话标识
   ```

4. 如果本机没有对应服务，页面显示无法连接是可能出现的结果。只要地址栏已经包含本次的 `code` 与 `state`，立即复制**完整地址栏网址**，然后手动关闭授权页，回到原面板粘贴并兑换；不需要为此启动 localhost 服务或打开其他网址。
5. 也可仅粘贴 `code` 的值；支持 URL 编码的 code。不要粘贴 `code=...&state=...` 查询片段。完整 URL 能同时校验回调地址和 state，优先使用完整 URL。
6. 保存成功后测试连接；需要凭据时单独查看/复制配置。

手动模式请按「复制回调 → 关闭授权页 → 返回原面板粘贴」完成。Chrome 等浏览器在跨站跳转后可能使原面板无法代为关闭授权窗口，因此需要你手动关闭；保留原来的 MailHub 面板，以继续当前授权会话。

**本地授权会话有效 10 分钟，Microsoft 授权码通常约 1 分钟过期。** 面板会话仍有效不表示旧 code 还能兑换，请拿到 code 后立即完成。两种授权都绑定发起时的管理员 Cookie，换浏览器、退出后重新登录或使用其他会话不能接续原流程。

完整回调 URL 必须与当前流程的源站、路径和 state 匹配；不接受其他域名、协议、路径、端口、片段、用户名/密码或重复的 `code` / `state` / `error` 参数。服务端只解析粘贴内容，不访问该网址。原始 code 仍须匹配本次 PKCE 流程，不能拿其他工具取得的 code 来兑换。

## 权限与健康状态

| 权限 / 状态 | 用途与边界 |
| --- | --- |
| `offline_access` | 请求 Refresh Token，用于后续续期；授权被撤销后仍需重新同意 |
| Graph `User.Read` | 核验登录邮箱身份，防止修复时写入另一个邮箱的凭据 |
| Graph `Mail.ReadWrite` | 当前授权流程默认申请，用于读取及整理/删除邮件 |
| Graph `Mail.Read` | 历史令牌可以用于阅读；不能据此认为可删除或执行其他写操作 |
| IMAP 权限 | 面向 IMAP 资源；仅有 IMAP 权限不保证可读取 Graph 邮件，本工作区通过 Graph 读取 |
| Graph `Mail.Send` | 发送/回复的独立权限，只有 `send_mail:true` 时额外申请；默认 false |
| `status` | 本地管理状态 `active` / `disabled`，授权修复保留它 |
| `auth_status` | 收件检查状态；授权保存后是 `unchecked`，测试成功才说明实际收件权限可用 |
| `token_refresh_status` | 续期状态；续期成功不等同于收件或发信权限健康 |

账号上次收件检查为 `healthy`，后续续期仍可能失败。API 保留原始 `auth_status`，并通过 `token_refresh_status` 表达续期异常；前端将续期 `retrying` 显示为 `error` 状态，提示需要处理。不要仅凭原始 `auth_status` 判断当前账号是否健康。

自动续期不能绕过撤销的授权、缺少的权限或组织同意策略。后台节奏与退避规则见 [Outlook 续期说明](OUTLOOK-RENEWAL.md)。发信还需要本服务的管理员权限；HTTP 202 仅表示微软受理，详细限制见 [API 开发者指南](API.md)。

## 常见修复情况

| 情况 | 处理方式 |
| --- | --- |
| 登录成另一个邮箱 | 服务端核验 Graph 邮箱后拒绝保存，不覆盖目标账号。重新从目标账号发起授权，在 Microsoft 账号选择器选择正确邮箱；不要改绑定邮箱来绕过校验 |
| code 已过期、已经兑换，或兑换请求超时 | 先确认账号是否已保存，再重新开始授权生成新的 state/code。不要反复提交旧 code |
| state 过期、已消费、会话不同 | 在当前管理员会话中重新发起；本地 10 分钟有效期不能延长微软 code 有效期 |
| 回调不属于当前流程 | 核对是否复制了当前窗口的完整网址；其他窗口的 state、不同路径或带 fragment 的 URL 会被拒绝 |
| `invalid_client` / `unauthorized_client` | 核对 Client ID 与令牌签发应用是否一致、Web Secret 是否有效、公共客户端及其回调是否获准。公共应用被策略拒绝时使用自己的应用 |
| `invalid_scope` / `ErrorAccessDenied` / 权限不足 | 核对 Graph 委派权限及同意状态。仅有 IMAP 权限时重新进行 Graph 授权，需要发信再选择 `Mail.Send` |
| `invalid_grant` / `interaction_required` / 需要重新授权 | 当前授权可能过期、被撤销或需要交互验证；重新登录并同意权限 |
| 网络错误、限流、续期 `retrying` | 先按提示等待，再测试连接；后台会按退避计划重试续期。若错误发生在授权码兑换阶段，应重新发起授权 |
| 账号仍为停用 | 修复不会自动启用账号；确认需要启用后再启用并测试 |
| 授权期间账号被编辑、删除或目标分组变更 | 刷新账号列表后重新发起；服务端拒绝覆盖并发修改或复活已删除记录 |

兑换在调用 Microsoft token 接口前就原子消费 state，因此即使网络失败也不能再次兑换同一会话。格式错误的回调会在兑换前被拒绝，但已经尝试兑换的流程不能靠更换 code 继续。

## API 用法

API 契约版本为 **2.4.0**，完整参数与响应见 [OpenAPI](openapi.json)。OAuth start / exchange / callback **仅接受管理员 Cookie**；主 API Key 或 `admin` scoped key 不能代替，也不要同时附带 API Key。下列 JSON 均使用虚构占位值，不能直接完成真实授权。

### 发起授权

`POST /api/outlook/oauth/start`，所有字段均可选：

```json
{
  "mode": "manual",
  "account_id": 1,
  "email": "user@outlook.com",
  "group_id": 1,
  "client_id": "9e5f94bc-e8a4-4e73-b8be-63364c29d753",
  "send_mail": false
}
```

省略 mode 默认为 `web`；group_id 默认 1，只用于新账号。已有账号保留原分组。account_id 绑定修复目标；若同时给 email，必须与该账号一致。仅给 email 时会绑定已存在的同邮箱账号。新建时推荐提供预期 email，服务端会核验返回邮箱；省略 account_id/email 时按 Graph 核验邮箱保存，可能更新已有同邮箱账号。client_id 仅 manual 使用，web 从服务器配置读取。

响应保留原来的根字段 `url`，新增 `data`；请原样打开实际返回的 url：

```json
{
  "success": true,
  "url": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?省略示例参数",
  "data": {
    "state": "EXAMPLE_ONLY_STATE",
    "mode": "manual",
    "expires_at": 1794787800,
    "redirect_uri": "https://localhost",
    "client_id": "9e5f94bc-e8a4-4e73-b8be-63364c29d753"
  }
}
```

`expires_at` 是 **UNIX 秒**，换算 JavaScript 时间时乘以 1000。它表示本地会话到期时间，不是 code 的有效期。

### 兑换并保存

`POST /api/outlook/oauth/exchange`，携带同一管理员 Cookie：

```json
{
  "state": "EXAMPLE_ONLY_STATE",
  "response": "https://localhost/?code=EXAMPLE_ONLY_FRESH_CODE&state=EXAMPLE_ONLY_STATE"
}
```

`response` 也可为 code 值，最长 16384 字符，解析后的 code 最长 8192 字符。只接受本次 manual 流程，web 流程由回调完成。成功响应为：

```json
{
  "success": true,
  "data": {
    "id": 1,
    "email": "user@outlook.com",
    "status": "active",
    "auth_status": "unchecked"
  },
  "message": "微软账号已授权并保存，请测试收件连接"
}
```

成功响应没有密码、Access Token 或 Refresh Token。需要复制凭据时，另行 `GET /api/outlook/accounts/export?ids=1`；响应为 `version/exported_at/accounts` JSON，含密码、client_id、refresh_token，可按 [账号交换规则](ACCOUNT-TRANSFER.md) 转成文本/CSV。只在明确需要时读取，并按凭据保管。

HTTP 409 `OAUTH_RESTART_REQUIRED` 表示会话失效/已使用、邮箱不匹配等需要重启的流程；OAuth 保存阶段的账号/分组并发校验冲突也统一返回该错误码。502 `OAUTH_EXCHANGE_FAILED` 或 `OAUTH_PROFILE_FAILED` 表示微软兑换或邮箱核验失败。收到结果不确定的错误时先核对账号，再重新授权。通用 Idempotency-Key 只能回放已保存的成功结果，不能延长 state/code 有效期或重新兑换已消费会话。

Web 回调返回 HTML，通过同源 `postMessage` 发送 `{type:"mailhub-outlook-oauth",success,message,state,account?}`，然后由回调页自行关闭窗口。成功 account 使用上面的四字段摘要。自定义客户端必须校验消息 `origin`、`source`、`state` 与 `success`；HTTP 200 不能单独证明授权完成。

### 读取修复诊断与筛选

`GET /api/outlook/accounts/1/recovery` 接受管理员 Cookie 或 `admin` grant。受邮箱/平台限制的 Key 仍按账号实际邮箱和关联平台校验，越权返回 403 `RESOURCE_FORBIDDEN`。接口只查询本地记录，不调用微软、不刷新令牌。

返回 `{success:true,data:{account,diagnosis}}`。account 只含 `id`、`email`、`client_id`、`group_id`、`status`、`auth_status`、`last_error`、`last_error_code`、`last_checked_at`、`token_refresh_status`、`token_refresh_error`、`next_token_refresh_at`，不含密码或令牌。diagnosis 为 `{kind,title,description,action}`，action 的含义如下：

| action | 建议动作 |
| --- | --- |
| `authorize` | 对目标邮箱重新发起授权 |
| `retry` | 等待临时故障恢复，再测试连接 |
| `enable` | 账号停用；确认后启用并测试 |
| `configure` | 检查应用 Client ID、Web Secret 或应用配置 |
| `check` | 测试连接以取得当前收件结果 |

客户端可显示 kind/title/description，但应容忍新增 kind。诊断来自已有状态；实时检查使用 `POST /api/outlook/accounts/1/check`。

列表与省略 ids 的导出支持可选 `attention=true/false`：

```text
GET /api/outlook/accounts?attention=true&page=1&limit=30
GET /api/outlook/accounts?auth_status=healthy&attention=true
GET /api/outlook/accounts?status=active&auth_status=healthy&attention=false
GET /api/outlook/accounts/export?attention=true
GET /api/outlook/accounts/export?auth_status=unchecked&attention=true
```

需处理集合为 **status=active，且 auth_status 为 error/reauth_required 或 token_refresh_status 为 retrying/reauth_required** 的并集，一条账号只计一次。attention 的三种用法如下：

| attention | 筛选语义 |
| --- | --- |
| 省略 | 不按需处理状态过滤 |
| `true` | 只保留需处理集合 |
| `false` | 排除需处理集合，仍可包含 disabled 账号；需要启用账号时另传 `status=active` |

三种用法均保留 q/group_id/tag_id/status/auth_status 的筛选，条件取交集，`attention=true&status=disabled` 因而为空。

列表及导出的 `auth_status` 始终精确匹配原始收件检查字段。`auth_status=healthy` 包含上次收件健康但后续续期异常的账号；再加 `attention=true` 会返回其中续期 `retrying/reauth_required` 的 active 账号，响应中的 `auth_status` 仍为 `healthy`。`auth_status=unchecked&attention=true` 同样可以命中续期异常的待检查账号。

列表的 `summary.attention` 是全池同一并集的数量，`summary.healthy/unchecked` 排除该并集。汇总桶互斥，不受当前筛选/分页影响，因此单独 `auth_status=healthy` 的列表总数可能大于 `summary.healthy`。UI 的健康/待检查选择器会同时发送 `status=active`、对应 `auth_status` 和 `attention=false`，使用与汇总桶一致的筛选规则；API 单独按原始 auth_status 筛选的行为保持不变。导出提供 ids 时只按所选 ID，忽略 attention 等其他筛选；导出仍含凭据。

## 参考

- [Microsoft identity platform 授权码流程](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow)：PKCE、回调匹配、公共客户端不使用 Secret、授权码通常约 1 分钟等规则的官方依据。
- 手动提取授权码与修复入口的交互思路参考 [roseforyou/cf-outlook-email](https://github.com/roseforyou/cf-outlook-email)（GPL）。本项目独立实现，未复制其代码；参考不代表与该项目或 Thunderbird 存在合作关系。

## 已保存密码

修复弹窗的「已保存的账号信息」直接显示邮箱和已保存密码，可隐藏或复制用于 Microsoft 登录。「编辑 Outlook 凭据」加载单账号详情后回填密码；未修改密码时保存不会覆盖后台已有值，Refresh Token 留空仍保留。平台账号编辑同样默认回显密码。没有存过密码的邮箱显示「此账号尚未保存密码」；OAuth 授权只返回令牌，不会返回邮箱登录密码。
