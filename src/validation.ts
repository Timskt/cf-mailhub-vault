import { HTTPException } from "hono/http-exception";

export function invalid(message: string): never {
  throw new HTTPException(400, { message });
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("请提供 JSON 对象");
  return value as Record<string, unknown>;
}

export function text(
  value: unknown,
  name: string,
  max = 1000,
  fallback = "",
): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length > max)
    invalid(`${name} 必须是长度不超过 ${max} 的文本`);
  return value;
}

export function integer(
  value: unknown,
  name: string,
  min: number,
  max: number,
  fallback?: number,
): number {
  if ((value === undefined || value === "") && fallback !== undefined)
    return fallback;
  if (typeof value !== "string" && typeof value !== "number")
    invalid(`${name} 必须是整数`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    invalid(`${name} 须在 ${min}–${max} 之间`);
  return number;
}

export function email(value: unknown): string {
  const address = text(value, "邮箱地址", 254).trim().toLowerCase();
  if (!/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(address))
    invalid("请输入有效的邮箱地址");
  return address;
}

export function choice<T extends string>(
  value: unknown,
  name: string,
  values: readonly T[],
  fallback?: T,
): T {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !values.includes(value as T))
    invalid(`${name} 无效`);
  return value as T;
}

export function boolean(
  value: unknown,
  name: string,
  fallback = false,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") invalid(`${name} 必须为 true 或 false`);
  return value;
}

export function since(value: unknown): string {
  const date = text(value, "since", 40).trim();
  if (
    date &&
    (!/^\d{4}-\d{2}-\d{2}T/.test(date) ||
      !/(Z|[+-]\d{2}:\d{2})$/i.test(date) ||
      !Number.isFinite(Date.parse(date)))
  )
    invalid("since 请使用带时区的 ISO 8601 时间");
  return date ? new Date(date).toISOString() : "";
}

export function httpUrl(value: unknown): string {
  const input = text(value, "网址", 2048).trim();
  if (!input) return "";
  try {
    const url = new URL(input);
    if (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
      return url.href;
  } catch {
    /* reported below */
  }
  return invalid("网址必须以 https:// 或 http:// 开头");
}

export const placeholders = (count: number) => Array(count).fill("?").join(",");
