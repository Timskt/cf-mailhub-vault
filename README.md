# 📬 MailHub & Vault

<p align="center">
  <b>全能邮箱矩阵与平台账号资产中心 (All-in-One Multi-Source Mailbox & Platform Account Vault)</b><br>
  完全基于 Cloudflare 原生无服务器架构（Workers + D1 + Email Routing）· 100% 零服务器 · 零成本运行 · 隐私自托管
</p>

---

## ✨ 为什么打造这个项目？

在日常出海或批量测试过程中，很多开发者都面临这些痛点：
1. **邮箱分散混乱**：自建域名临时邮箱、微软 Outlook 邮箱、公共接码临时邮箱各用一套，收信找验证码极其繁琐；
2. **账号资产遗忘**：在 OpenAI、Claude、Cursor、GitHub、Twitter 等平台注册了一堆账号，过几天根本记不清哪个平台用了哪个邮箱、密码是什么、是否存活；
3. **收码效率低下**：注册或找回密码时，需要反复在网页间跳转、手动刷新邮件、翻看长篇内容去找 6 位验证码。

**MailHub & Vault** 将「**多源邮箱矩阵**」与「**平台账号资产管理台账**」深度融合，同时吸收了顶流临时邮箱项目（如 `tempmail.jdyun.fun`、`cloudflare_temp_email`、`cf-outlook-email`）的交互精髓，打造一站式矩阵解决方案！

---

## 🔥 核心特性

- 🏢 **平台注册资产台账 (Vault)**
  - 详细记录平台名称、官网链接、绑定邮箱、登录用户名、密码（支持脱敏与一键复制）、2FA 密钥、状态（正常/待验证/已封禁）、分类及注册代理 IP 记录。
  - 支持一键导出 CSV 备份，随时本地归档。
- ⚡ **杀手级联动：一键秒提平台验证码**
  - 在平台列表中点击 **「⚡ 提取验证码」**，系统自动定位该平台绑定的邮箱，从最新邮件中智能提取 4~8 位数字/字母验证码与激活链接，直接大字号弹出并提供一键复制，彻底免去手动翻邮件的痛苦！
- 📬 **自建 Cloudflare 域名 Catch-all 收信**
  - 原生接入 Cloudflare Email Routing，无需任何额外服务器或开放 25 端口，全域收信直接触发 Worker 存储入库。
  - 列表级突出显示验证码徽章（免进邮件即可复制）。
  - 支持 DKIM / SPF 真实性鉴权校验徽章（🛡️ 已验真），防钓鱼欺诈。
- 🔑 **微软 Outlook / Hotmail 批量账号托管**
  - 集成 Microsoft Graph API，支持批量托管、自动定时续期 Refresh Token，免翻墙直接读取收件箱与垃圾箱。
- 🛡️ **生命周期保护机制**
  - 临时测试邮箱定期自动清理；一旦邮箱与平台账号绑定，系统自动将其锁定为永久受保护资产，绝不误删。
- 🤖 **开放自动化 REST API**
  - 专为 Python、Selenium、Playwright 自动化注册脚本设计，提供 `GET /api/external/code` 纯净接口，秒级回传最新验证码。
- 🚀 **100% Serverless & pnpm 构建**
  - 严格采用 pnpm 包管理，零磁盘浪费，单 Worker 整合前端与后端（Workers Assets 模式），秒级全球 CDN 部署。

---

## 🛠️ 快速部署教程

### 1. 前置准备
- 一个托管在 Cloudflare 上的域名；
- 本地安装了 Node.js（v18+）和 pnpm。

### 2. 本地登录 Cloudflare 并一键部署
```bash
# 克隆代码
git clone https://github.com/Timskt/cf-mailhub-vault.git
cd cf-mailhub-vault

# 1. 登录 Cloudflare（如已登录可跳过）
pnpm exec wrangler login

# 2. 执行一键部署脚本
./deploy.sh
```

按照终端提示输入您的域名（如 `example.com`）和前端访问域名（如 `vault.example.com`），脚本将自动完成 D1 数据库创建、表结构初始化并发布上线！

### 3. 配置 Cloudflare 邮件路由 (Email Routing)
部署成功后，最后一步开启接收邮件：
1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/) ➔ 进入您的托管域名；
2. 点击左侧导航栏 **「电子邮件 (Email)」** ➔ **「电子邮件路由 (Email Routing)」** 并启用；
3. 切换至 **「路由规则 (Routing rules)」**：
   - 找到 **Catch-all 规则** ➔ 编辑；
   - **操作 (Action)**：选择 **发送到 Worker (Send to Worker)**；
   - **目标**：选择 **`cf-mailhub-vault`** 并保存。

---

## 📄 自动化 REST API 说明

在请求头中携带 `X-API-Key: 你的API密钥` 即可调用：

### 1. 获取指定邮箱或平台的最新验证码
```bash
GET /api/external/code?email=xxx@yourdomain.com
# 或根据平台模糊查询：
GET /api/external/code?platform=OpenAI
```
**响应：**
```json
{
  "success": true,
  "code": "849201",
  "link": "https://auth.openai.com/verify?token=xxx",
  "subject": "Your OpenAI verification code",
  "sender": "noreply@tm.openai.com",
  "received_at": "2026-11-11 14:30:00"
}
```

### 2. 自动分配邮箱并登记新账号
```bash
POST /api/external/register
Content-Type: application/json

{
  "platform_name": "Claude",
  "password": "Password123!",
  "category": "AI工具",
  "remark": "美国住宅IP自动注册"
}
```

---

## 📜 开源协议

本项目采用 [MIT](LICENSE) 协议开源。仅供学习交流与个人资产管理使用。
