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
import { FieldGroup } from "@/components/ui/field";
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
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  ExternalLink,
  KeyRound,
  Link,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
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
type Catalog = (typeof mailProviders)[number] & {
  account_count: number;
  attention_count: number;
};
const name = (provider: string) =>
  mailProviders.find((p) => p.id === provider)?.name || provider;

export default function ProvidersPage({
  initialQuery = "",
}: {
  initialQuery?: string;
}) {
  const w = useWorkspace();
  const [q, setQ] = useState(initialQuery),
    [provider, setProvider] = useState(""),
    [status, setStatus] = useState("all"),
    [page, setPage] = useState(1);
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
    `/api/providers/accounts?${query({ q: search, provider, status, page })}`,
    w.revision,
    { keepPreviousData: true },
  );
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
  return (
    <>
      <PageHeader
        title="外部邮箱"
        description="把临时邮箱服务商的账号接入工作区，统一查收、取码和关联平台账号。"
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
      <div className="mb-5 grid gap-4 sm:grid-cols-2">
        {mailProviders.map((p) => {
          const stats = catalog.result?.data.find((s) => s.id === p.id);
          return (
            <section
              key={p.id}
              className={cn(
                "flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-5",
                provider === p.id && "border-primary",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold">{p.name}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    账号密码登录 · 无需 API Key
                  </p>
                </div>
                <a
                  className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:underline"
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  服务商
                  <ExternalLink className="size-3" />
                </a>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">
                  {stats?.account_count ?? "—"} 个邮箱
                </Badge>
                {!!stats?.attention_count && (
                  <Badge variant="destructive">
                    {stats.attention_count} 个需处理
                  </Badge>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setProvider(p.id);
                    setPage(1);
                  }}
                >
                  查看账号
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditor({ provider: p.id, mode: "create" })}
                >
                  创建邮箱
                </Button>
                <a
                  className="inline-flex items-center text-xs text-muted-foreground hover:underline"
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
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        邮件保留时间和账号有效期由服务商决定。平台保存登录凭据，令牌失效时自动重新登录；服务商删除邮箱后需要重新接入可用账号。
      </p>
      <ActionError message={action.error || catalog.error} />
      <div className="data-panel" aria-busy={rows.loading}>
        <div className="filter-bar">
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              setPage(1);
            }}
            placeholder="搜索外部邮箱或用途…"
          />
          <Pick
            label="服务商筛选"
            value={provider}
            onChange={(v) => {
              setProvider(v);
              setPage(1);
            }}
            options={[
              ["", "全部服务商"],
              ...mailProviders.map((p) => [p.id, p.name] as [string, string]),
            ]}
          />
          <Pick
            label="账号状态筛选"
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            options={[
              ["all", "全部状态"],
              ["active", "启用"],
              ["attention", "需要处理"],
              ["disabled", "停用"],
            ]}
          />
          <RefreshButton
            busy={rows.loading}
            onClick={() => {
              rows.reload();
              catalog.reload();
            }}
          />
        </div>
        {rows.error ? (
          <ErrorState message={rows.error} retry={rows.reload} />
        ) : !rows.result ? (
          <Loading />
        ) : !rows.result.data.length ? (
          <Blank
            title="尚无匹配的外部邮箱"
            description="接入已有 Mail.tm / Mail.gw 账号，或创建一个新邮箱。"
          />
        ) : (
          <div className="divide-y">
            {rows.result.data.map((a) => (
              <article
                key={a.id}
                className="flex min-w-0 flex-col gap-4 p-4 sm:flex-row sm:items-center"
                aria-label={`外部邮箱 ${a.address}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="break-all font-medium">{a.address}</span>
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
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      w.identity({ address: a.address, source: a.provider })
                    }
                  >
                    查看全部登记
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={a.status !== "active"}
                    onClick={() => setReader(a)}
                  >
                    <Mail data-icon="inline-start" />
                    收件
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={a.status !== "active"}
                    onClick={() => verify(a)}
                  >
                    <KeyRound data-icon="inline-start" />
                    取码 / 链接
                  </Button>
                  <Menu
                    label={`邮箱操作：${a.address}`}
                    items={[
                      {
                        label: "编辑账号 / 查看密码",
                        icon: <Pencil />,
                        action: () => setEditor({ id: a.id }),
                      },
                      {
                        label: "测试连接",
                        icon: <RefreshCw />,
                        disabled: action.busy || a.status !== "active",
                        action: () => check(a),
                      },
                      {
                        label: "登记平台账号",
                        icon: <Link />,
                        action: () =>
                          w.vault({
                            account_email: a.address,
                            email_source: a.provider,
                          }),
                      },
                      {
                        label: "查看全部登记",
                        icon: <Link />,
                        action: () =>
                          w.identity({
                            address: a.address,
                            source: a.provider,
                          }),
                      },
                      {
                        label: "移除接入",
                        icon: <Trash2 />,
                        danger: true,
                        action: () =>
                          w.confirm(
                            "移除此邮箱接入？",
                            `${a.address} 将从本平台移除，服务商邮箱仍保留。已关联平台的账号需要先调整绑定。`,
                            async () => {
                              const r = await api(
                                `/api/providers/accounts/${a.id}`,
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
              </article>
            ))}
          </div>
        )}
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
          ? "已显示保存的密码。此处更新用于登录的凭据，不会修改服务商网站的密码。"
          : "选择服务商，接入已有账号或创建新邮箱；登录凭据会保存到工作区。"
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
  const [provider, setProvider] = useState<MailProviderId>(
      initial?.provider || seedProvider || "mailtm",
    ),
    [mode, setMode] = useState(seedMode || "connect");
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
                <SelectField
                  label="邮箱服务商"
                  value={provider}
                  onChange={(value) => {
                    setProvider(value as MailProviderId);
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
              label="邮箱密码"
              required
              minLength={creating ? 8 : 1}
              value={password}
              onChange={setPassword}
              disabled={action.busy || attemptedCreate}
            />
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
