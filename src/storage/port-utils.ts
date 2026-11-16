import {
  StorageError,
  rowKey,
  type Revision,
  type Row,
  type Table,
  type Page,
} from "./model";
export interface Meta extends Revision {
  owner: string;
}
export const check = (meta: Meta | null | undefined, owner: string) => {
  if (!meta) throw new StorageError("DATASET_MISSING", "Dataset missing", 404);
  if (meta.owner !== owner)
    throw new StorageError(
      "OWNER_CONFLICT",
      "Dataset owned by another controller",
      409,
    );
  return meta;
};
export function revision(meta: Revision): Revision {
  return { version: meta.version, hash: meta.hash, counters: meta.counters };
}
export function pageRows(rows: Row[], table: Table, limit: number): Page {
  const selected: Row[] = [];
  let size = 0;
  for (const row of rows.slice(0, limit)) {
    size += JSON.stringify(row).length;
    if (selected.length && size > 1500000) break;
    selected.push(row);
  }
  return {
    rows: selected,
    cursor:
      rows.length > selected.length
        ? rowKey(table, selected[selected.length - 1])
        : null,
  };
}
