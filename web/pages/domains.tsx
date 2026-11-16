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
  Status,
  TextField,
} from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { FieldGroup } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { api, date, useAction, useResource } from "@/lib/api";
import { useWorkspace } from "@/lib/context";
import type { Domain } from "@/lib/types";
import {
  ArrowUpRight,
  Check,
  CircleHelp,
  Clock3,
  Globe2,
  Mail,
  Network,
  Pencil,
  Plus,
  Power,
  ShieldCheck,
  Star,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
interface DNS {
  domain: string;
  mx: string[];
  txt: string[];
  mx_ready: boolean;
  spf_ready: boolean;
  status: string;
}
export default function DomainsPage() {
  const w = useWorkspace();
  const rows = useResource<Domain[]>("/api/settings/domains", w.revision);
  const [editor, setEditor] = useState<Partial<Domain> | null>(null);
  const [guide, setGuide] = useState<string | null>(null);
  const [dns, setDns] = useState<DNS | null>(null);
  const action = useAction();
  const [checking, setChecking] = useState("");
  const update = async (d: Domain, values: object) => {
    await api(
      `/api/settings/domains/${encodeURIComponent(d.domain)}`,
      "PUT",
      values,
    );
    w.refresh();
    toast.success("域名配置已保存");
  };
  return (
    <>
      <PageHeader
        title="域名管理"
        description="多个邮件域名，共用一个收件工作区。"
      >
        <Button variant="outline" onClick={() => setGuide("")}>
          <CircleHelp data-icon="inline-start" />
          接入指引
        </Button>
        <Button onClick={() => setEditor({})}>
          <Plus data-icon="inline-start" />
          添加域名
        </Button>
      </PageHeader>
      <div className="section-meta">
        <span>
          <strong>{rows.result?.data.length ?? "—"}</strong> 个邮件域名
        </span>
        <span>
          <span className="status-dot status-good" />{" "}
          {rows.result?.data.filter((d) => d.enabled).length ?? "—"} 个已启用
        </span>
        <span className="ml-auto hidden sm:block">在生成邮箱时自由选择</span>
      </div>
      {rows.error ? (
        <ErrorState message={rows.error} retry={rows.reload} />
      ) : !rows.result ? (
        <Loading />
      ) : !rows.result.data.length ? (
        <Blank
          title="接入你的邮件域名"
          description="添加域名并设置收件路由，就能按用途分配邮箱地址。"
        >
          <Button onClick={() => setEditor({})}>添加第一个域名</Button>
        </Blank>
      ) : (
        <div className="domain-grid">
          {rows.result.data.map((d) => (
            <Card key={d.domain} className="domain-card">
              <CardHeader>
                <div className="domain-symbol">
                  <Globe2 />
                </div>
                <CardTitle className="break-all">{d.domain}</CardTitle>
                <CardDescription className="min-h-5">
                  {d.remark ||
                    (d.source === "environment"
                      ? "来自部署配置"
                      : "在工作区添加")}
                </CardDescription>
                <CardAction>
                  <Menu
                    label={`${d.domain} 操作`}
                    items={[
                      {
                        label: "修改备注",
                        icon: <Pencil />,
                        action: () => setEditor(d),
                      },
                      {
                        label: "设为默认域名",
                        icon: <Star />,
                        disabled: !d.enabled || d.is_default,
                        action: () => {
                          void action.run(() =>
                            update(d, { is_default: true }),
                          );
                        },
                      },
                      {
                        label: d.enabled ? "停用域名" : "启用域名",
                        icon: <Power />,
                        danger: !!d.enabled,
                        action: () =>
                          d.enabled
                            ? w.confirm(
                                "停用这个域名？",
                                `${d.domain} 将停止生成新邮箱并拒收后续邮件，已有邮件仍可查看。`,
                                () => update(d, { enabled: false }),
                              )
                            : void action.run(() =>
                                update(d, { enabled: true }),
                              ),
                      },
                    ]}
                  />
                </CardAction>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  <Status value={d.enabled ? "active" : "disabled"} />
                  {d.is_default && <Badge variant="secondary">默认分配</Badge>}
                </div>
                <Separator className="my-5" />
                <dl className="domain-facts">
                  <div>
                    <dt>
                      <Network />
                      DNS 记录
                    </dt>
                    <dd>
                      <Status value={d.dns_status || "unknown"} />
                    </dd>
                  </div>
                  <div>
                    <dt>
                      <Clock3 />
                      最近检查
                    </dt>
                    <dd>{date(d.last_checked_at)}</dd>
                  </div>
                  <div>
                    <dt>
                      <Mail />
                      最近收件
                    </dt>
                    <dd>{date(d.last_received_at)}</dd>
                  </div>
                </dl>
              </CardContent>
              <CardFooter className="justify-between gap-2">
                <BusyButton
                  variant="outline"
                  busy={checking === d.domain}
                  disabled={action.busy}
                  onClick={() => {
                    void action.run(async () => {
                      setChecking(d.domain);
                      try {
                        const r = await api<DNS>(
                          `/api/settings/domains/${encodeURIComponent(d.domain)}/check`,
                          "POST",
                        );
                        setDns(r.data);
                        w.refresh();
                      } finally {
                        setChecking("");
                      }
                    });
                  }}
                >
                  <ShieldCheck data-icon="inline-start" />
                  检查 DNS
                </BusyButton>
                <Button variant="ghost" onClick={() => setGuide(d.domain)}>
                  接入配置
                  <ArrowUpRight data-icon="inline-end" />
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
      <Alert className="mt-6">
        <Globe2 />
        <AlertTitle>一个 Worker，接入多个域名</AlertTitle>
        <AlertDescription>
          每个域名都需要单独启用 Cloudflare Email Routing，并把 Catch-all
          指向同一个 Worker。DNS 就绪后，还需要实际收一封邮件来验证投递。
        </AlertDescription>
      </Alert>
      {editor && <DomainEditor domain={editor} close={() => setEditor(null)} />}
      {guide !== null && (
        <DomainGuide domain={guide} close={() => setGuide(null)} />
      )}
      {dns && (
        <Modal
          title="DNS 检查"
          description="以下结果来自公开 DNS 记录查询。"
          close={() => setDns(null)}
        >
          <ModalBody>
            <p className="break-all font-medium">{dns.domain}</p>
            <div className="flex gap-2">
              <Badge variant={dns.mx_ready ? "secondary" : "destructive"}>
                MX {dns.mx_ready ? "已就绪" : "待完善"}
              </Badge>
              <Badge variant={dns.spf_ready ? "secondary" : "destructive"}>
                SPF {dns.spf_ready ? "已就绪" : "待完善"}
              </Badge>
            </div>
            <pre className="code-block">
              {[...dns.mx, ...dns.txt].join("\n") || "暂无记录"}
            </pre>
            <p className="text-sm text-muted-foreground">
              配置时以 Cloudflare Email Routing 提供的记录为准，避免与已有 MX 或
              SPF 冲突。
            </p>
          </ModalBody>
          <ModalFooter>
            <Button
              onClick={() => {
                setGuide(dns.domain);
                setDns(null);
              }}
            >
              查看接入步骤
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </>
  );
}
function DomainEditor({
  domain,
  close,
}: {
  domain: Partial<Domain>;
  close: () => void;
}) {
  const w = useWorkspace();
  const [name, setName] = useState(domain.domain || "");
  const [remark, setRemark] = useState(domain.remark || "");
  const action = useAction({ inline: true });
  return (
    <Modal
      title={domain.domain ? "编辑域名备注" : "添加邮件域名"}
      description="填写你已在 Cloudflare 管理的域名，子域名也可以独立接入。"
      close={close}
    >
      <form
        className="modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api(
              `/api/settings/domains${domain.domain ? `/${encodeURIComponent(domain.domain)}` : ""}`,
              domain.domain ? "PUT" : "POST",
              { domain: name, remark },
            );
            w.refresh();
            toast.success(
              domain.domain ? "备注已更新" : "域名已添加，请完成收件路由配置",
            );
            close();
          });
        }}
      >
        <ModalBody>
          <ActionError message={action.error} />
          <FieldGroup>
            <TextField
              label="域名"
              required
              disabled={!!domain.domain}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="mail.example.com"
              help="填写域名即可，无需 https:// 或路径。"
            />
            <TextField
              label="用途备注"
              maxLength={300}
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder="例如 工作、开发测试、订阅"
            />
          </FieldGroup>
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="outline" onClick={close}>
            取消
          </Button>
          <BusyButton type="submit" busy={action.busy}>
            {domain.domain ? "保存备注" : "添加域名"}
          </BusyButton>
        </ModalFooter>
      </form>
    </Modal>
  );
}
function DomainGuide({ domain, close }: { domain: string; close: () => void }) {
  return (
    <Modal
      title="接入邮件域名"
      description={domain || "每个域名分别完成以下步骤，即可进入统一收件箱。"}
      close={close}
      wide
    >
      <ModalBody>
        <ol className="setup-steps">
          <li>
            <span>1</span>
            <div>
              <h3>启用 Email Routing</h3>
              <p>
                进入 Cloudflare 对应域名的 Email → Email Routing，按提示添加 MX
                与 SPF 记录。子域名也需要配置自己的记录。
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <h3>把 Catch-all 指向当前 Worker</h3>
              <p>
                在 Routing rules 中启用 Catch-all，操作选择“Send to a
                Worker”，目标选择这个 MailHub 部署的 Worker。
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <h3>检查并验证一次真实收件</h3>
              <p>
                回到域名管理点击“检查
                DNS”。然后在“临时邮箱”选择此域名生成地址，用其他邮箱向它发送测试邮件。
              </p>
            </div>
          </li>
          <li>
            <span>
              <Check className="size-4" />
            </span>
            <div>
              <h3>设定默认分配域名</h3>
              <p>
                验证后可设为默认，平台账号登记、临时邮箱和外部 API
                都支持指定域名。
              </p>
            </div>
          </li>
        </ol>
        <Alert>
          <AlertDescription>
            添加邮件域名与面板访问域名是两项配置。若要通过新的网址访问面板，请在
            Cloudflare 的 Worker → Settings → Domains & Routes 中添加 Custom
            Domain。
          </AlertDescription>
        </Alert>
      </ModalBody>
      <ModalFooter>
        <Button variant="outline" asChild>
          <a
            href="https://dash.cloudflare.com/"
            target="_blank"
            rel="noopener noreferrer"
          >
            打开 Cloudflare 控制台
            <ArrowUpRight data-icon="inline-end" />
          </a>
        </Button>
      </ModalFooter>
    </Modal>
  );
}
