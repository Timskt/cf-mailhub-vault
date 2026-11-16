import assert from "node:assert/strict";
import test from "node:test";
import { serializeAccountText } from "../shared/account-text";
import { parseVaultImport } from "../src/vault-import";
import { parseImport } from "../src/outlook-import";
import { ACCOUNT, database } from "./helpers";

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
    assert.deepEqual(parsed.accounts[0], { ...account, is_pinned: 0 });
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
