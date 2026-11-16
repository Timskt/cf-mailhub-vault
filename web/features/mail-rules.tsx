import { useId, useState } from "react";
import { toast } from "sonner";
import { Plus, SlidersHorizontal } from "lucide-react";
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
  PageHeader,
  SelectField,
  TextField,
} from "@/components/common";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { api, date, useAction, useResource } from "@/lib/api";
import { useWorkspace } from "@/lib/context";
import type { Mail } from "@/lib/types";

export const categories: [string, string][] = [
  ["general", "普通邮件"],
  ["verification", "验证码 / 验证链接"],
  ["billing", "账单 / 收据"],
  ["newsletter", "订阅 / 简报"],
  ["notification", "通知提醒"],
];
export const categoryLabel = (value?: string) =>
  categories.find(([key]) => key === value)?.[1] || "普通邮件";
interface RuleDraft {
  name: string;
  enabled: boolean;
  priority: number;
  sender_contains: string;
  recipient: string;
  domain: string;
  subject_contains: string;
  verification_only: boolean;
  action_category: string;
  mark_read: boolean;
  archive: boolean;
  pin: boolean;
}
interface Rule extends Omit<
  RuleDraft,
  "enabled" | "verification_only" | "mark_read" | "archive" | "pin"
> {
  id: number;
  enabled: number;
  verification_only: number;
  mark_read: number;
  archive: number;
  pin: number;
}
interface Preview {
  mails: Mail[];
  total: number;
  limited: boolean;
  revision: string;
}
const blank: RuleDraft = {
  name: "",
  enabled: true,
  priority: 100,
  sender_contains: "",
  recipient: "",
  domain: "",
  subject_contains: "",
  verification_only: false,
  action_category: "",
  mark_read: false,
  archive: false,
  pin: false,
};
function draft(rule?: Partial<Rule> | Partial<RuleDraft>): RuleDraft {
  return {
    ...blank,
    ...rule,
    enabled: rule?.enabled === undefined ? true : !!rule.enabled,
    verification_only: !!rule?.verification_only,
    mark_read: !!rule?.mark_read,
    archive: !!rule?.archive,
    pin: !!rule?.pin,
  };
}
export function CheckField({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Field orientation="horizontal" data-disabled={disabled}>
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      />
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
    </Field>
  );
}
function actionLabels(rule: Rule | RuleDraft) {
  return [
    rule.action_category && categoryLabel(rule.action_category),
    rule.mark_read && "标为已读",
    rule.archive && "移入归档",
    rule.pin && "置顶保留",
  ].filter(Boolean) as string[];
}
function PreviewList({ preview }: { preview: Preview }) {
  return (
    <section className="flex flex-col gap-3" aria-label="规则预览结果">
      <p className="text-sm" role="status">
        共匹配 <strong>{preview.total}</strong> 封
        {preview.limited ? "，本次仅展示并处理最新 100 封" : ""}
        。预览不会修改邮件。
      </p>
      <div className="max-h-64 overflow-auto rounded-lg border">
        {preview.mails.length ? (
          preview.mails.map((m) => (
            <article
              key={m.id}
              className="flex flex-col gap-1 border-b p-3 last:border-b-0"
            >
              <p className="break-words text-sm font-medium">
                {m.subject || "(无主题)"}
              </p>
              <p className="break-all text-xs text-muted-foreground">
                {m.sender} → {m.recipient}
              </p>
              <p className="text-xs text-muted-foreground">
                {date(m.created_at)} · {m.is_archived ? "归档" : "收件箱"} ·{" "}
                {categoryLabel(m.category)}
              </p>
            </article>
          ))
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            当前没有命中邮件，仍可保存规则处理后续来信。
          </p>
        )}
      </div>
    </section>
  );
}
export function RuleEditor({
  rule,
  seed,
  close,
  saved,
}: {
  rule?: Rule;
  seed?: Partial<RuleDraft>;
  close: () => void;
  saved: () => void;
}) {
  const w = useWorkspace();
  const [value, setValue] = useState(() => draft(rule || seed));
  const [preview, setPreview] = useState<Preview | null>(null);
  const action = useAction({ inline: true });
  function set<K extends keyof RuleDraft>(key: K, next: RuleDraft[K]) {
    setValue((old) => ({ ...old, [key]: next }));
    setPreview(null);
  }
  return (
    <Modal
      title={rule ? "编辑收件规则" : "新建收件规则"}
      description="所有已填写条件须同时满足。新来信只执行第一条匹配的启用规则。"
      close={action.busy ? () => {} : close}
      wide
    >
      <form
        className="modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const r = await api(
              rule ? `/api/mail-rules/${rule.id}` : "/api/mail-rules",
              rule ? "PUT" : "POST",
              value,
            );
            toast.success(r.message);
            saved();
          });
        }}
      >
        <ModalBody>
          <ActionError message={action.error} />
          <fieldset disabled={action.busy} className="contents">
            <FieldGroup>
              <FieldGroup className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <TextField
                  label="规则名称"
                  required
                  maxLength={80}
                  value={value.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="例如：购物账单自动归档"
                />
                <TextField
                  label="优先级"
                  type="number"
                  min={1}
                  max={999}
                  required
                  value={value.priority}
                  onChange={(e) => set("priority", Number(e.target.value))}
                  help="数字越小越先执行；相同时按创建顺序。"
                />
              </FieldGroup>
              <FieldSet>
                <FieldLegend>匹配条件</FieldLegend>
                <FieldGroup className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                  <TextField
                    label="发件地址包含"
                    maxLength={254}
                    value={value.sender_contains}
                    onChange={(e) => set("sender_contains", e.target.value)}
                    placeholder="例如：@store.example"
                  />
                  <TextField
                    label="主题包含"
                    maxLength={200}
                    value={value.subject_contains}
                    onChange={(e) => set("subject_contains", e.target.value)}
                    placeholder="例如：账单"
                  />
                  <SelectField
                    label="收件域名"
                    value={value.domain}
                    onChange={(v) => set("domain", v)}
                    options={[
                      ["", "不限域名"],
                      ...(w.settings?.domains || []).map(
                        (d) => [d.domain, d.domain] as [string, string],
                      ),
                    ]}
                  />
                  <TextField
                    label="指定收件地址"
                    value={value.recipient}
                    onChange={(e) => set("recipient", e.target.value)}
                    placeholder="可选，填写完整地址"
                  />
                </FieldGroup>
                <CheckField
                  label="仅匹配识别到验证码或验证链接的邮件"
                  checked={value.verification_only}
                  onChange={(v) => set("verification_only", v)}
                />
              </FieldSet>
              <FieldSet>
                <FieldLegend>处理动作</FieldLegend>
                <SelectField
                  label="设置分类"
                  value={value.action_category}
                  onChange={(v) => set("action_category", v)}
                  options={[["", "保留原分类"], ...categories]}
                />
                <FieldGroup className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                  <CheckField
                    label="标为已读"
                    checked={value.mark_read}
                    onChange={(v) => set("mark_read", v)}
                  />
                  <CheckField
                    label="移入归档"
                    checked={value.archive}
                    onChange={(v) => set("archive", v)}
                  />
                  <CheckField
                    label="置顶，防止自动清理"
                    checked={value.pin}
                    onChange={(v) => set("pin", v)}
                  />
                  <CheckField
                    label="启用规则"
                    checked={value.enabled}
                    onChange={(v) => set("enabled", v)}
                  />
                </FieldGroup>
              </FieldSet>
              <Alert>
                <AlertDescription>
                  归档仅整理收件箱，不改变邮件保留期限。重要邮件请同时置顶。保存规则不会处理历史邮件，可在规则列表中预览后应用。
                </AlertDescription>
              </Alert>
              {preview && <PreviewList preview={preview} />}
            </FieldGroup>
          </fieldset>
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
            type="button"
            variant="secondary"
            busy={action.busy}
            onClick={() => {
              void action.run(async () =>
                setPreview(
                  (await api<Preview>("/api/mail-rules/preview", "POST", value))
                    .data,
                ),
              );
            }}
          >
            预览命中
          </BusyButton>
          <BusyButton type="submit" busy={action.busy}>
            保存规则
          </BusyButton>
        </ModalFooter>
      </form>
    </Modal>
  );
}
function ApplyRule({ rule, close }: { rule: Rule; close: () => void }) {
  const w = useWorkspace(),
    action = useAction({ inline: true });
  const [preview, setPreview] = useState<Preview | null>(null),
    [done, setDone] = useState(false);
  return (
    <Modal
      title={`应用规则：${rule.name}`}
      description="手动执行这一条规则，不受其他规则优先级影响。仅处理本次预览中的邮件。"
      close={action.busy ? () => {} : close}
      wide
    >
      <ModalBody>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            {actionLabels(rule).map((v) => (
              <Badge key={v} variant="secondary">
                {v}
              </Badge>
            ))}
          </div>
          <ActionError message={action.error} />
          {!rule.enabled && (
            <Alert>
              <AlertDescription>
                这条规则已停用，可以预览；启用后才能应用。
              </AlertDescription>
            </Alert>
          )}
          {preview ? (
            <PreviewList preview={preview} />
          ) : (
            <p className="text-sm text-muted-foreground">
              先检查命中范围，再决定是否批量处理。
            </p>
          )}
          {done && (
            <p role="status" className="text-sm">
              本次预览的邮件已处理。
            </p>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="outline" disabled={action.busy} onClick={close}>
          关闭
        </Button>
        <BusyButton
          variant="secondary"
          busy={action.busy}
          onClick={() => {
            void action.run(async () => {
              setPreview(
                (
                  await api<Preview>(
                    `/api/mail-rules/${rule.id}/preview`,
                    "POST",
                    {},
                  )
                ).data,
              );
              setDone(false);
            });
          }}
        >
          {preview ? "重新预览" : "预览命中邮件"}
        </BusyButton>
        <BusyButton
          busy={action.busy}
          disabled={!preview?.mails.length || done || !rule.enabled}
          onClick={() => {
            void action.run(async () => {
              const r = await api(`/api/mail-rules/${rule.id}/apply`, "POST", {
                ids: preview!.mails.map((m) => m.id),
                revision: preview!.revision,
              });
              toast.success(r.message);
              setDone(true);
              w.refresh();
            });
          }}
        >
          应用到 {preview?.mails.length || 0} 封邮件
        </BusyButton>
      </ModalFooter>
    </Modal>
  );
}
export default function MailRulesPage() {
  const w = useWorkspace(),
    action = useAction();
  const rules = useResource<Rule[]>("/api/mail-rules", w.revision);
  const [editor, setEditor] = useState<{
    rule?: Rule;
    seed?: Partial<RuleDraft>;
  } | null>(null);
  const [apply, setApply] = useState<Rule | null>(null);
  return (
    <>
      <PageHeader
        title="收件规则"
        description="让域名邮箱自动整理来信。按优先级匹配，历史邮件先预览再处理。"
      >
        <Button onClick={() => setEditor({})}>
          <Plus data-icon="inline-start" />
          新建规则
        </Button>
      </PageHeader>
      <Alert className="mb-5">
        <SlidersHorizontal />
        <AlertDescription>
          新来信自动识别验证码、账单、订阅简报和通知；下方规则可覆盖分类并整理邮件。当前作用于域名收件箱。
        </AlertDescription>
      </Alert>
      {rules.error ? (
        <ErrorState message={rules.error} retry={rules.reload} />
      ) : !rules.result ? (
        <Loading />
      ) : !rules.result.data.length ? (
        <Blank
          title="把重复操作交给规则"
          description="从常见场景开始，预览后再保存。"
        >
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              variant="outline"
              onClick={() =>
                setEditor({
                  seed: {
                    name: "验证码置顶",
                    verification_only: true,
                    pin: true,
                    action_category: "verification",
                  },
                })
              }
            >
              验证码置顶
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                setEditor({
                  seed: {
                    name: "订阅简报归档",
                    subject_contains: "newsletter",
                    archive: true,
                    action_category: "newsletter",
                  },
                })
              }
            >
              订阅简报归档
            </Button>
          </div>
        </Blank>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {rules.result.data.map((rule) => (
            <Card key={rule.id}>
              <CardHeader>
                <CardTitle className="break-words">{rule.name}</CardTitle>
                <CardDescription>
                  优先级 {rule.priority} · {rule.enabled ? "已启用" : "已停用"}
                </CardDescription>
                <CardAction>
                  <Menu
                    label={`规则操作：${rule.name}`}
                    items={[
                      { label: "编辑规则", action: () => setEditor({ rule }) },
                      {
                        label: rule.enabled ? "停用规则" : "启用规则",
                        disabled: action.busy,
                        action: () => {
                          void action.run(async () => {
                            await api(`/api/mail-rules/${rule.id}`, "PUT", {
                              ...draft(rule),
                              enabled: !rule.enabled,
                            });
                            w.refresh();
                          });
                        },
                      },
                      {
                        label: "删除规则",
                        danger: true,
                        action: () =>
                          w.confirm(
                            "删除这条规则？",
                            "后续来信将不再执行它，已处理的邮件保留当前状态。",
                            async () => {
                              await api(`/api/mail-rules/${rule.id}`, "DELETE");
                              w.refresh();
                            },
                          ),
                      },
                    ]}
                  />
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-4">
                <div className="flex flex-col gap-1 break-all text-sm text-muted-foreground">
                  {rule.sender_contains && (
                    <p>发件人包含：{rule.sender_contains}</p>
                  )}
                  {rule.subject_contains && (
                    <p>主题包含：{rule.subject_contains}</p>
                  )}
                  {rule.domain && <p>域名：{rule.domain}</p>}
                  {rule.recipient && <p>收件人：{rule.recipient}</p>}
                  {!!rule.verification_only && <p>含验证码或验证链接</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {actionLabels(rule).map((v) => (
                    <Badge key={v} variant="secondary">
                      {v}
                    </Badge>
                  ))}
                </div>
              </CardContent>
              <CardFooter className="justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  {rule.enabled ? "自动处理新来信" : "暂停自动处理"}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setApply(rule)}
                >
                  预览 / 应用历史邮件
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
      {editor && (
        <RuleEditor
          {...editor}
          close={() => setEditor(null)}
          saved={() => {
            setEditor(null);
            w.refresh();
          }}
        />
      )}
      {apply && <ApplyRule rule={apply} close={() => setApply(null)} />}
    </>
  );
}
