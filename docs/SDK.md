# TypeScript 与 Python SDK

仓库提供 API 2.5.0 的服务端客户端，分别位于 `sdk/typescript/` 和 `sdk/python/mailhub.py`，不依赖第三方运行库。TypeScript 使用原生 Fetch/Web Crypto，推荐 Node.js 22+；Python 使用标准库，要求 Python 3.10+。目前按源码分发，尚未发布 npm/PyPI 包。

在「设置 → 凭据与密钥」创建自动化密钥，通过运行环境的 `MAILHUB_API_KEY` 注入。查收只需 `verify:read`；自动登记需要 `mailbox:write` 和 `vault:write`。Outlook 发送接口需要业务管理权限及对应微软账号的 `Mail.Send` 授权。限制到具体邮箱/平台的密钥还需满足接口资源策略。

## 方法与返回值

| TypeScript                                    | Python                                            | 用途                                       |
| --------------------------------------------- | ------------------------------------------------- | ------------------------------------------ |
| `inspectMailbox(target)`                      | `inspect_mailbox(target)`                         | 查询接入与最近健康状态，不触发微软实时检查 |
| `lookupVerification(target)`                  | `lookup_verification(target)`                     | 单次查收验证码或验证链接                   |
| `waitForVerification(target, options)`        | `wait_for_verification(target, **options)`        | 固定时间起点、有限时长地等待新邮件         |
| `register(input, options)`                    | `register(input, **options)`                      | 分配邮箱并登记平台账号                     |
| `sendMail(accountId, input, options)`         | `send_mail(account_id, input, **options)`         | 明确提交一次发送请求                       |
| `reply(accountId, messageId, input, options)` | `reply(account_id, message_id, input, **options)` | 回复指定微软邮件                           |
| `request(method, path, options)`              | `request(method, path, **options)`                | 调用其他 JSON 信封接口                     |
| `verifyWebhook(rawBody, headers, options)`    | `verify_webhook(raw_body, headers, **options)`    | 验证原始字节、时间戳、事件类型和投递标识   |

单次请求返回 `data`、HTTP `status`、`request_id`、`retry_after`、`idempotency_replayed` 和 `idempotency_key_expires_at`。异常类型 `MailHubError` 保留 `code`、`status`、`request_id`、`retry_after`、`retryable` 和结构化 `details`，不把底层网络异常中的地址或凭据原样输出。

`target` 必须且只能提供 `email`、`vault_id`、唯一匹配的 `platform` 之一；只有 `email` 可以附加 `source: "outlook" | "cf_domain" | "mailtm" | "mailgw" | "mailslurp" | "mailinator"`。查收还支持 `since`、`sender`、`q` 和 `match`。收到 `has_mail: true` 不代表找到验证码；应检查 `outcome` 与 `code/link`。

`match` 默认为 `mailbox`，查询邮箱中符合筛选条件的验证信息，不确认平台归属，也不更新平台注册的历史验证码。`match: "platform"` 仅接受 `vault_id` 或唯一匹配的 `platform`，优先使用显式 `sender/q`，未提供的规则取登记中的 `verification_sender/verification_keyword`。两项规则都为空时返回 HTTP 409 / `VERIFICATION_RULE_REQUIRED`，应先配置规则，或由调用方明确改为邮箱范围查询。台账目标的响应包含 `match_scope/match_reason`；共享同一邮箱的不同平台应使用各自的登记 ID 和匹配规则。

登记设置了 `mailbox_address` 时按这个实际收件地址查询；空值才使用登录邮箱。`mailbox_link_state: "detached"` 返回 HTTP 409 / `MAILBOX_DETACHED`。平台取码期间若登记或规则发生变化，历史码更新被拒绝并返回 HTTP 409 / `STALE_PREVIEW`，刷新登记后再查收。

## TypeScript

在 TypeScript 服务中导入源码，或运行 `pnpm exec tsc -p sdk/typescript/tsconfig.json` 生成 `sdk/typescript/dist/` 后按 ESM 导入。不要把服务端密钥打包到网页。

```ts
import { MailHubClient, MailHubError } from "./sdk/typescript/index.js";

const client = new MailHubClient({
  baseUrl: process.env.MAILHUB_URL!,
  apiKey: process.env.MAILHUB_API_KEY!,
});
const stop = new AbortController();

try {
  const result = await client.waitForVerification(
    { email: "login@mail.example.com", sender: "auth" },
    { timeoutSeconds: 180, intervalSeconds: 10, signal: stop.signal },
  );
  if (result.outcome === "found") {
    // 将 result.data.code/link 交给当前业务流程，不要写入普通日志。
  }
} catch (error) {
  if (error instanceof MailHubError) {
    console.error({ code: error.code, requestId: error.request_id });
  } else throw error;
}
```

创建操作显式传入业务侧保存的操作标识。SDK 不自动生成、替换或重试此标识：

```ts
const result = await client.register(
  { platform_name: "QA", domain: "mail.example.com", prefix: "case-42" },
  { idempotencyKey: "registration-case-42" },
);
// 保存 result.data.id/email。网络未知时用完全相同的参数及 Key 核对。
```

发送使用 `sendMail(accountId, {to: [...], subject, body, attachments?}, {idempotencyKey})`；回复使用 `reply(accountId, messageId, {body, attachments?}, {idempotencyKey})`。附件字段为 `name/content_type/content_base64`。202 / `accepted: true` 只表示微软接受请求。

## Python

将 `sdk/python/mailhub.py` 放到应用模块路径，或设置 `PYTHONPATH` 指向该目录：

```python
import os
import threading
from mailhub import MailHubClient, MailHubError

client = MailHubClient(os.environ["MAILHUB_URL"], os.environ["MAILHUB_API_KEY"])
cancel = threading.Event()
try:
    result = client.wait_for_verification(
        {"email": "login@mail.example.com", "sender": "auth"},
        timeout_seconds=180,
        interval_seconds=10,
        cancel_event=cancel,
    )
    if result["outcome"] == "found":
        verification = result["data"]  # 交给业务处理，避免打印验证码。
except MailHubError as error:
    print({"code": error.code, "request_id": error.request_id})
```

`register/send_mail/reply` 接受 `idempotency_key="业务侧保存的标识"`。Python 是同步客户端；取消或超时会停止调用方等待，但底层请求可能已经提交。后台 urllib 线程在网络超时后退出，不保证取消已经到达服务端的写入。

## 邮箱资产与共享登记

通过 `request()` 调用邮箱资产查询接口：列表为 `/api/mailbox-identities`，单个身份的详情、登记和影响范围分别为 `/api/mailbox-identities/{id}`、`/{id}/registrations`、`/{id}/impact`。这些管理接口要求无邮箱/平台资源限制的 `admin` 密钥；受限密钥不能枚举邮箱身份及其共享登记。

身份 ID 为 `source:address`，作为路径段时整体编码。使用服务端列表返回的 ID，保持来源与实际收件地址对应；例如 `outlook:user@outlook.com`：

```ts
const identityId = encodeURIComponent("outlook:user@outlook.com");
const registrations = await client.request(
  "GET",
  `/api/mailbox-identities/${identityId}/registrations`,
  { query: { page: 1, limit: 30 } },
);

// vault_id 使用登记列表中的目标 ID；该登记需已配置匹配规则。
const verification = await client.lookupVerification({
  vault_id: 42,
  match: "platform",
});
```

```python
from urllib.parse import quote

identity_id = quote("outlook:user@outlook.com", safe="")
registrations = client.request(
    "GET",
    f"/api/mailbox-identities/{identity_id}/registrations",
    query={"page": 1, "limit": 30},
)
verification = client.lookup_verification({"vault_id": 42, "match": "platform"})
```

列表与登记接口支持 `page/limit`，应按响应中的 `total` 继续分页。邮箱资产不返回平台密码或 2FA；编辑凭据仍使用台账详情与编辑接口。完整参数和权限见 [API 文档](API.md)，字段含义见 [平台账号](PLATFORM-ACCOUNTS.md)。

## 轮询、重试和网络规则

- 等待开始时固定 `since`，始终使用同一邮箱与过滤条件；最多 180 秒，默认间隔 10 秒。`timeoutSeconds=0` / `timeout_seconds=0` 不发送请求。
- 只有等待方法会重复查询：无结果继续，429 或明确可重试的临时响应尊重 `Retry-After`；超出等待预算时返回 `outcome: "timeout"`。权限失败、无效响应等抛出异常，不伪装成空邮箱。
- 等待结果包含尝试次数、已耗时、时间起点、最近请求 ID；保留的错误可从 `last_error` 查看。等待查询不携带幂等键，以免反复重放第一次的空结果。
- 普通方法一律只请求一次。`TIMEOUT`、`NETWORK_ERROR`、`IDEMPOTENCY_UNKNOWN` 不证明写入失败；先核对业务状态。确认成功的重放保留原状态码；使用新 Key 前应明确确认这是新操作。
- 基础地址要求 HTTPS 源站，只允许本地回环地址使用 HTTP。客户端拒绝重定向和跨源路径，不把密钥随跳转转发。默认单次请求超时 30 秒，JSON 响应最多 8 MiB。
- `request()` 处理标准 JSON 信封。二进制附件、直接文件导出、管理员 Cookie 管理操作需按 API 文档单独接入，不由此客户端自动接管登录。

## Webhook 接收验证

在框架解析 JSON **之前**取得原始请求字节。签名绑定 `${timestamp}.${原始正文}`，默认接受时间偏差不超过 300 秒；订阅 ID 必须来自接收端可信配置。

```ts
import { verifyWebhook } from "./sdk/typescript/index.js";

const verified = await verifyWebhook(rawBytes, request.headers, {
  secret: process.env.MAILHUB_WEBHOOK_SECRET!,
  subscriptionId: Number(process.env.MAILHUB_WEBHOOK_ID),
});
// 在自己的持久存储中，以 verified.delivery 唯一约束原子记录 verified.hash
// 和待处理事件，成功落库后再返回 2xx；重复投递核对 hash 后安全返回。
```

Python 同义调用为 `verify_webhook(raw_bytes, headers, secret=..., subscription_id=...)`。验证通过不等于已去重，SDK 不替接收方维护投递账本。默认事件不含验证码、链接和可能含验证码的主题；只有明确启用订阅的包含验证码选项才发送这些内容。来信事件当前来自 CF 收件流程，不包含 Outlook 邮件推送订阅。

## 验证

```bash
pnpm typecheck:sdk
pnpm exec tsx --test tests/sdk.test.ts
pnpm test:sdk:python
```

测试覆盖路由和参数、错误与请求 ID、固定时间轮询、退避、取消/超时、二进制原文验签、投递标识绑定与本地 HTTP 重定向；不调用真实邮箱、不发送真实邮件。
