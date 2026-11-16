#!/usr/bin/env bash
# Explicit production deployment. Local development uses pnpm dev.
set -euo pipefail
umask 077
MAILHUB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$MAILHUB_ROOT"

command -v pnpm >/dev/null 2>&1 || { echo '请先安装 Node.js 22+ 和 pnpm 11。'; exit 1; }
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm exec wrangler whoami >/dev/null 2>&1 || { echo '请先执行 pnpm exec wrangler login，或配置 CLOUDFLARE_API_TOKEN。'; exit 1; }

if [[ -f wrangler.toml ]]; then
  echo '使用现有 wrangler.toml；保留域名、数据库和 Secrets 配置。'
else
  MAILHUB_DOMAINS="${1:-}"
  [[ -n "$MAILHUB_DOMAINS" ]] || read -r -p '邮件域名（多个域名用逗号分隔）: ' MAILHUB_DOMAINS
  MAILHUB_SITE="${2:-}"
  [[ -n "$MAILHUB_SITE" ]] || read -r -p '面板域名（如 vault.example.com；留空使用 workers.dev）: ' MAILHUB_SITE
  read -r -s -p '管理员密码（至少 10 位；留空生成并保存到本地凭据文件）: ' MAILHUB_ADMIN_INPUT
  echo
  MAILHUB_INIT_DOMAINS="$MAILHUB_DOMAINS" MAILHUB_INIT_SITE="$MAILHUB_SITE" MAILHUB_INIT_PASSWORD="$MAILHUB_ADMIN_INPUT" pnpm exec tsx scripts/bootstrap-config.ts
  unset MAILHUB_ADMIN_INPUT
fi

# The bootstrap file exists only after first-time initialization. Leave it in place
# on failure so an interrupted initial deployment can resume without rotating secrets.
if [[ -f .mailhub-bootstrap.json ]]; then
  pnpm exec wrangler secret bulk .mailhub-bootstrap.json
  mv .mailhub-bootstrap.json .mailhub-initial-credentials.json
fi
pnpm exec wrangler d1 migrations apply DB --remote
pnpm exec wrangler deploy --minify

echo '部署完成。若生成过 .mailhub-initial-credentials.json，请保存其中凭据到密码管理器后删除该文件。'
echo '请逐个域名启用 Email Routing，并把 Catch-all 的目标设为当前 Worker。'
echo '已有部署的 Secrets 不会被覆盖；需要接入新的邮件域名时，也可直接在面板的域名管理中添加。'
