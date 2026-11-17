import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function fits(page: Page) {
  await expect(async () => {
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    const top = page.getByRole("dialog").last();
    const bounds = (await top.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(-1);
    expect(bounds.y).toBeGreaterThanOrEqual(-1);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      page.viewportSize()!.width + 1,
    );
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(
      page.viewportSize()!.height + 1,
    );
    expect(
      await top.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
  }).toPass({ timeout: 5000 });
}

test("one mailbox keeps three independent platform registrations across both views, nested dialogs, mobile, dark and disabled connections", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  expect(
    (
      await page.request.post("/api/auth/login", {
        data: { password: "local-mailhub-password" },
      })
    ).ok(),
  ).toBe(true);
  const address = "reading@example.test";
  const records: { id: number; platform_name: string; password: string }[] = [];
  for (const [index, platform] of ["Atlas", "Beacon", "Cedar"].entries()) {
    const platform_name = `Identity E2E ${platform}`;
    const password = `Independent-platform-${index}-only`;
    const response = await page.request.post("/api/vault", {
      data: {
        platform_name,
        account_email: address,
        email_source: "cf_domain",
        username: `member-${index}`,
        password,
        workspace: `Team ${platform}`,
        account_identifier: `account-${index}`,
        login_methods: '["password"]',
        ...(index === 0 ? { verification_sender: "auth@example.test" } : {}),
        expires_at: "2030-12-01T00:00:00.000Z",
      },
    });
    expect(response.ok()).toBe(true);
    records.push({
      id: (await response.json()).data.id,
      platform_name,
      password,
    });
  }
  await page.goto("/#identities");
  await expect(
    page.getByRole("heading", { name: "邮箱资产", exact: true }),
  ).toBeVisible();
  await page.getByRole("searchbox").fill(address);
  const openIdentity = page.getByRole("button", {
    name: `查看邮箱资产 ${address}`,
    exact: true,
  });
  await openIdentity.click();
  const identity = page.getByRole("dialog", {
    name: `${address} · 邮箱资产`,
    exact: true,
  });
  await expect(
    identity.getByText("3 个平台 · 3 条登记", { exact: true }),
  ).toBeVisible();
  await expect(
    identity.getByText("来源：自建域名", { exact: true }),
  ).toBeVisible();
  await expect(
    identity.getByRole("button", { name: /复制.*密码/ }),
  ).toHaveCount(0);
  for (const record of records) {
    const row = identity.getByRole("article", {
      name: `${record.platform_name} 登记`,
      exact: true,
    });
    await expect(row).toContainText("密码登录");
    const edit = row.getByRole("button", { name: "编辑登记", exact: true });
    await edit.click();
    const editor = page.getByRole("dialog", {
      name: "编辑平台账号",
      exact: true,
    });
    await expect(editor.getByLabel("密码", { exact: true })).toHaveValue(
      record.password,
    );
    await page.keyboard.press("Escape");
    await expect(identity).toBeVisible();
    await expect(edit).toBeFocused();
  }
  const first = identity.getByRole("article", {
    name: `${records[0].platform_name} 登记`,
    exact: true,
  });
  const verify = first.getByRole("button", {
    name: "取码 / 链接",
    exact: true,
  });
  const request = page.waitForRequest(
    (r) => new URL(r.url()).pathname === `/api/vault/${records[0].id}/code`,
  );
  await verify.click();
  expect(new URL((await request).url()).searchParams.get("match")).toBe(
    "platform",
  );
  await expect(
    page.getByRole("dialog").last().getByText("246810", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(verify).toBeFocused();
  const second = identity.getByRole("article", {
    name: `${records[1].platform_name} 登记`,
    exact: true,
  });
  await second
    .getByRole("button", { name: "取码 / 链接", exact: true })
    .click();
  const lookup = page.getByRole("dialog").last();
  await expect(
    lookup.getByRole("button", { name: "配置平台取码规则", exact: true }),
  ).toBeVisible();
  await expect(
    lookup.getByRole("button", { name: "查整个邮箱", exact: true }),
  ).toBeVisible();
  await expect(lookup.getByText("246810", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const add = identity.getByRole("button", { name: "登记新平台", exact: true });
  await add.click();
  const draft = page.getByRole("dialog", { name: "登记平台账号", exact: true });
  await expect(draft.getByLabel("登录邮箱", { exact: true })).toHaveValue(
    address,
  );
  await expect(
    draft.getByRole("combobox", { name: "邮箱来源", exact: true }),
  ).toContainText("自建域名");
  await fits(page);
  await page.keyboard.press("Escape");
  await expect(add).toBeFocused();
  await page.setViewportSize({ width: 375, height: 812 });
  await fits(page);
  await identity.getByRole("tab", { name: "连接概览", exact: true }).click();
  await expect(
    identity.getByText("邮箱连接状态", { exact: true }),
  ).toBeVisible();
  await identity
    .getByRole("button", { name: "关闭邮箱详情", exact: true })
    .click();
  await page.getByRole("button", { name: "切换深色主题", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await openIdentity.click();
  await fits(page);
  await page.screenshot({
    path: info.outputPath("mobile-identities-dark.png"),
    animations: "disabled",
  });
  expect(
    (
      await new AxeBuilder({ page })
        .include('[data-slot="sheet-content"]')
        .withTags(["wcag2a", "wcag2aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await identity
    .getByRole("button", { name: "关闭邮箱详情", exact: true })
    .click();
  await expect(openIdentity).toBeFocused();
  await page.goto(`/#vault?q=${encodeURIComponent(records[0].platform_name)}`);
  await page
    .getByRole("button", {
      name: `管理 ${records[0].platform_name} 账号`,
      exact: true,
    })
    .click();
  const platform = page.getByRole("dialog", {
    name: `${records[0].platform_name} · 账号管理`,
    exact: true,
  });
  const fromPlatform = platform.getByRole("button", {
    name: `查看邮箱资产 ${address}`,
    exact: true,
  });
  await fromPlatform.click();
  await expect(
    identity.getByText("3 个平台 · 3 条登记", { exact: true }),
  ).toBeVisible();
  await identity
    .getByRole("button", { name: "关闭邮箱详情", exact: true })
    .click();
  await expect(platform).toBeVisible();
  await expect(fromPlatform).toBeFocused();
  const paged = await (
    await page.request.get(
      `/api/mailbox-identities/${encodeURIComponent(`cf_domain:${address}`)}/registrations?page=2&limit=2`,
    )
  ).json();
  expect(paged.total).toBe(3);
  expect(paged.data).toHaveLength(1);
  expect(paged.data[0].password).toBeUndefined();
  const disabledAddress = "identity-disabled@outlook.com";
  expect(
    (
      await page.request.post("/api/outlook/accounts", {
        data: {
          email: disabledAddress,
          password: "mailbox-password-is-separate",
          client_id: "11111111-2222-4333-8444-555555555555",
          refresh_token: "M.FICTIONAL_IDENTITY_E2E_REFRESH_TOKEN_0123456789",
          status: "disabled",
        },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.post("/api/vault", {
        data: {
          platform_name: records[0].platform_name,
          account_email: disabledAddress,
          email_source: "outlook",
          password: "separate-platform-password",
        },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/#outlook?q=${disabledAddress}`);
  const disabledRow = page
    .getByRole("article")
    .filter({ hasText: disabledAddress });
  await disabledRow
    .getByRole("button", { name: "查看全部登记", exact: true })
    .click();
  const disabled = page.getByRole("dialog", {
    name: `${disabledAddress} · 邮箱资产`,
    exact: true,
  });
  await expect(disabled.getByText("邮箱已停用", { exact: true })).toBeVisible();
  await expect(
    disabled.getByRole("article", {
      name: `${records[0].platform_name} 登记`,
      exact: true,
    }),
  ).toBeVisible();
  await fits(page);
  expect(errors).toEqual([]);
});

test("alias registrations open and manage the delivery mailbox instead of the platform login email", async ({
  page,
}) => {
  expect(
    (
      await page.request.post("/api/auth/login", {
        data: { password: "local-mailhub-password" },
      })
    ).ok(),
  ).toBe(true);
  const aliases = [
    {
      platform_name: "Identity Alias E2E Domain",
      account_email: "alias-domain-login@example.test",
      mailbox_address: "reading@example.test",
      email_source: "cf_domain",
    },
    {
      platform_name: "Identity Alias E2E Outlook Inbox",
      account_email: "alias-outlook-login@example.test",
      mailbox_address: "workspace@outlook.com",
      email_source: "outlook",
    },
    {
      platform_name: "Identity Alias E2E Outlook Connect",
      account_email: "alias-connect-login@example.test",
      mailbox_address: "identity-alias-connect@outlook.com",
      email_source: "outlook",
    },
  ];
  for (const alias of aliases) {
    const response = await page.request.post("/api/vault", {
      data: { ...alias, password: "independent-alias-platform-password" },
    });
    expect(response.ok()).toBe(true);
  }
  const openPlatform = async (alias: (typeof aliases)[number]) => {
    await page.goto(`/#vault?q=${encodeURIComponent(alias.platform_name)}`);
    await page
      .getByRole("button", {
        name: `管理 ${alias.platform_name} 账号`,
        exact: true,
      })
      .click();
    const platform = page.getByRole("dialog", {
      name: `${alias.platform_name} · 账号管理`,
      exact: true,
    });
    await expect(
      platform.getByRole("button", { name: alias.account_email, exact: true }),
    ).toBeVisible();
    return platform;
  };

  const domain = await openPlatform(aliases[0]);
  await domain.getByRole("button", { name: "打开收件箱", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "域名收件箱", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "收件地址", exact: true }),
  ).toContainText(aliases[0].mailbox_address);
  await expect(
    page.getByText("欢迎使用工作邮箱 · 验证码 246810", { exact: true }),
  ).toBeVisible();

  // Keep registration/health requests real; only remote Microsoft mail is stubbed.
  await page.route("**/api/outlook/accounts/1/emails?**", (route) =>
    route.fulfill({ json: { success: true, data: [], next_cursor: "" } }),
  );
  const outlook = await openPlatform(aliases[1]);
  const inbox = outlook.getByRole("button", {
    name: "打开收件箱",
    exact: true,
  });
  await inbox.click();
  const reader = page.getByRole("dialog", {
    name: aliases[1].mailbox_address,
    exact: true,
  });
  await expect(reader.getByText("暂无邮件", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(outlook).toBeVisible();
  await expect(inbox).toBeFocused();

  const missing = await openPlatform(aliases[2]);
  const connect = missing.getByRole("button", {
    name: "接入此 Outlook 邮箱",
    exact: true,
  });
  await connect.click();
  const recovery = page.getByRole("dialog", {
    name: "连接 Outlook 邮箱",
    exact: true,
  });
  await expect(
    recovery.getByRole("textbox", { name: "绑定邮箱（可选）", exact: true }),
  ).toHaveValue(aliases[2].mailbox_address);
  await page.keyboard.press("Escape");
  await expect(missing).toBeVisible();
  await expect(connect).toBeFocused();
});
