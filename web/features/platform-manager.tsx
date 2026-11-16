import { useState } from "react";
import { toast } from "sonner";
import {
  ArrowRight,
  ExternalLink,
  Merge,
  Pencil,
  Pin,
  Plus,
  Trash2,
} from "lucide-react";
import {
  ActionError,
  Blank,
  BusyButton,
  ErrorState,
  Loading,
  Menu,
  Modal,
  ModalBody,
  ModalFooter,
  SearchBox,
  SelectField,
  TextField,
} from "@/components/common";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { api, safeUrl, useAction, useResource } from "@/lib/api";
import { useWorkspace } from "@/lib/context";
import type { PlatformDefinition } from "@/lib/types";

export function PlatformEditor({
  initial,
  close,
}: {
  initial?: PlatformDefinition;
  close: () => void;
}) {
  const w = useWorkspace();
  const action = useAction({ inline: true });
  const [form, setForm] = useState({
    name: initial?.name || "",
    url: initial?.url || "",
    category: initial?.category || "其他",
    remark: initial?.remark || "",
    is_pinned: !!initial?.is_pinned,
  });
  return (
    <Modal
      title={initial ? "编辑平台" : "新建平台"}
      description="平台可以独立保存。先添加名称、官网和用途，再按需要登记账号。"
      close={() => {
        if (!action.busy) close();
      }}
    >
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            await api(
              `/api/platforms${initial ? `/${encodeURIComponent(initial.name)}` : ""}`,
              initial ? "PUT" : "POST",
              form,
            );
            toast.success(
              initial
                ? "平台资料及关联名称已更新"
                : "平台已创建，可继续添加账号",
            );
            w.refresh();
            close();
          });
        }}
      >
        <ModalBody>
          <ActionError message={action.error} />
          <FieldGroup>
            <TextField
              label="平台名称"
              required
              maxLength={100}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="例如 GitHub、OpenAI、你的业务平台"
              disabled={action.busy}
            />
            <TextField
              label="平台官网"
              type="url"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://…"
              disabled={action.busy}
            />
            <TextField
              label="平台分类"
              maxLength={100}
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              disabled={action.busy}
            />
            <Field>
              <FieldLabel htmlFor="platform-remark">平台备注</FieldLabel>
              <Textarea
                id="platform-remark"
                value={form.remark}
                maxLength={4000}
                onChange={(e) => setForm({ ...form, remark: e.target.value })}
                disabled={action.busy}
                placeholder="用途、登录说明、账号管理约定…"
              />
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id="platform-pin"
                checked={form.is_pinned}
                onCheckedChange={(v) =>
                  setForm({ ...form, is_pinned: v === true })
                }
                disabled={action.busy}
              />
              <FieldLabel htmlFor="platform-pin">置顶平台</FieldLabel>
            </Field>
          </FieldGroup>
          {initial && (
            <Alert>
              <AlertDescription>
                修改名称会同步全部关联账号和邮箱绑定；账号密码、状态及备注保留。名称已存在时，请使用“合并平台”。
              </AlertDescription>
            </Alert>
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
            disabled={!form.name.trim()}
          >
            保存平台
          </BusyButton>
        </ModalFooter>
      </form>
    </Modal>
  );
}

export function MergePlatform({
  source,
  close,
}: {
  source: PlatformDefinition;
  close: () => void;
}) {
  const w = useWorkspace();
  const all = useResource<PlatformDefinition[]>("/api/platforms", w.revision);
  const action = useAction({ inline: true });
  const [target, setTarget] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  return (
    <Modal
      title={`合并 ${source.name}`}
      description="将源平台的全部账号移入目标平台，保留目标平台资料和所有账号记录。"
      close={() => {
        if (!action.busy) close();
      }}
    >
      <ModalBody>
        <ActionError message={action.error} />
        {all.error ? (
          <ErrorState message={all.error} retry={all.reload} />
        ) : !all.result ? (
          <Loading />
        ) : (
          <FieldGroup>
            <SelectField
              label="目标平台"
              value={target}
              onChange={(v) => {
                setTarget(v);
                setConfirmed(false);
              }}
              options={[
                ["", "请选择目标平台"],
                ...all.result.data
                  .filter((p) => p.name_key !== source.name_key)
                  .map(
                    (p) =>
                      [p.name, `${p.name} · ${p.account_count} 个账号`] as [
                        string,
                        string,
                      ],
                  ),
              ]}
              disabled={action.busy}
            />
            <Alert>
              <AlertDescription>
                合并后移除“{source.name}
                ”的平台资料，账号和邮箱关联转到目标平台。同邮箱、同用户名的记录也会保留，便于你自行核对。
              </AlertDescription>
            </Alert>
            <Field orientation="horizontal">
              <Checkbox
                id="platform-merge-confirm"
                checked={confirmed}
                disabled={!target || action.busy}
                onCheckedChange={(v) => setConfirmed(v === true)}
              />
              <FieldLabel htmlFor="platform-merge-confirm">
                已核对目标，确认合并全部 {source.account_count} 个账号
              </FieldLabel>
            </Field>
          </FieldGroup>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="outline" disabled={action.busy} onClick={close}>
          取消
        </Button>
        <BusyButton
          busy={action.busy}
          disabled={!target || !confirmed}
          onClick={() => {
            void action.run(async () => {
              await api(
                `/api/platforms/${encodeURIComponent(source.name)}/merge`,
                "POST",
                { target },
              );
              w.refresh();
              toast.success("平台已合并，全部账号已保留");
              close();
            });
          }}
        >
          确认合并平台
        </BusyButton>
      </ModalFooter>
    </Modal>
  );
}

export function PlatformManager({
  close,
  openAccounts,
}: {
  close: () => void;
  openAccounts: (name: string) => void;
}) {
  const w = useWorkspace();
  const all = useResource<PlatformDefinition[]>("/api/platforms", w.revision);
  const [q, setQ] = useState("");
  const [editor, setEditor] = useState<PlatformDefinition | "new" | null>(null);
  const [merge, setMerge] = useState<PlatformDefinition | null>(null);
  const list = (all.result?.data || [])
    .filter((p) =>
      [p.name, p.category, p.remark].some((v) =>
        v.toLowerCase().includes(q.toLowerCase()),
      ),
    )
    .sort(
      (a, b) =>
        b.is_pinned - a.is_pinned || a.name.localeCompare(b.name, "zh-CN"),
    );
  return (
    <Modal
      title="管理平台"
      description="管理平台名称、官网、分类和用途。零账号平台也会保留，删除平台前须先处理关联账号。"
      close={close}
      wide
    >
      <ModalBody>
        <div className="flex flex-wrap gap-3">
          <div className="min-w-0 flex-1">
            <SearchBox
              value={q}
              onChange={setQ}
              placeholder="搜索平台名称、分类或备注…"
            />
          </div>
          <Button onClick={() => setEditor("new")}>
            <Plus data-icon="inline-start" />
            新建平台
          </Button>
        </div>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          共 {all.result?.total ?? 0} 个平台 · 当前显示 {list.length} 个
        </p>
        {all.error ? (
          <ErrorState message={all.error} retry={all.reload} />
        ) : !all.result ? (
          <Loading />
        ) : !list.length ? (
          <Blank
            title={q ? "没有匹配的平台" : "先添加你的平台"}
            description="平台资料可先保存，再逐步添加账号。"
          />
        ) : (
          <div className="flex flex-col gap-3">
            {list.map((p) => (
              <div
                key={p.name_key}
                className="flex flex-wrap items-start gap-3 rounded-xl border p-4"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="break-all">{p.name}</strong>
                    {!!p.is_pinned && (
                      <Pin className="size-4" aria-label="已置顶" />
                    )}
                    <Badge variant="secondary">{p.account_count} 个账号</Badge>
                    <Badge variant="outline">{p.category}</Badge>
                  </div>
                  {p.remark && (
                    <p className="line-clamp-2 break-all text-sm text-muted-foreground">
                      {p.remark}
                    </p>
                  )}
                  {safeUrl(p.url) && (
                    <a
                      className="inline-flex items-center gap-1 break-all text-xs text-muted-foreground hover:underline"
                      href={safeUrl(p.url)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {p.url}
                      <ExternalLink className="size-3 shrink-0" />
                    </a>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditor(p)}
                    aria-label={`编辑平台 ${p.name}`}
                  >
                    <Pencil data-icon="inline-start" />
                    编辑
                  </Button>
                  <Menu
                    label={`${p.name} 平台操作`}
                    items={[
                      {
                        label: "管理账号",
                        icon: <ArrowRight />,
                        action: () => {
                          close();
                          openAccounts(p.name);
                        },
                      },
                      {
                        label: "合并平台",
                        icon: <Merge />,
                        action: () => setMerge(p),
                      },
                      {
                        label: "删除平台",
                        icon: <Trash2 />,
                        danger: true,
                        disabled: p.account_count > 0,
                        action: () =>
                          w.confirm(
                            "删除平台？",
                            p.account_count
                              ? `“${p.name}”仍有 ${p.account_count} 个账号，需先移动账号或合并平台，删除不会清空账号。`
                              : `删除“${p.name}”的平台资料。`,
                            async () => {
                              await api(
                                `/api/platforms/${encodeURIComponent(p.name)}`,
                                "DELETE",
                              );
                              w.refresh();
                              toast.success("平台已删除");
                            },
                          ),
                      },
                    ]}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="outline" onClick={close}>
          完成
        </Button>
      </ModalFooter>
      {editor && (
        <PlatformEditor
          initial={editor === "new" ? undefined : editor}
          close={() => setEditor(null)}
        />
      )}
      {merge && <MergePlatform source={merge} close={() => setMerge(null)} />}
    </Modal>
  );
}
