import { getDomains, normalizeDomain } from "./domains";
import { db, oneOf, type Row } from "./storage/client";
import type { Env } from "./types";
import { boolean, integer, invalid, object, text } from "./validation";

function lifetime(body: Record<string, unknown>) {
  const duration_minutes = integer(
    body.duration_minutes,
    "有效分钟",
    1,
    525600,
    60,
  );
  const is_permanent = boolean(body.is_permanent, "永久保留");
  const remark = text(body.remark, "用途备注", 500).trim();
  return { duration_minutes, is_permanent, remark };
}
async function enabledDomains(env: Env) {
  return new Set(
    (await getDomains(env)).filter((d) => d.enabled).map((d) => d.domain),
  );
}
export async function previewMailboxes(env: Env, input: unknown) {
  const body = object(input),
    enabled = await enabledDomains(env);
  if (
    !Array.isArray(body.domains) ||
    !body.domains.length ||
    body.domains.length > 20
  )
    invalid("请选择 1–20 个已启用的域名");
  const domains = [...new Set(body.domains.map(normalizeDomain))];
  if (domains.some((d) => !enabled.has(d)))
    invalid("选择的域名尚未接入或已停用");
  const count = integer(body.count, "数量", 1, 100, 10);
  const base = text(body.prefix, "用途前缀", 40).trim().toLowerCase() || "box";
  if (!/^[a-z0-9][a-z0-9._+-]{0,39}$/.test(base))
    invalid("前缀仅支持字母、数字及 . _ + -，最长 40 个字符");
  const common = lifetime(body);
  return Array.from({ length: count }, (_, i) => ({
    ...common,
    domain: domains[i % domains.length],
    prefix: `${base}-${String(i + 1).padStart(2, "0")}-${crypto.randomUUID().slice(0, 8)}`,
  }));
}
export async function createMailboxBatch(env: Env, input: unknown) {
  const body = object(input);
  if (
    !Array.isArray(body.mailboxes) ||
    body.mailboxes.length < 1 ||
    body.mailboxes.length > 100
  )
    invalid("每批支持 1–100 个邮箱，请先预览地址");
  const enabled = await enabledDomains(env),
    time = Date.now();
  const rows: Row[] = body.mailboxes.map((item) => {
    const entry = object(item),
      domain = normalizeDomain(entry.domain);
    if (!enabled.has(domain)) invalid("选择的域名尚未接入或已停用");
    const prefix = text(entry.prefix, "邮箱前缀", 64).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._+-]{0,63}$/.test(prefix)) invalid("邮箱前缀无效");
    const options = lifetime(entry);
    const address = `${prefix}@${domain}`;
    if (address.length > 254) invalid("邮箱地址超过 254 个字符");
    return {
      address,
      prefix,
      domain,
      remark: options.remark,
      is_permanent: options.is_permanent ? 1 : 0,
      expires_at: options.is_permanent
        ? ""
        : new Date(time + options.duration_minutes * 60000).toISOString(),
    };
  });
  const addresses = rows.map((r) => r.address);
  if (new Set(addresses).size !== addresses.length)
    invalid("这一批包含重复地址，请重新预览");
  if (await db(env).count("temp_mailboxes", oneOf("address", addresses)))
    invalid(
      "部分地址已存在，本次未新增任何邮箱；如上次提交超时，请刷新邮箱列表核对",
    );
  const [saved] = await db(env).mutate([
    { op: "insert", table: "temp_mailboxes", rows },
  ]);
  return saved.rows;
}
