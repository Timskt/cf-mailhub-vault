import { useState } from "react";
import {
  ActionError,
  Blank,
  BusyButton,
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
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldGroup } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  OneTimeSecret,
  SettingsConfirmation,
  useSettingsAction,
  useSettingsUnloadGuard,
} from "@/features/security-settings";
import { api, date, query, useResource } from "@/lib/api";
import { useWorkspace } from "@/lib/context";
import { Plus } from "lucide-react";
import { toast } from "sonner";

const events = [
  ["mail.received", "域名邮箱收到邮件"],
  ["code.extracted", "域名邮件提取到验证码或链接"],
  ["token.renew_failed", "Outlook 自动续期失败"],
  ["storage.sync_interrupted", "数据源同步暂停"],
] as const;
const states: [string, string][] = [
  ["", "全部投递状态"],
  ["pending", "等待重试"],
  ["delivering", "正在投递"],
  ["delivered", "已送达"],
  ["dead", "投递失败"],
  ["cancelled", "已取消"],
];
interface Hook {
  id: number;
  name: string;
  destination: string;
  events: string[];
  include_code: number;
  enabled: number;
}
interface Delivery {
  id: string;
  webhook_id: number;
  event: string;
  status: string;
  attempts: number;
  http_status: number;
  error: string;
  next_attempt: number;
  created_at: string;
}
export default function WebhookSettings() {
  const w = useWorkspace();
  const [creating, setCreating] = useState(false),
    [secret, setSecret] = useState(""),
    [page, setPage] = useState(1),
    [status, setStatus] = useState("");
  const [confirmation, setConfirmation] = useState<{
    title: string;
    description: string;
    action: (signal: AbortSignal) => Promise<void>;
  } | null>(null);
  const hooks = useResource<Hook[]>("/api/settings/webhooks", w.revision);
  const rows = useResource<Delivery[]>(
    `/api/settings/webhooks/deliveries?${query({ page, status })}`,
    w.revision,
  );
  const action = useSettingsAction();
  useSettingsUnloadGuard(action.busy);
  const encryptionReady = (
    hooks.result as { encryption_ready?: boolean } | undefined
  )?.encryption_ready;
  return (
    <div className="flex min-w-0 flex-col gap-6 [overflow-wrap:anywhere]">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-2">
            <CardTitle>事件通知</CardTitle>
            <CardDescription>
              邮件与运行状态通过带签名的 HTTPS 请求送达你的服务，失败自动重试。
            </CardDescription>
          </div>
          <Button
            disabled={
              hooks.loading ||
              !!hooks.error ||
              encryptionReady === false ||
              (hooks.result?.data.length || 0) >= 50
            }
            onClick={() => setCreating(true)}
          >
            <Plus data-icon="inline-start" />
            添加订阅
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {encryptionReady === false && (
            <p role="status" className="text-sm text-muted-foreground">
              请先在“凭据与密钥”中完成加密配置，再添加通知订阅。
            </p>
          )}
          {hooks.loading ? (
            <Loading />
          ) : hooks.error ? (
            <ErrorState message={hooks.error} retry={hooks.reload} />
          ) : !hooks.result?.data.length ? (
            <Blank
              title="还没有通知订阅"
              description="将来信、验证码、续期失败等事件接入你的自动化流程。"
            />
          ) : (
            hooks.result.data.map((hook) => (
              <div
                key={hook.id}
                className="flex flex-col items-start justify-between gap-4 rounded-lg border p-4 sm:flex-row"
              >
                <div className="w-full min-w-0 flex-1">
                  <p className="break-words font-medium">{hook.name}</p>
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    {hook.destination}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1">
                    {hook.events.map((event) => (
                      <Badge
                        key={event}
                        variant="outline"
                        className="h-auto max-w-full whitespace-normal break-words"
                      >
                        {events.find(([id]) => id === event)?.[1] || event}
                      </Badge>
                    ))}
                    {!!hook.include_code && (
                      <Badge
                        variant="secondary"
                        className="h-auto max-w-full whitespace-normal"
                      >
                        包含主题与验证信息
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <Switch
                    aria-label={`${hook.name} 启用通知`}
                    checked={!!hook.enabled}
                    disabled={action.busy || hooks.loading || !!confirmation}
                    onCheckedChange={(enabled) => {
                      void action.run(async (signal) => {
                        await api(
                          `/api/settings/webhooks/${hook.id}`,
                          "PATCH",
                          { enabled },
                          signal,
                        );
                        signal.throwIfAborted();
                        w.refresh();
                      });
                    }}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={action.busy || hooks.loading}
                    onClick={() =>
                      setConfirmation({
                        title: "删除这个订阅？",
                        description: `${hook.name} 的后续事件停止投递，已有投递记录仍保留。`,
                        action: async (signal) => {
                          await api(
                            `/api/settings/webhooks/${hook.id}`,
                            "DELETE",
                            undefined,
                            signal,
                          );
                          signal.throwIfAborted();
                          w.refresh();
                          toast.success("订阅已删除");
                        },
                      })
                    }
                  >
                    删除
                  </Button>
                </div>
              </div>
            ))
          )}
          <ActionError message={action.error} />
          <p className="text-xs leading-relaxed text-muted-foreground">
            接收服务需在 8 秒内返回 2xx。请校验 X-MailHub-Signature
            和时间戳，并使用 X-MailHub-Delivery 去重。每分钟处理队列，最多重试 8
            次；投递采用至少一次语义。
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-2">
            <CardTitle>投递记录</CardTitle>
            <CardDescription>
              查看接收结果与重试状态。失败记录可手动重新排队。
            </CardDescription>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Pick
              label="投递状态"
              value={status}
              onChange={(value) => {
                setStatus(value);
                setPage(1);
              }}
              options={states}
            />
            <RefreshButton busy={rows.loading} onClick={rows.reload} />
          </div>
        </CardHeader>
        <CardContent>
          {rows.loading ? (
            <Loading />
          ) : rows.error ? (
            <ErrorState message={rows.error} retry={rows.reload} />
          ) : !rows.result?.data.length ? (
            <Blank
              title="暂无投递记录"
              description="订阅的事件发生后，会在这里显示投递结果。"
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>事件 / 订阅</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>尝试次数</TableHead>
                    <TableHead>时间</TableHead>
                    <TableHead>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.result.data.map((row) => {
                    const hook = hooks.result?.data.find(
                      (h) => h.id === row.webhook_id,
                    );
                    const retryAvailable =
                      !!hook?.enabled && !hooks.loading && !hooks.error;
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="whitespace-normal">
                          <p>
                            {events.find(([id]) => id === row.event)?.[1] ||
                              row.event}
                          </p>
                          <p className="max-w-48 text-xs text-muted-foreground">
                            {hook?.name || `订阅 #${row.webhook_id}`}
                          </p>
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          <Badge
                            variant={
                              row.status === "dead" ? "destructive" : "outline"
                            }
                          >
                            {states.find(([id]) => id === row.status)?.[1] ||
                              row.status}
                          </Badge>
                          {row.error && (
                            <p className="mt-1 max-w-xs break-words text-xs text-muted-foreground">
                              {row.error}
                            </p>
                          )}
                        </TableCell>
                        <TableCell>{row.attempts} / 8</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {date(row.created_at)}
                          {row.status === "pending" && (
                            <p className="text-xs text-muted-foreground">
                              下次：
                              {Number.isFinite(row.next_attempt)
                                ? date(new Date(row.next_attempt).toISOString())
                                : "等待调度"}
                            </p>
                          )}
                        </TableCell>
                        <TableCell>
                          {["dead", "cancelled"].includes(row.status) && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!retryAvailable || action.busy}
                              onClick={() =>
                                setConfirmation({
                                  title: "重新投递此事件？",
                                  description:
                                    "接收方可能已收到之前的请求。请确保接收服务按投递 ID 去重。",
                                  action: async (signal) => {
                                    await api(
                                      `/api/settings/webhooks/deliveries/${encodeURIComponent(row.id)}/retry`,
                                      "POST",
                                      {},
                                      signal,
                                    );
                                    signal.throwIfAborted();
                                    rows.reload();
                                    toast.success("已加入重试队列");
                                  },
                                })
                              }
                            >
                              重试
                            </Button>
                          )}
                          {["dead", "cancelled"].includes(row.status) &&
                            !retryAvailable &&
                            !hooks.loading && (
                              <p className="mt-1 text-xs text-muted-foreground">
                                {hooks.error
                                  ? "请刷新订阅列表"
                                  : hook
                                    ? "请先启用订阅"
                                    : "订阅已删除"}
                              </p>
                            )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          <Pager result={rows.result} page={page} setPage={setPage} />
        </CardContent>
      </Card>
      {confirmation && (
        <SettingsConfirmation
          {...confirmation}
          close={() => setConfirmation(null)}
        />
      )}
      {creating && (
        <HookEditor
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
          title="保存通知签名密钥"
          value={secret}
          close={() => setSecret("")}
        />
      )}
    </div>
  );
}
function HookEditor({
  close,
  saved,
}: {
  close: () => void;
  saved: (secret: string) => void;
}) {
  const [name, setName] = useState(""),
    [url, setUrl] = useState(""),
    [selected, setSelected] = useState<string[]>(["mail.received"]),
    [include, setInclude] = useState(false);
  const action = useSettingsAction();
  useSettingsUnloadGuard(action.busy);
  return (
    <Modal
      title="添加事件订阅"
      description="通知地址与签名密钥加密保存。请使用自己信任的接收服务。"
      close={() => !action.busy && close()}
    >
      <form
        className="modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async (signal) => {
            const target = new URL(url);
            if (
              target.protocol !== "https:" ||
              target.username ||
              target.password ||
              target.hash
            )
              throw new Error("请填写不含账号密码或片段的 HTTPS 接收地址");
            const r = await api<{ secret: string }>(
              "/api/settings/webhooks",
              "POST",
              { name, url, events: selected, include_code: include },
              signal,
            );
            signal.throwIfAborted();
            saved(r.data.secret);
          });
        }}
      >
        <ModalBody>
          <fieldset disabled={action.busy} className="min-w-0">
            <FieldGroup>
              <TextField
                label="订阅名称"
                value={name}
                maxLength={100}
                required
                onChange={(e) => setName(e.target.value)}
              />
              <TextField
                label="接收地址"
                type="url"
                autoCapitalize="none"
                spellCheck={false}
                value={url}
                required
                maxLength={2000}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://hooks.your-domain.com/mailhub"
                help="仅支持公网 HTTPS 域名，拒绝内网、IP 地址与跳转响应。"
              />
              <fieldset className="flex flex-col gap-3">
                <legend className="mb-3 text-sm font-medium">通知事件</legend>
                {events.map(([id, label]) => (
                  <label key={id} className="flex items-center gap-3 text-sm">
                    <Checkbox
                      checked={selected.includes(id)}
                      onCheckedChange={(checked) =>
                        setSelected((old) =>
                          checked
                            ? [...old, id]
                            : old.filter((event) => event !== id),
                        )
                      }
                      aria-label={label}
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
              <label className="flex items-start gap-3 rounded-lg border p-3">
                <Checkbox
                  checked={include}
                  onCheckedChange={(v) => setInclude(v === true)}
                  aria-label="通知包含验证信息"
                />
                <span className="flex flex-col gap-1 text-sm">
                  通知包含主题、验证码与验证链接
                  <span className="text-xs text-muted-foreground">
                    这些内容可能用于登录账号，启用后会发送给上面的接收服务。
                  </span>
                </span>
              </label>
            </FieldGroup>
          </fieldset>
          <ActionError message={action.error} />
          {action.error && (
            <p className="text-xs text-muted-foreground">
              若创建时连接中断，请先核对订阅列表。未保存签名密钥的新订阅应删除后重新创建。
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
            type="submit"
            busy={action.busy}
            disabled={!selected.length}
          >
            创建订阅
          </BusyButton>
        </ModalFooter>
      </form>
    </Modal>
  );
}
