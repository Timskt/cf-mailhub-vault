import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountTextColumns,
  accountTextTemplate,
  hasSpreadsheetFormula,
  parseDelimited,
  serializeAccountText,
  serializeDelimited,
} from "../shared/account-text";

test("delimited parser keeps physical line numbers, BOM, CRLF, empty fields and quoted newlines", () => {
  assert.deepEqual(
    parseDelimited(
      '\uFEFFemail,password,remark\r\n\r\n"demo@example.com"," p,""ass"" ","first\r\nsecond"\r\nother@example.com,,\r\n',
      ",",
    ),
    [
      { line: 1, values: ["email", "password", "remark"] },
      {
        line: 3,
        values: ["demo@example.com", ' p,"ass" ', "first\r\nsecond"],
      },
      { line: 5, values: ["other@example.com", "", ""] },
    ],
  );
});

test("four-hyphen parser preserves quoted delimiters, whitespace and literal formula-like passwords", () => {
  assert.deepEqual(
    parseDelimited(
      'email----password----remark\nuser@example.com----" =p----""quoted"" "----"备注\n第二行"\nnext@example.com----  secret  ----',
      "----",
    ),
    [
      { line: 1, values: ["email", "password", "remark"] },
      {
        line: 2,
        values: ["user@example.com", ' =p----"quoted" ', "备注\n第二行"],
      },
      { line: 4, values: ["next@example.com", "  secret  ", ""] },
    ],
  );
});

test("serializing and parsing is lossless for CSV, tabs and overlapping multi-character delimiters", () => {
  const values = [
    "",
    "plain",
    "----",
    "ending-",
    "ending--",
    "ending---",
    "ab",
    "aba",
    "aa",
    "::",
    "ends:",
    "  whitespace  ",
    "\tsecret",
    "\uFEFFat-the-start",
    "\r\n\n\r",
    '"quoted"',
    "one,two",
    "=SUM(1,2)",
    "@example",
    "汉字🔑",
  ];
  for (const delimiter of [",", "----", "\t", "::", "aba", "aa"]) {
    const rows = values.map((value, i) => [
      value,
      values[(i + 1) % values.length],
      values[(i + 2) % values.length],
    ]);
    rows.push([""], ["", ""], ["\uFEFF"]);
    const serialized = serializeDelimited(rows, delimiter);
    assert.deepEqual(
      parseDelimited(serialized, delimiter).map((row) => row.values),
      rows,
      `lossless ${JSON.stringify(delimiter)} round trip`,
    );
  }
});

test("serializer emits ordinary unquoted fields and escapes only when needed", () => {
  assert.equal(
    serializeDelimited(
      [["demo@example.com", ' password----"quote" ', "", "token"]],
      "----",
    ),
    'demo@example.com----" password----""quote"" "--------token',
  );
  assert.equal(serializeDelimited([[""]], ","), '""');
  assert.equal(serializeDelimited([], ","), "");
  assert.deepEqual(parseDelimited("\uFEFF\r\n\n", ","), []);
  assert.deepEqual(parseDelimited('""\r\n,\rtext', ","), [
    { line: 1, values: [""] },
    { line: 2, values: ["", ""] },
    { line: 3, values: ["text"] },
  ]);
});

test("malformed quoted fields fail with a useful line and never echo credentials", () => {
  for (const input of [
    'header,password\nuser,"private-secret',
    'header,password\nuser,"private-secret"suffix',
    'header,password\nuser,private-secret"',
  ]) {
    assert.throws(
      () => parseDelimited(input, ","),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /第 2 行/);
        assert.equal(error.message.includes("private-secret"), false);
        return true;
      },
    );
  }
});

test("invalid delimiter and unrepresentable records fail explicitly", () => {
  for (const delimiter of ["", '"', "a\nb", "\r"]) {
    assert.throws(() => parseDelimited("value", delimiter), /分隔符/);
    assert.throws(() => serializeDelimited([["value"]], delimiter), /分隔符/);
  }
  assert.throws(() => serializeDelimited([[]], ","), /至少.*字段/);
  assert.throws(
    () => serializeDelimited([[undefined as unknown as string]], ","),
    /字符串/,
  );
});

test("Outlook export defaults to exactly four named columns, with optional lossless remark", () => {
  const account = {
    email: "demo@example.com",
    password: ' \tpass----"word"\n ',
    client_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    refresh_token: "FICTIONAL_TOKEN_FOR_TESTS_ONLY",
    remark: " 多行\r\n备注----保留 ",
    group_id: 7,
  };
  const standard = parseDelimited(
    serializeAccountText([account], "outlook"),
    "----",
  );
  assert.deepEqual(standard[0].values, [
    "email",
    "password",
    "client_id",
    "refresh_token",
  ]);
  assert.deepEqual(standard[1].values, [
    account.email,
    account.password,
    account.client_id,
    account.refresh_token,
  ]);
  for (const format of ["text", "csv"] as const) {
    const rows = parseDelimited(
      serializeAccountText([account], "outlook", {
        format,
        includeRemark: true,
      }),
      format === "csv" ? "," : "----",
    );
    assert.equal(rows[0].values[4], "remark");
    assert.equal(rows[1].values[1], account.password);
    assert.equal(rows[1].values[4], account.remark);
  }
});

test("vault export has a stable human-readable order and fills absent optional fields with empty strings", () => {
  const columns = accountTextColumns("vault").map((column) => column.key);
  assert.deepEqual(columns, [
    "platform_name",
    "account_email",
    "password",
    "username",
    "email_source",
    "category",
    "status",
    "platform_url",
    "totp_secret",
    "proxy_node",
    "remark",
  ]);
  const [header, row] = parseDelimited(
    serializeAccountText(
      [
        {
          platform_name: "示例平台",
          account_email: "demo@example.com",
          password: undefined,
          username: null,
          remark: ' "保留空格"\n多行----内容 ',
        },
      ],
      "vault",
    ),
    "----",
  );
  assert.deepEqual(header.values, columns);
  assert.deepEqual(row.values, [
    "示例平台",
    "demo@example.com",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    ' "保留空格"\n多行----内容 ',
  ]);
  assert.throws(
    () => serializeAccountText([{ password: { private: "secret" } }], "vault"),
    /字段.*文本/,
  );
});

test("copyable fake templates have named columns matching their data", () => {
  for (const kind of ["vault", "outlook"] as const) {
    for (const format of ["text", "csv"] as const) {
      const parsed = parseDelimited(
        accountTextTemplate(kind, { format, includeRemark: true }),
        format === "csv" ? "," : "----",
      );
      assert.equal(parsed.length, 2);
      assert.equal(parsed[0].values.length, parsed[1].values.length);
      assert.ok(
        parsed[1].values.some((value) => value.includes("example.com")),
      );
    }
  }
});

test("spreadsheet formula detection is explicit and never mutates credential values", () => {
  for (const value of [
    "=SUM(1,2)",
    "+123",
    "-123",
    "@cmd",
    " =cmd",
    "\tplain",
    "\rplain",
    "＝cmd",
  ]) {
    assert.equal(hasSpreadsheetFormula(value), true);
    assert.equal(
      parseDelimited(serializeDelimited([[value]], ","), ",")[0].values[0],
      value,
    );
  }
  for (const value of ["plain", "demo@example.com", "abc=1", "12345", ""]) {
    assert.equal(hasSpreadsheetFormula(value), false);
  }
});
