import {
  PollingControls,
  VerificationActions,
  VerificationLookup,
} from "./verification";
import { MailCompose } from "./mail-compose";
import {
  ActionError,
  Blank,
  BusyButton,
  CopyAction,
  ErrorState,
  IconButton,
  Loading,
  Modal,
  ModalBody,
  Pick,
  RefreshButton,
  SearchBox,
} from "@/components/common";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  api,
  date,
  downloadFile,
  query,
  safeUrl,
  useAction,
  useDebounce,
  useResource,
} from "@/lib/api";
import { useWorkspace } from "@/lib/context";
import { mailHtml } from "@/lib/mail-html";
import type { Mail } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useSmartPolling } from "@/hooks/use-smart-polling";
import {
  ArrowLeft,
  ArrowRight,
  Archive,
  Image,
  KeyRound,
  Mail as MailIcon,
  Paperclip,
  Pin,
  Moon,
  Pencil,
  Reply,
  Sun,
  Trash2,
  Users,
  Download,
} from "lucide-react";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";

export type ReaderLayout = "modal" | "embedded";

function ReaderFrame({
  layout = "modal",
  title,
  description,
  close,
  children,
  wide = false,
}: {
  layout?: ReaderLayout;
  title: ReactNode;
  description: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  if (layout === "embedded")
    return (
      <section
        aria-labelledby={titleId}
        className="flex h-[min(920px,calc(100dvh-10rem))] min-h-96 min-w-0 flex-col overflow-hidden rounded-xl border bg-card"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b p-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h2
              id={titleId}
              className="flex min-w-0 items-center gap-2 text-base font-semibold"
            >
              {title}
            </h2>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
          <Button variant="outline" size="sm" onClick={close}>
            <ArrowLeft data-icon="inline-start" />
            返回
          </Button>
        </header>
        {children}
      </section>
    );
  return (
    <Dialog open onOpenChange={(value) => !value && close()}>
      <DialogContent
        className={
          wide
            ? "h-[calc(100dvh-2rem)] max-h-[min(920px,calc(100dvh-2rem))] max-w-[1120px] md:h-[86dvh]"
            : "max-w-4xl"
        }
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle
            ref={titleRef}
            tabIndex={-1}
            className="flex min-w-0 items-center gap-2 outline-none"
          >
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** Always available, including for a disabled or disconnected mailbox. */
export function RelatedVaultAccounts({
  email,
  source = "cf_domain",
}: {
  email: string;
  source?: string;
}) {
  const w = useWorkspace();
  if (!email.trim()) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      className="self-start"
      onClick={() => w.identity({ address: email, source })}
    >
      <Users data-icon="inline-start" />
      查看全部登记
    </Button>
  );
}
const folderNames: [string, string][] = [
  ["inbox", "收件箱"],
  ["junkemail", "垃圾邮件"],
  ["sentitems", "已发送"],
  ["archive", "归档"],
  ["deleteditems", "已删除"],
  ["all", "全部邮件"],
];
type OutlookReaderProps = {
  id: number;
  email: string;
  close: () => void;
  layout?: ReaderLayout;
};
export function OutlookReader(props: OutlookReaderProps) {
  return <OutlookReaderContent key={props.id} {...props} />;
}
function OutlookReaderContent({
  id,
  email,
  close,
  layout,
}: OutlookReaderProps) {
  const [folder, setFolder] = useState("inbox");
  const [q, setQ] = useState("");
  const search = useDebounce(q);
  const [cursors, setCursors] = useState([""]);
  const [message, setMessage] = useState<string | null>(null);
  const [compose, setCompose] = useState(false);
  const w = useWorkspace();
  const rows = useSmartPolling<Mail[]>(
    `/api/outlook/accounts/${id}/emails?${query({ folder, q: search, cursor: cursors.at(-1), top: 20 })}`,
    { revision: w.revision },
  );
  const detail = useResource<Mail>(
    message
      ? `/api/outlook/accounts/${id}/messages/${encodeURIComponent(message)}`
      : null,
    w.revision,
  );
  const reset = () => {
    setCursors([""]);
    setMessage(null);
  };
  return (
    <ReaderFrame
      layout={layout}
      close={close}
      wide
      description="Outlook 邮件工作区"
      title={
        <>
          <MailIcon className="size-5 shrink-0" />
          <span className="line-clamp-2 min-w-0 break-all" title={email}>
            {email}
          </span>
        </>
      }
    >
      <div className="reader-layout">
        <section
          className={cn("message-list-pane", message && "reader-mobile-hidden")}
          aria-label="邮件列表"
        >
          <div className="px-3 pt-3">
            <RelatedVaultAccounts email={email} source="outlook" />
          </div>
          <div className="flex shrink-0 items-center gap-2 p-3">
            <Pick
              label="邮件文件夹"
              value={folder}
              onChange={(v) => {
                setFolder(v);
                reset();
              }}
              options={folderNames}
              className="flex-1"
            />
            <RefreshButton onClick={rows.reload} busy={rows.loading} />
            <IconButton
              label="查收验证码"
              onClick={() => w.code(`/api/outlook/accounts/${id}/code`)}
            >
              <KeyRound />
            </IconButton>
            <IconButton
              label="写邮件"
              onClick={() => {
                rows.stop();
                setCompose(true);
              }}
            >
              <Pencil />
            </IconButton>
          </div>
          <div className="flex shrink-0 flex-col gap-2 px-3 pb-3">
            <SearchBox
              value={q}
              onChange={(v) => {
                rows.stop();
                setQ(v);
                reset();
              }}
              placeholder="搜索此邮箱的邮件…"
            />
            <PollingControls
              polling={rows}
              compact
              disabled={cursors.length > 1 || q !== search || compose}
            />
            {cursors.length > 1 && (
              <p className="text-xs text-muted-foreground">
                返回第一页后可开启自动查收。
              </p>
            )}
          </div>
          <Separator />
          <div className="message-list-scroll">
            {rows.error ? (
              <div className="p-3">
                <ErrorState message={rows.error} retry={rows.reload} />
                <Button
                  className="mt-3"
                  variant="outline"
                  onClick={() => {
                    rows.stop();
                    w.repairOutlook({ id, email });
                  }}
                >
                  检查授权与修复连接
                </Button>
              </div>
            ) : !rows.result ? (
              <div className="px-3">
                <Loading />
              </div>
            ) : !rows.result.data.length ? (
              <Blank
                title="暂无邮件"
                description="切换文件夹或调整搜索关键词。"
              />
            ) : (
              rows.result.data.map((m) => (
                <article
                  key={m.id}
                  className={cn(
                    "message-preview",
                    String(m.id) === message && "selected",
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-col gap-2 text-left"
                    onClick={() => setMessage(String(m.id))}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs">
                        {m.from?.emailAddress?.name ||
                          m.from?.emailAddress?.address ||
                          "未知发件人"}
                      </span>
                      {!m.isRead && <span className="status-dot status-good" />}
                    </div>
                    <strong className="line-clamp-2 text-sm">
                      {m.subject || "(无主题)"}
                    </strong>
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                      {m.bodyPreview}
                    </p>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <time>{date(m.receivedDateTime)}</time>
                      {m.hasAttachments && <Paperclip className="size-3" />}
                    </div>
                  </button>
                  <VerificationActions
                    code={m.verification_code}
                    link={m.verification_link}
                  />
                </article>
              ))
            )}
          </div>
          <div className="flex shrink-0 items-center justify-between border-t p-2">
            <IconButton
              label="上一页邮件"
              disabled={cursors.length === 1 || rows.loading}
              onClick={() => {
                setCursors((c) => c.slice(0, -1));
                setMessage(null);
              }}
            >
              <ArrowLeft />
            </IconButton>
            <span className="text-xs text-muted-foreground">
              第 {cursors.length} 页
            </span>
            <IconButton
              label="下一页邮件"
              disabled={!rows.result?.next_cursor || rows.loading}
              onClick={() => {
                setCursors((c) => [...c, rows.result!.next_cursor!]);
                setMessage(null);
              }}
            >
              <ArrowRight />
            </IconButton>
          </div>
        </section>
        <section
          className={cn(
            "message-detail-pane",
            !message && "reader-mobile-hidden",
          )}
          aria-label="邮件正文"
        >
          {message && (
            <div className="flex shrink-0 items-center justify-between border-b px-3 py-2 md:hidden">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setMessage(null)}
              >
                <ArrowLeft data-icon="inline-start" />
                返回邮件列表
              </Button>
              <IconButton
                label="查收验证码"
                onClick={() => w.code(`/api/outlook/accounts/${id}/code`)}
              >
                <KeyRound />
              </IconButton>
            </div>
          )}
          <div className="message-detail-scroll" key={message || "empty"}>
            {!message ? (
              <Blank
                title={rows.error ? "邮件尚未加载" : "选择一封邮件"}
                description={
                  rows.error
                    ? "连接恢复后，在左侧重新加载邮件列表。"
                    : "在左侧选择邮件，查看正文、验证码和附件。"
                }
              />
            ) : detail.error ? (
              <div className="p-4 sm:p-5">
                <ErrorState message={detail.error} retry={detail.reload} />
              </div>
            ) : !detail.result ? (
              <div className="px-4 sm:px-5">
                <Loading />
              </div>
            ) : (
              <MessageBody
                key={message}
                mail={detail.result.data}
                outlookId={id}
                mailboxEmail={email}
                onCompose={rows.stop}
                onDeleted={() => {
                  reset();
                  rows.reload();
                }}
              />
            )}
          </div>
        </section>
      </div>
      {compose && (
        <MailCompose
          accountId={id}
          email={email}
          close={() => setCompose(false)}
          onAccepted={rows.reload}
        />
      )}
    </ReaderFrame>
  );
}
export function CfReader({
  id,
  close,
  layout,
}: {
  id: number;
  close: () => void;
  layout?: ReaderLayout;
}) {
  const r = useResource<Mail>(`/api/cf-mails/${id}`);
  return (
    <ReaderFrame
      layout={layout}
      close={close}
      title="邮件详情"
      description="域名邮箱收件"
    >
      <div className="message-detail-scroll">
        {r.error ? (
          <div className="p-5">
            <ErrorState message={r.error} retry={r.reload} />
          </div>
        ) : !r.result ? (
          <div className="p-5">
            <Loading />
          </div>
        ) : (
          <MessageBody key={id} mail={r.result.data} onDeleted={close} />
        )}
      </div>
    </ReaderFrame>
  );
}
function MessageBody({
  mail,
  outlookId,
  onDeleted,
  mailboxEmail,
  onCompose,
}: {
  mail: Mail;
  outlookId?: number;
  onDeleted: () => void;
  mailboxEmail?: string;
  onCompose?: () => void;
}) {
  const w = useWorkspace();
  const action = useAction({ inline: true });
  const [remote, setRemote] = useState(false);
  const [night, setNight] = useState(false);
  const [reply, setReply] = useState(false);
  const [pinned, setPinned] = useState(!!mail.is_pinned);
  const [archived, setArchived] = useState(!!mail.is_archived);
  const html = outlookId
    ? mail.body?.contentType.toLowerCase() === "html"
      ? mail.body.content
      : ""
    : mail.html_content;
  const text = outlookId
    ? mail.body?.contentType.toLowerCase() === "text"
      ? mail.body.content
      : mail.bodyPreview
    : mail.text_content;
  const srcDoc = useMemo(
    () => (html ? mailHtml(html, remote, night) : ""),
    [html, remote, night],
  );
  const base = outlookId
    ? `/api/outlook/accounts/${outlookId}/messages/${encodeURIComponent(mail.id)}`
    : `/api/cf-mails/${mail.id}`;
  return (
    <div className="message-body">
      <div className="mail-subject-header">
        <h2>{mail.subject || "(无主题)"}</h2>
        <div className="mail-sender-line">
          <span className="sender-avatar">
            {(
              mail.from?.emailAddress?.name ||
              mail.sender_name ||
              mail.sender ||
              "M"
            ).slice(0, 1)}
          </span>
          <div className="min-w-0">
            <p className="break-all font-medium">
              {mail.from?.emailAddress?.name || mail.sender_name || mail.sender}
            </p>
            <p className="break-all text-xs text-muted-foreground">
              {mail.from?.emailAddress?.address || mail.recipient}
            </p>
          </div>
          <time className="ml-auto shrink-0 text-xs text-muted-foreground">
            {date(mail.receivedDateTime || mail.created_at)}
          </time>
        </div>
        <div className="flex flex-wrap gap-1">
          {!outlookId && mail.has_raw && (
            <BusyButton
              variant="ghost"
              size="sm"
              busy={action.busy}
              onClick={() =>
                void action.run(() =>
                  downloadFile(`${base}/raw`, `mail-${mail.id}.eml`),
                )
              }
            >
              <Download data-icon="inline-start" />
              下载原始邮件
            </BusyButton>
          )}
          {outlookId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onCompose?.();
                setReply(true);
              }}
            >
              <Reply data-icon="inline-start" />
              回复邮件
            </Button>
          )}
          <CopyAction
            variant="ghost"
            size="sm"
            label="复制正文"
            value={
              text ||
              new DOMParser().parseFromString(html || "", "text/html").body
                .textContent ||
              ""
            }
          />
          {!outlookId && (
            <BusyButton
              variant="ghost"
              size="sm"
              busy={action.busy}
              onClick={() => {
                void action.run(async () => {
                  await api(base, "PATCH", { is_archived: !archived });
                  setArchived(!archived);
                  w.refresh();
                });
              }}
            >
              <Archive data-icon="inline-start" />
              {archived ? "移回收件箱" : "归档邮件"}
            </BusyButton>
          )}
          {!outlookId && (
            <BusyButton
              variant="ghost"
              size="sm"
              busy={action.busy}
              onClick={() => {
                void action.run(async () => {
                  await api(base, "PATCH", { is_pinned: !pinned });
                  setPinned(!pinned);
                  w.refresh();
                });
              }}
            >
              <Pin data-icon="inline-start" />
              {pinned ? "取消置顶" : "置顶邮件"}
            </BusyButton>
          )}
          <IconButton
            label="删除邮件"
            onClick={() =>
              w.confirm(
                "删除这封邮件？",
                outlookId
                  ? "此操作会删除微软邮箱中的邮件。在“已删除”文件夹操作时，可能无法恢复。"
                  : "邮件正文将永久删除。",
                async () => {
                  await api(base, "DELETE");
                  w.refresh();
                  onDeleted();
                },
              )
            }
          >
            <Trash2 />
          </IconButton>
        </div>
      </div>
      <div className="px-4 pb-3 sm:px-5">
        <RelatedVaultAccounts
          email={mailboxEmail || mail.recipient || ""}
          source={outlookId ? "outlook" : "cf_domain"}
        />
      </div>
      {action.error && (
        <div className="px-4 pb-4 sm:px-5">
          <ActionError message={action.error} />
        </div>
      )}
      {(mail.verification_code || safeUrl(mail.verification_link)) && (
        <div className="verification-banner">
          <div>
            <p>邮件验证码</p>
            <strong>{mail.verification_code || "发现验证链接"}</strong>
          </div>
          <VerificationActions
            code={mail.verification_code}
            link={mail.verification_link}
          />
        </div>
      )}
      {!!mail.attachments?.length && (
        <div className="flex flex-wrap gap-2 p-4">
          {mail.attachments.map((a) => (
            <BusyButton
              variant="outline"
              size="sm"
              className="max-w-full"
              key={a.id}
              busy={action.busy}
              onClick={() =>
                void action.run(() =>
                  downloadFile(
                    `${base}/attachments/${encodeURIComponent(a.id)}`,
                    a.name,
                  ),
                )
              }
            >
              <Paperclip data-icon="inline-start" />
              <span className="min-w-0 truncate">{a.name}</span>
              <span className="shrink-0 text-muted-foreground">
                {Math.ceil(a.size / 1024)} KB
              </span>
            </BusyButton>
          ))}
        </div>
      )}
      {mail.attachment_error && (
        <div className="px-4 pb-4 sm:px-5">
          <Alert variant="destructive">
            <AlertDescription>{mail.attachment_error}</AlertDescription>
          </Alert>
        </div>
      )}
      <Tabs defaultValue={html ? "html" : "text"} className="gap-0">
        <div className="mail-mode-bar">
          <TabsList variant="line">
            {html && <TabsTrigger value="html">邮件原貌</TabsTrigger>}
            <TabsTrigger value="text">纯文本</TabsTrigger>
            {!outlookId && <TabsTrigger value="headers">邮件信息</TabsTrigger>}
          </TabsList>
          {html && (
            <div className="flex flex-wrap items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                aria-pressed={night}
                onClick={() => setNight(!night)}
              >
                {night ? (
                  <Sun data-icon="inline-start" />
                ) : (
                  <Moon data-icon="inline-start" />
                )}
                {night ? "恢复原貌" : "夜间阅读"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-pressed={remote}
                onClick={() => setRemote(!remote)}
              >
                <Image data-icon="inline-start" />
                {remote ? "隐藏外部图片" : "显示外部图片"}
              </Button>
            </div>
          )}
        </div>
        {html && (
          <TabsContent value="html">
            <iframe
              className="mail-frame"
              title="邮件 HTML 正文"
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
              srcDoc={srcDoc}
            />
          </TabsContent>
        )}
        <TabsContent value="text">
          <pre className="mail-text">{text || "(无纯文本正文)"}</pre>
        </TabsContent>
        {!outlookId && (
          <TabsContent value="headers">
            <dl className="mail-headers">
              <dt>Message-ID</dt>
              <dd>{mail.message_id || "—"}</dd>
              <dt>收件人</dt>
              <dd>{mail.recipient}</dd>
              <dt>邮件大小</dt>
              <dd>{mail.raw_size || 0} bytes</dd>
              <dt>邮件头报告 SPF</dt>
              <dd>{mail.spf_status || "unknown"}</dd>
              <dt>邮件头报告 DKIM</dt>
              <dd>{mail.dkim_status || "unknown"}</dd>
            </dl>
          </TabsContent>
        )}
      </Tabs>
      <p className="px-5 pb-4 text-xs text-muted-foreground">
        脚本与表单已禁用。外部图片默认不加载。
      </p>
      {!!outlookId && reply && (
        <MailCompose
          accountId={outlookId}
          email={mailboxEmail || "当前 Outlook 邮箱"}
          reply={{
            id: mail.id,
            subject: mail.subject,
            to: mail.from?.emailAddress?.address,
          }}
          close={() => setReply(false)}
        />
      )}
    </div>
  );
}
export function CodeReader({
  path,
  close,
}: {
  path: string;
  close: () => void;
}) {
  return (
    <Modal
      title="验证码与验证链接"
      description="直接取码，或等待新的验证邮件到达。"
      close={close}
    >
      <ModalBody>
        <VerificationLookup path={path} />
      </ModalBody>
    </Modal>
  );
}
