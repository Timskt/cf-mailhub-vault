/** Conservative, deterministic extraction; mail content is never executed or fetched. */
export interface ExtractedCodeResult {
  code: string;
  link: string;
}

function decode(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (original, entity: string) => {
      if (!entity.startsWith("#"))
        return named[entity.toLowerCase()] || original;
      const hex = entity[1].toLowerCase() === "x";
      const point = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return point > 0 &&
        point <= 0x10ffff &&
        !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : "";
    },
  );
}
function plain(html: string): string {
  return decode(
    html
      .replace(/<!--[^]*?-->/g, " ")
      .replace(/<(script|style|head)\b[^>]*>[^]*?<\/\1\s*>/gi, " ")
      .replace(/<\/(?:p|div|h[1-6]|tr)>|<br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}
const label = String.raw`(?:验证码|校验码|动态码|安全码|激活码|确认码|登录码|驗證碼|one[ -]time\s+(?:password|code)|(?:verification|verify|security|confirmation|authentication|login|sign[ -]?in|auth)\s+code|passcode|\botp\b|\byour\s+code|\buse\s+(?:this\s+)?code)`;
const token = String.raw`(?<![a-zA-Z0-9])([a-zA-Z0-9]{3,4}[ -][a-zA-Z0-9]{3,4}|[a-zA-Z0-9]{4,10})(?![a-zA-Z0-9-])`;
const intent = new RegExp(
  `${label}|verify (?:your )?(?:email|account)|验证|確認|确认邮箱|sign[ -]?in|log[ -]?in`,
  "i",
);
function validCode(value: string): string {
  const normalized = value.replace(/[ -]/g, "");
  if (/^\d{4,8}$/.test(normalized)) return normalized;
  if (
    /^[A-Z\d]{4,10}$/.test(normalized) &&
    /[A-Z]/.test(normalized) &&
    !/^(?:CODE|YOUR|EMAIL|VERIFY|LOGIN|SIGNIN|SECURITY|PASSWORD|ACCOUNT|CONFIRM|EXPIRES)$/.test(
      normalized,
    )
  )
    return normalized;
  return "";
}
function findCode(text: string): string {
  // URLs and addresses can contain tokens, ports and IDs, which are not OTPs.
  text = text
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\ufeff]/g, "")
    .replace(/https?:\/\/[^\s<>]+|\b[^\s@]+@[^\s@]+/gi, " ");
  const patterns = [
    new RegExp(
      `${label}[\\s:：=,，。.!！\\[【(（-]*(?:(?:is|为|是)\\s*[:：]?\\s*)?${token}`,
      "gi",
    ),
    new RegExp(
      `${token}\\s*(?:is\\s+(?:your|the)|为?您?的|是您?的)\\s*${label}`,
      "gi",
    ),
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = validCode(match[1]);
      if (candidate) return candidate;
    }
  }
  if (intent.test(text)) {
    const match = text.match(/(?:^|\n)\s*(\d{6})\s*(?:\n|$)/);
    if (match) return match[1];
  }
  return "";
}
function safeLink(raw: string): string {
  try {
    const url = new URL(decode(raw).trim());
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}
const actionLabel =
  /(?:^(?:verify|confirm|activate|validate|sign[ -]?in|log[ -]?in|reset\s+(?:your\s+)?password)|验证(?:邮箱|邮件|账户|账号)|(?:确认|激活)(?:邮箱|邮件|账户|账号)|重置密码|登录账户|登入)/i;
const actionPath =
  /(?:^|[\/_.?=&-])(?:verify|verification|activate|activation|confirm|confirmation|magic[/-]?link|reset[/-]?password)(?:[\/_.?=&-]|$)|\/auth\/callback(?:[/?]|$)/i;
const ignoredLink =
  /(?:^|[\/_.?=&-])(?:unsubscribe|privacy|terms|help|support|docs)(?:[\/_.?=&-]|$)/i;
function findLink(text: string, html: string): string {
  const candidates: { url: string; score: number }[] = [];
  const add = (raw: string, caption = "") => {
    const url = safeLink(raw);
    if (!url) return;
    const parsed = new URL(url),
      route = parsed.pathname + parsed.search + parsed.hash;
    if (ignoredLink.test(route)) return;
    const score =
      (actionLabel.test(caption.trim()) ? 10 : 0) +
      (actionPath.test(route) ? 5 : 0);
    if (score) candidates.push({ url, score });
  };
  for (const anchor of html.matchAll(/<a\b([^>]*)>([^]*?)<\/a\s*>/gi)) {
    const href = anchor[1].match(
      /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
    );
    if (href) add(href[1] ?? href[2] ?? href[3], plain(anchor[2]));
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi))
    add(match[0].replace(/[.,;!。；，！）)\]]+$/, ""));
  return candidates.sort((a, b) => b.score - a.score)[0]?.url || "";
}
export function extractVerificationInfo(
  subject = "",
  bodyText = "",
  bodyHtml = "",
): ExtractedCodeResult {
  subject = subject.slice(0, 2000);
  bodyText = bodyText.slice(0, 256000);
  bodyHtml = bodyHtml
    .slice(0, 512000)
    .replace(/<!--[^]*?-->|<(script|style|head)\b[^>]*>[^]*?<\/\1\s*>/gi, " ");
  const htmlText = plain(bodyHtml);
  return {
    code:
      findCode(decode(subject)) ||
      findCode(`${decode(subject)}\n${decode(bodyText)}\n${htmlText}`),
    link: findLink(
      `${decode(subject)}\n${decode(bodyText)}\n${htmlText}`,
      bodyHtml,
    ),
  };
}
