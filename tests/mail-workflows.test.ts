import { test } from "node:test";
import assert from "node:assert/strict";
import { database } from "./helpers";
import { handleIncomingEmail } from "../src/email-handler";
import {
  classifyMail,
  organizeIncoming,
  validateRule,
} from "../src/mail-workflows";
import { D1Port } from "../src/storage/d1";
import {
  eq,
  defaults,
  insert,
  update,
  and,
  StorageError,
} from "../src/storage/model";
import { DirectStore } from "../src/storage/engine";

test("classification is conservative; first enabled rule wins and conditions are literal AND matches", () => {
  assert.equal(
    classifyMail({ subject: "Your invoice", verification_code: "567890" }),
    "verification",
  );
  assert.equal(
    classifyMail({ subject: "Your invoice for November" }),
    "billing",
  );
  assert.equal(classifyMail({ subject: "Weekly roundup" }), "newsletter");
  assert.equal(classifyMail({ subject: "hello" }), "general");
  const high = {
    ...validateRule({
      name: "Priority",
      sender_contains: "auth+",
      domain: "example.test",
      pin: true,
    }),
    id: 2,
    priority: 1,
  };
  const low = {
    ...validateRule({ name: "Archive", domain: "example.test", archive: true }),
    id: 1,
    priority: 100,
  };
  const mail = {
    sender: "auth+tag@sender.test",
    recipient: "u@example.test",
    subject: "hello",
  };
  assert.deepEqual(organizeIncoming(mail, [low, high]), {
    category: "general",
    rule_name: "Priority",
    is_pinned: 1,
  });
  assert.equal(
    organizeIncoming({ ...mail, sender: "auth@sender.test" }, [low, high])
      .rule_name,
    "Archive",
  );
  assert.equal(
    organizeIncoming(mail, [{ ...high, enabled: 0 }, low]).rule_name,
    "Archive",
  );
  assert.throws(
    () => validateRule({ name: "All", archive: true }),
    /至少设置一个/,
  );
  assert.throws(
    () => validateRule({ name: "None", domain: "example.test" }),
    /至少选择一个/,
  );
});
test("rule preview is read-only, apply is limited to reviewed matching IDs and rejects changed or disabled rules", async () => {
  const f = await database();
  try {
    await f.DB.prepare(
      "INSERT INTO cf_inbox_mails(recipient,sender,subject) VALUES('a@example.test','news@sender.test','Digest'),('b@example.test','other@sender.test','Hello')",
    ).run();
    const input = {
      name: "News",
      sender_contains: "news@",
      archive: true,
      mark_read: true,
      action_category: "newsletter",
    };
    const created = await f.request("/api/mail-rules", input),
      id = created.data.data.id;
    const preview = await f.request(`/api/mail-rules/${id}/preview`, {});
    assert.equal(preview.data.data.total, 1);
    assert.equal(
      (
        await f.DB.prepare(
          "SELECT is_read FROM cf_inbox_mails WHERE id=1",
        ).first<any>()
      ).is_read,
      0,
    );
    const apply = await f.request(`/api/mail-rules/${id}/apply`, {
      ids: [1, 2],
      revision: preview.data.data.revision,
    });
    assert.equal(apply.data.data.changed, 1);
    const archived = await f.request(
      "/api/cf-mails?folder=archived&category=newsletter",
    );
    assert.equal(archived.data.total, 1);
    assert.equal(archived.data.data[0].rule_name, "News");
    const inbox = await f.request("/api/cf-mails?folder=inbox");
    assert.equal(inbox.data.total, 1);
    assert.equal(inbox.data.data[0].is_read, 0);
    await f.request(
      `/api/mail-rules/${id}`,
      { ...input, name: "Changed" },
      "PUT",
    );
    assert.equal(
      (
        await f.request(`/api/mail-rules/${id}/apply`, {
          ids: [1],
          revision: preview.data.data.revision,
        })
      ).response.status,
      409,
    );
    await f.request(
      `/api/mail-rules/${id}`,
      { ...input, enabled: false },
      "PUT",
    );
    const disabled = await f.request(`/api/mail-rules/${id}/preview`, {});
    assert.equal(
      (
        await f.request(`/api/mail-rules/${id}/apply`, {
          ids: [1],
          revision: disabled.data.data.revision,
        })
      ).response.status,
      400,
    );
    await f.request(`/api/mail-rules/${id}`, undefined, "DELETE");
    assert.equal(
      (await f.request("/api/cf-mails?folder=archived")).data.total,
      1,
    );
  } finally {
    await f.dispose();
  }
});
test("real MIME ingestion applies rules once; duplicate delivery preserves later manual choices", async () => {
  const f = await database();
  try {
    await f.request("/api/mail-rules", {
      name: "Keep receipts",
      subject_contains: "Invoice",
      pin: true,
      archive: true,
    });
    const raw =
      "From: Billing <billing@sender.test>\r\nTo: invoice@example.test\r\nMessage-ID: <invoice@sender.test>\r\nSubject: Invoice #2026\r\nContent-Type: text/plain\r\n\r\nYour payment receipt.";
    const deliver = () =>
      handleIncomingEmail(
        {
          to: "invoice@example.test",
          from: "billing@sender.test",
          raw: new Blob([raw]).stream(),
          rawSize: raw.length,
          headers: new Headers(),
          setReject: assert.fail,
        } as unknown as ForwardableEmailMessage,
        f.env,
      );
    await deliver();
    let row = await f.DB.prepare("SELECT * FROM cf_inbox_mails").first<any>();
    assert.equal(row.category, "billing");
    assert.equal(row.is_archived, 1);
    assert.equal(row.is_pinned, 1);
    await f.request(
      `/api/cf-mails/${row.id}`,
      { is_archived: false, is_pinned: false },
      "PATCH",
    );
    await deliver();
    row = await f.DB.prepare("SELECT * FROM cf_inbox_mails").first<any>();
    assert.equal(row.is_archived, 0);
    assert.equal(row.is_pinned, 0);
    assert.equal((await f.request("/api/cf-mails")).data.total, 1);
  } finally {
    await f.dispose();
  }
});
test("bulk mail changes are reversible and do not reset unrelated flags; boundaries reject empty, oversized and unknown patches", async () => {
  const f = await database();
  try {
    await f.DB.prepare(
      "INSERT INTO cf_inbox_mails(recipient,sender,is_pinned) VALUES('a@example.test','sender@test.test',1)",
    ).run();
    assert.equal(
      (
        await f.request("/api/cf-mails/batch", {
          ids: [1],
          patch: { is_read: true, is_archived: true },
        })
      ).data.data.changed,
      1,
    );
    await f.request(
      "/api/cf-mails/1",
      { is_archived: false, is_read: false, category: "billing" },
      "PATCH",
    );
    const row = (await f.request("/api/cf-mails?folder=inbox")).data.data[0];
    assert.equal(row.is_pinned, 1);
    assert.equal(row.is_read, 0);
    assert.equal(row.category, "billing");
    for (const body of [
      { ids: [], patch: { is_read: true } },
      { ids: Array(101).fill(1), patch: {} },
      { ids: [1], patch: { subject: "replace" } },
      { ids: [1], patch: { is_read: "true" } },
    ])
      assert.equal(
        (await f.request("/api/cf-mails/batch", body)).response.status,
        400,
      );
    assert.equal(
      (await f.request("/api/cf-mails/999", { is_read: true }, "PATCH"))
        .response.status,
      404,
    );
  } finally {
    await f.dispose();
  }
});
test("cross-domain allocation previews without writing, validates whole batch, and stores purpose and usage", async () => {
  const f = await database();
  try {
    const preview = await f.request("/api/mailboxes/batch-preview", {
      domains: ["example.test", "mail.example.test"],
      count: 5,
      prefix: "shopping",
      remark: "购物用途",
      is_permanent: true,
    });
    const rows = preview.data.data;
    assert.equal(rows.length, 5);
    assert.equal(
      rows.filter((r: any) => r.domain === "example.test").length,
      3,
    );
    assert.equal((await f.request("/api/mailboxes")).data.total, 0);
    assert.equal(
      (
        await f.request("/api/mailboxes/batch", {
          mailboxes: [...rows, { ...rows[0], domain: "invalid.test" }],
        })
      ).response.status,
      400,
    );
    assert.equal((await f.request("/api/mailboxes")).data.total, 0);
    const created = await f.request("/api/mailboxes/batch", {
      mailboxes: rows,
    });
    assert.equal(created.data.data.length, 5);
    const box = created.data.data[0];
    assert.equal(box.remark, "购物用途");
    assert.equal(box.is_permanent, 1);
    assert.equal(
      (
        await f.request("/api/mailboxes/batch", {
          mailboxes: [{ ...rows[0], prefix: "not-created" }, rows[1]],
        })
      ).response.status,
      400,
    );
    assert.equal((await f.request("/api/mailboxes")).data.total, 5);
    await f.request(
      `/api/mailboxes/${box.id}`,
      { remark: "已分配商店 A" },
      "PATCH",
    );
    await f.DB.prepare(
      "INSERT INTO cf_inbox_mails(recipient,sender) VALUES(?, 'sender@sender.test')",
    )
      .bind(box.address)
      .run();
    const usage = (
      await f.request(`/api/mailboxes?q=${encodeURIComponent(box.address)}`)
    ).data.data[0];
    assert.equal(usage.unread_count, 1);
    assert.equal(usage.mail_count, 1);
    assert.ok(usage.last_received_at);
    assert.equal(usage.remark, "已分配商店 A");
  } finally {
    await f.dispose();
  }
});
test("older portable D1 rows get query-compatible folder defaults without altering snapshot contents", async () => {
  const f = await database();
  try {
    const port = new D1Port(f.DB, "old-generation");
    await port.initialize({ version: 0, hash: "", counters: {} });
    const old = {
      ...defaults("cf_inbox_mails"),
      id: 1,
      recipient: "old@example.test",
      subject: "Old content",
    };
    delete old.category;
    delete old.is_archived;
    delete old.rule_name;
    await port.copy("cf_inbox_mails", [old]);
    assert.equal(await port.count("cf_inbox_mails", eq("is_archived", 0)), 1);
    assert.equal(
      (
        await port.find("cf_inbox_mails", { where: eq("category", "general") })
      )[0].is_archived,
      0,
    );
    assert.equal(
      (
        await port.find("cf_inbox_mails", {
          columns: ["category", "is_archived"],
        })
      )[0].is_archived,
      0,
    );
    assert.deepEqual((await port.page("cf_inbox_mails")).rows, [old]);
  } finally {
    await f.dispose();
  }
});
test("review guards are checked inside the mail transaction and never leave partial changes", async () => {
  const f = await database();
  try {
    const store = new DirectStore(new D1Port(f.DB));
    await store.mutate([
      insert("mail_rules", {
        id: 1,
        name: "Changed rule",
        domain: "example.test",
        archive: 1,
      }),
      insert("cf_inbox_mails", { id: 1, recipient: "u@example.test" }),
    ]);
    await assert.rejects(
      store.mutate([
        update("cf_inbox_mails", eq("id", 1), { is_read: 1 }),
        {
          op: "assertExists",
          table: "mail_rules",
          where: and(eq("id", 1), eq("name", "Old preview")),
        },
      ]),
      (e: unknown) => e instanceof StorageError && e.code === "STALE_PREVIEW",
    );
    assert.equal(
      (await store.first("cf_inbox_mails", eq("id", 1)))?.is_read,
      0,
    );
    const input = {
      mailboxes: [
        { domain: "example.test", prefix: "concurrent", is_permanent: true },
      ],
    };
    const responses = await Promise.all([
      f.request("/api/mailboxes/batch", input),
      f.request("/api/mailboxes/batch", input),
    ]);
    assert.equal(responses.filter((r) => r.response.ok).length, 1);
    assert.equal(await store.count("temp_mailboxes"), 1);
  } finally {
    await f.dispose();
  }
});
test("historical preview is capped at 100 and new workflows enforce authentication", async () => {
  const f = await database();
  try {
    const store = new DirectStore(new D1Port(f.DB));
    await store.mutate([
      {
        op: "insert",
        table: "cf_inbox_mails",
        rows: Array.from({ length: 101 }, (_, i) => ({
          recipient: "u@example.test",
          sender: "news@sender.test",
          subject: `Message ${i}`,
        })),
      },
    ]);
    const preview = await f.request("/api/mail-rules/preview", {
      name: "News",
      sender_contains: "news@",
      archive: true,
    });
    assert.equal(preview.data.data.total, 101);
    assert.equal(preview.data.data.mails.length, 100);
    assert.equal(preview.data.data.limited, true);
    for (const path of [
      "/api/mail-rules/preview",
      "/api/mailboxes/batch-preview",
      "/api/mailboxes/batch",
      "/api/cf-mails/batch",
    ])
      assert.equal(
        (await f.request(path, {}, "POST", {})).response.status,
        401,
      );
  } finally {
    await f.dispose();
  }
});
