export const passwordGroups = {
  lowercase: "abcdefghijklmnopqrstuvwxyz",
  uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digits: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{};:,.?/~|",
} as const;

export type PasswordOptions = {
  length: number;
  lowercase: boolean;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
  excludeAmbiguous: boolean;
};
export const defaultPasswordOptions: PasswordOptions = {
  length: 20,
  lowercase: true,
  uppercase: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: false,
};

/** Uniform sampling over passwords satisfying the chosen alphabet and group constraints. */
export function generatePassword(input: Partial<PasswordOptions> = {}) {
  const options = { ...defaultPasswordOptions, ...input };
  if (
    !Number.isInteger(options.length) ||
    options.length < 8 ||
    options.length > 128
  )
    throw new Error("密码长度必须是 8–128 的整数。");
  for (const key of [
    ...Object.keys(passwordGroups),
    "excludeAmbiguous",
  ] as const)
    if (typeof options[key as keyof PasswordOptions] !== "boolean")
      throw new Error("请选择有效的密码字符组选项。");
  const groups = (
    Object.keys(passwordGroups) as (keyof typeof passwordGroups)[]
  )
    .filter((key) => options[key])
    .map((key) =>
      options.excludeAmbiguous
        ? passwordGroups[key].replace(/[Il1O0o|]/g, "")
        : passwordGroups[key],
    );
  if (!groups.length) throw new Error("请至少选择一种字符组。");
  if (!globalThis.crypto?.getRandomValues)
    throw new Error("安全随机数不可用，无法生成密码。");
  const alphabet = groups.join("");
  const ceiling = 256 - (256 % alphabet.length);
  const random = new Uint8Array(256);
  let cursor = random.length,
    refills = 0;
  try {
    // Rejection of a whole candidate keeps distribution uniform even when every group is required.
    for (let attempt = 0; attempt < 1024; attempt++) {
      let password = "";
      while (password.length < options.length) {
        if (cursor === random.length) {
          if (++refills > 4096)
            throw new Error("安全随机数未能生成有效密码，请重试。");
          try {
            crypto.getRandomValues(random);
          } catch {
            throw new Error("安全随机数不可用，无法生成密码。");
          }
          cursor = 0;
        }
        const byte = random[cursor++];
        if (byte < ceiling) password += alphabet[byte % alphabet.length];
      }
      if (
        groups.every((group) =>
          [...password].some((char) => group.includes(char)),
        )
      )
        return password;
    }
    throw new Error("安全随机数未能生成满足字符组要求的密码，请重试。");
  } finally {
    random.fill(0);
  }
}
