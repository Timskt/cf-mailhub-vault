import assert from "node:assert/strict";
import test from "node:test";
import {
  serializeAccountText,
  serializeDelimited,
} from "../shared/account-text";
import * as vaultImport from "../src/vault-import";
import {
  parseVaultImport,
  validateVaultAccount,
  vaultColumns,
  vaultIdentity,
} from "../src/vault-import";
import { parseImport } from "../src/outlook-import";
import { ACCOUNT, database } from "./helpers";

const identityDefaults = {
  workspace: "",
  account_identifier: "",
  login_methods: '["unknown"]',
  mailbox_address: "",
  mailbox_link_state: "auto",
  verification_sender: "",
  verification_keyword: "",
  registered_at: "",
  last_verified_at: "",
  expires_at: "",
};

test("vault fixed text and CSV preserve credentials, delimiters, quotes, empty values and multiline notes", () => {
  const account = {
    platform_name: "GitHub",
    account_email: "demo@example.test",
    password: '  pass----"word"  ',
    username: "demo",
    email_source: "external",
    category: "工具",
    status: "active",
    platform_url: "https://example.test/",
    totp_secret: "JBSWY3DPEHPK3PXP",
    proxy_node: "",
    remark: 'line one\r\nline two, "quoted"----end',
  };
  for (const format of ["text", "csv"] as const) {
    const parsed = parseVaultImport(
      serializeAccountText([account], "vault", { format }),
    );
    assert.equal(parsed.error_count, 0);
    assert.deepEqual(parsed.accounts[0], {
      ...account,
      ...identityDefaults,
      is_pinned: 0,
    });
  }
  const simple = parseVaultImport(
    "demo@example.test----password----demo",
    "GitHub",
  );
  assert.equal(simple.accounts[0].platform_name, "GitHub");
  assert.equal(simple.accounts[0].password, "password");
  assert.equal(
    parseVaultImport("平台----邮箱----密码\nGitHub----demo@example.test----pw")
      .accounts[0].password,
    "pw",
  );
});

test("vault identities distinguish sources, workspaces, account identifiers and login methods", () => {
  const base = {
    platform_name: "Platform",
    account_email: "demo@example.test",
    username: "demo",
    email_source: "external" as const,
    workspace: "personal",
    account_identifier: "account-1",
    login_methods: '["google","password"]',
  };
  for (const patch of [
    { email_source: "outlook" as const },
    { workspace: "team" },
    { account_identifier: "account-2" },
    { login_methods: '["microsoft"]' },
    { username: "another" },
  ]) {
    assert.notEqual(vaultIdentity(base), vaultIdentity({ ...base, ...patch }));
  }
  assert.equal(
    vaultIdentity(base),
    vaultIdentity({
      ...base,
      platform_name: "PLATFORM",
      account_email: "DEMO@EXAMPLE.TEST",
      login_methods: '["password","google","google"]',
    }),
  );
  assert.equal(
    vaultIdentity({
      platform_name: "Platform",
      account_email: "demo@example.test",
      username: "demo",
    }),
    vaultIdentity({
      platform_name: "Platform",
      account_email: "demo@example.test",
      username: "demo",
      email_source: "cf_domain",
      ...identityDefaults,
    }),
  );
  assert.notEqual(
    vaultIdentity({ ...base, workspace: "a\0b", account_identifier: "c" }),
    vaultIdentity({ ...base, workspace: "a", account_identifier: "b\0c" }),
  );
});

test("vault import deduplication retains distinct identities and aligns field metadata with the last duplicate", () => {
  const base = {
    platform_name: "Platform",
    account_email: "demo@example.test",
    email_source: "external",
    workspace: "personal",
    account_identifier: "account-1",
    login_methods: '["password","google"]',
    password: "private-password",
  };
  const parsed = parseVaultImport(
    JSON.stringify([
      base,
      { ...base, email_source: "outlook" },
      { ...base, workspace: "team" },
      { ...base, account_identifier: "account-2" },
      { ...base, login_methods: '["sso"]' },
      {
        platform_name: "PLATFORM",
        account_email: base.account_email,
        email_source: "external",
        workspace: "personal",
        account_identifier: "account-1",
        login_methods: '["google","password"]',
        remark: "last duplicate",
      },
      { platform_name: "invalid", account_email: "not-an-email" },
    ]),
  );
  assert.equal(parsed.valid_count, 5);
  assert.equal(parsed.duplicate_count, 1);
  assert.equal(parsed.error_count, 1);
  assert.equal(parsed.accounts[0].remark, "last duplicate");
  assert.deepEqual(
    parsed.rows.map((row) => row.line),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.equal(parsed.rows[5].duplicate, true);
  assert.deepEqual(parsed.rows[6].provided_fields, [
    "platform_name",
    "account_email",
  ]);
  assert.equal(parsed.provided_fields?.length, parsed.accounts.length);
  assert.deepEqual(parsed.provided_fields?.[0], parsed.rows[5].provided_fields);
  assert.equal(parsed.provided_fields?.[0].includes("password"), false);
  assert.equal(parsed.provided_fields?.[1].includes("password"), true);
  assert.equal("provided_fields" in parsed.accounts[0], false);
  const { accounts, ...preview } = parsed;
  assert.equal(JSON.stringify(preview).includes("private-password"), false);
});

test("vault validation supplies deterministic identity and lifecycle defaults without inferring login methods", () => {
  const result = validateVaultAccount({
    platform_name: "Platform",
    account_email: "demo@example.test",
    password: "stored-password",
  });
  for (const [field, expected] of Object.entries(identityDefaults)) {
    assert.equal(result[field as keyof typeof result], expected, field);
  }
});

test("vault validation accepts bounded metadata, canonical login methods and explicit ISO timestamps", () => {
  const result = validateVaultAccount({
    platform_name: "Platform",
    account_email: "login@example.test",
    workspace: "w".repeat(100),
    account_identifier: "i".repeat(200),
    login_methods:
      '["unknown","passkey","magic_link","sso","microsoft","google","password","google"]',
    mailbox_address: " DELIVERY@EXAMPLE.TEST ",
    mailbox_link_state: "detached",
    verification_sender: "s".repeat(254),
    verification_keyword: "k".repeat(200),
    registered_at: "2024-02-29T12:34:56+08:00",
    last_verified_at: "2026-11-17T01:02:03.123Z",
    expires_at: "2027-01-01T00:00:00Z",
  });
  assert.equal(result.workspace.length, 100);
  assert.equal(result.account_identifier.length, 200);
  assert.deepEqual(JSON.parse(result.login_methods), [
    "google",
    "magic_link",
    "microsoft",
    "passkey",
    "password",
    "sso",
    "unknown",
  ]);
  assert.equal(result.mailbox_address, "delivery@example.test");
  assert.equal(result.mailbox_link_state, "detached");
  assert.equal(result.verification_sender.length, 254);
  assert.equal(result.verification_keyword.length, 200);
  assert.equal(result.registered_at, "2024-02-29T04:34:56.000Z");
  assert.equal(result.last_verified_at, "2026-11-17T01:02:03.123Z");
  assert.equal(result.expires_at, "2027-01-01T00:00:00.000Z");
  assert.equal(
    validateVaultAccount({
      platform_name: "Platform",
      account_email: "login@example.test",
      login_methods: ["microsoft", "password", "microsoft"],
    }).login_methods,
    '["microsoft","password"]',
  );
});

test("vault validation rejects invalid identity, mailbox, login and lifecycle metadata without echoing values", () => {
  const secret = "sensitive-field-value";
  const invalidValues: [string, unknown][] = [
    ["workspace", secret.repeat(6)],
    ["workspace", 12],
    ["account_identifier", secret.repeat(11)],
    ["verification_sender", secret.repeat(13)],
    ["verification_keyword", secret.repeat(11)],
    ["mailbox_address", secret],
    ["mailbox_link_state", secret],
    ["login_methods", secret],
    ["login_methods", JSON.stringify([secret])],
    ["login_methods", '["password",1]'],
    ["login_methods", '{"password":true}'],
    ["login_methods", '"password"'],
    ["registered_at", "2026-02-30T00:00:00Z"],
    ["registered_at", "2025-02-29T00:00:00Z"],
    ["last_verified_at", "2026-11-17"],
    ["last_verified_at", "2026-11-17T00:00:00"],
    ["expires_at", "2026-11-17T00:00:00+25:00"],
    ["expires_at", "now"],
    ["expires_at", 123456],
  ];
  for (const [field, value] of invalidValues) {
    assert.throws(
      () =>
        validateVaultAccount({
          platform_name: "Platform",
          account_email: "demo@example.test",
          [field]: value,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error, field);
        assert.equal(error.message.includes(secret), false, field);
        return true;
      },
      `${field} must reject ${typeof value}`,
    );
  }
});

test("vault provided fields reflect actual TEXT columns, CSV headers, JSON keys and email aliases", () => {
  const cases = [
    {
      raw: "Platform----demo@example.test",
      fields: ["platform_name", "account_email"],
    },
    {
      raw: "Platform----demo@example.test----",
      fields: ["platform_name", "account_email", "password"],
    },
    {
      raw: "demo@example.test----",
      platform: "Platform",
      fields: ["account_email", "password"],
    },
    {
      raw: "platform_name,account_email,remark,password\nPlatform,demo@example.test,updated,",
      fields: ["platform_name", "account_email", "remark", "password"],
    },
    {
      raw: JSON.stringify({
        platform_name: "Platform",
        email: "demo@example.test",
        password: "",
        irrelevant: "ignored",
        created_at: "2020-01-01T00:00:00Z",
      }),
      fields: ["platform_name", "account_email", "password"],
    },
  ];
  for (const { raw, platform, fields } of cases) {
    const result = parseVaultImport(raw, platform);
    assert.equal(result.error_count, 0);
    assert.deepEqual(result.provided_fields, [fields]);
    assert.deepEqual(result.rows[0].provided_fields, fields);
    assert.equal(result.accounts[0].registered_at, "");
    assert.equal(result.accounts[0].last_verified_at, "");
  }
});

test("extended vault columns append to the original eleven and round trip with TEXT and CSV headers", () => {
  const legacyColumns = [
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
  ];
  assert.deepEqual(vaultColumns.slice(0, 11), legacyColumns);
  const account = validateVaultAccount({
    platform_name: "Platform",
    account_email: "demo@example.test",
    email_source: "external",
    password: " pass----word ",
    workspace: "team, one",
    account_identifier: "tenant-123",
    login_methods: '["password","sso"]',
    mailbox_address: "delivery@example.test",
    mailbox_link_state: "detached",
    verification_sender: "sender@example.test",
    verification_keyword: "line one\nline two",
    registered_at: "2026-11-17T10:00:00Z",
    last_verified_at: "2026-11-17T11:00:00Z",
    expires_at: "2027-01-01T00:00:00Z",
  });
  for (const delimiter of ["----", ","]) {
    const columns = [...vaultColumns, "is_pinned"] as const;
    const result = parseVaultImport(
      serializeDelimited(
        [columns, columns.map((field) => String(account[field]))],
        delimiter,
      ),
    );
    assert.equal(result.error_count, 0);
    assert.deepEqual(result.accounts, [account]);
    assert.deepEqual(result.provided_fields, [columns]);
  }
  for (const format of ["text", "csv"] as const)
    assert.deepEqual(
      parseVaultImport(serializeAccountText([account], "vault", { format }))
        .accounts,
      [account],
    );
  const legacy = parseVaultImport(
    serializeDelimited(
      [
        legacyColumns.map((field) =>
          String(account[field as keyof typeof account]),
        ),
      ],
      "----",
    ),
  );
  assert.equal(legacy.error_count, 0);
  assert.deepEqual(legacy.provided_fields, [legacyColumns]);
  assert.equal(legacy.accounts[0].workspace, "");
});

test("vault merge preserves unprovided credentials and metadata while replace uses incoming defaults", () => {
  assert.equal(typeof vaultImport.mergeVaultImport, "function");
  const prior = validateVaultAccount({
    platform_name: "Platform",
    account_email: "demo@example.test",
    email_source: "external",
    password: "original-password",
    totp_secret: "original-totp",
    username: "original-user",
    category: "original-category",
    status: "banned",
    platform_url: "https://example.test/",
    proxy_node: "original-node",
    remark: "original-remark",
    is_pinned: 1,
    workspace: "original-workspace",
    account_identifier: "original-id",
    login_methods: '["password"]',
    mailbox_address: "delivery@example.test",
    mailbox_link_state: "detached",
    verification_sender: "sender@example.test",
    verification_keyword: "verification",
    registered_at: "2020-01-01T00:00:00Z",
    last_verified_at: "2021-01-01T00:00:00Z",
    expires_at: "2030-01-01T00:00:00Z",
  });
  const parsed = parseVaultImport(
    JSON.stringify({
      platform_name: prior.platform_name,
      account_email: prior.account_email,
      remark: "new-remark",
    }),
  );
  const snapshot = structuredClone({ prior, incoming: parsed.accounts[0] });
  assert.deepEqual(
    vaultImport.mergeVaultImport(
      prior,
      parsed.accounts[0],
      parsed.provided_fields?.[0],
    ),
    { ...prior, remark: "new-remark" },
  );
  assert.deepEqual(
    vaultImport.mergeVaultImport(
      prior,
      parsed.accounts[0],
      parsed.provided_fields?.[0],
      "replace",
    ),
    parsed.accounts[0],
  );
  assert.deepEqual({ prior, incoming: parsed.accounts[0] }, snapshot);
});

test("vault merge honors explicit empty strings and false flags across TEXT, CSV and JSON", () => {
  assert.equal(typeof vaultImport.mergeVaultImport, "function");
  const prior = validateVaultAccount({
    platform_name: "Platform",
    account_email: "demo@example.test",
    password: "secret",
    username: "user",
    totp_secret: "totp",
    remark: "remark",
    category: "category",
    is_pinned: 1,
    mailbox_address: "delivery@example.test",
    registered_at: "2020-01-01T00:00:00Z",
  });
  for (const raw of [
    "Platform----demo@example.test----",
    "platform_name,account_email,password\nPlatform,demo@example.test,",
    JSON.stringify({
      platform_name: "Platform",
      account_email: "demo@example.test",
      password: "",
    }),
  ]) {
    const parsed = parseVaultImport(raw);
    assert.equal(parsed.error_count, 0);
    assert.deepEqual(
      vaultImport.mergeVaultImport(
        prior,
        parsed.accounts[0],
        parsed.provided_fields?.[0],
      ),
      { ...prior, password: "" },
    );
  }
  const cleared = parseVaultImport(
    JSON.stringify({
      platform_name: "Platform",
      account_email: "demo@example.test",
      password: "",
      username: "",
      totp_secret: "",
      remark: "",
      category: "",
      is_pinned: false,
      mailbox_address: "",
      registered_at: "",
    }),
  );
  assert.equal(cleared.error_count, 0);
  const result = vaultImport.mergeVaultImport(
    prior,
    cleared.accounts[0],
    cleared.provided_fields?.[0],
  );
  for (const field of [
    "password",
    "username",
    "totp_secret",
    "remark",
    "category",
    "mailbox_address",
    "registered_at",
  ] as const)
    assert.equal(result[field], "", field);
  assert.equal(result.is_pinned, 0);
});

test("vault preview never treats JSON fields as internal parser errors or trusts supplied field metadata", () => {
  const secret = "private-password-and-totp";
  const parsed = parseVaultImport(
    JSON.stringify([
      {
        platform_name: "Platform",
        account_email: "demo@example.test",
        password: secret,
        totp_secret: secret,
        __error: secret,
        provided_fields: ["category"],
      },
      {
        platform_name: "Other",
        account_email: "other@example.test",
        password: secret,
        totp_secret: secret,
        login_methods: JSON.stringify([secret]),
      },
    ]),
  );
  assert.equal(parsed.valid_count, 1);
  assert.equal(parsed.error_count, 1);
  assert.deepEqual(parsed.provided_fields, [
    ["platform_name", "account_email", "password", "totp_secret"],
  ]);
  assert.deepEqual(parsed.rows[1].provided_fields, [
    "platform_name",
    "account_email",
    "password",
    "totp_secret",
    "login_methods",
  ]);
  const { accounts, ...preview } = parsed;
  assert.equal(JSON.stringify(preview).includes(secret), false);
  const incomplete = parseVaultImport(
    `platform_name,account_email,password\nPlatform,demo@example.test\nOther,other@example.test,${secret},extra`,
  );
  assert.equal(incomplete.error_count, 2);
  assert.equal(JSON.stringify(incomplete).includes(secret), false);
  assert.deepEqual(incomplete.rows[0].provided_fields, [
    "platform_name",
    "account_email",
  ]);
  assert.deepEqual(incomplete.rows[1].provided_fields, [
    "platform_name",
    "account_email",
    "password",
  ]);
});

test("preview masks secrets; invalid imports are atomic; duplicates skip or update explicitly", async () => {
  const f = await database();
  try {
    const raw =
      "Platform----demo@example.test----very-sensitive-password----demo\ninvalid----broken";
    const preview = await f.request("/api/vault/import-preview", {
      raw_text: raw,
    });
    assert.equal(preview.data.valid_count, 1);
    assert.equal(preview.data.error_count, 1);
    assert.equal(
      JSON.stringify(preview.data).includes("very-sensitive-password"),
      false,
    );
    assert.equal(
      (await f.request("/api/vault/import", { raw_text: raw })).response.status,
      400,
    );
    assert.equal((await f.request("/api/vault")).data.total, 0);
    const good = raw.split("\n")[0];
    assert.equal(
      (await f.request("/api/vault/import", { raw_text: good })).data.created,
      1,
    );
    assert.equal(
      (await f.request("/api/vault/import", { raw_text: good })).data.skipped,
      1,
    );
    assert.equal(
      (
        await f.request("/api/vault/import", {
          raw_text: good.replace("very-sensitive-password", "changed"),
          duplicate_mode: "update",
        })
      ).data.updated,
      1,
    );
    const list = await f.request("/api/vault");
    assert.equal(
      (await f.request(`/api/vault/${list.data.data[0].id}`)).data.data
        .password,
      "changed",
    );
    assert.equal(
      (await f.request("/api/platforms")).data.data[0].account_count,
      1,
    );
    assert.equal(
      (await f.request("/api/vault/export?platform=Other")).data.accounts
        .length,
      0,
    );
    assert.equal(
      (await f.request(`/api/vault/export?ids=${list.data.data[0].id}`)).data
        .accounts.length,
      1,
    );
    assert.equal(
      (await f.request("/api/vault/export?ids=999999")).response.status,
      409,
    );
  } finally {
    await f.dispose();
  }
});

test("import preview and writes share extended identities and preserve omitted credentials by default", async () => {
  const f = await database();
  try {
    const base = {
      platform_name: "Shared Platform",
      account_email: "shared@example.test",
      email_source: "external",
      workspace: "personal",
      account_identifier: "member-1",
      login_methods: '["password"]',
      password: "keep-private-password",
      totp_secret: "KEEPPRIVATE2FA",
      remark: "old remark",
      is_pinned: 1,
      verification_sender: "auth@platform.test",
      mailbox_address: "delivery@example.test",
    };
    const create = await f.request("/api/vault/import", { accounts: [base] });
    assert.equal(create.response.status, 200, JSON.stringify(create.data));
    const id = (await f.request("/api/vault")).data.data[0].id;
    const patch = {
      platform_name: "SHARED PLATFORM",
      account_email: base.account_email,
      email_source: "external",
      workspace: "personal",
      account_identifier: "member-1",
      login_methods: '["password"]',
      remark: "new remark",
    };
    const raw_text = JSON.stringify([patch]);
    const preview = await f.request("/api/vault/import-preview", {
      raw_text,
      duplicate_mode: "update",
    });
    assert.equal(preview.data.rows[0].action, "update");
    assert.equal(preview.data.rows[0].existing_id, id);
    assert.ok(preview.data.rows[0].changed_fields.includes("remark"));
    assert.ok(!preview.data.rows[0].changed_fields.includes("password"));
    assert.ok(!JSON.stringify(preview.data).includes(base.password));
    const merged = await f.request("/api/vault/import", {
      raw_text,
      duplicate_mode: "update",
    });
    assert.equal(merged.data.updated, 1, JSON.stringify(merged.data));
    const detail = (await f.request(`/api/vault/${id}`)).data.data;
    for (const key of [
      "password",
      "totp_secret",
      "mailbox_address",
      "verification_sender",
      "is_pinned",
    ] as const)
      assert.equal(detail[key], base[key], key);
    assert.equal(detail.remark, "new remark");

    const variants = [
      { ...patch, email_source: "outlook" },
      { ...patch, workspace: "team" },
      { ...patch, account_identifier: "member-2" },
      { ...patch, login_methods: '["microsoft"]' },
    ];
    const distinct = await f.request("/api/vault/import", {
      accounts: variants,
    });
    assert.equal(distinct.data.created, 4, JSON.stringify(distinct.data));
    assert.equal((await f.request("/api/vault")).data.total, 5);

    const replacement = await f.request("/api/vault/import-preview", {
      raw_text,
      duplicate_mode: "update",
      update_mode: "replace",
    });
    assert.ok(replacement.data.rows[0].changed_fields.includes("password"));
    const replaced = await f.request("/api/vault/import", {
      raw_text,
      duplicate_mode: "update",
      update_mode: "replace",
    });
    assert.equal(replaced.data.updated, 1, JSON.stringify(replaced.data));
    const after = (await f.request(`/api/vault/${id}`)).data.data;
    for (const field of [
      "password",
      "totp_secret",
      "mailbox_address",
      "verification_sender",
    ])
      assert.equal(after[field], "", field);
    assert.equal(after.is_pinned, 0);
    assert.equal(
      (
        await f.request("/api/vault/import", {
          raw_text,
          update_mode: "unsafe",
        })
      ).response.status,
      400,
    );
  } finally {
    await f.dispose();
  }
});

test("direct import patches keep omitted secrets, clear explicitly supplied fields, and never conflate duplicated legacy records", async () => {
  const f = await database();
  try {
    const base = {
      platform_name: "Patch",
      account_email: "patch@example.test",
      email_source: "cf_domain",
      password: "keep-secret",
      totp_secret: "keep-totp",
      remark: "old",
    };
    const created = await f.request("/api/vault", base);
    const id = created.data.data.id;
    const result = await f.request("/api/vault/import", {
      accounts: [
        {
          platform_name: base.platform_name,
          account_email: base.account_email,
          remark: "patched",
        },
      ],
      duplicate_mode: "update",
    });
    assert.equal(result.data.updated, 1, JSON.stringify(result.data));
    assert.equal(
      (await f.request(`/api/vault/${id}`)).data.data.password,
      base.password,
    );
    assert.equal(
      (
        await f.request("/api/vault/import", {
          accounts: [{ ...base, password: "", totp_secret: "" }],
          duplicate_mode: "update",
        })
      ).data.updated,
      1,
    );
    assert.equal((await f.request(`/api/vault/${id}`)).data.data.password, "");
    await f.request("/api/vault", base);
    const ambiguous = await f.request("/api/vault/import", {
      accounts: [base],
      duplicate_mode: "update",
    });
    assert.equal(ambiguous.response.status, 409);
    assert.match(ambiguous.data.message, /多个|重复|不唯一/);
  } finally {
    await f.dispose();
  }
});

test("Outlook fixed text and CSV exports reimport without changing complex password or remark", () => {
  const account = {
    ...ACCOUNT,
    password: ' "pass----word" ',
    remark: "first\nsecond",
  };
  for (const format of ["text", "csv"] as const) {
    const parsed = parseImport(
      serializeAccountText([account], "outlook", {
        format,
        includeRemark: true,
      }),
    );
    assert.equal(parsed.error_count, 0);
    assert.deepEqual(parsed.accounts[0], account);
  }
});

test("Outlook export supports all, filters and selected IDs with strict missing-ID checks", async () => {
  const f = await database();
  try {
    await f.request("/api/outlook/batch-import", {
      accounts: [
        ACCOUNT,
        { ...ACCOUNT, email: "second@outlook.com", remark: "another" },
      ],
      sync_to_vault: false,
    });
    assert.equal(
      (await f.request("/api/outlook/accounts/export")).data.accounts.length,
      2,
    );
    assert.equal(
      (await f.request("/api/outlook/accounts/export?q=second")).data.accounts
        .length,
      1,
    );
    assert.equal(
      (await f.request("/api/outlook/accounts/export?ids=99999")).response
        .status,
      409,
    );
  } finally {
    await f.dispose();
  }
});

test("vault import preserves trailing password spaces and rejects duplicate or incomplete headers", () => {
  assert.equal(
    parseVaultImport("Platform----demo@example.test---- password  ").accounts[0]
      .password,
    " password  ",
  );
  assert.throws(
    () =>
      parseVaultImport(
        "platform_name,account_email,password,password\nPlatform,demo@example.test,one,two",
      ),
    /重复/,
  );
  assert.equal(
    parseVaultImport(
      "platform_name,account_email,password\nPlatform,demo@example.test",
    ).error_count,
    1,
  );
});

test("200-account batches respect D1 limits and concurrent imports never duplicate case-insensitive identities", async () => {
  const f = await database();
  try {
    f.env.STORAGE_ENCRYPTION_KEY =
      "fictional-encryption-key-for-transfer-testing";
    const raw = Array.from(
      { length: 200 },
      (_, i) => `Bulk----bulk${i}@example.test---- password${i} `,
    ).join("\n");
    const imported = await f.request("/api/vault/import", { raw_text: raw });
    assert.equal(imported.response.status, 200, JSON.stringify(imported.data));
    assert.equal(imported.data.created, 200);
    assert.equal(
      (await f.request("/api/platforms")).data.data[0].account_count,
      200,
    );
    const responses = await Promise.all(
      ["Concurrent", "CONCURRENT"].map((platform) =>
        f.request("/api/vault/import", {
          raw_text: `${platform}----race@example.test----secret`,
        }),
      ),
    );
    assert.ok(responses.every((r) => [200, 409].includes(r.response.status)));
    assert.equal(
      responses.reduce((n, r) => n + (r.data.created || 0), 0),
      1,
    );
    assert.equal(
      (await f.request("/api/vault?platform=Concurrent")).data.total,
      1,
    );
    assert.equal(
      (
        await f.request("/api/vault/import", {
          raw_text: "concurrent----race@example.test----changed",
        })
      ).data.skipped,
      1,
    );
    const first = (await f.request("/api/vault?platform=Bulk")).data.data[0];
    const stored = await f.DB.prepare(
      "SELECT password FROM platform_vault WHERE id=?",
    )
      .bind(first.id)
      .first<{ password: string }>();
    assert.ok(stored?.password.startsWith("enc:v1:"));
    assert.match(
      (await f.request(`/api/vault/${first.id}`)).data.data.password,
      /^ password\d+ $/,
    );
  } finally {
    await f.dispose();
  }
});
