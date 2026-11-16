import { useEffect, useRef, useState } from "react";
import {
  Clock3,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  SlidersHorizontal,
  Square,
  X,
} from "lucide-react";
import {
  CopyAction,
  ErrorState,
  IconButton,
  Loading,
  Pick,
  TextField,
} from "@/components/common";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FieldGroup } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { useSmartPolling } from "@/hooks/use-smart-polling";
import { date, query, safeUrl } from "@/lib/api";
import type { Code } from "@/lib/types";

export type VerificationTarget = { path: string; label: string };

export function PollingControls({
  polling,
  disabled = false,
  compact = false,
}: {
  polling: {
    enabled: boolean;
    status: string;
    checkedAt?: number;
    start: () => void;
    stop: () => void;
  };
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
      <label className="flex shrink-0 items-center gap-2 text-sm">
        <Switch
          checked={polling.enabled}
          disabled={disabled}
          onCheckedChange={(value) =>
            value ? polling.start() : polling.stop()
          }
          aria-label="自动查收新邮件"
          title="仅在页面可见时检查，间隔 5 / 10 / 15 秒，有变化恢复 5 秒，每次最多 5 分钟。"
        />
        自动查收
      </label>
      <p
        role="status"
        className={
          compact
            ? "min-w-0 flex-1 truncate text-xs text-muted-foreground"
            : "text-xs text-muted-foreground"
        }
        title={polling.status}
      >
        {polling.status}
        {!compact &&
          polling.checkedAt &&
          ` 最近检查 ${date(new Date(polling.checkedAt).toISOString())}。`}
      </p>
      <p
        className={compact ? "sr-only" : "w-full text-xs text-muted-foreground"}
      >
        仅在当前页面可见时检查；间隔 5 / 10 / 15 秒，有变化恢复 5 秒，每次最多 5
        分钟。
      </p>
    </div>
  );
}

/** Actions can be composed beside a mail row without nesting interactive elements. */
export function VerificationActions({
  code,
  link,
}: {
  code?: string;
  link?: string;
}) {
  const url = safeUrl(link);
  if (!code && !url) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {code && (
        <CopyAction
          value={code}
          label={`复制验证码 ${code}`}
          variant="secondary"
          size="sm"
        />
      )}
      {url && (
        <>
          <CopyAction
            value={url}
            label="复制验证链接"
            variant="outline"
            size="sm"
          />
          <Button variant="ghost" size="sm" asChild>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
              title={`打开验证链接 · ${new URL(url).hostname}`}
            >
              打开链接
              <ExternalLink data-icon="inline-end" />
            </a>
          </Button>
        </>
      )}
    </div>
  );
}

export function QuickVerification({
  target,
  close,
}: {
  target: VerificationTarget;
  close: () => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [target.path]);
  return (
    <Card ref={card} className="mb-6 min-w-0" aria-label="快捷查收">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle>快捷查收</CardTitle>
            <CardDescription className="break-all">
              {target.label}
            </CardDescription>
          </div>
          <IconButton label="关闭快捷查收" onClick={close}>
            <X />
          </IconButton>
        </div>
      </CardHeader>
      <CardContent>
        <VerificationLookup key={target.path} path={target.path} />
      </CardContent>
    </Card>
  );
}

export function VerificationLookup({
  path,
  onSettled,
}: {
  path: string;
  onSettled?: () => void;
}) {
  const [range, setRange] = useState("86400");
  const [sender, setSender] = useState("");
  const [keyword, setKeyword] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [filters, setFilters] = useState({
    since: new Date(Date.now() - 86400000).toISOString(),
    sender: "",
    q: "",
  });
  const [watchKey, setWatchKey] = useState(0);
  const r = useSmartPolling<Code>(
    `${path}${path.includes("?") ? "&" : "?"}${query(filters)}`,
    {
      durationMs: 180000,
      fingerprint: ({ data }) =>
        JSON.stringify([
          data.code,
          data.link,
          data.scanned,
          data.received_at,
          data.subject,
        ]),
      until: ({ data }) => !!(data.code || safeUrl(data.link)),
    },
  );
  const waiting = r.enabled;
  const result = r.result?.data;
  useEffect(() => {
    if (watchKey) r.start();
  }, [watchKey, r.start]);
  useEffect(() => {
    if (result || r.error) onSettled?.();
  }, [result, r.error, onSettled]);
  const startQuery = (seconds = range) => {
    r.stop();
    const next = {
      since: seconds
        ? new Date(Date.now() - Number(seconds) * 1000).toISOString()
        : "",
      sender,
      q: keyword,
    };
    if (query(next) === query(filters)) r.reload();
    else setFilters(next);
  };
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Pick
          label="验证码时间范围"
          value={range}
          disabled={waiting}
          onChange={(v) => {
            setRange(v);
            startQuery(v);
          }}
          options={[
            ["600", "最近 10 分钟"],
            ["3600", "最近 1 小时"],
            ["86400", "最近 24 小时"],
            ["", "近期邮件（不限时间）"],
          ]}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={r.loading || waiting}
          onClick={() => startQuery()}
        >
          {r.loading ? (
            <Loader2 className="animate-spin" data-icon="inline-start" />
          ) : (
            <RefreshCw data-icon="inline-start" />
          )}
          查收
        </Button>
        <Button
          size="sm"
          variant={waiting ? "secondary" : "outline"}
          disabled={r.loading && !waiting}
          onClick={() => {
            if (waiting) {
              r.stop();
            } else {
              const now = Date.now();
              setFilters({
                since: new Date(now).toISOString(),
                sender,
                q: keyword,
              });
              setWatchKey((value) => value + 1);
            }
          }}
        >
          {waiting ? (
            <Square data-icon="inline-start" />
          ) : (
            <Clock3 data-icon="inline-start" />
          )}
          {waiting ? "停止等待" : "等待新邮件"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={advanced}
          onClick={() => setAdvanced(!advanced)}
        >
          <SlidersHorizontal data-icon="inline-start" />
          筛选
        </Button>
      </div>
      {advanced && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            startQuery();
          }}
          className="flex flex-col gap-3"
        >
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="发件人包含"
              value={sender}
              onChange={(e) => setSender(e.target.value)}
              placeholder="例如 accounts.example.com"
              maxLength={254}
              disabled={waiting}
            />
            <TextField
              label="邮件关键词"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="例如平台名称"
              maxLength={200}
              disabled={waiting}
            />
          </FieldGroup>
          <Button
            variant="outline"
            size="sm"
            type="submit"
            className="self-start"
            disabled={r.loading || waiting}
          >
            应用筛选
          </Button>
        </form>
      )}
      {waiting && (
        <p
          role="status"
          className="flex items-start gap-2 text-sm text-muted-foreground"
        >
          <Clock3 className="mt-0.5 size-4 shrink-0" />
          只检查开始等待后收到的邮件；间隔 5 / 10 / 15 秒，有变化恢复 5 秒，最多
          3 分钟。{r.status}
        </p>
      )}
      {r.error ? (
        <ErrorState message={r.error} retry={() => startQuery()} />
      ) : !result ? (
        <Loading />
      ) : (
        <div
          className="flex min-w-0 flex-col gap-3 rounded-lg border bg-muted/25 p-4"
          aria-live="polite"
          aria-busy={r.loading}
        >
          {result.code || safeUrl(result.link) ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant="secondary">
                  <KeyRound data-icon="inline-start" />
                  {result.code ? "识别到验证码" : "识别到验证链接"}
                </Badge>
                {result.code && (
                  <strong className="break-all font-mono text-2xl tracking-widest">
                    {result.code}
                  </strong>
                )}
              </div>
              <VerificationActions code={result.code} link={result.link} />
              {safeUrl(result.link) && (
                <p className="break-all text-xs text-muted-foreground">
                  链接域名：{new URL(safeUrl(result.link)).hostname}
                </p>
              )}
              <div className="flex min-w-0 flex-col gap-1 text-sm">
                <p className="break-words">{result.subject}</p>
                <p className="break-all text-xs text-muted-foreground">
                  {result.sender} · 收到于 {date(result.received_at)}
                </p>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {waiting
                ? "等待新的验证码或验证链接…"
                : result.message || "未找到验证码或验证链接"}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {r.loading
              ? "正在检查，以上为上次结果…"
              : `已检查 ${result.scanned ?? 0} 封邮件${result.checked_at ? ` · ${date(result.checked_at)}` : ""}`}
            {result.limited
              ? " · 还有更早的邮件，可按发件人或关键词缩小范围"
              : ""}
          </p>
        </div>
      )}
      {!waiting && r.reason && (
        <p role="status" className="text-sm text-muted-foreground">
          {r.reason === "expired"
            ? "已等待 3 分钟，暂未识别到新的验证邮件。可以重新等待或查看收件箱。"
            : r.status}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        按收件时间返回最新匹配项，是否仍有效以目标平台为准。验证链接由你选择打开。
      </p>
    </div>
  );
}
