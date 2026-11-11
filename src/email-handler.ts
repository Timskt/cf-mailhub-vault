import PostalMime from 'postal-mime';
import type { Env } from './types';
import { extractVerificationInfo } from './code-extractor';

export async function handleIncomingEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx?: ExecutionContext
): Promise<void> {
  try {
    const rawBuffer = await new Response(message.raw).arrayBuffer();
    const parser = new PostalMime();
    const parsed = await parser.parse(rawBuffer);

    const recipient = message.to.toLowerCase().trim();
    const sender = (parsed.from?.address || message.from).toLowerCase().trim();
    const senderName = parsed.from?.name || '';
    const subject = parsed.subject || '(无主题)';
    const textContent = parsed.text || '';
    const htmlContent = parsed.html || '';
    const rawSize = rawBuffer.byteLength;

    // 1. 解析 DKIM / SPF 真实性鉴权状态
    let dkimStatus: 'pass' | 'fail' | 'none' | 'unknown' = 'unknown';
    let spfStatus: 'pass' | 'fail' | 'none' | 'unknown' = 'unknown';

    if (parsed.headers && Array.isArray(parsed.headers)) {
      for (const h of parsed.headers) {
        const k = (h.key || '').toLowerCase();
        const v = (h.value || '').toLowerCase();
        if (k === 'authentication-results' || k === 'arc-authentication-results') {
          if (v.includes('dkim=pass')) dkimStatus = 'pass';
          else if (v.includes('dkim=fail')) dkimStatus = 'fail';

          if (v.includes('spf=pass')) spfStatus = 'pass';
          else if (v.includes('spf=fail')) spfStatus = 'fail';
        }
      }
    }

    // 2. 智能提取验证码与激活链接 (借鉴 tempmail.jdyun.fun 核心优势)
    const { code: verificationCode, link: verificationLink } = extractVerificationInfo(
      subject,
      textContent,
      htmlContent
    );

    // 3. 检查收件地址是否绑定了平台注册台账 (Platform Vault)
    const boundAccount = await env.DB.prepare(
      'SELECT id, platform_name FROM platform_vault WHERE LOWER(account_email) = ? LIMIT 1'
    )
      .bind(recipient)
      .first<{ id: number; platform_name: string }>();

    const isProtected = boundAccount ? 1 : 0;

    // 4. 存入 D1 数据库
    await env.DB.prepare(
      `INSERT INTO cf_inbox_mails (
        message_id, recipient, sender, sender_name, subject,
        text_content, html_content, raw_size, verification_code,
        verification_link, dkim_status, spf_status, is_protected
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        (parsed.messageId || `msg_${Date.now()}`).substring(0, 200),
        recipient,
        sender,
        senderName.substring(0, 100),
        subject.substring(0, 500),
        textContent,
        htmlContent,
        rawSize,
        verificationCode,
        verificationLink,
        dkimStatus,
        spfStatus,
        isProtected
      )
      .run();

    // 5. 如果绑定了平台，自动同步更新台账中的最新验证码缓存
    if (boundAccount && verificationCode) {
      await env.DB.prepare(
        "UPDATE platform_vault SET last_code = ?, last_code_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
      )
        .bind(verificationCode, boundAccount.id)
        .run();
    }

    // 6. 可选 Telegram 通知推送
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      const codeNotice = verificationCode ? `\n⚡ <b>验证码</b>: <code>${verificationCode}</code>` : '';
      const platformNotice = boundAccount ? `\n🏷️ <b>关联平台</b>: ${boundAccount.platform_name}` : '';
      const text = `📬 <b>收到新邮件</b>\n📧 <b>收件箱</b>: <code>${recipient}</code>\n👤 <b>发件人</b>: ${sender}\n📝 <b>主题</b>: ${subject}${codeNotice}${platformNotice}`;

      const tgPromise = fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'HTML'
        })
      }).catch(err => console.error('TG push failed:', err));

      if (ctx) ctx.waitUntil(tgPromise);
    }
  } catch (error) {
    console.error('Failed to handle incoming email:', error);
  }
}
