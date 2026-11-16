import {
  ActionError,
  BusyButton,
  CopyButton,
  ErrorState,
  Loading,
  Menu,
  Modal,
  ModalBody,
  ModalFooter,
  PageHeader,
  SelectField,
  TextField,
} from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { FieldGroup } from "@/components/ui/field";
import { api, date, useAction, useResource } from "@/lib/api";
import { useWorkspace } from "@/lib/context";
import { cn } from "@/lib/utils";
import {
  ArrowRightLeft,
  Check,
  CircleAlert,
  Database,
  Link2,
  Play,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
type Source = {
  id: string;
  name: string;
  kind: "d1" | "mysql" | "mongodb" | "redis";
  endpoint?: string;
  source?: string;
  has_token: boolean;
  transport?: "http" | "redis";
  purpose?: "primary" | "replica";
};
type Job = {
  id: string;
  from: { sourceId: string };
  to: { sourceId: string };
  phase: "copy" | "replay" | "verify" | "complete" | "cancelled";
  tableIndex: number;
  base: number;
  applied: number;
  copied: number;
  verified: number;
  paused: boolean;
  error: string;
  started: string;
  finished?: string;
  mode?: "switch" | "snapshot";
};
type Status = {
  enabled: boolean;
  encryption_ready: boolean;
  active?: { sourceId: string; generation: string };
  revision?: number;
  sources: Source[];
  job: Job | null;
  write_paused?: boolean;
  pending_write?: boolean;
};
const labels = {
  d1: "Cloudflare D1",
  mysql: "MySQL",
  mongodb: "MongoDB",
  redis: "Redis",
};
export default function StoragePage() {
  const w = useWorkspace(),
    resource = useResource<Status>("/api/settings/storage"),
    action = useAction();
  const [editing, setEditing] = useState<Source | null>(null);
  const [adding, setAdding] = useState(false),
    [health, setHealth] = useState<Record<string, string>>({});
  const data = resource.result?.data,
    job = data?.job,
    running = job && !["complete", "cancelled"].includes(job.phase);
  useEffect(() => {
    if (!running || job?.paused) return;
    const timer = setInterval(resource.reload, 2000);
    return () => clearInterval(timer);
  }, [running, job?.paused, resource.reload]);
  const refresh = () => {
    resource.reload();
    w.refresh();
  };
  const command = async (path: string, message: string) => {
    await api(`/api/settings/storage/${path}`, "POST");
    toast.success(message);
    refresh();
  };
  return (
    <>
      <PageHeader
        title="数据源"
        description="连接你的数据库，在不同实例和服务器之间同步、校验并切换。"
      >
        <Button variant="outline" onClick={resource.reload}>
          <RefreshCw data-icon="inline-start" />
          刷新
        </Button>
        <Button
          onClick={() => setAdding(true)}
          disabled={!data?.enabled || !data.encryption_ready}
        >
          <Plus data-icon="inline-start" />
          添加数据源
        </Button>
      </PageHeader>
      {resource.error && (
        <ErrorState message={resource.error} retry={resource.reload} />
      )}
      {!data && !resource.error && <Loading />}
      {data && (
        <div className="flex flex-col gap-6">
          {!data.enabled && (
            <Alert>
              <Database />
              <AlertTitle>启用数据源管理</AlertTitle>
              <AlertDescription>
                部署存储协调器
                STORAGE，并执行最新数据库迁移后，即可接入其他服务器。配置步骤见项目的数据库部署文档。
              </AlertDescription>
            </Alert>
          )}
          {data.enabled && !data.encryption_ready && (
            <Alert>
              <ShieldCheck />
              <AlertTitle>配置连接加密密钥</AlertTitle>
              <AlertDescription>
                在 Worker Secrets 中添加至少 32 位随机
                STORAGE_ENCRYPTION_KEY，用于加密连接服务令牌。配置后可添加远程数据库。
              </AlertDescription>
            </Alert>
          )}
          {data.pending_write && (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertTitle>正在恢复未确认的写入</AlertTitle>
              <AlertDescription>
                请检查当前数据源的连接。系统会核对提交版本，连接恢复后继续处理。
              </AlertDescription>
            </Alert>
          )}
          {job && (
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <CardTitle>
                    {job.phase === "complete"
                      ? job.mode === "snapshot"
                        ? "数据副本已校验"
                        : "数据源已切换"
                      : job.phase === "cancelled"
                        ? "同步已取消"
                        : job.paused
                          ? "同步已暂停"
                          : "正在同步数据"}
                  </CardTitle>
                  <Badge variant={job.paused ? "destructive" : "secondary"}>
                    {job.phase === "complete"
                      ? "已完成"
                      : job.phase === "cancelled"
                        ? "已取消"
                        : job.paused
                          ? "等待处理"
                          : "后台运行"}
                  </Badge>
                </div>
                <CardDescription>
                  {data.sources.find((s) => s.id === job.from.sourceId)?.name ||
                    "已移除的数据源"}{" "}
                  →{" "}
                  {data.sources.find((s) => s.id === job.to.sourceId)?.name ||
                    "已移除的数据源"}{" "}
                  · {date(job.started)}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                <ol
                  className="grid grid-cols-2 gap-3 sm:grid-cols-4"
                  aria-label="迁移步骤"
                >
                  {[
                    ["copy", "复制记录"],
                    ["replay", "追平变更"],
                    ["verify", "校验内容"],
                    [
                      "complete",
                      job.mode === "snapshot" ? "副本完成" : "切换完成",
                    ],
                  ].map(([phase, label], index) => {
                    const current = [
                        "copy",
                        "replay",
                        "verify",
                        "complete",
                      ].indexOf(job.phase),
                      done = current > index || job.phase === "complete";
                    return (
                      <li
                        key={phase}
                        className={cn(
                          "flex items-center gap-2 rounded-lg border p-3 text-sm",
                          current === index && "border-primary bg-accent",
                        )}
                      >
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs">
                          {done ? <Check className="size-3.5" /> : index + 1}
                        </span>
                        {label}
                      </li>
                    );
                  })}
                </ol>
                <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  {[
                    ["已复制记录", job.copied.toLocaleString()],
                    ["已校验记录", job.verified.toLocaleString()],
                    ["目标版本", job.applied],
                    ["当前版本", data.revision],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="mt-1 text-xl font-semibold tabular-nums">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
                {data.write_paused && (
                  <Alert>
                    <RefreshCw />
                    <AlertTitle>正在完成最终校验</AlertTitle>
                    <AlertDescription>
                      写入暂时暂停，读取仍可使用。校验通过后会自动恢复写入并使用目标数据源。
                    </AlertDescription>
                  </Alert>
                )}
                {job.error && (
                  <Alert variant={job.paused ? "destructive" : "default"}>
                    <CircleAlert />
                    <AlertTitle>
                      {job.paused ? "需要处理" : "正在重试"}
                    </AlertTitle>
                    <AlertDescription className="break-words">
                      {job.error}
                    </AlertDescription>
                  </Alert>
                )}
                {job.phase === "complete" && (
                  <p className="text-sm text-muted-foreground">
                    {job.mode === "snapshot"
                      ? "本次副本与完成时的主库数据已校验一致。主库继续服务；后续新增和修改需要再次同步副本。"
                      : "账号、邮件、关联关系及应用设置已校验一致。原数据集仍保留；再次切换会重新同步最新数据。"}
                  </p>
                )}
              </CardContent>
              {running && (
                <CardFooter className="flex-wrap gap-2">
                  {job.paused && (
                    <BusyButton
                      busy={action.busy}
                      onClick={() =>
                        void action.run(() =>
                          command("sync/retry", "已恢复后台同步"),
                        )
                      }
                    >
                      <Play data-icon="inline-start" />
                      继续同步
                    </BusyButton>
                  )}
                  <Button
                    variant="outline"
                    disabled={action.busy}
                    onClick={() =>
                      w.confirm(
                        "取消这次同步？",
                        "继续使用当前数据源，目标上已复制的数据集会保留。",
                        async () => {
                          await command("sync/cancel", "同步已取消");
                        },
                      )
                    }
                  >
                    <X data-icon="inline-start" />
                    取消同步
                  </Button>
                </CardFooter>
              )}
            </Card>
          )}
          <div
            className={cn(
              "grid gap-4 md:grid-cols-2",
              data.sources.length > 2 && "2xl:grid-cols-3",
            )}
            aria-label="数据库连接"
          >
            {data.sources.map((source) => {
              const active = data.active?.sourceId === source.id;
              return (
                <Card
                  key={source.id}
                  className="min-w-0"
                  data-source-card={source.id}
                >
                  <CardHeader>
                    <div className="flex items-start gap-3">
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                        <Database className="size-5" />
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <CardTitle className="break-words">
                          {source.name}
                        </CardTitle>
                        <CardDescription>
                          {labels[source.kind]}
                          {source.transport === "redis" ? " · 直连" : ""}
                        </CardDescription>
                      </div>
                      <Badge
                        variant={active ? "secondary" : "outline"}
                        className="shrink-0"
                      >
                        {active
                          ? "当前主库"
                          : source.purpose === "replica"
                            ? "数据副本"
                            : "可切换"}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="flex min-w-0 flex-1 flex-col gap-4">
                    <dl className="flex min-w-0 flex-col gap-3 text-sm">
                      <div className="flex min-w-0 items-start gap-3">
                        <dt className="flex shrink-0 items-center gap-2 text-muted-foreground">
                          <Server className="size-4" />
                          服务器
                        </dt>
                        <dd className="min-w-0 flex-1">
                          {source.endpoint ? (
                            <details className="min-w-0">
                              <summary
                                className="cursor-pointer break-all"
                                title="点击展开完整连接地址"
                              >
                                {new URL(source.endpoint).host}
                              </summary>
                              <div className="mt-2 flex min-w-0 items-start gap-1 rounded-md bg-muted p-2">
                                <code className="min-w-0 flex-1 break-all text-xs">
                                  {source.endpoint}
                                </code>
                                <CopyButton
                                  value={source.endpoint}
                                  label="复制服务器地址"
                                />
                              </div>
                            </details>
                          ) : (
                            "Cloudflare 工作区存储"
                          )}
                        </dd>
                      </div>
                      <div className="flex min-w-0 items-start gap-3">
                        <dt className="flex shrink-0 items-center gap-2 text-muted-foreground">
                          <Link2 className="size-4" />
                          数据位置
                        </dt>
                        <dd className="min-w-0 flex-1 break-all">
                          <code>{source.source || "工作区默认数据库"}</code>
                        </dd>
                      </div>
                    </dl>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {active
                        ? "当前账号、邮件和设置从此处读取并保存。"
                        : source.purpose === "replica"
                          ? "按需保存完整数据副本。后续修改需要再次同步；免费实例回收后副本可能丢失。"
                          : "同步并校验当前数据后，可切换为主库。原数据集会保留。"}
                    </p>
                    {health[source.id] && (
                      <p role="status" className="text-sm">
                        {health[source.id]}
                      </p>
                    )}
                  </CardContent>
                  <CardFooter className="mt-auto min-h-20 flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          setHealth((h) => ({
                            ...h,
                            [source.id]: "正在检查连接…",
                          }));
                          try {
                            const r = await api<{ latency_ms: number }>(
                              `/api/settings/storage/sources/${source.id}/health`,
                              "POST",
                            );
                            setHealth((h) => ({
                              ...h,
                              [source.id]: `连接正常 · ${r.data.latency_ms} ms`,
                            }));
                          } catch (error) {
                            setHealth((h) => ({
                              ...h,
                              [source.id]: "连接失败，请检查连接服务后重试。",
                            }));
                            throw error;
                          }
                        })
                      }
                    >
                      测试连接
                    </Button>
                    {!active && (
                      <Button
                        size="sm"
                        disabled={!!running || action.busy}
                        onClick={() =>
                          w.confirm(
                            source.purpose === "replica"
                              ? `同步副本到「${source.name}」？`
                              : `同步并切换到「${source.name}」？`,
                            source.purpose === "replica"
                              ? "创建独立数据副本，复制并校验当前应用数据。完成后继续使用当前主库，后续变化需要再次同步；最终校验时会短暂暂停写入。"
                              : "系统会创建独立数据集，复制全部应用数据并追平期间的变更，校验通过后自动切换。最终校验期间会短暂暂停写入。",
                            async () => {
                              await api("/api/settings/storage/sync", "POST", {
                                source_id: source.id,
                                auto_switch: true,
                                mode:
                                  source.purpose === "replica"
                                    ? "snapshot"
                                    : "switch",
                              });
                              toast.success("同步已在后台开始");
                              refresh();
                            },
                          )
                        }
                      >
                        <ArrowRightLeft data-icon="inline-start" />
                        {source.purpose === "replica"
                          ? "同步副本"
                          : "同步并切换"}
                      </Button>
                    )}
                    {source.kind !== "d1" && (
                      <div className="ml-auto">
                        <Menu
                          label={`${source.name} 连接操作`}
                          items={[
                            {
                              label: "连接设置",
                              action: () => setEditing(source),
                            },
                            ...(!active && !running
                              ? [
                                  {
                                    label: "移除连接",
                                    danger: true,
                                    action: () =>
                                      w.confirm(
                                        "移除连接配置？",
                                        "此操作只移除面板中的连接配置，服务器上的数据仍保留。",
                                        async () => {
                                          await api(
                                            `/api/settings/storage/sources/${source.id}`,
                                            "DELETE",
                                          );
                                          refresh();
                                        },
                                      ),
                                  },
                                ]
                              : []),
                          ]}
                        />
                      </div>
                    )}
                  </CardFooter>
                </Card>
              );
            })}
          </div>
          <Card>
            <CardHeader>
              <CardTitle>连接与迁移说明</CardTitle>
              <CardDescription>
                一个数据源对应一个独立实例，你可以添加多个相同类型的数据库。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="compact-steps">
                <li>
                  Redis 可以直接填写连接地址；MySQL、MongoDB
                  或已有连接服务可通过 MailHub Connector 接入。
                </li>
                <li>
                  通过 HTTPS 或 Cloudflare Tunnel
                  提供连接服务，将服务地址、数据源 ID 和连接令牌添加到这里。
                </li>
                <li>
                  选择「同步并切换」。关闭页面后同步仍会继续，中断后可从断点恢复。
                </li>
                <li>
                  换服务器时，把新服务器添加为另一个数据源，再执行相同流程。
                </li>
              </ol>
              <p className="mt-4 text-sm text-muted-foreground">
                MongoDB 需要副本集。Redis 作为主存储需要开启 AOF、always fsync
                和 noeviction；免费实例可选择数据副本用途。Redis
                直连凭据加密保存，Connector 模式的数据库密码保存在连接服务器上。
              </p>
            </CardContent>
          </Card>
        </div>
      )}
      {editing && (
        <EditSource
          source={editing}
          close={() => setEditing(null)}
          saved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {adding && (
        <AddSource
          close={() => setAdding(false)}
          saved={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}
    </>
  );
}
function AddSource({ close, saved }: { close: () => void; saved: () => void }) {
  const [form, setForm] = useState({
      name: "",
      kind: "mysql",
      endpoint: "",
      source: "",
      token: "",
      transport: "http",
      redis_url: "",
      purpose: "replica",
    }),
    action = useAction({ inline: true });
  return (
    <Modal
      title="连接数据库实例"
      description="Redis 支持直接连接；其他数据库使用你部署的 HTTPS 连接服务。"
      close={close}
    >
      <form
        className="modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api("/api/settings/storage/sources", "POST", form);
            toast.success("连接已验证，数据源已添加");
            saved();
          });
        }}
      >
        <ModalBody>
          <ActionError message={action.error} />
          <FieldGroup>
            <TextField
              label="显示名称"
              placeholder="例如：新加坡 MySQL · 新服务器"
              value={form.name}
              required
              maxLength={80}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <SelectField
              label="数据库类型"
              value={form.kind}
              onChange={(kind) =>
                setForm({
                  ...form,
                  kind,
                  transport: kind === "redis" ? "redis" : "http",
                  source:
                    form.source || (kind === "redis" ? "mailhub-vault" : ""),
                })
              }
              options={[
                ["mysql", "MySQL"],
                ["mongodb", "MongoDB"],
                ["redis", "Redis"],
              ]}
            />
            {form.kind === "redis" && (
              <SelectField
                label="连接方式"
                value={form.transport}
                onChange={(transport) => setForm({ ...form, transport })}
                options={[
                  ["redis", "Redis 直接连接"],
                  ["http", "HTTPS 连接服务"],
                ]}
              />
            )}
            {form.transport === "redis" ? (
              <>
                <TextField
                  label="Redis 连接地址"
                  type="password"
                  autoComplete="new-password"
                  placeholder="redis://用户名:密码@服务器:端口/0"
                  required
                  value={form.redis_url}
                  onChange={(e) =>
                    setForm({ ...form, redis_url: e.target.value })
                  }
                  help="支持 redis:// 和 rediss://；完整地址加密保存，页面仅显示不含凭据的服务器地址。"
                />
                <SelectField
                  label="数据源用途"
                  value={form.purpose}
                  onChange={(purpose) => setForm({ ...form, purpose })}
                  options={[
                    ["replica", "数据副本（适合免费 Redis）"],
                    ["primary", "可切换主库（检查持久化）"],
                  ]}
                />
              </>
            ) : (
              <>
                <TextField
                  label="连接服务地址"
                  type="url"
                  placeholder="https://storage.example.com"
                  value={form.endpoint}
                  required
                  autoComplete="off"
                  onChange={(e) =>
                    setForm({ ...form, endpoint: e.target.value })
                  }
                />
              </>
            )}
            <TextField
              label={
                form.transport === "redis" ? "Redis 数据命名空间" : "数据源 ID"
              }
              placeholder={
                form.transport === "redis"
                  ? "mailhub-vault"
                  : "例如：mysql-primary"
              }
              help={
                form.transport === "redis"
                  ? "仅使用这个前缀下的新数据集，已有 Redis 数据保留。"
                  : "与连接服务 sources 配置中的 id 一致。"
              }
              value={form.source}
              required
              autoComplete="off"
              pattern={"[a-z0-9_\\-]{1,64}"}
              onChange={(e) => setForm({ ...form, source: e.target.value })}
            />
            {form.transport !== "redis" && (
              <TextField
                label="连接令牌"
                type="password"
                autoComplete="new-password"
                value={form.token}
                required
                minLength={32}
                help="至少 32 位随机字符，连接后不会在页面显示。"
                onChange={(e) => setForm({ ...form, token: e.target.value })}
              />
            )}
          </FieldGroup>
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="outline" onClick={close}>
            取消
          </Button>
          <BusyButton type="submit" busy={action.busy}>
            测试并添加
          </BusyButton>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function EditSource({
  source,
  close,
  saved,
}: {
  source: Source;
  close: () => void;
  saved: () => void;
}) {
  const [name, setName] = useState(source.name),
    [token, setToken] = useState(""),
    action = useAction({ inline: true });
  return (
    <Modal
      title="连接设置"
      description="修改显示名称或更新连接令牌。更换数据库实例请添加新数据源，再同步切换。"
      close={close}
    >
      <form
        className="modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api(`/api/settings/storage/sources/${source.id}`, "PATCH", {
              name,
              ...(source.transport === "redis"
                ? { redis_url: token }
                : { token }),
            });
            toast.success("连接配置已更新");
            saved();
          });
        }}
      >
        <ModalBody>
          <ActionError message={action.error} />
          <FieldGroup>
            <TextField
              label="显示名称"
              value={name}
              required
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
            <TextField
              label={
                source.transport === "redis"
                  ? "新的 Redis 连接地址"
                  : "新连接令牌"
              }
              type="password"
              autoComplete="new-password"
              minLength={source.transport === "redis" ? undefined : 32}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              help={
                source.transport === "redis"
                  ? "留空保留当前凭据；只允许更新同一服务器的凭据。换服务器请添加新数据源。"
                  : "留空保留当前令牌；更新时会验证连接与数据集身份。"
              }
            />
          </FieldGroup>
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="outline" onClick={close}>
            取消
          </Button>
          <BusyButton type="submit" busy={action.busy}>
            验证并保存
          </BusyButton>
        </ModalFooter>
      </form>
    </Modal>
  );
}
