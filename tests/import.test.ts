import { test } from "node:test";
import assert from "node:assert/strict";
import { parseImport, importPreview } from "../src/outlook-import";
import { ACCOUNT, APP_ID, TOKEN } from "./helpers";

test("standard import preserves empty password, UUID position and token-like passwords", () => {
  const parsed = parseImport(
    `empty@outlook.com--------${APP_ID}----${TOKEN}\n${ACCOUNT.email}----${ACCOUNT.password}----${APP_ID}----${TOKEN}----用途`,
  );
  assert.equal(parsed.error_count, 0);
  assert.equal(parsed.accounts[0].password, "");
  assert.equal(parsed.accounts[1].password, ACCOUNT.password);
  assert.equal(parsed.accounts[1].refresh_token, TOKEN);
  const reversedApp = parseImport(
    `${ACCOUNT.email}----password----${TOKEN}----${APP_ID}`,
  );
  assert.equal(reversedApp.accounts[0].client_id, APP_ID);
  assert.equal(reversedApp.accounts[0].refresh_token, TOKEN);
  const uuidPassword = parseImport(
    `${ACCOUNT.email}----aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee----${APP_ID}----${TOKEN}`,
  );
  assert.equal(
    uuidPassword.accounts[0].password,
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  );
  assert.equal(uuidPassword.accounts[0].client_id, APP_ID);
});
test("CSV and tab headers after BOM/comments keep quotes, blank fields and delimiter", () => {
  const tab = parseImport(
    `\uFEFF# export\nemail\tpassword\tclient_id\trefresh_token\tremark\n${ACCOUNT.email}\t\t${APP_ID}\t${TOKEN}\t研发`,
  );
  assert.equal(tab.accounts[0].password, "");
  assert.equal(tab.accounts[0].remark, "研发");
  const csv = parseImport(
    `email,password,clientId,refreshToken,remark\n${ACCOUNT.email},"p,""x",${APP_ID},${TOKEN},"hello, world"`,
  );
  assert.equal(csv.accounts[0].password, 'p,"x');
  assert.equal(csv.accounts[0].remark, "hello, world");
});
test("four-column exports accept the Chinese format caption and preserve token punctuation", () => {
  const token =
    "M.C525_BAY.0.U.MsaArtifacts.FICTIONAL!not*a-real-token_0123456789";
  const record = `DemoMailbox42@outlook.com----TestOnly42!----${APP_ID}----${token}`;
  for (const header of [
    "导出内容（格式：邮箱----密码----client_id----refresh_token）",
    "邮箱----密码----client_id----refresh_token",
    "email----password----client_id----refresh_token",
  ]) {
    const parsed = parseImport(`${header}\n${record}`);
    assert.equal(parsed.valid_count, 1);
    assert.equal(parsed.error_count, 0);
    assert.equal(parsed.rows[0].line, 2);
    assert.equal(parsed.accounts[0].email, "demomailbox42@outlook.com");
    assert.equal(parsed.accounts[0].password, "TestOnly42!");
    assert.equal(parsed.accounts[0].refresh_token, token);
    const preview = JSON.stringify(importPreview(parsed));
    assert.equal(preview.includes(token), false);
    assert.equal(preview.includes("TestOnly42!"), false);
  }
});
test("format captions do not conceal invalid rows or count against the account limit", () => {
  const header = "导出内容（格式：邮箱----密码----client_id----refresh_token）";
  const parsed = parseImport(
    `${header}\ninvalid\n${ACCOUNT.email}----password----${APP_ID}----${TOKEN}`,
  );
  assert.equal(parsed.valid_count, 1);
  assert.equal(parsed.error_count, 1);
  assert.equal(parsed.rows[0].line, 2);
  const records = Array.from(
    { length: 200 },
    (_, i) => `caption${i}@outlook.com----password----${APP_ID}----${TOKEN}`,
  );
  assert.equal(
    parseImport(`${header}\n${records.join("\n")}`).valid_count,
    200,
  );
  assert.throws(
    () =>
      parseImport(
        `${header}\n${records.join("\n")}\nextra@outlook.com----password----${APP_ID}----${TOKEN}`,
      ),
    /200/,
  );
});
test("JSON arrays, individual records, JSON lines and own export round-trip", () => {
  for (const content of [
    JSON.stringify([ACCOUNT]),
    JSON.stringify(ACCOUNT),
    JSON.stringify({ version: 1, accounts: [ACCOUNT] }),
    `${JSON.stringify(ACCOUNT)}\n${JSON.stringify({ ...ACCOUNT, email: "second@outlook.com" })}`,
  ]) {
    assert.deepEqual(parseImport(content).accounts[0], ACCOUNT);
  }
});
test("duplicates use last valid value, report original lines, preview omits secrets", () => {
  const parsed = parseImport(
    `# account list\n${JSON.stringify(ACCOUNT)}\ninvalid\n${JSON.stringify({ ...ACCOUNT, remark: "latest" })}`,
  );
  assert.equal(parsed.valid_count, 1);
  assert.equal(parsed.duplicate_count, 1);
  assert.equal(parsed.error_count, 1);
  assert.equal(parsed.rows[1].line, 3);
  assert.equal(parsed.accounts[0].remark, "latest");
  const preview = JSON.stringify(importPreview(parsed));
  assert.equal(preview.includes(TOKEN), false);
  assert.equal(preview.includes(ACCOUNT.password), false);
});
test("truncated tokens, invalid client IDs, oversized batches/content fail clearly", () => {
  assert.equal(
    parseImport(`${ACCOUNT.email}----password----${APP_ID}----M.incomplete...`)
      .valid_count,
    0,
  );
  assert.equal(
    parseImport(JSON.stringify([{ ...ACCOUNT, client_id: "not-a-uuid" }]))
      .error_count,
    1,
  );
  assert.throws(
    () => parseImport(JSON.stringify(Array(201).fill(ACCOUNT))),
    /200/,
  );
  assert.throws(() => parseImport("界".repeat(400000)), /1 MiB/);
});
