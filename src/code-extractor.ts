/**
 * 智能验证码与激活链接提取引擎 (Smart OTP & Verification Link Extractor)
 * 支持中英文常见验证码格式、上下文加权推断
 */

export interface ExtractedCodeResult {
  code: string;
  link: string;
}

const OTP_PATTERNS = [
  // 模式 1: 带有明显上下文指示词的 4-8 位纯数字
  /(?:验证码|校验码|动态码|安全码|激活码|确认码|auth\s*code|verification\s*code|verify\s*code|security\s*code|confirmation\s*code|one-time\s*password|otp|passcode)[^\d\r\n]{0,25}[:：\s]?\s*(?:[【\[\(\{\<])?(\d{4,8})(?:[】\]\)\}\>])?/i,
  // 模式 2: 英文 "is 123456" 或 "code: 123456"
  /(?:your\s+code\s+is|is\s+your\s+code|code\s+is|use\s+code|enter\s+code)[^\d\r\n]{0,15}[:：\s]?\s*(?:[【\[\(\{\<])?(\d{4,8})(?:[】\]\)\}\>])?/i,
  // 模式 3: 独立方括号或大写字母混合码，如 [849201] 或 【849201】
  /[【\[]([A-Za-z0-9]{4,8})[】\]]/,
  // 模式 4: HTML 标签包裹的单行粗体/突出大号数字
  /<(?:b|strong|span|h[1-4]|div)[^>]*?>\s*([0-9]{4,8})\s*<\/(?:b|strong|span|h[1-4]|div)>/i,
  // 模式 5: 孤立的 6 位数字行
  /(?:^|\s|\n)(\d{6})(?:\s|\n|$)/
];

const LINK_PATTERNS = [
  // 常见激活与验证链接
  /https?:\/\/[^\s"'<>]+?(?:verify|verification|activate|activation|confirm|signup-confirm|auth\/callback)[^\s"'<>]*/i,
  /href=["'](https?:\/\/[^"']*(?:verify|confirm|activate)[^"']*)["']/i
];

export function extractVerificationInfo(subject: string = '', bodyText: string = '', bodyHtml: string = ''): ExtractedCodeResult {
  const fullContent = `${subject}\n${bodyText}\n${bodyHtml}`;
  let extractedCode = '';
  let extractedLink = '';

  // 1. 尝试从标题和正文中匹配验证码
  for (const pattern of OTP_PATTERNS) {
    const match = fullContent.match(pattern);
    if (match && match[1]) {
      const candidate = match[1].trim();
      // 过滤掉非典型年份 (如 2024, 2025, 2026) 如果长度是4位且开头是20
      if (candidate.length === 4 && (candidate.startsWith('19') || candidate.startsWith('20'))) {
        continue;
      }
      extractedCode = candidate;
      break;
    }
  }

  // 2. 尝试匹配激活/验证链接
  for (const pattern of LINK_PATTERNS) {
    const match = fullContent.match(pattern);
    if (match && match[1]) {
      extractedLink = match[1].trim();
      break;
    } else if (match && match[0] && match[0].startsWith('http')) {
      extractedLink = match[0].trim();
      break;
    }
  }

  return {
    code: extractedCode,
    link: extractedLink
  };
}
