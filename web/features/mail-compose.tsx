import { useEffect, useId, useRef, useState } from "react";
import { Paperclip, Send, X } from "lucide-react";
import {
  ActionError,
  BusyButton,
  CopyAction,
  IconButton,
} from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const attachmentTypes: Record<string, string> = {
  txt: "text/plain",
  csv: "text/csv",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};
type SendFailure = {
  message?: string;
  error?: string;
  required_scopes?: string[];
  delivery_unknown?: boolean;
  draft_id?: string;
  retry_after?: number;
};
type SendResponse = SendFailure & {
  success?: boolean;
  data?: { accepted?: boolean };
};

async function encodeAttachment(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return {
    name: file.name,
    content_type: attachmentTypes[file.name.split(".").at(-1)!.toLowerCase()],
    content_base64: btoa(binary),
  };
}

export type MailComposeProps = {
  accountId: number;
  email: string;
  reply?: { id: string | number; subject: string; to?: string };
  close: () => void;
  onAccepted?: () => void;
};

/** Drafts stay in component memory. No autosend, background retry or persistence
 * of message contents. The server sends Graph contentType=Text for both routes.
 */
export function MailCompose({
  accountId,
  email,
  reply,
  close,
  onAccepted,
}: MailComposeProps) {
  const uid = useId();
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState<
    "to" | "subject" | "body" | "files" | null
  >(null);
  const [accepted, setAccepted] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [failure, setFailure] = useState<SendFailure | null>(null);
  const [retryConfirmed, setRetryConfirmed] = useState(false);
  const [confirmNewSubmission, setConfirmNewSubmission] = useState(false);
  const submission = useRef<{ path: string; body: string; key: string } | null>(
    null,
  );
  const lock = useRef(false);
  const mounted = useRef(true);
  const request = useRef<AbortController | null>(null);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  const toInput = useRef<HTMLInputElement>(null);
  const subjectInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (accepted || (error && !invalid)) {
      feedback.current?.focus({ preventScroll: true });
      feedback.current?.scrollIntoView({ block: "nearest" });
    }
  }, [accepted, error, invalid]);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (!accepted && (to || subject || body || files.length || busy)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [to, subject, body, files.length, accepted, busy]);
  const requestClose = () => {
    if (lock.current) return;
    if (!accepted && (to || subject || body || files.length)) setDiscard(true);
    else close();
  };
  const fail = (field: typeof invalid, message: string) => {
    setInvalid(field);
    setError(message);
    (field === "to"
      ? toInput
      : field === "subject"
        ? subjectInput
        : field === "files"
          ? fileInput
          : bodyInput
    ).current?.focus();
  };
  const addFiles = (incoming: FileList | null) => {
    if (!incoming?.length) return;
    const next = [...files, ...Array.from(incoming)];
    if (
      next.length > 10 ||
      next.reduce((total, file) => total + file.size, 0) > 3 * 1024 * 1024
    )
      return fail(
        "files",
        "最多添加 10 个附件，合计不超过 3 MiB。此次选择未加入。",
      );
    if (
      next.some(
        (file) =>
          !file.size ||
          !Object.hasOwn(
            attachmentTypes,
            file.name.split(".").at(-1)!.toLowerCase(),
          ) ||
          file.name !== file.name.trim() ||
          file.name.startsWith(".") ||
          file.name.endsWith(".") ||
          /[\x00-\x1f\x7f-\x9f/\\:<>"|?*\u202a-\u202e\u2066-\u2069]/.test(
            file.name,
          ) ||
          new TextEncoder().encode(file.name).length > 255,
      )
    )
      return fail(
        "files",
        "请使用非空的受支持文档、图片或 ZIP 文件；文件名不能包含路径、控制字符或超过 255 字节。此次选择未加入。",
      );
    setFiles(next);
    if (invalid === "files") {
      setInvalid(null);
      setError("");
    }
  };
  const needsRetryReview = !!(failure?.delivery_unknown || failure?.draft_id);
  const send = async (newSubmission = false) => {
    if (lock.current || accepted || (needsRetryReview && !retryConfirmed))
      return;
    setError("");
    setInvalid(null);
    const recipients = [
      ...new Set(
        to
          .split(/[,;；，\n]+/)
          .map((v) => v.trim())
          .filter(Boolean),
      ),
    ];
    if (
      !reply &&
      (!recipients.length ||
        recipients.length > 100 ||
        recipients.some(
          (v) => v.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(v),
        ))
    )
      return fail(
        "to",
        "请输入 1–100 个有效邮箱，用逗号分隔；请只填写邮箱地址。",
      );
    if (!reply && (!subject.trim() || /[\r\n]/.test(subject)))
      return fail("subject", "请填写邮件主题，不能包含换行。");
    if (!body.trim()) return fail("body", "请填写要发送的正文。");
    lock.current = true;
    setBusy(true);
    const controller = new AbortController();
    request.current = controller;
    let submitted = false;
    try {
      const base = `/api/outlook/accounts/${accountId}`;
      const attachments = files.length
        ? await Promise.all(files.map(encodeAttachment))
        : undefined;
      if (controller.signal.aborted || !mounted.current) return;
      const path = reply
        ? `${base}/messages/${encodeURIComponent(reply.id)}/reply`
        : `${base}/send`;
      const payload = JSON.stringify(
        reply
          ? { body, attachments }
          : { to: recipients, subject: subject.trim(), body, attachments },
      );
      if (
        submission.current &&
        !newSubmission &&
        (failure ||
          submission.current.path !== path ||
          submission.current.body !== payload)
      ) {
        if (failure)
          setError(
            failure.message || "上次提交未成功，请确认后发起新的发送请求。",
          );
        setConfirmNewSubmission(true);
        return;
      }
      if (!submission.current || newSubmission)
        submission.current = { path, body: payload, key: crypto.randomUUID() };
      const attempt = submission.current;
      submitted = true;
      // Keep structured failure details here: the shared api helper intentionally
      // turns failures into a message, losing draft_id and delivery_unknown.
      const response = await fetch(attempt.path, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(120000),
        ]),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": attempt.key,
        },
        body: attempt.body,
      });
      if (response.status === 401)
        window.dispatchEvent(new Event("mailhub:unauthorized"));
      const result: SendResponse = await response.json().catch(() => ({}));
      if (controller.signal.aborted || !mounted.current) return;
      if (
        response.status !== 202 ||
        result.success !== true ||
        result.data?.accepted !== true
      ) {
        const detail: SendFailure = {
          ...result,
          delivery_unknown:
            result.delivery_unknown ||
            result.error === "IDEMPOTENCY_UNKNOWN" ||
            response.status >= 500 ||
            response.ok,
        };
        setFailure(detail);
        setRetryConfirmed(false);
        setError(result.message || "未能确认发送结果，请先检查已发送邮件。");
        return;
      }
      if (mounted.current) {
        setFailure(null);
        setAccepted(true);
        onAccepted?.();
      }
    } catch (e) {
      if (mounted.current) {
        setFailure({ delivery_unknown: submitted });
        setRetryConfirmed(false);
        setError(e instanceof Error ? e.message : "发送请求失败");
      }
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <>
      <Dialog open onOpenChange={(value) => !value && requestClose()}>
        <DialogContent
          className="max-w-2xl"
          showCloseButton={!busy}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (reply) bodyInput.current?.focus();
            else toInput.current?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>{reply ? "回复邮件" : "写邮件"}</DialogTitle>
            <DialogDescription className="break-all">
              发件邮箱：{email} · 纯文本
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {accepted && (
              <Alert role="status" ref={feedback} tabIndex={-1}>
                <AlertTitle>微软已接受发送请求</AlertTitle>
                <AlertDescription>
                  接受请求不代表已经投递到收件箱。请在“已发送”中查看记录，并留意退信。
                  <p className="break-words">
                    主题：{reply?.subject || subject || "(无主题)"}
                  </p>
                  {!!files.length && (
                    <p>已随邮件提交 {files.length} 个附件。</p>
                  )}
                </AlertDescription>
              </Alert>
            )}
            {!accepted && (
              <FieldGroup>
                <Field
                  data-invalid={invalid === "to"}
                  data-disabled={busy || accepted}
                >
                  <FieldLabel htmlFor={`${uid}-to`}>
                    {reply ? "回复给" : "收件人"}
                  </FieldLabel>
                  {reply ? (
                    <p id={`${uid}-to`} className="break-all text-sm">
                      {reply.to || "原邮件发件人"}（按原邮件 Reply-To 地址回复）
                    </p>
                  ) : (
                    <Input
                      id={`${uid}-to`}
                      ref={toInput}
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                      disabled={busy || accepted}
                      aria-invalid={invalid === "to"}
                      autoComplete="off"
                      spellCheck={false}
                      inputMode="email"
                      maxLength={25500}
                      placeholder="name@example.com, another@example.com"
                    />
                  )}
                  {!reply && (
                    <FieldDescription>
                      多个地址用逗号分隔，最多 100 个。
                    </FieldDescription>
                  )}
                </Field>
                <Field
                  data-invalid={invalid === "subject"}
                  data-disabled={busy || accepted}
                >
                  <FieldLabel htmlFor={`${uid}-subject`}>主题</FieldLabel>
                  {reply ? (
                    <p id={`${uid}-subject`} className="break-words text-sm">
                      {reply.subject || "(无主题)"}
                    </p>
                  ) : (
                    <Input
                      id={`${uid}-subject`}
                      ref={subjectInput}
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      disabled={busy || accepted}
                      aria-invalid={invalid === "subject"}
                      autoComplete="off"
                      maxLength={255}
                    />
                  )}
                </Field>
                <Field
                  data-invalid={invalid === "body"}
                  data-disabled={busy || accepted}
                >
                  <FieldLabel htmlFor={`${uid}-body`}>正文</FieldLabel>
                  <Textarea
                    id={`${uid}-body`}
                    ref={bodyInput}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    className="min-h-40 max-h-80"
                    disabled={busy || accepted}
                    aria-invalid={invalid === "body"}
                    maxLength={100000}
                    placeholder={reply ? "写下你的回复…" : "写下邮件正文…"}
                  />
                  <FieldDescription>
                    以纯文本发送；HTML 标签会作为文字保留。
                  </FieldDescription>
                </Field>
                <Field
                  data-invalid={invalid === "files"}
                  data-disabled={busy || accepted}
                >
                  <FieldLabel htmlFor={`${uid}-files`}>
                    <Paperclip className="size-4" />
                    附件（可选）
                  </FieldLabel>
                  <Input
                    ref={fileInput}
                    id={`${uid}-files`}
                    type="file"
                    multiple
                    accept={Object.keys(attachmentTypes)
                      .map((extension) => `.${extension}`)
                      .join(",")}
                    disabled={busy || accepted}
                    aria-invalid={invalid === "files"}
                    onChange={(event) => {
                      addFiles(event.currentTarget.files);
                      event.currentTarget.value = "";
                    }}
                  />
                  <FieldDescription>
                    最多 10 个，共 3 MiB。支持 TXT、CSV、PDF、图片、Office
                    文档及 ZIP。
                  </FieldDescription>
                  {!!files.length && (
                    <ul className="flex min-w-0 flex-col gap-1">
                      {files.map((file, index) => (
                        <li
                          key={`${file.name}-${index}`}
                          className="flex min-w-0 items-center gap-2"
                        >
                          <span
                            className="min-w-0 flex-1 truncate text-sm"
                            title={file.name}
                          >
                            {file.name}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {Math.ceil(file.size / 1024)} KB
                          </span>
                          <IconButton
                            label={`移除附件 ${file.name}`}
                            disabled={busy || accepted}
                            onClick={() =>
                              setFiles(files.filter((_, i) => i !== index))
                            }
                          >
                            <X />
                          </IconButton>
                        </li>
                      ))}
                    </ul>
                  )}
                </Field>
              </FieldGroup>
            )}
            {error && (
              <div
                ref={feedback}
                tabIndex={-1}
                className="flex flex-col gap-2 outline-none"
              >
                <ActionError message={error} />
                {failure?.required_scopes?.length ? (
                  <p className="break-words text-sm text-muted-foreground">
                    请重新授权所需权限：{failure.required_scopes.join("、")}
                    。当前内容已保留。
                  </p>
                ) : null}
                {failure?.delivery_unknown && (
                  <Alert>
                    <AlertTitle>发送结果未知</AlertTitle>
                    <AlertDescription>
                      请求可能已被微软接受。请先检查“已发送”和收件情况，确认后再决定是否重新发送。
                    </AlertDescription>
                  </Alert>
                )}
                {failure?.draft_id && (
                  <Alert>
                    <AlertTitle>微软邮箱中保留了草稿</AlertTitle>
                    <AlertDescription>
                      <p>
                        请在 Outlook
                        的草稿箱检查或继续编辑。再次发送会创建新的回复，可能留下重复草稿。
                      </p>
                      <p className="break-all font-mono text-xs">
                        {failure.draft_id}
                      </p>
                      <CopyAction
                        value={failure.draft_id}
                        label="复制草稿 ID"
                        variant="outline"
                        size="sm"
                      />
                    </AlertDescription>
                  </Alert>
                )}
                {failure?.retry_after ? (
                  <p className="text-sm text-muted-foreground">
                    服务建议至少等待 {failure.retry_after} 秒后再尝试。
                  </p>
                ) : null}
                {!invalid && (
                  <p className="text-sm text-muted-foreground">
                    内容已保留。若网络中断或超时，请先检查“已发送”再决定是否重试，避免重复发送。
                  </p>
                )}
                {needsRetryReview && !retryConfirmed && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      submission.current = null;
                      setRetryConfirmed(true);
                    }}
                  >
                    我已检查，允许再次发送
                  </Button>
                )}
              </div>
            )}
            {!accepted && (
              <p className="text-xs text-muted-foreground">
                需要此邮箱授权
                Mail.Send。点击发送后才会提交；草稿仅保留在当前窗口。
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={requestClose}>
              {accepted ? "完成" : "取消"}
            </Button>
            {!accepted && (
              <BusyButton
                type="button"
                busy={busy}
                disabled={needsRetryReview && !retryConfirmed}
                onClick={() => void send()}
              >
                <Send data-icon="inline-start" />
                {busy ? "正在提交…" : reply ? "发送回复" : "发送邮件"}
              </BusyButton>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={discard} onOpenChange={setDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃这封草稿？</AlertDialogTitle>
            <AlertDialogDescription>
              关闭后，当前输入的内容将被清除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>继续编辑</AlertDialogCancel>
            <AlertDialogAction onClick={close}>放弃草稿</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={confirmNewSubmission}
        onOpenChange={setConfirmNewSubmission}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>发起新的发送请求？</AlertDialogTitle>
            <AlertDialogDescription>
              {failure && !needsRetryReview
                ? "上次提交未成功。请先处理权限或频率限制；确认后将使用新的操作标识提交当前内容。"
                : "确认后会作为一次新的发送提交。请先核对已发送邮件，确认之前的邮件没有发出，避免重复发送。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>返回编辑</AlertDialogCancel>
            <AlertDialogAction onClick={() => void send(true)}>
              确认新发送
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
