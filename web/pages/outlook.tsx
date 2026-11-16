import {
  QuickVerification,
  type VerificationTarget,
} from "@/features/verification";
import { AccountExportDialog } from "@/features/account-export";
import {
  ActionError,
  Blank,
  BusyButton,
  ErrorState,
  IconButton,
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  api,
  copy,
  date,
  query,
  readFile,
  useAction,
  useDebounce,
  useResource,
} from "@/lib/api";
import { useWorkspace } from "@/lib/context";
import type { Organization, Outlook, Preview } from "@/lib/types";
import {
  Activity,
  Copy,
  Download,
  FolderInput,
  KeyRound,
  Link,
  Mail,
  Pencil,
  Plus,
  Power,
  ShieldCheck,
  Tags,
  Trash2,
  Upload,
  Wrench,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  accountTextColumns,
  accountTextTemplate,
} from "../../shared/account-text";
import { outlookDiagnosis } from "../../shared/outlook-recovery";

function connectionStatus(a: Outlook) {
  return a.status === "disabled"
    ? "disabled"
    : a.token_refresh_status === "reauth_required"
      ? "reauth_required"
      : a.token_refresh_status === "retrying"
        ? "error"
        : a.auth_status;
}
function needsRecovery(a: Outlook) {
  return (
    a.status === "active" &&
    (["error", "reauth_required"].includes(a.auth_status) ||
      ["retrying", "reauth_required"].includes(a.token_refresh_status || ""))
  );
}
function RepairPanel({ onShowAll }: { onShowAll: () => void }) {
  const w = useWorkspace();
  const r = useResource<Outlook[]>(
    "/api/outlook/accounts?attention=true&limit=3",
    w.revision,
  );
  if (r.error) return <ErrorState message={r.error} retry={r.reload} />;
  if (!r.result?.total) return null;
  return (
    <Alert className="mb-5">
      <Wrench />
      <AlertTitle>{r.result.total} 个邮箱需要处理</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <p>按账号查看原因，选择测试连接、修复应用配置或重新授权。</p>
        {r.result.data.map((a) => (
          <div
            key={a.id}
            className="flex min-w-0 flex-wrap items-center justify-between gap-2"
          >
            <div className="min-w-0 flex-1">
              <p className="break-all font-medium">{a.email}</p>
              <p className="text-xs">{outlookDiagnosis(a).title}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => w.repairOutlook({ id: a.id, email: a.email })}
              aria-label={`修复 ${a.email}`}
            >
              去修复
            </Button>
          </div>
        ))}
        <div>
          <Button variant="link" size="sm" onClick={onShowAll}>
            查看全部待处理账号
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

function RenewalStatus({ account }: { account: Outlook }) {
  if (account.status !== "active") return null;
  return (
    <div className="row-detail max-w-64" title={account.token_refresh_error}>
      {account.token_refresh_status === "reauth_required"
        ? "续期需重新授权，请更新凭据"
        : account.token_refresh_status === "retrying"
          ? `续期失败 · ${date(account.next_token_refresh_at)} 自动重试`
          : account.last_token_refresh_at
            ? `已续期 ${date(account.last_token_refresh_at)} · 下次 ${date(account.next_token_refresh_at)}`
            : "等待自动续期，可立即测试连接"}
    </div>
  );
}
function RenewalPanel() {
  const w = useWorkspace();
  const action = useAction();
  const resource = useResource<{
    last_run: {
      at: string;
      attempted: number;
      renewed: number;
      failed: number;
    } | null;
    due: number;
    attention: number;
    active: number;
  }>("/api/outlook/renewal", w.revision);
  const data = resource.result?.data;
  if (resource.error)
    return <ErrorState message={resource.error} retry={resource.reload} />;
  if (!data) return null;
  return (
    <Alert>
      <ShieldCheck />
      <AlertTitle>自动续期 · {data.active} 个启用账号</AlertTitle>
      <AlertDescription>
        <div className="flex flex-col gap-2">
          <p>
            {data.last_run
              ? `最近执行 ${date(data.last_run.at)}：尝试 ${data.last_run.attempted} 个，成功 ${data.last_run.renewed} 个，失败 ${data.last_run.failed} 个。`
              : "等待首次后台调度，也可以立即执行。"}
            当前 {data.due} 个等待续期，{data.attention} 个需要重新授权。
          </p>
          <div>
            <BusyButton
              variant="outline"
              size="sm"
              busy={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await api("/api/outlook/renewal/run", "POST");
                  resource.reload();
                  w.refresh();
                  toast.success("本轮续期已执行");
                })
              }
            >
              立即执行续期
            </BusyButton>
          </div>
        </div>
      </AlertDescription>
    </Alert>
  );
}

export default function OutlookPage({
  initialQuery = "",
}: {
  initialQuery?: string;
}) {
  const w = useWorkspace();
  const [verification, setVerification] = useState<VerificationTarget | null>(
    null,
  );
  const [q, setQ] = useState(initialQuery);
  const [page, setPage] = useState(1);
  const [group, setGroup] = useState("");
  const [tag, setTag] = useState("");
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [editor, setEditor] = useState<Partial<Outlook> | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState<{
    endpoint: string;
    description: string;
  } | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const [bulk, setBulk] = useState("");
  const action = useAction();
  const search = useDebounce(q);
  const accountFilters = {
    q: search,
    group_id: group,
    tag_id: tag,
    status: status === "disabled" ? "disabled" : status ? "active" : "",
    auth_status: ["disabled", "attention"].includes(status) ? "" : status,
    attention:
      status === "attention"
        ? "true"
        : ["healthy", "unchecked"].includes(status)
          ? "false"
          : "",
  };
  const exportQuery = query(accountFilters);
  const rows = useResource<Outlook[]>(
    `/api/outlook/accounts?${query({ ...accountFilters, page })}`,
    w.revision,
  );
  const groups = useResource<Organization[]>("/api/outlook/groups", w.revision);
  const tags = useResource<Organization[]>("/api/outlook/tags", w.revision);
  const g = groups.result?.data || [],
    t = tags.result?.data || [];
  const filter = (fn: (s: string) => void) => (s: string) => {
    fn(s);
    setPage(1);
    setSelected([]);
  };
  useEffect(() => {
    if (!rows.result) return;
    const visible = new Set(rows.result.data.map((a) => a.id));
    setSelected((ids) => {
      const remaining = ids.filter((id) => visible.has(id));
      return remaining.length === ids.length ? ids : remaining;
    });
  }, [rows.result]);
  const connect = (sendMail = false) =>
    w.repairOutlook({
      group_id: Number(group) || 1,
      ...(initialQuery.includes("@") ? { email: initialQuery } : {}),
      send_mail: sendMail,
    });
  const applyBulk = async (type: string, value = "") => {
    let failed = 0;
    const size = type === "check" ? 10 : 50;
    try {
      for (let i = 0; i < selected.length; i += size) {
        const r = await api<{ success: boolean }[]>(
          "/api/outlook/accounts/batch",
          "POST",
          {
            action: type,
            ids: selected.slice(i, i + size),
            ...(type === "move" ? { group_id: Number(value) } : {}),
            ...(["tag", "untag"].includes(type)
              ? { tag_id: Number(value) }
              : {}),
          },
        );
        if (type === "check") failed += r.data.filter((a) => !a.success).length;
      }
      toast.success(
        type === "check"
          ? `检查完成，${failed} 个账号需要处理`
          : `已处理 ${selected.length} 个账号`,
      );
      setSelected([]);
      setBulk("");
    } finally {
      w.refresh();
    }
  };
  const check = (a: Outlook) => {
    void action.run(async () => {
      try {
        await api(`/api/outlook/accounts/${a.id}/check`, "POST");
        toast.success("连接正常");
      } finally {
        w.refresh();
      }
    });
  };
  const items = (a: Outlook) => [
    {
      label: "查收验证码",
      icon: <KeyRound />,
      action: () => w.code(`/api/outlook/accounts/${a.id}/code`),
    },
    {
      label: "测试连接",
      icon: <Activity />,
      disabled: action.busy,
      action: () => check(a),
    },
    {
      label: "授权与修复",
      icon: <Wrench />,
      action: () => w.repairOutlook({ id: a.id, email: a.email }),
    },
    { label: "编辑凭据", icon: <Pencil />, action: () => setEditor(a) },
    {
      label: "登记平台账号",
      icon: <Plus />,
      action: () =>
        w.vault({ account_email: a.email, email_source: "outlook" }),
    },
    {
      label: "查看关联平台",
      icon: <Link />,
      action: () => w.navigate("vault", a.email),
    },
    {
      label: "导出账号 / 复制配置",
      icon: <Download />,
      action: () =>
        setExporting({
          endpoint: `/api/outlook/accounts/export?ids=${a.id}`,
          description: `导出 ${a.email} 的凭据。可预览、复制固定格式文本，或下载 TXT、CSV、JSON。`,
        }),
    },
    {
      label: a.status === "disabled" ? "启用账号" : "停用账号",
      icon: <Power />,
      action: () => {
        void action.run(async () => {
          await api(`/api/outlook/accounts/${a.id}`, "PUT", {
            status: a.status === "disabled" ? "active" : "disabled",
          });
          w.refresh();
        });
      },
    },
    {
      label: "移除账号",
      icon: <Trash2 />,
      danger: true,
      action: () =>
        w.confirm(
          "移除 Outlook 账号？",
          `从工作区移除 ${a.email}，微软邮箱本身不会被删除。`,
          async () => {
            await api(`/api/outlook/accounts/${a.id}`, "DELETE");
            w.refresh();
          },
        ),
    },
  ];
  const selection = (a: Outlook) => (
    <Checkbox
      aria-label={`选择 ${a.email}`}
      checked={selected.includes(a.id)}
      onCheckedChange={(v) =>
        setSelected((ids) =>
          v ? [...ids, a.id] : ids.filter((id) => id !== a.id),
        )
      }
    />
  );
  return (
    <>
      <PageHeader
        title="Outlook 工作区"
        description="管理微软邮箱的连接、收件与授权状态。"
      >
        <Button
          variant="outline"
          disabled={q !== search}
          onClick={() =>
            setExporting({
              endpoint: `/api/outlook/accounts/export${exportQuery ? `?${exportQuery}` : ""}`,
              description: exportQuery
                ? "按当前搜索、分组、标签和状态条件导出全部匹配账号，最多 10,000 个。"
                : "导出工作区的全部 Outlook 账号，最多 10,000 个。",
            })
          }
        >
          <Download data-icon="inline-start" />
          导出账号
        </Button>
        <Button variant="outline" onClick={() => setImporting(true)}>
          <Upload data-icon="inline-start" />
          批量导入
        </Button>
        <BusyButton
          variant="outline"
          onClick={() => connect(true)}
          busy={action.busy}
        >
          授予发信权限
        </BusyButton>
        <BusyButton onClick={() => connect()} busy={action.busy}>
          <Plus data-icon="inline-start" />
          连接微软账号
        </BusyButton>
      </PageHeader>
      {initialQuery && q === initialQuery && (
        <Alert className="mb-5">
          <Link />
          <AlertTitle>处理平台账号的收件连接</AlertTitle>
          <AlertDescription className="flex flex-col gap-3">
            <p className="break-all">
              正在定位 {initialQuery}
              。已有账号可检查连接或更新凭据；尚未接入时，请导入凭据或连接对应的微软账号。
            </p>
            <div className="flex flex-wrap gap-2">
              {rows.result?.total === 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditor({ email: initialQuery })}
                >
                  填写此邮箱凭据
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => w.navigate("vault", initialQuery)}
              >
                返回关联的平台账号
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      {verification && (
        <QuickVerification
          target={verification}
          close={() => setVerification(null)}
        />
      )}
      <div className="health-strip">
        {[
          ["total", "全部账号"],
          ["healthy", "连接正常"],
          ["attention", "需要处理"],
          ["unchecked", "尚未检查"],
          ["disabled", "已停用"],
        ].map(([key, name]) => (
          <div key={key}>
            <span>{name}</span>
            <strong>
              {rows.result?.summary?.[key] ?? "—"}
              {key === "healthy" && (
                <ShieldCheck className="size-4 text-success" />
              )}
            </strong>
          </div>
        ))}
      </div>
      <RepairPanel
        onShowAll={() => {
          setQ("");
          setGroup("");
          setTag("");
          setStatus("attention");
          setPage(1);
          setSelected([]);
        }}
      />
      <div className="data-panel">
        <div className="filter-bar">
          <SearchBox
            value={q}
            onChange={filter(setQ)}
            placeholder="搜索邮箱或备注…"
          />
          <Pick
            label="分组筛选"
            value={group}
            onChange={filter(setGroup)}
            options={[
              ["", "全部分组"],
              ...g.map((a) => [String(a.id), a.name] as [string, string]),
            ]}
          />
          <Pick
            label="标签筛选"
            value={tag}
            onChange={filter(setTag)}
            options={[
              ["", "全部标签"],
              ...t.map((a) => [String(a.id), a.name] as [string, string]),
            ]}
          />
          <Pick
            label="连接状态"
            value={status}
            onChange={filter(setStatus)}
            options={[
              ["", "全部状态"],
              ["attention", "全部待处理"],
              ["healthy", "连接正常"],
              ["reauth_required", "需重新授权"],
              ["error", "连接异常"],
              ["unchecked", "尚未检查"],
              ["disabled", "已停用"],
            ]}
          />
          <RefreshButton onClick={rows.reload} busy={rows.loading} />
          <Menu
            label="Outlook 管理"
            items={[
              {
                label: "手动添加账号",
                icon: <Plus />,
                action: () => setEditor({}),
              },
              {
                label: "管理分组与标签",
                icon: <Tags />,
                action: () => setOrganizing(true),
              },
            ]}
          />
        </div>
        {selected.length > 0 && (
          <div className="selection-bar">
            <span>已选 {selected.length} 个</span>
            <BusyButton
              size="sm"
              variant="outline"
              busy={action.busy}
              onClick={() => {
                void action.run(() => applyBulk("check"));
              }}
            >
              <Activity data-icon="inline-start" />
              测试连接
            </BusyButton>
            <Button size="sm" variant="outline" onClick={() => setBulk("move")}>
              <FolderInput data-icon="inline-start" />
              移动
            </Button>
            <Menu
              trigger={
                <Button size="sm" variant="outline">
                  <Tags data-icon="inline-start" />
                  批量操作
                </Button>
              }
              items={[
                { label: "添加标签", action: () => setBulk("tag") },
                { label: "移除标签", action: () => setBulk("untag") },
                {
                  label: "导出所选账号",
                  icon: <Download />,
                  disabled: selected.length > 100,
                  action: () =>
                    setExporting({
                      endpoint: `/api/outlook/accounts/export?ids=${selected.join(",")}`,
                      description: `导出所选 ${selected.length} 个账号。可预览、复制固定格式文本，或下载 TXT、CSV、JSON。`,
                    }),
                },
                {
                  label: "启用所选",
                  action: () => {
                    void action.run(() => applyBulk("enable"));
                  },
                },
                {
                  label: "停用所选",
                  action: () => {
                    void action.run(() => applyBulk("disable"));
                  },
                },
                {
                  label: "移除所选",
                  danger: true,
                  action: () =>
                    w.confirm(
                      "批量移除账号？",
                      `将移除所选 ${selected.length} 个账号在工作区中的凭据。`,
                      () => applyBulk("delete"),
                    ),
                },
              ]}
            />
          </div>
        )}
        {rows.error ? (
          <ErrorState message={rows.error} retry={rows.reload} />
        ) : !rows.result ? (
          <Loading />
        ) : !rows.result.data.length ? (
          <Blank
            title={
              q || group || tag || status
                ? "没有匹配的 Outlook 账号"
                : "连接你的第一组邮箱"
            }
            description={
              q
                ? "确认邮箱地址正确；尚未接入的邮箱需要先导入凭据或完成微软授权。"
                : "使用微软授权连接，或导入已有的 Refresh Token 凭据。"
            }
          >
            <Button onClick={() => connect()}>连接微软账号</Button>
            <Button variant="outline" onClick={() => setImporting(true)}>
              导入已有账号
            </Button>
          </Blank>
        ) : (
          <>
            <div className="desktop-table">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        aria-label="选择本页全部账号"
                        checked={
                          selected.length === rows.result.data.length
                            ? true
                            : selected.length
                              ? "indeterminate"
                              : false
                        }
                        onCheckedChange={(v) =>
                          setSelected(
                            v ? rows.result!.data.map((a) => a.id) : [],
                          )
                        }
                      />
                    </TableHead>
                    <TableHead>邮箱账号</TableHead>
                    <TableHead>分组与标签</TableHead>
                    <TableHead>连接状态</TableHead>
                    <TableHead className="w-52">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.result.data.map((a) => (
                    <TableRow
                      key={a.id}
                      data-state={
                        selected.includes(a.id) ? "selected" : undefined
                      }
                    >
                      <TableCell>{selection(a)}</TableCell>
                      <TableCell>
                        <button
                          className="row-link"
                          onClick={() => w.outlook(a.id, a.email)}
                        >
                          {a.email}
                        </button>
                        <div className="row-detail">
                          {a.remark || `关联 ${a.platform_count} 个平台账号`}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1.5">
                          <Badge variant="secondary">
                            {a.group_name || "默认分组"}
                          </Badge>
                          {a.tags?.map((t) => (
                            <Badge variant="outline" key={t.id}>
                              {t.name}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Status value={connectionStatus(a)} />
                        <div
                          className="row-detail max-w-64"
                          title={a.last_error}
                        >
                          {a.last_error ||
                            (a.last_checked_at
                              ? date(a.last_checked_at)
                              : "导入后可测试连接")}
                        </div>
                        <RenewalStatus account={a} />
                        {needsRecovery(a) && (
                          <Button
                            variant="link"
                            size="sm"
                            onClick={() =>
                              w.repairOutlook({ id: a.id, email: a.email })
                            }
                          >
                            修复连接
                          </Button>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={a.status === "disabled"}
                            onClick={() =>
                              setVerification({
                                path: `/api/outlook/accounts/${a.id}/code`,
                                label: a.email,
                              })
                            }
                          >
                            <KeyRound data-icon="inline-start" />
                            取码 / 链接
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => w.outlook(a.id, a.email)}
                          >
                            <Mail data-icon="inline-start" />
                            收件
                          </Button>
                          <Menu label={`${a.email} 操作`} items={items(a)} />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="mobile-records">
              {rows.result.data.map((a) => (
                <article className="mobile-record" key={a.id}>
                  <div className="flex items-center gap-3">
                    {selection(a)}
                    <button
                      className="row-link min-w-0 break-all"
                      onClick={() => w.outlook(a.id, a.email)}
                    >
                      {a.email}
                    </button>
                    <div className="ml-auto">
                      <Menu items={items(a)} />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary">{a.group_name}</Badge>
                    <Status value={connectionStatus(a)} />
                  </div>
                  <p className="row-detail">
                    {a.last_error ||
                      a.remark ||
                      `关联 ${a.platform_count} 个平台账号`}
                  </p>
                  <RenewalStatus account={a} />
                  {needsRecovery(a) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        w.repairOutlook({ id: a.id, email: a.email })
                      }
                    >
                      <Wrench data-icon="inline-start" />
                      修复连接
                    </Button>
                  )}
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={() => w.outlook(a.id, a.email)}
                    >
                      <Mail data-icon="inline-start" />
                      阅读邮件
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={a.status === "disabled"}
                      onClick={() =>
                        setVerification({
                          path: `/api/outlook/accounts/${a.id}/code`,
                          label: a.email,
                        })
                      }
                    >
                      <KeyRound data-icon="inline-start" />
                      取码 / 链接
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
        <Pager
          result={rows.result}
          page={page}
          setPage={(p) => {
            setPage(p);
            setSelected([]);
          }}
        />
      </div>
      <RenewalPanel />
      <p className="page-footnote">
        <ShieldCheck className="size-4" />
        后台每 15 分钟调度到期账号，成功后安排约 6
        小时再续期；积压账号依次处理。停用账号不续期，微软撤销授权时需重新授权。
      </p>
      {editor && (
        <OutlookEditor
          initial={editor}
          groups={g}
          close={() => setEditor(null)}
        />
      )}
      {importing && (
        <ImportOutlook groups={g} close={() => setImporting(false)} />
      )}
      {exporting && (
        <AccountExportDialog
          kind="outlook"
          endpoint={exporting.endpoint}
          description={exporting.description}
          close={() => setExporting(null)}
        />
      )}
      {organizing && (
        <Organize groups={g} tags={t} close={() => setOrganizing(false)} />
      )}
      {bulk && (
        <BulkTarget
          type={bulk}
          options={bulk === "move" ? g : t}
          apply={(value) => applyBulk(bulk, value)}
          close={() => setBulk("")}
        />
      )}
    </>
  );
}
function OutlookEditor({
  initial,
  groups,
  close,
}: {
  initial: Partial<Outlook>;
  groups: Organization[];
  close: () => void;
}) {
  const w = useWorkspace();
  const action = useAction({ inline: true });
  const [data, setData] = useState({
    email: initial.email || "",
    client_id: initial.client_id || "",
    password: "",
    refresh_token: "",
    group_id: initial.group_id || 1,
    status: initial.status || "active",
    remark: initial.remark || "",
  });
  const unsavedCredentials = !!(
    data.password ||
    data.refresh_token ||
    data.client_id !== (initial.client_id || "") ||
    data.remark !== (initial.remark || "") ||
    data.status !== (initial.status || "active") ||
    (!!initial.id && Number(data.group_id) !== initial.group_id)
  );
  const set = (k: keyof typeof data, v: string) =>
    setData((d) => ({ ...d, [k]: v }));
  return (
    <Modal
      close={close}
      title={initial.id ? "编辑 Outlook 凭据" : "手动添加 Outlook"}
      description={
        initial.id
          ? "留空密码或 Refresh Token 会保留已有凭据。"
          : "使用你自己的 Microsoft 应用与邮箱授权凭据。"
      }
      wide
    >
      <form
        className="modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api(
              `/api/outlook/accounts${initial.id ? `/${initial.id}` : ""}`,
              initial.id ? "PUT" : "POST",
              {
                ...data,
                password: data.password || undefined,
                refresh_token: data.refresh_token || undefined,
              },
            );
            w.refresh();
            toast.success("账号已保存，可测试连接");
            close();
          });
        }}
      >
        <ModalBody>
          <ActionError message={action.error} />
          <Alert>
            <KeyRound />
            <AlertTitle>也可以通过微软授权更新凭据</AlertTitle>
            <AlertDescription className="flex flex-col gap-2">
              <p>
                {unsavedCredentials
                  ? "请先保存当前手动修改，再打开授权工具。"
                  : "打开微软授权页，自动回调或粘贴授权码，即可获取并保存新的 Refresh Token。"}
              </p>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={unsavedCredentials || action.busy}
                  onClick={() => {
                    close();
                    w.repairOutlook({
                      id: initial.id,
                      email: data.email || undefined,
                      group_id: Number(data.group_id),
                    });
                  }}
                >
                  打开授权工具
                </Button>
              </div>
            </AlertDescription>
          </Alert>
          <FieldGroup className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <TextField
              label="邮箱"
              type="email"
              required
              readOnly={!!initial.id}
              value={data.email}
              onChange={(e) => set("email", e.target.value)}
            />
            <TextField
              label="密码（可选）"
              type="password"
              autoComplete="new-password"
              value={data.password}
              onChange={(e) => set("password", e.target.value)}
            />
            <TextField
              label="Client ID"
              required
              value={data.client_id}
              onChange={(e) => set("client_id", e.target.value)}
            />
            <SelectField
              label="分组"
              value={String(data.group_id)}
              onChange={(v) => set("group_id", v)}
              options={groups.map((g) => [String(g.id), g.name])}
            />
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="refresh-token">Refresh Token</FieldLabel>
              <Textarea
                id="refresh-token"
                required={!initial.id}
                autoComplete="off"
                spellCheck={false}
                value={data.refresh_token}
                onChange={(e) => set("refresh_token", e.target.value)}
                placeholder={
                  initial.id ? "留空保留已有 Token" : "粘贴完整的 Refresh Token"
                }
              />
            </Field>
            <SelectField
              label="账号状态"
              value={data.status}
              onChange={(v) => set("status", v)}
              options={[
                ["active", "启用"],
                ["disabled", "停用"],
              ]}
            />
            <TextField
              label="备注"
              value={data.remark}
              onChange={(e) => set("remark", e.target.value)}
            />
          </FieldGroup>
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="outline" onClick={close}>
            取消
          </Button>
          <BusyButton type="submit" busy={action.busy}>
            保存账号
          </BusyButton>
        </ModalFooter>
      </form>
    </Modal>
  );
}
function ImportOutlook({
  groups,
  close,
}: {
  groups: Organization[];
  close: () => void;
}) {
  const w = useWorkspace();
  const [raw, setRaw] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [group, setGroup] = useState("1");
  const [mode, setMode] = useState("skip");
  const [sync, setSync] = useState(true);
  const [templateFormat, setTemplateFormat] = useState<"text" | "csv" | "json">(
    "text",
  );
  const template =
    templateFormat === "json"
      ? JSON.stringify(
          {
            accounts: [
              Object.fromEntries(
                accountTextColumns("outlook", true).map(({ key, example }) => [
                  key,
                  example,
                ]),
              ),
            ],
          },
          null,
          2,
        )
      : accountTextTemplate("outlook", {
          format: templateFormat,
          includeRemark: templateFormat === "csv",
        });
  const action = useAction({ inline: true });
  const version = useRef(0);
  const change = (v: string) => {
    version.current++;
    setRaw(v);
    setPreview(null);
  };
  return (
    <Modal
      close={close}
      title="批量导入 Outlook"
      description="支持文本、CSV、JSON 和本站导出的备份。每批最多 200 个账号，1 MiB。"
      wide
    >
      <ModalBody>
        <ActionError message={action.error} />
        <FieldGroup>
          <Alert>
            <AlertTitle>固定文本格式 · 每条记录一个账号</AlertTitle>
            <AlertDescription className="flex flex-col gap-2">
              <code className="[overflow-wrap:anywhere]">
                邮箱----密码----client_id----refresh_token
              </code>
              <p>
                密码为空时保留位置；可在第 5
                列附加备注。支持表头和“导出内容（格式：…）”说明。
                字段含分隔符、换行、引号或首尾空格时，用双引号包住；内部引号写成两个双引号。
              </p>
              <p>
                先预览检查格式，再确认导入。下方模板全部是虚构数据，请替换为自己的凭据。
              </p>
            </AlertDescription>
          </Alert>
          <SelectField
            label="查看导入模板"
            value={templateFormat}
            onChange={(value) =>
              setTemplateFormat(value as "text" | "csv" | "json")
            }
            options={[
              ["text", "常用四列文本（---- 分隔）"],
              ["csv", "CSV（带表头和备注）"],
              ["json", "JSON（账号数组）"],
            ]}
          />
          <Field>
            <FieldLabel htmlFor="outlook-import-template">
              导入模板（虚构数据）
            </FieldLabel>
            <Textarea
              id="outlook-import-template"
              value={template}
              readOnly
              autoComplete="off"
              spellCheck={false}
              wrap="off"
              rows={3}
              className="h-24 [field-sizing:fixed]"
            />
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void copy(template, "导入模板")}
              >
                <Copy data-icon="inline-start" />
                复制模板
              </Button>
            </div>
          </Field>
          <Field>
            <FieldLabel htmlFor="outlook-file">选择文件</FieldLabel>
            <Input
              id="outlook-file"
              type="file"
              accept=".txt,.csv,.json,.jsonl"
              disabled={action.busy}
              onChange={(e) => {
                void action.run(async () =>
                  change(await readFile(e.target.files?.[0])),
                );
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="outlook-raw">或粘贴账号</FieldLabel>
            <Textarea
              id="outlook-raw"
              rows={5}
              value={raw}
              disabled={action.busy}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => change(e.target.value)}
              placeholder="邮箱----密码----Client ID----Refresh Token"
            />
            <FieldDescription>
              可直接粘贴上述格式，也可以选择 TXT、CSV 或 JSON 文件。
              预览只检查格式，不验证微软授权；导入后可测试连接。
            </FieldDescription>
          </Field>
          <div className="form-grid">
            <SelectField
              label="导入分组"
              value={group}
              onChange={setGroup}
              options={groups.map((g) => [String(g.id), g.name])}
            />
            <SelectField
              label="已有账号"
              value={mode}
              onChange={setMode}
              options={[
                ["skip", "跳过已有"],
                ["update", "更新已有凭据"],
              ]}
            />
          </div>
          <Field orientation="horizontal">
            <Checkbox
              id="sync-vault"
              checked={sync}
              onCheckedChange={(v) => setSync(v === true)}
            />
            <FieldLabel htmlFor="sync-vault">同步登记到平台账号</FieldLabel>
          </Field>
        </FieldGroup>
        {preview && (
          <div className="flex flex-col gap-3">
            <Alert>
              <AlertTitle>
                {preview.valid_count} 个账号格式正确，尚未导入
              </AlertTitle>
              <AlertDescription>
                {preview.error_count} 行格式异常，{preview.duplicate_count}{" "}
                行重复。格式异常行会跳过；重复账号以最后一条有效记录为准。
                {preview.valid_count > 0 &&
                  "点击下方“确认导入”保存账号，之后可测试连接。"}
              </AlertDescription>
            </Alert>
            <div className="max-h-48 overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>行</TableHead>
                    <TableHead>邮箱</TableHead>
                    <TableHead>检查结果</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rows.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell>{r.line}</TableCell>
                      <TableCell>{r.email || "—"}</TableCell>
                      <TableCell>
                        {r.error ? (
                          <span className="text-destructive">{r.error}</span>
                        ) : (
                          <div className="flex flex-col gap-1">
                            <span>
                              {r.duplicate ? "格式正确 · 重复" : "格式正确"}
                            </span>
                            {r.warning && (
                              <span className="text-muted-foreground text-xs">
                                {r.warning}
                              </span>
                            )}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        <BusyButton
          variant="outline"
          disabled={!raw.trim()}
          busy={action.busy}
          onClick={() => {
            void action.run(async () => {
              const current = version.current;
              const p = (await api("/api/outlook/parse-preview", "POST", {
                raw_text: raw,
              })) as unknown as Preview;
              if (current === version.current) setPreview(p);
            });
          }}
        >
          预览导入
        </BusyButton>
        <BusyButton
          disabled={!preview?.valid_count}
          busy={action.busy}
          onClick={() => {
            void action.run(async () => {
              const r = await api("/api/outlook/batch-import", "POST", {
                raw_text: raw,
                group_id: Number(group),
                duplicate_mode: mode,
                sync_to_vault: sync,
              });
              toast.success(r.message);
              w.refresh();
              close();
            });
          }}
        >
          <Upload data-icon="inline-start" />
          {preview?.valid_count
            ? `确认导入 ${preview.valid_count} 个账号`
            : "确认导入"}
        </BusyButton>
      </ModalFooter>
    </Modal>
  );
}
function BulkTarget({
  type,
  options,
  apply,
  close,
}: {
  type: string;
  options: Organization[];
  apply: (v: string) => Promise<void>;
  close: () => void;
}) {
  const [value, setValue] = useState(String(options[0]?.id || ""));
  const action = useAction({ inline: true });
  return (
    <Modal
      title={
        type === "move" ? "移至分组" : type === "tag" ? "添加标签" : "移除标签"
      }
      description="对当前选中的账号应用此操作。"
      close={close}
    >
      <ModalBody>
        <ActionError message={action.error} />
        <SelectField
          label="选择目标"
          value={value}
          onChange={setValue}
          options={options.map((a) => [String(a.id), a.name])}
        />
        {!options.length && (
          <p className="text-muted-foreground">
            请先在“管理分组与标签”中新建。
          </p>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="outline" onClick={close}>
          取消
        </Button>
        <BusyButton
          disabled={!value}
          busy={action.busy}
          onClick={() => void action.run(() => apply(value))}
        >
          应用
        </BusyButton>
      </ModalFooter>
    </Modal>
  );
}
function Organize({
  groups,
  tags,
  close,
}: {
  groups: Organization[];
  tags: Organization[];
  close: () => void;
}) {
  const w = useWorkspace();
  const action = useAction({ inline: true });
  const [type, setType] = useState("groups");
  const [editing, setEditing] = useState<Organization | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#18798a");
  const reset = () => {
    setEditing(null);
    setName("");
    setColor("#18798a");
  };
  return (
    <Modal
      title="分组与标签"
      description="用分组区分用途，用标签交叉整理邮箱。删除分组时，账号会移至默认分组。"
      close={close}
    >
      <form
        className="modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api(
              `/api/outlook/${type}${editing ? `/${editing.id}` : ""}`,
              editing ? "PUT" : "POST",
              { name, color },
            );
            w.refresh();
            reset();
          });
        }}
      >
        <ModalBody>
          <ActionError message={action.error} />
          <Tabs
            value={type}
            onValueChange={(v) => {
              setType(v);
              reset();
            }}
          >
            <TabsList>
              <TabsTrigger value="groups">分组</TabsTrigger>
              <TabsTrigger value="tags">标签</TabsTrigger>
            </TabsList>
            {[
              ["groups", groups],
              ["tags", tags],
            ].map(([kind, rows]) => (
              <TabsContent key={String(kind)} value={String(kind)}>
                <div className="flex max-h-64 flex-col overflow-auto">
                  {(rows as Organization[]).map((row) => (
                    <div className="organize-row" key={row.id}>
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{
                          background: /^#[a-f\d]{6}$/i.test(row.color)
                            ? row.color
                            : undefined,
                        }}
                      />
                      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                        {row.name}
                        <span className="row-detail ml-2">
                          {row.account_count} 个账号
                        </span>
                      </div>
                      <IconButton
                        label={`编辑 ${row.name}`}
                        onClick={() => {
                          setEditing(row);
                          setName(row.name);
                          setColor(row.color);
                        }}
                      >
                        <Pencil />
                      </IconButton>
                      <IconButton
                        label={`删除 ${row.name}`}
                        disabled={kind === "groups" && row.id === 1}
                        onClick={() =>
                          w.confirm(
                            `删除${kind === "groups" ? "分组" : "标签"}？`,
                            row.name,
                            async () => {
                              await api(
                                `/api/outlook/${kind}/${row.id}`,
                                "DELETE",
                              );
                              w.refresh();
                              if (editing?.id === row.id) reset();
                            },
                          )
                        }
                      >
                        <Trash2 />
                      </IconButton>
                    </div>
                  ))}
                </div>
              </TabsContent>
            ))}
          </Tabs>
          <FieldGroup>
            <TextField
              label={editing ? "修改名称" : "新建名称"}
              required
              maxLength={40}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <TextField
              label="标记颜色"
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
          </FieldGroup>
        </ModalBody>
        <ModalFooter>
          {editing && (
            <Button type="button" variant="outline" onClick={reset}>
              取消编辑
            </Button>
          )}
          <BusyButton type="submit" busy={action.busy}>
            {editing ? "保存修改" : "创建"}
          </BusyButton>
        </ModalFooter>
      </form>
    </Modal>
  );
}
