import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function login(page: Page) {
  const response = await page.request.post("/api/auth/login", {
    data: { password: "local-mailhub-password" },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto("/#vault");
  await expect(
    page.getByRole("heading", { name: "平台账号", exact: true }),
  ).toBeVisible();
}
async function withinViewport(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth + 1,
  );
  expect(overflow, "page must not overflow horizontally").toBe(false);
  for (const dialog of await page.getByRole("dialog").all()) {
    if (!(await dialog.isVisible())) continue;
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.y).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(
      page.viewportSize()!.width + 1,
    );
    expect(box!.y + box!.height).toBeLessThanOrEqual(
      page.viewportSize()!.height + 1,
    );
  }
}
test("login, navigation, empty search, mobile and dark settings", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("密码", { exact: true }).fill("local-mailhub-password");
  await page.getByRole("button", { name: "进入工作区" }).click();
  await expect(
    page.getByRole("heading", { name: "平台账号", exact: true }),
  ).toBeVisible();
  const search = page.getByRole("searchbox").first();
  await expect(search).toHaveValue("");
  await page.waitForTimeout(400);
  await expect(search).toHaveValue("");
  for (const [hash, heading] of [
    ["outlook", "Outlook 工作区"],
    ["mailboxes", "临时邮箱"],
    ["inbox", "域名收件箱"],
    ["rules", "收件规则"],
    ["domains", "域名管理"],
    ["storage", "数据源"],
    ["api", "开发者中心"],
    ["settings", "设置"],
  ]) {
    await page.goto(`/#${hash}`);
    await expect(
      page.getByRole("heading", { name: heading, exact: true }).first(),
    ).toBeVisible();
    await withinViewport(page);
  }
  for (const label of [
    "凭据与密钥",
    "事件通知",
    "操作记录",
    "备份恢复",
    "工作区",
  ]) {
    await page.getByRole("tab", { name: label, exact: true }).click();
    await expect(page.getByText("正在加载", { exact: true })).toHaveCount(0);
    await withinViewport(page);
  }
  await page.getByRole("button", { name: "切换深色主题" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.setViewportSize({ width: 375, height: 812 });
  await withinViewport(page);
  await page.screenshot({
    path: info.outputPath("mobile-settings-dark.png"),
    fullPage: true,
  });
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  expect(errors).toEqual([]);
});

test("platform bulk changes persist, errors preserve selection, TOTP and password editor work", async ({
  page,
}) => {
  await login(page);
  for (let i = 1; i <= 2; i++) {
    const created = await page.request.post("/api/vault", {
      data: {
        platform_name: "E2E Platform",
        account_email: `e2e-${i}@example.test`,
        email_source: "cf_domain",
        username: `e2e-${i}`,
        password: "fictional-only",
        totp_secret: "JBSWY3DPEHPK3PXP",
        category: "QA",
      },
    });
    expect(created.ok()).toBeTruthy();
  }
  await page.reload();
  await page.getByRole("searchbox").first().fill("E2E Platform");
  await page
    .getByRole("button", { name: "查看 E2E Platform 的账号", exact: true })
    .click();
  const drawer = page.getByRole("dialog");
  await expect(
    drawer.getByRole("heading", { name: "E2E Platform · 账号管理" }),
  ).toBeVisible();
  await drawer.getByRole("combobox", { name: "账号展示方式" }).click();
  await page.getByRole("option", { name: "紧凑表格" }).click();
  await drawer.getByRole("checkbox", { name: /选择本页/ }).check();
  await drawer.getByRole("button", { name: "批量整理 2 个账号" }).click();
  await page.getByRole("menuitem", { name: "设置分类" }).click();
  const edit = page.getByRole("dialog").last();
  await edit.getByRole("textbox").first().fill("E2E verified");
  await page.route(
    "**/api/vault/batch",
    (route) =>
      route.fulfill({
        status: 503,
        json: { success: false, message: "测试暂时失败" },
      }),
    { times: 1 },
  );
  await edit.getByRole("button", { name: "应用到 2 个账号" }).click();
  await expect(edit.getByText("测试暂时失败")).toBeVisible();
  await expect(edit.getByRole("textbox").first()).toHaveValue("E2E verified");
  await edit.getByRole("button", { name: "应用到 2 个账号" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  const stored = await (
    await page.request.get("/api/vault?platform=E2E%20Platform")
  ).json();
  expect(
    stored.data
      .filter(
        (row: { platform_name: string }) =>
          row.platform_name === "E2E Platform",
      )
      .every((row: { category: string }) => row.category === "E2E verified"),
  ).toBe(true);
  const codeTrigger = page
    .getByRole("button", { name: /查看.*动态口令/ })
    .first();
  await codeTrigger.click();
  await expect(page.getByLabel("当前动态口令")).toHaveText(/\d{3}\s?\d{3}/);
  await withinViewport(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(codeTrigger).toBeFocused();
});

test("Outlook composer retains failed drafts and submits only after explicit send", async ({
  page,
}, info) => {
  let sends = 0;
  const sendKeys: string[] = [];
  await page.route("**/api/outlook/accounts/*/emails?**", (route) =>
    route.fulfill({ json: { success: true, data: [], next_cursor: "" } }),
  );
  await page.route("**/api/outlook/accounts/*/send", async (route) => {
    sends++;
    const key = route.request().headers()["idempotency-key"];
    expect(key).toBeTruthy();
    sendKeys.push(key);
    await route.fulfill(
      sends === 1
        ? {
            status: 403,
            json: {
              success: false,
              error: "PERMISSION_REQUIRED",
              message: "需要发信权限",
              required_scopes: ["Mail.Send"],
            },
          }
        : { status: 202, json: { success: true, data: { accepted: true } } },
    );
  });
  await login(page);
  await page.goto("/#outlook");
  const row = page
    .getByRole("row")
    .filter({ hasText: "workspace@outlook.com" });
  await row.getByRole("button", { name: "收件", exact: true }).click();
  await page.getByRole("button", { name: "写邮件", exact: true }).click();
  expect(sends).toBe(0);
  const compose = page.getByRole("dialog").last();
  await compose
    .getByLabel("收件人", { exact: true })
    .fill("fake-recipient@example.test");
  await compose
    .getByLabel("主题", { exact: true })
    .fill("E2E fictional message");
  await compose
    .getByLabel("正文", { exact: true })
    .fill("This request is intercepted in the test browser.");
  await page.setViewportSize({ width: 375, height: 812 });
  await withinViewport(page);
  await page.screenshot({ path: info.outputPath("mobile-compose.png") });
  await compose.getByRole("button", { name: "发送邮件", exact: true }).click();
  await expect(
    compose.getByText("需要发信权限", { exact: true }),
  ).toBeVisible();
  await expect(compose.getByLabel("正文", { exact: true })).toHaveValue(
    "This request is intercepted in the test browser.",
  );
  expect(sends).toBe(1);
  await compose.getByRole("button", { name: "发送邮件", exact: true }).click();
  await expect(
    page.getByRole("alertdialog", { name: "发起新的发送请求？" }),
  ).toBeVisible();
  expect(sends).toBe(1);
  await page.getByRole("button", { name: "确认新发送", exact: true }).click();
  await expect(
    compose.getByText("微软已接受发送请求", { exact: true }),
  ).toBeVisible();
  expect(sends).toBe(2);
  expect(sendKeys[1]).not.toBe(sendKeys[0]);
  await compose.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
});

test("scoped API key creation and revocation, webhook form and backup validation", async ({
  page,
}, info) => {
  await login(page);
  await page.goto("/#settings");
  await page.getByRole("tab", { name: "凭据与密钥" }).click();
  const newKey = page.getByRole("button", { name: "新建密钥", exact: true });
  await newKey.click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(newKey).toBeFocused();
  await newKey.click();
  await page.getByLabel("用途名称").fill("E2E key");
  await page.getByLabel("仅允许这些邮箱（可选）").fill("reading@example.test");
  await page.getByRole("button", { name: "创建密钥", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "自动化密钥已创建" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "已保存，关闭" }).click();
  await expect(newKey).toBeFocused();
  const row = page.getByRole("row").filter({ hasText: "E2E key" });
  await expect(row).toContainText("reading@example.test");
  await row.getByRole("button", { name: "撤销" }).click();
  await page.getByRole("button", { name: "确认操作" }).click();
  await expect(row).toContainText("已撤销");
  await page.getByRole("tab", { name: "事件通知" }).click();
  await page.getByRole("button", { name: "添加订阅" }).click();
  await page.getByLabel("订阅名称").fill("E2E no delivery");
  await page.getByLabel("接收地址").fill("https://127.0.0.1/");
  await page.getByRole("button", { name: "创建订阅" }).click();
  await expect(page.getByText(/通知地址必须是公网 HTTPS/)).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await withinViewport(page);
  await page.screenshot({ path: info.outputPath("mobile-webhook-error.png") });
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "添加订阅", exact: true }),
  ).toBeFocused();
  await page.getByRole("tab", { name: "备份恢复" }).click();
  await page.getByLabel("备份文件", { exact: true }).setInputFiles({
    name: "invalid-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"invalid":true}'),
  });
  await page.getByRole("button", { name: "检查并预览" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "操作未完成" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认恢复", exact: true }),
  ).toHaveCount(0);
  await withinViewport(page);
  await page.getByRole("tab", { name: "工作区", exact: true }).click();
  // Exercise the real local key endpoint while denying clipboard access. The
  // value is never logged or added to an assertion/screenshot.
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () =>
          Promise.reject(
            new DOMException("Clipboard denied", "NotAllowedError"),
          ),
      },
    }),
  );
  const copyKey = page.getByRole("button", { name: "复制密钥", exact: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    await copyKey.click();
    await expect(
      page.getByRole("dialog", { name: "手动复制主 API 密钥" }),
    ).toBeVisible();
    // No timing delay or second Escape: the dialog must dismiss as soon as it
    // is visible, without an automatically opened tooltip intercepting it.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(copyKey).toBeFocused();
  }
});
