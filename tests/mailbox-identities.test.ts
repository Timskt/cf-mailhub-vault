import assert from "node:assert/strict";
import test from "node:test";
import { database } from "./helpers";
import { db, eq, insert, update } from "../src/storage/client";
import { updateVaultCode } from "../src/codes";
import type { PlatformAccount } from "../src/types";

test("one mailbox exposes all independent platform registrations and safe metadata", async () => {
  const f = await database();
  try {
    for (const platform of ["Alpha", "Beta", "Gamma"]) {
      const created = await f.request("/api/vault", {
        platform_name: platform,
        account_email: "shared@example.test",
        email_source: "cf_domain",
        password: `${platform}-private-password`,
        workspace: "personal",
        login_methods: '["password","microsoft"]',
        verification_sender: `${platform.toLowerCase()}@sender.test`,
      });
      assert.equal(created.response.status, 200);
      const detail = await f.request(`/api/vault/${created.data.data.id}`);
      assert.equal(detail.data.data.workspace, "personal");
    }
    const inventory = await f.request("/api/mailbox-identities");
    assert.equal(inventory.response.status, 200);
    assert.equal(inventory.data.summary.total_registrations, 3);
    assert.equal(inventory.data.summary.unique_addresses, 1);
    const identity = inventory.data.data.find(
      (r: any) => r.address === "shared@example.test",
    );
    assert.equal(identity.platform_count, 3);
    const rows = await f.request(
      `/api/mailbox-identities/${encodeURIComponent(identity.id)}/registrations?limit=2`,
    );
    assert.equal(rows.data.total, 3);
    assert.equal(rows.data.data.length, 2);
    assert.equal(JSON.stringify(rows.data).includes("private-password"), false);
  } finally {
    await f.dispose();
  }
});

test("platform matching rejects an unrelated newer code and detached mailbox access", async () => {
  const f = await database();
  try {
    const created = await f.request("/api/vault", {
      platform_name: "Alpha",
      account_email: "shared@example.test",
      email_source: "cf_domain",
      verification_sender: "alpha@sender.test",
    });
    const id = created.data.data.id;
    await db(f.env).mutate([
      insert("cf_inbox_mails", {
        recipient: "shared@example.test",
        sender: "alpha@sender.test",
        subject: "Your verification code is 123456",
        verification_code: "123456",
        created_at: "2026-11-17T10:00:00Z",
      }),
      insert("cf_inbox_mails", {
        recipient: "shared@example.test",
        sender: "beta@sender.test",
        subject: "Your verification code is 987654",
        verification_code: "987654",
        created_at: "2026-11-17T11:00:00Z",
      }),
    ]);
    const platform = await f.request(`/api/vault/${id}/code?match=platform`);
    assert.equal(platform.data.data.code, "123456");
    assert.equal(platform.data.data.match_scope, "platform");
    const mailbox = await f.request(`/api/vault/${id}/code?match=mailbox`);
    assert.equal(mailbox.data.data.code, "987654");
    assert.equal(
      (await f.request(`/api/vault/${id}`)).data.data.last_code,
      "123456",
    );
    await f.request(
      `/api/vault/${id}`,
      { mailbox_link_state: "detached" },
      "PUT",
    );
    assert.equal(
      (await f.request(`/api/vault/${id}/code?match=platform`)).response.status,
      409,
    );
  } finally {
    await f.dispose();
  }
});

test("platform mode requires a rule; alias delivery is explicit and source identities stay separate", async () => {
  const f = await database();
  try {
    const first = await f.request("/api/vault", {
      platform_name: "Alias Platform",
      account_email: "alias@example.test",
      mailbox_address: "delivery@example.test",
      email_source: "cf_domain",
      login_methods: '["magic_link"]',
    });
    assert.equal(
      (await f.request(`/api/vault/${first.data.data.id}/code?match=platform`))
        .response.status,
      409,
    );
    await f.request("/api/vault", {
      platform_name: "Other Source",
      account_email: "delivery@example.test",
      email_source: "external",
    });
    const inventory = await f.request("/api/mailbox-identities");
    assert.equal(inventory.response.status, 200);
    const identities = inventory.data.data.filter(
      (r: any) => r.address === "delivery@example.test",
    );
    assert.equal(identities.length, 2);
    assert.notEqual(identities[0].id, identities[1].id);
  } finally {
    await f.dispose();
  }
});

test("editing a shared registration preserves a valid manual mailbox representative", async () => {
  const f = await database();
  try {
    const payload = {
      account_email: "login@example.test",
      mailbox_address: "shared@example.test",
      email_source: "cf_domain",
    };
    const first = await f.request("/api/vault", {
      ...payload,
      platform_name: "First",
    });
    const second = await f.request("/api/vault", {
      ...payload,
      platform_name: "Second",
    });
    const box = (await db(f.env).select("temp_mailboxes"))[0];
    await f.request(`/api/mailboxes/${box.id}/link-vault`, {
      vault_id: second.data.data.id,
    });
    assert.equal(
      (
        await f.request(
          `/api/vault/${first.data.data.id}`,
          { remark: "updated only" },
          "PUT",
        )
      ).response.status,
      200,
    );
    assert.equal(
      (await db(f.env).select("temp_mailboxes"))[0].associated_vault_id,
      second.data.data.id,
    );
    await f.request(`/api/vault/${second.data.data.id}`, undefined, "DELETE");
    assert.equal(
      (await db(f.env).select("temp_mailboxes"))[0].associated_vault_id,
      first.data.data.id,
    );
  } finally {
    await f.dispose();
  }
});

test("legacy platform lookup follows explicit aliases and respects detachment", async () => {
  const f = await database();
  try {
    const created = await f.request("/api/vault", {
      platform_name: "Legacy Alias",
      account_email: "login@example.test",
      mailbox_address: "delivery@example.test",
      email_source: "cf_domain",
    });
    await db(f.env).mutate([
      insert("cf_inbox_mails", {
        recipient: "login@example.test",
        verification_code: "111111",
      }),
      insert("cf_inbox_mails", {
        recipient: "delivery@example.test",
        verification_code: "222222",
      }),
    ]);
    const result = await f.request(
      "/api/external/code?platform=Legacy%20Alias",
    );
    assert.equal(result.data.code, "222222");
    await f.request(
      `/api/vault/${created.data.data.id}`,
      { mailbox_link_state: "detached" },
      "PUT",
    );
    assert.equal(
      (await f.request("/api/external/code?platform=Legacy%20Alias")).response
        .status,
      409,
    );
    // Explicit email remains a mailbox query and has no registration context.
    assert.equal(
      (
        await f.request(
          "/api/external/code?email=delivery@example.test&source=cf_domain",
        )
      ).data.code,
      "222222",
    );
  } finally {
    await f.dispose();
  }
});

test("a completed verification cannot write stale history after the registration changes", async () => {
  const f = await database();
  try {
    const created = await f.request("/api/vault", {
      platform_name: "In Flight",
      account_email: "old@example.test",
      email_source: "cf_domain",
      verification_sender: "auth@example.test",
    });
    const id = created.data.data.id;
    const snapshot = (await db(f.env).first<PlatformAccount>(
      "platform_vault",
      eq("id", id),
    ))!;
    await f.request(
      `/api/vault/${id}`,
      { mailbox_address: "new@example.test" },
      "PUT",
    );
    await assert.rejects(
      updateVaultCode(f.env, snapshot, {
        has_mail: true,
        code: "123456",
        link: "",
        scanned: 1,
      }),
      /变化|重新/,
    );
    assert.equal((await f.request(`/api/vault/${id}`)).data.data.last_code, "");
  } finally {
    await f.dispose();
  }
});

test("restored login methods keep their raw CAS identity while imports use canonical matching", async () => {
  const f = await database();
  try {
    const created = await f.request("/api/vault", {
      platform_name: "Restored",
      account_email: "restored@example.test",
      email_source: "external",
      login_methods: '["google","password"]',
      password: "private-password",
    });
    const id = created.data.data.id;
    await db(f.env).mutate([
      update("platform_vault", eq("id", id), {
        login_methods: '[ "password", "google" ]',
      }),
    ]);
    const edit = await f.request(
      `/api/vault/${id}`,
      { remark: "edited" },
      "PUT",
    );
    assert.equal(edit.response.status, 200, JSON.stringify(edit.data));
    await db(f.env).mutate([
      update("platform_vault", eq("id", id), {
        login_methods: '[ "password", "google" ]',
      }),
    ]);
    const imported = await f.request("/api/vault/import", {
      accounts: [
        {
          platform_name: "Restored",
          account_email: "restored@example.test",
          email_source: "external",
          login_methods: '["google","password"]',
          remark: "imported",
        },
      ],
      duplicate_mode: "update",
    });
    assert.equal(imported.response.status, 200, JSON.stringify(imported.data));
    assert.equal(imported.data.updated, 1);
    assert.equal(
      (await f.request(`/api/vault/${id}`)).data.data.password,
      "private-password",
    );
  } finally {
    await f.dispose();
  }
});

test("expired CF identities expose their lifecycle state even when the domain is configured", async () => {
  const f = await database();
  try {
    await db(f.env).mutate([
      insert("temp_mailboxes", {
        address: "expired@example.test",
        expires_at: "2000-01-01T00:00:00.000Z",
        is_permanent: 0,
      }),
    ]);
    const result = await f.request(
      `/api/mailbox-identities/${encodeURIComponent("cf_domain:expired@example.test")}`,
    );
    assert.equal(result.data.data.health.state, "disabled");
    assert.equal(result.data.data.health.needs_attention, true);
    assert.match(result.data.data.health.label, /过期|停用/);
  } finally {
    await f.dispose();
  }
});
