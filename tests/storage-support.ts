import type { ControlStorage } from "../src/storage/coordinator";
export class MemoryControl implements ControlStorage {
  data = new Map<string, unknown>();
  alarms: number[] = [];
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async atomic(entries: Record<string, unknown>, remove: string[] = []) {
    for (const key of remove) this.data.delete(key);
    for (const [key, value] of Object.entries(entries))
      this.data.set(key, structuredClone(value));
  }
  async schedule(delay: number) {
    this.alarms.push(delay);
  }
  async logsBefore(version: number, limit: number) {
    return [...this.data.keys()]
      .filter(
        (k) =>
          k.startsWith("log:") &&
          k < `log:${String(version).padStart(16, "0")}`,
      )
      .sort()
      .slice(0, limit);
  }
}
