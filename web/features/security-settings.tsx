import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActionError,
  Blank,
  BusyButton,
  CopyButton,
  ErrorState,
  Loading,
  Modal,
  ModalBody,
  ModalFooter,
  Pager,
  Pick,
  RefreshButton,
  TextField,
} from "@/components/common";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { FieldGroup } from "@/components/ui/field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, date, query, useResource } from "@/lib/api";
import { useWorkspace } from "@/lib/context";
import { KeyRound, Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

const scopes = [
  ["verify:read", "查询验证码", "查收指定邮箱的验证码与验证链接"],
  ["mailbox:write", "管理邮箱", "分配、延长和管理邮箱"],
  ["vault:read", "读取平台账号", "包含密码与 TOTP，请仅授予可信程序"],
  ["vault:write", "修改平台账号", "创建和批量更新台账"],
  ["admin", "业务管理员", "可管理业务资源与发送邮件；基础设施仍需网页登录"],
] as const;
interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  restrictions: { emails?: string[]; platforms?: string[] };
  expires_at: string;
  revoked_at: string;
  last_used_at: string;
}

// Settings mutations must stop updating UI, copying secrets or starting another
// batch when their tab unmounts. Aborting does not roll back server-side writes.
export function useSettingsAction() {
  const current = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      current.current?.abort();
    };
  }, []);
  const run = async (task: (signal: AbortSignal) => Promise<void>) => {
    if (!mounted.current || current.current) return;
    const controller = new AbortController();
    current.current = controller;
    setBusy(true);
    setError("");
    try {
      await task(controller.signal);
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "操作失败，请重试");
    } finally {
      if (current.current === controller) current.current = null;
      if (mounted.current) setBusy(false);
    }
  };
  return { busy, error, run, cancel: () => current.current?.abort() };
}

export function useSettingsUnloadGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [active]);
}

export function SettingsConfirmation({
  title,
  description,
  close,
  action,
  children,
}: {
  title: string;
  description: string;
  close: () => void;
  action: (signal: AbortSignal) => Promise<void>;
  children?: ReactNode;
}) {
  const request = useSettingsAction();
  useSettingsUnloadGuard(request.busy);
  return (
    <AlertDialog
      open
      onOpenChange={(open) => !open && !request.busy && close()}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
          {children}
          <ActionError message={request.error} />
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={request.busy}>取消</AlertDialogCancel>
          <BusyButton
            variant="destructive"
            busy={request.busy}
            onClick={() =>
              void request.run(async (signal) => {
                await action(signal);
                signal.throwIfAborted();
                close();
              })
            }
          >
            确认操作
          </BusyButton>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function OneTimeSecret({
  title,
  value,
  close,
  oneTime = true,
}: {
  title: string;
  value: string;
  close: () => void;
  oneTime?: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  useSettingsUnloadGuard(oneTime);
  return (
    <Modal
      title={title}
      description={
        oneTime
          ? "仅本次显示完整密钥，请保存到接收服务或可信的密码管理器。"
          : "剪贴板不可用，请选择下方文本手动复制到可信的接收服务。"
      }
      close={oneTime ? () => setDismissed(true) : close}
    >
      <ModalBody>
        <div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-4">
          <code className="min-w-0 flex-1 select-all break-all text-sm">
            {value}
          </code>
          <CopyButton value={value} label="复制新密钥" />
        </div>
        {oneTime && (
          <p className="text-sm text-muted-foreground">
            刷新或离开页面后无法再次查看。请先保存，再点击“已保存，关闭”。
          </p>
        )}
        {dismissed && (
          <p role="alert" className="text-sm text-destructive">
            密钥仍为你保留。确认已保存后，再使用下方按钮关闭。
          </p>
        )}
      </ModalBody>
      <ModalFooter>
        <Button onClick={close}>已保存，关闭</Button>
      </ModalFooter>
    </Modal>
  );
}
export function SecuritySettings() {
  const w = useWorkspace();
  const [page, setPage] = useState(1),
    [creating, setCreating] = useState(false),
    [secret, setSecret] = useState(""),
    [revoking, setRevoking] = useState<ApiKey | null>(null);
  const keys = useResource<ApiKey[]>(`/api/api-keys?page=${page}`, w.revision);
  return (
    <div className="flex min-w-0 flex-col gap-6 [overflow-wrap:anywhere]">
      <Credentials />
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-2">
            <CardTitle>自动化密钥</CardTitle>
            <CardDescription>
              为每个脚本单独授权，支持到期、撤销及邮箱和平台限制。
            </CardDescription>
          </div>
          <Button onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" />
            新建密钥
          </Button>
        </CardHeader>
        <CardContent>
          {keys.loading ? (
            <Loading />
          ) : keys.error ? (
            <ErrorState message={keys.error} retry={keys.reload} />
          ) : !keys.result?.data.length ? (
            <Blank
              title="还没有自动化密钥"
              description="建议让查码脚本只持有“查询验证码”权限。"
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>密钥</TableHead>
                    <TableHead>权限与限制</TableHead>
                    <TableHead>有效期</TableHead>
                    <TableHead>最近使用</TableHead>
                    <TableHead>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.result.data.map((key) => (
                    <TableRow key={key.id}>
                      <TableCell className="whitespace-normal">
                        <p className="max-w-48 font-medium">{key.name}</p>
                        <code className="text-xs text-muted-foreground">
                          {key.prefix}…
                        </code>
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        <div className="flex max-w-sm flex-wrap gap-1">
                          {key.scopes.map((s) => (
                            <Badge variant="outline" key={s}>
                              {scopes.find(([id]) => id === s)?.[1] || s}
                            </Badge>
                          ))}
                        </div>
                        <p className="mt-1 max-w-sm break-words text-xs text-muted-foreground">
                          {[
                            key.restrictions.emails?.join("、"),
                            key.restrictions.platforms?.join("、"),
                          ]
                            .filter(Boolean)
                            .join(" · ") || "全部业务资源"}
                        </p>
                      </TableCell>
                      <TableCell>
                        {key.revoked_at ? (
                          <Badge variant="outline">已撤销</Badge>
                        ) : Date.parse(key.expires_at) <= Date.now() ? (
                          <Badge variant="outline">已到期</Badge>
                        ) : (
                          date(key.expires_at)
                        )}
                      </TableCell>
                      <TableCell>{date(key.last_used_at)}</TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!!key.revoked_at}
                          onClick={() => setRevoking(key)}
                        >
                          撤销
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <Pager page={page} setPage={setPage} result={keys.result} />
        </CardContent>
      </Card>
      {revoking && (
        <SettingsConfirmation
          title="撤销这个密钥？"
          description={`${revoking.name} 的后续请求会立即失效。`}
          close={() => setRevoking(null)}
          action={async (signal) => {
            await api(
              `/api/api-keys/${encodeURIComponent(revoking.id)}`,
              "DELETE",
              undefined,
              signal,
            );
            signal.throwIfAborted();
            w.refresh();
            toast.success("密钥已撤销");
          }}
        />
      )}
      {creating && (
        <KeyEditor
          close={() => setCreating(false)}
          saved={(value) => {
            setCreating(false);
            setSecret(value);
            w.refresh();
          }}
        />
      )}
      {secret && (
        <OneTimeSecret
          title="自动化密钥已创建"
          value={secret}
          close={() => setSecret("")}
        />
      )}
    </div>
  );
}
function KeyEditor({
  close,
  saved,
}: {
  close: () => void;
  saved: (secret: string) => void;
}) {
  const [name, setName] = useState(""),
    [selected, setSelected] = useState<string[]>(["verify:read"]),
    [days, setDays] = useState("30"),
    [emails, setEmails] = useState(""),
    [platforms, setPlatforms] = useState("");
  const action = useSettingsAction();
  useSettingsUnloadGuard(action.busy);
  const values = (input: string) =>
    input
      .split(/[,，;；\n]/)
      .map((v) => v.trim())
      .filter(Boolean);
  return (
    <Modal
      title="新建自动化密钥"
      description="限制采用精确匹配，同时填写邮箱和平台时，目标必须同时符合。"
      close={() => !action.busy && close()}
    >
      <form
        className="modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async (signal) => {
            const result = await api<{ key: string }>(
              "/api/api-keys",
              "POST",
              {
                name,
                scopes: selected,
                expires_at: new Date(
                  Date.now() + Number(days) * 86400000,
                ).toISOString(),
                restrictions: {
                  ...(values(emails).length ? { emails: values(emails) } : {}),
                  ...(values(platforms).length
                    ? { platforms: values(platforms) }
                    : {}),
                },
              },
              signal,
            );
            signal.throwIfAborted();
            saved(result.data.key);
          });
        }}
      >
        <ModalBody>
          <fieldset disabled={action.busy} className="min-w-0">
            <FieldGroup>
              <TextField
                label="用途名称"
                placeholder="例如：注册流程查码"
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <fieldset className="flex flex-col gap-3">
                <legend className="mb-3 text-sm font-medium">授权范围</legend>
                {scopes.map(([id, label, hint]) => (
                  <label
                    key={id}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border p-3"
                  >
                    <Checkbox
                      aria-label={label}
                      checked={selected.includes(id)}
                      onCheckedChange={(checked) =>
                        setSelected((old) =>
                          checked ? [...old, id] : old.filter((s) => s !== id),
                        )
                      }
                    />
                    <span className="flex flex-col gap-1 text-sm">
                      <span className="font-medium">{label}</span>
                      <span className="text-xs text-muted-foreground">
                        {hint}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <TextField
                label="有效天数"
                type="number"
                min={1}
                max={365}
                required
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
              <TextField
                label="仅允许这些邮箱（可选）"
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                help="多个地址用逗号分隔。留空表示不限制邮箱；不支持通配符。"
              />
              <TextField
                label="仅允许这些平台（可选）"
                value={platforms}
                onChange={(e) => setPlatforms(e.target.value)}
                help="使用台账中准确的平台名称。受限密钥优先使用邮箱或账号 ID 查询。"
              />
            </FieldGroup>
          </fieldset>
          <ActionError message={action.error} />
          {action.error && (
            <p className="text-xs text-muted-foreground">
              若创建时连接中断，请先核对密钥列表。未保存完整密钥的新增项应撤销后重新创建。
            </p>
          )}
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
            busy={action.busy}
            disabled={!selected.length}
            type="submit"
          >
            <KeyRound data-icon="inline-start" />
            创建密钥
          </BusyButton>
        </ModalFooter>
      </form>
    </Modal>
  );
}
interface EncryptionStatus {
  enabled: boolean;
  previous_key_available: boolean;
  tables: { table: string; plaintext_records: number }[];
}
function Credentials() {
  const status = useResource<EncryptionStatus>("/api/settings/credentials");
  const action = useSettingsAction();
  const [progress, setProgress] = useState("");
  const [interrupted, setInterrupted] = useState(() => {
    try {
      return sessionStorage.getItem("mailhub:rekey-incomplete") === "1";
    } catch {
      return false;
    }
  });
  useSettingsUnloadGuard(action.busy);
  const markInterrupted = (value: boolean) => {
    setInterrupted(value);
    try {
      if (value) sessionStorage.setItem("mailhub:rekey-incomplete", "1");
      else sessionStorage.removeItem("mailhub:rekey-incomplete");
    } catch {
      /* Progress is optional; no credentials are persisted here. */
    }
  };
  const plaintext =
    status.result?.data.tables.reduce(
      (sum, t) => sum + t.plaintext_records,
      0,
    ) || 0;
  const rekey = () =>
    void action.run(async (signal) => {
      if (status.loading || !status.result?.data.enabled) return;
      markInterrupted(true);
      setProgress("正在核对凭据；已完成的批次会保留。");
      let changed = 0,
        skipped = 0;
      for (const table of status.result?.data.tables || []) {
        let cursor: string | number = table.table === "oauth_sessions" ? "" : 0,
          complete = false;
        while (!complete) {
          signal.throwIfAborted();
          const r = await api<{
            cursor: string | number;
            complete: boolean;
            changed: number;
            skipped: number;
          }>(
            "/api/settings/credentials/rekey",
            "POST",
            { table: table.table, cursor },
            signal,
          );
          signal.throwIfAborted();
          if (!r.data.complete && r.data.cursor === cursor)
            throw new Error("重加密游标未推进，已停止。请稍后重新核对。");
          changed += r.data.changed;
          skipped += r.data.skipped;
          cursor = r.data.cursor;
          complete = r.data.complete;
          setProgress(
            `已处理 ${changed} 条凭据记录${skipped ? `，${skipped} 条并发更新已跳过` : ""}`,
          );
        }
      }
      signal.throwIfAborted();
      markInterrupted(skipped > 0);
      status.reload();
      toast.success(
        skipped ? "本轮已完成，请再运行一轮核对并发更新记录" : "凭据加密已完成",
      );
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4" />
          凭据保护
        </CardTitle>
        <CardDescription>
          密码、TOTP、微软刷新令牌及通知签名密钥在写入数据库前加密。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {status.loading ? (
          <Loading />
        ) : status.error ? (
          <ErrorState message={status.error} retry={status.reload} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={status.result?.data.enabled ? "secondary" : "outline"}
              >
                {status.result?.data.enabled
                  ? "新增凭据已启用加密"
                  : "尚未配置加密密钥"}
              </Badge>
              <Badge variant="outline">{plaintext} 条历史记录待加密</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {status.result?.data.enabled
                ? "升级历史记录或轮换密钥后，运行全量重加密。切换设置页或关闭页面会停止后续批次，已写入记录会保留；返回后可从头安全核对。"
                : "管理员需在 Worker Secrets 中配置至少 32 位随机 CREDENTIAL_ENCRYPTION_KEY；已有 STORAGE_ENCRYPTION_KEY 时会自动复用。"}
            </p>
            {status.result?.data.previous_key_available && (
              <p className="text-sm text-muted-foreground">
                旧密钥仍可用于读取历史记录。确认所有记录重加密完成，并保存独立备份后，再移除旧密钥。
              </p>
            )}
          </>
        )}
        {progress && (
          <p role="status" className="text-sm">
            {progress}
          </p>
        )}
        {interrupted && !action.busy && (
          <p role="status" className="text-sm text-muted-foreground">
            上轮核对尚未确认完成。继续核对会从头检查所有记录，不会撤销已经完成的加密。
          </p>
        )}
        <ActionError message={action.error} />
      </CardContent>
      <CardFooter className="flex-wrap gap-2">
        <BusyButton
          variant="outline"
          busy={action.busy}
          disabled={
            status.loading || !!status.error || !status.result?.data.enabled
          }
          onClick={rekey}
        >
          {interrupted && !action.busy
            ? "继续核对并重加密"
            : "加密 / 重加密全部凭据"}
        </BusyButton>
        {action.busy && (
          <Button
            variant="outline"
            onClick={() => {
              action.cancel();
              setProgress(
                "已停止后续批次；正在处理的批次可能已经写入。返回后可继续核对。",
              );
            }}
          >
            停止后续批次
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
interface Audit {
  id: number;
  actor_type: string;
  api_key_prefix: string;
  action: string;
  route: string;
  status: number;
  request_id: string;
  created_at: string;
}
export function AuditSettings() {
  const [page, setPage] = useState(1),
    [actor, setActor] = useState("");
  const rows = useResource<Audit[]>(
    `/api/audit?${query({ page, actor_type: actor })}`,
  );
  const actors: [string, string][] = [
    ["", "全部身份"],
    ["admin_session", "网页登录"],
    ["api_key", "自动化密钥"],
    ["master_key", "主密钥"],
    ["anonymous", "未登录"],
    ["system", "系统"],
  ];
  return (
    <Card className="min-w-0 [overflow-wrap:anywhere]">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <CardTitle>操作记录</CardTitle>
          <CardDescription>
            保留 90 天操作元数据，便于排查权限、请求与自动化问题。
          </CardDescription>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Pick
            label="筛选操作身份"
            value={actor}
            onChange={(value) => {
              setActor(value);
              setPage(1);
            }}
            options={actors}
          />
          <RefreshButton onClick={rows.reload} busy={rows.loading} />
        </div>
      </CardHeader>
      <CardContent>
        {rows.loading ? (
          <Loading />
        ) : rows.error ? (
          <ErrorState message={rows.error} retry={rows.reload} />
        ) : !rows.result?.data.length ? (
          <Blank title="暂无操作记录" />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>身份</TableHead>
                  <TableHead>操作</TableHead>
                  <TableHead>结果</TableHead>
                  <TableHead>请求 ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.result.data.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap">
                      {date(row.created_at)}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {actors.find(([id]) => id === row.actor_type)?.[1] ||
                        row.actor_type}
                      <p className="font-mono text-xs text-muted-foreground">
                        {row.api_key_prefix}
                      </p>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <p className="max-w-64">{row.action}</p>
                      <code className="block max-w-64 break-all text-xs text-muted-foreground">
                        {row.route}
                      </code>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={row.status >= 400 ? "destructive" : "outline"}
                      >
                        {row.status || "开始执行"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <code
                          className="max-w-32 truncate text-xs"
                          title={row.request_id}
                        >
                          {row.request_id}
                        </code>
                        <CopyButton
                          value={row.request_id}
                          label="复制请求 ID"
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <Pager result={rows.result} page={page} setPage={setPage} />
      </CardContent>
    </Card>
  );
}
