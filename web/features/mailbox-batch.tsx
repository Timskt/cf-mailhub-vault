import { useState } from "react";
import { toast } from "sonner";
import { Download } from "lucide-react";
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
  const [count, setCount] = useState(10),
    [prefix, setPrefix] = useState(""),
    [remark, setRemark] = useState("");
  const [duration, setDuration] = useState("1440"),
    [permanent, setPermanent] = useState(false);
  const [preview, setPreview] = useState<PlannedMailbox[] | null>(null),
    [created, setCreated] = useState<Mailbox[] | null>(null);
  const action = useAction({ inline: true });
  const addresses =
    created?.map((m) => m.address) ||
    preview?.map((m) => `${m.prefix}@${m.domain}`) ||
    [];
  return (
    <Modal
      title={
        created ? "邮箱已批量分配" : preview ? "确认分配清单" : "批量分配邮箱"
      }
      description="为不同用途分配独立地址，均匀分布到所选域名，便于定位来信来源。每批最多 100 个。"
      close={action.busy ? () => {} : close}
      wide
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
                      domains: selected,
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
        <ModalBody>
          <ActionError message={action.error} />
          {!preview ? (
            <fieldset disabled={action.busy} className="contents">
              <FieldGroup>
                <FieldSet>
                  <FieldLegend>分配到哪些域名</FieldLegend>
                  <FieldGroup className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {domains.map((d) => (
                      <CheckField
                        key={d.domain}
                        label={d.domain}
                        checked={selected.includes(d.domain)}
                        onChange={(value) =>
                          setSelected((old) =>
                            value
                              ? [...old, d.domain]
                              : old.filter((v) => v !== d.domain),
                          )
                        }
                      />
                    ))}
                  </FieldGroup>
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
                    required
                    value={count}
                    onChange={(e) => setCount(Number(e.target.value))}
                    help="总数会轮流分配到所选域名。"
                  />
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
            </fieldset>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">{addresses.length} 个地址</Badge>
                <Badge variant="outline">
                  {permanent ? "永久保留" : `创建后 ${duration} 分钟有效`}
                </Badge>
              </div>
              <p className="break-words text-sm text-muted-foreground">
                用途：{remark || "未填写，可在分配后编辑"}
              </p>
              <div
                className="max-h-72 overflow-auto rounded-lg border"
                aria-label="邮箱分配清单"
              >
                {addresses.map((address) => (
                  <p
                    key={address}
                    className="break-all border-b p-3 font-mono text-sm last:border-b-0"
                  >
                    {address}
                  </p>
                ))}
              </div>
              {created ? (
                <>
                  <Alert>
                    <AlertDescription>
                      已全部创建。可复制地址用于注册，或导出清单；后续在邮箱列表中查看未读数、最近来信并编辑用途。
                    </AlertDescription>
                  </Alert>
                  <div className="flex flex-wrap gap-2">
                    <CopyAction
                      label="复制全部地址"
                      value={addresses.join("\n")}
                      variant="outline"
                    />
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
                  </div>
                </>
              ) : (
                <Alert>
                  <AlertDescription>
                    预览尚未创建邮箱。确认后整批写入；如某个域名停用或地址冲突，本批不会创建部分邮箱。
                  </AlertDescription>
                </Alert>
              )}
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
              onClick={() => setPreview(null)}
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
