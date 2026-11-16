import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Finish intercepted settings refreshes before Playwright disposes API responses.
test.afterEach(async ({ page, context }) => {
  await page.unrouteAll({ behavior: "wait" });
  await context.unrouteAll({ behavior: "wait" });
});

async function login(page: Page) {
  expect(
    (
      await page.request.post("/api/auth/login", {
        data: { password: "local-mailhub-password" },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto("/#outlook");
  await expect(
    page.getByRole("heading", { name: "Outlook 工作区", exact: true }),
  ).toBeVisible();
}
async function fits(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  for (const dialog of await page.getByRole("dialog").all()) {
    if (!(await dialog.isVisible())) continue;
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.y).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(
      page.viewportSize()!.width + 1,
    );
    expect(box.y + box.height).toBeLessThanOrEqual(
      page.viewportSize()!.height + 1,
    );
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
  }
}

test("repair panel, state-bound code extraction, explicit exchange and nested config export work on mobile", async ({
  page,
  context,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  // Browser boundaries use fictional provider pages. Backend exchange is tested separately with real D1 + mocked Microsoft.
  await context.route("https://login.microsoftonline.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>模拟 Microsoft 授权</title><p>本地测试授权窗口</p>",
    }),
  );
  await login(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page
    .getByRole("button", { name: "修复 reconnect@hotmail.com", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "修复 Outlook 授权",
    exact: true,
  });
  await expect(dialog.getByLabel("修复邮箱（不可修改）")).toHaveValue(
    "reconnect@hotmail.com",
  );
  await expect(
    dialog.getByRole("tab", { name: "手动授权", exact: true }),
  ).toHaveAttribute("data-state", "active");
  await expect(
    dialog.getByText("需要重新授权", { exact: true }).first(),
  ).toBeVisible();
  await fits(page);
  const started = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/outlook/oauth/start") &&
      r.request().method() === "POST",
  );
  const opened = page.waitForEvent("popup");
  await dialog
    .getByRole("button", { name: "打开 Microsoft 授权", exact: true })
    .click();
  const popup = await opened;
  const session = await (await started).json();
  expect(session.success).toBe(true);
  await popup.waitForURL("https://login.microsoftonline.com/**");
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  const input = dialog.getByLabel("回调网址或原始授权码", { exact: true });
  await input.fill("https://localhost/?code=test-code&state=another-session");
  await dialog.getByRole("button", { name: "提取授权码", exact: true }).click();
  await expect(dialog.getByText(/回调不属于本次授权/)).toBeVisible();
  await expect(input).toHaveValue(/another-session/);
  await expect(
    dialog.getByRole("button", { name: "兑换并保存授权", exact: true }),
  ).toBeDisabled();
  const code = "M.FAKE_CODE_" + "abcdefghijk1234567890".repeat(35);
  const response = `https://localhost/?${new URLSearchParams({ code, state: session.data.state })}`;
  await input.fill(response);
  await dialog.getByRole("button", { name: "提取授权码", exact: true }).click();
  await expect(dialog.getByLabel("已提取的授权码")).toHaveValue(/•/);
  await dialog.getByRole("button", { name: "显示授权码", exact: true }).click();
  await expect(dialog.getByLabel("已提取的授权码")).toHaveValue(code);
  await dialog.getByRole("button", { name: "复制授权码", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
  await fits(page);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("mobile-authorization-code.png"),
  });
  await popup.close();
  await expect(
    dialog.getByText("授权窗口已关闭或连接已断开", { exact: true }),
  ).toBeVisible();
  let exchanged = 0;
  await page.route("**/api/outlook/oauth/exchange", async (route) => {
    exchanged++;
    expect(route.request().postDataJSON()).toEqual({
      state: session.data.state,
      response,
    });
    const updated = await page.request.put("/api/outlook/accounts/2", {
      data: {
        client_id: session.data.client_id,
        refresh_token: "M.FICTIONAL_BROWSER_REPAIRED_TOKEN_0123456789",
      },
    });
    expect(updated.ok()).toBeTruthy();
    await route.fulfill({
      json: {
        success: true,
        data: {
          id: 2,
          email: "reconnect@hotmail.com",
          status: "active",
          auth_status: "unchecked",
        },
        message: "授权已保存",
      },
    });
  });
  await dialog
    .getByRole("button", { name: "兑换并保存授权", exact: true })
    .click();
  await expect(
    dialog.getByText("授权凭据已保存", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText(/收件权限尚未验证/)).toBeVisible();
  expect(exchanged).toBe(1);
  await expect(dialog.getByLabel("回调网址或原始授权码")).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "查看 / 复制配置", exact: true })
    .click();
  const exporter = page.getByRole("dialog", {
    name: "查看 / 复制 Outlook 配置",
    exact: true,
  });
  await exporter
    .getByRole("button", { name: "生成导出内容", exact: true })
    .click();
  await expect(exporter.getByLabel("导出预览")).toHaveValue(
    /reconnect@hotmail.com----.*FICTIONAL_BROWSER_REPAIRED_TOKEN/,
  );
  await fits(page);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("mobile-repaired-config.png"),
  });
  await exporter.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.route("**/api/outlook/accounts/2/check", (route) =>
    route.fulfill({ json: { success: true } }),
  );
  await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(
    dialog.getByText("本次收件连接检查已通过。", { exact: false }),
  ).toBeVisible();
  for (const size of [
    { width: 812, height: 375 },
    { width: 1440, height: 960 },
  ]) {
    await page.setViewportSize(size);
    await fits(page);
  }
  expect(
    (
      await new AxeBuilder({ page })
        .include('[role="dialog"][data-state="open"]')
        .withTags(["wcag2a", "wcag2aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.route("**/api/outlook/accounts/2/emails?**", (route) =>
    route.fulfill({ json: { success: true, data: [], next_cursor: "" } }),
  );
  await dialog.getByRole("button", { name: "读取邮件", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const reader = page.getByRole("dialog", {
    name: "reconnect@hotmail.com",
    exact: true,
  });
  await expect(reader.getByText("暂无邮件", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(reader).toHaveCount(0);
  expect(context.pages()).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("authorization popup blocking, exchange failure, retry and nested reader recovery remain usable", async ({
  page,
  context,
}, info) => {
  await context.route("https://login.microsoftonline.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>模拟授权</title>",
    }),
  );
  await login(page);
  await page.route("**/api/outlook/accounts/1/emails?**", (route) =>
    route.fulfill({
      status: 502,
      json: { success: false, message: "测试：授权失效，请重新授权" },
    }),
  );
  await page
    .getByRole("button", { name: "workspace@outlook.com", exact: true })
    .first()
    .click();
  const reader = page.getByRole("dialog", {
    name: "workspace@outlook.com",
    exact: true,
  });
  await reader
    .getByRole("button", { name: "检查授权与修复连接", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "修复 Outlook 授权",
    exact: true,
  });
  await page.evaluate(() => {
    (window as any).__originalOpen = window.open;
    window.open = () => null;
  });
  await dialog
    .getByRole("button", { name: "打开 Microsoft 授权", exact: true })
    .click();
  await expect(dialog.getByText(/授权窗口被浏览器拦截/)).toBeVisible();
  await page.evaluate(() => {
    window.open = (window as any).__originalOpen;
  });
  const opened = page.waitForEvent("popup");
  await dialog
    .getByRole("button", { name: "打开 Microsoft 授权", exact: true })
    .click();
  const popup = await opened;
  await popup.waitForURL("https://login.microsoftonline.com/**");
  await expect(dialog.getByLabel("回调网址或原始授权码")).toBeEnabled();
  await dialog.getByLabel("回调网址或原始授权码").fill("M.raw-test-code");
  await dialog.getByRole("button", { name: "提取授权码", exact: true }).click();
  await page.route("**/api/outlook/oauth/exchange", (route) =>
    route.fulfill({
      status: 409,
      json: {
        success: false,
        error: "OAUTH_RESTART_REQUIRED",
        message: "登录的微软邮箱与目标账号不匹配，本次未保存。",
      },
    }),
  );
  await dialog
    .getByRole("button", { name: "兑换并保存授权", exact: true })
    .click();
  await expect(dialog.getByText(/邮箱与目标账号不匹配/)).toBeVisible();
  await expect(dialog.getByLabel("回调网址或原始授权码")).toHaveValue("");
  await expect(
    dialog.getByRole("button", { name: "打开 Microsoft 授权", exact: true }),
  ).toBeEnabled();
  // A disowned manual popup is closed by the user after copying its callback.
  await popup.close();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(dialog.getByText(/邮箱与目标账号不匹配/)).toBeInViewport();
  await fits(page);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("mobile-nested-repair-error-dark.png"),
  });
  expect(
    (
      await new AxeBuilder({ page })
        .include('[role="dialog"][data-state="open"]:last-of-type')
        .withTags(["wcag2a", "wcag2aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(reader).toBeVisible();
  await page.keyboard.press("Escape");
  expect(context.pages()).toHaveLength(1);
});

test("automatic callback accepts only the current popup and state, and closes owned windows", async ({
  page,
  context,
}) => {
  await context.route("https://login.microsoftonline.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>模拟授权</title>",
    }),
  );
  await context.route("**/__e2e_oauth_return", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>模拟回调</title>",
    }),
  );
  await page.route("**/api/settings", async (route) => {
    const original = await route.fetch();
    const data = await original.json();
    data.data.oauth_configured = true;
    await route.fulfill({ json: data });
  });
  await login(page);
  await page.route("**/api/outlook/oauth/start", async (route) => {
    expect(route.request().postDataJSON().mode).toBe("web");
    await route.fulfill({
      json: {
        success: true,
        url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=fake-web-state",
        data: {
          mode: "web",
          state: "fake-web-state",
          client_id: "11111111-2222-4333-8444-555555555555",
          expires_at: Math.floor(Date.now() / 1000) + 600,
          redirect_uri: "http://127.0.0.1:8789/api/outlook/oauth/callback",
        },
      },
    });
  });
  await page
    .getByRole("button", { name: "连接微软账号", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", {
    name: "连接 Outlook 邮箱",
    exact: true,
  });
  await expect(
    dialog.getByRole("tab", { name: "自动回调", exact: true }),
  ).toHaveAttribute("data-state", "active");
  const opened = page.waitForEvent("popup");
  await dialog
    .getByRole("button", { name: "打开 Microsoft 授权", exact: true })
    .click();
  const popup = await opened;
  await popup.waitForURL("https://login.microsoftonline.com/**");
  const payload = {
    type: "mailhub-outlook-oauth",
    success: true,
    state: "fake-web-state",
    account: {
      id: 3,
      email: "pending@outlook.com",
      status: "active",
      auth_status: "unchecked",
    },
  };
  await page.evaluate(
    (message) => window.postMessage(message, location.origin),
    payload,
  );
  await expect(dialog.getByText("授权凭据已保存", { exact: true })).toHaveCount(
    0,
  );
  await popup.evaluate(() => {
    location.href = "http://127.0.0.1:8789/__e2e_oauth_return";
  });
  await popup.waitForURL("http://127.0.0.1:8789/__e2e_oauth_return");
  await popup.evaluate(
    (message) =>
      window.opener.postMessage(
        { ...message, state: "another-state" },
        location.origin,
      ),
    payload,
  );
  await expect(dialog.getByText("授权凭据已保存", { exact: true })).toHaveCount(
    0,
  );
  await popup.evaluate(
    (message) => window.opener.postMessage(message, location.origin),
    payload,
  );
  const savedDialog = page.getByRole("dialog", {
    name: "修复 Outlook 授权",
    exact: true,
  });
  await expect(
    savedDialog.getByText("授权凭据已保存", { exact: true }),
  ).toBeVisible();
  await expect(
    savedDialog.getByText("pending@outlook.com", { exact: true }).first(),
  ).toBeVisible();
  await expect.poll(() => popup.isClosed()).toBe(true);
  await savedDialog.getByRole("button", { name: "关闭", exact: true }).click();
  expect(context.pages()).toHaveLength(1);
});

test("vault verification refreshes account state without triggering another lookup", async ({
  page,
}) => {
  await login(page);
  let lookups = 0;
  await page.route("**/api/vault/*/code?**", (route) => {
    lookups++;
    return route.fulfill({
      json: {
        success: true,
        data: {
          code: "246810",
          link: "",
          scanned: 1,
          subject: "Fictional verification",
        },
      },
    });
  });
  await page.goto("/#vault");
  await page.getByRole("searchbox").first().fill("Microsoft Workspace");
  await page
    .getByRole("button", {
      name: "查看 Microsoft Workspace 的账号",
      exact: true,
    })
    .click();
  const drawer = page.getByRole("dialog", {
    name: "Microsoft Workspace · 账号管理",
    exact: true,
  });
  await drawer.getByRole("combobox", { name: "账号展示方式" }).click();
  await page.getByRole("option", { name: "紧凑表格", exact: true }).click();
  await drawer
    .getByRole("button", {
      name: "查收 workspace@outlook.com 验证码或链接",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "查收验证码 / 链接",
    exact: true,
  });
  await expect(
    dialog.getByText("246810", { exact: true }).first(),
  ).toBeVisible();
  // Wait for the resulting workspace refresh. A short bounded observation detects
  // the former onSettled -> refresh -> lookup feedback loop, without extra clicks.
  await expect.poll(() => lookups).toBe(1);
  await page.waitForTimeout(700);
  expect(lookups).toBe(1);
  await dialog
    .getByRole("button", { name: "返回账号列表", exact: true })
    .click();
  await expect(drawer).toBeVisible();
});
