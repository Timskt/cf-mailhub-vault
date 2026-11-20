import {
  ActionError,
  Blank,
  BusyButton,
  CopyAction,
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
  Status,
  TextField,
} from "@/components/common";
import { CredentialField } from "@/components/credential-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldGroup } from "@/components/ui/field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  PollingControls,
  VerificationLookup,
  VerificationActions,
  type VerificationTarget,
} from "@/features/verification";
import { RelatedVaultAccounts } from "@/features/readers";
import { useSmartPolling } from "@/hooks/use-smart-polling";
import {
  api,
  date,
  query,
  useAction,
  useDebounce,
  useResource,
} from "@/lib/api";
import { useWorkspace } from "@/lib/context";
import { mailHtml } from "@/lib/mail-html";
import { generatePassword } from "@/lib/password-generator";
import {
  ArrowLeft,
  ExternalLink,
  KeyRound,
  List,
  Link,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Rows3,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  mailProviders,
  type MailProviderId,
  type ProviderAccountSummary,
  type ProviderMail,
} from "../../shared/mail-providers";

type Detail = ProviderAccountSummary & {
  password: string;
  credential_version: string;
};
type Catalog = {
  id: MailProviderId;
  name: string;
  url: string;
  docs: string;
  credential_label: string;
  description: string;
  integration_hint: string;
  can_create: boolean;
  account_count: number;
  attention_count: number;
};
const name = (provider: string) =>
  mailProviders.find((p) => p.id === provider)?.name || provider;
const providerLayoutPreference = "mailhub:providers:layout";

export default function ProvidersPage({
  initialQuery = "",
}: {
  initialQuery?: string;
}) {
  const w = useWorkspace();
  const [q, setQ] = useState(initialQuery),
    [provider, setProvider] = useState(""),
    [status, setStatus] = useState("all"),
    [page, setPage] = useState(1),
    [limit, setLimit] = useState(30);
  const [layout, setLayout] = useState<"comfortable" | "compact">(() => {
    try {
      return localStorage.getItem(providerLayoutPreference) === "comfortable"
        ? "comfortable"
        : "compact";
    } catch {
      return "compact";
    }
  });
  const [selected, setSelected] = useState<Map<number, ProviderAccountSummary>>(
    () => new Map(),
  );
  const search = useDebounce(q);
  const [editor, setEditor] = useState<{
    id?: number;
    provider?: MailProviderId;
    mode?: "create" | "connect";
  } | null>(null);
  const [reader, setReader] = useState<ProviderAccountSummary | null>(null);
  const [verification, setVerification] = useState<VerificationTarget | null>(
    null,
  );
  const action = useAction({ inline: true });
  const catalog = useResource<Catalog[]>("/api/providers", w.revision);
  const rows = useResource<ProviderAccountSummary[]>(
    `/api/providers/accounts?${query({ q: search, provider, status, page, limit })}`,
    w.revision,
    { keepPreviousData: true },
  );
  const visibleAccounts = rows.result?.data || [];
  const visibleIds = visibleAccounts.map((account) => account.id);
  const selectedAccounts = [...selected.values()].sort(
    (left, right) => left.id - right.id,
  );
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const accountCount = (catalog.result?.data || []).reduce(
    (count, item) => count + item.account_count,
    0,
  );
  const attentionCount = (catalog.result?.data || []).reduce(
    (count, item) => count + item.attention_count,
    0,
  );
  useEffect(() => {
    setSelected((current) => {
      if (!current.size) return current;
      const next = new Map(current);
      for (const account of visibleAccounts)
        if (next.has(account.id)) next.set(account.id, account);
      return next;
    });
  }, [rows.result]);
  const filterProvider = (value: string) => {
    setProvider(value);
    setPage(1);
    setSelected(new Map());
  };
  const toggleAccount = (account: ProviderAccountSummary, checked: boolean) =>
    setSelected((current) => {
      const next = new Map(current);
      if (checked) next.set(account.id, account);
      else next.delete(account.id);
      return next;
    });
  const toggleVisible = (checked: boolean) =>
    setSelected((current) => {
      const next = new Map(current);
      for (const account of visibleAccounts) {
        if (checked) next.set(account.id, account);
        else next.delete(account.id);
      }
      return next;
    });
  const check = (account: ProviderAccountSummary) =>
    void action.run(async () => {
      try {
        const r = await api(
          `/api/providers/accounts/${account.id}/check`,
          "POST",
        );
        toast.success(r.message);
      } finally {
        w.refresh();
      }
    });
  const verify = (account: ProviderAccountSummary) =>
    setVerification({
      path: `/api/providers/accounts/${account.id}/code`,
      label: `${name(account.provider)} · ${account.address}`,
    });
  const renderAccountActions = (
    account: ProviderAccountSummary,
    compact = false,
  ) => (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
      <Button
        size={compact ? "icon" : "sm"}
        variant="outline"
        aria-label={compact ? `查看全部登记 · ${account.address}` : undefined}
        title={compact ? "查看全部登记" : undefined}
        onClick={() =>
          w.identity({ address: account.address, source: account.provider })
        }
      >
        <Link data-icon={compact ? undefined : "inline-start"} />
        {!compact && "登记"}
      </Button>
      <Button
        size={compact ? "icon" : "sm"}
        variant="outline"
        disabled={account.status !== "active"}
        aria-label={compact ? `收件 · ${account.address}` : undefined}
        title={compact ? "收件" : undefined}
        onClick={() => setReader(account)}
      >
        <Mail data-icon={compact ? undefined : "inline-start"} />
        {!compact && "收件"}
      </Button>
      <Button
        size={compact ? "icon" : "sm"}
        variant="outline"
        disabled={account.status !== "active"}
        aria-label={compact ? `取码 / 链接 · ${account.address}` : undefined}
        title={compact ? "取码 / 链接" : undefined}
        onClick={() => verify(account)}
      >
        <KeyRound data-icon={compact ? undefined : "inline-start"} />
        {!compact && "取码"}
      </Button>
      <Menu
        label={`邮箱操作：${account.address}`}
        items={[
          {
            label: "编辑账号 / 查看密码",
            icon: <Pencil />,
            action: () => setEditor({ id: account.id }),
          },
          {
            label: "测试连接",
            icon: <RefreshCw />,
            disabled: action.busy || account.status !== "active",
            action: () => check(account),
          },
          {
            label: "登记平台账号",
            icon: <Link />,
            action: () =>
              w.vault({
                account_email: account.address,
                email_source: account.provider,
              }),
          },
          {
            label: "查看全部登记",
            icon: <Link />,
            action: () =>
              w.identity({
                address: account.address,
                source: account.provider,
              }),
          },
          {
            label: "移除接入",
            icon: <Trash2 />,
            danger: true,
            action: () =>
              w.confirm(
                "移除此邮箱接入？",
                `${account.address} 将从本平台移除，服务商邮箱仍保留。已关联平台的账号需要先调整绑定。`,
                async () => {
                  const r = await api(
                    `/api/providers/accounts/${account.id}`,
                    "DELETE",
                  );
                  toast.success(r.message);
                  w.refresh();
                },
              ),
          },
        ]}
      />
    </div>
  );
  return (
    <>
      <PageHeader
        title="外部邮箱"
        description="统一查收第三方邮箱并关联平台账号。共享临时邮箱可能限流或回收；长期使用优先选择自有域名或 Outlook。"
      >
        <Button
          variant="outline"
          onClick={() => setEditor({ mode: "connect" })}
        >
          <Link data-icon="inline-start" />
          接入已有邮箱
        </Button>
        <Button onClick={() => setEditor({ mode: "create" })}>
          <Plus data-icon="inline-start" />
          创建外部邮箱
        </Button>
      </PageHeader>
      <div
        className="provider-source-filters mb-3"
        role="group"
        aria-label="按邮箱来源筛选"
        tabIndex={0}
      >
        <Button
          size="sm"
          variant={!provider ? "secondary" : "outline"}
          aria-pressed={!provider}
          onClick={() => filterProvider("")}
        >
          全部来源 <span className="tabular-nums">{accountCount}</span>
        </Button>
        {[
          {
            label: "短期邮箱",
            providers: mailProviders.filter((item) => item.canCreate),
          },
          {
            label: "QA 测试 Inbox",
            providers: mailProviders.filter((item) => !item.canCreate),
          },
        ].map((group) => (
          <div
            key={group.label}
            className="provider-source-group"
            role="group"
            aria-label={`${group.label}来源`}
          >
            <span className="provider-source-label">{group.label}</span>
            {group.providers.map((p) => {
              const stats = catalog.result?.data.find((s) => s.id === p.id);
              return (
                <Button
                  key={p.id}
                  size="sm"
                  variant={provider === p.id ? "secondary" : "outline"}
                  aria-pressed={provider === p.id}
                  title={
                    p.canCreate
                      ? "共享短期邮箱，域名和保留时间由服务商决定"
                      : "面向邮件自动化测试的服务，不是通用临时邮箱"
                  }
                  onClick={() => filterProvider(p.id)}
                >
                  {p.name}
                  <span className="tabular-nums">
                    {stats?.account_count ?? "—"}
                  </span>
                  {!!stats?.attention_count && (
                    <span className="text-destructive">
                      {stats.attention_count} 需处理
                    </span>
                  )}
                </Button>
              );
            })}
          </div>
        ))}
        <Button
          size="sm"
          variant={status === "attention" ? "secondary" : "outline"}
          aria-pressed={status === "attention"}
          onClick={() => {
            setStatus(status === "attention" ? "all" : "attention");
            setPage(1);
            setSelected(new Map());
          }}
        >
          需处理 <span className="tabular-nums">{attentionCount}</span>
        </Button>
      </div>
      <details className="mb-4 rounded-lg border bg-card">
        <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
          <span>服务商与接入方式</span>
          <span className="text-xs font-normal text-muted-foreground">
            {mailProviders.length} 个来源 · {accountCount} 个邮箱
          </span>
        </summary>
        <div className="grid gap-3 border-t p-3 md:grid-cols-2">
          {mailProviders.map((p) => {
            const stats = catalog.result?.data.find((s) => s.id === p.id);
            return (
              <section
                key={p.id}
                className="flex min-w-0 flex-col gap-2 border-b pb-3 last:border-b-0 last:pb-0 md:rounded-md md:border md:p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold">{p.name}</h2>
                      <Badge variant="outline">
                        {p.id === "mailtm" || p.id === "mailgw"
                          ? "共享临时邮箱"
                          : p.id === "mailinator"
                            ? "QA 测试 · 私有域"
                            : "QA 测试 Inbox"}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {stats?.description || p.description}
                    </p>
                  </div>
                  <a
                    className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:underline"
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    服务商 <ExternalLink className="size-3" />
                  </a>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {stats?.integration_hint || p.integrationHint}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">
                    {stats?.account_count ?? "—"} 个邮箱
                  </Badge>
                  {!!stats?.attention_count && (
                    <Badge variant="destructive">
                      {stats.attention_count} 个需处理
                    </Badge>
                  )}
                  {p.canCreate ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setEditor({ provider: p.id, mode: "create" })
                      }
                    >
                      创建邮箱
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setEditor({ provider: p.id, mode: "connect" })
                      }
                    >
                      {p.id === "mailinator"
                        ? "接入私有邮箱"
                        : "接入已有 Inbox"}
                    </Button>
                  )}
                  <a
                    className="px-2 text-xs text-muted-foreground hover:underline"
                    href={p.docs}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    API 文档
                  </a>
                </div>
              </section>
            );
          })}
          <p className="text-xs leading-relaxed text-muted-foreground md:col-span-2">
            邮件保留时间和账号有效期由服务商决定。平台保存登录凭据，令牌失效时自动重新登录；服务商删除邮箱后需要重新接入可用账号。
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground md:col-span-2">
            免费共享临时邮箱可能被限流或回收，不建议作为唯一长期账号邮箱。长期使用优先选择自有域名或
            Outlook；Mail.tm 与 Mail.gw 属于同一 API 家族，互不构成备份。
          </p>
        </div>
      </details>
      <ActionError message={action.error || catalog.error} />
      <div
        className="data-panel provider-account-panel"
        data-account-layout={layout}
        aria-busy={rows.loading}
      >
        <div className="filter-bar">
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              setPage(1);
              setSelected(new Map());
            }}
            placeholder="搜索外部邮箱或用途…"
          />
          <Pick
            label="账号状态筛选"
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
              setSelected(new Map());
            }}
            options={[
              ["all", "全部状态"],
              ["active", "启用"],
              ["attention", "需要处理"],
              ["disabled", "停用"],
            ]}
          />
          <Pick
            label="每页条数"
            value={String(limit)}
            onChange={(value) => {
              setLimit(Number(value));
              setPage(1);
              setSelected(new Map());
            }}
            options={[
              ["30", "每页 30 条"],
              ["50", "每页 50 条"],
              ["100", "每页 100 条"],
            ]}
          />
          <Tabs
            value={layout}
            onValueChange={(value) => {
              const next = value as "comfortable" | "compact";
              setLayout(next);
              try {
                localStorage.setItem(providerLayoutPreference, next);
              } catch {
                // Keep the preference for this view when storage is unavailable.
              }
            }}
          >
            <TabsList aria-label="账号列表密度">
              <TabsTrigger value="comfortable" title="舒展列表">
                <List data-icon="inline-start" />
                舒展
              </TabsTrigger>
              <TabsTrigger value="compact" title="紧凑表格">
                <Rows3 data-icon="inline-start" />
                紧凑
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <RefreshButton
            busy={rows.loading}
            onClick={() => {
              rows.reload();
              catalog.reload();
            }}
          />
        </div>
        {!rows.error && rows.result?.data.length ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                aria-label="选择全部当前页"
                checked={allVisibleSelected}
                onCheckedChange={(checked) => toggleVisible(checked === true)}
              />
              <span>
                {selected.size
                  ? `已选择 ${selected.size} 个账号（本页 ${visibleAccounts.filter((account) => selected.has(account.id)).length} 个）`
                  : `当前页 ${visibleAccounts.length} 个账号`}
              </span>
            </div>
            {selected.size > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <CopyAction
                  label="复制选中邮箱"
                  value={selectedAccounts
                    .map((account) => account.address)
                    .join("\n")}
                  size="sm"
                  variant="outline"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelected(new Map())}
                >
                  清除选择
                </Button>
              </div>
            )}
          </div>
        ) : null}
        {rows.error ? (
          <ErrorState message={rows.error} retry={rows.reload} />
        ) : !rows.result ? (
          <Loading />
        ) : !rows.result.data.length ? (
          <Blank
            title="尚无匹配的外部邮箱"
            description="Mail.tm / Mail.gw 可创建短期邮箱；MailSlurp 与 Mailinator 是需 API Key 的邮件测试服务。长期账号优先使用自有域名或 Outlook。"
          />
        ) : (
          <div className="provider-account-cards divide-y">
            {rows.result.data.map((a) => (
              <article
                key={a.id}
                className="provider-account-row flex min-w-0 flex-col gap-3 p-4 sm:flex-row sm:items-center"
                aria-label={`外部邮箱 ${a.address}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-start gap-2">
                    <Checkbox
                      aria-label={`选择 ${a.address}`}
                      checked={selected.has(a.id)}
                      onCheckedChange={(checked) =>
                        toggleAccount(a, checked === true)
                      }
                    />
                    <span className="min-w-0 [overflow-wrap:anywhere] font-medium">
                      {a.address}
                    </span>
                    <CopyButton value={a.address} label="复制邮箱" />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{name(a.provider)}</Badge>
                    <Status
                      value={
                        a.status === "disabled" ? "disabled" : a.auth_status
                      }
                    />
                    <span className="text-xs text-muted-foreground">
                      {a.remark || "未填写用途"}
                    </span>
                  </div>
                  {a.last_error && (
                    <p className="mt-2 break-words text-sm text-destructive">
                      {a.last_error}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    最近检查：{date(a.last_checked_at)}
                  </p>
                </div>
                {renderAccountActions(a)}
              </article>
            ))}
          </div>
        )}
        {!rows.error && rows.result?.data.length ? (
          <div className="provider-account-table overflow-x-auto">
            <Table aria-label="外部邮箱账号紧凑列表" className="min-w-[940px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-9">
                    <span className="sr-only">选择</span>
                  </TableHead>
                  <TableHead>邮箱地址</TableHead>
                  <TableHead>来源 / 状态</TableHead>
                  <TableHead>用途 / 最近异常</TableHead>
                  <TableHead>最近检查</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.result.data.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <Checkbox
                        aria-label={`选择 ${a.address}`}
                        checked={selected.has(a.id)}
                        onCheckedChange={(checked) =>
                          toggleAccount(a, checked === true)
                        }
                      />
                    </TableCell>
                    <TableCell className="max-w-[280px]">
                      <div className="flex min-w-0 items-center gap-1">
                        <span
                          className="truncate font-medium"
                          title={a.address}
                        >
                          {a.address}
                        </span>
                        <CopyButton value={a.address} label="复制邮箱" />
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{name(a.provider)}</Badge>
                        <Status
                          value={
                            a.status === "disabled" ? "disabled" : a.auth_status
                          }
                        />
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[320px] whitespace-normal">
                      <span className="block truncate" title={a.remark}>
                        {a.remark || "未填写用途"}
                      </span>
                      {a.last_error && (
                        <span
                          className="mt-1 block truncate text-xs text-destructive"
                          title={a.last_error}
                        >
                          {a.last_error}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {date(a.last_checked_at)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        {renderAccountActions(a, true)}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
        <Pager result={rows.result} page={page} setPage={setPage} />
      </div>
      {editor && <ProviderEditor {...editor} close={() => setEditor(null)} />}
      {reader && (
        <ProviderReader
          account={reader}
          close={() => {
            setReader(null);
            w.refresh();
          }}
          edit={() => {
            setReader(null);
            setEditor({ id: reader.id });
          }}
        />
      )}
      {verification && (
        <ProviderVerification
          target={verification}
          close={() => {
            setVerification(null);
            w.refresh();
          }}
        />
      )}
    </>
  );
}
function ProviderEditor({
  id,
  provider,
  mode,
  close,
}: {
  id?: number;
  provider?: MailProviderId;
  mode?: "create" | "connect";
  close: () => void;
}) {
  const detail = useResource<Detail>(
    id ? `/api/providers/accounts/${id}` : null,
  );
  return (
    <Modal
      title={id ? "编辑外部邮箱" : "接入外部邮箱"}
      description={
        id
          ? "已显示保存的服务商凭据。修改这里只更新本地接入信息，不会修改服务商账户。"
          : "选择服务商并接入邮箱；凭据会加密保存在工作区。"
      }
      close={close}
      wide
    >
      {id && !detail.result ? (
        <ModalBody>
          {detail.error ? (
            <ErrorState message={detail.error} retry={detail.reload} />
          ) : (
            <Loading />
          )}
        </ModalBody>
      ) : (
        <ProviderForm
          initial={detail.result?.data}
          provider={provider}
          mode={mode}
          close={close}
        />
      )}
    </Modal>
  );
}
function ProviderForm({
  initial,
  provider: seedProvider,
  mode: seedMode,
  close,
}: {
  initial?: Detail;
  provider?: MailProviderId;
  mode?: "create" | "connect";
  close: () => void;
}) {
  const w = useWorkspace(),
    action = useAction({ inline: true });
  const initialProvider = initial?.provider || seedProvider || "mailtm";
  const [provider, setProvider] = useState<MailProviderId>(initialProvider),
    [mode, setMode] = useState<"create" | "connect">(
      seedMode === "create" &&
        !mailProviders.find((p) => p.id === initialProvider)?.canCreate
        ? "connect"
        : seedMode || "connect",
    );
  const selectedProvider = mailProviders.find((p) => p.id === provider)!;
  const [address, setAddress] = useState(initial?.address || ""),
    [password, setPassword] = useState(
      initial?.password || (seedMode === "create" ? generatePassword() : ""),
    );
  const [remark, setRemark] = useState(initial?.remark || ""),
    [status, setStatus] = useState(initial?.status || "active");
  const [prefix, setPrefix] = useState(
      () => `mail${crypto.randomUUID().slice(0, 8)}`,
    ),
    [domain, setDomain] = useState(""),
    [domainPage, setDomainPage] = useState(1);
  const [attemptedCreate, setAttemptedCreate] = useState(false);
  const modePanelId = useId();
  const creating = !initial && mode === "create";
  const domains = useResource<{ domain: string }[]>(
    creating ? `/api/providers/${provider}/domains?page=${domainPage}` : null,
  );
  const selectedDomain = domain || domains.result?.data[0]?.domain || "";
  const effectiveAddress = creating ? `${prefix}@${selectedDomain}` : address;
  return (
    <form
      className="modal-form"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(async () => {
          if (creating && attemptedCreate) return;
          if (creating) setAttemptedCreate(true);
          try {
            const r = await api(
              `/api/providers/accounts${initial ? `/${initial.id}` : ""}`,
              initial ? "PUT" : "POST",
              initial
                ? {
                    password,
                    remark,
                    status,
                    credential_version: initial.credential_version,
                  }
                : {
                    provider,
                    mode,
                    address: effectiveAddress,
                    password,
                    remark,
                  },
            );
            toast.success(r.message);
            close();
          } finally {
            w.refresh();
          }
        });
      }}
    >
      <ModalBody>
        <fieldset
          disabled={action.busy || attemptedCreate}
          className="contents"
        >
          <FieldGroup id={modePanelId}>
            {!initial && (
              <>
                {selectedProvider.canCreate && (
                  <Tabs
                    value={mode}
                    onValueChange={(value) => {
                      setMode(value as "create" | "connect");
                      if (value === "create" && !password)
                        setPassword(generatePassword());
                    }}
                  >
                    <TabsList className="w-full">
                      <TabsTrigger
                        className="text-foreground"
                        aria-controls={modePanelId}
                        value="connect"
                      >
                        接入已有账号
                      </TabsTrigger>
                      <TabsTrigger
                        className="text-foreground"
                        aria-controls={modePanelId}
                        value="create"
                      >
                        创建新邮箱
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                )}
                <SelectField
                  label="邮箱服务商"
                  value={provider}
                  onChange={(value) => {
                    const next = value as MailProviderId;
                    setProvider(next);
                    if (!mailProviders.find((p) => p.id === next)?.canCreate)
                      setMode("connect");
                    setDomain("");
                    setDomainPage(1);
                  }}
                  options={mailProviders.map((p) => [p.id, p.name])}
                />
              </>
            )}
            {creating ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    label="地址前缀"
                    required
                    maxLength={64}
                    pattern="[a-zA-Z0-9._-]{3,64}"
                    value={prefix}
                    onChange={(e) => setPrefix(e.target.value)}
                  />
                  <div className="flex flex-col gap-2">
                    {domains.error ? (
                      <ErrorState
                        message={domains.error}
                        retry={domains.reload}
                      />
                    ) : !domains.result ? (
                      <Loading />
                    ) : (
                      <SelectField
                        label="服务商域名"
                        value={selectedDomain}
                        onChange={setDomain}
                        options={domains.result.data.map((d) => [
                          d.domain,
                          d.domain,
                        ])}
                      />
                    )}
                    <Pager
                      result={domains.result}
                      page={domainPage}
                      setPage={(page) => {
                        setDomainPage(page);
                        setDomain("");
                      }}
                    />
                  </div>
                </div>
                {selectedDomain && (
                  <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg bg-muted p-3">
                    <span className="break-all text-sm">
                      {effectiveAddress}
                    </span>
                    <CopyButton
                      value={effectiveAddress}
                      label="复制新邮箱地址"
                    />
                  </div>
                )}
                {domains.result && !domains.result.data.length && (
                  <p className="text-sm text-muted-foreground">
                    此页没有可用域名，请切换页码或稍后刷新。
                  </p>
                )}
              </>
            ) : (
              <TextField
                label="邮箱地址"
                type="email"
                required
                readOnly={!!initial}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            )}
            <CredentialField
              label={selectedProvider.credentialLabel}
              required
              minLength={creating ? 8 : 1}
              value={password}
              onChange={setPassword}
              disabled={action.busy || attemptedCreate}
            />
            {provider === "mailslurp" && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                这里填写 MailSlurp API Key，不是邮箱密码。请先在 MailSlurp 创建
                Inbox；本平台只接入已有 Inbox，不会替你创建服务商资源。
              </p>
            )}
            {provider === "mailinator" && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                这里只支持 Mailinator 私有域。邮箱域名必须属于当前团队，并已在
                Team Settings 中验证；不要接入公共收件箱，因为任何人都可以读取。
                本平台仅查收，不创建或删除 Mailinator 资源。
              </p>
            )}
            {creating && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setPassword(generatePassword())}
              >
                <KeyRound data-icon="inline-start" />
                重新生成密码
              </Button>
            )}
            <TextField
              label="用途备注"
              maxLength={1000}
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
            />
            {initial && (
              <SelectField
                label="账号状态"
                value={status}
                onChange={(v) => setStatus(v as "active" | "disabled")}
                options={[
                  ["active", "启用"],
                  ["disabled", "停用"],
                ]}
              />
            )}
          </FieldGroup>
        </fieldset>
      </ModalBody>
      {action.error && (
        <div className="max-h-32 shrink-0 overflow-y-auto border-t px-5 py-3">
          <ActionError message={action.error} />
        </div>
      )}
      <ModalFooter>
        <Button
          type="button"
          variant="outline"
          disabled={action.busy}
          onClick={close}
        >
          {attemptedCreate ? "返回账号列表" : "取消"}
        </Button>
        <BusyButton
          type="submit"
          busy={action.busy}
          disabled={
            attemptedCreate ||
            (creating &&
              (!selectedDomain || domains.loading || !!domains.error))
          }
        >
          {initial ? "保存账号" : creating ? "创建并保存" : "验证并接入"}
        </BusyButton>
      </ModalFooter>
    </form>
  );
}
function ProviderReader({
  account,
  close,
  edit,
}: {
  account: ProviderAccountSummary;
  close: () => void;
  edit: () => void;
}) {
  const [page, setPage] = useState(1),
    [selected, setSelected] = useState<string | null>(null),
    [verify, setVerify] = useState(false);
  const rows = useSmartPolling<ProviderMail[]>(
    !selected && !verify
      ? `/api/providers/accounts/${account.id}/messages?page=${page}`
      : null,
  );
  const detail = useResource<ProviderMail>(
    selected
      ? `/api/providers/accounts/${account.id}/messages/${encodeURIComponent(selected)}`
      : null,
  );
  return (
    <>
      <Modal
        title={`${name(account.provider)} 收件箱`}
        description={account.address}
        close={close}
        wide
      >
        <ModalBody>
          <div className="flex flex-wrap gap-2">
            <CopyAction
              size="sm"
              variant="outline"
              value={account.address}
              label="复制邮箱"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                rows.stop();
                setVerify(true);
              }}
            >
              <KeyRound data-icon="inline-start" />
              查看验证码 / 链接
            </Button>
            <Button size="sm" variant="ghost" onClick={edit}>
              编辑账号 / 查看密码
            </Button>
          </div>
          <RelatedVaultAccounts
            email={account.address}
            source={account.provider}
          />
          {selected ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelected(null)}
              >
                <ArrowLeft data-icon="inline-start" />
                返回邮件列表
              </Button>
              {detail.error ? (
                <ErrorState message={detail.error} retry={detail.reload} />
              ) : !detail.result ? (
                <Loading />
              ) : (
                <ProviderMessage mail={detail.result.data} />
              )}
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <PollingControls polling={rows} disabled={page > 1 || verify} />
                <RefreshButton busy={rows.loading} onClick={rows.reload} />
              </div>
              {rows.error ? (
                <ErrorState message={rows.error} retry={rows.reload} />
              ) : !rows.result ? (
                <Loading />
              ) : !rows.result.data.length ? (
                <Blank
                  title="还没有收到邮件"
                  description="可复制邮箱地址使用，点击刷新或开启自动查收。"
                />
              ) : (
                <div className="divide-y rounded-lg border">
                  {rows.result.data.map((m) => (
                    <article
                      key={m.id}
                      className="flex min-w-0 flex-col gap-2 p-4"
                    >
                      <button
                        type="button"
                        className="min-w-0 text-left"
                        onClick={() => {
                          rows.stop();
                          setSelected(m.id);
                        }}
                      >
                        <span className="block break-words font-medium">
                          {m.subject || "（无主题）"}
                        </span>
                        <span className="mt-1 block break-all text-xs text-muted-foreground">
                          {m.sender_name || m.sender} · {date(m.created_at)}
                        </span>
                        <span className="mt-2 line-clamp-2 break-words text-sm text-muted-foreground">
                          {m.text_content}
                        </span>
                      </button>
                      <VerificationActions
                        code={m.verification_code}
                        link={m.verification_link}
                      />
                    </article>
                  ))}
                </div>
              )}
              <Pager
                result={rows.result}
                page={page}
                setPage={(value) => {
                  rows.stop();
                  setPage(value);
                }}
              />
            </>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="outline" onClick={close}>
            关闭收件箱
          </Button>
        </ModalFooter>
      </Modal>
      {verify && (
        <ProviderVerification
          target={{
            path: `/api/providers/accounts/${account.id}/code`,
            label: account.address,
          }}
          close={() => setVerify(false)}
        />
      )}
    </>
  );
}
function ProviderMessage({ mail }: { mail: ProviderMail }) {
  const [mode, setMode] = useState(mail.html_content ? "html" : "text");
  const html = useMemo(() => mailHtml(mail.html_content), [mail.html_content]);
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <h3 className="break-words text-lg font-semibold">
        {mail.subject || "（无主题）"}
      </h3>
      <p className="break-all text-xs text-muted-foreground">
        {mail.sender} · {date(mail.created_at)}
      </p>
      <VerificationActions
        code={mail.verification_code}
        link={mail.verification_link}
      />
      <Tabs value={mode} onValueChange={setMode}>
        <TabsList>
          <TabsTrigger className="text-foreground" value="text">
            纯文本
          </TabsTrigger>
          {mail.html_content && (
            <TabsTrigger className="text-foreground" value="html">
              邮件排版
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="html">
          <iframe
            title="外部邮件内容"
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            srcDoc={html}
            className="min-h-80 w-full rounded-lg border bg-white"
          />
        </TabsContent>
        <TabsContent value="text">
          <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted p-4 font-sans text-sm">
            {mail.text_content || "这封邮件没有纯文本内容"}
          </pre>
        </TabsContent>
      </Tabs>
      {mail.has_attachments && (
        <p className="text-xs text-muted-foreground">
          邮件含附件，可在服务商网站查看。
        </p>
      )}
    </section>
  );
}

function ProviderVerification({
  target,
  close,
}: {
  target: VerificationTarget;
  close: () => void;
}) {
  return (
    <Modal
      title="外部邮箱验证码 / 链接"
      description={target.label}
      close={close}
      wide
    >
      <ModalBody>
        <VerificationLookup path={target.path} />
      </ModalBody>
      <ModalFooter>
        <Button variant="outline" onClick={close}>
          关闭查收
        </Button>
      </ModalFooter>
    </Modal>
  );
}
