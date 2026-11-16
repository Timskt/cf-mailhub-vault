import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("deployment bootstrap validates domains, keeps secrets out of TOML, and refuses to overwrite existing configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "mailhub-bootstrap-test-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // The production bootstrap invokes this local stub, never Cloudflare.
    writeFileSync(
      join(bin, "pnpm"),
      `#!${process.execPath}
if (process.argv.slice(2).join(' ') !== 'exec wrangler d1 list --json') process.exit(90);
console.log(JSON.stringify([{ name: 'mailhub-vault-db', uuid: '11111111-2222-4333-8444-555555555555' }]));
`,
      { mode: 0o700 },
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MAILHUB_INIT_DOMAINS: "Example.com,mail.example.net",
      MAILHUB_INIT_SITE: "vault.example.com",
      MAILHUB_INIT_PASSWORD: "fictional-bootstrap-password",
    };
    const run = (overrides = {}) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          fileURLToPath(
            new URL("../scripts/bootstrap-config.ts", import.meta.url),
          ),
        ],
        { cwd: dir, env: { ...env, ...overrides }, encoding: "utf8" },
      );
    assert.notEqual(
      run({ MAILHUB_INIT_DOMAINS: "https://invalid.test/" }).status,
      0,
    );
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const config = readFileSync(join(dir, "wrangler.toml"), "utf8");
    assert.match(config, /CF_DOMAINS = "example.com,mail.example.net"/);
    assert.ok(config.indexOf("routes =") < config.indexOf("[assets]"));
    assert.equal(config.includes(env.MAILHUB_INIT_PASSWORD), false);
    assert.equal(first.stdout.includes(env.MAILHUB_INIT_PASSWORD), false);
    const secretsPath = join(dir, ".mailhub-bootstrap.json");
    const secrets = JSON.parse(readFileSync(secretsPath, "utf8"));
    assert.equal(secrets.ADMIN_PASSWORD, env.MAILHUB_INIT_PASSWORD);
    assert.equal(secrets.COOKIE_SECRET.length, 64);
    assert.ok(secrets.API_KEY.length >= 40);
    assert.equal(statSync(secretsPath).mode & 0o777, 0o600);
    assert.notEqual(run().status, 0);
    assert.equal(readFileSync(join(dir, "wrangler.toml"), "utf8"), config);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
