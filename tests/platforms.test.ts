import assert from "node:assert/strict";
import test from "node:test";
import { database } from "./helpers";

test("platforms can exist without accounts and remain after the last account is deleted", async () => {
  const f = await database();
  try {
    const created = await f.request("/api/platforms", {
      name: "Research",
      url: "https://example.test",
      category: "工具",
      remark: "先建平台",
    });
    assert.equal(created.response.status, 200);
    const list = await f.request("/api/vault/platforms");
    assert.equal(
      list.data.data.find((p: any) => p.platform_name === "Research").count,
      0,
    );
    assert.equal(
      (await f.request("/api/vault/stats")).data.data.total_platforms,
      1,
    );
    const account = await f.request("/api/vault", {
      platform_name: "Research",
      account_email: "user@example.test",
      email_source: "external",
    });
    await f.request(`/api/vault/${account.data.data.id}`, undefined, "DELETE");
    assert.equal(
      (await f.request("/api/platforms")).data.data[0].account_count,
      0,
    );
    assert.equal(
      (await f.request("/api/platforms/Research", undefined, "DELETE")).response
        .status,
      200,
    );
    assert.equal((await f.request("/api/platforms")).data.data.length, 0);
  } finally {
    await f.dispose();
  }
});

test("rename and merge preserve credentials and update mailbox links; occupied deletion and duplicate names are rejected", async () => {
  const f = await database();
  try {
    const a = await f.request("/api/vault", {
      platform_name: "Before",
      account_email: "link@example.test",
      password: "kept-password",
      email_source: "cf_domain",
    });
    const id = a.data.data.id;
    assert.equal(
      (
        await f.request(
          "/api/platforms/before",
          { name: "After", url: "https://example.test", category: "服务" },
          "PUT",
        )
      ).response.status,
      200,
    );
    const detail = await f.request(`/api/vault/${id}`);
    assert.equal(detail.data.data.platform_name, "After");
    assert.equal(detail.data.data.password, "kept-password");
    assert.equal(
      (
        await f.DB.prepare(
          "SELECT associated_platform FROM temp_mailboxes WHERE address = ?",
        )
          .bind("link@example.test")
          .first<any>()
      )?.associated_platform,
      "After",
    );
    assert.equal(
      (await f.request("/api/platforms/After", undefined, "DELETE")).response
        .status,
      409,
    );
    await f.request("/api/platforms", {
      name: "Target",
      remark: "keep target",
    });
    assert.equal(
      (await f.request("/api/platforms/After", { name: "TARGET" }, "PUT"))
        .response.status,
      409,
    );
    assert.equal(
      (await f.request("/api/platforms/After/merge", { target: "Target" }))
        .response.status,
      200,
    );
    assert.equal(
      (await f.request(`/api/vault/${id}`)).data.data.platform_name,
      "Target",
    );
    assert.equal((await f.request("/api/platforms")).data.data.length, 1);
    assert.equal(
      (await f.request("/api/platforms")).data.data[0].remark,
      "keep target",
    );
    assert.equal(
      (await f.request("/api/platforms/Target/merge", { target: "target" }))
        .response.status,
      400,
    );
  } finally {
    await f.dispose();
  }
});

test("legacy platforms are adoptable and empty catalogs respect account filters", async () => {
  const f = await database();
  try {
    await f.DB.prepare(
      "INSERT INTO platform_vault(platform_name,account_email,email_source) VALUES ('Legacy','old@example.test','external')",
    ).run();
    const legacy = (await f.request("/api/platforms")).data.data[0];
    assert.equal(legacy.managed, false);
    assert.equal(
      (
        await f.request(
          "/api/platforms/legacy",
          { name: "Adopted", remark: "saved" },
          "PUT",
        )
      ).response.status,
      200,
    );
    await f.request("/api/platforms", { name: "Empty" });
    assert.equal(
      (await f.request("/api/vault/platforms?email_source=external")).data.data
        .length,
      1,
    );
    assert.equal(
      (await f.request("/api/vault/platforms?q=Empty")).data.data[0].count,
      0,
    );
    assert.equal(
      (await f.request("/api/platforms", { name: "adopted" })).response.status,
      409,
    );
    assert.equal(
      (
        await f.request("/api/platforms", {
          name: "bad",
          url: "javascript:alert(1)",
        })
      ).response.status,
      400,
    );
  } finally {
    await f.dispose();
  }
});
