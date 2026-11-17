import PostalMime from "postal-mime";
import { extractVerificationInfo } from "./code-extractor";
import { getDomains } from "./domains";
import { organizeIncoming } from "./mail-workflows";
import {
  and,
  db,
  digest,
  eq,
  insert,
  now,
  type Mutation,
} from "./storage/client";
import { attachmentManifest, saveRawMail } from "./mail-objects";
import { webhookMutations } from "./webhooks";
import type { Env } from "./types";
import { mailboxReferenceFilter } from "./registration";
export async function handleIncomingEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx?: ExecutionContext,
): Promise<void> {
  const recipient = message.to.toLowerCase().trim();
  const domain = recipient.split("@")[1];
  if (!(await getDomains(env)).some((d) => d.domain === domain && d.enabled)) {
    message.setReject("This domain is not enabled");
    return;
  }
  const maxSize = (env.MAIL_OBJECTS ? 20 : 2) * 1024 * 1024;
  if (message.rawSize > maxSize) {
    message.setReject(
      `Message exceeds the ${maxSize / 1024 / 1024} MiB storage limit`,
    );
    return;
  }
  const [mailbox, bound] = await Promise.all([
    db(env).first<{ is_permanent: number; expires_at: string }>(
      "temp_mailboxes",
      eq("address", recipient),
    ),
    db(env).first<{ id: number; platform_name: string }>(
      "platform_vault",
      and(mailboxReferenceFilter(recipient), eq("email_source", "cf_domain")),
    ),
  ]);
  if (
    !bound &&
    mailbox &&
    !mailbox.is_permanent &&
    mailbox.expires_at &&
    Date.parse(mailbox.expires_at) <= Date.now()
  ) {
    message.setReject("This temporary mailbox has expired");
    return;
  }
  // Throw on processing/storage failures so Cloudflare can retry instead of silently losing the mail.
  const raw = await new Response(message.raw).arrayBuffer();
  if (raw.byteLength > maxSize) {
    message.setReject("Message exceeds storage limit");
    return;
  }
  const parsed = await new PostalMime({
    maxPartCount: 200,
    maxNestingDepth: 30,
  }).parse(raw);
  const messageId = parsed.messageId
    ? parsed.messageId.slice(0, 200)
    : Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", raw)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
  if (
    await db(env).first(
      "cf_inbox_mails",
      and(eq("message_id", messageId), eq("recipient", recipient)),
      { columns: ["id"] },
    )
  )
    return;
  const sender = (parsed.from?.address || message.from).toLowerCase();
  const subject = (parsed.subject || "(无主题)").slice(0, 500);
  const content = {
    text: (parsed.text || "").slice(0, 500000),
    html: (parsed.html || "").slice(0, 500000),
  };
  const info = extractVerificationInfo(subject, content.text, content.html);
  const auth = message.headers.get("authentication-results") || "";
  const dkim = /\bdkim=pass\b/i.test(auth)
    ? "pass"
    : /\bdkim=fail\b/i.test(auth)
      ? "fail"
      : "unknown";
  const spf = /\bspf=pass\b/i.test(auth)
    ? "pass"
    : /\bspf=fail\b/i.test(auth)
      ? "fail"
      : "unknown";
  const protectedMail = Boolean(bound || mailbox?.is_permanent);
  const organization = organizeIncoming(
    {
      sender,
      recipient,
      subject,
      verification_code: info.code,
      verification_link: info.link,
    },
    await db(env).select("mail_rules", {
      where: eq("enabled", 1),
      order: [
        ["priority", "asc"],
        ["id", "asc"],
      ],
      limit: 50,
    }),
  );
  const rawObjectKey = await saveRawMail(env, raw);
  const eventId = await digest(["mail.received", recipient, messageId]);
  const eventPayload = {
    recipient,
    sender,
    subject,
    received_at: now(),
    code: info.code,
    link: info.link,
  };
  const events = [
    ...(await webhookMutations(env, "mail.received", eventPayload, eventId)),
    ...(info.code || info.link
      ? await webhookMutations(
          env,
          "code.extracted",
          eventPayload,
          `${eventId}:code`,
        )
      : []),
  ];
  const statements: Mutation[] = [
    insert(
      "cf_inbox_mails",
      {
        message_id: messageId,
        recipient,
        sender,
        sender_name: (parsed.from?.name || "").slice(0, 100),
        subject,
        text_content: content.text,
        html_content: content.html,
        raw_size: raw.byteLength,
        raw_object_key: rawObjectKey,
        attachment_manifest: JSON.stringify(
          rawObjectKey ? attachmentManifest(parsed) : [],
        ),
        verification_code: info.code,
        verification_link: info.link,
        dkim_status: dkim,
        spf_status: spf,
        is_protected: protectedMail ? 1 : 0,
        ...organization,
      },
      { conflict: "ignore", match: ["message_id", "recipient"] },
    ),
    ...events,
    ...(rawObjectKey
      ? [{ op: "confirmMailObject" as const, key: rawObjectKey }]
      : []),
    insert(
      "domains",
      { domain, last_received_at: now() },
      { conflict: "update" },
    ),
    insert(
      "temp_mailboxes",
      {
        address: recipient,
        prefix: recipient.split("@")[0],
        domain,
        expires_at: protectedMail
          ? ""
          : new Date(Date.now() + 3600000).toISOString(),
        is_permanent: protectedMail ? 1 : 0,
        associated_platform: bound?.platform_name || "",
        associated_vault_id: bound?.id || null,
        remark: "Catch-all 自动发现",
      },
      { conflict: "ignore" },
    ),
  ];
  // A received mailbox code has no confirmed platform ownership. Keep it on
  // the original mail; platform history is written only by scoped lookups.
  const [stored] = await db(env).mutate(statements);
  if (stored.changes && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const notification = fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: `收到新邮件\n收件箱: ${recipient}\n发件人: ${sender}\n主题: ${subject}${info.code ? `\n验证码: ${info.code}` : ""}`,
        }),
        signal: AbortSignal.timeout(8000),
      },
    )
      .then((response) => {
        if (!response.ok)
          console.error("Telegram notification failed", response.status);
      })
      .catch(() => console.error("Telegram notification unavailable"));
    if (ctx) ctx.waitUntil(notification);
    else await notification;
  }
}
