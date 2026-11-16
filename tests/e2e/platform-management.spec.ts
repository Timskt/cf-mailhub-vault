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
async function fits(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  for (const dialog of await page.getByRole("dialog").all()) {
    if (!(await dialog.isVisible())) continue;
    const b = await dialog.boundingBox();
    expect(b).not.toBeNull();
    expect(b!.x).toBeGreaterThanOrEqual(-1);
    expect(b!.y).toBeGreaterThanOrEqual(-1);
    expect(b!.x + b!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    expect(b!.y + b!.height).toBeLessThanOrEqual(
      page.viewportSize()!.height + 1,
    );
  }
}

test("independent platform create/edit/merge/delete, text import/export and clipboard work on mobile", async ({
  page,
  context,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  await page
    .getByRole("button", { name: "新建平台", exact: true })
    .first()
    .click();
  let dialog = page.getByRole("dialog", { name: "新建平台", exact: true });
  await dialog.getByLabel("平台名称", { exact: true }).fill("E2E Independent");
  await dialog
    .getByLabel("平台官网", { exact: true })
    .fill("https://example.test/platform");
  await dialog.getByLabel("平台备注").fill("独立平台说明");
  await dialog.getByRole("button", { name: "保存平台" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "管理平台", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "管理平台", exact: true });
  await manager.getByRole("searchbox").fill("E2E Independent");
  await expect(manager.getByText("0 个账号", { exact: true })).toBeVisible();
  await manager
    .getByRole("button", { name: "编辑平台 E2E Independent", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "编辑平台", exact: true });
  await dialog.getByLabel("平台名称", { exact: true }).fill("E2E Renamed");
  await page.setViewportSize({ width: 375, height: 812 });
  await fits(page);
  await dialog.getByRole("button", { name: "保存平台" }).click();
  await manager.getByRole("searchbox").fill("E2E Renamed");
  await expect(
    manager.getByRole("button", { name: "编辑平台 E2E Renamed" }),
  ).toBeVisible();
  await manager.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("button", { name: "导入账号", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "导入平台账号", exact: true });
  const content =
    'E2E Renamed----e2e-transfer@example.test----"safe----password"----demo----external----工具----active----https://example.test/------------"第一行\n第二行"';
  await dialog
    .getByLabel("账号内容", { exact: true })
    .fill(content + "\ninvalid----broken");
  await dialog.getByRole("button", { name: "预览导入", exact: true }).click();
  await expect(dialog.getByRole("button", { name: /确认导入/ })).toBeDisabled();
  await dialog.getByLabel("账号内容", { exact: true }).fill(content);
  await dialog.getByRole("button", { name: "预览导入", exact: true }).click();
  await expect(dialog.getByText("1 条有效账号 · 0 行错误")).toBeVisible();
  await fits(page);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("mobile-vault-text-import.png"),
  });
  await dialog
    .getByRole("button", { name: "确认导入 1 个账号", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("searchbox").first().fill("E2E Renamed");
  await expect(
    page.getByRole("button", { name: "管理 E2E Renamed 账号" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "导出账号", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "导出筛选账号", exact: true });
  await expect(dialog.getByLabel("导出预览")).toHaveValue("");
  await dialog
    .getByRole("button", { name: "生成导出内容", exact: true })
    .click();
  await expect(dialog.getByLabel("导出预览")).toHaveValue(
    /e2e-transfer@example.test/,
  );
  const exported = await dialog.getByLabel("导出预览").inputValue();
  expect(exported).toContain('"safe----password"');
  await dialog.getByRole("button", { name: "复制内容", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    exported,
  );
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: /下载/ }).click();
  expect((await download).suggestedFilename()).toMatch(/\.txt$/);
  await fits(page);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("mobile-vault-export.png"),
  });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  const preview = await (
    await page.request.post("/api/vault/import-preview", {
      data: { raw_text: exported },
    })
  ).json();
  expect(preview.valid_count).toBe(1);
  expect(preview.error_count).toBe(0);

  await page.getByRole("button", { name: "管理 E2E Renamed 账号" }).click();
  const drawer = page.getByRole("dialog", {
    name: "E2E Renamed · 账号管理",
    exact: true,
  });
  await drawer
    .getByRole("button", {
      name: "e2e-transfer@example.test 操作",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: "导出账号 / 复制配置", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "导出 e2e-transfer@example.test",
    exact: true,
  });
  await dialog.getByRole("button", { name: "生成导出内容" }).click();
  await expect(dialog.getByLabel("导出预览")).toHaveValue(
    /e2e-transfer@example.test/,
  );
  await fits(page);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(drawer).toBeVisible();
  await drawer
    .getByRole("button", { name: "关闭平台详情", exact: true })
    .click();

  await page.request.post("/api/platforms", {
    data: { name: "E2E Destination" },
  });
  await page.getByRole("button", { name: "管理平台", exact: true }).click();
  await manager.getByRole("searchbox").fill("E2E Renamed");
  await manager.getByRole("button", { name: "E2E Renamed 平台操作" }).click();
  await expect(
    page.getByRole("menuitem", { name: "删除平台", exact: true }),
  ).toBeDisabled();
  await page.getByRole("menuitem", { name: "合并平台", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "合并 E2E Renamed", exact: true });
  await dialog.getByRole("combobox").click();
  await page
    .getByRole("option", { name: "E2E Destination · 0 个账号", exact: true })
    .click();
  await dialog.getByRole("checkbox").check();
  await fits(page);
  await dialog.getByRole("button", { name: "确认合并平台" }).click();
  await expect(dialog).toHaveCount(0);
  const moved = await (
    await page.request.get("/api/vault?platform=E2E%20Destination")
  ).json();
  expect(moved.total).toBe(1);
  const detail = await (
    await page.request.get(`/api/vault/${moved.data[0].id}`)
  ).json();
  expect(detail.data.password).toBe("safe----password");
  await manager.getByRole("button", { name: "新建平台", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "新建平台", exact: true });
  await dialog.getByLabel("平台名称", { exact: true }).fill("E2E Delete Empty");
  await dialog.getByRole("button", { name: "保存平台" }).click();
  await manager.getByRole("searchbox").fill("E2E Delete Empty");
  await manager
    .getByRole("button", { name: "E2E Delete Empty 平台操作" })
    .click();
  await page.getByRole("menuitem", { name: "删除平台", exact: true }).click();
  const confirm = page.getByRole("alertdialog");
  await confirm.getByRole("button", { name: "确认操作", exact: true }).click();
  await expect(
    manager.getByRole("button", { name: "E2E Delete Empty 平台操作" }),
  ).toHaveCount(0);
  await manager.getByRole("searchbox").fill("E2E Destination");
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("mobile-platform-manager.png"),
  });
  await fits(page);
  expect(
    (
      await new AxeBuilder({ page })
        .include('[role="dialog"][data-state="open"]')
        .withTags(["wcag2a", "wcag2aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await manager.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.getByText("平台已删除", { exact: true })).toHaveCount(0);
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  expect(errors).toEqual([]);
});

test("Outlook individual, selected and filtered exports show fixed text, CSV and JSON dialogs", async ({
  page,
  context,
}, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  await page.goto("/#outlook");
  await page.getByRole("searchbox").fill("workspace@outlook.com");
  const row = page
    .getByRole("row")
    .filter({ hasText: "workspace@outlook.com" });
  await row.getByRole("button", { name: "workspace@outlook.com 操作" }).click();
  await page.getByRole("menuitem", { name: "导出账号 / 复制配置" }).click();
  const dialog = page.getByRole("dialog").last();
  await dialog
    .getByRole("button", { name: "生成导出内容", exact: true })
    .click();
  await expect(dialog.getByLabel("导出预览")).toHaveValue(
    /email----password----client_id----refresh_token/,
  );
  await dialog.getByRole("button", { name: "复制内容" }).click();
  const exported = await page.evaluate(() => navigator.clipboard.readText());
  expect(exported).toContain("workspace@outlook.com");
  const parsed = await (
    await page.request.post("/api/outlook/parse-preview", {
      data: { raw_text: exported },
    })
  ).json();
  expect(parsed.valid_count).toBe(1);
  expect(parsed.error_count).toBe(0);
  await dialog.getByRole("combobox").click();
  await page
    .getByRole("option", { name: "CSV（带字段表头）", exact: true })
    .click();
  await expect(dialog.getByLabel("导出预览")).toHaveValue(
    /email,password,client_id,refresh_token/,
  );
  await dialog.getByRole("combobox").click();
  await page
    .getByRole("option", {
      name: "JSON（保留接口返回的全部字段）",
      exact: true,
    })
    .click();
  expect(
    JSON.parse(await dialog.getByLabel("导出预览").inputValue()).accounts,
  ).toHaveLength(1);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await row.getByRole("checkbox").check();
  await page.getByRole("button", { name: "批量操作", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "导出所选账号", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "生成导出内容", exact: true })
    .click();
  await expect(dialog.getByText("1 个账号", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "导出账号", exact: true }).click();
  await dialog
    .getByRole("button", { name: "生成导出内容", exact: true })
    .click();
  await expect(dialog.getByText("1 个账号", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await fits(page);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("mobile-outlook-export.png"),
  });
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 844, height: 390 },
    { width: 1440, height: 1000 },
  ]) {
    await page.setViewportSize(viewport);
    await fits(page);
    await expect(
      dialog.getByRole("button", { name: "复制内容", exact: true }),
    ).toBeInViewport();
  }
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("desktop-outlook-export.png"),
  });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "切换深色主题" }).click();
  await page.setViewportSize({ width: 375, height: 667 });
  await page.getByRole("button", { name: "批量导入", exact: true }).click();
  await fits(page);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("mobile-outlook-import.png"),
  });
});
