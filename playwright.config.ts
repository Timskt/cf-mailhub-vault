import { defineConfig, devices } from "@playwright/test";

const e2ePort = process.env.MAILHUB_E2E_PORT || "8789";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 12000 },
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  outputDir: "output/e2e-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "output/e2e-report", open: "never" }],
  ],
  use: {
    ...devices["Desktop Chrome"],
    channel: process.env.PLAYWRIGHT_CHANNEL,
    baseURL: `http://127.0.0.1:${e2ePort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/start-e2e.mjs",
    url: `http://127.0.0.1:${e2ePort}/healthz`,
    reuseExistingServer: false,
    timeout: 120000,
  },
});
