import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { normalizeDomain } from "../src/domains";

// Called only by deploy.sh after the operator explicitly starts deployment.
if (
  existsSync("wrangler.toml") ||
  existsSync(".mailhub-bootstrap.json") ||
  existsSync(".mailhub-initial-credentials.json")
)
  throw new Error("配置或初始化凭据已存在，拒绝覆盖");
const domains = [
  ...new Set(
    (process.env.MAILHUB_INIT_DOMAINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(normalizeDomain),
  ),
];
if (!domains.length || domains.length > 100)
  throw new Error("请提供 1–100 个邮件域名");
const site = process.env.MAILHUB_INIT_SITE
  ? normalizeDomain(process.env.MAILHUB_INIT_SITE)
  : "";
const password =
  process.env.MAILHUB_INIT_PASSWORD || randomBytes(18).toString("base64url");
if (password.length < 10) throw new Error("管理员密码至少需要 10 位");
const wrangler = (args: string[]) =>
  execFileSync("pnpm", ["exec", "wrangler", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
const list = () =>
  JSON.parse(wrangler(["d1", "list", "--json"])) as {
    name: string;
    uuid: string;
  }[];
let db = list().find((d) => d.name === "mailhub-vault-db");
if (!db) {
  wrangler(["d1", "create", "mailhub-vault-db"]);
  db = list().find((d) => d.name === "mailhub-vault-db");
}
if (!db || !/^[\da-f-]{36}$/i.test(db.uuid))
  throw new Error(
    "未能找到 D1 数据库 ID，请手动复制 wrangler.toml.example 配置",
  );
const toml = `name = "cf-mailhub-vault"
main = "src/index.ts"
compatibility_date = "2026-11-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = true
${site ? `routes = [{ pattern = "${site}", custom_domain = true }]` : ""}

[assets]
directory = "./public"
binding = "ASSETS"
run_worker_first = true

[[d1_databases]]
binding = "DB"
database_name = "mailhub-vault-db"
database_id = "${db.uuid}"
migrations_dir = "migrations"

[[durable_objects.bindings]]
name = "STORAGE"
class_name = "StorageCoordinator"

[[migrations]]
tag = "storage-v1"
new_sqlite_classes = ["StorageCoordinator"]

[triggers]
crons = ["* * * * *"]

[vars]
CF_DOMAINS = "${domains.join(",")}"
DEFAULT_PREFIX = "tmp"
`;
writeFileSync(
  ".mailhub-bootstrap.json",
  JSON.stringify(
    {
      ADMIN_PASSWORD: password,
      COOKIE_SECRET: randomBytes(32).toString("hex"),
      API_KEY: randomBytes(32).toString("base64url"),
      STORAGE_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
    },
    null,
    2,
  ),
  { flag: "wx", mode: 0o600 },
);
writeFileSync("wrangler.toml", toml, { flag: "wx", mode: 0o600 });
console.log(
  "已生成 wrangler.toml，初始化凭据保存在权限为 0600 的 .mailhub-bootstrap.json。",
);
