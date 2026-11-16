import {
  VerificationActions,
  QuickVerification,
  type VerificationTarget,
  PollingControls,
} from "@/features/verification";
import { RelatedVaultAccounts } from "@/features/readers";
import { useSmartPolling } from "@/hooks/use-smart-polling";
import { categories, categoryLabel, RuleEditor } from "@/features/mail-rules";
import { BatchMailboxes, MailboxPurpose } from "@/features/mailbox-batch";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  api,
  date,
  query,
  useAction,
  useDebounce,
  useResource,
} from "@/lib/api";
import { useWorkspace } from "@/lib/context";
import type { Mail, Mailbox } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ArrowUpRight,
  Archive,
  Clock3,
  Infinity,
  KeyRound,
  Link,
  Mail as MailIcon,
  Pin,
  Plus,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export function MailRows({
  mails,
  selected,
  select,
  createRule,
}: {
  mails: Mail[];
  selected?: number[];
  select?: (id: number, value: boolean) => void;
  createRule?: (mail: Mail) => void;
}) {
  const w = useWorkspace();
  const action = useAction();
  return (
    <div className="inbox-rows">
      {mails.map((m) => (
        <article className={cn("inbox-row", !m.is_read && "unread")} key={m.id}>
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {select && (
              <Checkbox
                aria-label={`选择邮件：${m.subject || m.id}`}
                checked={selected?.includes(Number(m.id))}
                onCheckedChange={(value) =>
                  select(Number(m.id), value === true)
                }
              />
            )}
            <button
              type="button"
              className="inbox-row-main"
              onClick={() => w.mail(Number(m.id))}
            >
              <span className="inbox-initial">
                {(m.sender_name || m.sender || "M").slice(0, 1)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {!!m.is_pinned && <Pin className="size-3 shrink-0" />}
                  <span className="truncate">{m.subject || "(无主题)"}</span>
                  {!m.is_read && <span className="status-dot status-good" />}
                </span>
                <span className="row-detail block">
                  {m.sender_name || m.sender}
                </span>
                <span className="row-detail block">收件：{m.recipient}</span>
                <span className="mt-1 flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{categoryLabel(m.category)}</Badge>
                  {!!m.is_archived && <Badge variant="secondary">已归档</Badge>}
                  {m.rule_name && (
                    <span className="text-xs text-muted-foreground">
                      规则：{m.rule_name}
                    </span>
                  )}
                </span>
              </span>
            </button>
          </div>
          <div className="inbox-row-meta">
            <VerificationActions
              code={m.verification_code}
              link={m.verification_link}
            />
            <time>{date(m.created_at)}</time>
            <Menu
              label={`邮件操作：${m.subject || m.id}`}
              items={[
                {
                  label: m.is_read ? "标为未读" : "标为已读",
                  disabled: action.busy,
                  action: () => {
                    void action.run(async () => {
                      await api(`/api/cf-mails/${m.id}`, "PATCH", {
                        is_read: !m.is_read,
                      });
                      w.refresh();
                    });
                  },
                },
                {
                  label: m.is_archived ? "移回收件箱" : "归档邮件",
                  disabled: action.busy,
                  action: () => {
                    void action.run(async () => {
                      await api(`/api/cf-mails/${m.id}`, "PATCH", {
                        is_archived: !m.is_archived,
                      });
                      w.refresh();
                    });
                  },
                },
                {
                  label: m.is_pinned ? "取消置顶" : "置顶邮件",
                  disabled: action.busy,
                  action: () => {
                    void action.run(async () => {
                      await api(`/api/cf-mails/${m.id}`, "PATCH", {
                        is_pinned: !m.is_pinned,
                      });
                      w.refresh();
                    });
                  },
                },
                { label: "阅读邮件", action: () => w.mail(Number(m.id)) },
                ...(createRule
                  ? [{ label: "按发件人创建规则", action: () => createRule(m) }]
                  : []),
              ]}
            />
          </div>
        </article>
      ))}
    </div>
  );
}
export default function InboxPage({
  initialQuery = "",
}: {
  initialQuery?: string;
}) {
  const w = useWorkspace();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [domain, setDomain] = useState("");
  const [recipient, setRecipient] = useState(initialQuery.trim().toLowerCase());
  const [unread, setUnread] = useState(false);
  const [verificationOnly, setVerificationOnly] = useState(false);
  const [folder, setFolder] = useState("inbox");
  const [category, setCategory] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [ruleSeed, setRuleSeed] = useState<Mail | null>(null);
  const action = useAction();
  const search = useDebounce(q);
  const rows = useSmartPolling<Mail[]>(
    `/api/cf-mails?${query({ q: search, domain, recipient, unread, verification: verificationOnly, folder, category, page })}`,
    { revision: w.revision },
  );
  const recipients = useResource<
    { recipient: string; mail_count: number; unread_count: number }[]
  >(`/api/cf-mails/recipients?${query({ domain })}`, w.revision);
  const filter = (fn: (v: string) => void) => (v: string) => {
    rows.stop();
    fn(v);
    setPage(1);
  };
  useEffect(() => {
    // The mailbox link is an exact recipient filter. q searches message content,
    // and would silently miss messages addressed to this mailbox.
    setRecipient(initialQuery.trim().toLowerCase());
    setQ("");
    setDomain("");
    setPage(1);
    setFolder("inbox");
    setUnread(false);
    setVerificationOnly(false);
    setCategory("");
  }, [initialQuery]);
  useEffect(() => {
    setSelected([]);
  }, [
    search,
    domain,
    recipient,
    unread,
    verificationOnly,
    folder,
    category,
    page,
  ]);
  const visible = (rows.result?.data || []).map((m) => Number(m.id));
  const chosen = selected.filter((id) => visible.includes(id));
  const batch = (patch: Record<string, boolean | string>) => {
    void action.run(async () => {
      const r = await api("/api/cf-mails/batch", "POST", {
        ids: chosen,
        patch,
      });
      toast.success(r.message);
      setSelected([]);
      w.refresh();
    });
  };
  return (
    <>
      <PageHeader
        title="域名收件箱"
        description="集中查收、分类和归档，验证码与验证链接可直接复制。"
      >
        <Button variant="outline" onClick={() => w.navigate("rules")}>
          <SlidersHorizontal data-icon="inline-start" />
          收件规则
        </Button>
        <Menu
          trigger={
            <Button variant="outline">
              <Trash2 data-icon="inline-start" />
              清理邮件
            </Button>
          }
          items={[
            {
              label: "清理未保护的临时邮件",
              danger: true,
              action: () =>
                w.confirm(
                  "清理临时邮件？",
                  "将永久删除未置顶、未绑定平台且未设为永久保留的临时邮件。",
                  async () => {
                    const r = await api("/api/cf-mails/clean", "POST");
                    toast.success(r.message);
                    w.refresh();
                  },
                ),
            },
          ]}
        />
        <Button onClick={() => w.navigate("mailboxes")}>
          <Plus data-icon="inline-start" />
          生成收件地址
        </Button>
      </PageHeader>
      <div className="data-panel">
        <Tabs
          value={folder}
          onValueChange={filter(setFolder)}
          className="px-4 pt-3"
        >
          <TabsList variant="line">
            {[
              ["inbox", "收件箱"],
              ["archived", "已归档"],
              ["all", "全部邮件"],
            ].map(([key, label]) => (
              <TabsTrigger key={key} value={key}>
                {label}
                <span className="ml-1 text-xs text-muted-foreground">
                  {rows.result?.summary?.[key] ?? ""}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="filter-bar">
          <SearchBox
            value={q}
            onChange={filter(setQ)}
            placeholder="搜索主题、发件人或验证码…"
          />
          <Pick
            label="邮件分类"
            value={category}
            onChange={filter(setCategory)}
            options={[["", "全部分类"], ...categories]}
          />
          <Pick
            label="收件域名"
            value={domain}
            onChange={(v) => {
              setDomain(v);
              setRecipient("");
              setPage(1);
            }}
            options={[
              ["", "全部域名"],
              ...(w.settings?.domains || []).map(
                (d) => [d.domain, d.domain] as [string, string],
              ),
            ]}
          />
          <label className="flex items-center gap-2 whitespace-nowrap text-sm">
            <Checkbox
              checked={unread}
              onCheckedChange={(v) => {
                setUnread(v === true);
                setPage(1);
              }}
            />
            只看未读
          </label>
          <label className="flex items-center gap-2 whitespace-nowrap text-sm">
            <Checkbox
              checked={verificationOnly}
              onCheckedChange={(v) => {
                setVerificationOnly(v === true);
                setPage(1);
              }}
            />
            只看验证码 / 链接
          </label>
          <RefreshButton onClick={rows.reload} busy={rows.loading} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <Pick
            label="收件地址"
            value={recipient}
            onChange={filter(setRecipient)}
            className="max-w-full"
            options={[
              ["", "全部收件地址"],
              ...(recipient &&
              !recipients.result?.data.some((r) => r.recipient === recipient)
                ? [[recipient, recipient] as [string, string]]
                : []),
              ...(recipients.result?.data || []).map(
                (r) =>
                  [
                    r.recipient,
                    `${r.recipient} (${r.unread_count ? `${r.unread_count} 未读 / ` : ""}${r.mail_count})`,
                  ] as [string, string],
              ),
            ]}
          />
          <span className="text-xs text-muted-foreground">
            归档不改变保留期限；置顶可防止自动清理
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-2 border-b px-4 py-3">
          <PollingControls polling={rows} disabled={page > 1 || q !== search} />
          {page > 1 && (
            <p className="text-xs text-muted-foreground">
              返回第一页后可开启自动查收。
            </p>
          )}
          {recipient && (
            <RelatedVaultAccounts key={recipient} email={recipient} />
          )}
        </div>
        {!!visible.length && (
          <div className="selection-bar">
            <label className="flex items-center gap-2">
              <Checkbox
                aria-label="选择本页邮件"
                checked={
                  chosen.length === visible.length
                    ? true
                    : chosen.length
                      ? "indeterminate"
                      : false
                }
                onCheckedChange={(v) => setSelected(v === true ? visible : [])}
              />
              {chosen.length ? `已选 ${chosen.length} 封` : "选择本页"}
            </label>
            {chosen.length > 0 && (
              <>
                <BusyButton
                  size="sm"
                  variant="outline"
                  busy={action.busy}
                  onClick={() => batch({ is_archived: folder !== "archived" })}
                >
                  <Archive data-icon="inline-start" />
                  {folder === "archived" ? "移回收件箱" : "归档"}
                </BusyButton>
                <Menu
                  label="批量标记"
                  trigger={
                    <Button size="sm" variant="outline" disabled={action.busy}>
                      标记状态
                    </Button>
                  }
                  items={[
                    {
                      label: "标为已读",
                      action: () => batch({ is_read: true }),
                    },
                    {
                      label: "标为未读",
                      action: () => batch({ is_read: false }),
                    },
                    {
                      label: "置顶保留",
                      action: () => batch({ is_pinned: true }),
                    },
                    {
                      label: "取消置顶",
                      action: () => batch({ is_pinned: false }),
                    },
                  ]}
                />
                <Menu
                  label="批量分类"
                  trigger={
                    <Button size="sm" variant="outline" disabled={action.busy}>
                      设置分类
                    </Button>
                  }
                  items={categories.map(([key, label]) => ({
                    label,
                    action: () => batch({ category: key }),
                  }))}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={action.busy}
                  onClick={() => setSelected([])}
                >
                  取消选择
                </Button>
              </>
            )}
          </div>
        )}
        {rows.error ? (
          <ErrorState message={rows.error} retry={rows.reload} />
        ) : !rows.result ? (
          <Loading />
        ) : !rows.result.data.length ? (
          <Blank
            title="收件箱是空的"
            description="使用你的域名邮箱接收邮件，或调整上方筛选条件。"
          />
        ) : (
          <MailRows
            mails={rows.result.data}
            selected={chosen}
            select={(id, value) =>
              setSelected((old) =>
                value
                  ? [...new Set([...old, id])]
                  : old.filter((i) => i !== id),
              )
            }
            createRule={setRuleSeed}
          />
        )}
        <Pager result={rows.result} page={page} setPage={setPage} />
      </div>
      {ruleSeed && (
        <RuleEditor
          seed={{
            name: `整理 ${ruleSeed.sender || "此发件人"}`.slice(0, 80),
            sender_contains: ruleSeed.sender || "",
            action_category: ruleSeed.category || "general",
          }}
          close={() => setRuleSeed(null)}
          saved={() => {
            setRuleSeed(null);
            w.refresh();
          }}
        />
      )}
    </>
  );
}
export function MailboxesPage() {
  const w = useWorkspace();
  const [q, setQ] = useState("");
  const [domain, setDomain] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [create, setCreate] = useState(false);
  const [batchCreate, setBatchCreate] = useState(false);
  const [purpose, setPurpose] = useState<Mailbox | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [verification, setVerification] = useState<VerificationTarget | null>(
    null,
  );
  const [now, setNow] = useState(Date.now());
  const search = useDebounce(q);
  const action = useAction();
  const rows = useResource<Mailbox[]>(
    `/api/mailboxes?${query({ q: search, domain, status, page })}`,
    w.revision,
  );
  const active = useResource<Mailbox>(
    selected ? `/api/mailboxes/${selected}` : null,
    w.revision,
  );
  const box = active.result?.data;
  const inbox = useSmartPolling<Mail[]>(
    box
      ? `/api/cf-mails?${query({ recipient: box.address, limit: 10 })}`
      : null,
    { revision: w.revision },
  );
  useEffect(() => {
    if (!box) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [box]);
  const remaining = box
    ? Math.max(0, Math.ceil((Date.parse(box.expires_at) - now) / 1000))
    : 0;
  const canReceive = !!box && (!!box.is_permanent || remaining > 0);
  useEffect(() => {
    if (!canReceive) inbox.stop();
  }, [canReceive, inbox.stop]);
  const mutate = async (m: Mailbox, command: string) => {
    const r = await api(
      `/api/mailboxes/${m.id}${command === "destroy" ? "" : `/${command}`}`,
      command === "destroy" ? "DELETE" : "POST",
      command === "extend" ? { minutes: 60 } : undefined,
    );
    toast.success(r.message);
    w.refresh();
  };
  const items = (m: Mailbox) => [
    { label: "编辑用途备注", action: () => setPurpose(m) },
    { label: "查看收件", icon: <MailIcon />, action: () => setSelected(m.id) },
    {
      label: "取码 / 链接",
      icon: <KeyRound />,
      action: () =>
        setVerification({
          path: `/api/mailboxes/${m.id}/code`,
          label: m.address,
        }),
    },
    {
      label: "登记平台账号",
      icon: <Link />,
      action: () =>
        w.vault({ account_email: m.address, email_source: "cf_domain" }),
    },
    {
      label: "延长 1 小时",
      icon: <Clock3 />,
      disabled: !!m.is_permanent,
      action: () => {
        void action.run(() => mutate(m, "extend"));
      },
    },
    {
      label: m.is_permanent ? "改为一小时有效" : "设为永久邮箱",
      icon: <Infinity />,
      action: () => {
        void action.run(() => mutate(m, "toggle-permanent"));
      },
    },
    {
      label: "停用并清理邮箱",
      icon: <Trash2 />,
      danger: true,
      action: () =>
        w.confirm(
          "停用这个邮箱？",
          `${m.address} 将拒收后续邮件，未置顶的邮件也会清理。仍绑定平台的地址需先解除绑定。`,
          () => mutate(m, "destroy"),
        ),
    },
  ];
  return (
    <>
      <PageHeader
        title="临时邮箱"
        description="按域名分配收件地址；重要的地址可以长期保留。"
      >
        <Button variant="outline" onClick={() => setBatchCreate(true)}>
          批量分配邮箱
        </Button>
        <Button onClick={() => setCreate(true)}>
          <Plus data-icon="inline-start" />
          生成邮箱
        </Button>
      </PageHeader>
      {verification && (
        <QuickVerification
          target={verification}
          close={() => setVerification(null)}
        />
      )}
      {box && (
        <section className="active-mailbox">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-2">
              <span className="text-xs text-muted-foreground">
                当前收件地址
              </span>
              <div className="flex items-center gap-2">
                <h2 className="break-all text-xl font-semibold">
                  {box.address}
                </h2>
                <CopyButton value={box.address} label="复制当前邮箱" />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant="outline">
                  {box.is_permanent
                    ? "永久保留"
                    : remaining > 0
                      ? `剩余 ${Math.floor(remaining / 60)} 分 ${remaining % 60} 秒`
                      : "已过期，可延长"}
                </Badge>
                {!canReceive && (
                  <span className="text-xs text-muted-foreground">
                    当前已停止收件
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <RefreshButton onClick={inbox.reload} busy={inbox.loading} />
              <Menu items={items(box)} />
            </div>
          </div>
          <div className="mt-3 flex min-w-0 flex-col gap-2">
            <PollingControls polling={inbox} disabled={!canReceive} />
            <RelatedVaultAccounts key={box.address} email={box.address} />
          </div>
          <div className="mt-5 rounded-lg border bg-card">
            {inbox.error ? (
              <ErrorState message={inbox.error} retry={inbox.reload} />
            ) : !inbox.result ? (
              <Loading />
            ) : inbox.result.data.length ? (
              <MailRows mails={inbox.result.data} />
            ) : (
              <div className="flex items-center gap-3 p-5 text-sm text-muted-foreground">
                <MailIcon className="size-5 shrink-0" />
                {box.is_permanent || remaining > 0
                  ? "等待新邮件。使用这个地址收信后，邮件会显示在这里。"
                  : "这个地址已停止收件。延长有效期或设为永久邮箱后，可继续接收邮件。"}
              </div>
            )}
          </div>
        </section>
      )}
      {active.error && (
        <ErrorState message={active.error} retry={active.reload} />
      )}
      <div className="data-panel">
        <div className="filter-bar">
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              setPage(1);
            }}
            placeholder="搜索地址、备注或关联平台…"
          />
          <Pick
            label="邮箱域名"
            value={domain}
            onChange={(v) => {
              setDomain(v);
              setPage(1);
            }}
            options={[
              ["", "全部域名"],
              ...(w.settings?.domains || []).map(
                (d) => [d.domain, d.domain] as [string, string],
              ),
            ]}
          />
          <RefreshButton onClick={rows.reload} busy={rows.loading} />
        </div>
        <Tabs
          value={status}
          onValueChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          className="px-4 pt-2"
        >
          <TabsList variant="line">
            {[
              ["all", "全部"],
              ["active", "有效"],
              ["permanent", "永久"],
              ["expired", "已过期"],
            ].map(([k, v]) => (
              <TabsTrigger value={k} key={k}>
                {v}
                <span className="ml-1 text-xs text-muted-foreground">
                  {rows.result?.summary?.[k === "all" ? "total" : k] || 0}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {rows.error ? (
          <ErrorState message={rows.error} retry={rows.reload} />
        ) : !rows.result ? (
          <Loading />
        ) : !rows.result.data.length ? (
          <Blank
            title="准备一个收件地址"
            description="选择域名，即可生成随机地址或自定义前缀。"
          >
            <Button onClick={() => setCreate(true)}>生成邮箱</Button>
          </Blank>
        ) : (
          <>
            <div className="desktop-table">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>收件地址</TableHead>
                    <TableHead>有效期</TableHead>
                    <TableHead>关联平台</TableHead>
                    <TableHead>快捷查收</TableHead>
                    <TableHead className="w-12">
                      <span className="sr-only">操作</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.result.data.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <button
                            className="row-link"
                            onClick={() => setSelected(m.id)}
                          >
                            {m.address}
                          </button>
                          <CopyButton value={m.address} />
                        </div>
                        <p className="row-detail">
                          {m.remark || `创建于 ${date(m.created_at)}`}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {m.is_permanent
                            ? "永久保留"
                            : m.is_expired
                              ? "已过期"
                              : date(m.expires_at)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {m.associated_platform || (
                          <span className="text-muted-foreground">未关联</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setVerification({
                              path: `/api/mailboxes/${m.id}/code`,
                              label: m.address,
                            })
                          }
                        >
                          取码 / 链接
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelected(m.id)}
                        >
                          {m.mail_count} 封
                          <ArrowUpRight data-icon="inline-end" />
                        </Button>
                        <p className="row-detail">
                          {m.unread_count || 0} 未读 ·{" "}
                          {m.last_received_at
                            ? `最近 ${date(m.last_received_at)}`
                            : "尚未收到邮件"}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Menu items={items(m)} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="mobile-records">
              {rows.result.data.map((m) => (
                <article className="mobile-record" key={m.id}>
                  <div className="flex items-start justify-between gap-2">
                    <button
                      className="row-link break-all"
                      onClick={() => setSelected(m.id)}
                    >
                      {m.address}
                    </button>
                    <Menu items={items(m)} />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Badge variant="outline">
                      {m.is_permanent
                        ? "永久保留"
                        : m.is_expired
                          ? "已过期"
                          : date(m.expires_at)}
                    </Badge>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        setVerification({
                          path: `/api/mailboxes/${m.id}/code`,
                          label: m.address,
                        })
                      }
                    >
                      取码 / 链接
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setSelected(m.id)}
                    >
                      {m.mail_count} 封邮件
                    </Button>
                  </div>
                  <p className="row-detail break-words">
                    {m.remark || "未填写用途"} · {m.unread_count || 0} 未读
                  </p>
                </article>
              ))}
            </div>
          </>
        )}
        <Pager result={rows.result} page={page} setPage={setPage} />
      </div>
      {create && (
        <GenerateMailbox
          close={() => setCreate(false)}
          generated={(id) => {
            setSelected(id);
            w.refresh();
            setCreate(false);
          }}
        />
      )}
      {batchCreate && (
        <BatchMailboxes
          close={() => setBatchCreate(false)}
          generated={(id) => {
            setSelected(id);
            w.refresh();
          }}
        />
      )}
      {purpose && (
        <MailboxPurpose
          mailbox={purpose}
          close={() => setPurpose(null)}
          saved={() => {
            setPurpose(null);
            w.refresh();
          }}
        />
      )}
    </>
  );
}
function GenerateMailbox({
  close,
  generated,
}: {
  close: () => void;
  generated: (id: number) => void;
}) {
  const w = useWorkspace();
  const domains = (w.settings?.domains || []).filter((d) => d.enabled);
  const [domain, setDomain] = useState(
    domains.find((d) => d.is_default)?.domain || domains[0]?.domain || "",
  );
  const [prefix, setPrefix] = useState("");
  const [duration, setDuration] = useState("60");
  const [permanent, setPermanent] = useState(false);
  const [remark, setRemark] = useState("");
  const action = useAction({ inline: true });
  return (
    <Modal
      title="生成收件地址"
      description="留空前缀时自动分配随机地址，绑定平台后会永久保留。"
      close={close}
    >
      <form
        className="modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const r = await api<Mailbox>("/api/mailboxes/generate", "POST", {
              domain,
              prefix: prefix || undefined,
              duration_minutes: Number(duration),
              is_permanent: permanent,
              remark,
            });
            toast.success("邮箱已生成");
            generated(r.data.id);
          });
        }}
      >
        <ModalBody>
          <ActionError message={action.error} />
          <FieldGroup>
            <SelectField
              label="邮件域名"
              value={domain}
              onChange={setDomain}
              options={domains.map((d) => [
                d.domain,
                `${d.domain}${d.is_default ? "（默认）" : ""}`,
              ])}
            />
            <TextField
              label="用途备注（可选）"
              maxLength={500}
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder="例如：购物、订阅、开发测试"
            />
            <TextField
              label="自定义前缀（可选）"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder="留空自动生成"
            />
            <SelectField
              label="保留时间"
              value={duration}
              onChange={setDuration}
              disabled={permanent}
              options={[
                ["10", "10 分钟"],
                ["60", "1 小时"],
                ["1440", "1 天"],
                ["10080", "7 天"],
              ]}
            />
            <Field orientation="horizontal">
              <Checkbox
                id="mailbox-permanent"
                checked={permanent}
                onCheckedChange={(v) => setPermanent(v === true)}
              />
              <FieldLabel htmlFor="mailbox-permanent">
                永久保留这个地址
              </FieldLabel>
            </Field>
          </FieldGroup>
          {!domains.length && (
            <p className="text-sm text-destructive">
              请先在域名管理中添加或启用域名。
            </p>
          )}
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="outline" onClick={close}>
            取消
          </Button>
          <BusyButton type="submit" busy={action.busy} disabled={!domain}>
            生成邮箱
          </BusyButton>
        </ModalFooter>
      </form>
    </Modal>
  );
}
