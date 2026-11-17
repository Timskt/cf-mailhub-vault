# 账号导入导出

平台台账和 Outlook 都支持先在弹窗核对格式，再复制文本或下载文件。固定文本使用 `----` 分隔，CSV 使用逗号；导出的首行是字段名，本站导入会自动识别。示例均为虚构数据。

## Outlook

常用格式：`邮箱----密码----client_id----refresh_token`。导出时可选附加备注列。

```text
email----password----client_id----refresh_token
demo@outlook.com----example-password----aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee----FICTIONAL_REFRESH_TOKEN
```

支持不带表头的上述四段格式及 `导出内容（格式：邮箱----密码----client_id----refresh_token）` 说明行。旧版三段格式和 JSON 导入继续支持。首页「导出账号」使用当前搜索、分组、标签、启停用和授权状态筛选；账号菜单可导出单个账号，「批量操作」可导出所选账号。

TXT/CSV 保留所选字段。JSON 保留导出接口返回的全部字段，但账号导入仅恢复接口允许的账号资料，不是完整业务备份；分组、标签关系等应通过设置中的加密业务备份迁移。

## 平台账号

默认固定文本为 21 列，保留原有前 11 列的位置，再追加 10 个平台注册元数据字段。旧 11 列文件和省略末尾字段的文本继续支持：

```text
platform_name----account_email----password----username----email_source----category----status----platform_url----totp_secret----proxy_node----remark
GitHub----demo@example.test----example-password----demo----external----开发工具----active----https://github.com------------个人账号
```

上例为兼容的前 11 列格式。第 12–21 列依次为：

```text
workspace----account_identifier----login_methods----mailbox_address----mailbox_link_state----verification_sender----verification_keyword----registered_at----last_verified_at----expires_at
```

也可以填写「默认平台」，粘贴 `邮箱----密码----用户名`。带表头时支持英文列名及界面列出的中文别名，如「平台、邮箱、密码、用户名、来源、分类、状态、官网、2FA密钥、节点、备注、置顶、工作区、账号标识、登录方式、收件邮箱、邮箱关联状态」。无表头允许省略末尾字段；有表头时每行列数必须一致，重复表头会被拒绝。

- 来源：`cf_domain`、`outlook`、`mailtm`、`mailgw`、`gptmail`、`external`；文本未填时微软邮箱推断为 Outlook，其他为 external。API 的 `accounts[]` 入口省略来源时默认为 `cf_domain`。
- 状态：`active`、`pending`、`banned`、`deprecated`，默认 active。它表示登记状态，邮箱连接是否正常另行检查。
- 工作区和账号标识分别使用 `workspace`、`account_identifier`；`login_methods` 使用 JSON 数组字符串，例如 `["google","password"]`。支持 password/google/microsoft/sso/magic_link/passkey/unknown，去重并排序；省略或为空时默认为 `["unknown"]`。
- `account_email` 是平台登录邮箱；`mailbox_address` 是实际收件地址，空值回退账号邮箱，别名须明确登记。`mailbox_link_state` 为 auto/detached，省略或空值取 auto；detached 停止此平台注册自动查收，仍保留台账和现有邮件保留保护。
- `verification_sender` / `verification_keyword` 是此平台的验证匹配规则。三个日期字段只接受空字符串或含时区的 ISO 8601，保存为 UTC；未知日期保持空值，不推断。
- 每批 1–200 条、最多 1 MiB。先预览显示行号、错误和预计动作；任何一行无效时整批不写入。预览会比对现有账号，显示新增/更新/跳过（`action`）、变更字段名（`changed_fields`）和命中记录 ID（`existing_id`），不显示密码、2FA 或原始行。
- 同一账号身份包含平台名（不区分大小写）、规范化账号邮箱、原样用户名，以及来源、工作区、账号标识和规范化登录方式。批内重复采用最后一条有效记录；`duplicate_mode` 默认 skip，明确 update 才更新已有账号。相同身份命中多条已有登记时返回 409 `IMPORT_TARGET_AMBIGUOUS`，需先按 ID 整理。
- 省略身份字段时按默认值匹配，不作为通配条件。已有登记带工作区、账号标识或特定登录方式时，导入须保留相同身份字段才能命中该记录；改变身份会成为另一条登记。
- 更新默认使用 `update_mode=merge`：只更新明确提供的字段，省略的密码、2FA、别名、日期和其他资料保留；明确提供空值可清除对应字段。显式选择 replace 才将未提供的可选字段恢复空值或默认值。带表头文本中的空单元格属于明确提供，与完全省略该列不同。
- 并发导入或编辑导致账号变化时返回 409，整批取消；重新预览后再提交。

API 预览接受 `{raw_text,platform_name?,duplicate_mode?,update_mode?}`；导入接受相同字段或 `{accounts:[...],duplicate_mode?,update_mode?}`，不能混用 `accounts` 和 `raw_text`。预览与提交应使用相同输入和模式，预览不锁定数据库状态。返回的 `duplicate_count` 只统计文件内重复，不能替代 `action` 判断现有账号。

首页导出使用当前筛选；抽屉可导出整个平台、跨页选择或单个账号。指定 ID 一次最多 100 个，筛选导出最多 10,000 个。导出量超过导入上限时，需要拆成每批最多 200 条导入。

## 字符、凭据与备份

空字段保留分隔符。字段含分隔符、引号或换行时，使用双引号包住完整字段，内部引号写成两个双引号。例如 `"pass----word"`、`"say ""hello"""`。密码中的前后空格会保留。导出器会自动完成这些转义，支持多行备注重新导入。

打开导出弹窗不会立即读取密码或令牌；点击生成后才加载明文。关闭弹窗清除当前预览，不写入浏览器持久存储。CSV 遇到公式起始字符时会提示，但不会改写密码或令牌；只把来源可信的文件交给表格软件。

账号 TXT/CSV/JSON 用于账号交换。完整平台目录、零账号平台、邮件及业务关系请使用「设置 → 加密业务备份」。当前 schema 13 包含 13 张业务表及平台注册元数据，兼容经严格校验的 schema 10/11/12 文件；详见 [备份与恢复](BACKUP-RECOVERY.md)。API 请求/响应示例见 [接口文档](API.md)。
