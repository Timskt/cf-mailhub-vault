import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVerificationInfo as extract } from "../src/code-extractor";

test("recognizes contextual numeric/alphanumeric codes, including year-shaped PINs", () => {
  for (const [text, expected] of [
    ["您的验证码：2026，请勿分享", "2026"],
    ["Your verification code is 135790", "135790"],
    ["Use code: AB12CD", "AB12CD"],
    ["Security code: 123 456", "123456"],
    ["One-time password: 012345", "012345"],
    ["654321 is your verification code", "654321"],
    ["验证码为 ９８７６５４", "987654"],
    ["Login code: ABCD-EFGH", "ABCDEFGH"],
  ])
    assert.equal(extract(text).code, expected, text);
  assert.equal(
    extract("Microsoft account security code", "", "<strong>734692</strong>")
      .code,
    "734692",
  );
  assert.equal(
    extract("验证码 111111", "Previous code: 222222").code,
    "111111",
  );
  assert.equal(
    extract(
      "",
      "",
      "<style>.code{color:#123456}</style><p>Verification code:</p><b>&#50;46810</b>",
    ).code,
    "246810",
  );
});
test("does not interpret order IDs, copyright years, URL tokens or long identifiers as OTPs", () => {
  for (const text of [
    "Your order 123456 has shipped",
    "© 2026 [NEWS]",
    "Invoice\n123456\nTotal: 20",
    "Verification code: 12345678901",
    "Your code is available in the app",
    "Verify your email https://example.test/verify?code=123456",
    "Your verification code has expired. Order 123456",
  ])
    assert.equal(extract(text).code, "", text);
});
test("detects verification buttons through labels and decodes signed query strings", () => {
  assert.equal(
    extract(
      "",
      "",
      '<a href="https://example.test/t/opaque?a=1&amp;b=2"><b>Verify your email</b></a>',
    ).link,
    "https://example.test/t/opaque?a=1&b=2",
  );
  assert.equal(
    extract("", "Open https://example.test/confirm?token=abc.").link,
    "https://example.test/confirm?token=abc",
  );
  assert.equal(
    extract(
      "",
      "",
      '<a href="https://example.test/privacy?verify=yes">Privacy</a><a href="https://example.test/action?k=x">确认邮箱</a>',
    ).link,
    "https://example.test/action?k=x",
  );
  assert.equal(
    extract("", "", '<a href="https://example.test/link">Sign in</a>').link,
    "https://example.test/link",
  );
});
test("ignores unsafe schemes, userinfo, unrelated hosts and documentation links", () => {
  for (const link of [
    "javascript:alert(1)",
    "data:text/html,x",
    "https://user:pass@example.test/verify",
    "https://example.test/help/verification",
  ])
    assert.equal(
      extract("", "", `<a href="${link}">Verify email</a>`).link,
      "",
    );
  assert.equal(extract("", "https://verify.example.test/news").link, "");
});
