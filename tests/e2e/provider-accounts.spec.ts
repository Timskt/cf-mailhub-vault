import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function login(page: Page, path = "/#providers") {
  expect(
    (
      await page.request.post("/api/auth/login", {
        data: { password: "local-mailhub-password" },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(path);
}
async function fits(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  const dialog = page.getByRole("dialog").last();
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(-1);
  expect(bounds.y).toBeGreaterThanOrEqual(-1);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(
    page.viewportSize()!.width + 1,
  );
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(
    page.viewportSize()!.height + 1,
  );
  expect(
    await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
}
async function providerMock(page: Page) {
  const accounts: any[] = [];
  let next = 800,
    unavailable = false;
  const safe = (a: any) => {
    const { password, credential_version, ...summary } = a;
    return summary;
  };
  await page.route("**/api/providers**", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname,
      method = route.request().method();
    const respond = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/api/providers")
      return respond({
        success: true,
        data: ["mailtm", "mailgw"].map((id) => ({
          id,
          name: id === "mailtm" ? "Mail.tm" : "Mail.gw",
          account_count: accounts.filter((a) => a.provider === id).length,
          attention_count: 0,
        })),
      });
    if (path.endsWith("/domains"))
      return unavailable
        ? respond(
            { success: false, message: "服务商暂时无法连接，请稍后重试" },
            502,
          )
        : respond({
            success: true,
            data: [{ domain: "fixture.test" }],
            total: 1,
            page: 1,
            limit: 30,
          });
    if (path === "/api/providers/accounts") {
      if (method === "POST") {
        const body = route.request().postDataJSON();
        const a = {
          id: next++,
          ...body,
          remote_id: "fictional",
          status: "active",
          auth_status: "unchecked",
          has_password: true,
          credential_version: "v1",
          last_checked_at: "",
          last_error: "",
          last_error_code: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        delete a.mode;
        accounts.push(a);
        return respond(
          { success: true, data: safe(a), message: "邮箱已保存" },
          201,
        );
      }
      const filtered = accounts.filter(
        (a) =>
          (!url.searchParams.get("provider") ||
            a.provider === url.searchParams.get("provider")) &&
          (!url.searchParams.get("q") ||
            a.address.includes(url.searchParams.get("q"))),
      );
      return respond({
        success: true,
        data: filtered.map(safe),
        total: filtered.length,
        page: 1,
        limit: 30,
      });
    }
    const a = accounts.find((a) =>
      path.startsWith(`/api/providers/accounts/${a.id}`),
    );
    if (!a) return respond({ success: false, message: "不存在" }, 404);
    if (path.endsWith("/check")) {
      a.auth_status = "healthy";
      return respond({
        success: true,
        data: { connected: true },
        message: "邮箱连接成功",
      });
    }
    if (path.endsWith("/code"))
      return respond({
        success: true,
        data: {
          has_mail: true,
          code: "238641",
          link: "https://example.test/verify?token=fictional",
          subject: "验证码测试邮件",
          sender: "auth@example.test",
          received_at: new Date().toISOString(),
          scanned: 1,
          checked_at: new Date().toISOString(),
        },
      });
    const mail = {
      id: "message123",
      subject: "验证码测试邮件",
      sender: "auth@example.test",
      sender_name: "测试服务",
      created_at: new Date().toISOString(),
      is_read: 0,
      text_content: "您的验证码是 238641",
      html_content:
        "<h1>测试邮件</h1><script>parent.hacked=true</script><p>您的验证码是 238641</p>",
      verification_code: "238641",
      verification_link: "https://example.test/verify?token=fictional",
      has_attachments: false,
    };
    if (path.endsWith("/messages"))
      return respond({
        success: true,
        data: [mail],
        total: 1,
        page: 1,
        limit: 30,
      });
    if (path.endsWith("/messages/message123"))
      return respond({ success: true, data: mail });
    if (method === "PUT") {
      Object.assign(a, route.request().postDataJSON());
      a.credential_version = "v2";
      return respond({ success: true, data: safe(a), message: "账号已保存" });
    }
    if (method === "DELETE") {
      accounts.splice(accounts.indexOf(a), 1);
      return respond({ success: true, message: "接入已移除" });
    }
    return respond({ success: true, data: a });
  });
  return {
    accounts,
    unavailable: (value: boolean) => {
      unavailable = value;
    },
  };
}

test("saved Outlook and vault passwords are visible, copyable and persist explicit edits", async ({
  page,
  context,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page, "/#outlook");
  const address = "e2e-password@outlook.com",
    password = "Visible-only-test-password";
  const created = await page.request.post("/api/outlook/accounts", {
    data: {
      email: address,
      password,
      client_id: "11111111-2222-4333-8444-555555555555",
      refresh_token: "M.FICTIONAL_PASSWORD_BROWSER_TOKEN_0123456789",
    },
  });
  expect(created.ok()).toBe(true);
  const id = (await created.json()).data.id;
  await page.reload();
  await expect(
    page.getByRole("button", { name: `${address} 操作`, exact: true }).first(),
  ).toBeVisible();
  let releaseSearch!: () => void;
  let searchStarted!: () => void;
  const delayedSearch = new Promise<void>((resolve) => {
    releaseSearch = resolve;
  });
  const searchRequest = new Promise<void>((resolve) => {
    searchStarted = resolve;
  });
  await page.route("**/api/outlook/accounts?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("q") === address) {
      searchStarted();
      await delayedSearch;
    }
    await route.continue();
  });
  try {
    await page.getByRole("searchbox").first().fill(address);
    await page
      .getByRole("button", { name: `${address} 操作`, exact: true })
      .first()
      .click();
    await searchRequest;
    await expect(
      page.getByRole("menuitem", { name: "编辑凭据", exact: true }),
    ).toBeVisible({ timeout: 2000 });
    const updated = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/outlook/accounts" &&
        new URL(response.url()).searchParams.get("q") === address,
    );
    releaseSearch();
    await updated;
    await expect(
      page.getByRole("menuitem", { name: "编辑凭据", exact: true }),
    ).toBeVisible();
  } finally {
    releaseSearch();
    await page.unrouteAll({ behavior: "wait" });
  }
  await page.getByRole("menuitem", { name: "编辑凭据", exact: true }).click();
  let dialog = page.getByRole("dialog", {
    name: "编辑 Outlook 凭据",
    exact: true,
  });
  await expect(dialog.getByLabel("密码（可选）", { exact: true })).toHaveValue(
    password,
  );
  await expect(
    dialog.getByLabel("密码（可选）", { exact: true }),
  ).toHaveAttribute("type", "text");
  await dialog
    .getByRole("button", { name: "复制密码（可选）", exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    password,
  );
  await dialog
    .getByRole("button", { name: "隐藏密码（可选）", exact: true })
    .click();
  await expect(
    dialog.getByLabel("密码（可选）", { exact: true }),
  ).toHaveAttribute("type", "password");
  await dialog
    .getByRole("button", { name: "显示密码（可选）", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "打开授权工具" }),
  ).toBeEnabled();
  await dialog
    .getByLabel("密码（可选）", { exact: true })
    .fill(password + "-edited");
  await expect(
    dialog.getByRole("button", { name: "打开授权工具" }),
  ).toBeDisabled();
  await page.setViewportSize({ width: 375, height: 812 });
  await fits(page);
  await dialog.getByRole("button", { name: "保存账号", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    (await (await page.request.get(`/api/outlook/accounts/${id}`)).json()).data
      .password,
  ).toBe(password + "-edited");
  await page
    .getByRole("button", { name: `${address} 操作`, exact: true })
    .last()
    .click();
  await page.getByRole("menuitem", { name: "授权与修复", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "修复 Outlook 授权", exact: true });
  await expect(dialog.getByLabel("账号密码", { exact: true })).toHaveValue(
    password + "-edited",
  );
  await dialog
    .getByRole("button", { name: "复制账号密码", exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    password + "-edited",
  );
  await fits(page);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("mobile-repair-password.png"),
  });
  await page.keyboard.press("Escape");
  const v = await page.request.post("/api/vault", {
    data: {
      platform_name: "E2E Password",
      account_email: address,
      email_source: "outlook",
      password,
    },
  });
  expect(v.ok()).toBe(true);
  await page.goto("/#vault?q=E2E%20Password");
  await page
    .getByRole("button", { name: "管理 E2E Password 账号", exact: true })
    .click();
  await page.getByRole("button", { name: address, exact: true }).click();
  dialog = page.getByRole("dialog", { name: "编辑平台账号", exact: true });
  await expect(dialog.getByLabel("密码", { exact: true })).toHaveValue(
    password,
  );
  await expect(dialog.getByLabel("密码", { exact: true })).toHaveAttribute(
    "type",
    "text",
  );
  await fits(page);
  expect(errors).toEqual([]);
});

test("provider create/connect/edit, mailbox reader, nested verification and local removal work on mobile", async ({
  page,
  context,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const mock = await providerMock(page);
  await login(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("button", { name: "创建外部邮箱", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "接入外部邮箱", exact: true });
  await expect(dialog.getByLabel("邮箱密码", { exact: true })).toHaveAttribute(
    "type",
    "text",
  );
  await dialog.getByLabel("地址前缀", { exact: true }).fill("owned");
  await dialog
    .getByLabel("邮箱密码", { exact: true })
    .fill("Fictional-e2e-password-82");
  await expect(
    dialog.getByText("owned@fixture.test", { exact: true }),
  ).toBeVisible();
  await fits(page);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("mobile-provider-create.png"),
  });
  const a11y = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(a11y.violations).toEqual([]);
  await dialog.getByRole("button", { name: "创建并保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(mock.accounts[0].address).toBe("owned@fixture.test");
  await page
    .getByRole("button", { name: "邮箱操作：owned@fixture.test", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "编辑账号 / 查看密码", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "编辑外部邮箱", exact: true });
  await expect(dialog.getByLabel("邮箱密码", { exact: true })).toHaveValue(
    "Fictional-e2e-password-82",
  );
  await dialog
    .getByRole("button", { name: "复制邮箱密码", exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Fictional-e2e-password-82",
  );
  await dialog.getByLabel("用途备注").fill("开发测试");
  await dialog.getByRole("button", { name: "保存账号", exact: true }).click();
  await page.getByRole("button", { name: "收件", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Mail.tm 收件箱", exact: true });
  await dialog.getByRole("button", { name: /验证码测试邮件/ }).click();
  await expect(
    dialog.getByRole("heading", { name: "验证码测试邮件", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => (window as any).hacked)).toBeUndefined();
  await fits(page);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("mobile-provider-message.png"),
  });
  await dialog
    .getByRole("button", { name: "查看验证码 / 链接", exact: true })
    .click();
  const verification = page.getByRole("dialog", {
    name: "外部邮箱验证码 / 链接",
    exact: true,
  });
  await expect(verification.getByText("238641", { exact: true })).toBeVisible();
  await fits(page);
  await verification
    .getByRole("button", { name: "关闭查收", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "关闭收件箱", exact: true }).click();
  await page.getByRole("button", { name: "接入已有邮箱", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "接入外部邮箱", exact: true });
  await dialog.getByLabel("邮箱服务商", { exact: true }).click();
  await page.getByRole("option", { name: "Mail.gw", exact: true }).click();
  await dialog
    .getByLabel("邮箱地址", { exact: true })
    .fill("existing@fixture.test");
  await dialog
    .getByLabel("邮箱密码", { exact: true })
    .fill("Fictional-existing-password");
  await dialog.getByRole("button", { name: "验证并接入", exact: true }).click();
  expect(mock.accounts[1].provider).toBe("mailgw");
  await page
    .getByRole("button", {
      name: "邮箱操作：existing@fixture.test",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "移除接入", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await confirmation.getByRole("button", { name: /确认/ }).click();
  await expect(
    page.getByText("existing@fixture.test", { exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("unavailable domain API shows retry and blocks creation while existing-account mode remains usable", async ({
  page,
}) => {
  const mock = await providerMock(page);
  mock.unavailable(true);
  await login(page);
  await page.getByRole("button", { name: "创建外部邮箱", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "接入外部邮箱",
    exact: true,
  });
  await expect(
    dialog.getByText("服务商暂时无法连接，请稍后重试", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "创建并保存", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("tab", { name: "接入已有账号", exact: true }).click();
  await expect(dialog.getByLabel("邮箱地址", { exact: true })).toBeVisible();
  mock.unavailable(false);
  await dialog.getByRole("tab", { name: "创建新邮箱", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "创建并保存", exact: true }),
  ).toBeEnabled();
});
