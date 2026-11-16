import PostalMime, { type Email } from "postal-mime";
import {
  and,
  db,
  eq,
  insert,
  remove,
  update,
  now,
  type Row,
} from "./storage/client";
import type { Env } from "./types";

export interface StoredAttachment {
  id: string;
  name: string;
  size: number;
  contentType: string;
}
function contentBytes(content: ArrayBuffer | Uint8Array | string) {
  return typeof content === "string"
    ? new TextEncoder().encode(content)
    : new Uint8Array(content);
}
export function attachmentManifest(parsed: Email): StoredAttachment[] {
  return parsed.attachments.map((a, index) => ({
    id: String(index),
    name: (a.filename || `attachment-${index + 1}`)
      .replace(/[\r\n\x00-\x1f]/g, "")
      .slice(0, 200),
    size: contentBytes(a.content).byteLength,
    contentType: a.mimeType || "application/octet-stream",
  }));
}
export async function saveRawMail(env: Env, raw: ArrayBuffer) {
  if (!env.MAIL_OBJECTS) return "";
  const key = `mail/${crypto.randomUUID()}/raw.eml`;
  // Persist an orphan-recovery entry before upload. The email commit removes it
  // atomically. Interrupted uploads are reclaimed after the grace period.
  await db(env).mutate([
    insert("mail_object_gc", { key, available_at: Date.now() + 86400000 }),
  ]);
  await env.MAIL_OBJECTS.put(key, raw, {
    httpMetadata: {
      contentType: "message/rfc822",
      contentDisposition: "attachment",
    },
  });
  return key;
}
export async function collectMailObjects(env: Env) {
  if (!env.MAIL_OBJECTS) return { deleted: 0 };
  const rows = await db(env).select("mail_object_gc", {
    where: { field: "available_at", op: "lte", value: Date.now() },
    limit: 50,
  });
  let deleted = 0;
  for (const row of rows) {
    const key = String(row.key);
    if (!/^mail\/[0-9a-f-]{36}\/raw\.eml$/.test(key)) continue;
    // Claim and reference check share the same serialized database transaction as
    // confirmMailObject. A late confirmation cannot reference a claimed object.
    const [claim] = await db(env).mutate([
      { op: "claimMailObject", key, time: Date.now() },
    ]);
    if (!claim.changes) continue;
    try {
      await env.MAIL_OBJECTS.delete(key);
      await db(env).mutate([remove("mail_object_gc", eq("key", key))]);
      deleted++;
    } catch {
      await db(env).mutate([
        update("mail_object_gc", eq("key", key), {
          available_at: Date.now() + 3600000,
          attempts: Number(row.attempts) + 1,
        }),
      ]);
    }
  }
  return { deleted };
}
export function publicMailObjects(mail: Row) {
  let attachments: StoredAttachment[] = [];
  try {
    attachments = JSON.parse(String(mail.attachment_manifest || "[]"));
  } catch {
    /* Legacy mail has no manifest. */
  }
  return { has_raw: Boolean(mail.raw_object_key), attachments };
}
export async function mailObjectResponse(
  env: Env,
  mail: Row,
  attachment?: string,
) {
  if (!env.MAIL_OBJECTS || !mail.raw_object_key)
    return Response.json(
      {
        success: false,
        error: "MAIL_OBJECT_UNAVAILABLE",
        message: "这封邮件没有保存原始文件",
      },
      { status: 404 },
    );
  const object = await env.MAIL_OBJECTS.get(String(mail.raw_object_key));
  if (!object)
    return Response.json(
      {
        success: false,
        error: "MAIL_OBJECT_MISSING",
        message: "邮件文件暂时不可用，请检查对象存储与备份",
      },
      { status: 503 },
    );
  let body: BodyInit = object.body,
    filename = `mail-${mail.id}.eml`;
  if (attachment !== undefined) {
    if (!/^\d{1,3}$/.test(attachment)) {
      await object.body.cancel();
      return Response.json(
        { success: false, message: "附件不存在" },
        { status: 404 },
      );
    }
    const parsed = await new PostalMime({
      maxPartCount: 200,
      maxNestingDepth: 30,
    }).parse(await object.arrayBuffer());
    const found = parsed.attachments[Number(attachment)];
    if (!found)
      return Response.json(
        { success: false, message: "附件不存在" },
        { status: 404 },
      );
    body = contentBytes(found.content);
    filename = attachmentManifest(parsed)[Number(attachment)].name;
  }
  return new Response(body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename).replaceAll("'", "%27")}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
