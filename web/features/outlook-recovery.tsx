import { CredentialField } from "@/components/credential-field";
import {
  ActionError,
  BusyButton,
  CopyAction,
  ErrorState,
  Loading,
  Modal,
  ModalBody,
  ModalFooter,
  Status,
} from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { AccountExportDialog } from "@/features/account-export";
import { api, date, useResource } from "@/lib/api";
import { useWorkspace, type OutlookRecoveryTarget } from "@/lib/context";
import type { Outlook } from "@/lib/types";
import {
  Activity,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Eye,
  EyeOff,
  FileKey2,
  Mail,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  MANUAL_REDIRECT_URI,
  PUBLIC_CLIENT_ID,
  outlookDiagnosis,
  parseAuthorizationResponse,
  type RecoveryDiagnosis,
} from "../../shared/outlook-recovery";

type Mode = "web" | "manual";
type AccountIdentity = Pick<Outlook, "id" | "email" | "status" | "auth_status">;
type Recovery = {
  account: AccountIdentity &
    Pick<
      Outlook,
      | "client_id"
      | "group_id"
      | "last_error"
      | "last_error_code"
      | "token_refresh_status"
      | "token_refresh_error"
      | "next_token_refresh_at"
    >;
  diagnosis: RecoveryDiagnosis;
};
type AuthorizationSession = {
  state: string;
  mode: Mode;
  expires_at: number;
  redirect_uri: string;
  client_id: string;
};
type Operation = {
  kind: "start" | "exchange" | "check" | "enable";
  controller: AbortController;
};

function readIdentity(value: unknown): AccountIdentity {
  if (!value || typeof value !== "object")
    throw new Error("授权结果缺少账号信息，请刷新账号列表确认保存结果。");
  const account = value as Partial<AccountIdentity>;
  if (
    !Number.isSafeInteger(account.id) ||
    !account.id ||
    account.id < 1 ||
    typeof account.email !== "string" ||
    !account.email ||
    typeof account.status !== "string" ||
    typeof account.auth_status !== "string"
  )
    throw new Error("授权结果中的账号信息无效，请刷新账号列表确认保存结果。");
  return {
    id: account.id,
    email: account.email,
    status: account.status,
    auth_status: account.auth_status,
  };
}

function failureMessage(failure: unknown) {
  return failure instanceof Error ? failure.message : "操作失败，请稍后重试";
}

export function OutlookRecoveryDialog({
  target,
  close,
}: {
  target: OutlookRecoveryTarget;
  close: () => void;
}) {
  // A different target must never inherit another account's authorization code.
  return (
    <OutlookRecoveryContent
      key={`${target.id ?? "new"}:${target.email ?? ""}:${target.group_id ?? ""}:${!!target.send_mail}`}
      target={target}
      close={close}
    />
  );
}

function OutlookRecoveryContent({
  target,
  close,
}: {
  target: OutlookRecoveryTarget;
  close: () => void;
}) {
  const w = useWorkspace();
  const id = useId();
  const [chosenMode, setChosenMode] = useState<Mode | null>(null);
  const [email, setEmail] = useState(target.email || "");
  const [clientId, setClientId] = useState(PUBLIC_CLIENT_ID);
  const [sendMail, setSendMail] = useState(!!target.send_mail);
  const [session, setSession] = useState<AuthorizationSession | null>(null);
  const sessionRef = useRef<AuthorizationSession | null>(null);
  const popup = useRef<Window | null>(null);
  const request = useRef<Operation | null>(null);
  const [busy, setBusy] = useState<Operation["kind"] | "">("");
  const [popupClosed, setPopupClosed] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [response, setResponse] = useState("");
  const [extracted, setExtracted] = useState<ReturnType<
    typeof parseAuthorizationResponse
  > | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [extractionError, setExtractionError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [savedAccount, setSavedAccount] = useState<AccountIdentity | null>(
    null,
  );
  const [completed, setCompleted] = useState(false);
  const [checked, setChecked] = useState<"idle" | "passed" | "failed">("idle");
  const [exporting, setExporting] = useState(false);
  const accountId = savedAccount?.id ?? target.id;
  const recovery = useResource<Recovery>(
    accountId ? `/api/outlook/accounts/${accountId}/recovery` : null,
    w.revision,
  );
  const credentials = useResource<Outlook>(
    accountId ? `/api/outlook/accounts/${accountId}` : null,
    w.revision,
  );
  const account = recovery.result?.data.account ?? savedAccount;
  const accountEmail =
    savedAccount?.email || account?.email || target.email || "";
  const mode = chosenMode ?? (w.settings?.oauth_configured ? "web" : "manual");
  const locked = !!busy || !!session;
  const sessionExpired = !!session && remaining === 0;
  const disabledAccount = account?.status === "disabled";
  // A previous recovery response may still be cached while refresh starts.
  const diagnosis =
    completed && checked === "idle"
      ? outlookDiagnosis({ status: account?.status, auth_status: "unchecked" })
      : recovery.result?.data.diagnosis;

  const closePopup = useCallback(() => {
    const owned = popup.current;
    popup.current = null;
    try {
      owned?.close();
    } catch {
      // A browser may sever the handle after Microsoft changes origin.
    }
  }, []);

  const clearSession = useCallback(() => {
    sessionRef.current = null;
    closePopup();
    setSession(null);
    setRemaining(0);
    setPopupClosed(false);
    setResponse("");
    setExtracted(null);
    setRevealed(false);
    setExtractionError("");
  }, [closePopup]);

  useEffect(
    () => () => {
      request.current?.controller.abort();
      request.current = null;
      sessionRef.current = null;
      closePopup();
    },
    [closePopup],
  );

  const saved = useCallback(
    (value: unknown) => {
      const identity = readIdentity(value);
      if (accountId && identity.id !== accountId)
        throw new Error("授权结果与当前账号不一致，请刷新账号列表确认。");
      clearSession();
      setSavedAccount(identity);
      setCompleted(true);
      setChecked("idle");
      setError("");
      setNotice("");
      w.refresh();
    },
    [accountId, clearSession, w.refresh],
  );

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const current = sessionRef.current;
      if (
        !current ||
        current.mode !== "web" ||
        event.origin !== window.location.origin ||
        !popup.current ||
        event.source !== popup.current ||
        event.data?.type !== "mailhub-outlook-oauth" ||
        event.data.state !== current.state ||
        typeof event.data.success !== "boolean"
      )
        return;
      try {
        if (!event.data.success)
          throw new Error(
            typeof event.data.message === "string"
              ? event.data.message
              : "微软授权未完成，请重新授权。",
          );
        saved(event.data.account);
      } catch (failure) {
        clearSession();
        setError(`${failureMessage(failure)} 请重新开始授权后重试。`);
        w.refresh();
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [clearSession, saved, w.refresh]);

  useEffect(() => {
    if (!session) return;
    const tick = () => {
      if (sessionRef.current !== session) return;
      const seconds = Math.max(
        0,
        Math.ceil((session.expires_at * 1000 - Date.now()) / 1000),
      );
      setRemaining(seconds);
      if (!seconds && session.mode === "manual") {
        clearSession();
        setError(
          "本次授权会话已过期，请重新开始微软授权，并使用新生成的授权码。",
        );
        return;
      }
      // A web callback may have claimed the session before expiry and still
      // be saving. Keep its window and listener until it reports the result.
      try {
        if (popup.current?.closed) setPopupClosed(true);
      } catch {
        setPopupClosed(true);
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [session, clearSession]);

  const begin = (kind: Operation["kind"]) => {
    if (request.current) return null;
    const operation = { kind, controller: new AbortController() };
    request.current = operation;
    setBusy(kind);
    setError("");
    setNotice("");
    return operation;
  };
  const finish = (operation: Operation) => {
    if (request.current !== operation) return;
    request.current = null;
    setBusy("");
  };
  const cancel = () => {
    if (request.current && request.current.kind !== "start") return false;
    request.current?.controller.abort();
    request.current = null;
    setBusy("");
    clearSession();
    return true;
  };
  const dismiss = () => {
    if (cancel()) close();
  };
  const openSettings = () => {
    if (!cancel()) return;
    close();
    w.navigate("settings");
  };

  const start = async () => {
    if (
      request.current ||
      (sessionRef.current &&
        !(
          mode === "web" &&
          (popupClosed || sessionRef.current.expires_at * 1000 <= Date.now())
        ))
    )
      return;
    if (accountId && !accountEmail) {
      setError("请等待账号邮箱加载完成；加载失败时请先重试连接诊断。");
      return;
    }
    if (mode === "web" && !w.settings?.oauth_configured) {
      setError("请先在设置中配置自己的微软 Web 应用，或切换到手动授权。");
      return;
    }
    if (
      mode === "manual" &&
      !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(clientId.trim())
    ) {
      setError(
        "请输入有效的公共客户端 Client ID（UUID），或恢复 Thunderbird 默认值。",
      );
      return;
    }
    const operation = begin("start");
    if (!operation) return;
    clearSession();
    setChosenMode(mode);
    setChecked("idle");
    try {
      // Open during the click, before the first await, to retain user activation.
      const opened = window.open(
        "about:blank",
        "_blank",
        "popup,width=560,height=720",
      );
      if (!opened)
        throw new Error("授权窗口被浏览器拦截。请允许本站弹出窗口后重试。");
      popup.current = opened;
      if (mode === "manual") opened.opener = null;
      opened.document.title = "准备 Microsoft 授权";
      opened.document.body.textContent = "正在准备微软授权，请稍候…";
      const result = await api<AuthorizationSession>(
        "/api/outlook/oauth/start",
        "POST",
        {
          mode,
          account_id: accountId,
          email: accountId ? undefined : email.trim() || undefined,
          group_id: target.group_id,
          client_id: mode === "manual" ? clientId.trim() : undefined,
          send_mail: sendMail,
        },
        operation.controller.signal,
      );
      if (operation.controller.signal.aborted) return;
      if (opened.closed) throw new Error("授权窗口已关闭，请重新开始授权。");
      if (
        !result.url ||
        !result.data?.state ||
        result.data.mode !== mode ||
        !Number.isFinite(result.data.expires_at) ||
        result.data.expires_at * 1000 <= Date.now() ||
        !result.data.redirect_uri ||
        !result.data.client_id ||
        (mode === "manual" && result.data.redirect_uri !== MANUAL_REDIRECT_URI)
      )
        throw new Error("授权会话信息无效，请重新开始授权。");
      const url = new URL(result.url);
      if (
        url.origin !== "https://login.microsoftonline.com" ||
        url.username ||
        url.password
      )
        throw new Error("微软授权地址无效，请重试。");
      sessionRef.current = result.data;
      setSession(result.data);
      setRemaining(
        Math.ceil((result.data.expires_at * 1000 - Date.now()) / 1000),
      );
      // Manual callbacks go to localhost and deliberately cannot message us.
      if (mode === "manual") opened.opener = null;
      opened.location.href = url.href;
    } catch (failure) {
      if (!operation.controller.signal.aborted) {
        clearSession();
        setError(failureMessage(failure));
      }
    } finally {
      finish(operation);
    }
  };

  const extract = () => {
    const current = sessionRef.current;
    if (!current || current.mode !== "manual" || request.current) return;
    if (current.expires_at * 1000 <= Date.now()) {
      clearSession();
      setError("本次授权会话已过期，请重新开始授权。");
      return;
    }
    setExtracted(null);
    setRevealed(false);
    setExtractionError("");
    try {
      setExtracted(
        parseAuthorizationResponse(
          response,
          current.state,
          current.redirect_uri,
        ),
      );
    } catch (failure) {
      // Keep the original pasted text so a validation error can be corrected.
      setExtractionError(failureMessage(failure));
    }
  };

  const exchange = async () => {
    const current = sessionRef.current;
    if (!current || current.mode !== "manual" || !extracted || request.current)
      return;
    if (current.expires_at * 1000 <= Date.now()) {
      clearSession();
      setError("本次授权会话已过期，请重新开始授权。");
      return;
    }
    const operation = begin("exchange");
    if (!operation) return;
    const submitted = response;
    // An exchange attempt consumes the server session, even on failure.
    clearSession();
    try {
      const result = await api<AccountIdentity>(
        "/api/outlook/oauth/exchange",
        "POST",
        { state: current.state, response: submitted },
        operation.controller.signal,
      );
      if (!operation.controller.signal.aborted) saved(result.data);
    } catch (failure) {
      if (!operation.controller.signal.aborted) {
        setError(
          `${failureMessage(failure)} 本次授权已结束，请重新开始授权后再兑换。`,
        );
        w.refresh();
      }
    } finally {
      finish(operation);
    }
  };

  const check = async () => {
    if (!accountId || sessionRef.current) return;
    const operation = begin("check");
    if (!operation) return;
    setChecked("idle");
    try {
      await api(
        `/api/outlook/accounts/${accountId}/check`,
        "POST",
        undefined,
        operation.controller.signal,
      );
      if (!operation.controller.signal.aborted) {
        setChecked("passed");
        setNotice("连接检查通过，微软邮件权限可用。");
      }
    } catch (failure) {
      if (!operation.controller.signal.aborted) {
        setChecked("failed");
        setError(failureMessage(failure));
      }
    } finally {
      if (!operation.controller.signal.aborted) w.refresh();
      finish(operation);
    }
  };

  const enable = async () => {
    if (!accountId || sessionRef.current) return;
    const operation = begin("enable");
    if (!operation) return;
    try {
      await api(
        `/api/outlook/accounts/${accountId}`,
        "PUT",
        { status: "active" },
        operation.controller.signal,
      );
      if (!operation.controller.signal.aborted) {
        setSavedAccount(
          (previous) => previous && { ...previous, status: "active" },
        );
        setChecked("idle");
        setNotice("账号已启用，请测试连接确认收件权限。");
        w.refresh();
      }
    } catch (failure) {
      if (!operation.controller.signal.aborted)
        setError(failureMessage(failure));
    } finally {
      finish(operation);
    }
  };

  return (
    <>
      <Modal
        title={accountId ? "修复 Outlook 授权" : "连接 Outlook 邮箱"}
        description="登录 Microsoft 更新授权，保存后可测试收件、查看配置或打开邮箱。"
        close={dismiss}
        wide
      >
        <form
          className="modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!completed) void start();
          }}
        >
          <ModalBody aria-busy={!!busy}>
            {accountId && (
              <section
                className="flex min-w-0 flex-col gap-3 rounded-lg border p-4"
                aria-label="已保存的账号信息"
              >
                <h3 className="text-sm font-medium">已保存的账号信息</h3>
                {credentials.error ? (
                  <ErrorState
                    message={credentials.error}
                    retry={credentials.reload}
                  />
                ) : !credentials.result ? (
                  <Loading />
                ) : (
                  <>
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 break-all text-sm">
                        {credentials.result.data.email}
                      </span>
                      <CopyAction
                        value={credentials.result.data.email}
                        label="邮箱"
                      />
                    </div>
                    <CredentialField
                      label="账号密码"
                      value={credentials.result.data.password || ""}
                      placeholder="此账号尚未保存密码"
                    />
                    <p className="text-xs text-muted-foreground">
                      使用以上邮箱和密码登录微软；完成授权后，平台会保存新的收件凭据。
                    </p>
                  </>
                )}
              </section>
            )}
            {completed && (
              <Alert role="status">
                <CheckCircle2 />
                <AlertTitle>授权凭据已保存</AlertTitle>
                <AlertDescription className="flex flex-col gap-3">
                  <span className="break-all">{accountEmail}</span>
                  <span>
                    Refresh Token 已保存到服务器。
                    {mode === "manual" && "可关闭已复制网址的微软授权页。"}
                    {disabledAccount
                      ? "账号仍为停用状态，请先启用，再测试收件权限。"
                      : checked === "passed"
                        ? "本次收件连接检查已通过。"
                        : checked === "failed"
                          ? "收件连接检查失败，请按下方诊断继续处理。"
                          : "收件权限尚未验证，请点击“测试连接”。"}
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <Status
                      value={
                        checked === "passed"
                          ? "healthy"
                          : checked === "failed"
                            ? "error"
                            : "unchecked"
                      }
                    />
                    {disabledAccount && (
                      <Badge variant="outline">账号仍为停用状态</Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!!busy}
                      onClick={() => setExporting(true)}
                    >
                      <FileKey2 data-icon="inline-start" />
                      查看 / 复制配置
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!!busy || disabledAccount}
                      onClick={() => {
                        if (!accountId) return;
                        dismiss();
                        w.outlook(accountId, accountEmail);
                      }}
                    >
                      <Mail data-icon="inline-start" />
                      读取邮件
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={!!busy}
                      onClick={() => {
                        setCompleted(false);
                        setError("");
                        setNotice("");
                      }}
                    >
                      再次授权
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {accountId && recovery.loading && <Loading />}
            {recovery.error && (
              <ErrorState message={recovery.error} retry={recovery.reload} />
            )}
            {!recovery.loading && recovery.result && diagnosis && (
              <Alert>
                <Activity />
                <AlertTitle>{diagnosis.title}</AlertTitle>
                <AlertDescription className="flex flex-col gap-3">
                  <span>{diagnosis.description}</span>
                  <details>
                    <summary className="cursor-pointer">
                      查看连接诊断详情
                    </summary>
                    <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[auto_minmax(0,1fr)]">
                      <dt>邮箱</dt>
                      <dd className="break-all">{accountEmail}</dd>
                      <dt>Client ID</dt>
                      <dd className="break-all">
                        {recovery.result.data.account.client_id || "未配置"}
                      </dd>
                      <dt>错误代码</dt>
                      <dd>
                        {recovery.result.data.account.last_error_code || "无"}
                      </dd>
                      <dt>最近连接错误</dt>
                      <dd>{recovery.result.data.account.last_error || "无"}</dd>
                      <dt>自动续期</dt>
                      <dd>
                        {recovery.result.data.account.token_refresh_status ===
                        "healthy"
                          ? "最近令牌续期成功（不代表收件检查通过）"
                          : recovery.result.data.account
                                .token_refresh_status === "retrying"
                            ? "等待重试"
                            : recovery.result.data.account
                                  .token_refresh_status === "reauth_required"
                              ? "需要重新授权"
                              : "等待续期"}
                      </dd>
                      {recovery.result.data.account.token_refresh_error && (
                        <>
                          <dt>续期错误</dt>
                          <dd>
                            {recovery.result.data.account.token_refresh_error}
                          </dd>
                        </>
                      )}
                      <dt>下次续期</dt>
                      <dd>
                        {date(
                          recovery.result.data.account.next_token_refresh_at,
                        )}
                      </dd>
                    </dl>
                  </details>
                  <div className="flex flex-wrap gap-2">
                    {!completed &&
                      (disabledAccount ? (
                        <BusyButton
                          type="button"
                          variant="outline"
                          busy={busy === "enable"}
                          disabled={locked}
                          onClick={() => void enable()}
                        >
                          启用账号
                        </BusyButton>
                      ) : (
                        <BusyButton
                          type="button"
                          variant="outline"
                          busy={busy === "check"}
                          disabled={locked}
                          onClick={() => void check()}
                        >
                          {diagnosis.action === "retry"
                            ? "重试连接"
                            : "测试连接"}
                        </BusyButton>
                      ))}
                    {diagnosis.action === "configure" && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={locked}
                        onClick={openSettings}
                      >
                        <Settings data-icon="inline-start" />
                        检查应用设置
                      </Button>
                    )}
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {!completed && (
              <>
                <Tabs
                  value={mode}
                  onValueChange={(value) => {
                    if (locked) return;
                    setChosenMode(value as Mode);
                    setError("");
                    setNotice("");
                  }}
                >
                  <TabsList className="w-full" aria-label="授权方式">
                    <TabsTrigger value="web" disabled={locked}>
                      自动回调
                    </TabsTrigger>
                    <TabsTrigger value="manual" disabled={locked}>
                      手动授权
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="web" className="mt-3">
                    <Alert>
                      <ShieldCheck />
                      <AlertTitle>
                        {w.settings?.oauth_configured
                          ? "使用已配置的微软应用"
                          : "需要配置自己的微软 Web 应用"}
                      </AlertTitle>
                      <AlertDescription className="flex flex-col gap-3">
                        <span>
                          在弹出的 Microsoft
                          窗口完成登录与授权，本站会自动接收结果并保存凭据。
                        </span>
                        {w.settings?.oauth_redirect_uri && (
                          <span>
                            回调地址：
                            <code className="break-all">
                              {w.settings.oauth_redirect_uri}
                            </code>
                          </span>
                        )}
                        {!w.settings?.oauth_configured && (
                          <div>
                            <Button
                              type="button"
                              variant="outline"
                              disabled={locked}
                              onClick={openSettings}
                            >
                              前往设置微软应用
                            </Button>
                          </div>
                        )}
                      </AlertDescription>
                    </Alert>
                  </TabsContent>
                  <TabsContent
                    value="manual"
                    className="mt-3 flex flex-col gap-4"
                  >
                    <Alert>
                      <Clock3 />
                      <AlertTitle>授权后立即复制地址栏中的完整网址</AlertTitle>
                      <AlertDescription>
                        授权完成会跳转到 <code>{MANUAL_REDIRECT_URI}</code>
                        ，页面无法打开是正常现象。
                        请复制地址栏中的完整网址，关闭授权页并回到这里，也可只粘贴
                        code 的值。 授权码通常约 1
                        分钟有效，请尽快提取并兑换；此窗口不会自动回传结果。
                      </AlertDescription>
                    </Alert>
                    <Field data-disabled={locked}>
                      <FieldLabel htmlFor={`${id}-client`}>
                        公共客户端 Client ID
                      </FieldLabel>
                      <Input
                        id={`${id}-client`}
                        value={clientId}
                        onChange={(event) => setClientId(event.target.value)}
                        readOnly={locked}
                        autoComplete="off"
                        spellCheck={false}
                        required
                      />
                      <FieldDescription>
                        默认使用 Thunderbird
                        公共应用。自定义应用必须启用公共客户端并注册精确回调地址{" "}
                        <code>{MANUAL_REDIRECT_URI}</code>。 已配置的自有 Web
                        应用请使用“自动回调”，不要将其 ID 用在这里。
                      </FieldDescription>
                      {clientId !== PUBLIC_CLIENT_ID && (
                        <div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={locked}
                            onClick={() => setClientId(PUBLIC_CLIENT_ID)}
                          >
                            恢复 Thunderbird 默认值
                          </Button>
                        </div>
                      )}
                    </Field>
                  </TabsContent>
                </Tabs>

                <FieldGroup>
                  <Field data-disabled={locked}>
                    <FieldLabel htmlFor={`${id}-email`}>
                      {accountId ? "修复邮箱（不可修改）" : "绑定邮箱（可选）"}
                    </FieldLabel>
                    <Input
                      id={`${id}-email`}
                      type="email"
                      value={accountId ? accountEmail : email}
                      readOnly={!!accountId || locked}
                      onChange={(event) => setEmail(event.target.value)}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder={
                        accountId && !accountEmail
                          ? recovery.loading
                            ? "正在读取账号邮箱…"
                            : "暂时无法读取邮箱，请重试加载诊断"
                          : "name@outlook.com"
                      }
                    />
                    <FieldDescription>
                      {accountId
                        ? "请登录此邮箱对应的 Microsoft 账号；修复会更新该账号的凭据。"
                        : "填写后，登录的微软邮箱必须与此地址一致；留空则使用授权返回的邮箱。"}
                    </FieldDescription>
                  </Field>
                  <Field orientation="horizontal" data-disabled={locked}>
                    <Checkbox
                      id={`${id}-send`}
                      checked={sendMail}
                      disabled={locked}
                      onCheckedChange={(value) => setSendMail(value === true)}
                    />
                    <FieldContent>
                      <FieldLabel htmlFor={`${id}-send`}>
                        同时申请发信权限（Mail.Send）
                      </FieldLabel>
                      <FieldDescription>
                        需要在本站发送或回复邮件时勾选。本次授权不会发送邮件。
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                </FieldGroup>

                {session && (
                  <Alert role="status" aria-live="off">
                    <Clock3 />
                    <AlertTitle aria-live="polite">
                      {sessionExpired
                        ? "授权会话已到期"
                        : popupClosed
                          ? "授权窗口已关闭或连接已断开"
                          : "正在等待 Microsoft 授权"}
                    </AlertTitle>
                    <AlertDescription className="flex flex-col gap-3">
                      <span>
                        本次会话剩余 {Math.floor(remaining / 60)} 分{" "}
                        {remaining % 60} 秒。授权码自身通常仅约 1 分钟有效。
                      </span>
                      <span>
                        {mode === "manual"
                          ? "若已复制回调网址，可继续在下方提取；未取得授权码时请取消本次授权后重新开始。"
                          : sessionExpired
                            ? "若已完成微软授权，请稍候等待保存结果；否则请重新开始授权。"
                            : popupClosed
                              ? "若未收到授权结果，请重新开始授权；也可以取消后切换为手动授权。"
                              : "完成后此面板会自动更新，请保持此面板打开。"}
                      </span>
                      {!popupClosed && (
                        <div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              try {
                                popup.current?.focus();
                              } catch {
                                setPopupClosed(true);
                              }
                            }}
                          >
                            <ExternalLink data-icon="inline-start" />
                            返回授权窗口
                          </Button>
                        </div>
                      )}
                    </AlertDescription>
                  </Alert>
                )}

                {mode === "manual" && (
                  <FieldGroup>
                    <Field
                      data-invalid={!!extractionError}
                      data-disabled={!session || !!busy}
                    >
                      <FieldLabel htmlFor={`${id}-response`}>
                        回调网址或原始授权码
                      </FieldLabel>
                      <Textarea
                        id={`${id}-response`}
                        value={response}
                        onChange={(event) => {
                          setResponse(event.target.value);
                          setExtracted(null);
                          setRevealed(false);
                          setExtractionError("");
                        }}
                        disabled={!session || !!busy}
                        aria-invalid={!!extractionError}
                        aria-describedby={
                          extractionError ? `${id}-response-error` : undefined
                        }
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        data-1p-ignore
                        data-lpignore="true"
                        wrap="soft"
                        rows={3}
                        className="h-24 resize-none [field-sizing:fixed] [overflow-wrap:anywhere]"
                        placeholder={
                          session
                            ? "https://localhost/?code=…&state=…"
                            : "先点击“打开 Microsoft 授权”，再粘贴本次授权的结果"
                        }
                      />
                      <FieldError id={`${id}-response-error`}>
                        {extractionError}
                      </FieldError>
                      <FieldDescription>
                        仅在当前面板中保留，关闭或结束会话后清除。修改输入后需重新提取。
                      </FieldDescription>
                      <div>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={!session || !!busy || !response.trim()}
                          onClick={extract}
                        >
                          提取授权码
                        </Button>
                      </div>
                    </Field>
                    {extracted && (
                      <Field>
                        <FieldLabel htmlFor={`${id}-code`}>
                          已提取的授权码
                        </FieldLabel>
                        <Textarea
                          id={`${id}-code`}
                          readOnly
                          value={
                            revealed
                              ? extracted.code
                              : "••••••••••••••••••••••••"
                          }
                          autoComplete="off"
                          spellCheck={false}
                          data-1p-ignore
                          data-lpignore="true"
                          wrap="soft"
                          rows={2}
                          className="h-20 resize-none [field-sizing:fixed] [overflow-wrap:anywhere]"
                        />
                        <FieldDescription>
                          {extracted.fromUrl
                            ? "回调地址与本次会话匹配。确认后点击“兑换并保存授权”。"
                            : "已识别原始授权码。请确认它来自本次打开的授权窗口，再兑换保存。"}
                        </FieldDescription>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setRevealed((value) => !value)}
                            aria-pressed={revealed}
                          >
                            {revealed ? (
                              <EyeOff data-icon="inline-start" />
                            ) : (
                              <Eye data-icon="inline-start" />
                            )}
                            {revealed ? "隐藏授权码" : "显示授权码"}
                          </Button>
                          <CopyAction
                            value={extracted.code}
                            label="复制授权码"
                            variant="outline"
                            size="sm"
                          />
                        </div>
                      </Field>
                    )}
                  </FieldGroup>
                )}
              </>
            )}
            {busy === "exchange" && (
              <p role="status">正在兑换并保存授权，请稍候…</p>
            )}
            {notice && (
              <p role="status" className="text-sm text-muted-foreground">
                {notice}
              </p>
            )}
          </ModalBody>
          {error && (
            <div className="max-h-[24dvh] shrink-0 overflow-y-auto border-t px-5 py-3 sm:px-6">
              <ActionError message={error} />
            </div>
          )}
          <ModalFooter>
            <Button
              type="button"
              variant="outline"
              disabled={!!busy && busy !== "start"}
              onClick={dismiss}
            >
              关闭
            </Button>
            {completed ? (
              <BusyButton
                type="button"
                busy={busy === "check" || busy === "enable"}
                disabled={!!busy || !accountId}
                onClick={() => void (disabledAccount ? enable() : check())}
              >
                <Activity data-icon="inline-start" />
                {disabledAccount ? "启用账号" : "测试连接"}
              </BusyButton>
            ) : (
              <>
                {(session || busy === "start") && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!!busy && busy !== "start"}
                    onClick={() => {
                      if (cancel()) {
                        setError("");
                        setNotice(
                          "已取消本次授权。请关闭仍打开的授权页，再调整选项重新开始。",
                        );
                      }
                    }}
                  >
                    取消本次授权
                  </Button>
                )}
                {session?.mode === "manual" || busy === "exchange" ? (
                  <BusyButton
                    type="button"
                    busy={busy === "exchange"}
                    disabled={!session || !extracted || !!busy}
                    onClick={() => void exchange()}
                  >
                    兑换并保存授权
                  </BusyButton>
                ) : (
                  <BusyButton
                    type="submit"
                    busy={busy === "start"}
                    disabled={
                      !!busy ||
                      (!!accountId && !accountEmail) ||
                      (!!session && !popupClosed && !sessionExpired) ||
                      (mode === "web" && !w.settings?.oauth_configured)
                    }
                  >
                    <ExternalLink data-icon="inline-start" />
                    {session ? "重新开始授权" : "打开 Microsoft 授权"}
                  </BusyButton>
                )}
              </>
            )}
          </ModalFooter>
        </form>
      </Modal>
      {exporting && accountId && (
        <AccountExportDialog
          kind="outlook"
          endpoint={`/api/outlook/accounts/export?ids=${accountId}`}
          title="查看 / 复制 Outlook 配置"
          description="生成并复制此账号的完整配置，包含服务器已保存的 Refresh Token。"
          close={() => setExporting(false)}
        />
      )}
    </>
  );
}
