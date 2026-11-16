import { normalizeDomain } from "./domains";
import { and, eq, matches, or, type Filter, type Row } from "./storage/model";
import {
  boolean,
  choice,
  email,
  integer,
  invalid,
  object,
  text,
} from "./validation";

export const mailCategories = [
  "general",
  "verification",
  "billing",
  "newsletter",
  "notification",
] as const;
export function mailPatch(input: unknown): Row {
  const body = object(input),
    patch: Row = {};
  for (const key of Object.keys(body)) {
    if (["is_pinned", "is_read", "is_archived"].includes(key))
      patch[key] = boolean(body[key], key) ? 1 : 0;
    else if (key === "category")
      patch.category = choice(body.category, "分类", mailCategories);
    else invalid("仅支持更新置顶、已读、归档或分类");
  }
  if (!Object.keys(patch).length) invalid("请选择要更新的状态");
  return patch;
}
export function mailIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100)
    invalid("每次请选择 1–100 封邮件");
  return [
    ...new Set(
      value.map((id) => integer(id, "邮件 ID", 1, Number.MAX_SAFE_INTEGER)),
    ),
  ];
}
export function validateRule(input: unknown): Row {
  const body = object(input);
  const rule: Row = {
    name: text(body.name, "规则名称", 80).trim(),
    enabled: boolean(body.enabled, "启用", true) ? 1 : 0,
    priority: integer(body.priority, "优先级", 1, 999, 100),
    sender_contains: text(body.sender_contains, "发件人", 254)
      .trim()
      .toLowerCase(),
    recipient: body.recipient ? email(body.recipient) : "",
    domain: body.domain ? normalizeDomain(body.domain) : "",
    subject_contains: text(body.subject_contains, "主题关键词", 200).trim(),
    verification_only: boolean(body.verification_only, "仅验证码邮件") ? 1 : 0,
    action_category: choice(
      body.action_category,
      "分类",
      ["", ...mailCategories],
      "",
    ),
    mark_read: boolean(body.mark_read, "标为已读") ? 1 : 0,
    archive: boolean(body.archive, "归档") ? 1 : 0,
    pin: boolean(body.pin, "置顶") ? 1 : 0,
  };
  if (!rule.name) invalid("请输入规则名称");
  if (
    !rule.sender_contains &&
    !rule.recipient &&
    !rule.domain &&
    !rule.subject_contains &&
    !rule.verification_only
  )
    invalid("请至少设置一个匹配条件，避免意外处理全部邮件");
  if (!rule.action_category && !rule.mark_read && !rule.archive && !rule.pin)
    invalid("请至少选择一个处理动作");
  if (
    rule.domain &&
    rule.recipient &&
    !String(rule.recipient).endsWith(`@${rule.domain}`)
  )
    invalid("收件地址与所选域名不一致");
  return rule;
}
export function ruleFilter(rule: Row): Filter {
  return and(
    rule.sender_contains
      ? { field: "sender", op: "contains", value: rule.sender_contains }
      : undefined,
    rule.recipient ? eq("recipient", rule.recipient) : undefined,
    rule.domain
      ? { field: "recipient", op: "ends", value: `@${rule.domain}` }
      : undefined,
    rule.subject_contains
      ? { field: "subject", op: "contains", value: rule.subject_contains }
      : undefined,
    rule.verification_only
      ? or(
          { field: "verification_code", op: "ne", value: "" },
          { field: "verification_link", op: "ne", value: "" },
        )
      : undefined,
  );
}
export function rulePatch(rule: Row): Row {
  return {
    rule_name: rule.name,
    ...(rule.action_category ? { category: rule.action_category } : {}),
    ...(rule.mark_read ? { is_read: 1 } : {}),
    ...(rule.archive ? { is_archived: 1 } : {}),
    ...(rule.pin ? { is_pinned: 1 } : {}),
  };
}
export function classifyMail(mail: Row): string {
  if (mail.verification_code || mail.verification_link) return "verification";
  const subject = String(mail.subject || "");
  if (
    /\b(invoice|receipt|payment received|billing statement)\b|发票|付款成功|支付成功|账单/i.test(
      subject,
    )
  )
    return "billing";
  if (
    /\b(newsletter|digest|weekly roundup)\b|订阅周报|每周精选|电子简报/i.test(
      subject,
    )
  )
    return "newsletter";
  if (
    /\b(security alert|new sign.in|password changed|delivery status)\b|安全提醒|异地登录|密码已更改|物流通知/i.test(
      subject,
    )
  )
    return "notification";
  return "general";
}
export function organizeIncoming(mail: Row, rules: Row[]): Row {
  const first = rules
    .filter((r) => r.enabled)
    .sort(
      (a, b) =>
        Number(a.priority) - Number(b.priority) || Number(a.id) - Number(b.id),
    )
    .find((r) => matches(mail, ruleFilter(r)));
  return { category: classifyMail(mail), ...(first ? rulePatch(first) : {}) };
}
