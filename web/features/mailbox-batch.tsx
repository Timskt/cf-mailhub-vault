import { useState } from "react";
import { toast } from "sonner";
import { Download, Search } from "lucide-react";
import {
  ActionError,
  BusyButton,
  CopyAction,
  Modal,
  ModalBody,
  ModalFooter,
  SelectField,
  TextField,
} from "@/components/common";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, download, useAction } from "@/lib/api";
import { useWorkspace } from "@/lib/context";
import type { Mailbox } from "@/lib/types";
import { CheckField } from "./mail-rules";
interface PlannedMailbox {
  domain: string;
  prefix: string;
  duration_minutes: number;
  is_permanent: boolean;
  remark: string;
}

export function BatchMailboxes({
  close,
  generated,
}: {
  close: () => void;
  generated: (id: number) => void;
}) {
  const w = useWorkspace();
  const domains = (w.settings?.domains || []).filter((d) => d.enabled);
  const [selected, setSelected] = useState(() =>
    domains.filter((d) => d.is_default).map((d) => d.domain),
  );
  const [domainSearch, setDomainSearch] = useState("");
  const [count, setCount] = useState(10),
    [prefix, setPrefix] = useState(""),
    [remark, setRemark] = useState("");
  const [duration, setDuration] = useState("1440"),
    [permanent, setPermanent] = useState(false);
  const [preview, setPreview] = useState<PlannedMailbox[] | null>(null),
    [created, setCreated] = useState<Mailbox[] | null>(null);
  const [previewDomain, setPreviewDomain] = useState("");
  const [previewSearch, setPreviewSearch] = useState("");
  const matchingDomains = domains.filter((domain) =>
    domain.domain.toLowerCase().includes(domainSearch.trim().toLowerCase()),
  );
  const allMatchingSelected =
    matchingDomains.length > 0 &&
    matchingDomains.every((domain) => selected.includes(domain.domain));
  const action = useAction({ inline: true });
  const addresses =
    created?.map((m) => m.address) ||
    preview?.map((m) => `${m.prefix}@${m.domain}`) ||
    [];
  const domainCounts = addresses.reduce<Record<string, number>>(
    (counts, address) => {
      const domain = address.slice(address.lastIndexOf("@") + 1);
      counts[domain] = (counts[domain] || 0) + 1;
      return counts;
    },
    {},
  );
  const previewDomains = Object.keys(domainCounts);
  const visibleAddresses = addresses.filter((address) => {
    const domain = address.slice(address.lastIndexOf("@") + 1);
    return (
      (!previewDomain || domain === previewDomain) &&
      address.toLowerCase().includes(previewSearch.trim().toLowerCase())
    );
  });
  const durationLabel = permanent
    ? "永久保留"
    : { "60": "1 小时", "1440": "1 天", "10080": "7 天", "43200": "30 天" }[
        duration
      ] || `${duration} 分钟`;
  const selectedDomains = domains.filter((domain) =>
    selected.includes(domain.domain),
  );
  const allocationPreview = selectedDomains.map((domain, index) => ({
    domain: domain.domain,
    amount:
      Math.floor(count / Math.max(selectedDomains.length, 1)) +
      (index < count % Math.max(selectedDomains.length, 1) ? 1 : 0),
  }));
  const currentStep = created ? 2 : preview ? 1 : 0;
  return (
    <Modal
      title={
        created ? "邮箱已批量分配" : preview ? "确认分配清单" : "批量分配邮箱"
      }
      description="按域名配置顺序均匀分配，先预览后整批创建；每批最多 100 个。"
      close={action.busy ? () => {} : close}
      wide
      className="mailbox-batch-dialog"
    >
      <form
        className="modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!preview)
            void action.run(async () => {
              setPreview(
                (
                  await api<PlannedMailbox[]>(
                    "/api/mailboxes/batch-preview",
                    "POST",
                    {
                      domains: domains
                        .map((domain) => domain.domain)
                        .filter((domain) => selected.includes(domain)),
                      count,
                      prefix,
                      remark,
                      duration_minutes: Number(duration),
                      is_permanent: permanent,
                    },
                  )
                ).data,
              );
            });
        }}
      >
        <ol className="batch-stepper" aria-label="批量分配进度">
          {["配置", "检查", "完成"].map((label, index) => (
            <li
              key={label}
              data-current={currentStep === index}
              data-complete={currentStep > index}
              aria-current={currentStep === index ? "step" : undefined}
            >
              <span>{index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        <ModalBody className="batch-dialog-body">
          <ActionError message={action.error} />
          {!preview ? (
            <fieldset disabled={action.busy} className="contents">
              <div className="batch-config-layout">
                <div className="batch-config-fields">
                  <FieldGroup>
                    <FieldSet>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <FieldLegend>分配到哪些域名</FieldLegend>
                        <div className="flex items-center gap-1">
                          <span className="mr-2 text-xs text-muted-foreground">
                            {selected.length}/{domains.length} 个域名
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={
                              !matchingDomains.length || allMatchingSelected
                            }
                            onClick={() =>
                              setSelected((current) => [
                                ...new Set([
                                  ...current,
                                  ...matchingDomains.map(
                                    (domain) => domain.domain,
                                  ),
                                ]),
                              ])
                            }
                          >
                            全选当前结果
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={!selected.length}
                            onClick={() => setSelected([])}
                          >
                            清空所选
                          </Button>
                        </div>
                      </div>
                      <div className="relative">
                        <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
                        <Input
                          aria-label="搜索启用域名"
                          className="pl-9"
                          value={domainSearch}
                          onChange={(event) =>
                            setDomainSearch(event.target.value)
                          }
                          placeholder="搜索启用域名…"
                        />
                      </div>
                      <div
                        data-testid="batch-domain-options"
                        className="max-h-48 overflow-y-auto rounded-md border p-2"
                      >
                        {matchingDomains.length ? (
                          <FieldGroup className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                            {matchingDomains.map((domain) => (
                              <CheckField
                                key={domain.domain}
                                label={domain.domain}
                                checked={selected.includes(domain.domain)}
                                onChange={(value) =>
                                  setSelected((current) =>
                                    value
                                      ? [...current, domain.domain]
                                      : current.filter(
                                          (item) => item !== domain.domain,
                                        ),
                                  )
                                }
                              />
                            ))}
                          </FieldGroup>
                        ) : (
                          <p className="px-2 py-5 text-center text-sm text-muted-foreground">
                            没有匹配的启用域名
                          </p>
                        )}
                      </div>
                    </FieldSet>
                    {!domains.length && (
                      <Alert>
                        <AlertDescription>
                          请先在域名管理中添加或启用域名。
                        </AlertDescription>
                      </Alert>
                    )}
                    <FieldGroup className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                      <TextField
                        label="总数量"
                        type="number"
                        min={1}
                        max={100}
                        step={1}
                        required
                        value={count}
                        onChange={(e) => setCount(Number(e.target.value))}
                        help="按域名配置顺序均匀分配到已选域名。"
                      />
                      <div className="flex flex-col gap-2">
                        <span className="text-sm font-medium">常用数量</span>
                        <div
                          className="flex flex-wrap gap-1.5"
                          role="group"
                          aria-label="批量数量快捷选择"
                        >
                          {[10, 25, 50, 100].map((value) => (
                            <Button
                              key={value}
                              type="button"
                              size="sm"
                              variant={
                                count === value ? "secondary" : "outline"
                              }
                              aria-pressed={count === value}
                              onClick={() => setCount(value)}
                            >
                              {value}
                            </Button>
                          ))}
                        </div>
                      </div>
                      <TextField
                        label="用途前缀"
                        maxLength={40}
                        value={prefix}
                        onChange={(e) => setPrefix(e.target.value)}
                        placeholder="例如：shopping、dev、news"
                        help="自动追加序号和随机后缀，避免地址冲突。"
                      />
                    </FieldGroup>
                    <TextField
                      label="用途备注"
                      maxLength={500}
                      value={remark}
                      onChange={(e) => setRemark(e.target.value)}
                      placeholder="例如：购物账号专用，按商店分别登记"
                    />
                    <SelectField
                      label="邮箱有效期"
                      value={duration}
                      onChange={setDuration}
                      disabled={permanent}
                      options={[
                        ["60", "1 小时"],
                        ["1440", "1 天"],
                        ["10080", "7 天"],
                        ["43200", "30 天"],
                      ]}
                    />
                    <CheckField
                      label="永久保留这些地址"
                      checked={permanent}
                      onChange={setPermanent}
                    />
                  </FieldGroup>
                </div>
                <aside
                  className="batch-side-summary"
                  aria-label="本次批量分配摘要"
                >
                  <span className="text-xs font-medium text-muted-foreground">
                    本次分配
                  </span>
                  <strong className="batch-summary-count">{count || 0}</strong>
                  <span className="text-sm text-muted-foreground">个邮箱</span>
                  <dl className="batch-summary-facts">
                    <div>
                      <dt>目标域名</dt>
                      <dd>{selectedDomains.length}</dd>
                    </div>
                    <div>
                      <dt>有效期</dt>
                      <dd>{durationLabel}</dd>
                    </div>
                  </dl>
                  <section aria-label="域名分配预估">
                    <h3>域名分配预估</h3>
                    <div className="batch-domain-ledger">
                      {allocationPreview.length ? (
                        allocationPreview.map(({ domain, amount }) => (
                          <div key={domain}>
                            <span title={domain}>{domain}</span>
                            <strong>{amount}</strong>
                          </div>
                        ))
                      ) : (
                        <p>先选择至少一个启用域名</p>
                      )}
                    </div>
                  </section>
                </aside>
              </div>
            </fieldset>
          ) : (
            <div className="batch-preview-layout">
              <div className="batch-preview-main">
                <p className="break-words text-sm text-muted-foreground">
                  用途：{remark || "未填写，可在分配后编辑"}
                </p>
                <div className="batch-preview-controls">
                  <SelectField
                    label="按域名筛选"
                    value={previewDomain}
                    onChange={setPreviewDomain}
                    options={[
                      ["", "全部域名"],
                      ...previewDomains.map(
                        (domain) => [domain, domain] as const,
                      ),
                    ]}
                  />
                  <TextField
                    label="搜索地址"
                    type="search"
                    value={previewSearch}
                    onChange={(event) => setPreviewSearch(event.target.value)}
                    placeholder="输入前缀或完整邮箱"
                  />
                  <div className="batch-preview-actions">
                    <span className="text-xs tabular-nums text-muted-foreground">
                      显示 {visibleAddresses.length} / {addresses.length} 个地址
                    </span>
                    <CopyAction
                      label={
                        previewDomain || previewSearch
                          ? "复制筛选地址"
                          : created
                            ? "复制全部地址"
                            : "复制预览地址"
                      }
                      value={visibleAddresses.join("\n")}
                      size="sm"
                      variant="outline"
                      disabled={!visibleAddresses.length}
                    />
                  </div>
                </div>
                <div className="batch-preview-addresses">
                  <ol className="divide-y sm:hidden" aria-label="邮箱分配清单">
                    {visibleAddresses.map((address, index) => (
                      <li
                        key={`${index}:${address}`}
                        className="grid min-w-0 grid-cols-[2.5rem_minmax(0,1fr)] gap-2 px-3 py-2"
                      >
                        <span className="pt-0.5 font-mono text-xs text-muted-foreground">
                          {String(index + 1).padStart(3, "0")}
                        </span>
                        <span
                          data-mailbox-address
                          className="min-w-0 whitespace-normal font-mono text-xs leading-5 [overflow-wrap:anywhere]"
                        >
                          {address}
                        </span>
                      </li>
                    ))}
                  </ol>
                  <div className="hidden sm:block">
                    <Table
                      aria-label="邮箱分配清单"
                      className="w-full min-w-0 table-fixed"
                    >
                      <TableHeader className="sticky top-0 z-10 bg-background">
                        <TableRow>
                          <TableHead className="w-12">序号</TableHead>
                          <TableHead>邮箱地址</TableHead>
                          <TableHead className="hidden md:table-cell">
                            域名
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {visibleAddresses.map((address, index) => {
                          const domain = address.slice(
                            address.lastIndexOf("@") + 1,
                          );
                          return (
                            <TableRow key={`${index}:${address}`}>
                              <TableCell className="w-12 font-mono text-xs text-muted-foreground">
                                {String(index + 1).padStart(3, "0")}
                              </TableCell>
                              <TableCell className="whitespace-normal break-all font-mono text-xs">
                                {address}
                              </TableCell>
                              <TableCell className="hidden max-w-[180px] truncate text-xs text-muted-foreground md:table-cell">
                                {domain}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </div>
              <aside
                className="batch-preview-summary"
                aria-label="批量分配汇总"
              >
                <div className="batch-preview-count">
                  <strong>{addresses.length} 个地址</strong>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">{durationLabel}</Badge>
                  <Badge variant="outline">
                    {Object.keys(domainCounts).length} 个域名
                  </Badge>
                </div>
                <section aria-label="各域名分配数量">
                  <h3>域名分配</h3>
                  <div className="grid max-h-56 gap-x-6 overflow-y-auto">
                    {Object.entries(domainCounts).map(([domain, amount]) => (
                      <div
                        key={domain}
                        className="flex min-w-0 items-center justify-between gap-3 border-b py-2 text-sm"
                      >
                        <span
                          className="truncate text-muted-foreground"
                          title={domain}
                        >
                          {domain}
                        </span>
                        <span className="shrink-0 font-medium">
                          {amount} 个
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
                {created ? (
                  <>
                    <Alert>
                      <AlertDescription>
                        已全部创建。邮箱列表中可继续查看来信和编辑用途。
                      </AlertDescription>
                    </Alert>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        download(
                          created.map(
                            ({
                              address,
                              domain,
                              remark,
                              expires_at,
                              is_permanent,
                            }) => ({
                              address,
                              domain,
                              remark,
                              expires_at,
                              is_permanent,
                            }),
                          ),
                          "mailboxes.json",
                        )
                      }
                    >
                      <Download data-icon="inline-start" />
                      导出分配清单
                    </Button>
                  </>
                ) : (
                  <Alert>
                    <AlertDescription>
                      预览尚未创建邮箱。确认后整批写入；如某个域名停用或地址冲突，本批不会创建部分邮箱。
                    </AlertDescription>
                  </Alert>
                )}
              </aside>
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button
            type="button"
            variant="outline"
            disabled={action.busy}
            onClick={close}
          >
            {created ? "完成" : "取消"}
          </Button>
          {preview && !created && (
            <Button
              type="button"
              variant="secondary"
              disabled={action.busy}
              onClick={() => {
                setPreview(null);
                setPreviewDomain("");
                setPreviewSearch("");
              }}
            >
              返回调整
            </Button>
          )}
          {!preview && (
            <BusyButton
              type="submit"
              busy={action.busy}
              disabled={!selected.length}
            >
              预览地址
            </BusyButton>
          )}
          {preview && !created && (
            <BusyButton
              type="button"
              busy={action.busy}
              onClick={() => {
                void action.run(async () => {
                  const r = await api<Mailbox[]>(
                    "/api/mailboxes/batch",
                    "POST",
                    { mailboxes: preview },
                  );
                  setCreated(r.data);
                  toast.success(r.message);
                  generated(r.data[0].id);
                });
              }}
            >
              确认创建 {preview.length} 个邮箱
            </BusyButton>
          )}
        </ModalFooter>
      </form>
    </Modal>
  );
}
export function MailboxPurpose({
  mailbox,
  close,
  saved,
}: {
  mailbox: Mailbox;
  close: () => void;
  saved: () => void;
}) {
  const [remark, setRemark] = useState(mailbox.remark || ""),
    action = useAction({ inline: true });
  return (
    <Modal
      title="编辑用途备注"
      description={mailbox.address}
      close={action.busy ? () => {} : close}
    >
      <form
        className="modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api(`/api/mailboxes/${mailbox.id}`, "PATCH", { remark });
            toast.success("用途备注已更新");
            saved();
          });
        }}
      >
        <ModalBody>
          <ActionError message={action.error} />
          <FieldGroup>
            <TextField
              label="用途备注"
              maxLength={500}
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder="记录注册服务、分配对象或使用目的"
              help="可在邮箱列表按备注搜索。"
            />
          </FieldGroup>
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
          <BusyButton type="submit" busy={action.busy}>
            保存用途
          </BusyButton>
        </ModalFooter>
      </form>
    </Modal>
  );
}
