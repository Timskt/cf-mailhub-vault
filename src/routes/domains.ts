import { Hono } from "hono";
import { getDomains, normalizeDomain } from "../domains";
import { db, insert, now } from "../storage/client";
import type { Env } from "../types";
import { boolean, invalid, object, text } from "../validation";

const app = new Hono<{ Bindings: Env }>();
app.get("/", async (c) =>
  c.json({ success: true, data: await getDomains(c.env) }),
);

app.post("/", async (c) => {
  const body = object(await c.req.json());
  const domain = normalizeDomain(body.domain);
  const domains = await getDomains(c.env);
  if (domains.some((d) => d.domain === domain))
    invalid("该域名已存在，可直接启用或编辑");
  if (domains.length >= 100) invalid("最多支持 100 个域名");
  await db(c.env).mutate([
    insert("domains", { domain, remark: text(body.remark, "备注", 300) }),
  ]);
  return c.json({
    success: true,
    message: "域名已添加，请按接入指引配置 Cloudflare Email Routing",
    data: await getDomains(c.env),
  });
});

app.put("/:domain", async (c) => {
  const domain = normalizeDomain(c.req.param("domain"));
  const body = object(await c.req.json());
  const current = (await getDomains(c.env)).find((d) => d.domain === domain);
  if (!current) return c.json({ success: false, message: "域名不存在" }, 404);
  const enabled = boolean(body.enabled, "enabled", Boolean(current.enabled));
  const isDefault = boolean(body.is_default, "is_default");
  if (isDefault && !enabled) invalid("默认域名必须处于启用状态");
  const statements = [
    insert(
      "domains",
      {
        domain,
        enabled: enabled ? 1 : 0,
        remark: text(body.remark, "备注", 300, current.remark),
        updated_at: now(),
      },
      { conflict: "update" },
    ),
  ];
  if (isDefault)
    statements.push(
      insert(
        "settings",
        { key: "default_mail_domain", value: domain },
        { conflict: "update" },
      ),
    );
  await db(c.env).mutate(statements);
  return c.json({
    success: true,
    data: await getDomains(c.env),
    message: "域名配置已保存",
  });
});

app.post("/:domain/check", async (c) => {
  const domain = normalizeDomain(c.req.param("domain"));
  if (!(await getDomains(c.env)).some((d) => d.domain === domain))
    invalid("请先添加该域名");
  try {
    const records = await Promise.all(
      ["MX", "TXT"].map(async (type) => {
        const response = await fetch(
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`,
          {
            headers: { Accept: "application/dns-json" },
            signal: AbortSignal.timeout(8000),
          },
        );
        if (!response.ok) throw new Error("DNS unavailable");
        const data = (await response.json()) as {
          Status?: number;
          Answer?: { type: number; data: string }[];
        };
        if (data.Status !== 0 && data.Status !== 3)
          throw new Error("DNS lookup failed");
        return (data.Answer || [])
          .filter((a) => a.type === (type === "MX" ? 15 : 16))
          .map((a) => a.data);
      }),
    );
    const [mx, txt] = records;
    const mxReady =
      mx.length > 0 &&
      mx.every((record) =>
        /\broute[123]\.mx\.cloudflare\.net\.?$/i.test(record),
      );
    const spf = txt.filter((record) => /v=spf1\b/i.test(record));
    const spfReady =
      spf.length === 1 && spf[0].includes("include:_spf.mx.cloudflare.net");
    const status = mxReady && spfReady ? "ready" : "incomplete";
    await db(c.env).mutate([
      insert(
        "domains",
        { domain, dns_status: status, last_checked_at: now() },
        { conflict: "update" },
      ),
    ]);
    return c.json({
      success: true,
      data: { domain, mx, txt, mx_ready: mxReady, spf_ready: spfReady, status },
      message:
        mxReady && spfReady
          ? "DNS 记录已就绪；请确认 Catch-all 指向本 Worker，并发送测试邮件验证投递"
          : `${[!mxReady ? "MX 记录未正确指向 Cloudflare" : "", !spfReady ? "SPF 记录缺失或冲突" : ""].filter(Boolean).join("；")}。请在 Email Routing 中完成配置`,
    });
  } catch {
    return c.json(
      { success: false, message: "DNS 检查暂时失败，请稍后重试" },
      502,
    );
  }
});

export default app;
