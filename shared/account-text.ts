/**
 * The human-readable account interchange format used by the web UI.
 *
 * This parser deliberately follows the small, useful part of RFC 4180 that
 * matters here: fields may be quoted, quotes are escaped by doubling them,
 * and a quoted field may contain a record separator. It also works with
 * multi-character separators such as `----`, which are common in account
 * lists exported by other tools.
 */

export type AccountTextKind = "vault" | "outlook";
export type AccountTextFormat = "text" | "csv";

export interface AccountTextColumn {
  key: string;
  label: string;
  example: string;
  sensitive?: boolean;
}

export interface ParsedDelimitedRow {
  /** Physical line at which the record starts; useful for import errors. */
  line: number;
  values: string[];
}

export interface AccountTextSerializeOptions {
  format?: AccountTextFormat;
  includeRemark?: boolean;
}

const OUTLOOK_COLUMNS: readonly AccountTextColumn[] = [
  {
    key: "email",
    label: "邮箱",
    example: "demo@example.com",
  },
  {
    key: "password",
    label: "密码",
    example: "Example-password-42",
    sensitive: true,
  },
  {
    key: "client_id",
    label: "Client ID",
    example: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  },
  {
    key: "refresh_token",
    label: "Refresh Token",
    example: "FICTIONAL_REFRESH_TOKEN_FOR_EXAMPLE_ONLY",
    sensitive: true,
  },
  {
    key: "remark",
    label: "备注",
    example: "示例账号",
  },
];

const VAULT_COLUMNS: readonly AccountTextColumn[] = [
  { key: "platform_name", label: "平台名称", example: "示例平台" },
  {
    key: "account_email",
    label: "账号邮箱",
    example: "demo@example.com",
  },
  {
    key: "password",
    label: "密码",
    example: "Example-password-42",
    sensitive: true,
  },
  { key: "username", label: "用户名", example: "demo-user" },
  { key: "email_source", label: "邮箱来源", example: "outlook" },
  { key: "category", label: "分类", example: "social" },
  { key: "status", label: "状态", example: "active" },
  { key: "platform_url", label: "平台地址", example: "https://example.com" },
  {
    key: "totp_secret",
    label: "TOTP 密钥",
    example: "JBSWY3DPEHPK3PXP",
    sensitive: true,
  },
  { key: "proxy_node", label: "代理节点", example: "direct" },
  { key: "remark", label: "备注", example: "示例账号" },
];

const columnsByKind: Record<AccountTextKind, readonly AccountTextColumn[]> = {
  outlook: OUTLOOK_COLUMNS,
  vault: VAULT_COLUMNS,
};

function validateDelimiter(delimiter: string): void {
  if (
    typeof delimiter !== "string" ||
    delimiter.length === 0 ||
    delimiter.includes("\r") ||
    delimiter.includes("\n") ||
    delimiter.includes('"')
  ) {
    throw new Error("分隔符必须是非空且不包含引号或换行的字符串");
  }
}

function parseError(line: number, reason: string): never {
  // Never include the offending field: these rows contain credentials.
  throw new Error(`第 ${line} 行格式无效：${reason}`);
}

function isRecordSeparator(value: string, index: number): boolean {
  return value[index] === "\n" || value[index] === "\r";
}

/**
 * Parse delimited records while preserving every character in every field.
 * Blank physical lines are ignored. A quoted CRLF remains CRLF in the value.
 */
export function parseDelimited(
  input: string,
  delimiter: string,
): ParsedDelimitedRow[] {
  validateDelimiter(delimiter);
  if (typeof input !== "string") throw new Error("导入内容必须是字符串");

  const value = input.startsWith("\uFEFF") ? input.slice(1) : input;
  const rows: ParsedDelimitedRow[] = [];
  const fields: string[] = [];
  let field = "";
  let fieldStarted = false;
  let quoted = false;
  let closedQuote = false;
  let recordLine = 1;
  let line = 1;
  let index = 0;

  const pushField = () => {
    fields.push(field);
    field = "";
    fieldStarted = false;
    closedQuote = false;
  };
  const pushRecord = () => {
    // A completely empty physical line is not an account record. A quoted
    // empty cell and a comma-only row are records and must be preserved.
    if (fields.length > 0 || fieldStarted || field.length > 0) {
      pushField();
      rows.push({ line: recordLine, values: fields.splice(0) });
    }
    field = "";
    fieldStarted = false;
    closedQuote = false;
  };
  const consumeSeparator = () => {
    if (value[index] === "\r" && value[index + 1] === "\n") index++;
    line++;
    index++;
  };

  while (index < value.length) {
    const character = value[index];

    if (quoted) {
      if (character === '"') {
        if (value[index + 1] === '"') {
          field += '"';
          fieldStarted = true;
          index += 2;
        } else {
          quoted = false;
          closedQuote = true;
          index++;
        }
        continue;
      }
      field += character;
      fieldStarted = true;
      if (isRecordSeparator(value, index)) {
        if (character === "\r" && value[index + 1] === "\n") field += "\n";
        consumeSeparator();
      } else index++;
      continue;
    }

    if (closedQuote) {
      if (value.startsWith(delimiter, index)) {
        pushField();
        index += delimiter.length;
        continue;
      }
      if (isRecordSeparator(value, index)) {
        pushRecord();
        consumeSeparator();
        recordLine = line;
        continue;
      }
      parseError(recordLine, "关闭引号后只能接分隔符、换行或文件结束");
    }

    if (!fieldStarted && character === '"') {
      quoted = true;
      fieldStarted = true;
      index++;
      continue;
    }
    if (value.startsWith(delimiter, index)) {
      pushField();
      index += delimiter.length;
      continue;
    }
    if (isRecordSeparator(value, index)) {
      pushRecord();
      consumeSeparator();
      recordLine = line;
      continue;
    }
    if (character === '"')
      parseError(recordLine, "引号必须包住完整字段，内部引号请写成两个引号");

    field += character;
    fieldStarted = true;
    index++;
  }

  if (quoted) parseError(recordLine, "引号未闭合");
  if (closedQuote || fieldStarted || field.length > 0 || fields.length > 0)
    pushRecord();

  return rows;
}

function serializedValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  throw new Error("账号字段必须是字符串、数字、布尔值或空值，无法转换为文本");
}

function quoteValue(
  value: string,
  delimiter: string,
  singleField: boolean,
): string {
  const needsQuotes =
    (singleField && value.length === 0) ||
    // A trailing '-' also needs quotes with '----': otherwise the parser
    // would consume it as the first character of the following separator.
    (value + delimiter).indexOf(delimiter) < value.length ||
    value.includes("\r") ||
    value.includes("\n") ||
    value.includes('"') ||
    /^\s|\s$/u.test(value);
  return needsQuotes ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Serialize rows without trimming or changing any field value. */
export function serializeDelimited(
  rows: readonly (readonly string[])[],
  delimiter: string,
): string {
  validateDelimiter(delimiter);
  return rows
    .map((row) => {
      if (!Array.isArray(row) || row.length === 0)
        throw new Error("每条记录至少需要一个字段");
      return row
        .map((cell) => {
          if (typeof cell !== "string") throw new Error("字段必须是字符串");
          return quoteValue(cell, delimiter, row.length === 1);
        })
        .join(delimiter);
    })
    .join("\n");
}

/**
 * Return the stable, documented column order. Outlook's remark is opt-in;
 * vault exports always retain the standard remark column.
 */
export function accountTextColumns(
  kind: AccountTextKind,
  includeRemark = false,
): readonly AccountTextColumn[] {
  const columns = columnsByKind[kind];
  if (kind === "outlook" && !includeRemark)
    return columns.filter((column) => column.key !== "remark");
  return columns;
}

function delimiterFor(format: AccountTextFormat): string {
  return format === "csv" ? "," : "----";
}

/** Serialize account records with the fixed human-facing field order. */
export function serializeAccountText(
  records: readonly Record<string, unknown>[],
  kind: AccountTextKind,
  options: AccountTextSerializeOptions = {},
): string {
  const format = options.format || "text";
  const columns = accountTextColumns(kind, options.includeRemark);
  const rows = [
    columns.map((column) => column.key),
    ...records.map((record) =>
      columns.map((column) => serializedValue(record[column.key])),
    ),
  ];
  return serializeDelimited(rows, delimiterFor(format));
}

/** A copyable example that contains no real credential. */
export function accountTextTemplate(
  kind: AccountTextKind,
  options: AccountTextSerializeOptions = {},
): string {
  const columns = accountTextColumns(kind, options.includeRemark);
  const example = Object.fromEntries(
    columns.map((column) => [column.key, column.example]),
  );
  return serializeAccountText([example], kind, options);
}

/**
 * Values beginning with spreadsheet formula operators are safe as account
 * data but deserve a visible warning before opening the file in a spreadsheet.
 * The value is intentionally not prefixed with an apostrophe: that would
 * silently change passwords and tokens.
 */
export function hasSpreadsheetFormula(value: string): boolean {
  if (typeof value !== "string") return false;
  return /^[\t\r\n]|^\s*[=+\-@＝＋－＠]/u.test(value);
}

export function accountTextDelimiter(format: AccountTextFormat): string {
  return delimiterFor(format);
}
