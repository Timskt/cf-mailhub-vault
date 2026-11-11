#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=========================================================="
echo " 📬 MailHub & Vault (全能邮箱矩阵与账号资产中心) 一键部署"
echo " （使用 pnpm 驱动，零磁盘浪费，100% 部署至 Cloudflare）"
echo "=========================================================="

# 1. 检查 pnpm 与 Cloudflare 登录状态
if ! command -v pnpm &> /dev/null; then
  echo "❌ 未检测到 pnpm，请先安装 pnpm: npm install -g pnpm"
  exit 1
fi

echo ">>> 正在检测 Cloudflare 授权状态..."
if ! pnpm exec wrangler whoami > /dev/null 2>&1; then
  echo ""
  echo "⚠️ 未检测到 Cloudflare 登录授权。"
  echo "请在终端中执行以下命令完成浏览器授权登录："
  echo "    pnpm exec wrangler login"
  echo "或者设置环境变量：export CLOUDFLARE_API_TOKEN=你的Token"
  exit 1
fi
echo "✓ Cloudflare 授权已就绪！"

# 2. 收集域名配置
DOMAIN="$1"
if [ -z "$DOMAIN" ]; then
  read -r -p "请输入您在 Cloudflare 托管的主域名 (例如 example.com): " DOMAIN
fi

if [ -z "$DOMAIN" ]; then
  echo "❌ 域名不能为空！"
  exit 1
fi

SITE_DOMAIN="$2"
if [ -z "$SITE_DOMAIN" ]; then
  read -r -p "请输入前端面板的访问域名 (例如 vault.${DOMAIN}，直接回车默认使用 vault.${DOMAIN}): " SITE_DOMAIN
  if [ -z "$SITE_DOMAIN" ]; then
    SITE_DOMAIN="vault.${DOMAIN}"
  fi
fi

ADMIN_PASS="$3"
if [ -z "$ADMIN_PASS" ]; then
  read -r -p "请输入管理后台密码 (直接回车将随机生成一个安全密码): " ADMIN_PASS
  if [ -z "$ADMIN_PASS" ]; then
    ADMIN_PASS=$(openssl rand -hex 8)
    echo "已生成随机后台密码: $ADMIN_PASS"
  fi
fi

COOKIE_SECRET=$(openssl rand -hex 32)
API_KEY=$(openssl rand -hex 16)

echo ""
echo "配置信息确认："
echo "  - 邮件接收域名: $DOMAIN"
echo "  - 前端访问域名: $SITE_DOMAIN"
echo "  - 管理后台密码: $ADMIN_PASS"
echo "  - 自动化API密钥: $API_KEY"
echo ""

# 3. 安装依赖 (使用 pnpm)
echo ">>> 正在使用 pnpm 安装依赖..."
pnpm install
echo "✓ 依赖安装完成！"

# 4. 创建 D1 数据库
echo ">>> 正在检查/创建 D1 数据库 (mailhub-vault-db)..."
D1_CREATE_OUTPUT=$(pnpm exec wrangler d1 create mailhub-vault-db 2>&1 || true)
DB_ID=$(echo "$D1_CREATE_OUTPUT" | grep "database_id =" | head -n1 | sed -E 's/.*database_id = "([^"]+)".*/\1/')

if [ -z "$DB_ID" ]; then
  DB_ID=$(node -e '
    const { execSync } = require("child_process");
    try {
      const out = execSync("pnpm exec wrangler d1 info mailhub-vault-db --json 2>/dev/null").toString();
      const data = JSON.parse(out);
      if (data && data.uuid) process.stdout.write(data.uuid);
    } catch(e) {}
  ' || true)
fi

if [ -z "$DB_ID" ]; then
  DB_ID=$(node -e '
    const { execSync } = require("child_process");
    try {
      const out = execSync("pnpm exec wrangler d1 list --json 2>/dev/null").toString();
      const list = JSON.parse(out);
      const found = Array.isArray(list) ? list.find(d => d.name === "mailhub-vault-db") : null;
      if (found && (found.uuid || found.database_id)) process.stdout.write(found.uuid || found.database_id);
    } catch(e) {}
  ' || true)
fi

if [ -z "$DB_ID" ]; then
  echo "⚠️ 自动提取 D1 数据库 ID 失败，以下为 D1 输出信息："
  echo "$D1_CREATE_OUTPUT"
  read -r -p "请手动输入上述输出中的 database_id: " DB_ID
fi

echo "✓ D1 数据库 ID: $DB_ID"

# 5. 执行数据库初始化
echo ">>> 正在初始化 D1 数据库表结构 (migrations/0001_init.sql)..."
pnpm exec wrangler d1 execute mailhub-vault-db --file=./migrations/0001_init.sql --remote -y
echo "✓ 数据库初始化成功！"

# 6. 生成 wrangler.toml
echo ">>> 正在生成 wrangler.toml..."

ROUTES_CONFIG=""
if [ -n "$SITE_DOMAIN" ]; then
ROUTES_CONFIG="routes = [
  { pattern = \"${SITE_DOMAIN}\", custom_domain = true }
]"
fi

cat <<EOF > "$DIR/wrangler.toml"
name = "cf-mailhub-vault"
main = "src/index.ts"
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./public"
binding = "ASSETS"
run_worker_first = true

${ROUTES_CONFIG}

[[d1_databases]]
binding = "DB"
database_name = "mailhub-vault-db"
database_id = "${DB_ID}"

[triggers]
crons = ["0 */6 * * *"]

[vars]
CF_DOMAINS = "${DOMAIN}"
DEFAULT_PREFIX = "tmp"
ADMIN_PASSWORD = "${ADMIN_PASS}"
COOKIE_SECRET = "${COOKIE_SECRET}"
API_KEY = "${API_KEY}"
EOF

echo "✓ wrangler.toml 配置完成！"

# 7. 部署 Worker
echo ">>> 正在部署服务到 Cloudflare Workers..."
pnpm exec wrangler deploy --minify

echo ""
echo "================================================================"
echo "🎉 部署完成！"
echo "  - 前端面板访问地址: https://${SITE_DOMAIN}"
echo "  - 管理后台密码: ${ADMIN_PASS}"
echo "  - 自动化 API 密钥: ${API_KEY}"
echo ""
echo "⚠️ 【最后一步关键配置：Cloudflare 邮件路由 (Email Routing)】"
echo "1. 打开 Cloudflare 控制台 -> 选中域名 [ ${DOMAIN} ]"
echo "2. 点击左侧导航栏的 [电子邮件 (Email)] -> [电子邮件路由 (Email Routing)]"
echo "3. 开启 Email Routing（如未启用，点击启用并自动添加 MX 记录）"
echo "4. 进入 [路由规则 (Routing rules)] 选项卡"
echo "5. 在 [Catch-all 规则] 中点击编辑/启用："
echo "   - 匹配条件：发送给 ${DOMAIN} 的所有邮件 (*@${DOMAIN})"
echo "   - 操作 (Action)：发送到 Worker (Send to Worker)"
echo "   - Worker 目标：选择 [ cf-mailhub-vault ]"
echo "6. 保存规则。现在任何发送至 *@${DOMAIN} 的邮件都将自动被捕获并智能提取验证码！"
echo "================================================================"
