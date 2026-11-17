import { and, collect, db, eq, oneOf, or, type Filter } from "./storage/client";
import type { Env } from "./types";
import { deliveryAddress } from "../shared/registrations";
export async function cleanMail(env: Env, days?: number) {
  const store = db(env);
  const [boxes, vaults] = await Promise.all([
    collect(store, "temp_mailboxes", {
      columns: ["address", "is_permanent", "expires_at"],
    }),
    collect(store, "platform_vault", {
      where: eq("email_source", "cf_domain"),
      columns: ["account_email", "mailbox_address"],
    }),
  ]);
  const protectedAddresses = [
    ...new Set([
      ...boxes.filter((b) => b.is_permanent).map((b) => b.address),
      ...vaults.map((v) =>
        deliveryAddress(
          v as { account_email: string; mailbox_address?: string },
        ),
      ),
    ]),
  ];
  const expiredAddresses = boxes
    .filter(
      (b) =>
        !b.is_permanent &&
        b.expires_at &&
        Date.parse(String(b.expires_at)) <= Date.now(),
    )
    .map((b) => b.address);
  const age: Filter | undefined =
    days === undefined
      ? undefined
      : or(
          {
            field: "created_at",
            op: "dateLt",
            value: new Date(Date.now() - days * 86400000).toISOString(),
          },
          oneOf("recipient", expiredAddresses),
        );
  let total = 0;
  for (let batch = 0; batch < 20; batch++) {
    const rows = await store.select("cf_inbox_mails", {
      where: and(
        eq("is_pinned", 0),
        eq("is_protected", 0),
        { not: oneOf("recipient", protectedAddresses) },
        age,
      ),
      columns: ["id"],
      limit: 200,
    });
    if (!rows.length) break;
    const [deleted] = await store.mutate([
      { op: "cleanMail", ids: rows.map((r) => Number(r.id)) },
    ]);
    total += deleted.changes;
  }
  return total;
}
