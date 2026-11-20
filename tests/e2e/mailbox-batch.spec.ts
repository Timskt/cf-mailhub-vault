import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  expect(
    (
      await page.request.post("/api/auth/login", {
        data: { password: "local-mailhub-password" },
      })
    ).ok(),
  ).toBe(true);
  await page.goto("/#mailboxes");
}

test("batch domain picker stays compact with many domains and filters the list", async ({
  page,
}) => {
  await page.route("**/api/settings", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const domains = body.data.domains;
    body.data.domains = [
      ...domains,
      ...Array.from({ length: 40 }, (_, index) => ({
        ...domains[0],
        domain: `fixture-${String(index + 1).padStart(2, "0")}.test`,
        enabled: true,
        is_default: false,
      })),
    ];
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/mailboxes/batch-preview", async (route) => {
    const body = route.request().postDataJSON();
    const data = Array.from({ length: body.count }, (_, index) => {
      const domain = body.domains[index % body.domains.length];
      return {
        domain,
        prefix: `fixture-${index + 1}`,
        duration_minutes: body.duration_minutes,
        is_permanent: body.is_permanent,
        remark: body.remark,
      };
    });
    await route.fulfill({
      json: { success: true, data },
    });
  });
  await login(page);
  await page.getByRole("button", { name: "批量分配邮箱", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "批量分配邮箱",
    exact: true,
  });
  await dialog.getByRole("button", { name: "清空所选", exact: true }).click();
  await dialog
    .getByLabel("搜索启用域名", { exact: true })
    .fill("fixture-40.test");
  await dialog
    .getByRole("button", { name: "全选当前结果", exact: true })
    .click();
  await expect(dialog.getByText("1/42 个域名", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("complementary", { name: "本次批量分配摘要" }),
  ).toContainText("fixture-40.test");
  await expect(
    dialog.getByRole("complementary", { name: "本次批量分配摘要" }),
  ).toContainText("10");
  await dialog.getByLabel("搜索启用域名", { exact: true }).fill("");
  await dialog
    .getByRole("button", { name: "全选当前结果", exact: true })
    .click();
  const options = dialog.getByTestId("batch-domain-options");
  const bounds = await options.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(bounds.clientHeight).toBeLessThanOrEqual(200);
  expect(bounds.scrollHeight).toBeGreaterThan(bounds.clientHeight);
  await dialog.getByRole("button", { name: "100", exact: true }).click();
  await dialog.getByRole("button", { name: "预览地址", exact: true }).click();
  const preview = page.getByRole("dialog", {
    name: "确认分配清单",
    exact: true,
  });
  await expect(preview.getByText("42 个域名", { exact: true })).toBeVisible();
  await expect(
    preview.getByRole("table", { name: "邮箱分配清单" }).getByRole("row"),
  ).toHaveCount(101);
});

test("mailbox account list supports cross-page selection, larger pages and both layouts", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("**/api/mailboxes?*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const url = new URL(route.request().url());
    const pageNumber = Number(url.searchParams.get("page") || 1);
    const limit = Number(url.searchParams.get("limit") || 30);
    const all = Array.from({ length: 55 }, (_, index) => ({
      id: index + 1,
      address: `member-${String(index + 1).padStart(3, "0")}@example.test`,
      domain: "example.test",
      remark: `Account ${index + 1}`,
      is_permanent: index % 3 === 0 ? 1 : 0,
      expires_at: "2099-01-01T00:00:00.000Z",
      is_expired: false,
      associated_platform: "",
      mail_count: index % 4,
      unread_count: index % 2,
      last_received_at: "",
      created_at: "2026-11-20T10:00:00.000Z",
    }));
    body.total = all.length;
    body.page = pageNumber;
    body.limit = limit;
    body.data = all.slice((pageNumber - 1) * limit, pageNumber * limit);
    body.summary.total = all.length;
    await route.fulfill({ response, json: body });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);

  const table = page.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(31);
  await page
    .getByRole("checkbox", { name: "选择邮箱 member-001@example.test" })
    .click();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "选择邮箱 member-031@example.test" })
    .click();
  await expect(page.getByText("2 个已选", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "复制所选邮箱", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "member-001@example.test\nmember-031@example.test",
  );
  const selectedExport = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出所选", exact: true }).click();
  expect((await selectedExport).suggestedFilename()).toBe(
    "selected-mailboxes.json",
  );
  await page.getByRole("combobox", { name: "每页邮箱数" }).click();
  await page.getByRole("option", { name: "每页 100 个", exact: true }).click();
  await expect(table.getByRole("row")).toHaveCount(56);
  await page.getByRole("tab", { name: "卡片", exact: true }).click();
  await expect(table).toBeHidden();
  await expect(
    page.getByRole("article", {
      name: "member-001@example.test",
      exact: false,
    }),
  ).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});

test("batch mailbox preview summarizes domains and remains usable on mobile", async ({
  page,
  context,
}, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  const before = await page.request.get("/api/mailboxes");
  const beforeTotal = (await before.json()).total;

  await page.getByRole("button", { name: "批量分配邮箱", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "批量分配邮箱", exact: true });
  await dialog.getByRole("button", { name: "清空所选", exact: true }).click();
  await dialog
    .getByLabel("搜索启用域名", { exact: true })
    .fill("mail.example.test");
  await dialog
    .getByRole("button", { name: "全选当前结果", exact: true })
    .click();
  await expect(dialog.getByText("1/2 个域名", { exact: true })).toBeVisible();
  await dialog.getByLabel("搜索启用域名", { exact: true }).fill("");
  await dialog
    .getByRole("button", { name: "全选当前结果", exact: true })
    .click();
  await dialog.getByRole("button", { name: "100", exact: true }).click();
  await dialog.getByRole("button", { name: "预览地址", exact: true }).click();

  dialog = page.getByRole("dialog", { name: "确认分配清单", exact: true });
  await expect(dialog.getByText("100 个地址", { exact: true })).toBeVisible();
  await expect(dialog.getByText("2 个域名", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("complementary", { name: "批量分配汇总" }),
  ).toBeVisible();
  const table = dialog.getByRole("table", { name: "邮箱分配清单" });
  await expect(table.getByRole("row")).toHaveCount(101);
  const domainRows = dialog
    .getByRole("region", { name: "各域名分配数量" })
    .locator("div.grid > div");
  await expect(domainRows).toHaveCount(2);
  const domainTotals = await domainRows
    .locator("span.font-medium")
    .allTextContents();
  expect(
    domainTotals
      .map((text) => Number.parseInt(text, 10))
      .reduce((a, b) => a + b, 0),
  ).toBe(100);
  const domainFilter = dialog.getByRole("combobox", { name: "按域名筛选" });
  await domainFilter.click();
  await page.getByRole("option", { name: "example.test", exact: true }).click();
  await expect(
    dialog.getByText("显示 50 / 100 个地址", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "复制筛选地址", exact: true })
    .click();
  const copiedDomain = (
    await page.evaluate(() => navigator.clipboard.readText())
  ).split("\n");
  expect(copiedDomain).toHaveLength(50);
  expect(
    copiedDomain.every((address) => address.endsWith("@example.test")),
  ).toBe(true);
  await domainFilter.click();
  await page.getByRole("option", { name: "全部域名", exact: true }).click();
  await expect(
    dialog.getByText("预览尚未创建邮箱。", { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("mailbox-batch-preview-desktop.png"),
  });
  await dialog
    .getByRole("button", { name: "复制预览地址", exact: true })
    .click();
  expect(
    (await page.evaluate(() => navigator.clipboard.readText())).split("\n"),
  ).toHaveLength(100);

  await page.setViewportSize({ width: 375, height: 812 });
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(376);
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  const mobileAddresses = dialog.locator("[data-mailbox-address]");
  await expect(mobileAddresses).toHaveCount(100);
  expect(
    await mobileAddresses.evaluateAll((elements) =>
      elements.some((element) => element.scrollWidth > element.clientWidth + 1),
    ),
  ).toBe(false);
  await expect(mobileAddresses.first()).toContainText("@example.test");
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("mailbox-batch-preview-mobile.png"),
  });

  await dialog
    .getByRole("button", { name: "确认创建 100 个邮箱", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "邮箱已批量分配", exact: true });
  await expect(dialog.getByText("100 个地址", { exact: true })).toBeVisible();
  await dialog
    .getByRole("button", { name: "复制全部地址", exact: true })
    .click();
  expect(
    (await page.evaluate(() => navigator.clipboard.readText())).split("\n"),
  ).toHaveLength(100);
  const download = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "导出分配清单", exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe("mailboxes.json");
  const after = await page.request.get("/api/mailboxes");
  expect((await after.json()).total).toBe(beforeTotal + 100);
});
