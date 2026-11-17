/** Additive registration metadata. Empty dates mean unknown, never inferred. */
export const registrationDefaults = {
  workspace: "",
  account_identifier: "",
  login_methods: '["unknown"]',
  mailbox_address: "",
  mailbox_link_state: "auto",
  verification_sender: "",
  verification_keyword: "",
  registered_at: "",
  last_verified_at: "",
  expires_at: "",
} as const;
export type RegistrationMetadata = {
  [K in keyof typeof registrationDefaults]: string;
};
export function deliveryAddress(row: {
  account_email: string;
  mailbox_address?: string;
}) {
  return (row.mailbox_address || row.account_email).trim().toLowerCase();
}
