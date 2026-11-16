import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { Reply } from "@/lib/types";

type StopReason = "manual" | "expired" | "error" | "matched";
type PollState<T> = {
  path: string | null;
  result?: Reply<T>;
  error?: string;
  loading: boolean;
  enabled: boolean;
  hidden: boolean;
  delay: number;
  checkedAt?: number;
  expiresAt?: number;
  reason?: StopReason;
};
type Options<T> = {
  revision?: number;
  durationMs?: number;
  fingerprint?: (result: Reply<T>) => string;
  until?: (result: Reply<T>) => boolean;
};

/** A resource and its polling share one request lane, including manual refreshes.
 * Hidden tabs cancel reads; returning resumes within the original wall-clock bound.
 * Every error (including 429) ends the session. Only start() enables it again.
 */
export function useSmartPolling<T>(
  path: string | null,
  options: Options<T> = {},
) {
  const latest = useRef(options);
  latest.current = options;
  const flight = useRef<Promise<void> | null>(null);
  const operations = useRef({
    reload: () => {},
    start: () => {},
    stop: () => {},
  });
  const [state, setState] = useState<PollState<T>>({
    path,
    loading: !!path,
    enabled: false,
    hidden: document.visibilityState !== "visible",
    delay: 5000,
  });

  useEffect(() => {
    let disposed = false;
    let busy = false;
    let enabled = false;
    let needsLoad = !!path;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let previous: string | undefined;
    let delay = 5000;
    let expiresAt = 0;
    const visible = () => document.visibilityState === "visible";
    const patch = (value: Partial<PollState<T>>) => {
      if (!disposed) setState((old) => ({ ...old, ...value, path }));
    };
    const stop = (reason: StopReason, cancel = true) => {
      enabled = false;
      needsLoad = false;
      clearTimeout(timer);
      clearTimeout(deadline);
      if (cancel) controller?.abort();
      patch({ enabled: false, expiresAt: undefined, reason });
    };
    const schedule = () => {
      clearTimeout(timer);
      if (!enabled || disposed || busy || !visible()) return;
      if (Date.now() >= expiresAt) return stop("expired");
      timer = setTimeout(() => void load(), delay);
    };
    const load = async () => {
      clearTimeout(timer);
      if (disposed || !path) return;
      needsLoad = true;
      if (busy || !visible()) return;
      busy = true;
      patch({ loading: true });
      // A path change/StrictMode cleanup aborts the old read. Await its settlement
      // before issuing the next one, even if the transport is slow to cancel.
      await flight.current;
      if (disposed) return;
      if (!visible() || !needsLoad) {
        busy = false;
        patch({ loading: false });
        return;
      }
      needsLoad = false;
      const request = new AbortController();
      controller = request;
      patch({ error: undefined });
      const task = (async () => {
        try {
          const result = await api<T>(
            path,
            "GET",
            undefined,
            AbortSignal.any([request.signal, AbortSignal.timeout(30000)]),
          );
          if (disposed || request.signal.aborted) return;
          const fingerprint =
            latest.current.fingerprint?.(result) ??
            JSON.stringify([
              result.data,
              result.total,
              result.summary,
              result.next_cursor,
            ]);
          delay =
            previous === fingerprint ? Math.min(delay + 5000, 15000) : 5000;
          previous = fingerprint;
          patch({
            result,
            error: undefined,
            checkedAt: Date.now(),
            delay,
            ...(!enabled ? { reason: undefined } : {}),
          });
          if (enabled && latest.current.until?.(result)) stop("matched", false);
        } catch (error) {
          if (disposed || request.signal.aborted) return;
          patch({
            error: error instanceof Error ? error.message : "检查失败，请重试",
          });
          stop("error", false);
        } finally {
          busy = false;
          if (controller === request) controller = undefined;
          patch({ loading: false });
        }
      })();
      flight.current = task;
      await task;
      if (flight.current === task) flight.current = null;
      if (disposed) return;
      if (needsLoad && visible()) void load();
      else schedule();
    };
    const start = () => {
      if (!path || enabled) return;
      enabled = true;
      delay = 5000;
      previous = undefined;
      // Callers may shorten the bound. Never permit an unbounded session.
      const duration = latest.current.durationMs ?? 300000;
      expiresAt =
        Date.now() +
        (Number.isFinite(duration)
          ? Math.min(Math.max(duration, 1000), 600000)
          : 300000);
      patch({
        enabled: true,
        reason: undefined,
        expiresAt,
        delay,
        error: undefined,
      });
      deadline = setTimeout(() => stop("expired"), expiresAt - Date.now());
      // Joining an initial/manual load does not queue a duplicate request.
      if (!busy) void load();
      else if (controller?.signal.aborted) needsLoad = true;
    };
    const visibility = () => {
      patch({ hidden: !visible() });
      if (!visible()) {
        clearTimeout(timer);
        if (busy) {
          needsLoad = true;
          controller?.abort();
        }
      } else if (enabled && Date.now() >= expiresAt) {
        stop("expired");
      } else if (needsLoad || enabled) {
        void load();
      }
    };
    setState({
      path,
      loading: !!path,
      enabled: false,
      hidden: !visible(),
      delay,
    });
    operations.current = {
      reload: () => void load(),
      start,
      stop: () => stop("manual"),
    };
    document.addEventListener("visibilitychange", visibility);
    void load();
    return () => {
      disposed = true;
      enabled = false;
      needsLoad = false;
      clearTimeout(timer);
      clearTimeout(deadline);
      controller?.abort();
      document.removeEventListener("visibilitychange", visibility);
      operations.current = {
        reload: () => {},
        start: () => {},
        stop: () => {},
      };
    };
  }, [path]);

  const lastRevision = useRef(options.revision);
  useEffect(() => {
    if (lastRevision.current !== options.revision) {
      lastRevision.current = options.revision;
      operations.current.reload();
    }
  }, [options.revision]);
  const reload = useCallback(() => operations.current.reload(), []);
  const start = useCallback(() => operations.current.start(), []);
  const stop = useCallback(() => operations.current.stop(), []);
  const current =
    state.path === path
      ? state
      : {
          path,
          loading: !!path,
          enabled: false,
          hidden: state.hidden,
          delay: 5000,
        };
  const status = current.enabled
    ? current.hidden
      ? "后台已暂停；返回后继续，等待时限不延长。"
      : current.loading
        ? "正在检查新邮件…"
        : `自动查收中，下次检查在 ${current.delay / 1000} 秒后。`
    : current.reason === "expired"
      ? "已到等待时限，自动查收已停止。"
      : current.reason === "error"
        ? "检查出错，自动查收已停止。处理后可手动重试。"
        : current.reason === "matched"
          ? "已收到验证邮件，自动查收已停止。"
          : current.reason === "manual"
            ? "自动查收已停止。"
            : "自动查收未开启。";
  return { ...current, status, reload, start, stop };
}
