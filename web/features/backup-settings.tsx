import { useEffect, useRef, useState } from "react";
import {
  ActionError,
  BusyButton,
  ErrorState,
  Loading,
  TextField,
} from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldGroup } from "@/components/ui/field";
import {
  SettingsConfirmation,
  useSettingsAction,
  useSettingsUnloadGuard,
} from "@/features/security-settings";
import { api, date, download, useResource } from "@/lib/api";
import { useWorkspace } from "@/lib/context";
import { Download, FolderInput } from "lucide-react";
import { toast } from "sonner";

interface Manifest {
  name: string;
  limits: { max_plaintext_bytes: number; max_rows: number };
  excluded: string[];
  restore_available: boolean;
}
interface Preview {
  valid: boolean;
  restorable: boolean;
  table_counts: Record<string, number>;
  backup_hash: string;
  writes_performed: boolean;
  confirmation_token?: string;
  expires_at?: string;
  external_dependencies: string[];
}
interface RestoreSubmission {
  body: {
    backup: unknown;
    passphrase: string;
    confirmation_token: string;
    confirm: "RESTORE_BACKUP";
  };
  key: string;
  expiresAt: number;
}
const names: Record<string, string> = {
  settings: "业务偏好",
  groups: "Outlook 分组",
  tags: "标签",
  accounts: "Outlook 账号",
  account_tags: "账号标签关系",
  cf_inbox_mails: "域名邮件",
  mail_rules: "收件规则",
  platform_vault: "平台账号",
  temp_emails: "外部邮箱台账",
  temp_mailboxes: "临时邮箱",
  domains: "域名",
};

export default function BackupSettings() {
  const w = useWorkspace();
  const manifest = useResource<Manifest>("/api/backups/manifest");
  const [passphrase, setPassphrase] = useState(""),
    [repeat, setRepeat] = useState(""),
    [include, setInclude] = useState(false);
  const [file, setFile] = useState<File | null>(null),
    [restorePassphrase, setRestorePassphrase] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null),
    [backup, setBackup] = useState<unknown>(null);
  const exportAction = useSettingsAction(),
    previewAction = useSettingsAction();
  const [confirmation, setConfirmation] = useState<RestoreSubmission | null>(
    null,
  );
  const [expired, setExpired] = useState(false);
  const locked = exportAction.busy || previewAction.busy || !!confirmation;
  useSettingsUnloadGuard(locked);
  useEffect(() => {
    if (!preview?.expires_at) {
      setExpired(false);
      return;
    }
    const remaining = Date.parse(preview.expires_at) - Date.now();
    setExpired(!Number.isFinite(remaining) || remaining <= 0);
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timer = window.setTimeout(() => setExpired(true), remaining);
    return () => window.clearTimeout(timer);
  }, [preview]);
  const restoreKey = useRef("");
  const name = () =>
    `mailhub-${new Date().toISOString().replaceAll(":", "-")}.json`;
  const resetPreview = () => {
    setPreview(null);
    setBackup(null);
    restoreKey.current = "";
  };
  return (
    <div className="flex min-w-0 flex-col gap-6 [overflow-wrap:anywhere]">
      {manifest.loading ? (
        <Loading />
      ) : manifest.error ? (
        <ErrorState message={manifest.error} retry={manifest.reload} />
      ) : (
        <Alert>
          <AlertTitle>便携业务备份</AlertTitle>
          <AlertDescription>
            包含账号、邮件、域名、规则和业务偏好。最多{" "}
            {manifest.result?.data.limits.max_rows} 条记录、
            {Math.round(
              (manifest.result?.data.limits.max_plaintext_bytes || 0) / 1024,
            )}{" "}
            KiB
            解密后数据；更大的数据集请使用数据源副本及数据库原生备份。登录配置、API
            密钥、通知配置、协调器和 R2 文件需要另行备份。
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>导出业务数据</CardTitle>
          <CardDescription>
            默认导出脱敏清单。恢复账号凭据和邮件正文需使用带口令的加密文件。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            id="backup-export"
            onSubmit={(e) => {
              e.preventDefault();
              if (locked) return;
              void exportAction.run(async (signal) => {
                if (!include) {
                  // Export endpoints return the backup document itself, without
                  // the usual { success, data } envelope.
                  const document = await api(
                    "/api/backups/export",
                    "GET",
                    undefined,
                    signal,
                  );
                  signal.throwIfAborted();
                  download(document, name());
                  return;
                }
                if (passphrase !== repeat)
                  throw new Error("两次备份口令不一致");
                const document = await api(
                  "/api/backups/export",
                  "POST",
                  {
                    include_credentials: true,
                    confirm: "EXPORT_CREDENTIALS",
                    passphrase,
                  },
                  signal,
                );
                signal.throwIfAborted();
                download(document, name());
                setPassphrase("");
                setRepeat("");
                toast.success("加密备份已下载，请妥善保存口令");
              });
            }}
          >
            <fieldset disabled={locked} className="min-w-0">
              <FieldGroup>
                <label className="flex items-start gap-3 text-sm">
                  <Checkbox
                    checked={include}
                    onCheckedChange={(v) => setInclude(v === true)}
                    aria-label="导出包含凭据的加密备份"
                  />
                  <span>
                    导出包含凭据的加密备份
                    <span className="mt-1 block text-xs text-muted-foreground">
                      包含密码、TOTP、刷新令牌和邮件正文。口令不会保存在服务器，遗失后无法解密此文件。
                    </span>
                  </span>
                </label>
                {include && (
                  <div className="form-grid">
                    <TextField
                      label="备份口令"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={1024}
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                    />
                    <TextField
                      label="再次输入备份口令"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={1024}
                      value={repeat}
                      onChange={(e) => setRepeat(e.target.value)}
                    />
                  </div>
                )}
              </FieldGroup>
            </fieldset>
            <ActionError message={exportAction.error} />
          </form>
        </CardContent>
        <CardFooter>
          <BusyButton
            form="backup-export"
            type="submit"
            busy={exportAction.busy}
            disabled={locked || manifest.loading || !!manifest.error}
          >
            <Download data-icon="inline-start" />
            {include ? "下载加密备份" : "下载脱敏清单"}
          </BusyButton>
        </CardFooter>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>检查与恢复备份</CardTitle>
          <CardDescription>
            先验证文件、口令、表结构和关联数据，再预览恢复范围。验证阶段不会修改业务记录。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <form
            id="backup-preview"
            onSubmit={(e) => {
              e.preventDefault();
              if (locked) return;
              void previewAction.run(async (signal) => {
                resetPreview();
                if (!file) throw new Error("请先选择备份文件");
                if (file.size > 2 * 1024 * 1024)
                  throw new Error("文件超过便携备份的 2 MiB 上传限制");
                let document: unknown;
                try {
                  document = JSON.parse(await file.text());
                } catch {
                  throw new Error("文件不是有效的 JSON 备份");
                }
                signal.throwIfAborted();
                const body = {
                  backup: document,
                  passphrase: restorePassphrase,
                };
                if (new Blob([JSON.stringify(body)]).size > 2 * 1024 * 1024)
                  throw new Error("文件和口令超过 2 MiB 上传限制");
                const r = await api<Preview>(
                  "/api/backups/preview",
                  "POST",
                  body,
                  signal,
                );
                signal.throwIfAborted();
                if (!r.data.valid || r.data.writes_performed)
                  throw new Error("未获得有效的只读预览，请重新检查备份");
                setBackup(document);
                setPreview(r.data);
                restoreKey.current = crypto.randomUUID();
              });
            }}
          >
            <fieldset disabled={locked} className="min-w-0">
              <FieldGroup>
                <TextField
                  label="备份文件"
                  type="file"
                  accept=".json,application/json"
                  required
                  onChange={(e) => {
                    setFile(e.target.files?.[0] || null);
                    resetPreview();
                  }}
                />
                <TextField
                  label="解密口令"
                  type="password"
                  autoComplete="off"
                  maxLength={1024}
                  value={restorePassphrase}
                  onChange={(e) => {
                    setRestorePassphrase(e.target.value);
                    resetPreview();
                  }}
                  help="加密备份需要导出时设置的口令。脱敏清单无需口令，仅支持检查。"
                />
              </FieldGroup>
            </fieldset>
            <ActionError message={previewAction.error} />
          </form>
          {preview && (
            <div className="flex flex-col gap-4 rounded-lg border p-4">
              <p className="font-medium">文件已通过完整性检查</p>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {Object.entries(preview.table_counts).map(([table, count]) => (
                  <div key={table}>
                    <dt className="text-xs text-muted-foreground">
                      {names[table] || table}
                    </dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums">
                      {count}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="break-all font-mono text-xs text-muted-foreground">
                SHA-256：{preview.backup_hash}
              </p>
              <p className="text-sm text-muted-foreground">
                {preview.restorable
                  ? "恢复会用备份替换以上业务数据，当前数据集会保留。R2 原始邮件与附件需要仍存在于对应的私有存储桶。"
                  : "这是脱敏清单，缺少恢复所需的凭据和正文，不能用来覆盖业务数据。"}
              </p>
              {preview.expires_at && (
                <p className="text-xs text-muted-foreground">
                  预览有效至 {date(preview.expires_at)}
                  ；业务记录变化后需要重新预览。
                </p>
              )}
              {expired && (
                <p role="status" className="text-sm text-destructive">
                  预览已过期，请重新检查并预览后再恢复。
                </p>
              )}
              {preview.restorable && !preview.confirmation_token && (
                <p role="status" className="text-sm text-muted-foreground">
                  当前环境尚不支持恢复，请先完成存储协调器与凭据加密配置，然后重新预览。
                </p>
              )}
            </div>
          )}
        </CardContent>
        <CardFooter className="flex-wrap gap-2">
          <BusyButton
            form="backup-preview"
            type="submit"
            variant="outline"
            busy={previewAction.busy}
            disabled={locked || !file || manifest.loading || !!manifest.error}
          >
            <FolderInput data-icon="inline-start" />
            检查并预览
          </BusyButton>
          {preview?.restorable && preview.confirmation_token && (
            <Button
              variant="destructive"
              disabled={
                locked || expired || !manifest.result?.data.restore_available
              }
              onClick={() => {
                const expiresAt = Date.parse(preview.expires_at || "");
                if (
                  locked ||
                  !backup ||
                  !restoreKey.current ||
                  !Number.isFinite(expiresAt) ||
                  expiresAt <= Date.now()
                ) {
                  setExpired(true);
                  return;
                }
                setConfirmation({
                  body: {
                    backup,
                    passphrase: restorePassphrase,
                    confirmation_token: preview.confirmation_token!,
                    confirm: "RESTORE_BACKUP",
                  },
                  key: restoreKey.current,
                  expiresAt,
                });
              }}
            >
              确认恢复
            </Button>
          )}
        </CardFooter>
      </Card>
      {confirmation && (
        <SettingsConfirmation
          title="恢复这份业务备份？"
          description="当前业务记录将被备份替换。恢复前请确认已导出当前数据，并已准备好备份引用的原始邮件文件。"
          close={() => setConfirmation(null)}
          action={async (signal) => {
            if (confirmation.expiresAt <= Date.now())
              throw new Error("预览已过期，请取消后重新检查并预览");
            const result = await api<{ restored_rows: number }>(
              "/api/backups/restore",
              "POST",
              confirmation.body,
              signal,
              { "Idempotency-Key": confirmation.key },
            );
            signal.throwIfAborted();
            resetPreview();
            setRestorePassphrase("");
            w.refresh();
            toast.success(`已恢复 ${result.data.restored_rows} 条业务记录`);
          }}
        >
          <p className="text-sm text-muted-foreground">
            确认期间文件与口令已锁定。请求中断时，服务端可能已完成恢复；请先核对工作区。重试本次提交会沿用同一个操作标识。
          </p>
        </SettingsConfirmation>
      )}
      <p className="text-sm text-muted-foreground">
        灾备需要同时保管部署配置、加密密钥、协调器状态、数据库和 R2
        文件。具体恢复顺序见项目文档 BACKUP-RECOVERY.md。
      </p>
    </div>
  );
}
