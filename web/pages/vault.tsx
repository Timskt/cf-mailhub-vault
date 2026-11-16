import { PlatformManager, PlatformEditor } from "@/features/platform-manager";
import { VaultImportDialog } from "@/features/vault-import";
import { AccountExportDialog } from "@/features/account-export";
import { VerificationLookup } from "@/features/verification";
import { TotpDialog, TotpField } from "@/features/totp";
import {
  ActionError,
  Blank,
  BusyButton,
  CopyButton,
  ErrorState,
  Loading,
  Menu,
  Modal,
  ModalBody,
  ModalFooter,
  PageHeader,
  Pager,
  Pick,
  RefreshButton,
  SearchBox,
  SelectField,
  TextField,
} from "@/components/common";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  api,
  copy,
  download,
  date,
  query,
  readFile,
  safeUrl,
  useAction,
  useDebounce,
  useResource,
} from "@/lib/api";
import { useWorkspace } from "@/lib/context";
import {
  defaultPasswordOptions,
  generatePassword,
  type PasswordOptions,
} from "@/lib/password-generator";
import { normalizeTotp } from "@/lib/totp";
import { cn } from "@/lib/utils";
import type {
  Mailbox,
  Vault,
  VaultPlatform,
  PlatformDefinition,
} from "@/lib/types";
import {
  Activity,
  ArrowRight,
  CircleAlert,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Filter,
  Inbox,
  KeyRound,
  Layers,
  Link,
  Pencil,
  Pin,
  Plus,
  SearchCheck,
  ShieldCheck,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

export const sources: [string, string][] = [
  ["cf_domain", "自建域名"],
  ["outlook", "Outlook"],
  ["external", "外部邮箱"],
  ["gptmail", "公共邮箱"],
];
const statuses: [string, string][] = [
  ["active", "使用中"],
  ["pending", "待验证"],
  ["banned", "已封禁"],
  ["deprecated", "已废弃"],
];
const triageOptions: [string, string][] = [
  ["", "全部账号"],
  ["attention", "需要处理"],
  ["unchecked", "待检查 / 复查"],
  ["connected", "邮箱已连接"],
];
type VaultFilters = {
  q: string;
  email_source: string;
  status: string;
  category: string;
  domain: string;
  has_code: boolean;
  triage: string;
};
const emptyFilters: VaultFilters = {
  q: "",
  email_source: "",
  status: "",
  category: "",
  domain: "",
  has_code: false,
  triage: "",
};
type SelectedAccount = Pick<Vault, "id" | "account_email" | "username">;
const viewPreference = "mailhub.vault.account-view.v1";

export default function VaultPage({
  initialQuery = "",
}: {
  initialQuery?: string;
}) {
  const w = useWorkspace();
  const [filters, setFilters] = useState({ ...emptyFilters, q: initialQuery });
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState("name");
  const [advanced, setAdvanced] = useState(false);
  const [restore, setRestore] = useState(false);
  const [managePlatforms, setManagePlatforms] = useState(false);
  const [platformEditor, setPlatformEditor] = useState<
    PlatformDefinition | "new" | null
  >(null);
  const [exportAll, setExportAll] = useState(false);
  const [selected, setSelected] = useState<{
    name: string;
    filters: VaultFilters;
  } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const search = useDebounce(filters.q);
  const action = useAction();
  const platforms = useResource<VaultPlatform[]>(
    `/api/vault/platforms?${query({ ...filters, q: search, page, limit: 24, sort })}`,
    w.revision,
  );
  const stats = useResource<{
    total_vault_accounts: number;
    total_platforms: number;
    attention_accounts: number;
    unchecked_accounts: number;
    categories: { category: string }[];
  }>("/api/vault/stats", w.revision);
  const change = (key: keyof VaultFilters, value: string | boolean) => {
    setFilters((old) => ({ ...old, [key]: value }));
    setPage(1);
  };
  const reset = () => {
    setFilters({ ...emptyFilters });
    setPage(1);
  };
  const filtered = Object.values(filters).some(Boolean);
  const searching = platforms.loading || filters.q !== search;
  const open = (name: string, triage = filters.triage) => {
    opener.current = document.activeElement as HTMLElement;
    setSelected({ name, filters: { ...filters, triage } });
  };
  return (
    <>
      <PageHeader
        title="平台账号"
        description="平台资料独立管理，账号按平台归档。支持固定文本导入、复制和导出。"
      >
        <Button variant="outline" onClick={() => setManagePlatforms(true)}>
          <Layers data-icon="inline-start" />
          管理平台
        </Button>
        <Button variant="outline" onClick={() => setRestore(true)}>
          <Upload data-icon="inline-start" />
          导入账号
        </Button>
        <Button
          variant="outline"
          disabled={searching}
          onClick={() => setExportAll(true)}
        >
          <Download data-icon="inline-start" />
          导出账号
        </Button>
        <Button variant="outline" onClick={() => setPlatformEditor("new")}>
          <Plus data-icon="inline-start" />
          新建平台
        </Button>
        <Button onClick={() => w.vault({})}>
          <Plus data-icon="inline-start" />
          登记账号
        </Button>
      </PageHeader>
      {stats.error ? (
        <ErrorState message={stats.error} retry={stats.reload} />
      ) : (
        <div
          className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4"
          aria-label="平台账号概览"
        >
          {[
            {
              title: "平台总数",
              value: stats.result?.data.total_platforms,
              icon: Layers,
              note: "每个平台独立汇总",
              action: reset,
            },
            {
              title: "账号总数",
              value: stats.result?.data.total_vault_accounts,
              icon: Users,
              note: "查看全部平台",
              action: reset,
            },
            {
              title: "需要处理",
              value: stats.result?.data.attention_accounts,
              icon: CircleAlert,
              note: "连接问题 / 待验证 / 封禁",
              action: () => {
                setFilters({ ...emptyFilters, triage: "attention" });
                setPage(1);
              },
            },
            {
              title: "待检查 / 复查",
              value: stats.result?.data.unchecked_accounts,
              icon: SearchCheck,
              note: "尚未验证或检查已过期",
              action: () => {
                setFilters({ ...emptyFilters, triage: "unchecked" });
                setPage(1);
              },
            },
          ].map((metric) => (
            <Card key={metric.title} size="sm">
              <CardHeader className="max-sm:pb-3">
                <CardDescription className="flex items-center justify-between gap-2">
                  {metric.title}
                  <metric.icon className="size-4" />
                </CardDescription>
                <CardTitle>
                  <strong className="text-3xl tabular-nums">
                    {metric.value ?? "—"}
                  </strong>
                </CardTitle>
              </CardHeader>
              <CardContent className="hidden sm:block">
                <p className="text-xs text-muted-foreground">{metric.note}</p>
              </CardContent>
              <CardFooter className="hidden sm:flex">
                <Button
                  className="w-full justify-between"
                  size="sm"
                  variant="ghost"
                  onClick={metric.action}
                  aria-label={`查看${metric.title}`}
                >
                  查看
                  <ArrowRight data-icon="inline-end" />
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
      <div className="data-panel mb-5">
        <div className="filter-bar">
          <SearchBox
            value={filters.q}
            onChange={(v) => change("q", v)}
            placeholder="搜索平台、邮箱、用户名…"
          />
          <Pick
            label="处理状态"
            value={filters.triage}
            onChange={(v) => change("triage", v)}
            options={triageOptions}
          />
          <Pick
            label="平台排序"
            value={sort}
            onChange={(v) => {
              setSort(v);
              setPage(1);
            }}
            options={[
              ["name", "按平台名称"],
              ["attention", "优先需要处理"],
              ["count", "按账号数量"],
              ["pinned", "优先置顶账号"],
            ]}
          />
          <Button
            variant={advanced ? "secondary" : "outline"}
            aria-expanded={advanced}
            onClick={() => setAdvanced(!advanced)}
          >
            <Filter data-icon="inline-start" />
            更多筛选
          </Button>
          <RefreshButton onClick={w.refresh} busy={searching} />
        </div>
        {advanced && (
          <div className="filter-extra">
            <Pick
              label="邮箱来源"
              value={filters.email_source}
              onChange={(v) => change("email_source", v)}
              options={[["", "全部来源"], ...sources]}
            />
            <Pick
              label="登记状态"
              value={filters.status}
              onChange={(v) => change("status", v)}
              options={[["", "全部登记状态"], ...statuses]}
            />
            <Pick
              label="分类"
              value={filters.category}
              onChange={(v) => change("category", v)}
              options={[
                ["", "全部分类"],
                ...(stats.result?.data.categories || []).map(
                  (c) => [c.category, c.category] as [string, string],
                ),
              ]}
            />
            <Pick
              label="邮箱域名"
              value={filters.domain}
              onChange={(v) => change("domain", v)}
              options={[
                ["", "全部域名"],
                ...[
                  ...new Set([
                    ...(w.settings?.domains || []).map((d) => d.domain),
                    "outlook.com",
                    "hotmail.com",
                  ]),
                ].map((d) => [d, d] as [string, string]),
              ]}
            />
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={filters.has_code}
                onCheckedChange={(v) => change("has_code", v === true)}
              />
              有历史验证码
            </label>
          </div>
        )}
        <div
          className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm text-muted-foreground"
          aria-live="polite"
        >
          <span>
            {searching
              ? "正在更新平台…"
              : `${filtered ? "当前筛选" : "全部"} ${platforms.result?.total ?? 0} 个平台 · ${platforms.result?.summary?.accounts ?? 0} 个${filtered ? "匹配" : ""}账号`}
          </span>
          {filtered ? (
            <Button variant="ghost" size="sm" onClick={reset}>
              清除全部筛选
            </Button>
          ) : (
            <span className="text-xs">点击平台进入账号抽屉</span>
          )}
        </div>
      </div>
      {platforms.error ? (
        <ErrorState message={platforms.error} retry={platforms.reload} />
      ) : !platforms.result ? (
        <Loading />
      ) : !platforms.result.data.length ? (
        <Blank
          title={filtered ? "没有匹配的平台或账号" : "登记你的第一个平台"}
          description={
            filtered
              ? "搜索会同时匹配平台名称、邮箱、用户名和备注；试试清除筛选。"
              : "先创建平台资料，再按需要登记账号。没有账号的平台也会保留。"
          }
        >
          <Button
            variant="outline"
            onClick={filtered ? reset : () => setPlatformEditor("new")}
          >
            {filtered ? "清除全部筛选" : "新建平台"}
          </Button>
        </Blank>
      ) : (
        <div
          className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
          aria-label="平台卡片"
        >
          {platforms.result.data.map((p) => (
            <Card
              key={p.platform_name.toLowerCase()}
              className="min-w-0"
              aria-label={`${p.platform_name} 平台`}
            >
              <CardHeader>
                <div className="flex min-w-0 items-start gap-3">
                  <Avatar className="size-11 rounded-xl">
                    <AvatarFallback className="rounded-xl">
                      {p.platform_name.slice(0, 2)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <CardTitle>
                      <button
                        className="text-left break-all hover:underline"
                        onClick={() => open(p.platform_name)}
                        aria-label={`查看 ${p.platform_name} 的账号`}
                      >
                        {p.platform_name}
                      </button>
                    </CardTitle>
                    <CardDescription className="truncate">
                      {p.definition?.category ||
                        p.categories.join(" · ") ||
                        "未分类"}
                    </CardDescription>
                  </div>
                  {p.definition && (
                    <Menu
                      label={`管理平台 ${p.platform_name}`}
                      items={[
                        {
                          label: "编辑平台资料",
                          icon: <Pencil />,
                          action: () => setPlatformEditor(p.definition!),
                        },
                        {
                          label: "管理全部平台",
                          icon: <Layers />,
                          action: () => setManagePlatforms(true),
                        },
                      ]}
                    />
                  )}
                  {(!!p.pinned_count || !!p.definition?.is_pinned) && (
                    <Badge variant="outline">
                      <Pin data-icon="inline-start" />
                      {p.definition?.is_pinned ? "平台置顶" : p.pinned_count}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-4">
                {p.definition?.remark && (
                  <p className="line-clamp-2 break-all text-sm text-muted-foreground">
                    {p.definition.remark}
                  </p>
                )}
                {safeUrl(p.definition?.url) && (
                  <a
                    href={safeUrl(p.definition?.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm hover:underline"
                  >
                    打开平台官网
                    <ExternalLink className="size-3" />
                  </a>
                )}
                <div className="flex items-baseline gap-2">
                  <strong className="text-3xl font-semibold tabular-nums">
                    {p.count}
                  </strong>
                  <span className="text-sm text-muted-foreground">
                    个{filtered ? "匹配" : ""}账号
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge
                    variant={p.attention_count ? "destructive" : "secondary"}
                  >
                    {p.attention_count} 需要处理
                  </Badge>
                  <Badge variant="outline">
                    {p.unchecked_count} 待检查 / 复查
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  收件来源：
                  {p.sources
                    .map((v) => sources.find(([s]) => s === v)?.[1] || v)
                    .join(" · ")}
                </p>
              </CardContent>
              <CardFooter className="flex-wrap justify-between gap-2">
                {p.attention_count > 0 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => open(p.platform_name, "attention")}
                    aria-label={`处理 ${p.platform_name} 的问题`}
                  >
                    处理问题
                    <CircleAlert data-icon="inline-end" />
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {p.connected_count
                      ? `${p.connected_count} 个邮箱已连接`
                      : "状态按账号分别记录"}
                  </span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => open(p.platform_name)}
                  aria-label={`管理 ${p.platform_name} 账号`}
                >
                  管理账号
                  <ArrowRight data-icon="inline-end" />
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
      <div className="mt-5">
        <Pager result={platforms.result} page={page} setPage={setPage} />
      </div>
      <p className="page-footnote">
        登记状态由你手动维护；邮箱状态来自最近一次连接、续期或域名检查，不代表平台登录已经验证。
      </p>
      {selected && (
        <PlatformDrawer
          name={selected.name}
          initial={selected.filters}
          close={() => setSelected(null)}
          restoreFocus={() => {
            if (opener.current?.isConnected) opener.current.focus();
            else document.getElementById("main-content")?.focus();
          }}
        />
      )}
      {restore && <VaultImportDialog close={() => setRestore(false)} />}
      {exportAll && (
        <AccountExportDialog
          kind="vault"
          title={filtered ? "导出筛选账号" : "导出全部平台账号"}
          endpoint={`/api/vault/export?${query({ ...filters, q: search })}`}
          close={() => setExportAll(false)}
        />
      )}
      {managePlatforms && (
        <PlatformManager
          close={() => setManagePlatforms(false)}
          openAccounts={(name) => open(name)}
        />
      )}
      {platformEditor && (
        <PlatformEditor
          initial={platformEditor === "new" ? undefined : platformEditor}
          close={() => setPlatformEditor(null)}
        />
      )}
    </>
  );
}

function PlatformDrawer({
  name,
  initial,
  close,
  restoreFocus,
}: {
  name: string;
  initial: VaultFilters;
  close: () => void;
  restoreFocus: () => void;
}) {
  const w = useWorkspace();
  const [filters, setFilters] = useState(initial);
  const [page, setPage] = useState(1);
  const [verification, setVerification] = useState<Vault | null>(null);
  const [totp, setTotp] = useState<Vault | null>(null);
  const [selection, setSelection] = useState<Map<number, SelectedAccount>>(
    new Map(),
  );
  const [bulk, setBulk] = useState<BulkField | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportPlatform, setExportPlatform] = useState(false);
  const [singleExport, setSingleExport] = useState<Vault | null>(null);
  const [importPlatform, setImportPlatform] = useState(false);
  const [view, setView] = useState<"cards" | "table">(() => {
    try {
      return localStorage.getItem(viewPreference) === "table"
        ? "table"
        : "cards";
    } catch {
      return "cards";
    }
  });
  const title = useRef<HTMLHeadingElement>(null);
  const selectionHelp = useId();
  const search = useDebounce(filters.q);
  const rows = useResource<Vault[]>(
    `/api/vault?${query({ ...filters, q: search, platform: name, page, limit: 20 })}`,
    w.revision,
  );
  const overview = useResource<VaultPlatform[]>(
    `/api/vault/platforms?${query({ platform: name })}`,
    w.revision,
  );
  const group = overview.result?.data[0];
  const emptyPlatform = overview.result?.data.length === 0;
  const visible = rows.result?.data ?? [];
  const pageSelected = visible.filter((a) => selection.has(a.id)).length;
  const loading = rows.loading || filters.q !== search;
  const selectAccount = (account: Vault, checked: boolean) => {
    if (checked && selection.size >= 100 && !selection.has(account.id)) {
      toast.info("每批最多选择 100 个账号，请先处理或清空选择。");
      return;
    }
    setSelection((old) => {
      const next = new Map(old);
      if (checked)
        next.set(account.id, {
          id: account.id,
          account_email: account.account_email,
          username: account.username,
        });
      else next.delete(account.id);
      return next;
    });
  };
  const selectPage = (checked: boolean) => {
    const additions = visible.filter((a) => !selection.has(a.id));
    if (checked && selection.size + additions.length > 100) {
      toast.info("选择本页会超过 100 个账号，请先取消部分选择。");
      return;
    }
    setSelection((old) => {
      const next = new Map(old);
      for (const a of visible) {
        if (checked)
          next.set(a.id, {
            id: a.id,
            account_email: a.account_email,
            username: a.username,
          });
        else next.delete(a.id);
      }
      return next;
    });
  };
  const filtered = Object.values(filters).some(Boolean);
  const inherited = [
    filters.email_source &&
      sources.find(([s]) => s === filters.email_source)?.[1],
    filters.status && statuses.find(([s]) => s === filters.status)?.[1],
    filters.category,
    filters.domain,
    filters.has_code && "有历史验证码",
  ].filter(Boolean);
  const change = (key: keyof VaultFilters, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  };
  const reset = () => {
    setFilters({ ...emptyFilters });
    setPage(1);
  };
  return (
    <Sheet open onOpenChange={(open) => !open && close()}>
      <SheetContent
        closeLabel="关闭平台详情"
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          title.current?.focus();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          restoreFocus();
        }}
      >
        <SheetHeader className="shrink-0 gap-2 border-b p-5 pr-14">
          <SheetTitle ref={title} tabIndex={-1} className="break-all">
            {name} · 账号管理
          </SheetTitle>
          <SheetDescription>
            {group
              ? `${group.count} 个账号 · ${group.attention_count} 个需要处理 · ${group.unchecked_count} 个待检查 / 复查`
              : emptyPlatform
                ? "0 个账号"
                : "账号按置顶和最近更新排序"}
          </SheetDescription>
        </SheetHeader>
        <div
          className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4 sm:p-5"
          data-slot="platform-body"
        >
          <div className="flex shrink-0 flex-col gap-3">
            {overview.error && (
              <ErrorState message={overview.error} retry={overview.reload} />
            )}
            <div className="flex flex-wrap gap-2">
              <div className="min-w-0 basis-full sm:flex-1 sm:basis-64">
                <SearchBox
                  value={filters.q}
                  onChange={(v) => change("q", v)}
                  placeholder="在此平台搜索邮箱、用户名…"
                />
              </div>
              <Pick
                label="平台内处理状态"
                value={filters.triage}
                onChange={(v) => change("triage", v)}
                options={triageOptions}
              />
              <RefreshButton busy={rows.loading} onClick={w.refresh} />
              <Button variant="outline" onClick={() => setImportPlatform(true)}>
                <Upload data-icon="inline-start" />
                导入账号
              </Button>
              <Button variant="outline" onClick={() => setExportPlatform(true)}>
                <Download data-icon="inline-start" />
                导出此平台
              </Button>
              <Pick
                label="账号展示方式"
                value={view}
                options={[
                  ["cards", "卡片视图"],
                  ["table", "紧凑表格"],
                ]}
                onChange={(value) => {
                  const mode = value === "table" ? "table" : "cards";
                  setView(mode);
                  // Store only the display preference, never selection or account data.
                  try {
                    localStorage.setItem(viewPreference, mode);
                  } catch {
                    /* Use an in-memory preference when storage is disabled. */
                  }
                }}
              />
            </div>
            {inherited.length > 0 && (
              <p className="text-xs text-muted-foreground">
                沿用首页筛选：{inherited.join(" · ")}
              </p>
            )}
            <div
              className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
              aria-live="polite"
            >
              <span>
                {rows.loading || filters.q !== search
                  ? "正在加载账号…"
                  : `显示 ${rows.result?.total ?? 0} 个${filtered ? "匹配" : ""}账号`}
              </span>
              {filtered && !emptyPlatform && (
                <Button variant="ghost" size="sm" onClick={reset}>
                  查看此平台全部账号
                </Button>
              )}
            </div>
            <div
              className="data-panel flex flex-col gap-3 p-3"
              aria-label="批量账号操作"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={
                      visible.length > 0 && pageSelected === visible.length
                        ? true
                        : pageSelected
                          ? "indeterminate"
                          : false
                    }
                    disabled={loading || !visible.length}
                    aria-describedby={selectionHelp}
                    onCheckedChange={(v) => selectPage(v === true)}
                  />
                  选择本页（{visible.length}）
                </label>
                <span role="status" className="text-sm tabular-nums">
                  已选 {selection.size} / 100 · 本页 {pageSelected} ·
                  其它页或筛选外 {selection.size - pageSelected}
                </span>
              </div>
              <p id={selectionHelp} className="text-xs text-muted-foreground">
                翻页和筛选保留选择；本页全选仅影响当前页。批量操作包含全部已选；关闭抽屉清空。
              </p>
              {selection.size > 0 && (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Menu
                      label="批量整理选中账号"
                      trigger={
                        <Button variant="secondary">
                          批量整理 {selection.size} 个账号
                        </Button>
                      }
                      items={[
                        {
                          label: "设置分类",
                          action: () => setBulk("category"),
                        },
                        {
                          label: "设置登记状态",
                          action: () => setBulk("status"),
                        },
                        { label: "替换备注", action: () => setBulk("remark") },
                        {
                          label: "设置置顶",
                          action: () => setBulk("is_pinned"),
                        },
                      ]}
                    />
                    <Button
                      variant="outline"
                      onClick={() => setExporting(true)}
                    >
                      <Download data-icon="inline-start" />
                      导出所选
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setSelection(new Map())}
                    >
                      清空选择
                    </Button>
                  </div>
                  <details>
                    <summary className="cursor-pointer text-sm">
                      查看 / 移除已选账号（{selection.size}）
                    </summary>
                    <ul className="mt-2 flex max-h-48 flex-col gap-2 overflow-y-auto">
                      {[...selection.values()].map((a) => (
                        <li
                          key={a.id}
                          className="flex min-w-0 items-center justify-between gap-2"
                        >
                          <span className="min-w-0 break-all text-xs">
                            {a.account_email}
                            {a.username ? ` · ${a.username}` : ""} · #{a.id}
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`取消选择 ${a.account_email} #${a.id}`}
                            onClick={() =>
                              setSelection((old) => {
                                const next = new Map(old);
                                next.delete(a.id);
                                return next;
                              })
                            }
                          >
                            移除
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </details>
                </>
              )}
            </div>
          </div>
          {rows.error ? (
            <ErrorState message={rows.error} retry={rows.reload} />
          ) : !rows.result ? (
            <Loading />
          ) : !rows.result.data.length ? (
            <Blank
              title={
                filtered && !emptyPlatform
                  ? "当前条件下没有账号"
                  : "这个平台暂无账号"
              }
              description={
                filtered && !emptyPlatform
                  ? "试试清除筛选，查看该平台的全部账号。"
                  : "可以继续登记账号，或关闭抽屉查看其它平台。"
              }
            />
          ) : view === "table" ? (
            <div
              className="min-w-0 shrink-0 overflow-x-auto rounded-lg border [&>[data-slot=table-container]]:overflow-visible"
              tabIndex={0}
              role="region"
              aria-label="账号表格，可横向滚动"
            >
              <Table>
                <TableCaption className="sr-only">
                  {name} 平台账号，每页 20 条。可选择账号进行批量操作。
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col" className="px-2">
                      选择
                    </TableHead>
                    <TableHead scope="col" className="px-2">
                      账号 / 分类
                    </TableHead>
                    <TableHead scope="col" className="px-2">
                      邮箱 / 登记状态
                    </TableHead>
                    <TableHead scope="col" className="px-2">
                      操作
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((a) => (
                    <VaultAccountRow
                      key={a.id}
                      account={a}
                      selected={selection.has(a.id)}
                      selectionDisabled={loading}
                      select={(v) => selectAccount(a, v)}
                      verify={() => setVerification(a)}
                      totp={() => setTotp(a)}
                      exportAccount={() => setSingleExport(a)}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="flex shrink-0 flex-col gap-3">
              {rows.result.data.map((a) => (
                <VaultAccountCard
                  key={a.id}
                  account={a}
                  verify={() => setVerification(a)}
                  totp={() => setTotp(a)}
                  exportAccount={() => setSingleExport(a)}
                  selected={selection.has(a.id)}
                  selectionDisabled={loading}
                  select={(v) => selectAccount(a, v)}
                />
              ))}
            </div>
          )}
        </div>
        <SheetFooter className="shrink-0 gap-3 border-t p-4">
          <Pager result={rows.result} page={page} setPage={setPage} />
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="outline" onClick={close}>
              返回平台概览
            </Button>
            <Button onClick={() => w.vault({ platform_name: name })}>
              <Plus data-icon="inline-start" />
              登记到此平台
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
      {totp && (
        <TotpDialog
          accountId={totp.id}
          email={totp.account_email}
          close={() => setTotp(null)}
        />
      )}
      {bulk && (
        <BulkVaultEditor
          field={bulk}
          accounts={[...selection.values()]}
          close={() => setBulk(null)}
          saved={() => {
            setSelection(new Map());
            setBulk(null);
            w.refresh();
          }}
        />
      )}
      {importPlatform && (
        <VaultImportDialog
          platform={name}
          close={() => setImportPlatform(false)}
        />
      )}
      {exportPlatform && (
        <AccountExportDialog
          kind="vault"
          title={`导出 ${name} 的账号`}
          endpoint={`/api/vault/export?${query({ platform: name })}`}
          close={() => setExportPlatform(false)}
        />
      )}
      {exporting && (
        <ExportSelectedVault
          accounts={[...selection.values()]}
          close={() => setExporting(false)}
        />
      )}
      {singleExport && (
        <AccountExportDialog
          kind="vault"
          title={`导出 ${singleExport.account_email}`}
          endpoint={`/api/vault/export?ids=${singleExport.id}`}
          close={() => setSingleExport(null)}
        />
      )}
      {verification && (
        <Modal
          title="查收验证码 / 链接"
          description={`${verification.platform_name} · ${verification.account_email}`}
          close={() => setVerification(null)}
          wide
        >
          <ModalBody>
            <VerificationLookup
              path={`/api/vault/${verification.id}/code`}
              onSettled={w.refresh}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="outline" onClick={() => setVerification(null)}>
              返回账号列表
            </Button>
            {verification.email_source === "outlook" && (
              <Button
                variant="outline"
                onClick={() =>
                  w.navigate("outlook", verification.account_email)
                }
              >
                查看邮箱连接
              </Button>
            )}
          </ModalFooter>
        </Modal>
      )}
    </Sheet>
  );
}
type BulkField = "category" | "status" | "remark" | "is_pinned";
const bulkLabels: Record<BulkField, string> = {
  category: "设置分类",
  status: "设置登记状态",
  remark: "替换备注",
  is_pinned: "设置置顶",
};

function BulkVaultEditor({
  field,
  accounts,
  close,
  saved,
}: {
  field: BulkField;
  accounts: SelectedAccount[];
  close: () => void;
  saved: () => void;
}) {
  const action = useAction({ inline: true });
  const [value, setValue] = useState("");
  const [replaceEmpty, setReplaceEmpty] = useState(false);
  const fieldId = useId();
  const empty = (field === "category" || field === "remark") && !value.trim();
  return (
    <Modal
      title={`${bulkLabels[field]} · ${accounts.length} 个账号`}
      description="将更新所有已选账号，包含其它页和当前筛选之外的选择。仅修改这一字段。"
      close={() => {
        if (!action.busy) close();
      }}
    >
      <form
        className="modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            if (!accounts.length || accounts.length > 100)
              throw new Error("请重新选择 1–100 个账号。");
            if (empty && !replaceEmpty) throw new Error("请确认清空此字段。");
            if ((field === "status" || field === "is_pinned") && !value)
              throw new Error("请选择目标值。");
            await api("/api/vault/batch", "POST", {
              ids: accounts.map((a) => a.id),
              patch: {
                [field]:
                  field === "is_pinned" ? value === "true" : empty ? "" : value,
              },
            });
            toast.success(
              `已更新 ${accounts.length} 个账号的${field === "remark" ? "备注" : bulkLabels[field].replace("设置", "")}`,
            );
            saved();
          });
        }}
      >
        <ModalBody>
          <ActionError message={action.error} />
          <FieldGroup>
            {field === "category" && (
              <TextField
                label="统一分类"
                maxLength={100}
                value={value}
                disabled={action.busy}
                onChange={(e) => setValue(e.target.value)}
                placeholder="例如：开发服务"
              />
            )}
            {field === "status" && (
              <SelectField
                label="目标登记状态"
                value={value}
                disabled={action.busy}
                onChange={setValue}
                options={[["", "请选择状态"], ...statuses]}
              />
            )}
            {field === "remark" && (
              <Field>
                <FieldLabel htmlFor={fieldId}>
                  统一备注（覆盖原备注）
                </FieldLabel>
                <Textarea
                  id={fieldId}
                  maxLength={4000}
                  rows={4}
                  value={value}
                  disabled={action.busy}
                  onChange={(e) => setValue(e.target.value)}
                />
                <FieldDescription>
                  各账号原备注会被替换，请核对选择范围。
                </FieldDescription>
              </Field>
            )}
            {field === "is_pinned" && (
              <SelectField
                label="目标置顶状态"
                value={value}
                disabled={action.busy}
                onChange={setValue}
                options={[
                  ["", "请选择置顶状态"],
                  ["true", "全部置顶"],
                  ["false", "全部取消置顶"],
                ]}
              />
            )}
            {empty && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={replaceEmpty}
                  disabled={action.busy}
                  onCheckedChange={(v) => setReplaceEmpty(v === true)}
                />
                确认清空全部已选账号的{field === "category" ? "分类" : "备注"}
              </label>
            )}
          </FieldGroup>
          <details>
            <summary className="cursor-pointer text-sm">
              核对所选账号（{accounts.length}）
            </summary>
            <ul className="mt-2 flex max-h-44 flex-col gap-2 overflow-y-auto text-xs">
              {accounts.map((a) => (
                <li key={a.id} className="break-all">
                  {a.account_email} · {a.username || "无用户名"} · #{a.id}
                </li>
              ))}
            </ul>
          </details>
          <p className="text-xs text-muted-foreground">
            提交失败会保留选择和输入，可修正后重试。登记状态与邮箱实际连接状态分开记录。
          </p>
        </ModalBody>
        <ModalFooter>
          <Button
            type="button"
            variant="outline"
            disabled={action.busy}
            onClick={close}
          >
            取消
          </Button>
          <BusyButton
            type="submit"
            busy={action.busy}
            disabled={empty ? !replaceEmpty : !value}
          >
            应用到 {accounts.length} 个账号
          </BusyButton>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function ExportSelectedVault({
  accounts,
  close,
}: {
  accounts: SelectedAccount[];
  close: () => void;
}) {
  return (
    <AccountExportDialog
      kind="vault"
      title={`导出已选 ${accounts.length} 个账号`}
      endpoint={`/api/vault/export?ids=${accounts.map((a) => a.id).join(",")}`}
      close={close}
    />
  );
}

type AccountProps = {
  account: Vault;
  verify: () => void;
  totp: () => void;
  exportAccount: () => void;
  selected: boolean;
  selectionDisabled: boolean;
  select: (checked: boolean) => void;
};
function VaultAccountRow(props: AccountProps) {
  return <VaultAccountCard {...props} compact />;
}
function VaultAccountCard({
  account: a,
  verify,
  totp,
  exportAccount,
  selected,
  selectionDisabled,
  select,
  compact = false,
}: AccountProps & { compact?: boolean }) {
  const w = useWorkspace();
  const action = useAction({ inline: true });
  const health = a.mailbox;
  const canOpenInbox =
    a.email_source === "cf_domain" ||
    (a.email_source === "outlook" && !!health?.account_id);
  const openInbox = () => {
    if (a.email_source === "cf_domain") w.navigate("inbox", a.account_email);
    else if (a.email_source === "outlook" && health?.account_id)
      w.outlook(health.account_id, a.account_email);
  };
  const manage = () =>
    w.navigate(
      a.email_source === "outlook" ? "outlook" : "domains",
      a.email_source === "outlook" ? a.account_email : "",
    );
  const items = [
    { label: "编辑账号", icon: <Pencil />, action: () => w.vault(a) },
    { label: "导出账号 / 复制配置", icon: <Download />, action: exportAccount },
    {
      label: "打开收件箱",
      icon: <Inbox />,
      disabled: !canOpenInbox,
      action: openInbox,
    },
    {
      label: "查看动态口令",
      icon: <ShieldCheck />,
      disabled: !a.has_totp,
      action: totp,
    },
    {
      label: a.is_pinned ? "取消置顶" : "置顶账号",
      icon: <Pin />,
      disabled: action.busy,
      action: () => {
        void action.run(async () => {
          await api(`/api/vault/${a.id}/pin`, "POST");
          w.refresh();
        });
      },
    },
    {
      label: "复制密码",
      icon: <KeyRound />,
      disabled: !a.has_password || action.busy,
      action: () => {
        void action.run(async () => {
          const r = await api<Vault>(`/api/vault/${a.id}`);
          await copy(r.data.password, "密码");
        });
      },
    },
    {
      label: "打开平台",
      icon: <ExternalLink />,
      disabled: !safeUrl(a.platform_url),
      action: () =>
        window.open(safeUrl(a.platform_url), "_blank", "noopener,noreferrer"),
    },
    {
      label: "删除记录",
      icon: <Trash2 />,
      danger: true,
      action: () =>
        w.confirm(
          "删除平台账号？",
          `将删除 ${a.platform_name} 的 ${a.account_email} 记录。邮箱中的邮件会保留。`,
          async () => {
            await api(`/api/vault/${a.id}`, "DELETE");
            w.refresh();
          },
        ),
    },
  ];
  const checkbox = (
    <Checkbox
      checked={selected}
      disabled={selectionDisabled}
      onCheckedChange={(v) => select(v === true)}
      aria-label={`选择 ${a.account_email} #${a.id}`}
    />
  );
  if (compact)
    return (
      <TableRow
        data-state={selected ? "selected" : undefined}
        aria-label={`${a.account_email} 账号`}
      >
        <TableCell className="px-2 py-2">{checkbox}</TableCell>
        <th
          scope="row"
          className="min-w-44 max-w-64 px-2 py-2 text-left font-normal"
        >
          <div className="flex min-w-0 flex-col gap-1">
            <button
              className="text-left break-all hover:underline"
              onClick={() => w.vault(a)}
            >
              {a.account_email}
            </button>
            <p className="break-all text-xs text-muted-foreground">
              {a.username || "无用户名"} · {a.category || "未分类"}
            </p>
            <div className="flex flex-wrap gap-1">
              {!!a.is_pinned && (
                <Badge variant="outline">
                  <Pin />
                  置顶
                </Badge>
              )}
              {!!a.has_password && <Badge variant="outline">密码</Badge>}
              {!!a.has_totp && <Badge variant="outline">2FA</Badge>}
            </div>
          </div>
        </th>
        <TableCell className="px-2 py-2">
          <div className="flex flex-col items-start gap-1">
            <Badge
              variant={health?.needs_attention ? "destructive" : "outline"}
            >
              {health?.label || "邮箱状态待加载"}
            </Badge>
            <Badge
              variant={a.status === "banned" ? "destructive" : "secondary"}
            >
              登记：{statuses.find(([s]) => s === a.status)?.[1] || a.status}
            </Badge>
            {health?.message && (
              <details className="max-w-52 whitespace-normal text-xs text-muted-foreground">
                <summary className="cursor-pointer">状态详情</summary>
                <p className="mt-1">{health.message}</p>
                {health.checked_at && (
                  <p>最近检查：{date(health.checked_at)}</p>
                )}
              </details>
            )}
          </div>
        </TableCell>
        <TableCell className="min-w-44 px-2 py-2 whitespace-normal">
          <div className="flex flex-wrap items-center gap-1">
            {canOpenInbox && (
              <Button
                size="sm"
                variant="outline"
                onClick={openInbox}
                aria-label={`打开 ${a.account_email} 收件箱`}
              >
                <Inbox data-icon="inline-start" />
                收件箱
              </Button>
            )}
            {health?.can_lookup && (
              <Button
                size="sm"
                variant="secondary"
                onClick={verify}
                aria-label={`查收 ${a.account_email} 验证码或链接`}
              >
                取码
              </Button>
            )}
            {!!a.has_totp && (
              <Button
                size="sm"
                variant="outline"
                onClick={totp}
                aria-label={`查看 ${a.account_email} 动态口令`}
              >
                动态口令
              </Button>
            )}
            {health?.action && (
              <Button size="sm" variant="ghost" onClick={manage}>
                管理连接
              </Button>
            )}
            <CopyButton
              value={a.account_email}
              label={`复制 ${a.account_email}`}
            />
            <Menu label={`${a.account_email} 操作`} items={items} />
          </div>
          <ActionError message={action.error} />
        </TableCell>
      </TableRow>
    );
  return (
    <Card
      size="sm"
      aria-label={`${a.account_email} 账号`}
      className={cn("min-w-0 shrink-0", selected && "ring-2 ring-ring")}
    >
      <CardHeader>
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="pt-1">{checkbox}</div>
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle>
              <button
                className="text-left break-all hover:underline"
                onClick={() => w.vault(a)}
              >
                {a.account_email}
              </button>
            </CardTitle>
            <CardDescription className="break-all">
              {a.username || "未设置用户名"} · {a.category || "未分类"}
              {a.has_password ? " · 已保存密码" : ""}
              {a.has_totp ? " · 已启用 2FA" : ""}
            </CardDescription>
          </div>
          <div className="flex shrink-0 gap-1">
            <CopyButton value={a.account_email} label="复制邮箱" />
            <Menu label={`${a.account_email} 操作`} items={items} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Badge variant={health?.needs_attention ? "destructive" : "outline"}>
            {health?.label || "邮箱状态待加载"}
          </Badge>
          <Badge variant={a.status === "banned" ? "destructive" : "secondary"}>
            登记：{statuses.find(([s]) => s === a.status)?.[1] || a.status}
          </Badge>
          {!!a.is_pinned && (
            <Badge variant="outline">
              <Pin data-icon="inline-start" />
              已置顶
            </Badge>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">{health?.message}</p>
          {health?.checked_at && (
            <p className="text-xs text-muted-foreground">
              最近检查：{date(health.checked_at)}
            </p>
          )}
        </div>
        {a.last_code && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => copy(a.last_code)}
            >
              <Copy data-icon="inline-start" />
              {a.last_code}
            </Button>
            <span className="text-xs text-muted-foreground">
              历史验证码 · {date(a.last_code_at)}
            </span>
          </div>
        )}
        <ActionError message={action.error} />
      </CardContent>
      <CardFooter className="flex-wrap gap-2">
        {canOpenInbox && (
          <Button variant="outline" size="sm" onClick={openInbox}>
            <Inbox data-icon="inline-start" />
            打开收件箱
          </Button>
        )}
        {!!a.has_totp && (
          <Button variant="outline" size="sm" onClick={totp}>
            <ShieldCheck data-icon="inline-start" />
            查看动态口令
          </Button>
        )}
        {health?.can_lookup && (
          <Button variant="secondary" size="sm" onClick={verify}>
            <KeyRound data-icon="inline-start" />
            取码 / 链接
          </Button>
        )}
        {health?.action === "check_outlook" && (
          <BusyButton
            size="sm"
            variant="outline"
            busy={action.busy}
            onClick={() => {
              void action.run(async () => {
                try {
                  await api(
                    `/api/outlook/accounts/${health.account_id}/check`,
                    "POST",
                  );
                  toast.success("邮箱连接检查成功");
                } finally {
                  w.refresh();
                }
              });
            }}
          >
            <Activity data-icon="inline-start" />
            检查邮箱连接
          </BusyButton>
        )}
        {health?.action && (
          <Button variant="outline" size="sm" onClick={manage}>
            <Link data-icon="inline-start" />
            {health.action === "connect_outlook"
              ? "接入此 Outlook 邮箱"
              : health.action === "manage_domains"
                ? "检查收件域名"
                : "管理邮箱连接"}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => w.vault(a)}>
          <Pencil data-icon="inline-start" />
          编辑资料
        </Button>
      </CardFooter>
    </Card>
  );
}
export function VaultEditor({
  draft,
  close,
}: {
  draft: Partial<Vault>;
  close: () => void;
}) {
  const detail = useResource<Vault>(draft.id ? `/api/vault/${draft.id}` : null);
  return (
    <Modal
      title={draft.id ? "编辑平台账号" : "登记平台账号"}
      description="登记状态由你手动维护，邮箱连接状态由系统单独检查。关联的自建邮箱会自动永久保护。"
      close={close}
      wide
    >
      {draft.id && !detail.result ? (
        <ModalBody>
          {detail.error ? (
            <ErrorState message={detail.error} retry={detail.reload} />
          ) : (
            <Loading />
          )}
        </ModalBody>
      ) : (
        <VaultForm initial={detail.result?.data || draft} close={close} />
      )}
    </Modal>
  );
}

function PasswordField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<PasswordOptions>({
    ...defaultPasswordOptions,
  });
  const [length, setLength] = useState(String(defaultPasswordOptions.length));
  const [generated, setGenerated] = useState("");
  const [showGenerated, setShowGenerated] = useState(false);
  const [error, setError] = useState("");
  return (
    <Field className="sm:col-span-2">
      <FieldLabel htmlFor={id}>密码</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          type={visible ? "text" : "password"}
          autoComplete="new-password"
          maxLength={1000}
          spellCheck={false}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            aria-label={visible ? "隐藏账号密码" : "显示账号密码"}
            aria-pressed={visible}
            disabled={disabled}
            onClick={() => setVisible((v) => !v)}
          >
            {visible ? <EyeOff /> : <Eye />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-expanded={open}
          aria-controls={`${id}-generator`}
          disabled={disabled}
          onClick={() => {
            setOpen((v) => !v);
            setGenerated("");
            setShowGenerated(false);
            setError("");
          }}
        >
          <KeyRound data-icon="inline-start" />
          {open ? "收起密码生成器" : "生成安全密码"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || !value}
          onClick={() => void copy(value, "密码")}
        >
          <Copy data-icon="inline-start" />
          复制密码
        </Button>
      </div>
      {open && (
        <FieldGroup id={`${id}-generator`} className="rounded-lg border p-4">
          <FieldSet disabled={disabled}>
            <FieldLegend>密码生成规则</FieldLegend>
            <Field data-invalid={!!error}>
              <FieldLabel htmlFor={`${id}-length`}>
                密码长度（8–128）
              </FieldLabel>
              <Input
                id={`${id}-length`}
                inputMode="numeric"
                value={length}
                maxLength={3}
                aria-invalid={!!error}
                aria-describedby={error ? `${id}-error` : undefined}
                onChange={(e) => {
                  setLength(e.target.value);
                  setGenerated("");
                  setError("");
                }}
              />
            </Field>
            <div className="flex flex-wrap gap-x-5 gap-y-3">
              {(
                [
                  ["lowercase", "小写 a–z"],
                  ["uppercase", "大写 A–Z"],
                  ["digits", "数字 0–9"],
                  ["symbols", "符号 !@#…"],
                  ["excludeAmbiguous", "排除易混淆字符 Il1O0o|"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={options[key]}
                    onCheckedChange={(checked) => {
                      setOptions((old) => ({
                        ...old,
                        [key]: checked === true,
                      }));
                      setGenerated("");
                      setError("");
                    }}
                  />
                  {label}
                </label>
              ))}
            </div>
            <FieldDescription>
              每个已选字符组至少出现一次。密码只在本机生成，点击使用后才填入表单；保存账号后才提交。
            </FieldDescription>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                try {
                  if (!/^\d+$/.test(length))
                    throw new Error("密码长度必须是 8–128 的整数。");
                  setGenerated(
                    generatePassword({ ...options, length: Number(length) }),
                  );
                  setError("");
                } catch (e) {
                  setGenerated("");
                  setError(e instanceof Error ? e.message : "无法生成密码");
                }
              }}
            >
              {generated ? "重新生成" : "生成密码"}
            </Button>
            {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
            {generated && (
              <Field>
                <FieldLabel htmlFor={`${id}-preview`}>
                  生成结果（尚未填入）
                </FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id={`${id}-preview`}
                    readOnly
                    type={showGenerated ? "text" : "password"}
                    value={generated}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      aria-label={
                        showGenerated ? "隐藏生成密码" : "显示生成密码"
                      }
                      aria-pressed={showGenerated}
                      onClick={() => setShowGenerated((v) => !v)}
                    >
                      {showGenerated ? <EyeOff /> : <Eye />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void copy(generated, "生成的密码")}
                  >
                    <Copy data-icon="inline-start" />
                    复制生成结果
                  </Button>
                  <Button
                    type="button"
                    onClick={() => {
                      onChange(generated);
                      setGenerated("");
                      setOpen(false);
                      setShowGenerated(false);
                    }}
                  >
                    {value ? "使用并替换表单密码" : "使用此密码"}
                  </Button>
                </div>
              </Field>
            )}
          </FieldSet>
        </FieldGroup>
      )}
    </Field>
  );
}
function VaultForm({
  initial,
  close,
}: {
  initial: Partial<Vault>;
  close: () => void;
}) {
  const w = useWorkspace();
  const catalog = useResource<PlatformDefinition[]>(
    "/api/platforms",
    w.revision,
  );
  const action = useAction({ inline: true });
  const [totpError, setTotpError] = useState("");
  const [qrBusy, setQrBusy] = useState(false);
  const [data, setData] = useState({
    platform_name: "",
    platform_url: "",
    account_email: "",
    email_source: "cf_domain",
    username: "",
    password: "",
    totp_secret: "",
    category: "其他",
    status: "active",
    proxy_node: "",
    remark: "",
    ...initial,
  });
  const [domain, setDomain] = useState(
    w.settings?.domains.find((d) => d.is_default)?.domain ||
      w.settings?.domains.find((d) => d.enabled)?.domain ||
      "",
  );
  const set = (key: keyof typeof data, value: string) =>
    setData((d) => ({ ...d, [key]: value }));
  return (
    <form
      className="modal-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (qrBusy) return;
        void action.run(async () => {
          let totp_secret = "";
          try {
            if (data.totp_secret?.trim())
              totp_secret = normalizeTotp(data.totp_secret);
            setTotpError("");
          } catch (error) {
            setTotpError(
              error instanceof Error ? error.message : "2FA 配置无效",
            );
            throw error;
          }
          await api(
            `/api/vault${initial.id ? `/${initial.id}` : ""}`,
            initial.id ? "PUT" : "POST",
            { ...data, totp_secret },
          );
          toast.success("平台账号已保存");
          w.refresh();
          close();
        });
      }}
    >
      <ModalBody>
        <ActionError message={action.error} />
        <fieldset disabled={action.busy} className="contents">
          <FieldGroup className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field className="sm:col-span-2">
              <SelectField
                label="选择已有平台"
                value=""
                onChange={(value) => {
                  const platform = catalog.result?.data.find(
                    (p) => p.name === value,
                  );
                  if (platform)
                    setData((old) => ({
                      ...old,
                      platform_name: platform.name,
                      platform_url: platform.url,
                      category: platform.category,
                    }));
                }}
                options={[
                  ["", "选择平台，自动填入名称、官网和分类"],
                  ...(catalog.result?.data || []).map(
                    (p) => [p.name, p.name] as [string, string],
                  ),
                ]}
              />
              <FieldDescription>
                也可直接在下方填写新平台名称，保存账号时自动建立平台。
              </FieldDescription>
            </Field>
            <TextField
              label="平台名称"
              required
              maxLength={100}
              value={data.platform_name}
              onChange={(e) => set("platform_name", e.target.value)}
              placeholder="例如 GitHub"
            />
            <TextField
              label="平台官网"
              type="url"
              value={data.platform_url}
              onChange={(e) => set("platform_url", e.target.value)}
              placeholder="https://…"
            />
            <TextField
              label="登录邮箱"
              type="email"
              required
              value={data.account_email}
              onChange={(e) => set("account_email", e.target.value)}
            />
            <SelectField
              label="邮箱来源"
              value={data.email_source}
              onChange={(v) => set("email_source", v)}
              options={sources}
            />
            {!initial.id && (
              <Field className="sm:col-span-2">
                <FieldLabel>为这个账号分配新邮箱</FieldLabel>
                <div className="flex flex-wrap gap-2">
                  <Pick
                    label="分配域名"
                    value={domain}
                    onChange={setDomain}
                    options={(w.settings?.domains || [])
                      .filter((d) => d.enabled)
                      .map((d) => [d.domain, d.domain])}
                  />
                  <BusyButton
                    type="button"
                    variant="outline"
                    busy={action.busy}
                    disabled={!domain}
                    onClick={() => {
                      void action.run(async () => {
                        const r = await api<Mailbox>(
                          "/api/mailboxes/generate",
                          "POST",
                          { domain, duration_minutes: 60 },
                        );
                        setData((d) => ({
                          ...d,
                          account_email: r.data.address,
                          email_source: "cf_domain",
                        }));
                      });
                    }}
                  >
                    生成地址
                  </BusyButton>
                </div>
              </Field>
            )}
            <TextField
              label="用户名"
              value={data.username}
              onChange={(e) => set("username", e.target.value)}
            />
            <PasswordField
              value={data.password || ""}
              onChange={(value) => set("password", value)}
              disabled={action.busy}
            />
            <TextField
              label="分类"
              value={data.category}
              onChange={(e) => set("category", e.target.value)}
            />
            <SelectField
              label="登记状态（手动维护）"
              value={data.status}
              onChange={(v) => set("status", v)}
              options={statuses}
            />
            <TotpField
              value={data.totp_secret || ""}
              error={totpError}
              disabled={action.busy}
              onBusyChange={setQrBusy}
              onChange={(value) => {
                set("totp_secret", value);
                setTotpError("");
              }}
            />
            <TextField
              label="代理节点 / 环境"
              value={data.proxy_node}
              onChange={(e) => set("proxy_node", e.target.value)}
            />
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="vault-note">备注</FieldLabel>
              <Textarea
                id="vault-note"
                value={data.remark}
                onChange={(e) => set("remark", e.target.value)}
              />
            </Field>
          </FieldGroup>
        </fieldset>
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="outline" onClick={close}>
          取消
        </Button>
        <BusyButton type="submit" busy={action.busy} disabled={qrBusy}>
          保存账号
        </BusyButton>
      </ModalFooter>
    </form>
  );
}
