import { and, eq, or, type Filter } from "./storage/model";
export { deliveryAddress } from "../shared/registrations";
export function mailboxReferenceFilter(address: string): Filter {
  return or(
    { field: "mailbox_address", op: "ieq", value: address },
    and(eq("mailbox_address", ""), {
      field: "account_email",
      op: "ieq",
      value: address,
    }),
  );
}
