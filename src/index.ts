import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { API_VERSION, openApi } from "../shared/api-contract";
import {
  aiReference,
  developerGuide,
  llmsIndex,
  postmanCollection,
  workflows,
} from "../shared/api-guides";
import { authMiddleware } from "./auth";
import { AUTOMATION_LIMITS } from "./automation";
import { runCleanup, runTokenRefresh } from "./cron";
import { API_DOC_JSON } from "./docs";
import { getDomains } from "./domains";
import { handleIncomingEmail } from "./email-handler";
import authRoutes from "./routes/auth";
import automationRoutes from "./routes/automation";
import cfMailRoutes from "./routes/cf-mails";
import compatRoutes from "./routes/compat";
import domainRoutes from "./routes/domains";
import externalRoutes from "./routes/external";
import mailRuleRoutes from "./routes/mail-rules";
import mailboxRoutes from "./routes/mailboxes";
import oauthRoutes from "./routes/oauth";
import organizeRoutes from "./routes/organize";
import outlookRoutes from "./routes/outlook";
import searchRoutes from "./routes/search";
import settingsRoutes from "./routes/settings";
import storageRoutes from "./routes/storage";
import vaultRoutes from "./routes/vault";
import credentialRoutes from "./routes/credentials";
import webhookRoutes from "./routes/webhooks";
import apiKeyRoutes from "./routes/api-keys";
import auditRoutes from "./routes/audit";
import backupRoutes from "./routes/backups";
import { runWebhookDeliveries, enqueueEvent } from "./webhooks";
import { collectMailObjects } from "./mail-objects";
import { storageCall } from "./storage/client";
import type { Job } from "./storage/coordinator";
import { StorageError } from "./storage/model";
import type { Env } from "./types";
export { StorageCoordinator } from "./storage/durable-object";
export const app = new Hono<{ Bindings: Env }>();
app.onError((error, c) => {
  if (error instanceof StorageError)
    return c.json(
      { success: false, error: error.code, message: error.message },
      error.status as 400,
      { "Retry-After": "5" },
    );
  if (error instanceof HTTPException)
    return c.json(
      { success: false, error: "INVALID_REQUEST", message: error.message },
      error.status,
    );
  if (error instanceof SyntaxError)
    return c.json(
      { success: false, error: "INVALID_JSON", message: "JSON 请求格式无效" },
      400,
    );
  const missingSchema = /no such (table|column)|has no column named/i.test(
    error.message,
  );
  console.error("Request failed", {
    path: c.req.path,
    type: missingSchema ? "DB_MIGRATION_REQUIRED" : error.name,
  });
  return c.json(
    {
      success: false,
      error: missingSchema ? "DB_MIGRATION_REQUIRED" : "SERVER_ERROR",
      message: missingSchema
        ? "数据库需要升级，请执行 pnpm exec wrangler d1 migrations apply mailhub-vault-db --remote"
        : "服务暂时无法处理请求，请稍后重试",
    },
    500,
  );
});
app.use("*", async (c, next) => {
  c.header("X-Request-ID", crypto.randomUUID());
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
  if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    if (origin && origin !== new URL(c.req.url).origin)
      return c.json({ success: false, message: "拒绝跨站写入请求" }, 403);
  }
  await next();
});
app.use("/api/*", (c, next) => {
  const sending =
    c.req.method === "POST" &&
    /^\/api\/outlook\/accounts\/\d+\/(send|messages\/[^/]+\/reply)$/.test(
      c.req.path,
    );
  const size = sending ? 5 : 2;
  return bodyLimit({
    maxSize: size * 1024 * 1024,
    onError: (c) =>
      c.json(
        {
          success: false,
          error: "REQUEST_TOO_LARGE",
          message: `请求超过 ${size} MiB，请缩小文件或拆分导入`,
        },
        413,
      ),
  })(c, next);
});
app.get("/healthz", (c) => c.text("ok"));
app.get("/api-doc.md", (c) =>
  c.text(developerGuide(new URL(c.req.url).origin), 200, {
    "Content-Type": "text/markdown; charset=utf-8",
  }),
);
app.get("/openapi.json", (c) => c.json(openApi(new URL(c.req.url).origin)));
app.get("/postman.json", (c) =>
  c.json(postmanCollection(new URL(c.req.url).origin), 200, {
    "Content-Disposition": 'attachment; filename="mailhub.postman.json"',
  }),
);
app.get("/llms.txt", (c) => c.text(llmsIndex(new URL(c.req.url).origin)));
app.get("/llms-full.txt", (c) =>
  c.text(aiReference(new URL(c.req.url).origin)),
);
app.get("/api-doc.json", (c) => c.json(API_DOC_JSON));
app.get("/api/domains", async (c) =>
  c.json({
    domains: (await getDomains(c.env))
      .filter((d) => d.enabled)
      .map((d) => d.domain),
  }),
);
app.route("/api/auth", authRoutes);
app.route("/api/external", externalRoutes);
app.use("/api/*", authMiddleware());
app.get("/api/capabilities", (c) =>
  c.json({
    success: true,
    data: {
      version: API_VERSION,
      documents: {
        openapi: "/openapi.json",
        markdown: "/api-doc.md",
        llms: "/llms.txt",
        postman: "/postman.json",
      },
      limits: AUTOMATION_LIMITS,
      authentication: {
        business: ["X-API-Key", "Bearer", "AdminSession"],
        infrastructure: "AdminSession",
        scoped_keys: true,
      },
      workflows,
    },
  }),
);
app.route("/api/automation", automationRoutes);
app.route("/api/api-keys", apiKeyRoutes);
app.route("/api/audit", auditRoutes);
app.route("/api/backups", backupRoutes);
app.route("/api/vault", vaultRoutes);
app.route("/api/mailboxes", mailboxRoutes);
app.route("/api/cf-mails", cfMailRoutes);
app.route("/api/mail-rules", mailRuleRoutes);
app.route("/api/outlook/oauth", oauthRoutes);
app.route("/api/outlook", outlookRoutes);
app.route("/api/outlook", organizeRoutes);
app.route("/api/settings/storage", storageRoutes);
app.route("/api/settings/credentials", credentialRoutes);
app.route("/api/settings/webhooks", webhookRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/settings/domains", domainRoutes);
app.route("/api/search", searchRoutes);
app.route("/api", compatRoutes);
app.all("/api/*", (c) =>
  c.json({ success: false, error: "NOT_FOUND", message: "接口不存在" }, 404),
);
app.get("*", (c) =>
  c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text("MailHub & Vault"),
);
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    app.fetch(request, env, ctx),
  email: handleIncomingEmail,
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const at = new Date(_event.scheduledTime);
    if (at.getUTCMinutes() % 15 === 0) ctx.waitUntil(runTokenRefresh(env));
    ctx.waitUntil(runWebhookDeliveries(env));
    if (at.getUTCMinutes() % 15 === 0) ctx.waitUntil(collectMailObjects(env));
    if (env.STORAGE)
      ctx.waitUntil(
        (async () => {
          const status = await storageCall<{ job: Job | null }>(env, "/status");
          if (status.job?.paused && status.job.retries > 0) {
            const job = status.job;
            await enqueueEvent(
              env,
              "storage.sync_interrupted",
              {
                job_id: job.id,
                source_id: job.from.sourceId,
                target_id: job.to.sourceId,
                error_code: "SYNC_PAUSED",
              },
              `sync:${job.id}:${job.retries}`,
            );
          }
        })(),
      );
    if (at.getUTCMinutes() === 0 && at.getUTCHours() % 6 === 0)
      ctx.waitUntil(runCleanup(env));
  },
} satisfies ExportedHandler<Env>;
