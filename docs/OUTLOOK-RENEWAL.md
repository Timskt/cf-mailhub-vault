# Outlook 导入、连接与自动续期

四段文本支持 `邮箱----密码----client_id----refresh_token`，包括大小写邮箱和令牌中的 `!`、`*` 等字符。中文「导出内容（格式：…）」和中英文表头会被识别为表头，不计入异常行及 200 条账号上限。预览只检查格式，确认导入后才保存；微软授权是否有效由「测试连接」验证。

## 续期流程

Cloudflare Cron 配置为 `*/15 * * * *`。每轮从启用的账号中选择最早到期的 1–8 个，默认 5 个，按最多 3 个并发兑换令牌。成功后将下一次续期安排为当前时间加 6 小时；大量账号的实际处理时间取决于队列与每轮数量。

请求使用 `https://graph.microsoft.com/.default offline_access`。必须保存响应中的新 Refresh Token；仅取得 Access Token 不能证明已获得可持续使用的新刷新令牌。实际收件、查验证码和手动检查也走相同的令牌保存流程。

保存时比较账号 ID、原 Client ID、原 Refresh Token 与启用状态，防止在途响应覆盖并发导入或编辑。续期成功时间、最近尝试、下次尝试、失败次数、续期状态和简化错误单独存储。邮件连接状态保留其自身含义，后台续期不读取收件箱。

网络和临时服务错误保留原令牌，以 15、30、60、120、240 分钟和最多 6 小时的间隔重试。`invalid_grant`、`interaction_required`、`consent_required`、`login_required` 会标为需要重新授权；更换凭据后清除失败状态并重新进入队列。一个账号失败不阻止本轮其他账号。`settings.token_refresh_last_run` 记录最近调度时间、尝试数、成功数和失败数，不包含凭据。

邮件清理仍每 6 小时执行。应用升级需要先应用 `0005_token_renewal.sql`，然后部署匹配的 Worker，并确认线上 Cron 已更新。

## 已修复的运行环境问题

Workers 不支持 Fetch 的 `redirect: "error"`，构造请求时就会抛错。旧代码因此把尚未发出的微软请求报告为网络故障。现使用 `manual` 并拒绝 3xx 响应；凭据不会跟随跳转。回归测试使用真实 Workerd Request 构造器，避免 Node 模拟测试掩盖差异。

## 授权期限的边界

定时续期可以避免长期未使用导致的过期，不能阻止微软撤销授权。密码变更、用户撤销、账号策略或微软风险检查仍可能要求重新登录；SPA 类型的刷新令牌也可能具有无法通过轮换延长的 24 小时期限。平台不承诺“永不过期”，并在需要人工处理时显示原因。

依据：[Microsoft 刷新令牌文档](https://learn.microsoft.com/entra/identity-platform/refresh-tokens)、[Cloudflare Request redirect 说明](https://developers.cloudflare.com/workers/runtime-apis/request/)。
