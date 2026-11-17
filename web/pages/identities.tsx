import { useState } from "react";
import { Mail, Plus } from "lucide-react";
import {
  Blank,
  CopyButton,
  ErrorState,
  Loading,
  PageHeader,
  Pager,
  Pick,
  RefreshButton,
  SearchBox,
} from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { date, query, useDebounce, useResource } from "@/lib/api";
import { useWorkspace } from "@/lib/context";
import { mailboxSources, sourceName } from "@/lib/identities";
import type { MailboxIdentity } from "@/lib/types";

const metrics = [
  ["total_platforms", "平台总数"],
  ["unique_addresses", "独立邮箱地址"],
  ["total_registrations", "平台注册"],
  ["total_connections", "邮箱连接"],
  ["attention_connections", "需处理连接"],
  ["affected_registrations", "受影响登记"],
  ["due_registrations", "到期 / 7 天内到期"],
] as const;

export default function IdentitiesPage({
  initialQuery = "",
}: {
  initialQuery?: string;
}) {
  const w = useWorkspace();
  const [q, setQ] = useState(initialQuery);
  const [source, setSource] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const search = useDebounce(q);
  const rows = useResource<MailboxIdentity[]>(
    `/api/mailbox-identities?${query({ q: search, source, page, limit })}`,
    w.revision,
  );
  const loading = rows.loading || q !== search;
  return (
    <>
      <PageHeader
        title="邮箱资产"
        description="按实际收件地址与来源汇总，查看一个邮箱在多个平台的登记和连接状态。"
      >
        <Button onClick={() => w.vault({})}>
          <Plus data-icon="inline-start" />
          登记账号
        </Button>
      </PageHeader>
      <div
        className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4"
        aria-label="邮箱资产全局概览"
      >
        {metrics.map(([key, label]) => (
          <Card key={key} size="sm" aria-label={label}>
            <CardHeader>
              <CardDescription>{label}</CardDescription>
              <CardTitle>
                <strong className="text-2xl tabular-nums">
                  {rows.result?.summary?.[key] ?? "—"}
                </strong>
              </CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        概览统计整个工作区；下方筛选按收件地址、平台名称与来源查找。
      </p>
      <div className="data-panel mb-5">
        <div className="filter-bar">
          <SearchBox
            value={q}
            onChange={(value) => {
              setQ(value);
              setPage(1);
            }}
            placeholder="搜索邮箱地址或平台…"
          />
          <Pick
            label="邮箱资产来源"
            value={source}
            onChange={(value) => {
              setSource(value);
              setPage(1);
            }}
            options={[["", "全部来源"], ...mailboxSources]}
          />
          <Pick
            label="邮箱每页数量"
            value={String(limit)}
            onChange={(value) => {
              setLimit(Number(value));
              setPage(1);
            }}
            options={[
              ["10", "每页 10 个"],
              ["20", "每页 20 个"],
              ["50", "每页 50 个"],
            ]}
          />
          <RefreshButton busy={loading} onClick={w.refresh} />
        </div>
      </div>
      {rows.error ? (
        <ErrorState message={rows.error} retry={rows.reload} />
      ) : !rows.result ? (
        <Loading />
      ) : !rows.result.data.length ? (
        <Blank
          title="没有匹配的邮箱资产"
          description="调整来源或关键词，也可以直接登记新的平台账号。"
        >
          <Button
            variant="outline"
            onClick={() => {
              setQ("");
              setSource("");
              setPage(1);
            }}
          >
            清除筛选
          </Button>
        </Blank>
      ) : (
        <div
          className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
          aria-label="邮箱资产列表"
        >
          {rows.result.data.map((identity) => (
            <Card key={identity.id} className="min-w-0">
              <CardHeader>
                <div className="flex min-w-0 items-start gap-2">
                  <Mail className="mt-0.5 size-4 shrink-0" />
                  <CardTitle className="min-w-0 flex-1">
                    <button
                      className="text-left break-all hover:underline"
                      aria-label={`查看邮箱资产 ${identity.address}`}
                      onClick={() => w.identity(identity)}
                    >
                      {identity.address}
                    </button>
                  </CardTitle>
                  <CopyButton value={identity.address} label="复制邮箱地址" />
                </div>
                <CardDescription>
                  来源：{sourceName(identity.source)}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-3">
                <Badge
                  className="self-start"
                  variant={
                    identity.health.needs_attention
                      ? "destructive"
                      : "secondary"
                  }
                >
                  {identity.health.label}
                </Badge>
                <p className="text-sm">
                  {identity.platform_count} 个平台 ·{" "}
                  {identity.registration_count} 条登记
                </p>
                <p className="text-sm break-all text-muted-foreground">
                  {identity.platforms.join(" · ") || "尚未登记平台"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {identity.health.message}
                </p>
                {identity.expires_at && (
                  <p className="text-xs text-muted-foreground">
                    邮箱到期：{date(identity.expires_at)}
                  </p>
                )}
              </CardContent>
              <CardFooter>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => w.identity(identity)}
                >
                  查看全部登记
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
      <div className="mt-5" aria-busy={loading}>
        <Pager
          result={loading ? undefined : rows.result}
          page={page}
          setPage={setPage}
        />
      </div>
    </>
  );
}
