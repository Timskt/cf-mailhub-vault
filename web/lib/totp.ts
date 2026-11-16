export type TotpConfig = {
  secret: string;
  algorithm: "SHA-1" | "SHA-256" | "SHA-512";
  digits: 6 | 8;
  period: number;
  label?: string;
  issuer?: string;
};

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const hashes = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" } as const;

function decodeSecret(input: string) {
  if (typeof input !== "string" || input.length > 1000)
    throw new Error("2FA 密钥长度无效，最多 1000 个字符。");
  const value = input.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z2-7]+={0,6}$/.test(value))
    throw new Error(
      "2FA 密钥必须是 Base32（字母 A–Z、数字 2–7），或完整 otpauth://totp/ URI。",
    );
  const secret = value.replace(/=+$/, "");
  const remainder = secret.length % 8;
  if (
    ![0, 2, 4, 5, 7].includes(remainder) ||
    (value.includes("=") &&
      value.length - secret.length !== (8 - remainder) % 8)
  )
    throw new Error("Base32 密钥长度或补位无效，请重新复制完整密钥。");
  const bytes = new Uint8Array(Math.floor((secret.length * 5) / 8));
  let buffer = 0,
    bits = 0,
    offset = 0;
  for (const char of secret) {
    buffer = (buffer << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (buffer >>> bits) & 255;
      buffer &= (1 << bits) - 1;
    }
  }
  if (buffer !== 0)
    throw new Error("Base32 密钥末尾补位无效，请重新复制完整密钥。");
  return { secret, bytes };
}

function validPeriod(period: number) {
  if (!Number.isInteger(period) || period < 1 || period > 300)
    throw new Error("TOTP 周期必须是 1–300 秒的整数。");
}

/** Parse strictly: silently ignoring HOTP, duplicate settings or custom parameters can generate wrong codes. */
export function parseTotp(input: string): TotpConfig {
  if (typeof input !== "string" || input.length > 1000)
    throw new Error("2FA 内容最多 1000 个字符。");
  const value = input.trim();
  if (!/^otpauth:/i.test(value)) {
    const decoded = decodeSecret(value);
    decoded.bytes.fill(0);
    return {
      secret: decoded.secret,
      algorithm: "SHA-1",
      digits: 6,
      period: 30,
    };
  }
  let url: URL;
  let label: string;
  try {
    url = new URL(value);
    label = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error("otpauth URI 格式无效，请重新复制。");
  }
  if (
    url.protocol !== "otpauth:" ||
    url.hostname !== "totp" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !label.trim()
  )
    throw new Error(
      "仅支持 otpauth://totp/ 时间型验证码；不支持 HOTP 或非标准地址。",
    );
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (
      !["secret", "issuer", "algorithm", "digits", "period"].includes(key) ||
      params.getAll(key).length !== 1
    )
      throw new Error("otpauth URI 含重复或不支持的参数，请核对原始配置。");
  }
  const hash = (params.get("algorithm") ?? "SHA1")
    .toUpperCase()
    .replace("-", "");
  if (!Object.hasOwn(hashes, hash))
    throw new Error("TOTP 仅支持 SHA1、SHA256、SHA512。");
  const digits = params.get("digits") ?? "6";
  if (digits !== "6" && digits !== "8")
    throw new Error("TOTP 位数仅支持 6 或 8。");
  const periodValue = params.get("period") ?? "30";
  if (!/^[1-9]\d*$/.test(periodValue))
    throw new Error("TOTP 周期必须是 1–300 秒的整数。");
  const period = Number(periodValue);
  validPeriod(period);
  const decoded = decodeSecret(params.get("secret") ?? "");
  decoded.bytes.fill(0);
  return {
    secret: decoded.secret,
    algorithm: hashes[hash as keyof typeof hashes],
    digits: Number(digits) as 6 | 8,
    period,
    label,
    ...(params.has("issuer") ? { issuer: params.get("issuer")! } : {}),
  };
}

/** The existing totp_secret field stores either Base32 or a URI, preserving non-default settings. */
export function normalizeTotp(input: string) {
  const config = parseTotp(input);
  if (!config.label) return config.secret;
  const params = new URLSearchParams({
    secret: config.secret,
    algorithm: config.algorithm.replace("-", ""),
    digits: String(config.digits),
    period: String(config.period),
  });
  if (config.issuer !== undefined) params.set("issuer", config.issuer);
  const normalized = `otpauth://totp/${encodeURIComponent(config.label)}?${params}`;
  if (normalized.length > 1000)
    throw new Error("规范化后的 2FA URI 超过 1000 个字符，请缩短账户标签。");
  return normalized;
}

export function totpWindow(period: number, timestamp = Date.now()) {
  validPeriod(period);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0)
    throw new Error("设备时间无效，请检查系统时钟。");
  const counter = Math.floor(timestamp / (period * 1000));
  const expiresAt = (counter + 1) * period * 1000;
  return {
    counter,
    expiresAt,
    remainingSeconds: Math.ceil((expiresAt - timestamp) / 1000),
  };
}

/** RFC 6238, T0 = 0. No requests or storage; HMAC runs only through Web Crypto. */
export async function generateTotp(config: TotpConfig, timestamp = Date.now()) {
  const { counter } = totpWindow(config.period, timestamp);
  if (
    ![6, 8].includes(config.digits) ||
    !Object.values(hashes).includes(config.algorithm)
  )
    throw new Error("TOTP 算法或位数不受支持。");
  if (!globalThis.crypto?.subtle)
    throw new Error(
      "浏览器无法使用 Web Crypto，请通过 HTTPS 或 localhost 打开。",
    );
  const { bytes } = decodeSecret(config.secret);
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      bytes,
      { name: "HMAC", hash: config.algorithm },
      false,
      ["sign"],
    );
    const message = new ArrayBuffer(8);
    new DataView(message).setBigUint64(0, BigInt(counter), false);
    const digest = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, message),
    );
    const offset = digest[digest.length - 1] & 15;
    const truncated =
      new DataView(digest.buffer).getUint32(offset, false) & 0x7fffffff;
    return String(truncated % 10 ** config.digits).padStart(config.digits, "0");
  } finally {
    bytes.fill(0);
  }
}
