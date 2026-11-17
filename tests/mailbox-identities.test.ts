import assert from "node:assert/strict";
import test from "node:test";
import { database } from "./helpers";
import { db, insert } from "../src/storage/client";

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
    const identity = inventory.data.data.find((r: any) => r.address === "shared@example.test");
    assert.equal(identity.platform_count, 3);
    const rows = await f.request(`/api/mailbox-identities/${encodeURIComponent(identity.id)}/registrations?limit=2`);
    assert.equal(rows.data.total, 3);
    assert.equal(rows.data.data.length, 2);
    assert.equal(JSON.stringify(rows.data).includes("private-password"), false);
  } finally { await f.dispose(); }
});

test("platform matching rejects an unrelated newer code and detached mailbox access", async () => {
  const f = await database();
  try {
    const created = await f.request("/api/vault", {
      platform_name: "Alpha", account_email: "shared@example.test", email_source: "cf_domain",
      verification_sender: "alpha@sender.test",
    });
    const id = created.data.data.id;
    await db(f.env).mutate([
      insert("cf_inbox_mails", {recipient:"shared@example.test", sender:"alpha@sender.test", subject:"Your verification code is 123456", verification_code:"123456", created_at:"2026-11-17T10:00:00Z"}),
      insert("cf_inbox_mails", {recipient:"shared@example.test", sender:"beta@sender.test", subject:"Your verification code is 987654", verification_code:"987654", created_at:"2026-11-17T11:00:00Z"}),
    ]);
    const platform = await f.request(`/api/vault/${id}/code?match=platform`);
    assert.equal(platform.data.data.code, "123456");
    assert.equal(platform.data.data.match_scope, "platform");
    const mailbox = await f.request(`/api/vault/${id}/code?match=mailbox`);
    assert.equal(mailbox.data.data.code, "987654");
    assert.equal((await f.request(`/api/vault/${id}`)).data.data.last_code, "123456");
    await f.request(`/api/vault/${id}`, {mailbox_link_state:"detached"}, "PUT");
    assert.equal((await f.request(`/api/vault/${id}/code?match=platform`)).response.status, 409);
  } finally { await f.dispose(); }
});

test("platform mode requires a rule; alias delivery is explicit and source identities stay separate", async () => {
  const f = await database();
  try {
    const first = await f.request("/api/vault", {
      platform_name:"Alias Platform", account_email:"alias@example.test", mailbox_address:"delivery@example.test",
      email_source:"cf_domain", login_methods:'["magic_link"]',
    });
    assert.equal((await f.request(`/api/vault/${first.data.data.id}/code?match=platform`)).response.status, 409);
    await f.request("/api/vault", {platform_name:"Other Source",account_email:"delivery@example.test",email_source:"external"});
    const inventory = await f.request("/api/mailbox-identities");
    assert.equal(inventory.response.status, 200);
    const identities = inventory.data.data.filter((r: any) => r.address === "delivery@example.test");
    assert.equal(identities.length, 2);
    assert.notEqual(identities[0].id, identities[1].id);
  } finally { await f.dispose(); }
});
