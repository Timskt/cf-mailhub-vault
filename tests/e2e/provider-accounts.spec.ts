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
        data: [
          {
            id: "mailtm",
            name: "Mail.tm",
            description: "临时邮箱 · 账号密码登录",
            integration_hint: "Mail.tm 与 Mail.gw 使用同一 API 家族",
            credential_label: "邮箱密码",
            can_create: true,
          },
          {
            id: "mailgw",
            name: "Mail.gw",
            description: "临时邮箱 · 账号密码登录",
            integration_hint: "Mail.tm 与 Mail.gw 使用同一 API 家族",
            credential_label: "邮箱密码",
            can_create: true,
          },
          {
            id: "mailslurp",
            name: "MailSlurp",
            description: "测试邮箱 API · 需使用自己的 MailSlurp 账户",
            integration_hint: "请先创建 Inbox，再接入",
            credential_label: "MailSlurp API Key",
            can_create: false,
          },
          {
            id: "mailinator",
            name: "Mailinator Private",
            description: "私有域收件 API · 按地址读取",
            integration_hint: "只接入账户私有域",
            credential_label: "Mailinator API Token",
            can_create: false,
          },
        ].map((provider) => ({
          ...provider,
          url: "https://example.test",
          docs: "https://example.test/docs",
          account_count: accounts.filter((a) => a.provider === provider.id)
            .length,
          attention_count: accounts.filter(
            (a) =>
              a.provider === provider.id &&
              ["error", "reauth_required"].includes(a.auth_status),
          ).length,
          capabilities: [provider.can_create ? "create" : "api_key"],
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
            `${a.address} ${a.remark || ""}`.includes(
              url.searchParams.get("q"),
            )) &&
          (!url.searchParams.get("status") ||
            url.searchParams.get("status") === "all" ||
            (url.searchParams.get("status") === "attention"
              ? ["error", "reauth_required"].includes(a.auth_status)
              : a.status === url.searchParams.get("status"))),
      );
      const limit = Number(url.searchParams.get("limit") || 30),
        pageNumber = Number(url.searchParams.get("page") || 1);
      return respond({
        success: true,
        data: filtered
          .slice((pageNumber - 1) * limit, pageNumber * limit)
          .map(safe),
        total: filtered.length,
        page: pageNumber,
        limit,
      });
    }
    const accountId = Number(
      path.match(/^\/api\/providers\/accounts\/(\d+)(?:\/|$)/)?.[1],
    );
    const a = accounts.find((account) => account.id === accountId);
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
    if (path.endsWith("/messages")) {
      const pageNumber = Number(url.searchParams.get("page") || 1);
      const pagedMailinator = a.provider === "mailinator";
      return respond({
        success: true,
        data: pagedMailinator
          ? pageNumber === 1
            ? Array.from({ length: 30 }, (_, index) => ({
                ...mail,
                id: `message-${index + 1}`,
              }))
            : [mail]
          : [mail],
        total: pagedMailinator ? 31 : 1,
        ...(pagedMailinator ? { has_more: pageNumber === 1 } : {}),
        page: pageNumber,
        limit: 30,
      });
    }
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

test("large provider pools paginate densely and MailSlurp uses an API key for an existing inbox", async ({
  page,
  context,
}, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const mock = await providerMock(page);
  mock.accounts.push(
    ...Array.from({ length: 45 }, (_, index) => ({
      id: index + 1,
      provider: index % 2 ? "mailtm" : "mailgw",
      address: `member-${String(index + 1).padStart(3, "0")}@fixture.test`,
      remote_id: `remote-${index + 1}`,
      password: "Fictional-only-password",
      status: "active",
      auth_status: index === 2 ? "error" : "healthy",
      remark: index === 2 ? "needs repair" : "test inbox",
      has_password: true,
      credential_version: "v1",
      last_checked_at: "2026-11-20T10:00:00.000Z",
      last_error: index === 2 ? "Upstream timeout" : "",
      last_error_code: index === 2 ? "PROVIDER_TIMEOUT" : "",
      created_at: "2026-11-20T10:00:00.000Z",
      updated_at: "2026-11-20T10:00:00.000Z",
    })),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);

  const table = page.getByRole("table", { name: "外部邮箱账号紧凑列表" });
  await expect(table).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(31);
  await expect(
    page.getByRole("button", { name: /Mail\.gw 23 1 需处理/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "全部来源 45", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("服务商与接入方式", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "接入已有 Inbox", exact: true }),
  ).toBeHidden();
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("provider-accounts-compact-desktop.png"),
  });
  await page.getByRole("checkbox", { name: "选择全部当前页" }).click();
  await expect(
    page.getByText("已选择 30 个账号（本页 30 个）", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "复制选中邮箱", exact: true }).click();
  expect(
    (await page.evaluate(() => navigator.clipboard.readText())).split("\n"),
  ).toHaveLength(30);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(table.getByRole("row")).toHaveCount(16);
  await expect(
    page.getByText("已选择 30 个账号（本页 0 个）", { exact: true }),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: "选择全部当前页" }).click();
  await expect(
    page.getByText("已选择 45 个账号（本页 15 个）", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "复制选中邮箱", exact: true }).click();
  expect(
    (await page.evaluate(() => navigator.clipboard.readText())).split("\n"),
  ).toHaveLength(45);

  await page.getByRole("combobox", { name: "每页条数" }).click();
  await page.getByRole("option", { name: "每页 50 条", exact: true }).click();
  await expect(table.getByRole("row")).toHaveCount(46);
  await expect(
    table.getByText("Upstream timeout", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "舒展", exact: true }).click();
  await expect(table).toBeHidden();
  await expect(
    page.getByRole("article", {
      name: "外部邮箱 member-001@fixture.test",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "紧凑", exact: true }).click();
  await expect(table).toBeVisible();

  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(table).toBeHidden();
  await expect(
    page.getByRole("article", {
      name: "外部邮箱 member-001@fixture.test",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(table).toBeHidden();
  await expect(
    page.getByRole("article", {
      name: "外部邮箱 member-001@fixture.test",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("provider-accounts-compact-mobile.png"),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: /Mail\.tm 22/ }).click();
  await expect(page.getByText("共 22 条记录", { exact: true })).toBeVisible();

  await page.getByText("服务商与接入方式", { exact: true }).click();
  await page
    .getByRole("button", { name: "接入已有 Inbox", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "接入外部邮箱",
    exact: true,
  });
  await dialog.getByRole("combobox", { name: "邮箱服务商" }).click();
  await page.getByRole("option", { name: "MailSlurp", exact: true }).click();
  await expect(
    dialog.getByRole("tab", { name: "创建新邮箱", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByLabel("邮箱地址", { exact: true })
    .fill("qa@mailslurp.test");
  await dialog
    .getByLabel("MailSlurp API Key", { exact: true })
    .fill("Fictional-mail-s-l-u-r-p-key");
  await expect(dialog.getByText(/先在 MailSlurp 创建 Inbox/)).toBeVisible();
  await dialog.getByRole("button", { name: "验证并接入", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(mock.accounts.at(-1).provider).toBe("mailslurp");
  expect(mock.accounts.at(-1).password).toBe("Fictional-mail-s-l-u-r-p-key");

  await page.getByRole("button", { name: "接入私有邮箱", exact: true }).click();
  const mailinatorDialog = page.getByRole("dialog", {
    name: "接入外部邮箱",
    exact: true,
  });
  await mailinatorDialog
    .getByLabel("邮箱地址", { exact: true })
    .fill("qa@team.testinator.com");
  await mailinatorDialog
    .getByLabel("Mailinator API Token", { exact: true })
    .fill("Fictional-mailinator-token");
  await expect(mailinatorDialog.getByText(/公共收件箱/)).toBeVisible();
  await mailinatorDialog
    .getByRole("button", { name: "验证并接入", exact: true })
    .click();
  await expect(mailinatorDialog).toHaveCount(0);
  expect(mock.accounts.at(-1).provider).toBe("mailinator");
  await page.getByRole("button", { name: "全部来源 47", exact: true }).click();
  await page.getByRole("searchbox").first().fill("qa@team.testinator.com");
  const mailinatorAccount = page.getByRole("article", {
    name: "外部邮箱 qa@team.testinator.com",
    exact: true,
  });
  await mailinatorAccount
    .getByRole("button", { name: "收件", exact: true })
    .click();
  const mailinatorReader = page.getByRole("dialog", {
    name: "Mailinator Private 收件箱",
    exact: true,
  });
  await expect(
    mailinatorReader.getByText("至少 31 条记录", { exact: true }),
  ).toBeVisible();
  await expect(
    mailinatorReader.getByText("1 / 2+", { exact: true }),
  ).toBeVisible();
  await mailinatorReader
    .getByRole("button", { name: "下一页", exact: true })
    .click();
  await expect(
    mailinatorReader.getByText("共 31 条记录", { exact: true }),
  ).toBeVisible();
  await expect(
    mailinatorReader.getByText("2 / 2", { exact: true }),
  ).toBeVisible();
  await expect(
    mailinatorReader.getByRole("button", { name: "下一页", exact: true }),
  ).toBeDisabled();
});
