import { email, invalid, object, text } from "./validation";
export const DEFAULT_MICROSOFT_CLIENT_ID =
  "9e5f94bc-e8a4-4e73-b8be-63364c29d753";
export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_IMPORT = 200;
const DELIMITERS = ["----", "---", "\t", "::", "|", ","];
const HEADER_NAMES: Record<string, string> = {
  邮箱: "email",
  email: "email",
  密码: "password",
  password: "password",
  clientid: "client_id",
  client_id: "client_id",
  refreshtoken: "refresh_token",
  refresh_token: "refresh_token",
  刷新令牌: "refresh_token",
  备注: "remark",
  remark: "remark",
  note: "remark",
};
export interface ImportAccount {
  email: string;
  password: string;
  client_id: string;
  refresh_token: string;
  remark: string;
}
export interface ImportRow {
  line: number;
  account?: ImportAccount;
  error?: string;
  warning?: string;
  duplicate?: boolean;
}
export function validateAccount(value: unknown): ImportAccount {
  const input = object(value);
  const client =
    text(
      input.client_id ?? input.clientId,
      "Client ID",
      100,
      DEFAULT_MICROSOFT_CLIENT_ID,
    ).trim() || DEFAULT_MICROSOFT_CLIENT_ID;
  if (!UUID_REGEX.test(client)) invalid("Client ID 必须是有效的应用 UUID");
  const token = text(
    input.refresh_token ?? input.refreshToken ?? input.token,
    "Refresh Token",
    16384,
  ).trim();
  if (token.length < 20 || /\s/.test(token) || /\.{3}$|…$/.test(token))
    invalid("Refresh Token 不完整，请粘贴完整令牌");
  return {
    email: email(input.email ?? input.username ?? input.mail),
    password: text(input.password ?? input.pwd, "密码", 1000),
    client_id: client,
    refresh_token: token,
    remark: text(input.remark ?? input.note, "备注", 1000),
  };
}
function fields(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let value = "",
    quoted = false,
    wasQuoted = false;
  const push = () => {
    result.push(wasQuoted ? value : value.trim());
    value = "";
    wasQuoted = false;
  };
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"' && (quoted || value.trim() === "")) {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else {
        quoted = !quoted;
        wasQuoted = true;
      }
    } else if (!quoted && line.startsWith(delimiter, i)) {
      push();
      i += delimiter.length - 1;
    } else value += line[i];
  }
  if (quoted) invalid("引号未闭合；多行字段请使用 JSON 数组");
  push();
  return result;
}
function parseLine(line: string): ImportAccount {
  if (line.startsWith("{")) return validateAccount(JSON.parse(line));
  const delimiter = DELIMITERS.find((d) => line.includes(d));
  const parts = delimiter ? fields(line, delimiter) : line.split(/\s+/);
  if (parts.length < 2)
    invalid("无法识别字段，请使用 邮箱----密码----Client ID----Refresh Token");
  const address = parts.shift();
  const clientIndex =
    parts.length >= 3 && UUID_REGEX.test(parts[1])
      ? 1
      : parts.length >= 3 && UUID_REGEX.test(parts[2])
        ? 2
        : parts.length === 2 && UUID_REGEX.test(parts[0])
          ? 0
          : -1;
  let client = "";
  if (clientIndex >= 0) client = parts.splice(clientIndex, 1)[0];
  // Standard columns are positional. A password can itself start with M. or be very long.
  let tokenIndex =
    parts.length >= 2
      ? 1
      : parts.length === 1 && parts[0].length >= 20
        ? 0
        : -1;
  if (tokenIndex < 0) invalid("未识别到 Refresh Token");
  const token = parts.splice(tokenIndex, 1)[0];
  const password = parts.shift() || "";
  return validateAccount({
    email: address,
    password,
    client_id: client || DEFAULT_MICROSOFT_CLIENT_ID,
    refresh_token: token,
    remark: parts.join(" | "),
  });
}
function parseHeader(line: string) {
  const caption = /^导出内容\s*[（(]\s*格式\s*[：:]\s*(.*?)\s*[）)]$/.exec(
    line,
  );
  const content = caption?.[1] ?? line;
  // Only a declared column header is skipped; malformed account lines still surface errors.
  if (!/^(email|邮箱)\s*(?:----|---|\t|::|\||,)/i.test(content)) return;
  const delimiter = DELIMITERS.find((d) => content.includes(d));
  if (!delimiter) return;
  const names = fields(content, delimiter).map((name) =>
    Object.hasOwn(HEADER_NAMES, name.trim().toLowerCase())
      ? HEADER_NAMES[name.trim().toLowerCase()]
      : name.trim(),
  );
  if (names[0] === "email" && names.includes("refresh_token"))
    return { names, delimiter };
}
export function parseImport(raw: unknown): {
  rows: ImportRow[];
  accounts: ImportAccount[];
  valid_count: number;
  error_count: number;
  duplicate_count: number;
} {
  const content = text(raw, "导入内容", 1024 * 1024)
    .replace(/^\uFEFF/, "")
    .trim();
  if (new TextEncoder().encode(content).byteLength > 1024 * 1024)
    invalid("导入内容超过 1 MiB，请拆分导入");
  let input: { value: unknown; line: number }[];
  let json: unknown;
  if (content.startsWith("[") || content.startsWith("{")) {
    try {
      json = JSON.parse(content);
    } catch {
      if (content.startsWith("[")) return invalid("JSON 数组格式无效");
    }
  }
  if (json !== undefined) {
    let parsed: unknown;
    parsed = Array.isArray(json) ? json : (object(json).accounts ?? [json]);
    if (!Array.isArray(parsed)) invalid("accounts 必须是 JSON 数组");
    input = parsed.map((value, index) => ({ value, line: index + 1 }));
  } else {
    input = content
      .split(/\r?\n/)
      .map((value, i) => ({ value: value.trim(), line: i + 1 }))
      .filter(
        (r) => r.value && !r.value.startsWith("#") && !r.value.startsWith("//"),
      );
  }
  let headers: string[] | undefined;
  let headerDelimiter = ",";
  const rows: ImportRow[] = [];
  const unique = new Map<string, ImportAccount>();
  for (const item of input) {
    try {
      let account: ImportAccount;
      if (typeof item.value === "string") {
        const header = parseHeader(item.value);
        if (header) {
          headerDelimiter = header.delimiter;
          headers = header.names;
          continue;
        }
        if (headers) {
          const values = fields(item.value, headerDelimiter);
          account = validateAccount(
            Object.fromEntries(
              headers.map((name, i) => [
                name === "邮箱" ? "email" : name,
                values[i] ?? "",
              ]),
            ),
          );
        } else account = parseLine(item.value);
      } else account = validateAccount(item.value);
      const duplicate = unique.has(account.email);
      unique.set(account.email, account);
      rows.push({
        line: item.line,
        account,
        duplicate,
        warning:
          account.client_id === DEFAULT_MICROSOFT_CLIENT_ID
            ? "使用兼容 Client ID，可正常导入；授权状态请在导入后测试连接"
            : undefined,
      });
    } catch (error) {
      rows.push({
        line: item.line,
        error:
          error instanceof Error && error.name !== "SyntaxError"
            ? error.message
            : "JSON 格式无效",
      });
    }
    if (rows.length > MAX_IMPORT)
      invalid(`每批最多 ${MAX_IMPORT} 条记录，请拆分导入`);
  }
  return {
    rows,
    accounts: [...unique.values()],
    valid_count: unique.size,
    error_count: rows.filter((r) => r.error).length,
    duplicate_count: rows.filter((r) => r.duplicate).length,
  };
}
export function importPreview(parsed: ReturnType<typeof parseImport>) {
  return {
    ...parsed,
    accounts: undefined,
    rows: parsed.rows.map(({ account, ...row }) => ({
      ...row,
      ...(account
        ? {
            email: account.email,
            client_id: account.client_id,
            has_password: Boolean(account.password),
            has_refresh_token: true,
            remark: account.remark,
          }
        : {}),
    })),
  };
}
