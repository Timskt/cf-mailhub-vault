import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generateTotp,
  normalizeTotp,
  parseTotp,
  totpWindow,
} from "../web/lib/totp";
import {
  generatePassword,
  passwordGroups,
} from "../web/lib/password-generator";

// RFC 6238 Appendix B uses different key lengths for each hash algorithm.
const secrets = {
  "SHA-1": "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  "SHA-256": "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA",
  "SHA-512":
    "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA",
} as const;
const vectors = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
] as const;

for (const [index, algorithm] of Object.keys(secrets).entries()) {
  test(`TOTP matches all RFC 6238 ${algorithm} vectors including timestamps after 2038`, async () => {
    const config = parseTotp(
      `otpauth://totp/Test?secret=${secrets[algorithm as keyof typeof secrets]}&algorithm=${algorithm.replace("-", "")}&digits=8`,
    );
    for (const row of vectors) {
      assert.equal(await generateTotp(config, row[0] * 1000), row[index + 1]);
    }
  });
}

test("TOTP defaults to six digits, preserves leading zeroes and respects custom periods", async () => {
  const config = parseTotp(secrets["SHA-1"]);
  assert.equal(await generateTotp(config, 1111111109000), "081804");
  assert.equal(
    await generateTotp({ ...config, period: 60, digits: 8 }, 119999),
    "94287082",
  );
  assert.notEqual(
    await generateTotp(config, 59999),
    await generateTotp(config, 60000),
  );
  assert.deepEqual(totpWindow(30, 59999), {
    counter: 1,
    expiresAt: 60000,
    remainingSeconds: 1,
  });
  assert.deepEqual(totpWindow(30, 60000), {
    counter: 2,
    expiresAt: 90000,
    remainingSeconds: 30,
  });
});

test("otpauth parsing retains algorithm, digits, period, issuer and escaped account label", () => {
  const uri = `otpauth://totp/Example%3Aalice%40example.test?secret=${secrets["SHA-256"]}&issuer=Example&algorithm=sha256&digits=8&period=60`;
  const parsed = parseTotp(uri);
  assert.deepEqual(parsed, {
    secret: secrets["SHA-256"],
    algorithm: "SHA-256",
    digits: 8,
    period: 60,
    label: "Example:alice@example.test",
    issuer: "Example",
  });
  assert.deepEqual(parseTotp(normalizeTotp(uri)), parsed);
  assert.equal(normalizeTotp("jbsw y3dp ehpk 3pxp"), "JBSWY3DPEHPK3PXP");
  assert.equal(
    parseTotp(`${secrets["SHA-256"]}====`).secret,
    secrets["SHA-256"],
  );
});

test("TOTP rejects malformed Base32 and ambiguous or unsupported otpauth parameters without echoing secrets", () => {
  const base = `otpauth://totp/Test?secret=${secrets["SHA-1"]}`;
  for (const input of [
    "",
    "123456",
    "A",
    "MZ",
    "JBSWY3DPEHPK3PXP=",
    "JBSWY3DP!EHPK3PXP",
    "A".repeat(1001),
    `otpauth://hotp/Test?secret=${secrets["SHA-1"]}&counter=1`,
    "https://example.test/totp?secret=PRIVATE",
    "otpauth://totp/Test",
    "otpauth://totp/%ZZ?secret=PRIVATE",
    `${base}&secret=${secrets["SHA-256"]}`,
    `${base}&algorithm=MD5`,
    `${base}&algorithm=`,
    `${base}&digits=7`,
    `${base}&digits=6.0`,
    `${base}&period=0`,
    `${base}&period=-30`,
    `${base}&period=1.5`,
    `${base}&period=301`,
    `${base}&period=30&period=60`,
    `${base}&counter=1`,
    `${base}#fragment`,
    `otpauth://user@totp/Test?secret=${secrets["SHA-1"]}`,
  ]) {
    assert.throws(
      () => parseTotp(input),
      (error: Error) => !error.message.includes("PRIVATE"),
    );
  }
});

test("TOTP validates direct generation configuration, time and period", async () => {
  const config = parseTotp(secrets["SHA-1"]);
  for (const time of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(generateTotp(config, time));
  }
  for (const period of [0, -1, 301, NaN, 1.5])
    assert.throws(() => totpWindow(period));
  await assert.rejects(generateTotp({ ...config, digits: 7 as 6 }));
  await assert.rejects(
    generateTotp({ ...config, algorithm: "MD5" as "SHA-1" }),
  );
  assert.equal((await generateTotp({ ...config, period: 1 }, 0)).length, 6);
});

test("password generator honors length and each enabled group without unwanted characters", () => {
  for (const length of [8, 20, 128]) {
    for (let i = 0; i < 40; i++) {
      const password = generatePassword({ length });
      assert.equal(password.length, length);
      for (const group of Object.values(passwordGroups))
        assert.ok([...password].some((c) => group.includes(c)));
      assert.ok(
        [...password].every((c) =>
          Object.values(passwordGroups).join("").includes(c),
        ),
      );
    }
  }
  assert.match(
    generatePassword({
      lowercase: false,
      uppercase: false,
      symbols: false,
      length: 128,
    }),
    /^\d{128}$/,
  );
  const noAmbiguous = generatePassword({ excludeAmbiguous: true, length: 128 });
  assert.doesNotMatch(noAmbiguous, /[Il1O0o|]/);
});

test("password generator rejects invalid options and unavailable secure randomness", (t) => {
  for (const length of [0, 7, 129, 9.5, NaN, Infinity])
    assert.throws(() => generatePassword({ length }));
  assert.throws(() =>
    generatePassword({
      lowercase: false,
      uppercase: false,
      digits: false,
      symbols: false,
    }),
  );
  assert.throws(() =>
    generatePassword({ digits: "yes" as unknown as boolean }),
  );
  const random = t.mock.method(globalThis.crypto, "getRandomValues", () => {
    throw new Error("unavailable");
  });
  assert.throws(() => generatePassword(), /安全随机/);
  random.mock.restore();
});

test("password generator rejects biased byte tail instead of mapping it to digits", (t) => {
  let i = 0;
  const bytes = [250, 251, 252, 253, 254, 255, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  t.mock.method(globalThis.crypto, "getRandomValues", (array: Uint8Array) => {
    for (let j = 0; j < array.length; j++) array[j] = bytes[i++ % bytes.length];
    return array;
  });
  assert.equal(
    generatePassword({
      length: 8,
      lowercase: false,
      uppercase: false,
      symbols: false,
    }),
    "01234567",
  );
});
