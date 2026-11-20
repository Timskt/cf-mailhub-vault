import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const state = await mkdtemp(join(tmpdir(), "mailhub-e2e-"));
const port = process.env.MAILHUB_E2E_PORT || "8789";
const config = [
  "--local",
  "--config",
  "wrangler.local.jsonc",
  "--persist-to",
  state,
];
let child;
const run = (args) =>
  new Promise((resolve, reject) => {
    child = spawn("pnpm", ["exec", "wrangler", ...args], {
      stdio: "inherit",
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Local test service exited (${code})`)),
    );
  });
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child?.kill(signal));
try {
  await run(["d1", "migrations", "apply", "DB", ...config]);
  await run([
    "d1",
    "execute",
    "DB",
    ...config,
    "--file",
    "scripts/seed-local.sql",
  ]);
  await run(["dev", ...config, "--ip", "127.0.0.1", "--port", port]);
} finally {
  await rm(state, { recursive: true, force: true });
}
