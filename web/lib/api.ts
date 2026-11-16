import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Reply } from "./types";

let epoch = 0;
const pending = new Set<AbortController>();
export function clearSession() {
  epoch++;
  for (const request of pending) request.abort();
  pending.clear();
}
export async function api<T = unknown>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
): Promise<Reply<T>> {
  const generation = epoch;
  const controller = new AbortController();
  pending.add(controller);
  try {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(120000),
        ...(signal ? [signal] : []),
      ]),
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
          }),
    });
    if (generation !== epoch)
      throw new DOMException("Session changed", "AbortError");
    const result = await response.json().catch(() => {
      throw new Error("服务响应异常，请刷新后重试");
    });
    if (generation !== epoch)
      throw new DOMException("Session changed", "AbortError");
    if (response.status === 401 && path !== "/api/auth/login")
      window.dispatchEvent(new Event("mailhub:unauthorized"));
    if (!response.ok || result.success === false)
      throw new Error(result.message || "操作失败，请稍后重试");
    return result;
  } finally {
    pending.delete(controller);
  }
}
export function useResource<T>(path: string | null, revision = 0) {
  const [state, setState] = useState<{
    path: string | null;
    result?: Reply<T>;
    loading: boolean;
    error?: string;
  }>({ path, loading: !!path });
  const [counter, setCounter] = useState(0);
  const reload = useCallback(() => setCounter((n) => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    if (!path) {
      setState({ path, loading: false });
      return;
    }
    setState((old) => ({
      path,
      result: old.path === path ? old.result : undefined,
      loading: true,
    }));
    api<T>(path, "GET", undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted)
          setState({ path, result, loading: false });
      })
      .catch((error) => {
        if (!controller.signal.aborted && error.name !== "AbortError")
          setState({ path, loading: false, error: error.message });
      });
    return () => controller.abort();
  }, [path, revision, counter]);
  return {
    ...(state.path === path
      ? state
      : { loading: !!path, result: undefined, error: undefined }),
    reload,
  };
}
export function useAction({ inline = false }: { inline?: boolean } = {}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const run = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        const message = error instanceof Error ? error.message : "操作失败";
        setError(message);
        if (!inline) toast.error(message);
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return { busy, error, run };
}
export function useDebounce<T>(value: T, delay = 280) {
  const [delayed, setDelayed] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDelayed(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return delayed;
}
export const query = (
  values: Record<string, string | number | boolean | undefined>,
) =>
  new URLSearchParams(
    Object.entries(values)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => [k, String(v)]),
  ).toString();
export function date(value?: string) {
  if (!value) return "尚无记录";
  const normalized = /Z$|[+-]\d\d:\d\d$/i.test(value)
    ? value
    : value.replace(" ", "T") + "Z";
  const d = new Date(normalized);
  return Number.isNaN(+d)
    ? "尚无记录"
    : d.toLocaleString("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
export function safeUrl(value?: string) {
  try {
    const u = new URL(value || "");
    return ["https:", "http:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : "";
  } catch {
    return "";
  }
}
export async function copy(
  value: string | undefined,
  label = "内容",
  notify = true,
) {
  if (!value) {
    if (notify) toast.info("暂无可复制的内容");
    return false;
  }
  try {
    await navigator.clipboard.writeText(value);
    if (notify) toast.success(`${label}已复制`);
    return true;
  } catch {
    if (notify) toast.error("剪贴板不可用，请选择文本手动复制");
    return false;
  }
}
export function download(value: unknown, name: string) {
  saveBlob(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
    name,
  );
}
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function downloadFile(path: string, name: string) {
  const generation = epoch;
  const controller = new AbortController();
  pending.add(controller);
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
    });
    if (generation !== epoch)
      throw new DOMException("Session changed", "AbortError");
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      if (generation !== epoch)
        throw new DOMException("Session changed", "AbortError");
      if (response.status === 401)
        window.dispatchEvent(new Event("mailhub:unauthorized"));
      throw new Error(error.message || "附件下载失败，请稍后重试");
    }
    const blob = await response.blob();
    if (generation !== epoch)
      throw new DOMException("Session changed", "AbortError");
    saveBlob(blob, name);
  } finally {
    pending.delete(controller);
  }
}
export async function readFile(file?: File) {
  if (!file) return "";
  if (file.size > 1024 * 1024) throw new Error("文件超过 1 MiB，请拆分导入");
  return file.text();
}
