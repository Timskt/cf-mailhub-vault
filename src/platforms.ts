import { collect, db, type Row } from "./storage/client";
import type { Env } from "./types";

export interface PlatformDefinition {
  name_key: string;
  name: string;
  url: string;
  category: string;
  remark: string;
  is_pinned: number;
  created_at: string;
  updated_at: string;
  account_count: number;
  managed: boolean;
}

export function platformKey(name: string) {
  return name.trim().toLowerCase();
}

export async function platformCatalog(env: Env): Promise<PlatformDefinition[]> {
  const store = db(env);
  const [catalog, accounts] = await Promise.all([
    collect<Row>(store, "platforms", { order: [["updated_at", "desc"]] }),
    collect<Row>(store, "platform_vault", {
      columns: ["platform_name", "platform_url", "category"],
      order: [["id", "asc"]],
    }),
  ]);
  const counts = new Map<string, number>();
  const legacy = new Map<string, Row>();
  for (const row of accounts) {
    const key = platformKey(String(row.platform_name || ""));
    if (key) {
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!legacy.has(key)) legacy.set(key, row);
    }
  }
  const result = new Map<string, PlatformDefinition>();
  for (const row of catalog) {
    const key = platformKey(String(row.name_key || row.name || ""));
    if (!key) continue;
    result.set(key, {
      name_key: key,
      name: String(row.name || key),
      url: String(row.url || ""),
      category: String(row.category || "其他"),
      remark: String(row.remark || ""),
      is_pinned: Number(row.is_pinned || 0),
      created_at: String(row.created_at || ""),
      updated_at: String(row.updated_at || ""),
      account_count: counts.get(key) || 0,
      managed: true,
    });
  }
  // Keep old installations and hand-created legacy rows visible until adopted.
  for (const [key, count] of counts) {
    if (!result.has(key))
      result.set(key, {
        name_key: key,
        name: String(legacy.get(key)?.platform_name || key),
        url: String(legacy.get(key)?.platform_url || ""),
        category: String(legacy.get(key)?.category || "其他"),
        remark: "",
        is_pinned: 0,
        created_at: "",
        updated_at: "",
        account_count: count,
        managed: false,
      });
  }
  return [...result.values()];
}

export function platformRow(
  name: string,
  values: Partial<
    Pick<PlatformDefinition, "url" | "category" | "remark" | "is_pinned">
  > = {},
): Row {
  const clean = name.trim();
  return {
    name_key: platformKey(clean),
    name: clean,
    url: values.url || "",
    category: values.category || "其他",
    remark: values.remark || "",
    is_pinned: values.is_pinned ? 1 : 0,
  };
}
